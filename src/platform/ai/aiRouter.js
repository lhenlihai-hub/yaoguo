const {
  crypto,
  TokenLedger,
  ModelGateway,
  truncate,
  estimateTokens,
  redactSensitive,
  sleep
} = require("../runtime");
const { estimateRequestTokens } = require("../tokens/tokenEstimator");
const aiRouterTelemetryActions = require("./actions/aiRouterTelemetryActions");
const aiRouterGatewayActions = require("./actions/aiRouterGatewayActions");
const aiRouterContextActions = require("./actions/aiRouterContextActions");
const aiRouterRequestActions = require("./actions/aiRouterRequestActions");
const { resolveMaxTokens } = require("./maxTokensRegistry");
const { resolveDeepSeekV4Policy } = require("./deepseekV4Policy");
const { claimExecutionBudget } = require("./agentTools/executionBudget");
const { RegistryService } = require("../registries/registryService");

class AiRouter {
  constructor(settingsService, paths = null, options = {}) {
    this.settingsService = settingsService;
    this.paths = paths;
    this.tokenLedger = options.tokenLedger || (paths ? new TokenLedger(paths) : null);
    this.modelGateway = new ModelGateway();
    this.registryService = options.registryService || (paths ? new RegistryService(paths) : null);
    this.memoryCacheService = options.memoryCacheService || null;
  }

  async runTask(args = {}) {
    const result = await this.runTaskDetailed(args);
    return result.content;
  }

  claimProviderAttempt(executionBudget = null, providerAttemptPreclaimed = false) {
    if (!executionBudget || providerAttemptPreclaimed) return null;
    const claim = claimExecutionBudget(executionBudget, "model");
    if (claim.ok) return claim;
    const error = new Error(claim.error || "Agent 模型调用预算不足。");
    error.code = claim.code || "AGENT_MODEL_BUDGET_EXCEEDED";
    throw error;
  }

  async runTaskDetailed({
    taskType = "default",
    title = "",
    instruction = "",
    input = "",
    runContext = "",
    contextProfile = "",
    contextBudget = {},
    contentFilterSafe = false,
    jsonMode = false,
    responseFormat = null,
    onToken = null,
    onReasoning = null,
    tools = null,
    toolChoice = null,
    onToolCalls = null,
    signal = null,
    pinnedSections = [],
    instructionReminder = "",
    instructionMemorySummary = null,
    memoryCacheScope = "",
    internalCall = false,
    projectId = "",
    taskId = "",
    runId = "",
    stepId = "",
    agentStage = "initial",
    thinkingOverride = null,
    reasoningEffortOverride = "",
    maxOutputTokens = 0,
    executionBudget = null,
    providerAttemptPreclaimed = false,
    allowTruncatedResponse = false,
    _retry = null
  } = {}) {
    let streamedAnyToken = false;
    const setupStartedAt = new Date();
    let setup;
    let setupProvider = null;
    let setupModel = "";
    try {
      const { settings, provider, model } = await this.resolve();
      setupProvider = provider;
      setupModel = model;
      this.claimProviderAttempt(executionBudget, providerAttemptPreclaimed);
      const effectiveSignal = executionBudget?.signal || signal || null;
      const retry = _retry || { transientAttempts: 0, totalAttempts: 0 };
      const propagated = {
        taskType, title, instruction, input, runContext, contextProfile, contextBudget,
        contentFilterSafe, jsonMode, responseFormat,
        onToken, onReasoning, tools, toolChoice, onToolCalls, signal: effectiveSignal,
        pinnedSections, instructionReminder, instructionMemorySummary,
        memoryCacheScope,
        internalCall, projectId, taskId, runId, stepId,
        agentStage, thinkingOverride, reasoningEffortOverride, maxOutputTokens, executionBudget,
        providerAttemptPreclaimed: false, allowTruncatedResponse
      };
      const effectiveOnToken = this.resolveEffectiveOnToken({ jsonMode, responseFormat, onToken });
      const tokenHandler = effectiveOnToken
        ? (delta) => { streamedAnyToken = true; effectiveOnToken(delta); }
        : null;
      const reasoningHandler = typeof onReasoning === "function"
        ? (delta, event) => { if (delta) streamedAnyToken = true; onReasoning(delta, event); }
        : null;
      const callTimeoutMs = this.resolveCallTimeoutMs({ jsonMode, responseFormat });
      const modelMaxTokens = resolveMaxTokens({ model, providerOverride: provider.maxTokens });
      const callMaxTokens = Number.isFinite(Number(maxOutputTokens)) && Number(maxOutputTokens) > 0
        ? Math.min(modelMaxTokens, Math.floor(Number(maxOutputTokens)))
        : modelMaxTokens;
      const deepseekPolicy = resolveDeepSeekV4Policy({
        provider, model, taskType, hasTools: Array.isArray(tools) && tools.length > 0,
        settings, agentStage, thinkingOverride, reasoningEffortOverride
      });
      const request = await this.prepareTaskRequest({
        provider, model, settings, callMaxTokens,
        taskType, title, instruction, input, runContext, contextProfile, contextBudget,
        contentFilterSafe,
        pinnedSections, instructionReminder, instructionMemorySummary, memoryCacheScope,
        internalCall, tools, executionBudget, signal: effectiveSignal
      });
      const startedAt = new Date();
      const call = this.buildTaskCallEntry({
        callId: crypto.randomUUID(), startedAt, provider, model, deepseekPolicy, callMaxTokens,
        taskType, title, instruction, input, runContext, projectId, taskId, runId,
        stepId, contentFilterSafe, jsonMode, responseFormat, tokenHandler,
        instructionMemorySummary
      }, request);
      setup = { settings, provider, model, effectiveSignal, retry, propagated,
        tokenHandler, reasoningHandler, callTimeoutMs, callMaxTokens, deepseekPolicy, request, startedAt, call };
    } catch (error) {
      await this.logCall({
        id: crypto.randomUUID(), createdAt: setupStartedAt.toISOString(), taskType, title,
        providerId: setupProvider?.id || "", providerName: setupProvider?.name || setupProvider?.id || "", model: setupModel,
        projectId, taskId, runId, stepId, status: "error", phase: "setup",
        durationMs: Date.now() - setupStartedAt.getTime(), error: `${error?.message || error}`
      }).catch(() => {});
      throw error;
    }
    const { settings, provider, model, effectiveSignal, retry, propagated,
      tokenHandler, reasoningHandler, callTimeoutMs, callMaxTokens, deepseekPolicy, request, startedAt, call } = setup;
    try {
      const response = await this.completeDetailed(provider, model, request.messages, {
        jsonMode,
        responseFormat,
        onToken: tokenHandler,
        onReasoning: reasoningHandler,
        tools: Array.isArray(tools) && tools.length ? tools : undefined,
        toolChoice: toolChoice || undefined,
        onToolCalls: typeof onToolCalls === "function" ? onToolCalls : undefined,
        signal: effectiveSignal || undefined,
        timeoutMs: callTimeoutMs,
        taskType,
        settings,
        maxTokens: callMaxTokens,
        deepseekPolicy,
        thinkingOverride,
        reasoningEffortOverride,
        allowTruncatedResponse
      });
      const content = response.content;
      const usage = response.usage;
      await this.logCall({
        ...call,
        status: "completed",
        durationMs: Date.now() - startedAt.getTime(),
        outputChars: content.length,
        outputTokens: estimateTokens(content),
        outputPreview: truncate(redactSensitive(content), 1600),
        actualPromptTokens: usage?.promptTokens || null,
        actualCompletionTokens: usage?.completionTokens || null,
        reasoningTokens: usage?.reasoningTokens || null,
        cacheHitTokens: usage?.cacheHitTokens ?? null,
        cacheMissTokens: usage?.cacheMissTokens ?? null,
        cacheHitRate: usage?.cacheHitRate ?? null,
        finishReason: response.finishReason || null,
        actualContextUsageRatio: usage?.promptTokens
          ? Number(((usage.promptTokens + (usage.completionTokens || 0)) / Math.max(1, request.modelContextTokens)).toFixed(4))
          : null
      });
      return {
        ...response,
        requestMessages: request.messages,
        provider,
        model,
        settings,
        taskType,
        title,
        projectId,
        taskId,
        runId,
        stepId,
        agentStage,
        thinkingOverride,
        reasoningEffortOverride,
        maxTokens: callMaxTokens,
        deepseekPolicy,
        modelContextTokens: request.modelContextTokens,
        outputReserveTokens: request.outputReserveTokens
      };
    } catch (error) {
      await this.logCall({
        ...call,
        status: "error",
        durationMs: Date.now() - startedAt.getTime(),
        error: error.message
      });
      return this.retryTaskAfterError({
        error, retry, streamedAnyToken, propagated, settings, provider, model,
        request
      });
    }
  }

  // 原生工具循环的后续轮次。首轮由 runTaskDetailed 负责完整上下文装配；后续轮固定
  // provider/model，并直接发送累计 messages，避免把 tool result 重新包装成用户文本。
  async continueTaskDetailed({
    base = {},
    messages = [],
    tools = [],
    toolChoice = null,
    onToken = null,
    onReasoning = null,
    signal = null,
    executionBudget = null,
    providerAttemptPreclaimed = false,
    round = 1,
    agentStage = "tool",
    allowTruncatedResponse = false
  } = {}) {
    const { provider, model, settings, taskType = "default", title = "" } = base;
    const effectiveSignal = executionBudget?.signal || signal || null;
    const thinkingOverride = base.thinkingOverride ?? null;
    const reasoningEffortOverride = `${base.reasoningEffortOverride || ""}`;
    const setupStartedAt = new Date();
    let setup;
    try {
      if (!provider || !model || !settings) throw new Error("原生工具循环缺少首轮模型上下文。");
      this.claimProviderAttempt(executionBudget, providerAttemptPreclaimed);
      const deepseekPolicy = resolveDeepSeekV4Policy({
        provider, model, taskType, hasTools: Array.isArray(tools) && tools.length > 0,
        settings, agentStage, thinkingOverride, reasoningEffortOverride
      });
      const baseMaxTokens = Number(base.maxTokens) || resolveMaxTokens({
        model,
        providerOverride: provider.maxTokens
      });
      const maxTokens = baseMaxTokens;
      const promptTokens = estimateRequestTokens({ messages, tools });
      const modelContextTokens = this.getModelContextTokens(provider, model, settings);
      const outputReserveTokens = this.getOutputReserveTokens(provider, settings, maxTokens);
      this.assertContextWindow(promptTokens, modelContextTokens, outputReserveTokens);
      setup = { deepseekPolicy, maxTokens, promptTokens, modelContextTokens, outputReserveTokens };
    } catch (error) {
      await this.logCall({
        id: crypto.randomUUID(), createdAt: setupStartedAt.toISOString(), taskType, title,
        providerId: provider?.id || "", providerName: provider?.name || provider?.id || "", model: model || "",
        projectId: base.projectId || "", taskId: base.taskId || "", runId: base.runId || "", stepId: base.stepId || "",
        status: "error", phase: "setup", durationMs: Date.now() - setupStartedAt.getTime(),
        error: `${error?.message || error}`
      }).catch(() => {});
      throw error;
    }
    const { deepseekPolicy, maxTokens, promptTokens, modelContextTokens, outputReserveTokens } = setup;
    let streamedAnyToken = false;
    const tokenHandler = typeof onToken === "function"
      ? (delta) => { streamedAnyToken = true; onToken(delta); }
      : null;
    const reasoningHandler = typeof onReasoning === "function"
      ? (delta, event) => { if (delta) streamedAnyToken = true; onReasoning(delta, event); }
      : null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const startedAt = new Date();
      const call = {
        id: crypto.randomUUID(),
        createdAt: startedAt.toISOString(),
        projectId: base.projectId || "",
        taskId: base.taskId || "",
        runId: base.runId || "",
        stepId: base.stepId || "",
        taskType,
        title: `${title || "Agent"} · 工具轮次 ${round + 1}`,
        providerId: provider.id,
        providerName: provider.name || provider.id,
        model,
        promptTokens,
        modelContextTokens,
        contextUsageRatio: Number((promptTokens / Math.max(1, modelContextTokens)).toFixed(4)),
        thinkingMode: deepseekPolicy.applicable ? deepseekPolicy.thinking : null,
        reasoningEffort: deepseekPolicy.applicable ? deepseekPolicy.reasoningEffort : null,
        maxOutputTokens: maxTokens,
        outputReserveTokens,
        attempt: attempt + 1
      };
      try {
        if (attempt > 0) this.claimProviderAttempt(executionBudget, false);
        const response = await this.completeDetailed(provider, model, messages, {
          onToken: tokenHandler,
          onReasoning: reasoningHandler,
          tools: Array.isArray(tools) && tools.length ? tools : undefined,
          toolChoice: toolChoice || undefined,
          signal: effectiveSignal || undefined,
          taskType,
          settings,
          maxTokens,
          deepseekPolicy,
          thinkingOverride,
          reasoningEffortOverride,
          allowTruncatedResponse
        });
        await this.logCall({
          ...call,
          status: "completed",
          durationMs: Date.now() - startedAt.getTime(),
          outputChars: response.content.length,
          outputTokens: estimateTokens(response.content),
          actualPromptTokens: response.usage?.promptTokens || null,
          actualCompletionTokens: response.usage?.completionTokens || null,
          reasoningTokens: response.usage?.reasoningTokens || null,
          cacheHitTokens: response.usage?.cacheHitTokens ?? null,
          cacheMissTokens: response.usage?.cacheMissTokens ?? null,
          cacheHitRate: response.usage?.cacheHitRate ?? null,
          finishReason: response.finishReason || null,
          actualContextUsageRatio: response.usage?.promptTokens
            ? Number(((response.usage.promptTokens + (response.usage.completionTokens || 0)) / Math.max(1, modelContextTokens)).toFixed(4))
            : null
        });
        return {
          ...response,
          requestMessages: messages,
          provider,
          model,
          settings,
          taskType,
          title,
          projectId: base.projectId || "",
          taskId: base.taskId || "",
          runId: base.runId || "",
          stepId: base.stepId || "",
          agentStage,
          thinkingOverride,
          reasoningEffortOverride,
          maxTokens,
          deepseekPolicy
        };
      } catch (error) {
        await this.logCall({
          ...call,
          status: "error",
          durationMs: Date.now() - startedAt.getTime(),
          error: error.message
        }).catch(() => {});
        if (streamedAnyToken || attempt >= 2 || !this.isTransientModelError(error)) throw error;
        await sleep(Math.min(4000, 750 * (2 ** attempt)) + Math.floor(Math.random() * 250));
      }
    }
    throw new Error("工具轮次执行失败。");
  }

  // 流式与超时策略（业界对齐）：
  // 1. 默认全开 stream，仅在 jsonMode/responseFormat 时回退非流式——OpenAI / Anthropic / Vercel AI SDK
  //    都按这个语义（structured output 不流，自由文本默认流）。之前白名单方案在 outline 步骤被实测
  //    打穿（8 次 120s 墙钟超时浪费 16 分钟），故倒置为黑名单。
  // 2. 墙钟统一 600s 兜底，所有调用一致；真正的"长输出不被中途打断"由 ModelGateway 的 idle timer 负责
  //    （reader 每收到一个 chunk 就重置 idle，无 token 静默 N 秒才 abort）。
  shouldDefaultToStream({ jsonMode = false, responseFormat = null } = {}) {
    return !jsonMode && !responseFormat;
  }

  resolveEffectiveOnToken({ jsonMode = false, responseFormat = null, onToken = null } = {}) {
    if (typeof onToken === "function") return onToken;
    if (!this.shouldDefaultToStream({ jsonMode, responseFormat })) return null;
    // noop sink：仅用于触发 ModelGateway 的 stream 分支。
    return () => {};
  }

  resolveCallTimeoutMs({ jsonMode = false, responseFormat = null } = {}) {
    // 不在路由层覆盖墙钟。ModelGateway 会根据 taskType、模型类型和 settings.timeouts
    // 选择 default / reasoning-long-output profile。结构化非流调用仍使用其 120s 默认值。
    void jsonMode;
    void responseFormat;
    return undefined;
  }

  // 所有面向用户的模型调用共享同一人格、行为边界与审美原则。
  // taskType 只保留为模型策略、预算与遥测元数据，不改变人格或输出方法。
  // internalCall 走 assembleInternalSystemPrompt，不接收 soul 或审美原则。
  async assembleSystemPromptSections(_taskType = "", { cacheScope = "" } = {}) {
    const soul = await this.loadSystemPromptBlock("block://soul.zh", { required: true });
    const systemAgentBlock = await this.loadSystemPromptBlock("block://system.agent", { required: true });
    const memoryCache = await this.loadSystemPromptSection(
      "block://system.agent",
      "memory.cache",
      { required: true, cacheScope }
    );
    const memoryBehavior = await this.loadSystemPromptSection(
      "block://system.agent",
      "memory.behavior",
      { required: true, cacheScope }
    );
    const aestheticPrinciple = await this.loadSystemPromptBlock("block://aesthetic.baseline.zh", { required: true });
    return [soul, systemAgentBlock, memoryCache, memoryBehavior, aestheticPrinciple];
  }

  async assembleSystemPrompt(taskType = "", options = {}) {
    return (await this.assembleSystemPromptSections(taskType, options)).join("\n\n");
  }

  // System prompt 资产加载（带 in-memory 缓存）。
  // RegistryService 是唯一读取入口；必需资产失败时终止调用，不带空 Prompt 继续运行。
  async loadSystemPromptBlock(blockId = "", { required = false } = {}) {
    if (!blockId) return "";
    if (!this._systemPromptBlockCache) this._systemPromptBlockCache = new Map();
    if (this._systemPromptBlockCache.has(blockId)) return this._systemPromptBlockCache.get(blockId);
    if (!this.registryService) {
      if (required) {
        const error = new Error(`缺少 Prompt Registry，无法加载必需资产：${blockId}`);
        error.code = "REQUIRED_PROMPT_UNAVAILABLE";
        throw error;
      }
      return "";
    }
    const row = await this.registryService.getPromptBlock(blockId, { required });
    const content = typeof row?.asset?.content === "string" ? row.asset.content.trim() : "";
    if (content) this._systemPromptBlockCache.set(blockId, content);
    return content;
  }

  async loadSystemPromptSection(blockId = "", sectionId = "", { required = false, cacheScope = "" } = {}) {
    if (!blockId || !sectionId) return "";
    const cache = this.systemPromptSectionCache(cacheScope);
    if (cache.has(sectionId)) return cache.get(sectionId);
    if (!this.registryService) {
      if (required) throw requiredPromptSectionError(blockId, sectionId);
      return "";
    }
    const row = await this.registryService.getPromptBlock(blockId, { required });
    const content = typeof row?.asset?.sections?.[sectionId] === "string"
      ? row.asset.sections[sectionId].trim()
      : "";
    if (!content && required) throw requiredPromptSectionError(blockId, sectionId);
    if (content) cache.set(sectionId, content);
    return content;
  }

  systemPromptSectionCache(cacheScope = "") {
    if (cacheScope && this.memoryCacheService?.session) {
      return this.memoryCacheService.session(cacheScope).systemPromptSections;
    }
    if (!this._systemPromptSectionCache) this._systemPromptSectionCache = new Map();
    return this._systemPromptSectionCache;
  }

}

function requiredPromptSectionError(blockId, sectionId) {
  const error = new Error(`缺少必需 Prompt section：${blockId}#${sectionId}`);
  error.code = "REQUIRED_PROMPT_SECTION_UNAVAILABLE";
  error.blockId = blockId;
  error.sectionId = sectionId;
  return error;
}

Object.assign(
  AiRouter.prototype,
  aiRouterTelemetryActions,
  aiRouterGatewayActions,
  aiRouterContextActions,
  aiRouterRequestActions
);

module.exports = {
  AiRouter
};
