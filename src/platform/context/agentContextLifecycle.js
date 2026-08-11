// @ts-check

const { estimateRequestTokens, estimateTokens } = require("../tokens/tokenEstimator");
const { calculateMessagesToKeepIndex } = require("./sessionCompactionBoundary");

/**
 * @typedef {Object} AgentLoopContextPolicy
 * @property {boolean} [enabled]
 * @property {number} [triggerRatio]
 * @property {number} [maxActiveTokens]
 * @property {number} [clearStartRatio]
 * @property {number} [triggerTokens]
 * @property {number} [clearStartTokens]
 * @property {number} [hardInputTokens]
 * @property {number} [inlineToolResultTokens]
 * @property {number} [toolResultPreviewTokens]
 * @property {number} [keepRecentToolGroups]
 * @property {number} [checkpointMaxEvents]
 * @property {number} [checkpointArgumentChars]
 * @property {number} [checkpointPreviewChars]
 * @property {number} [minKeepTokens]
 * @property {number} [maxKeepTokens]
 */

/** @type {Readonly<AgentLoopContextPolicy>} */
const DEFAULT_AGENT_LOOP_CONTEXT_POLICY = Object.freeze({
  enabled: true,
  triggerRatio: 0.6,
  maxActiveTokens: 100000,
  clearStartRatio: 0.72,
  inlineToolResultTokens: 10000,
  toolResultPreviewTokens: 1800,
  keepRecentToolGroups: 2,
  checkpointMaxEvents: 24,
  checkpointArgumentChars: 600,
  checkpointPreviewChars: 320,
  minKeepTokens: 12000,
  maxKeepTokens: 32000
});

function clamp(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

/**
 * @param {any} [base]
 * @param {AgentLoopContextPolicy} [override]
 * @returns {Required<Pick<AgentLoopContextPolicy, "enabled" | "triggerTokens" | "clearStartTokens" | "hardInputTokens" | "inlineToolResultTokens" | "toolResultPreviewTokens" | "keepRecentToolGroups" | "checkpointMaxEvents" | "checkpointArgumentChars" | "checkpointPreviewChars" | "minKeepTokens" | "maxKeepTokens">>}
 */
function resolveAgentLoopContextPolicy(base = {}, override = {}) {
  const configured = base?.settings?.context?.agentLoop || {};
  const sessionMemory = base?.settings?.context?.sessionMemory || {};
  const merged = {
    ...DEFAULT_AGENT_LOOP_CONTEXT_POLICY,
    ...configured,
    ...(Number(sessionMemory.compactTriggerTokens) > 0
      ? { maxActiveTokens: Number(sessionMemory.compactTriggerTokens) }
      : {}),
    ...(Number(sessionMemory.minKeepTokens) > 0
      ? { minKeepTokens: Number(sessionMemory.minKeepTokens) }
      : {}),
    ...(Number(sessionMemory.maxKeepTokens) > 0
      ? { maxKeepTokens: Number(sessionMemory.maxKeepTokens) }
      : {}),
    ...override
  };
  const modelContextTokens = Math.max(8000, Number(base.modelContextTokens) || 128000);
  const outputReserveTokens = Math.max(0, Number(base.outputReserveTokens) || Number(base.maxTokens) || 6000);
  const hardInputTokens = Math.max(0, modelContextTokens - outputReserveTokens - Math.max(8192, Math.ceil(modelContextTokens * 0.01)));
  const minimumTrigger = Math.min(4000, hardInputTokens);
  const ratioLimit = Math.floor(hardInputTokens * clamp(merged.triggerRatio, 0.25, 0.9, 0.6));
  const configuredLimit = Math.max(8000, Number(merged.maxActiveTokens) || DEFAULT_AGENT_LOOP_CONTEXT_POLICY.maxActiveTokens);
  const requestedTrigger = Number(merged.triggerTokens);
  const triggerTokens = Number.isFinite(requestedTrigger) && requestedTrigger > 0
    ? Math.max(minimumTrigger, Math.min(hardInputTokens, requestedTrigger))
    : Math.max(minimumTrigger, Math.min(hardInputTokens, ratioLimit, configuredLimit));
  const minimumClearStart = Math.min(3000, triggerTokens);
  const requestedClearStart = Number(merged.clearStartTokens);
  const clearStartTokens = Number.isFinite(requestedClearStart) && requestedClearStart > 0
    ? Math.max(minimumClearStart, Math.min(triggerTokens, requestedClearStart))
    : Math.max(minimumClearStart, Math.floor(triggerTokens * clamp(merged.clearStartRatio, 0.5, 0.95, 0.72)));
  return {
    enabled: merged.enabled !== false,
    triggerTokens,
    clearStartTokens,
    hardInputTokens,
    inlineToolResultTokens: Math.max(500, Number(merged.inlineToolResultTokens) || 10000),
    toolResultPreviewTokens: Math.max(200, Number(merged.toolResultPreviewTokens) || 1800),
    keepRecentToolGroups: Math.max(1, Math.min(6, Number(merged.keepRecentToolGroups) || 2)),
    checkpointMaxEvents: Math.max(4, Math.min(80, Number(merged.checkpointMaxEvents) || Number(DEFAULT_AGENT_LOOP_CONTEXT_POLICY.checkpointMaxEvents))),
    checkpointArgumentChars: Math.max(120, Number(merged.checkpointArgumentChars) || Number(DEFAULT_AGENT_LOOP_CONTEXT_POLICY.checkpointArgumentChars)),
    checkpointPreviewChars: Math.max(120, Number(merged.checkpointPreviewChars) || Number(DEFAULT_AGENT_LOOP_CONTEXT_POLICY.checkpointPreviewChars)),
    minKeepTokens: Math.max(1000, Number(merged.minKeepTokens) || Number(DEFAULT_AGENT_LOOP_CONTEXT_POLICY.minKeepTokens)),
    maxKeepTokens: Math.max(
      Math.max(1000, Number(merged.minKeepTokens) || Number(DEFAULT_AGENT_LOOP_CONTEXT_POLICY.minKeepTokens)),
      Number(merged.maxKeepTokens) || Number(DEFAULT_AGENT_LOOP_CONTEXT_POLICY.maxKeepTokens)
    )
  };
}

function serializeContextValue(value) {
  if (typeof value === "string") return value;
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? `${value}` : serialized;
  } catch {
    return `${value}`;
  }
}

function previewText(text = "", maxChars = 900) {
  const source = `${text || ""}`;
  const limit = Math.max(1, Math.floor(Number(maxChars) || 1));
  if (source.length <= limit) return source;
  const marker = "\n…[中间内容已外置]…\n";
  if (limit <= marker.length + 2) return source.slice(0, limit);
  const available = limit - marker.length;
  const head = Math.max(1, Math.floor(available * 0.68));
  const tail = Math.max(1, available - head);
  return `${source.slice(0, head)}${marker}${source.slice(-tail)}`;
}

function previewTextTokens(text = "", maxTokens = 1800) {
  const source = `${text || ""}`;
  const tokenLimit = Math.max(1, Math.floor(Number(maxTokens) || 1));
  if (estimateTokens(source) <= tokenLimit) return source;
  let low = 1;
  let high = source.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (estimateTokens(previewText(source, middle)) <= tokenLimit) low = middle;
    else high = middle - 1;
  }
  return previewText(source, low);
}

/** @param {any} [record] @param {AgentLoopContextPolicy} [policy] */
function buildToolResultReceipt(record = {}, policy = DEFAULT_AGENT_LOOP_CONTEXT_POLICY) {
  return JSON.stringify({
    contextEdited: true,
    tool: record.toolName || "",
    ...(record.trust === "untrusted_external_data" ? { trust: "untrusted_external_data" } : {}),
    resultRef: record.resultRef || "",
    totalChars: Number(record.totalChars) || 0,
    totalTokens: Number(record.totalTokens) || 0,
    preview: previewTextTokens(record.preview || "", Number(policy.toolResultPreviewTokens) || 1800),
    read: "调用 read_context_result，传 resultRef 与 offsetChars 分页读取完整结果。"
  });
}

/** @param {any} payload @param {any} [record] @param {AgentLoopContextPolicy} [policy] */
function buildToolResultMessageContent(payload, record = {}, policy = DEFAULT_AGENT_LOOP_CONTEXT_POLICY) {
  const serialized = serializeContextValue(payload);
  if (estimateTokens(serialized) <= Number(policy.inlineToolResultTokens || 10000)) return serialized;
  return buildToolResultReceipt({ ...record, preview: record.preview || serialized }, policy);
}

function cloneMessage(message = {}) {
  return { ...message };
}

/** @param {{messages?: any[], records?: any[], currentRound?: number, policy?: AgentLoopContextPolicy}} [options] */
function clearOldToolResults({ messages = [], records = [], currentRound = 0, policy = DEFAULT_AGENT_LOOP_CONTEXT_POLICY } = {}) {
  const keepFromRound = Math.max(0, currentRound - Number(policy.keepRecentToolGroups || 2) + 1);
  const byCallId = new Map(records.map((record) => [record.callId, record]));
  const clearedCallIds = [];
  const edited = messages.map((message) => {
    if (!["tool", "toolResult"].includes(message?.role)) return message;
    const callId = message.role === "toolResult" ? message.toolCallId : message.tool_call_id;
    const record = byCallId.get(callId);
    if (!record || Number(record.round) >= keepFromRound || record.cleared) return message;
    record.cleared = true;
    clearedCallIds.push(record.callId);
    const receipt = buildToolResultReceipt(record, policy);
    return {
      ...cloneMessage(message),
      content: message.role === "toolResult"
        ? [{ type: "text", text: receipt }]
        : receipt
    };
  });
  return { messages: edited, clearedCallIds };
}

function compactArguments(value, maxChars) {
  return previewText(serializeContextValue(value), maxChars);
}

/** @param {{records?: any[], policy?: AgentLoopContextPolicy, episode?: number}} [options] */
function buildCheckpointPayload({ records = [], policy = DEFAULT_AGENT_LOOP_CONTEXT_POLICY, episode = 1 } = {}) {
  const maxEvents = Number(policy.checkpointMaxEvents) || Number(DEFAULT_AGENT_LOOP_CONTEXT_POLICY.checkpointMaxEvents);
  const selected = records.slice(-maxEvents);
  const archived = records.slice(0, Math.max(0, records.length - selected.length));
  return {
    version: 2,
    type: "agent-context-checkpoint",
    episode,
    objectiveSource: "保留的初始 user message",
    completedActions: selected.map((record) => ({
      round: record.round,
      tool: record.toolName,
      arguments: compactArguments(record.args, Number(policy.checkpointArgumentChars) || Number(DEFAULT_AGENT_LOOP_CONTEXT_POLICY.checkpointArgumentChars)),
      ok: record.ok !== false,
      resultRef: record.resultRef,
      ...(record.trust === "untrusted_external_data" ? { trust: "untrusted_external_data" } : {}),
      preview: previewText(record.preview || "", Number(policy.checkpointPreviewChars) || Number(DEFAULT_AGENT_LOOP_CONTEXT_POLICY.checkpointPreviewChars))
    })),
    // 早期动作不再从模型可见世界中消失。保留一个有界、无正文的索引，
    // 让 Agent 始终能用 resultRef 回读完整结果；详细预览只留给最近动作。
    archivedActionIndex: archived.map((record) => ({
      round: record.round,
      tool: record.toolName,
      arguments: compactArguments(record.args, Math.min(120, Number(policy.checkpointArgumentChars) || 120)),
      ok: record.ok !== false,
      resultRef: record.resultRef,
      ...(record.trust === "untrusted_external_data" ? { trust: "untrusted_external_data" } : {})
    })),
    omittedEarlierActions: 0,
    continuation: "继续完成初始任务。需要旧工具结果时，用 read_context_result 按 resultRef 分页读取。"
  };
}

/** @param {{rootMessages?: any[], records?: any[], policy?: AgentLoopContextPolicy, episode?: number}} [options] */
function buildCheckpointMessages({ rootMessages = [], records = [], policy = DEFAULT_AGENT_LOOP_CONTEXT_POLICY, episode = 1 } = {}) {
  const roots = (Array.isArray(rootMessages) ? rootMessages : []).map(cloneMessage);
  const checkpoint = buildCheckpointPayload({ records, policy, episode });
  return [
    ...roots,
    {
      role: "user",
      content: `【AGENT_CONTEXT_CHECKPOINT】\n${JSON.stringify(checkpoint)}`,
      timestamp: Date.now()
    }
  ];
}

/** @param {{rootMessages?:any[], historyMessages?:any[], note?:string, boundary?:any, episode?:number}} [options] */
function buildSessionMemoryCheckpointMessages({
  rootMessages = [], historyMessages = [], note = "", boundary = null, episode = 1
} = {}) {
  const roots = (Array.isArray(rootMessages) ? rootMessages : []).map(cloneMessage);
  const rows = Array.isArray(historyMessages) ? historyMessages : [];
  const keepIndex = Math.max(0, Math.min(rows.length, Number(boundary?.keepIndex) || 0));
  const checkpoint = {
    role: "user",
    content: [
      "【SESSION_MEMORY_COMPACT】",
      `episode：${episode}`,
      "以下内容来自后台渐进维护的 session/memory.md；它是历史连续性摘要，当前用户要求与近期原始消息优先。",
      "<session-memory>",
      `${note || ""}`.trim(),
      "</session-memory>"
    ].join("\n"),
    timestamp: Date.now(),
    sessionMemoryCheckpoint: true
  };
  return [...roots, checkpoint, ...rows.slice(keepIndex).map(cloneMessage)];
}

/** @param {{messages?: any[], tools?: any[], rootMessages?: any[], records?: any[], currentRound?: number, episode?: number, policy?: AgentLoopContextPolicy, sessionMemory?:any, estimateContextTokens?:(messages:any[], tools:any[])=>number}} [options] */
function editAgentLoopContext({ messages = [], tools = [], rootMessages = [], records = [], currentRound = 0, episode = 0, policy = DEFAULT_AGENT_LOOP_CONTEXT_POLICY, sessionMemory = null, estimateContextTokens = null } = {}) {
  const activePolicy = policy;
  const estimateContext = typeof estimateContextTokens === "function"
    ? estimateContextTokens
    : (rows, schemas) => estimateRequestTokens({ messages: rows, tools: schemas });
  const beforeTokens = estimateContext(messages, tools);
  const rootFloorTokens = estimateContext(rootMessages, tools);
  const hardInputTokens = Number(activePolicy.hardInputTokens) > 0
    ? Number(activePolicy.hardInputTokens)
    : Infinity;
  const configuredTriggerTokens = Number(activePolicy.triggerTokens) > 0
    ? Number(activePolicy.triggerTokens)
    : Math.max(4000, Number(activePolicy.maxActiveTokens) || 160000);
  const configuredClearStartTokens = Number(activePolicy.clearStartTokens) > 0
    ? Number(activePolicy.clearStartTokens)
    : Math.floor(configuredTriggerTokens * clamp(activePolicy.clearStartRatio, 0.5, 0.95, 0.72));
  const effectiveTriggerTokens = Math.min(
    hardInputTokens,
    Math.max(configuredTriggerTokens, rootFloorTokens + 12000)
  );
  const effectiveClearStartTokens = Math.min(
    effectiveTriggerTokens,
    Math.max(configuredClearStartTokens, rootFloorTokens + 4000)
  );
  if (activePolicy.enabled === false || beforeTokens < effectiveClearStartTokens) {
    return { messages, beforeTokens, afterTokens: beforeTokens, clearedCallIds: [], checkpointed: false, episode };
  }
  const cleared = clearOldToolResults({ messages, records, currentRound, policy: activePolicy });
  const clearedTokens = estimateContext(cleared.messages, tools);
  if (clearedTokens < effectiveTriggerTokens) {
    return {
      messages: cleared.messages,
      beforeTokens,
      afterTokens: clearedTokens,
      clearedCallIds: cleared.clearedCallIds,
      checkpointed: false,
      episode
    };
  }
  const nextEpisode = episode + 1;
  const historyMessages = cleared.messages.slice(rootMessages.length);
  const sessionBoundary = sessionMemory?.boundary || calculateMessagesToKeepIndex(historyMessages, {
    lastSummaryIndex: Number(sessionMemory?.coveredIndex) || 0,
    priorCompactionBoundary: Number(sessionMemory?.priorCompactionBoundary) || 0,
    minKeepTokens: Number(activePolicy.minKeepTokens) || 12000,
    maxKeepTokens: Number(activePolicy.maxKeepTokens) || 32000
  });
  const useSessionMemory = Boolean(`${sessionMemory?.note || ""}`.trim());
  let checkpointMessages = useSessionMemory
    ? buildSessionMemoryCheckpointMessages({
      rootMessages,
      historyMessages,
      note: sessionMemory.note,
      boundary: sessionBoundary,
      episode: nextEpisode
    })
    : buildCheckpointMessages({ rootMessages, records, policy: activePolicy, episode: nextEpisode });
  let checkpointTokens = estimateContext(checkpointMessages, tools);
  if (checkpointTokens > hardInputTokens && !useSessionMemory) {
    const minimalPolicy = {
      ...activePolicy,
      checkpointMaxEvents: 4,
      checkpointArgumentChars: 120,
      checkpointPreviewChars: 120
    };
    checkpointMessages = buildCheckpointMessages({ rootMessages, records, policy: minimalPolicy, episode: nextEpisode });
    checkpointTokens = estimateContext(checkpointMessages, tools);
  }
  if (checkpointTokens > hardInputTokens) {
    const error = /** @type {Error & {code?: string, rootTokens?: number, hardInputTokens?: number}} */ (
      new Error(`Agent 根上下文 ${rootFloorTokens} tokens 未给 checkpoint 留出可用空间。`)
    );
    error.code = "AGENT_CONTEXT_ROOT_EXHAUSTED";
    error.rootTokens = rootFloorTokens;
    error.hardInputTokens = hardInputTokens;
    throw error;
  }
  return {
    messages: checkpointMessages,
    beforeTokens,
    afterTokens: checkpointTokens,
    clearedCallIds: cleared.clearedCallIds,
    checkpointed: true,
    episode: nextEpisode,
    strategy: useSessionMemory ? "session-memory" : "deterministic-checkpoint",
    keepIndex: useSessionMemory ? sessionBoundary.keepIndex : 0,
    keptHistoryCount: useSessionMemory
      ? Math.max(0, historyMessages.length - Number(sessionBoundary.keepIndex || 0)) + 1
      : 0,
    noteCoveredTail: useSessionMemory
      ? Number(sessionMemory.coveredIndex || 0) >= historyMessages.length
      : false
  };
}

module.exports = {
  DEFAULT_AGENT_LOOP_CONTEXT_POLICY,
  resolveAgentLoopContextPolicy,
  serializeContextValue,
  previewText,
  previewTextTokens,
  buildToolResultReceipt,
  buildToolResultMessageContent,
  clearOldToolResults,
  buildCheckpointPayload,
  buildCheckpointMessages,
  buildSessionMemoryCheckpointMessages,
  editAgentLoopContext
};
