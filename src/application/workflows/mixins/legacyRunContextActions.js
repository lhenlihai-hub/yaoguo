// 仅用于显式恢复、重放或 fork 旧多步骤运行。
// 新建运行永远使用 agent-default，不会进入这些 taskType 路由。
const {
  fsp,
  path,
  exists,
  truncateForPrompt,
  legacyCharsToTokens,
  tokensToApproxChars,
  truncateForPromptTokens,
  headTailForPromptTokens
} = require("../../../platform/runtime");
module.exports = {
compactStepContentForContext(content = "", previousStep = {}, currentStep = {}) {
  const currentType = currentStep.taskType || "";
  const previousType = previousStep.taskType || "";
  const needsCleanDraft = ["revise", "review", "factCheck", "title"].includes(currentType);
  if (needsCleanDraft && ["draft", "revise", "review"].includes(previousType)) {
    return this.extractDeliverableContent(content);
  }
  return this.stripProcessSections(content);
}
,

async composeStepHandoffPrefill(state = {}) {
  if (!this.checkpointStore || !state.runDir) return "";
  const acc = await this.checkpointStore.loadAccumulatedState(state.runDir).catch(() => null);
  if (!acc) return "";
  const renderSection = (title, items, max) => {
    if (!Array.isArray(items) || !items.length) return "";
    const lines = items.slice(0, max).map((item) => {
      const text = `${item || ""}`.replace(/[<>&]/g, "").trim();
      return text ? `  <item>${text}</item>` : "";
    }).filter(Boolean);
    return lines.length ? `<${title}>\n${lines.join("\n")}\n</${title}>` : "";
  };
  const sections = [
    renderSection("decisions", acc.decisions, 12),
    renderSection("rejected", acc.rejected, 8),
    renderSection("open_questions", acc.openQuestions, 8),
    renderSection("facts", acc.facts, 12)
  ].filter(Boolean);
  if (!sections.length) return "";
  return [
    "<handoff_state>",
    "这是历史多步骤运行已经累积的交接状态。遵守 decisions，并避免 rejected 方向。",
    sections.join("\n"),
    "</handoff_state>"
  ].join("\n");
}
,

fitRunStateBullets(body = "", budget = 240) {
  const rows = this.parseBulletList(body);
  const source = rows.length ? rows : ["_（尚无）_"];
  const picked = [];
  let used = 0;
  for (let i = source.length - 1; i >= 0; i -= 1) {
    const raw = source[i];
    const remaining = budget - used - (picked.length ? 1 : 0);
    if (remaining <= 6) break;
    const line = `- ${raw}`;
    if (line.length <= remaining) {
      picked.unshift(line);
      used += line.length + (picked.length > 1 ? 1 : 0);
      continue;
    }
    if (!picked.length) {
      picked.unshift(`- ${truncateForPrompt(raw, Math.max(4, remaining - 2))}`);
    }
    break;
  }
  return picked.join("\n") || "- _（内容已折叠）_";
}
,

fitRunStateBlock(title = "", body = "", budget = 240, options = {}) {
  const heading = title ? `## ${title}\n` : "";
  const bodyBudget = Math.max(0, budget - heading.length);
  if (bodyBudget <= 8) return truncateForPrompt(heading.trim(), budget);
  const content = options.bullets
    ? this.fitRunStateBullets(body, bodyBudget)
    : truncateForPrompt(`${body || ""}`.trim(), bodyBudget);
  return truncateForPrompt(`${heading}${content}`.trim(), budget);
}
,

renderRunStateForPrompt(text = "", maxChars = 1800) {
  const raw = `${text || ""}`.trim();
  if (!raw) return "";
  if (raw.length <= maxChars) return raw;
  // 预算不够时，各区块分别裁剪，避免前面的 Decisions 把 Facts 和最近日志挤掉。
  const head = raw.split(/\n## 已做决定/)[0] || "";
  const room = Math.max(120, maxChars - 20);
  const budgets = {
    head: Math.max(80, Math.floor(room * 0.18)),
    decisions: Math.max(80, Math.floor(room * 0.18)),
    rejected: Math.max(70, Math.floor(room * 0.13)),
    open: Math.max(70, Math.floor(room * 0.13)),
    facts: Math.max(95, Math.floor(room * 0.21))
  };
  budgets.log = Math.max(80, room - Object.values(budgets).reduce((sum, value) => sum + value, 0));

  const keep = [
    this.fitRunStateBlock("", head, budgets.head),
    this.fitRunStateBlock("已做决定（Decisions）", this.extractMarkedRegion(raw, "decisions"), budgets.decisions, { bullets: true }),
    this.fitRunStateBlock("已否决方向（Rejected）", this.extractMarkedRegion(raw, "rejected"), budgets.rejected, { bullets: true }),
    this.fitRunStateBlock("待确认项（Open Questions）", this.extractMarkedRegion(raw, "open"), budgets.open, { bullets: true }),
    this.fitRunStateBlock("关键事实锚点（Facts）", this.extractMarkedRegion(raw, "facts"), budgets.facts, { bullets: true })
  ].filter(Boolean);
  const log = this.extractMarkedRegion(raw, "log");
  if (log) {
    const entries = log.split(/\n(?=### )/).filter(Boolean);
    const recent = entries.slice(-1).join("\n").trim();
    if (recent) keep.push(this.fitRunStateBlock("步骤交接日志（最近一步）", recent, budgets.log));
  }
  const rendered = keep.join("\n\n").trim();
  if (rendered.length <= maxChars) return rendered;
  return [
    truncateForPrompt(rendered.slice(0, Math.floor(maxChars * 0.55)), Math.floor(maxChars * 0.55)),
    "\n\n[中间内容已折叠]\n\n",
    rendered.slice(-Math.floor(maxChars * 0.35)).trimStart()
  ].join("").slice(0, maxChars);
}
,

renderRunStateForPromptTokens(text = "", maxTokens = 1200) {
  const approxChars = tokensToApproxChars(maxTokens);
  return truncateForPromptTokens(this.renderRunStateForPrompt(text, approxChars), maxTokens);
}
,

async buildHistoricalRunContext(state, step) {
  const completed = state.steps.filter((item) => item.index < step.index && item.status === "completed");
  const needs = step.contextNeeds || {};
  const taskType = step.taskType || "default";
  const defaultRecentByType = {
    agent: 0,
    memory: 0,
    research: 0,
    material: 1,
    outline: 1,
    draft: 2,
    revise: 1,
    review: 1,
    factCheck: 2,
    title: 1
  };
  // 默认只带必要步骤原文，其余用摘要；声明 prev 则精确加载
  const recentN = Number.isFinite(needs.recentN) ? needs.recentN : (defaultRecentByType[taskType] ?? 1);
  const explicitPrevIds = new Set(Array.isArray(needs.prev) ? needs.prev : []);
  const summariesOnly = needs.summariesOnly === true;
  const skipPrev = needs.skipPrev === true;

  // 注：不在 prompt 上下文中注入"当前时间"——它每次调用都不同，会让 DeepSeek/OpenAI
  // 的 prefix cache 在 runContext 这一段必失效。日志 / 调试需要时间用 ai-calls.jsonl
  // 的 createdAt 字段已足够。
  const parts = [
    `项目：${state.projectName || state.projectId || "默认项目"}`,
    `任务：${state.taskTitle || state.taskId || "默认任务"}`,
    taskType !== "agent" && state.taskBrief ? `任务说明：${state.taskBrief}` : "",
    `工作流：${state.workflowName}`
  ].filter(Boolean);

  // 顶部注入运行交接状态（state.md）——跨步骤/跨上下文的"连贯性单点真相"。
  if (needs.skipRunState !== true) {
    const defaultHandoffByType = {
      agent: 0,
      memory: 900,
      research: 900,
      material: 1100,
      outline: 1400,
      draft: 1800,
      revise: 2000,
      review: 1600,
      factCheck: 1800,
      title: 1100
    };
    const handoffChars = Number.isFinite(needs.handoffChars)
      ? needs.handoffChars
      : (defaultHandoffByType[taskType] ?? 1200);
    if (handoffChars > 0) {
      const stateText = await this.readRunStateText(state).catch(() => "");
      const rendered = this.renderRunStateForPrompt(stateText, handoffChars);
      if (rendered) {
        parts.push("", "【运行交接状态 · 跨步骤连贯性唯一来源】", rendered);
      }
    }
  }

  if (!skipPrev && completed.length) {
    const recentThreshold = completed.length - recentN;
    const defaultOriginalByType = {
      material: 1400,
      outline: 2200,
      draft: 3200,
      revise: 5200,
      review: 3000,
      factCheck: 5000,
      title: 2600
    };
    const maxOriginalChars = Number.isFinite(needs.originalCharsPerStep) ? needs.originalCharsPerStep : (defaultOriginalByType[taskType] || 1800);
    const maxSummaryChars = Number.isFinite(needs.summaryChars) ? needs.summaryChars : 300;
    parts.push("", "已完成步骤：");
    for (const item of completed) {
      const isRecent = completed.indexOf(item) >= recentThreshold;
      const isExplicit = explicitPrevIds.has(item.id);
      const wantOriginal = !summariesOnly && (isExplicit || isRecent);
      if (wantOriginal) {
        const outputFile = path.join(state.runDir, item.outputFile);
        if (await exists(outputFile)) {
          const content = await fsp.readFile(outputFile, "utf8");
          const compact = this.compactStepContentForContext(content, item, step);
          parts.push(`\n## ${item.title}（原文）\n${truncateForPrompt(compact, maxOriginalChars)}`);
          continue;
        }
      }
      if (item.summary) {
        parts.push(`\n## ${item.title}（摘要）\n${truncateForPrompt(item.summary, maxSummaryChars)}`);
      } else {
        parts.push(`\n## ${item.title}：已完成（无摘要）`);
      }
    }
  }

  if (!needs.skipReferences && state.projectId && this.projectService) {
    const defaultReferenceByType = {
      agent: 1800,
      material: 600,
      outline: 800,
      draft: 900,
      revise: 500,
      review: 500,
      factCheck: 1800
    };
    const refChars = Number.isFinite(needs.referenceChars)
      ? needs.referenceChars
      : (defaultReferenceByType[taskType] ?? 500);
    if (refChars > 0) {
      const references = await this.projectService.bundleReferences(
        state.projectId,
        state.taskId,
        refChars
      ).catch(() => "");
      if (references) {
        parts.unshift(`【本次任务已引用参考】\n${truncateForPrompt(references, refChars)}`);
      }
    }
  }

  const defaultTotalTokensByType = {
    agent: 192000,
    memory: 8000,
    research: 16000,
    material: 32000,
    outline: 64000,
    draft: 96000,
    revise: 128000,
    review: 64000,
    factCheck: 64000,
    title: 16000
  };
  const hardCapTokensByType = {
    agent: 384000,
    memory: 16000,
    research: 32000,
    material: 64000,
    outline: 96000,
    draft: 192000,
    revise: 192000,
    review: 96000,
    factCheck: 96000,
    title: 32000
  };
  const legacyRequestedTokens = Number.isFinite(needs.totalChars) ? legacyCharsToTokens(needs.totalChars) : 0;
  const requestedTokenCap = Number.isFinite(needs.totalTokens)
    ? needs.totalTokens
    : Math.max(defaultTotalTokensByType[taskType] || 32000, legacyRequestedTokens);
  const totalTokenCap = Math.min(requestedTokenCap, hardCapTokensByType[taskType] || 64000);
  return headTailForPromptTokens(
    parts.join("\n"),
    totalTokenCap,
    "[历史多步骤上下文中段已省略，完整步骤输出仍可从运行目录读取]"
  );
}

};
