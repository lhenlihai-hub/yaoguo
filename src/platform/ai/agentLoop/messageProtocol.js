// @ts-check
const { DEEPSEEK_V4_MAX_OUTPUT_TOKENS } = require("../deepseekV4Policy");

function emptyUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  };
}

function normalizeUsage(usage = null) {
  const input = Number(usage?.promptTokens) || 0;
  const output = Number(usage?.completionTokens) || 0;
  const cacheRead = Number(usage?.cacheHitTokens) || 0;
  const cacheWrite = Number(usage?.cacheMissTokens) || 0;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    ...(Number.isFinite(usage?.reasoningTokens) ? { reasoning: Number(usage.reasoningTokens) } : {}),
    totalTokens: Number(usage?.totalTokens) || input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  };
}

function summarizeAgentUsage(messages = [], modelCalls = 0) {
  const summary = {
    modelCalls: Math.max(0, Number(modelCalls) || 0),
    promptTokens: 0,
    completionTokens: 0,
    reasoningTokens: 0,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    totalTokens: 0,
    cacheHitRate: 0
  };
  for (const message of Array.isArray(messages) ? messages : []) {
    if (message?.role !== "assistant" || !message.usage) continue;
    summary.promptTokens += Math.max(0, Number(message.usage.input) || 0);
    summary.completionTokens += Math.max(0, Number(message.usage.output) || 0);
    summary.reasoningTokens += Math.max(0, Number(message.usage.reasoning) || 0);
    summary.cacheHitTokens += Math.max(0, Number(message.usage.cacheRead) || 0);
    summary.cacheMissTokens += Math.max(0, Number(message.usage.cacheWrite) || 0);
  }
  summary.totalTokens = summary.promptTokens + summary.completionTokens;
  const cachePromptTokens = summary.cacheHitTokens + summary.cacheMissTokens;
  summary.cacheHitRate = cachePromptTokens > 0
    ? Number((summary.cacheHitTokens / cachePromptTokens).toFixed(4))
    : 0;
  return summary;
}

function createAgentModel(base = {}) {
  const contextWindow = Number(base.modelContextTokens) || 1024 * 1024;
  const maxTokens = Number(base.maxTokens) || DEEPSEEK_V4_MAX_OUTPUT_TOKENS;
  return {
    id: `${base.model || "deepseek-v4"}`,
    name: `${base.model || "DeepSeek V4"}`,
    api: "openai-completions",
    provider: `${base.provider?.id || "deepseek"}`,
    baseUrl: `${base.provider?.baseUrl || ""}`,
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens
  };
}

function parseToolArguments(raw = "") {
  try {
    const value = JSON.parse(`${raw || "{}"}`);
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : { __invalidArguments: `${raw || ""}` };
  } catch {
    return { __invalidArguments: `${raw || ""}` };
  }
}

function responseToAgentMessage(response = {}, model = createAgentModel()) {
  const content = [];
  const reasoning = `${response.reasoningContent || response.assistantMessage?.reasoning_content || ""}`;
  if (reasoning) {
    content.push({ type: "thinking", thinking: reasoning });
  }
  if (`${response.content || ""}`) {
    content.push({ type: "text", text: `${response.content}` });
  }
  for (const call of Array.isArray(response.toolCalls) ? response.toolCalls : []) {
    content.push({
      type: "toolCall",
      id: `${call?.id || ""}`,
      name: `${call?.function?.name || ""}`,
      arguments: parseToolArguments(call?.function?.arguments || "")
    });
  }
  return {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: normalizeUsage(response.usage),
    stopReason: resolveAgentStopReason(response),
    timestamp: Date.now()
  };
}

function resolveAgentStopReason(response = {}) {
  if (response.aborted) return "aborted";
  if (response.error) return "error";
  if (`${response.finishReason || ""}` === "length") return "length";
  if (Array.isArray(response.toolCalls) && response.toolCalls.length) return "toolUse";
  return "stop";
}

class CompletedAgentResponseStream {
  constructor(message) {
    this.message = message;
  }

  async *[Symbol.asyncIterator]() {
    yield { type: "start", partial: this.message };
    if (this.message.stopReason === "error" || this.message.stopReason === "aborted") {
      yield { type: "error", reason: this.message.stopReason, error: this.message };
      return;
    }
    yield { type: "done", reason: this.message.stopReason, message: this.message };
  }

  async result() {
    return this.message;
  }
}

function responseToAgentStream(response, model) {
  return new CompletedAgentResponseStream(responseToAgentMessage(response, model));
}

function errorToAgentStream(error, model, aborted = false) {
  return new CompletedAgentResponseStream({
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: emptyUsage(),
    stopReason: aborted ? "aborted" : "error",
    errorMessage: `${error?.message || error || "模型调用失败"}`,
    timestamp: Date.now()
  });
}

function agentMessagesToOpenAI(messages = []) {
  return messages.flatMap((message) => {
    if (message?.role === "user") return [{
      role: "user",
      content: contentToText(message.content)
    }];
    if (message?.role === "assistant") return [agentAssistantToOpenAI(message)];
    if (message?.role === "toolResult") return [{
      role: "tool",
      tool_call_id: `${message.toolCallId || ""}`,
      name: `${message.toolName || ""}`,
      content: contentToText(message.content)
    }];
    return [];
  });
}

function agentAssistantToOpenAI(message = {}) {
  const blocks = Array.isArray(message.content) ? message.content : [];
  const toolCalls = blocks.filter((item) => item?.type === "toolCall").map((call) => ({
    id: `${call.id || ""}`,
    type: "function",
    function: {
      name: `${call.name || ""}`,
      arguments: JSON.stringify(call.arguments || {})
    }
  }));
  const content = blocks.filter((item) => item?.type === "text").map((item) => item.text || "").join("");
  const reasoning = blocks.filter((item) => item?.type === "thinking").map((item) => item.thinking || "").join("");
  return {
    role: "assistant",
    content: toolCalls.length ? content : (content || null),
    ...(reasoning ? { reasoning_content: reasoning } : {}),
    ...(toolCalls.length ? { tool_calls: toolCalls } : {})
  };
}

function contentToText(content) {
  if (typeof content === "string") return content;
  return (Array.isArray(content) ? content : []).map((item) => (
    item?.type === "text"
      ? `${item.text || ""}`
      : (item?.type === "image" ? `[image:${item.mimeType || "unknown"}]` : "")
  )).filter(Boolean).join("\n");
}

function lastAssistantText(messages = []) {
  const assistant = [...messages].reverse().find((message) => message?.role === "assistant");
  return assistant ? contentToText(assistant.content) : "";
}

module.exports = {
  createAgentModel,
  responseToAgentStream,
  errorToAgentStream,
  agentMessagesToOpenAI,
  summarizeAgentUsage,
  lastAssistantText,
  contentToText
};
