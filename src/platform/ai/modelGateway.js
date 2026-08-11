const { truncate } = require("../shared/text");
const { resolveDeepSeekV4Policy } = require("./deepseekV4Policy");

// T1 默认 timeout profile（按 reasoning / 长输出 vs 默认两套）。
// 业界对标：OpenAI o1 推荐 600s，Anthropic Claude thinking default 10min，
// Boundary BAML idle 60-120s + wall 300-900s，LangChain stream_until_first_token=300s。
// TTFT 语义：从请求发出到第一个 stream chunk（包含 reasoning_content / thinking event），
// 不等"可见正文 token"，避免 reasoning 模型 thinking 期间被误判超时。
const TIMEOUT_PROFILE_DEFAULTS = {
  default: { ttftMs: 60000, idleMs: 90000, wallMs: 600000 },
  reasoning: { ttftMs: 240000, idleMs: 180000, wallMs: 1500000 }
};
// 模型名 regex：匹配 reasoner / thinking / OpenAI o-系列（o1/o3/o4，含 mini / preview 变体）。
const REASONING_MODEL_PATTERN = /(reasoner|reasoning|thinking)|((^|[^a-z])o[134]([-_]|$))/i;
// taskType 触发长输出 profile（即便 model 非 reasoning，大型交付也可能超过 90s idle）。
const LONG_OUTPUT_TASK_TYPES = new Set(["agent", "draft", "revise", "visual"]);

function getApiKey(config = {}) {
  if (config.apiKey) return config.apiKey;
  if (config.apiKeyEnv && process.env[config.apiKeyEnv]) return process.env[config.apiKeyEnv];
  return "";
}

function normalizeDeepSeekV4Messages(messages = [], policy = {}) {
  const source = Array.isArray(messages) ? messages : [];
  if (!policy.applicable) return source;
  return source.map((message) => {
    const hasToolCalls = message?.role === "assistant"
      && Array.isArray(message.tool_calls)
      && message.tool_calls.length > 0;
    return hasToolCalls && message.content == null ? { ...message, content: "" } : message;
  });
}

class ModelGateway {
  validateToolCalls(toolCalls = []) {
    for (const call of (Array.isArray(toolCalls) ? toolCalls : [])) {
      if (!call?.id || call?.type !== "function" || !call?.function?.name || typeof call?.function?.arguments !== "string") {
        const error = new Error("模型返回了不完整的 tool_call（必须包含原始 id、function name 和 arguments）。");
        error.code = "MODEL_TOOL_CALL_INVALID";
        throw error;
      }
    }
  }

  validateFinishReason(finishReason = "", toolCalls = [], options = {}) {
    const reason = `${finishReason || ""}`.trim();
    if (!reason || reason === "stop") return;
    if (reason === "length" && options.allowTruncatedResponse === true) return;
    if (reason === "tool_calls" && Array.isArray(toolCalls) && toolCalls.length) {
      this.validateToolCalls(toolCalls);
      return;
    }
    const error = new Error({
      length: "模型输出达到 max_tokens，结果不完整。",
      content_filter: "模型输出被内容过滤器中止。",
      insufficient_system_resource: "模型服务资源不足，生成被中止。",
      tool_calls: "模型声明调用工具，但没有返回有效 tool_calls。"
    }[reason] || `模型以未知 finish_reason=${reason} 结束。`);
    error.code = {
      length: "MODEL_OUTPUT_TRUNCATED",
      content_filter: "MODEL_CONTENT_FILTERED",
      insufficient_system_resource: "MODEL_RESOURCE_EXHAUSTED",
      tool_calls: "MODEL_TOOL_CALLS_MISSING"
    }[reason] || "MODEL_FINISH_REASON_INVALID";
    error.finishReason = reason;
    throw error;
  }

  publishDetailedResponse(result, options = {}) {
    if (Array.isArray(result.toolCalls) && result.toolCalls.length && typeof options.onToolCalls === "function") {
      try { options.onToolCalls(result.toolCalls); } catch {}
    }
    if (typeof options.onAssistantMessage === "function") {
      try { options.onAssistantMessage(result.assistantMessage); } catch {}
    }
    if (typeof options.onFinishReason === "function") {
      try { options.onFinishReason(result.finishReason || ""); } catch {}
    }
    if (typeof options.onUsage === "function" && result.usage) {
      try { options.onUsage(result.usage); } catch {}
    }
    return result;
  }

  resolveTemperature(provider = {}, model = "", override = undefined) {
    void model;
    return override ?? provider.temperature ?? 0.65;
  }

  buildOpenAICompatibleBody(provider = {}, model = "", messages = [], temperatureOverride = undefined, options = {}) {
    const deepseekPolicy = options.deepseekPolicy || resolveDeepSeekV4Policy({
      provider,
      model,
      taskType: options.taskType,
      hasTools: Array.isArray(options.tools) && options.tools.length > 0,
      settings: options.settings,
      agentStage: options.agentStage,
      thinkingOverride: options.thinkingOverride,
      reasoningEffortOverride: options.reasoningEffortOverride
    });
    const body = {
      model,
      messages: normalizeDeepSeekV4Messages(messages, deepseekPolicy),
      max_tokens: options.maxTokens || provider.maxTokens || 4096
    };
    if (deepseekPolicy.applicable) {
      body.thinking = { type: deepseekPolicy.thinking };
      if (deepseekPolicy.enabled && deepseekPolicy.reasoningEffort) {
        body.reasoning_effort = deepseekPolicy.reasoningEffort;
      }
    }
    // DeepSeek V4 思考模式会忽略 temperature；不发送比发送一个无效参数更可审计。
    if (!deepseekPolicy.enabled) {
      body.temperature = this.resolveTemperature(provider, model, temperatureOverride);
    }
    if (options.responseFormat) {
      body.response_format = options.responseFormat;
    } else if (options.jsonMode) {
      body.response_format = { type: "json_object" };
    }
    if (Array.isArray(options.tools) && options.tools.length) {
      if (deepseekPolicy.applicable && options.tools.length > 128) {
        const error = new Error("DeepSeek 单次请求最多允许 128 个 tools。");
        error.code = "MODEL_TOOL_LIMIT_EXCEEDED";
        throw error;
      }
      body.tools = options.tools;
      // DeepSeek V4 生产接口在 thinking=enabled 时对显式 tool_choice 返回 400；
      // 留空即使用服务端 auto。关闭思考时仍支持 required / named choice。
      if (options.toolChoice && !(deepseekPolicy.applicable && deepseekPolicy.enabled)) {
        body.tool_choice = options.toolChoice;
      }
    }
    if (options.stream) {
      body.stream = true;
      body.stream_options = { include_usage: true };
    }
    return body;
  }

  // 合并外部 signal 与超时 signal —— 任意一方触发即中止。
  buildAbortSignal(timeoutMs, externalSignal = null) {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    if (!externalSignal) return timeoutSignal;
    if (typeof AbortSignal.any === "function") return AbortSignal.any([timeoutSignal, externalSignal]);
    // 兼容老环境的兜底实现。
    const controller = new AbortController();
    const onAbort = (reason) => controller.abort(reason);
    timeoutSignal.addEventListener("abort", () => onAbort(timeoutSignal.reason), { once: true });
    externalSignal.addEventListener("abort", () => onAbort(externalSignal.reason), { once: true });
    if (externalSignal.aborted) controller.abort(externalSignal.reason);
    return controller.signal;
  }

  // T1：reasoning vs 默认 timeout profile 解析。多源判断：
  //   1. options.reasoningOverride (boolean) - 调用方显式声明
  //   2. modelId regex 命中 - 自动识别 reasoner/thinking/o1/o3/o4
  //   3. taskType ∈ {draft, revise} - 长输出任务即便非 reasoning model 也用 reasoning profile
  //   4. settings.timeouts 可覆盖各项默认值
  // 不纯依赖 model 名硬猜，避免误判（如未来出现 "kimi-k2-reasoning-test" 这类 non-reasoning 名）。
  isReasoningTask({ modelId = "", taskType = "", reasoningOverride = null } = {}) {
    if (typeof reasoningOverride === "boolean") return reasoningOverride;
    if (REASONING_MODEL_PATTERN.test(`${modelId || ""}`)) return true;
    if (LONG_OUTPUT_TASK_TYPES.has(`${taskType || ""}`)) return true;
    return false;
  }

  resolveTimeoutProfile({ modelId = "", taskType = "", reasoningOverride = null, settings = null, options = {} } = {}) {
    const reasoning = this.isReasoningTask({ modelId, taskType, reasoningOverride });
    const kind = reasoning ? "reasoning" : "default";
    const defaults = TIMEOUT_PROFILE_DEFAULTS[kind];
    const settingsTimeouts = settings?.timeouts || {};
    const pick = (explicit, settingsKey, fallback) => {
      if (Number.isFinite(explicit) && explicit > 0) return explicit;
      const fromSettings = Number(settingsTimeouts[settingsKey]);
      if (Number.isFinite(fromSettings) && fromSettings > 0) return fromSettings;
      return fallback;
    };
    return {
      ttftMs: pick(options.ttftMs, reasoning ? "ttftReasoningMs" : "ttftDefaultMs", defaults.ttftMs),
      idleMs: pick(options.idleTimeoutMs, reasoning ? "idleReasoningMs" : "idleDefaultMs", defaults.idleMs),
      wallMs: pick(options.timeoutMs, reasoning ? "wallReasoningMs" : "wallDefaultMs", defaults.wallMs),
      kind
    };
  }

  resolveReasoningOverride(options = {}) {
    if (typeof options.reasoningOverride === "boolean") return options.reasoningOverride;
    if (options.deepseekPolicy && typeof options.deepseekPolicy.enabled === "boolean") {
      return options.deepseekPolicy.enabled;
    }
    return null;
  }

  // 流式专用：TTFT + wall clock + idle 三层超时。
  //   ttftMs：从请求发出到第一个 stream chunk（任何 SSE event，包含 reasoning_content / thinking
  //     event），到达后清除 ttftTimer。避免 reasoning 模型 thinking 期间被误判超时。
  //   idleMs：first chunk 之后，连续 idleMs 没有任何 chunk 才 abort（refreshIdle 重置）。
  //   wallClockMs：整次请求最长时间，防止流式卡住不知不觉。
  // 不传 opts.ttftMs 时退化为双层（与升级前行为兼容）。
  buildStreamAbortSignals(wallClockMs, idleMs, externalSignal = null, opts = {}) {
    const controller = new AbortController();
    const reasons = { wall: null, idle: null, ttft: null, external: null };
    const abortWith = (kind, reason) => {
      if (controller.signal.aborted) return;
      reasons[kind] = reason;
      controller.abort(reason);
    };
    const wallTimer = setTimeout(() => {
      abortWith("wall", new Error(`stream wall-clock timeout ${wallClockMs}ms`));
    }, wallClockMs);
    const ttftMs = Number.isFinite(opts.ttftMs) && opts.ttftMs > 0 ? opts.ttftMs : null;
    let ttftTimer = ttftMs
      ? setTimeout(() => {
        abortWith("ttft", new Error(`stream TTFT timeout ${ttftMs}ms (no first chunk received)`));
      }, ttftMs)
      : null;
    let idleTimer = ttftMs
      ? null // 有 TTFT 层时，first chunk 到达后才启动 idle timer
      : setTimeout(() => {
        abortWith("idle", new Error(`stream idle timeout ${idleMs}ms (no token received)`));
      }, idleMs);
    const refreshIdle = () => {
      if (controller.signal.aborted) return;
      if (ttftTimer) {
        clearTimeout(ttftTimer);
        ttftTimer = null;
      }
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        abortWith("idle", new Error(`stream idle timeout ${idleMs}ms (token gap exceeded)`));
      }, idleMs);
    };
    const cleanup = () => {
      clearTimeout(wallTimer);
      if (ttftTimer) clearTimeout(ttftTimer);
      if (idleTimer) clearTimeout(idleTimer);
    };
    if (externalSignal) {
      const onExternalAbort = () => abortWith("external", externalSignal.reason);
      if (externalSignal.aborted) onExternalAbort();
      else externalSignal.addEventListener("abort", onExternalAbort, { once: true });
    }
    return { signal: controller.signal, refreshIdle, cleanup, reasons };
  }

  normalizeUsage(rawUsage = null) {
    if (!rawUsage || typeof rawUsage !== "object") return null;
    const completionTokens = Number(rawUsage.completion_tokens || rawUsage.output_tokens) || 0;
    const promptTokens = Number(rawUsage.prompt_tokens) || 0;
    let cacheHit = Number(rawUsage.prompt_cache_hit_tokens);
    if (!Number.isFinite(cacheHit)) cacheHit = 0;
    let cacheMiss = Number(rawUsage.prompt_cache_miss_tokens);
    if (!Number.isFinite(cacheMiss)) cacheMiss = Math.max(0, promptTokens - cacheHit);
    const denom = cacheHit + cacheMiss;
    const reasoningTokens = Number(rawUsage.completion_tokens_details?.reasoning_tokens) || 0;
    return {
      promptTokens,
      completionTokens,
      reasoningTokens,
      visibleCompletionTokens: Math.max(0, completionTokens - reasoningTokens),
      cacheHitTokens: cacheHit,
      cacheMissTokens: cacheMiss,
      cacheHitRate: denom > 0 ? Number((cacheHit / denom).toFixed(4)) : 0,
      raw: rawUsage
    };
  }

  async complete(provider = {}, model = "", messages = [], options = {}) {
    const result = await this.completeDetailed(provider, model, messages, options);
    return result.content;
  }

  async completeDetailed(provider = {}, model = "", messages = [], options = {}) {
    return this.completeOpenAICompatibleDetailed(provider, model, messages, options);
  }

  isTemperatureRejected(text = "") {
    return /invalid temperature|only 1 is allowed/i.test(text);
  }

  isResponseFormatRejected(text = "") {
    return /response_format|json_schema|json mode|response schema|unknown parameter[^\n]*(?:response_format|json)/i.test(text);
  }

  async requestOpenAICompatibleWithFallbacks(request, options = {}) {
    const send = async (temperatureOverride = undefined, requestOptions = options) => {
      const response = await request(temperatureOverride, requestOptions);
      return { response, text: await response.text() };
    };
    let result = await send(options.temperature);
    if (!result.response.ok && this.isTemperatureRejected(result.text)) {
      result = await send(1);
    }
    if (
      !result.response.ok
      && (options.jsonMode || options.responseFormat)
      && this.isResponseFormatRejected(result.text)
    ) {
      const withoutResponseFormat = { ...options, jsonMode: false, responseFormat: null };
      result = await send(undefined, withoutResponseFormat);
      if (!result.response.ok && this.isTemperatureRejected(result.text)) {
        result = await send(1, withoutResponseFormat);
      }
    }
    return result;
  }

  async completeOpenAICompatible(provider = {}, model = "", messages = [], options = {}) {
    const result = await this.completeOpenAICompatibleDetailed(provider, model, messages, options);
    return result.content;
  }

  async completeOpenAICompatibleDetailed(provider = {}, model = "", messages = [], options = {}) {
    if (typeof options.onToken === "function") {
      try {
        return await this.completeOpenAICompatibleStreamDetailed(provider, model, messages, options);
      } catch (error) {
        if (this.isStreamingUnsupportedError(error)) {
          return this.completeOpenAICompatibleDetailed(provider, model, messages, { ...options, onToken: null });
        }
        throw error;
      }
    }
    const apiKey = getApiKey(provider);
    if (!apiKey) throw new Error(`缺少 API Key。请设置环境变量 ${provider.apiKeyEnv || "对应的 apiKeyEnv"}。`);
    const baseUrl = `${provider.baseUrl || ""}`.replace(/\/+$/, "");
    const url = provider.chatCompletionsUrl || `${baseUrl}/chat/completions`;
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      ...(provider.defaultHeaders || {})
    };
    const profile = this.resolveTimeoutProfile({
      modelId: model,
      taskType: options.taskType,
      reasoningOverride: this.resolveReasoningOverride(options),
      settings: options.settings,
      options
    });
    const request = (temperatureOverride = undefined, requestOptions = options) => fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(this.buildOpenAICompatibleBody(provider, model, messages, temperatureOverride, requestOptions)),
      signal: this.buildAbortSignal(profile.wallMs, options.signal)
    });

    const { response, text } = await this.requestOpenAICompatibleWithFallbacks(request, options);
    if (!response.ok) throw new Error(`模型请求失败 ${response.status}：${truncate(text, 800)}`);
    const data = JSON.parse(text);
    const choice = data.choices?.[0] || {};
    const message = choice.message || {};
    const content = message.content || data.output_text || "";
    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    const reasoningContent = `${message.reasoning_content || ""}`;
    const finishReason = `${choice.finish_reason || ""}`;
    this.validateFinishReason(finishReason, toolCalls, options);
    if (toolCalls.length && finishReason !== "length") this.validateToolCalls(toolCalls);
    if (!content && !reasoningContent && !toolCalls.length) throw new Error("模型没有返回可用内容。");
    const assistantMessage = {
      role: "assistant",
      content: toolCalls.length ? (content || "") : (content || null),
      ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
      ...(toolCalls.length ? { tool_calls: toolCalls } : {})
    };
    return this.publishDetailedResponse({
      content,
      reasoningContent,
      toolCalls,
      finishReason,
      usage: this.normalizeUsage(data.usage),
      assistantMessage
    }, options);
  }

  async completeOpenAICompatibleStream(provider = {}, model = "", messages = [], options = {}) {
    const result = await this.completeOpenAICompatibleStreamDetailed(provider, model, messages, options);
    return result.content;
  }

  isStreamingUnsupportedError(error) {
    const message = `${error?.message || error || ""}`.toLowerCase();
    if (message.includes("当前运行环境不支持流式读取")) return true;
    return /(?:streaming|stream)\s+(?:is\s+)?(?:not\s+supported|unsupported|unavailable)/i.test(message)
      || /(?:unsupported|unknown|unrecognized|invalid)\s+(?:request\s+)?(?:parameter|argument)[^\n:]{0,40}[: ]\s*["']?stream\b/i.test(message)
      || /["']stream["']\s+(?:is\s+)?(?:not\s+supported|unknown|invalid)/i.test(message);
  }

  async completeOpenAICompatibleStreamDetailed(provider = {}, model = "", messages = [], options = {}) {
    const apiKey = getApiKey(provider);
    if (!apiKey) throw new Error(`缺少 API Key。请设置环境变量 ${provider.apiKeyEnv || "对应的 apiKeyEnv"}。`);
    const baseUrl = `${provider.baseUrl || ""}`.replace(/\/+$/, "");
    const url = provider.chatCompletionsUrl || `${baseUrl}/chat/completions`;
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      ...(provider.defaultHeaders || {})
    };
    const profile = this.resolveTimeoutProfile({
      modelId: model,
      taskType: options.taskType,
      reasoningOverride: this.resolveReasoningOverride(options),
      settings: options.settings,
      options
    });
    const streamSignals = this.buildStreamAbortSignals(
      profile.wallMs,
      profile.idleMs,
      options.signal || null,
      { ttftMs: profile.ttftMs }
    );
    const request = (temperatureOverride = undefined) => fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(this.buildOpenAICompatibleBody(provider, model, messages, temperatureOverride, { ...options, stream: true })),
      signal: streamSignals.signal
    });
    try {
      let response = await request(options.temperature);
      if (!response.ok) {
        const text = await response.text();
        if (/invalid temperature|only 1 is allowed/i.test(text)) {
          response = await request(1);
        } else {
          throw new Error(`模型请求失败 ${response.status}：${truncate(text, 800)}`);
        }
      }
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`模型请求失败 ${response.status}：${truncate(text, 800)}`);
      }
      const reader = response.body?.getReader?.();
      if (!reader) throw new Error("当前运行环境不支持流式读取。");
      const decoder = new TextDecoder();
      let buffer = "";
      let content = "";
      let reasoningContent = "";
      let finishReason = "";
      let lastUsage = null;
      const toolCallAcc = new Map();
      const emit = (delta = "") => {
        if (!delta) return;
        content += delta;
        options.onToken(delta);
      };
      const accumulateToolCalls = (deltas = []) => {
        for (const delta of deltas) {
          const index = Number.isFinite(delta.index) ? delta.index : 0;
          const prev = toolCallAcc.get(index) || { id: "", type: "function", function: { name: "", arguments: "" } };
          if (delta.id) prev.id = delta.id;
          if (delta.type) prev.type = delta.type;
          const fn = delta.function || {};
          if (fn.name) prev.function.name = (prev.function.name || "") + fn.name;
          if (fn.arguments) prev.function.arguments = (prev.function.arguments || "") + fn.arguments;
          toolCallAcc.set(index, prev);
        }
      };
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        // 每次成功收到 chunk 都刷新 idle timer；只要数据持续到达就不会被打断。
        streamSignals.refreshIdle();
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split(/\n\n/);
        buffer = events.pop() || "";
        for (const event of events) {
          const lines = event.split(/\n/).map((line) => line.trim()).filter(Boolean);
          for (const line of lines) {
            if (!line.startsWith("data:")) continue;
            const payload = line.replace(/^data:\s*/, "");
            if (!payload || payload === "[DONE]") continue;
            try {
              const data = JSON.parse(payload);
              const choice = data.choices?.[0] || {};
              if (choice.finish_reason) finishReason = choice.finish_reason;
              const reasoningDelta = choice.delta?.reasoning_content
                || choice.message?.reasoning_content
                || "";
              if (reasoningDelta) reasoningContent += reasoningDelta;
              const deltaContent = choice.delta?.content
                || choice.message?.content
                || choice.text
                || data.output_text
                || "";
              emit(deltaContent);
              const toolDelta = choice.delta?.tool_calls || choice.message?.tool_calls;
              if (Array.isArray(toolDelta) && toolDelta.length) accumulateToolCalls(toolDelta);
              if (data.usage) lastUsage = data.usage;
            } catch {}
          }
        }
      }
      const toolCalls = Array.from(toolCallAcc.values());
      this.validateFinishReason(finishReason, toolCalls, options);
      if (toolCalls.length && finishReason !== "length") this.validateToolCalls(toolCalls);
      if (!content.trim() && !reasoningContent && !toolCalls.length) throw new Error("模型没有返回可用内容。");
      const assistantMessage = {
        role: "assistant",
        content: toolCalls.length ? (content || "") : (content || null),
        ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
        ...(toolCalls.length ? { tool_calls: toolCalls } : {})
      };
      return this.publishDetailedResponse({
        content,
        reasoningContent,
        toolCalls,
        finishReason,
        usage: this.normalizeUsage(lastUsage),
        assistantMessage
      }, options);
    } finally {
      streamSignals.cleanup();
    }
  }

}

module.exports = {
  ModelGateway,
  getApiKey
};
