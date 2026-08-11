// @ts-check

const { loadAgentCore } = require("./coreDependency");
const {
  createAgentModel,
  responseToAgentStream,
  errorToAgentStream,
  agentMessagesToOpenAI,
  summarizeAgentUsage,
  lastAssistantText
} = require("./messageProtocol");
const { AgentToolRuntime } = require("./toolRuntime");
const {
  resolveExecutionBudget,
  claimExecutionBudget
} = require("../agentTools/executionBudget");
const {
  containsToolProtocol,
  stripInternalToolProtocol
} = require("../../shared/internalToolProtocol");

/**
 * @typedef {Object} AgentLoopResult
 * @property {string} text
 * @property {number} rounds
 * @property {any[]} toolCalls
 * @property {any} contextStats
 * @property {any} usage
 * @property {boolean} exhausted
 * @property {boolean} aborted
 * @property {boolean} budgetExhausted
 * @property {string} stopCode
 */

/** @param {any} [options] @returns {Promise<AgentLoopResult>} */
async function runToolLoop(options = {}) {
  assertDependencies(options);
  const externalRunTaskArgs = options.runTaskArgs || {};
  const turnAbortController = new AbortController();
  const runTaskArgs = {
    ...externalRunTaskArgs,
    signal: combineTurnSignals(externalRunTaskArgs.signal || null, turnAbortController.signal)
  };
  const maxRounds = normalizeOptionalPositiveInt(options.maxRounds);
  const executionBudget = resolveExecutionBudget({
    existing: options.toolCtx?.executionBudget,
    maxModelCalls: normalizeOptionalPositiveInt(options.maxTotalModelCalls),
    maxToolCalls: normalizeOptionalPositiveInt(options.maxTotalToolCalls),
    wallClockMs: normalizeOptionalPositiveInt(options.maxWallClockMs),
    signal: runTaskArgs.signal || null
  });
  const runtime = await new AgentToolRuntime({
    ...options,
    maxCallsPerRound: normalizeOptionalPositiveInt(options.maxCallsPerRound)
  }, executionBudget).initialize();
  const agentCore = await loadAgentCore();
  const control = createAgentTurnControl(turnAbortController);
  const state = createKernelState({
    options: { ...options, runTaskArgs }, runtime, executionBudget, maxRounds, control
  });
  const prompt = {
    role: "user",
    content: `${runTaskArgs.input || runTaskArgs.instruction || "完成当前任务。"}`,
    timestamp: Date.now()
  };
  const config = {
    model: state.model,
    convertToLlm: async (messages) => messages,
    toolExecution: "parallel",
    beforeToolCall: (context, signal) => runtime.beforeToolCall(context, signal),
    afterToolCall: (context) => runtime.afterToolCall(context),
    prepareNextTurn: ({ context, message }) => prepareNextAgentTurn(state, context, message),
    shouldStopAfterTurn: ({ message }) => shouldStopAfterAgentTurn(state, message),
    getSteeringMessages: () => control.takeSteering(),
    getFollowUpMessages: () => takeAgentFollowUp(state)
  };
  let transcript = [];
  let finalResult = null;
  try {
    options.onAgentReady?.(control);
    transcript = await agentCore.runAgentLoop(
      [prompt],
      { systemPrompt: "", messages: [], tools: runtime.tools },
      config,
      async (event) => handleAgentEvent(event, state),
      executionBudget.signal || runTaskArgs.signal || undefined,
      createAiRouterStreamFn(state)
    );
  } catch (error) {
    state.failure = error;
  }
  try {
    finalResult = await finalizeAgentLoop(state, transcript);
    return finalResult;
  } finally {
    control.close();
    try { await options.onAgentClosed?.(control, finalResult); } catch { /* 关闭通知不遮蔽 Agent 结果。 */ }
    await runtime.cleanup().catch(() => {});
  }
}

function combineTurnSignals(external, internal) {
  if (!external) return internal;
  if (typeof AbortSignal.any === "function") return AbortSignal.any([external, internal]);
  const controller = new AbortController();
  const forward = (signal) => {
    if (!controller.signal.aborted) controller.abort(signal.reason);
  };
  for (const signal of [external, internal]) {
    if (signal.aborted) {
      forward(signal);
      break;
    }
    signal.addEventListener("abort", () => forward(signal), { once: true });
  }
  return controller.signal;
}

function createKernelState({ options, runtime, executionBudget, maxRounds, control }) {
  return {
    options,
    runtime,
    executionBudget,
    maxRounds,
    model: createAgentModel(),
    baseResponse: null,
    modelCalls: 0,
    currentRound: -1,
    failure: null,
    lastResponse: null,
    terminalProtocolLeakDetected: false,
    maxModelCalls: normalizeOptionalPositiveInt(options.maxAgentModelCalls),
    lastToolBatchFingerprint: "",
    repeatedToolBatches: 0,
    // 通用 Agent 不按“连续三次相同工具”猜测任务已经停滞；轮次、调用量或
    // 墙钟预算只有宿主显式传入时才终止执行。该保护仍保留为可选运行参数。
    maxRepeatedToolBatches: normalizePositiveInt(
      options.maxRepeatedToolBatches,
      Number.POSITIVE_INFINITY
    ),
    truncatedTextParts: [],
    pendingTruncationFollowUp: false,
    emptyTruncations: 0,
    maxEmptyTruncations: normalizePositiveInt(options.maxEmptyTruncations, 3),
    artifactFollowUps: 0,
    maxArtifactFollowUps: normalizeOptionalPositiveInt(options.maxArtifactFollowUps),
    artifactPendingFingerprint: "",
    stalledArtifactFollowUps: 0,
    maxStalledArtifactFollowUps: normalizePositiveInt(options.maxStalledArtifactFollowUps, 3),
    control,
    stopCode: ""
  };
}

function createAiRouterStreamFn(state) {
  return async (_model, context) => {
    state.runtime.setAdvertisedTools(context.tools);
    if (state.modelCalls >= state.maxModelCalls) {
      const error = Object.assign(new Error("Agent 已达到本地模型轮次上限。"), {
        code: "AGENT_MODEL_ROUND_LIMIT"
      });
      state.failure = error;
      return errorToAgentStream(error, state.model, false);
    }
    const claim = claimExecutionBudget(state.executionBudget, "model");
    if (!claim.ok) {
      const aborted = claim.code === "AGENT_ABORTED";
      const error = Object.assign(new Error(claim.error), { code: claim.code });
      state.failure = error;
      return errorToAgentStream(error, state.model, aborted);
    }
    state.modelCalls += 1;
    const tokenBuffer = createTokenBuffer(state.options.runTaskArgs?.onToken);
    try {
      const rawResponse = state.baseResponse
        ? await continueAiRouterTask(state, context, tokenBuffer)
        : await startAiRouterTask(state, tokenBuffer);
      const sanitizedResponse = sanitizeAgentResponse(rawResponse, state);
      const response = prepareTruncatedAgentResponse(state, sanitizedResponse);
      state.lastResponse = response;
      state.model = createAgentModel(response);
      trackToolBatchProgress(state, response.toolCalls || []);
      await state.runtime.beginRound(state.currentRound, response.toolCalls || []);
      const hasTools = Array.isArray(response.toolCalls) && response.toolCalls.length > 0;
      if (hasTools || state.terminalProtocolLeakDetected || response.finishReason === "length") tokenBuffer.clear();
      else tokenBuffer.flush(response.content);
      return responseToAgentStream(response, state.model);
    } catch (error) {
      tokenBuffer.clear();
      state.failure = error;
      const aborted = isAbortError(error, state.executionBudget.signal);
      return errorToAgentStream(error, state.model, aborted);
    }
  };
}

async function prepareNextAgentTurn(state, context, message) {
  return {
    context: await state.runtime.prepareNextTurn(context, {
      allowContextEdit: needsAnotherModelTurn(state, message)
    })
  };
}

function needsAnotherModelTurn(state, message) {
  return hasToolCalls(message)
    || state.pendingTruncationFollowUp
    || state.control?.hasSteering?.()
    || unresolvedArtifactCandidates(state.runtime?.loopToolCtx?.artifactCandidates).length > 0;
}

function shouldStopAfterAgentTurn(state, message) {
  if (!hasToolCalls(message)) return false;
  if (state.control?.hasSteering?.()) return false;
  if (Number.isFinite(state.maxRounds) && state.modelCalls >= state.maxRounds) {
    state.stopCode = "AGENT_ROUND_LIMIT";
    return true;
  }
  if (state.repeatedToolBatches >= state.maxRepeatedToolBatches) {
    state.stopCode = "AGENT_STALLED";
    return true;
  }
  return false;
}

function trackToolBatchProgress(state, calls = []) {
  if (!calls.length) {
    state.lastToolBatchFingerprint = "";
    state.repeatedToolBatches = 0;
    return;
  }
  const fingerprint = calls
    .map((call) => {
      const name = `${call?.function?.name || ""}`;
      const raw = `${call?.function?.arguments || ""}`;
      try {
        return `${name}:${stableSerialize(JSON.parse(raw || "{}"))}`;
      } catch {
        return `${name}:${raw}`;
      }
    })
    .sort()
    .join("|");
  state.repeatedToolBatches = fingerprint === state.lastToolBatchFingerprint
    ? state.repeatedToolBatches + 1
    : 1;
  state.lastToolBatchFingerprint = fingerprint;
}

function stableSerialize(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${stableSerialize(value[key])}`
  )).join(",")}}`;
}

async function startAiRouterTask(state, tokenBuffer) {
  const response = await state.options.aiRouter.runTaskDetailed({
    ...state.options.runTaskArgs,
    tools: state.runtime.openAiSchemas(),
    onToken: tokenBuffer.capture,
    signal: state.executionBudget.signal || state.options.runTaskArgs?.signal || null,
    executionBudget: state.executionBudget,
    providerAttemptPreclaimed: true,
    allowTruncatedResponse: true
  });
  state.baseResponse = response;
  state.runtime.setBaseResponse(response);
  return response;
}

async function continueAiRouterTask(state, context, tokenBuffer) {
  const messages = buildContinuationMessages(state.baseResponse, context.messages);
  state.runtime.updatePeak(messages);
  return state.options.aiRouter.continueTaskDetailed({
    base: state.baseResponse,
    messages,
    tools: state.runtime.openAiSchemas(context.tools),
    toolChoice: state.options.runTaskArgs?.toolChoice || null,
    onToken: tokenBuffer.capture,
    onReasoning: state.options.runTaskArgs?.onReasoning || null,
    signal: state.executionBudget.signal || state.options.runTaskArgs?.signal || null,
    executionBudget: state.executionBudget,
    providerAttemptPreclaimed: true,
    round: state.currentRound,
    agentStage: "tool",
    allowTruncatedResponse: true
  });
}

function prepareTruncatedAgentResponse(state, response) {
  response = discardUnusableTruncatedToolCalls(response);
  const hasTools = Array.isArray(response?.toolCalls) && response.toolCalls.length > 0;
  const content = `${response?.content || ""}`;
  if (`${response?.finishReason || ""}` === "length" && !hasTools) {
    if (content) {
      state.truncatedTextParts.push(content);
      state.emptyTruncations = 0;
    } else {
      state.emptyTruncations += 1;
    }
    if (state.emptyTruncations >= state.maxEmptyTruncations) {
      state.pendingTruncationFollowUp = false;
      state.stopCode = "MODEL_OUTPUT_TRUNCATION_STALLED";
    } else {
      state.pendingTruncationFollowUp = true;
    }
    return response;
  }
  if (hasTools || !state.truncatedTextParts.length) return response;
  const mergedContent = mergeContinuationText([...state.truncatedTextParts, content]);
  state.truncatedTextParts = [];
  state.pendingTruncationFollowUp = false;
  state.emptyTruncations = 0;
  return {
    ...response,
    content: mergedContent,
    ...(response?.assistantMessage ? {
      assistantMessage: {
        ...response.assistantMessage,
        content: mergedContent || null
      }
    } : {})
  };
}

function discardUnusableTruncatedToolCalls(response) {
  if (`${response?.finishReason || ""}` !== "length" || !Array.isArray(response?.toolCalls)) {
    return response;
  }
  const toolCalls = response.toolCalls.filter((call) => (
    call?.id && call?.function?.name && typeof call?.function?.arguments === "string"
  ));
  if (toolCalls.length === response.toolCalls.length) return response;
  return {
    ...response,
    toolCalls,
    ...(response?.assistantMessage ? {
      assistantMessage: {
        ...response.assistantMessage,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        ...(!toolCalls.length ? { tool_calls: undefined } : {})
      }
    } : {})
  };
}

function mergeContinuationText(parts = []) {
  return parts.reduce((merged, part) => {
    const next = `${part || ""}`;
    if (!merged || !next) return merged + next;
    const maxOverlap = Math.min(4000, merged.length, next.length);
    for (let size = maxOverlap; size >= 8; size -= 1) {
      if (merged.slice(-size) === next.slice(0, size)) {
        return merged + next.slice(size);
      }
    }
    return merged + next;
  }, "");
}

function takeAgentFollowUp(state) {
  if (state.pendingTruncationFollowUp) {
    state.pendingTruncationFollowUp = false;
    return [{
      role: "user",
      content: "上一段模型响应达到单次输出上限。请从中断处继续，不要重复已经完成的内容；大型文件请继续使用工具分段写入。",
      timestamp: Date.now()
    }];
  }
  const artifactFollowUp = takeArtifactFollowUp(state);
  return artifactFollowUp;
}

function createAgentTurnControl(abortController) {
  const steering = [];
  let closed = false;
  const enqueue = (queue, message, trackConsumption = false) => {
    const normalized = normalizeQueuedAgentMessage(message);
    if (closed || !normalized) return { accepted: false, consumed: Promise.resolve(false) };
    /** @type {(consumed:boolean) => void} */
    let settle = () => {};
    const consumed = trackConsumption
      ? new Promise((resolve) => { settle = resolve; })
      : Promise.resolve(true);
    queue.push({ message: normalized, settle });
    return { accepted: true, consumed };
  };
  const take = (queue) => queue.splice(0).map((entry) => {
    entry.settle(true);
    return entry.message;
  });
  const closeQueue = (queue) => {
    for (const entry of queue.splice(0)) entry.settle(false);
  };
  const enqueueSteering = (message) => enqueue(steering, message, true);
  return Object.freeze({
    // Pi 的 public steering 语义保持 Boolean；宿主协调器使用 receipt 消除
    // “最后一次 poll 与 turn close 之间消息被接受却未消费”的竞态。
    steer: (message) => enqueueSteering(message).accepted,
    enqueueSteering,
    abort: (reason = "Agent turn aborted") => {
      if (closed || abortController.signal.aborted) return false;
      abortController.abort(new Error(`${reason || "Agent turn aborted"}`));
      return true;
    },
    hasSteering: () => steering.length > 0,
    takeSteering: () => take(steering),
    close: () => {
      closed = true;
      closeQueue(steering);
    },
    get closed() { return closed; }
  });
}

function normalizeQueuedAgentMessage(message) {
  const content = typeof message === "string" ? message : `${message?.content || ""}`;
  if (!content.trim()) return null;
  return {
    role: "user",
    content,
    timestamp: Number(message?.timestamp) || Date.now()
  };
}

function takeArtifactFollowUp(state) {
  if (state.options.requireResolvedArtifacts !== true) return [];
  const pending = unresolvedArtifactCandidates(state.runtime?.loopToolCtx?.artifactCandidates);
  if (!pending.length) return [];
  const fingerprint = JSON.stringify(pending.map((candidate) => [
    `${candidate?.absolute || ""}`,
    `${candidate?.status || ""}`,
    `${candidate?.inspectionId || ""}`
  ]).sort((left, right) => left[0].localeCompare(right[0])));
  if (fingerprint === state.artifactPendingFingerprint) state.stalledArtifactFollowUps += 1;
  else state.stalledArtifactFollowUps = 0;
  state.artifactPendingFingerprint = fingerprint;
  if (state.artifactFollowUps >= state.maxArtifactFollowUps
    || state.stalledArtifactFollowUps >= state.maxStalledArtifactFollowUps) {
    state.stopCode = "AGENT_ARTIFACTS_UNRESOLVED";
    return [];
  }
  state.artifactFollowUps += 1;
  const rows = pending.slice(0, 8).map((candidate) => (
    `- ${candidate.absolute}（${candidate.status || "candidate"}）`
  ));
  return [{
    role: "user",
    content: [
      "以下候选文件尚未完成交付闭环：",
      ...rows,
      "请先用 inspect_artifact 读取真实内容并对照用户要求；合格则用 publish_artifact 发布，不采用则用 discard_artifact_candidate 标记废弃。不要用自然文本代替这一步。"
    ].join("\n"),
    timestamp: Date.now()
  }];
}

function unresolvedArtifactCandidates(candidates) {
  if (!(candidates instanceof Map)) return [];
  return [...candidates.values()].filter((candidate) => (
    !["published", "discarded"].includes(`${candidate?.status || ""}`)
  ));
}

function buildContinuationMessages(baseResponse, messages, options = {}) {
  const source = Array.isArray(messages) ? messages.slice(1) : [];
  if (options.dropLastAssistant && source.at(-1)?.role === "assistant") source.pop();
  return [
    ...(baseResponse?.requestMessages || []),
    ...agentMessagesToOpenAI(source)
  ];
}

async function handleAgentEvent(event, state) {
  if (event?.type === "turn_start") {
    state.currentRound += 1;
  }
  state.runtime.onAgentEvent(event);
}

async function finalizeAgentLoop(state, transcript) {
  const aborted = state.executionBudget.signal?.aborted || isAbortError(state.failure);
  if (aborted) {
    return buildAgentResult(state, "", transcript, {
      exhausted: true,
      aborted: true,
      budgetExhausted: false,
      stopCode: "AGENT_ABORTED"
    });
  }
  const lastAssistant = [...transcript].reverse().find((message) => message?.role === "assistant");
  const unfinishedToolTurn = hasToolCalls(lastAssistant);
  const unresolvedArtifacts = state.stopCode === "AGENT_ARTIFACTS_UNRESOLVED";
  const text = unfinishedToolTurn || state.terminalProtocolLeakDetected || unresolvedArtifacts
    ? ""
    : lastAssistantText(transcript);
  const stopCode = !text.trim()
    ? (state.failure?.code
      || state.stopCode
      || (unfinishedToolTurn
        ? "AGENT_ROUND_LIMIT"
        : (state.terminalProtocolLeakDetected ? "AGENT_TOOL_PROTOCOL_LEAK" : "AGENT_EMPTY_RESULT")))
    : "";
  return buildAgentResult(state, text, transcript, {
    exhausted: !text.trim(),
    budgetExhausted: state.executionBudget.remaining("tool") <= 0 || isBudgetStopCode(stopCode),
    stopCode
  });
}

/** @returns {AgentLoopResult} */
function buildAgentResult(state, text, transcript, extra = {}) {
  const contextStats = state.runtime.contextStats(extra);
  return {
    text: `${text || ""}`,
    rounds: state.modelCalls,
    toolCalls: sortToolCalls(state.runtime.toolCalls, state.runtime.callIndexById),
    contextStats,
    usage: summarizeAgentUsage(transcript, state.modelCalls),
    exhausted: Boolean(extra.exhausted),
    aborted: Boolean(extra.aborted),
    budgetExhausted: Boolean(extra.budgetExhausted),
    stopCode: `${extra.stopCode || ""}`
  };
}

function sortToolCalls(toolCalls, order) {
  return [...toolCalls].sort((left, right) => (
    Number(left.round) - Number(right.round)
    || (order.get(left.callId) ?? Number.MAX_SAFE_INTEGER) - (order.get(right.callId) ?? Number.MAX_SAFE_INTEGER)
  ));
}

function hasToolCalls(message) {
  return Array.isArray(message?.content)
    && message.content.some((item) => item?.type === "toolCall");
}

function createTokenBuffer(onToken) {
  const tokens = [];
  return {
    capture: (token) => { if (token) tokens.push(`${token}`); },
    flush: (finalContent = "") => {
      const captured = tokens.join("");
      if (typeof onToken === "function" && tokens.length) {
        const visible = `${finalContent || ""}`;
        if (visible === captured) {
          for (const token of tokens) onToken(token);
        } else if (visible) {
          onToken(visible);
        }
      }
      tokens.length = 0;
    },
    clear: () => { tokens.length = 0; }
  };
}

function sanitizeAgentResponse(response, state) {
  state.terminalProtocolLeakDetected = false;
  const rawContent = `${response?.content ?? response?.assistantMessage?.content ?? ""}`;
  if (!containsToolProtocol(rawContent)) return response;
  const content = stripInternalToolProtocol(rawContent);
  state.terminalProtocolLeakDetected = !(
    Array.isArray(response?.toolCalls) && response.toolCalls.length > 0
  );
  return {
    ...response,
    content,
    ...(response?.assistantMessage ? {
      assistantMessage: {
        ...response.assistantMessage,
        content: content || null
      }
    } : {})
  };
}

function isBudgetStopCode(code = "") {
  return [
    "AGENT_MODEL_BUDGET_EXCEEDED",
    "AGENT_TOOL_BUDGET_EXCEEDED",
    "AGENT_DEADLINE_EXCEEDED"
  ].includes(`${code || ""}`);
}

function normalizePositiveInt(value, fallback) {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function normalizeOptionalPositiveInt(value) {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) && number > 0 ? number : Number.POSITIVE_INFINITY;
}

function isAbortError(error, signal = null) {
  return Boolean(
    signal?.aborted
    || error?.name === "AbortError"
    || error?.code === "ABORT_ERR"
    || error?.code === "AGENT_ABORTED"
  );
}

function assertDependencies(options) {
  if (!options?.aiRouter?.runTaskDetailed || !options?.aiRouter?.continueTaskDetailed) {
    throw new Error("Agent loop 需要支持原生 messages 的 AiRouter。");
  }
  if (!options?.registry?.toSchemas || !options?.registry?.execute) {
    throw new Error("Agent loop 缺少 AgentToolRegistry。");
  }
}

module.exports = { runToolLoop, buildContinuationMessages, createAgentTurnControl };
