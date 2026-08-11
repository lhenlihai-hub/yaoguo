const {
  crypto,
  fsp,
  path,
  writeTextAtomic,
  localNow,
  stampForId,
  sanitizeFileName,
  truncateForPrompt
} = require("../../../platform/runtime");
module.exports = {
decisionCardsFrom(container = {}) {
  return Array.isArray(container.decisionCards) ? container.decisionCards : [];
}
,

pendingDecisionCards(container = {}) {
  return this.decisionCardsFrom(container).filter((card) => card?.status === "pending");
}
,

blockingDecisionCards(container = {}) {
  return this.pendingDecisionCards(container).filter((card) => card?.blocking !== false);
}
,

normalizeDecisionChoice(choice = {}, index = 0) {
  const label = truncateForPrompt(`${choice.label || choice.title || `选项 ${index + 1}`}`.trim(), 18) || `选项 ${index + 1}`;
  const description = truncateForPrompt(`${choice.description || choice.reason || choice.text || ""}`.trim(), 120);
  return {
    id: sanitizeFileName(choice.id || label || `choice-${index + 1}`, `choice-${index + 1}`).toLowerCase(),
    label,
    description,
    recommended: choice.recommended === true,
    score: Number.isFinite(Number(choice.score)) ? Number(choice.score) : Math.max(0.5, 0.9 - index * 0.08),
    effects: choice.effects && typeof choice.effects === "object" ? choice.effects : {}
  };
}
,

normalizeDecisionCard(card = {}, defaults = {}) {
  const choices = (Array.isArray(card.choices) ? card.choices : [])
    .map((choice, index) => this.normalizeDecisionChoice(choice, index))
    .filter((choice) => choice.label && choice.description);
  const uniqueChoices = [];
  const seen = new Set();
  for (const choice of choices) {
    const key = `${choice.label}::${choice.description}`.replace(/\s+/g, "");
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueChoices.push(choice);
    if (uniqueChoices.length >= 4) break;
  }
  if (uniqueChoices.length < 2) return null;
  if (!uniqueChoices.some((choice) => choice.recommended)) {
    uniqueChoices[0].recommended = true;
  } else {
    let found = false;
    for (const choice of uniqueChoices) {
      if (choice.recommended && !found) {
        found = true;
      } else {
        choice.recommended = false;
      }
    }
  }
  const now = new Date().toISOString();
  const rawScope = `${card.scope || defaults.scope || "task"}`;
  const scope = ["task", "run", "step"].includes(rawScope) ? rawScope : "task";
  const type = ["clarify", "creative_fork", "workflow_choice", "fact_gap", "approval", "content_preflight"].includes(card.type || defaults.type)
    ? (card.type || defaults.type)
    : "clarify";
  // N2：kind 是子类型标记（如 "clarification" 区分 open_question 转出来的卡）。
  // 跟 type 正交：type 是通用决策类型（clarify/creative_fork/...），kind 标识来源 sub-pipeline。
  const kind = `${card.kind || defaults.kind || ""}`.trim() || null;
  return {
    id: card.id || `decision-${stampForId()}-${crypto.randomUUID().slice(0, 8)}`,
    version: 1,
    type,
    kind,
    scope,
    projectId: card.projectId || defaults.projectId || "",
    taskId: card.taskId || defaults.taskId || "",
    runId: card.runId || defaults.runId || "",
    stepId: card.stepId || defaults.stepId || "",
    stepIndex: Number.isInteger(card.stepIndex) ? card.stepIndex : (Number.isInteger(defaults.stepIndex) ? defaults.stepIndex : null),
    blocking: card.blocking !== false,
    question: truncateForPrompt(`${card.question || defaults.question || "需要你确认一个方向"}`.trim(), 120),
    why: truncateForPrompt(`${card.why || card.reason || defaults.why || "这个选择会影响后续工作流和成品方向。"}`.trim(), 180),
    choices: uniqueChoices,
    allowOther: card.allowOther !== false,
    status: card.status || "pending",
    createdAt: card.createdAt || now,
    updatedAt: card.updatedAt || now,
    // M1：emittedAt = emit decision_required 时刻；userWaitMs 起点。
    // 由 addDecisionCardToRun/Task emit 前赋值（normalize 调用本身不设默认）。
    // 老 card 没有此字段 → 落到 createdAt fallback（兼容旧 run）。
    emittedAt: card.emittedAt || null,
    answeredAt: card.answeredAt || null,
    answer: card.answer || null,
    previewSnippet: typeof card.previewSnippet === "string"
      ? truncateForPrompt(card.previewSnippet.trim(), 600)
      : (typeof defaults.previewSnippet === "string"
        ? truncateForPrompt(defaults.previewSnippet.trim(), 600)
        : ""),
    artifactRef: (card.artifactRef && typeof card.artifactRef === "object")
      ? {
        runId: `${card.artifactRef.runId || ""}`,
        stepId: `${card.artifactRef.stepId || ""}`,
        kind: `${card.artifactRef.kind || ""}`,
        title: `${card.artifactRef.title || ""}`,
        relative: `${card.artifactRef.relative || ""}`
      }
      : (defaults.artifactRef && typeof defaults.artifactRef === "object"
        ? {
          runId: `${defaults.artifactRef.runId || ""}`,
          stepId: `${defaults.artifactRef.stepId || ""}`,
          kind: `${defaults.artifactRef.kind || ""}`,
          title: `${defaults.artifactRef.title || ""}`,
          relative: `${defaults.artifactRef.relative || ""}`
        }
        : null),
    resume: {
      ...(defaults.resume || {}),
      ...(card.resume && typeof card.resume === "object" ? card.resume : {})
    }
  };
}
,

decisionFingerprint(text = "") {
  return crypto.createHash("sha1").update(`${text || ""}`.replace(/\s+/g, "").slice(0, 1000)).digest("hex").slice(0, 12);
}
,

hasAnsweredDecision(container = {}, { type = "", fingerprint = "", stepId = "" } = {}) {
  return this.decisionCardsFrom(container).some((card) => {
    if (card.status !== "answered") return false;
    if (type && card.type !== type) return false;
    if (fingerprint && card.resume?.fingerprint !== fingerprint) return false;
    if (stepId && card.stepId !== stepId) return false;
    return true;
  });
}
,

async addDecisionCardToTask(projectId = "", taskId = "", card = {}) {
  if (!this.projectService || !projectId || !taskId) return null;
  const task = await this.projectService.getTask(projectId, taskId, false);
  if (!task) return null;
  const normalized = this.normalizeDecisionCard(card, { projectId, taskId, scope: "task" });
  if (!normalized) return null;
  // M1：emittedAt 标 emit 时刻（对标 Microsoft Agent Framework RequestInfoEvent /
  // OTel events 标准）。userWaitMs 用 emit 时刻而非对象创建时刻作起点，metric 才准。
  normalized.emittedAt = new Date().toISOString();
  const cards = this.decisionCardsFrom(task).filter((item) => item.id !== normalized.id);
  cards.push(normalized);
  await this.projectService.updateTask(projectId, taskId, { decisionCards: cards });
  this.emitActivity({
    projectId,
    taskId,
    status: "decision_required",
    label: normalized.question,
    message: normalized.why,
    decisionCards: [normalized],
    emittedAt: normalized.emittedAt
  });
  return normalized;
}
,

async buildDecisionPreviewFromRun(state = {}, step = {}) {
  const steps = Array.isArray(state.steps) ? state.steps : [];
  const completedBefore = steps
    .filter((item) => item && item.status === "completed" && Number.isInteger(item.index))
    .filter((item) => !Number.isInteger(step.index) || item.index < step.index)
    .sort((a, b) => (b.index || 0) - (a.index || 0));
  for (const candidate of completedBefore) {
    if (!candidate.outputFile || !state.runDir) continue;
    const file = path.join(state.runDir, candidate.outputFile);
    const text = await fsp.readFile(file, "utf8").catch(() => "");
    const trimmed = `${text || ""}`.trim();
    if (trimmed) return trimmed.slice(-1200);
  }
  const handoff = await this.readRunStateText(state).catch(() => "");
  return `${handoff || ""}`.trim().slice(-1200);
}
,

buildDecisionArtifactRefFromRun(state = {}, step = {}) {
  const steps = Array.isArray(state.steps) ? state.steps : [];
  const completed = steps
    .filter((item) => item && item.status === "completed" && Number.isInteger(item.index))
    .filter((item) => !Number.isInteger(step.index) || item.index < step.index)
    .sort((a, b) => (b.index || 0) - (a.index || 0));
  const latest = completed[0];
  if (!latest) return null;
  return {
    runId: state.id || "",
    stepId: latest.id || "",
    kind: latest.taskType || "step-output",
    title: latest.title || "",
    relative: latest.outputFile || ""
  };
}
,

async addDecisionCardToRun(state = {}, step = {}, card = {}) {
  const defaultsPreview = card.previewSnippet
    ? ""
    : await this.buildDecisionPreviewFromRun(state, step).catch(() => "");
  const defaultsArtifactRef = card.artifactRef
    ? null
    : this.buildDecisionArtifactRefFromRun(state, step);
  const normalized = this.normalizeDecisionCard(card, {
    projectId: state.projectId,
    taskId: state.taskId,
    runId: state.id,
    stepId: step.id || "",
    stepIndex: step.index,
    scope: "step",
    previewSnippet: defaultsPreview,
    artifactRef: defaultsArtifactRef
  });
  if (!normalized) return null;
  // M1：emittedAt 标 emit 时刻（对标 Microsoft Agent Framework RequestInfoEvent /
  // OTel events 标准）。卡片对象在 normalizeDecisionCard 里设置了 createdAt，
  // 但 createdAt 是 normalize 调用时刻；emittedAt 才是用户实际看到卡片可点击的时刻。
  // 当前两者紧邻（几毫秒差），但 emittedAt 留出未来 enrichment / persistence
  // 介入 normalize → emit 之间的扩展空间，仍能保证 userWaitMs 起点严谨。
  normalized.emittedAt = new Date().toISOString();
  const cards = this.decisionCardsFrom(state).filter((item) => item.id !== normalized.id);
  cards.push(normalized);
  state.decisionCards = cards;
  this.emitActivity({
    projectId: state.projectId,
    taskId: state.taskId,
    runId: state.id,
    status: "decision_required",
    stepIndex: step.index,
    label: normalized.question,
    message: normalized.why,
    decisionCards: [normalized],
    emittedAt: normalized.emittedAt
  });
  return normalized;
}
,

async listDecisionCards({ projectId = "", taskId = "", runId = "", status = "pending" } = {}) {
  const cards = [];
  if (projectId && taskId && this.projectService) {
    const task = await this.projectService.getTask(projectId, taskId, false).catch(() => null);
    if (task) cards.push(...this.decisionCardsFrom(task));
  }
  if (runId) {
    const run = await this.readRun(runId).catch(() => null);
    if (run) cards.push(...this.decisionCardsFrom(run));
  } else if (projectId && taskId) {
    const runs = await this.listRuns(projectId, taskId).catch(() => []);
    for (const run of runs) {
      cards.push(...this.decisionCardsFrom(run));
    }
  }
  const filtered = status && status !== "all"
    ? cards.filter((card) => card.status === status)
    : cards;
  const seen = new Set();
  return filtered.filter((card) => {
    if (!card?.id || seen.has(card.id)) return false;
    seen.add(card.id);
    return true;
  });
}
,

resolveDecisionAnswer(card = {}, { choiceId = "", customText = "" } = {}) {
  const choices = Array.isArray(card.choices) ? card.choices : [];
  const choice = choices.find((item) => item.id === choiceId) || null;
  const text = `${customText || ""}`.trim();
  return {
    choiceId: choice?.id || (text ? "custom" : ""),
    label: text ? "自定义" : (choice?.label || "未选择"),
    description: text || choice?.description || "",
    customText: text,
    effects: choice?.effects || {}
  };
}
,

renderDecisionAnswerForPrompt(card = {}, answer = {}) {
  return [
    `问题：${card.question || ""}`,
    `选择：${answer.label || ""}`,
    answer.description ? `说明：${answer.description}` : "",
    Object.keys(answer.effects || {}).length ? `影响：${JSON.stringify(answer.effects)}` : ""
  ].filter(Boolean).join("\n");
}
,

appendDecisionToBrief(brief = "", card = {}, answer = {}) {
  const entry = [
    "【用户决策】",
    this.renderDecisionAnswerForPrompt(card, answer)
  ].join("\n");
  if (`${brief || ""}`.includes(entry)) return brief || "";
  return [brief || card.resume?.originalMessage || "", entry].filter(Boolean).join("\n\n").trim();
}
,

composeDecisionContinuationMessage(card = {}, answer = {}) {
  return [
    card.resume?.originalMessage || "继续执行当前内容任务。",
    "",
    "【用户已确认的决策】",
    this.renderDecisionAnswerForPrompt(card, answer),
    "",
    "请基于这个选择继续，不要再次询问同一个问题。"
  ].join("\n");
}
,

async appendDecisionToRunState(state = {}, card = {}, answer = {}) {
  const file = this.getRunStatePath(state);
  if (!file) return;
  const current = await this.readRunStateText(state).catch(() => "");
  const entry = [
    "",
    `## 用户决策 · ${localNow()}`,
    "",
    this.renderDecisionAnswerForPrompt(card, answer)
  ].join("\n");
  await writeTextAtomic(file, `${current || ""}${entry}\n`);
}
,

async answerDecisionCard({ cardId = "", choiceId = "", customText = "", projectId = "", taskId = "", runId = "" } = {}) {
  if (!cardId) throw new Error("缺少决策卡 ID。");
  if (runId) {
    const state = await this.readRun(runId).catch(() => null);
    const card = state ? this.decisionCardsFrom(state).find((item) => item.id === cardId) : null;
    if (card) {
      return this.answerRunDecisionCard({ state, card, choiceId, customText });
    }
  }
  if (projectId && taskId && this.projectService) {
    const task = await this.projectService.getTask(projectId, taskId, false);
    const card = task ? this.decisionCardsFrom(task).find((item) => item.id === cardId) : null;
    if (card) {
      return this.answerTaskDecisionCard({ projectId, taskId, task, card, choiceId, customText });
    }
  }
  throw new Error("找不到这张决策卡，可能已经处理或不属于当前任务。");
}
,

async answerTaskDecisionCard({ projectId, taskId, task, card, choiceId = "", customText = "" } = {}) {
  if (card.status !== "pending") {
    return {
      reply: "这张决策卡已经处理过。",
      decisionCards: await this.listDecisionCards({ projectId, taskId }),
      taskId
    };
  }
  const answer = this.resolveDecisionAnswer(card, { choiceId, customText });
  if (!answer.choiceId) throw new Error("请选择一个选项，或填写自定义方向。");
  const now = new Date().toISOString();
  const cards = this.decisionCardsFrom(task).map((item) => item.id === card.id
    ? { ...item, status: "answered", answer, answeredAt: now, updatedAt: now }
    : item);
  await this.projectService.updateTask(projectId, taskId, {
    decisionCards: cards,
    brief: this.appendDecisionToBrief(task.brief || card.resume?.originalMessage || "", card, answer)
  });
  const pendingCards = await this.listDecisionCards({ projectId, taskId, status: "pending" }).catch(() => []);
  this.emitActivity({
    projectId,
    taskId,
    status: "decision_answered",
    cardId: card.id,
    label: answer.label || "已选择",
    message: card.question,
    decisionCards: pendingCards
  });
  const decisionTurnId = `decision:${card.id}`;
  await this.appendAgentMessage({
    role: "user",
    content: `选择：${answer.label}${answer.description ? `\n${answer.description}` : ""}`,
    projectId,
    taskId,
    turnId: decisionTurnId,
    source: "decision"
  }).catch(() => {});
  if (card.resume?.kind === "content_preflight") {
    const result = await this.submitAgentInput({
      message: this.composeDecisionContinuationMessage(card, answer),
      projectId,
      taskId,
      runId: ""
    }, { skipUserLog: true });
    return {
      ...result,
      decisionCards: await this.listDecisionCards({ projectId, taskId, runId: result.runId || "", status: "pending" })
    };
  }
  const reply = `已记录选择：${answer.label}${answer.description ? `。${answer.description}` : ""}`;
  await this.appendAgentMessage({
    role: "assistant", content: reply, projectId, taskId,
    turnId: decisionTurnId, source: "decision", decisionCards: []
  });
  return { reply, taskId, decisionCards: await this.listDecisionCards({ projectId, taskId }) };
}
,

async answerRunDecisionCard({ state, card, choiceId = "", customText = "" } = {}) {
  if (card.status !== "pending") {
    return {
      reply: "这张决策卡已经处理过。",
      runId: state.id,
      taskId: state.taskId,
      decisionCards: await this.listDecisionCards({ projectId: state.projectId, taskId: state.taskId, runId: state.id })
    };
  }
  const answer = this.resolveDecisionAnswer(card, { choiceId, customText });
  if (!answer.choiceId) throw new Error("请选择一个选项，或填写自定义方向。");
  const now = new Date().toISOString();
  // 计算用户回答这张卡花的等待时长，单独累加进 state.totalUserWaitMs。
  // 这是"生产时间"与"人工等待时间"分离的核心：监控/统计应用方可以用
  //   总耗时 - totalUserWaitMs = 真实生产耗时
  // 来公平评价工作流提速效果，而不是把用户思考/离开的时间算到 LLM 上。
  // M1：起点用 emittedAt（emit decision_required 时刻）而非 createdAt（对象在内存
  // normalize 时刻）。两者紧邻但 emittedAt 才是用户感知到的"开始等待"时刻——对标
  // Microsoft Agent Framework RequestInfoEvent / OpenTelemetry events / Langfuse
  // trace event timestamp 业界标准。fallback createdAt 兼容历史 card（v1）。
  const waitFrom = card.emittedAt || card.createdAt || now;
  const userWaitMs = Math.max(0, new Date(now).getTime() - new Date(waitFrom).getTime());
  state.decisionCards = this.decisionCardsFrom(state).map((item) => item.id === card.id
    ? { ...item, status: "answered", answer, answeredAt: now, updatedAt: now, userWaitMs }
    : item);
  state.decisionAnswers = [
    ...(Array.isArray(state.decisionAnswers) ? state.decisionAnswers : []),
    {
      cardId: card.id,
      type: card.type,
      stepId: card.stepId || "",
      question: card.question || "",
      answer,
      answeredAt: now,
      userWaitMs
    }
  ];
  state.totalUserWaitMs = (Number(state.totalUserWaitMs) || 0) + userWaitMs;
  const step = (state.steps || []).find((item) => item.id === card.stepId || item.index === card.stepIndex);
  if (step && step.status === "blocked") {
    step.status = "pending";
    step.error = null;
    step.userWaitMs = (Number(step.userWaitMs) || 0) + userWaitMs;
  }
  const runningSteps = (state.steps || []).filter((item) => item?.status === "running");
  const blockingCards = this.blockingDecisionCards(state);
  state.status = runningSteps.length ? "running" : (blockingCards.length ? "blocked" : "pending");
  await this.writeRun(state);
  await this.appendDecisionToRunState(state, card, answer).catch(() => {});
  await this.appendAgentMessage({
    role: "user",
    content: `选择：${answer.label}${answer.description ? `\n${answer.description}` : ""}`,
    runId: state.id,
    projectId: state.projectId,
    taskId: state.taskId,
    turnId: `decision:${card.id}`,
    source: "decision"
  }).catch(() => {});
  const pendingCards = await this.listDecisionCards({
    projectId: state.projectId,
    taskId: state.taskId,
    runId: state.id,
    status: "pending"
  }).catch(() => []);
  this.emitActivity({
    projectId: state.projectId,
    taskId: state.taskId,
    runId: state.id,
    status: "decision_answered",
    stepIndex: card.stepIndex,
    cardId: card.id,
    label: answer.label || "已选择",
    message: card.question,
    decisionCards: pendingCards,
    userWaitMs,
    totalUserWaitMs: state.totalUserWaitMs || 0
  });
  if (blockingCards.length || runningSteps.length) {
    return {
      reply: "",
      artifact: null,
      runId: state.id,
      taskId: state.taskId,
      decisionCards: pendingCards
    };
  }
  const result = await this.runUntilBlocked(state.id);
  const artifact = result.run.status === "completed"
    ? await this.ensureRunArtifact(result.run).catch(() => null)
    : null;
  if (artifact) await this.cleanupRunProcessFiles(result.run.id).catch(() => {});
  const reply = this.buildWorkflowRunReply({
    workflow: {
      id: result.run.workflowId,
      name: result.run.workflowName,
      steps: result.run.steps || []
    },
    source: "decision-resume",
    result,
    artifact
  });
  if (reply) {
    await this.appendAgentMessage({
      role: "assistant",
      content: reply,
      runId: result.run.id,
      projectId: result.run.projectId,
      taskId: result.run.taskId,
      artifact,
      turnId: `decision-result:${card.id}`,
      source: "decision"
    }).catch(() => {});
  }
  return {
    reply,
    artifact,
    runId: result.run.id,
    taskId: result.run.taskId,
    decisionCards: await this.listDecisionCards({
      projectId: result.run.projectId,
      taskId: result.run.taskId,
      runId: result.run.id,
      status: "pending"
    })
  };
}
,

};
