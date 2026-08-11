const {
  fsp,
  path,
  exists,
  writeTextAtomic,
  localNow,
  truncateForPrompt,
  uniqueValues,
  extractFactClaims,
  localStepSummary
} = require("../../../platform/runtime");
module.exports = {
// state.md 是旧多步骤运行的可读审计记录。新运行只有一个通用 Agent 步骤，
// 不再把它当作第二套会话上下文；任务历史统一由 TaskSessionStore 装配。
getRunStatePath(state = {}) {
  return state?.runDir ? path.join(state.runDir, "state.md") : "";
}
,

buildInitialRunStateText(state = {}) {
  return [
    "# 运行交接状态",
    "<!-- yaoguo:state:v1 -->",
    "",
    "> 交接规则：每一步开始前先读这份文档，理解当前任务的目标、已做决定、已否决方向、",
    "> 待确认项和关键事实锚点；每一步结束时，通过步骤末尾的 HANDOFF 结构化块追加自己的交接项。",
    "> 下游步骤必须与本文档保持一致，不得与已记录的决定或事实自相矛盾。",
    "",
    "## 任务基本信息",
    `- 主题：${state.topic || "未命名主题"}`,
    `- 用户指令：${state.command || "无"}`,
    state.taskBrief ? `- 任务说明：${state.taskBrief}` : "",
    `- 项目：${state.projectName || state.projectId || "默认项目"}`,
    `- 工作流：${state.workflowName || state.workflowId || ""}`,
    `- 启动：${state.createdAt || new Date().toISOString()}`,
    "",
    "## 已做决定（Decisions）",
    "<!-- yaoguo:decisions:start -->",
    "- _（尚无）_",
    "<!-- yaoguo:decisions:end -->",
    "",
    "## 已否决方向（Rejected）",
    "<!-- yaoguo:rejected:start -->",
    "- _（尚无）_",
    "<!-- yaoguo:rejected:end -->",
    "",
    "## 待确认项（Open Questions）",
    "<!-- yaoguo:open:start -->",
    "- _（尚无）_",
    "<!-- yaoguo:open:end -->",
    "",
    "## 关键事实锚点（Facts）",
    "<!-- yaoguo:facts:start -->",
    "- _（尚无）_",
    "<!-- yaoguo:facts:end -->",
    "",
    "## 步骤交接日志（Handoff Log）",
    "<!-- yaoguo:log:start -->",
    "<!-- yaoguo:log:end -->",
    ""
  ].join("\n");
}
,

async seedRunState(state = {}) {
  const file = this.getRunStatePath(state);
  if (!file) return "";
  if (await exists(file)) return fsp.readFile(file, "utf8").catch(() => "");
  const text = this.buildInitialRunStateText(state);
  await writeTextAtomic(file, text);
  return text;
}
,

async readRunStateText(state = {}) {
  const file = this.getRunStatePath(state);
  if (!file || !(await exists(file))) return "";
  return fsp.readFile(file, "utf8").catch(() => "");
}
,

replaceMarkedRegion(text = "", name = "", body = "") {
  const pattern = new RegExp(
    `(<!--\\s*yaoguo:${name}:start\\s*-->)([\\s\\S]*?)(<!--\\s*yaoguo:${name}:end\\s*-->)`,
    "i"
  );
  if (!pattern.test(text)) return text;
  const inner = `\n${body.trim()}\n`;
  return text.replace(pattern, (_m, open, _mid, close) => `${open}${inner}${close}`);
}
,

extractMarkedRegion(text = "", name = "") {
  const pattern = new RegExp(
    `<!--\\s*yaoguo:${name}:start\\s*-->([\\s\\S]*?)<!--\\s*yaoguo:${name}:end\\s*-->`,
    "i"
  );
  const match = text.match(pattern);
  return match ? match[1].trim() : "";
}
,

parseBulletList(body = "") {
  const rows = `${body || ""}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim())
    .filter(Boolean)
    .filter((line) => !/^_?（尚无）_?$/.test(line));
  return uniqueValues(rows);
}
,

mergeListSection(existing = [], incoming = [], cap = 20) {
  const normalize = (item) => `${item || ""}`.replace(/\s+/g, " ").trim();
  // 语义去重：去掉 Markdown 修饰、引号、尾标点后取前 28 字作为 key，避免"A 确定为 X"
  // 和"A 确定为 X**"被当成两条，同时把极度相似的重复条目合并为较完整的那一条。
  const canonical = (item) => normalize(item)
    .replace(/\*\*|__|\*|_/g, "")
    .replace(/[""''`「」『』]/g, "")
    .replace(/[，。！？、；：,.!?;:]+$/g, "")
    .trim();
  const semanticKey = (item) => canonical(item).toLowerCase().slice(0, 28);
  // 过滤混入"已否决/决定"列表的步骤提示语（这些本是 instruction 文本而非实际决定）。
  const isInstructionNoise = (item) => {
    const t = canonical(item);
    return /^(围绕任务目标|通过内置搜索|检查方向|只整理最终交付|不要输出过程|整理最终(?:正文|成品|交付)|本步骤)/.test(t)
      || /内置搜索.{0,8}API.{0,8}本地资料库/.test(t)
      || /删空句.{0,6}补细节.{0,6}压重复/.test(t)
      || /不要让\s*AI\s*凭自身知识/.test(t);
  };
  const seen = new Map();
  const push = (item) => {
    const clean = canonical(item);
    if (!clean) return;
    if (isInstructionNoise(clean)) return;
    const key = semanticKey(clean);
    if (!key) return;
    const prev = seen.get(key);
    if (!prev || clean.length > prev.length) seen.set(key, clean);
  };
  existing.forEach(push);
  incoming.forEach(push);
  const merged = [...seen.values()];
  if (merged.length <= cap) return merged;
  // 超过上限时保留最后 cap 条（最近的事实/决定优先）。
  return merged.slice(merged.length - cap);
}
,

formatListSection(items = []) {
  if (!items.length) return "- _（尚无）_";
  return items.map((item) => `- ${item}`).join("\n");
}
,

pickHandoffLines(text = "", pattern, maxRows = 4) {
  const rows = `${text || ""}`
    .split(/\r?\n+/)
    .map((line) => line
      .replace(/^[-*#>\d.、\s]+/, "")
      .replace(/[“”]/g, "")
      .trim())
    .filter((line) => line.length >= 6 && line.length <= 180)
    .filter((line) => pattern.test(line))
    .map((line) => truncateForPrompt(line, 120));
  return uniqueValues(rows).slice(0, maxRows);
}
,

buildFallbackHandoff(step = {}, outputText = "", summary = "") {
  // 交付类步骤（初稿/深度修改/终修/标题）的输出就是文章正文本身，
  // 在此构造 fallback handoff 会把正文句子当成"决定/事实"回写进 state.md，
  // 导致交接文档被成品段落污染。这类步骤直接跳过，让 state.md 只保留元信息。
  const deliverableTypes = new Set(["agent", "draft", "revise", "title"]);
  if (deliverableTypes.has(step.taskType)) return null;
  const basis = `${summary || localStepSummary(outputText, 700)}`.trim();
  if (!basis) return null;
  const stepText = [step.taskType, step.title, step.instruction].filter(Boolean).join("\n");
  const decisions = this.pickHandoffLines(
    basis,
    /(确定|统一|采用|保持|必须|交付形式|读者|受众|结构|口径|标题|直接输出)/,
    4
  );
  const rejected = this.pickHandoffLines(
    `${basis}\n${stepText}`,
    /(不要|避免|禁区|否决|删除|不能|不得|拒绝)/,
    4
  );
  const openQuestions = this.pickHandoffLines(
    `${basis}\n${outputText.slice(0, 2400)}`,
    /(待确认|待核实|无法证实|资料不足|缺少|需要补|需补|不确定)/,
    4
  );
  const facts = extractFactClaims(basis, 4).map((item) => truncateForPrompt(item, 120));
  if (!decisions.length && !rejected.length && !openQuestions.length && !facts.length) return null;
  return { decisions, rejected, openQuestions, facts };
}
,

async applyHandoffToState(state = {}, step = {}, handoff = null, fallbackSummary = "") {
  const file = this.getRunStatePath(state);
  if (!file) return;
  let text = (await this.readRunStateText(state)) || this.buildInitialRunStateText(state);

  if (handoff) {
    const sections = [
      ["decisions", handoff.decisions],
      ["rejected", handoff.rejected],
      ["open", handoff.openQuestions],
      ["facts", handoff.facts]
    ];
    for (const [name, incoming] of sections) {
      if (!incoming?.length) continue;
      const existing = this.parseBulletList(this.extractMarkedRegion(text, name));
      const merged = this.mergeListSection(existing, incoming, 24);
      text = this.replaceMarkedRegion(text, name, this.formatListSection(merged));
    }
  }

  // 交付类步骤的 summary 多半来自 localStepSummary(outputText)，即正文前 10 行，
  // 写进日志会污染 state.md。这里统一替换成元信息，正文只留在步骤输出或显式发布的文件中。
  const deliverableTypes = new Set(["agent", "draft", "revise", "title"]);
  const isDeliverable = deliverableTypes.has(step.taskType);
  const rawSummary = `${fallbackSummary || step.summary || ""}`.trim();
  const entrySummary = isDeliverable
    ? `本步为交付类输出（${step.taskType || "final"}），正文已落盘到 ${step.outputFile || "输出文件"}；正文不写入 state.md。`
    : (truncateForPrompt(rawSummary, 500) || "（无摘要）");
  const entryHeader = `### ${String((step.index ?? 0) + 1).padStart(2, "0")} · ${step.title || "未命名步骤"} · ${localNow()}`;
  const entry = `${entryHeader}\n${entrySummary}`;
  const existingLog = this.extractMarkedRegion(text, "log");
  const nextLog = existingLog ? `${existingLog}\n\n${entry}` : entry;
  // 日志区域不做整体裁剪（保留完整历史便于回溯），注入 prompt 时按字符预算再裁。
  text = this.replaceMarkedRegion(text, "log", nextLog);

  await writeTextAtomic(file, text);
}
,

async buildRunContext(state = {}, step = {}) {
  if (step.taskType && step.taskType !== "agent") {
    return this.buildHistoricalRunContext(state, step);
  }
  return [
    state.id ? `运行 ID：${state.id}` : "",
    state.workflowName || state.workflowId
      ? `执行来源：${state.workflowName || state.workflowId}`
      : ""
  ].filter(Boolean).join("\n");
}

};
