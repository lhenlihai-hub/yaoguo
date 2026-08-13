module.exports = {
async executeAgentTurn({
  message = "", projectId = "", taskId = "", runId = "", runDir = "",
  handoffDir = "", stepId = "", turnId = "", fileReferences = [],
  state = null, step = null, instruction = "", title = "腰果 Agent",
  source = "shared",
  additionalRunContext = "",
  requestOverrides = {}, requestedToolNames = null, maxRounds = null,
  explicitOutputTargets = [], explicitOpenTargets = [], signal = null,
  onToken = null, onReasoning = null, onToolEvent = null
} = {}) {
  const preparedInput = await this.prepareAgentInputForModel({
    projectId, taskId, turnId, message
  });
  const canonicalRunContext = await this.buildAgentContext({
    projectId, taskId, runId, turnId, message, state, step
  });
  const runContext = [additionalRunContext, canonicalRunContext]
    .map((value) => `${value || ""}`.trim())
    .filter(Boolean)
    .join("\n\n");
  const hostContext = source === "terminal"
    ? "【当前宿主】终端版 TUI。当前没有桌面窗口或预览面板；只描述终端中实际存在的会话、状态行、菜单和已发布文件路径。"
    : (source === "desktop"
      ? "【当前宿主】桌面版应用。只描述当前工具结果能够证实的界面状态。"
      : "【当前宿主】后台任务执行，不呈现交互界面。只报告工具能够证实的结果与路径。");
  const conversationMessages = await this.buildAgentConversationMessages({
    projectId,
    taskId,
    currentTurnId: turnId,
    currentMessage: message
  });
  const turn = await this._executeAgent({
    runTaskArgs: this._buildAgentRequest({
      input: preparedInput.input,
      runContext: [hostContext, runContext].filter(Boolean).join("\n\n"),
      conversationMessages,
      instruction,
      title,
      ...requestOverrides,
      onToken,
      onReasoning,
      projectId,
      taskId,
      runId,
      stepId,
      signal
    }),
    projectId,
    taskId,
    runId,
    runDir,
    handoffDir,
    stepId,
    turnId,
    fileReferences,
    requestedToolNames,
    explicitOutputTargets,
    explicitOpenTargets,
    maxRounds,
    message,
    onToolEvent
  });
  const artifacts = Array.isArray(turn.artifacts) ? turn.artifacts : [];
  const reply = turn.cancelled
    ? "已停止当前任务。"
    : (turn.blocked
      ? this._describeAgentStop(turn.stopCode, turn.toolTrace?.maxRounds)
      : this.stripInternalDisclosure(turn.text || ""));
  return {
    reply,
    text: `${turn.text || ""}`,
    cancelled: Boolean(turn.cancelled),
    blocked: Boolean(turn.blocked),
    stopCode: `${turn.stopCode || ""}`,
    artifact: artifacts.at(-1) || null,
    artifacts,
    toolTrace: turn.toolTrace || null,
    usage: turn.usage || null,
    modelInput: `${turn.modelInput || ""}`,
    contextStats: turn.contextStats || null,
    preparedInput
  };
}
,

async persistAgentTurnOutcome({
  outcome = {}, projectId = "", taskId = "", runId = "", turnId = "",
  source = "desktop", errorCode = ""
} = {}) {
  const reply = `${outcome.reply || ""}`;
  if (!reply.trim() || typeof this.appendAgentMessage !== "function") return null;
  const cancelled = Boolean(outcome.cancelled);
  const blocked = Boolean(outcome.blocked);
  const memoryWritePerformed = outcome.toolTrace?.memoryWritePerformed === true;
  const modelInputRef = await persistAgentModelInput(this, {
    projectId,
    taskId,
    content: `${outcome.modelInput || ""}`
  });
  const persisted = await this.appendAgentMessage({
    role: "assistant",
    content: reply,
    projectId,
    taskId,
    runId,
    turnId,
    source,
    status: cancelled ? "cancelled" : (blocked ? "blocked" : "completed"),
    cancelled,
    blocked,
    stopCode: `${outcome.stopCode || ""}`,
    errorCode: `${errorCode || ""}`,
    artifact: outcome.artifact || null,
    artifacts: Array.isArray(outcome.artifacts) ? outcome.artifacts : [],
    usage: outcome.usage || null,
    ...(modelInputRef ? { modelInputRef } : {}),
    memoryPrefetch: outcome.contextStats?.memoryPrefetch || null,
    toolNamesUsed: usedToolNames(outcome.toolTrace),
    memoryWritePerformed
  });
  if (!cancelled && !blocked) scheduleMemoryExtraction(this, {
    projectId,
    taskId,
    runId,
    turnId,
    assistantEventId: `${persisted?.eventId || ""}`,
    assistantCreatedAt: `${persisted?.createdAt || ""}`,
    memoryWritePerformed
  });
  return persisted;
}
};

async function persistAgentModelInput(engine, {
  projectId = "", taskId = "", content = ""
} = {}) {
  if (!content.trim() || typeof engine.taskSessionStore?.persistContentBody !== "function") return null;
  const stored = await engine.taskSessionStore.persistContentBody(
    projectId,
    taskId,
    content
  ).catch(() => null);
  return stored?.sha256 ? { version: 1, sha256: stored.sha256 } : null;
}

function scheduleMemoryExtraction(engine, input = {}) {
  if (!input.assistantEventId || typeof engine.memoryExtractionService?.scheduleTurn !== "function") return null;
  try {
    return engine.memoryExtractionService.scheduleTurn(input);
  } catch {
    return null;
  }
}

function usedToolNames(toolTrace = null) {
  const rows = Array.isArray(toolTrace?.roundsOutline) ? toolTrace.roundsOutline : [];
  const names = rows.flatMap((row) => (
    Array.isArray(row?.toolCalls) ? row.toolCalls.map((call) => `${call?.name || ""}`) : []
  ));
  return [...new Set(names.filter((name) => /^[a-z][a-z0-9_]{0,63}$/.test(name)))].slice(0, 24);
}
