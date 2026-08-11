// @ts-check

const { estimateMessageTokens } = require("../tokens/tokenEstimator");

const DEFAULT_SESSION_COMPACTION_BOUNDARY = Object.freeze({
  minKeepTokens: 12000,
  maxKeepTokens: 32000
});

/**
 * 计算压缩后保留消息的起点。Token 预算只能在完整消息组之间移动；
 * 工具调用、流式片段与 thinking 关联的协议完整性优先于预算。
 *
 * @param {any[]} messages
 * @param {{lastSummaryIndex?:number, priorCompactionBoundary?:number, minKeepTokens?:number, maxKeepTokens?:number, estimate?: (messages:any[]) => number}} [options]
 */
function calculateMessagesToKeepIndex(messages = [], options = {}) {
  const rows = Array.isArray(messages) ? messages : [];
  const estimate = typeof options.estimate === "function" ? options.estimate : estimateMessageTokens;
  const minKeepTokens = positiveInteger(
    options.minKeepTokens,
    DEFAULT_SESSION_COMPACTION_BOUNDARY.minKeepTokens
  );
  const maxKeepTokens = Math.max(
    minKeepTokens,
    positiveInteger(options.maxKeepTokens, DEFAULT_SESSION_COMPACTION_BOUNDARY.maxKeepTokens)
  );
  const groups = buildAtomicMessageGroups(rows, estimate);
  const priorBoundary = clampIndex(options.priorCompactionBoundary, rows.length);
  const summaryIndex = clampIndex(options.lastSummaryIndex, rows.length);
  const safePriorBoundary = boundaryAtOrAfter(groups, priorBoundary, rows.length);
  const lowerGroup = firstGroupAtOrAfter(groups, safePriorBoundary);
  let keepGroup = firstGroupContainingBoundary(groups, Math.max(safePriorBoundary, summaryIndex));
  if (keepGroup < lowerGroup) keepGroup = lowerGroup;
  let keepTokens = sumGroupTokens(groups, keepGroup);

  if (keepTokens > maxKeepTokens) {
    while (keepGroup < groups.length - 1 && keepTokens > maxKeepTokens) {
      keepTokens -= groups[keepGroup].tokens;
      keepGroup += 1;
    }
  } else if (keepTokens < minKeepTokens) {
    while (keepGroup > lowerGroup) {
      const candidate = groups[keepGroup - 1];
      if (keepTokens + candidate.tokens > maxKeepTokens) break;
      keepGroup -= 1;
      keepTokens += candidate.tokens;
      if (keepTokens >= minKeepTokens) break;
    }
  }

  const keepIndex = keepGroup < groups.length ? groups[keepGroup].start : rows.length;
  return {
    keepIndex,
    keepTokens,
    lastSummaryIndex: boundaryAtOrBefore(groups, summaryIndex, rows.length),
    priorCompactionBoundary: safePriorBoundary,
    minKeepTokens,
    maxKeepTokens,
    atomicGroups: groups.map((group) => ({
      start: group.start,
      end: group.end,
      tokens: group.tokens,
      reasons: [...group.reasons]
    })),
    protocolOversize: keepTokens > maxKeepTokens
  };
}

/** @param {any[]} messages @param {(messages:any[]) => number} estimate */
function buildAtomicMessageGroups(messages, estimate = estimateMessageTokens) {
  if (!messages.length) return [];
  const parents = messages.map((_message, index) => index);
  const reasons = messages.map(() => new Set());
  const messageIds = new Map();
  const toolUses = new Map();
  const toolResults = new Map();

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index] || {};
    const id = messageIdentity(message);
    if (id) messageIds.set(id, index);
    for (const callId of toolCallIds(message)) toolUses.set(callId, index);
    const resultId = toolResultId(message);
    if (resultId) toolResults.set(resultId, index);
    if (index > 0 && sharedFragmentKey(messages[index - 1]) === sharedFragmentKey(message)
      && sharedFragmentKey(message)) {
      unionRange(parents, reasons, index - 1, index, "stream-fragments");
    }
  }

  for (let index = 0; index < messages.length; index += 1) {
    const parentId = parentMessageIdentity(messages[index]);
    if (parentId && messageIds.has(parentId)) {
      unionRange(parents, reasons, messageIds.get(parentId), index, "message-association");
    }
  }
  for (const [callId, useIndex] of toolUses) {
    const resultIndex = toolResults.get(callId);
    if (Number.isInteger(resultIndex)) {
      unionRange(parents, reasons, useIndex, resultIndex, "tool-use-result");
    }
  }

  const groups = [];
  let start = 0;
  while (start < messages.length) {
    const root = find(parents, start);
    let end = start + 1;
    while (end < messages.length && find(parents, end) === root) end += 1;
    const groupReasons = new Set();
    for (let index = start; index < end; index += 1) {
      for (const reason of reasons[find(parents, index)]) groupReasons.add(reason);
    }
    groups.push({
      start,
      end,
      tokens: Math.max(0, Number(estimate(messages.slice(start, end))) || 0),
      reasons: groupReasons
    });
    start = end;
  }
  return groups;
}

function toolCallIds(message = {}) {
  const pi = Array.isArray(message.content)
    ? message.content.filter((item) => item?.type === "toolCall").map((item) => `${item.id || ""}`)
    : [];
  const openAi = Array.isArray(message.tool_calls)
    ? message.tool_calls.map((item) => `${item?.id || ""}`)
    : [];
  return [...new Set([...pi, ...openAi].filter(Boolean))];
}

function toolResultId(message = {}) {
  if (!["tool", "toolResult"].includes(`${message.role || ""}`)) return "";
  return `${message.toolCallId || message.tool_call_id || ""}`;
}

function messageIdentity(message = {}) {
  return `${message.messageId || message.message_id || message.id || ""}`;
}

function parentMessageIdentity(message = {}) {
  return `${message.parentMessageId || message.parent_message_id || message.thinkingParentId || ""}`;
}

function sharedFragmentKey(message = {}) {
  const explicit = message.fragmentGroupId
    || message.fragment_group_id
    || message.streamId
    || message.stream_id
    || message.thinkingGroupId
    || message.thinking_group_id;
  if (explicit) return `${explicit}`;
  if (message.fragmentIndex !== undefined || message.fragment_index !== undefined) {
    return messageIdentity(message);
  }
  return "";
}

function unionRange(parents, reasons, leftValue, rightValue, reason) {
  let left = Math.max(0, Math.min(leftValue, rightValue));
  const right = Math.min(parents.length - 1, Math.max(leftValue, rightValue));
  while (left < right) {
    union(parents, reasons, left, left + 1, reason);
    left += 1;
  }
}

function union(parents, reasons, left, right, reason) {
  const leftRoot = find(parents, left);
  const rightRoot = find(parents, right);
  if (leftRoot === rightRoot) {
    reasons[leftRoot].add(reason);
    return;
  }
  parents[rightRoot] = leftRoot;
  for (const item of reasons[rightRoot]) reasons[leftRoot].add(item);
  reasons[leftRoot].add(reason);
}

function find(parents, index) {
  if (parents[index] !== index) parents[index] = find(parents, parents[index]);
  return parents[index];
}

function firstGroupAtOrAfter(groups, index) {
  const found = groups.findIndex((group) => group.start >= index || group.end > index);
  return found < 0 ? groups.length : found;
}

function firstGroupContainingBoundary(groups, index) {
  if (!groups.length) return 0;
  const found = groups.findIndex((group) => index <= group.start || index < group.end);
  return found < 0 ? groups.length : found;
}

function boundaryAtOrBefore(groups, index, length) {
  if (index >= length) return length;
  const group = groups.find((item) => index >= item.start && index < item.end);
  return group ? group.start : index;
}

function boundaryAtOrAfter(groups, index, length) {
  if (index >= length) return length;
  const group = groups.find((item) => index > item.start && index < item.end);
  return group ? group.end : index;
}

function sumGroupTokens(groups, start) {
  return groups.slice(start).reduce((sum, group) => sum + group.tokens, 0);
}

function clampIndex(value, length) {
  const number = Math.floor(Number(value) || 0);
  return Math.max(0, Math.min(length, number));
}

function positiveInteger(value, fallback) {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

module.exports = {
  DEFAULT_SESSION_COMPACTION_BOUNDARY,
  buildAtomicMessageGroups,
  calculateMessagesToKeepIndex
};
