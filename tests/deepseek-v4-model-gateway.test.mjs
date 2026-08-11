import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { ModelGateway } = require("../src/platform/ai/modelGateway.js");

const provider = {
  id: "deepseek",
  name: "DeepSeek V4",
  type: "openai-compatible",
  baseUrl: "https://api.deepseek.com",
  apiKey: "sk-test",
  temperature: 0.65
};

const settings = {
  deepseek: {
    thinking: "max"
  }
};

async function withMockFetch(mock, action) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock;
  try {
    return await action();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("DeepSeek V4 thinking 请求下发 thinking/effort 并省略 temperature", () => {
  const gateway = new ModelGateway();
  const thinkingBody = gateway.buildOpenAICompatibleBody(
    provider,
    "deepseek-v4-pro",
    [{ role: "user", content: "plan" }],
    undefined,
    { taskType: "workflow", settings, maxTokens: 16384 }
  );
  assert.deepEqual(thinkingBody.thinking, { type: "enabled" });
  assert.equal(thinkingBody.reasoning_effort, "max");
  assert.equal(Object.hasOwn(thinkingBody, "temperature"), false);

  const directBody = gateway.buildOpenAICompatibleBody(
    provider,
    "deepseek-v4-flash",
    [{ role: "user", content: "title" }],
    undefined,
    { taskType: "title", settings: { deepseek: { thinking: "disabled" } }, maxTokens: 600 }
  );
  assert.deepEqual(directBody.thinking, { type: "disabled" });
  assert.equal(Object.hasOwn(directBody, "reasoning_effort"), false);
  assert.equal(directBody.temperature, 0.65);
});

test("DeepSeek V4 body fallback 的工具轮沿用全局思考能力", () => {
  const gateway = new ModelGateway();
  const body = gateway.buildOpenAICompatibleBody(
    provider,
    "deepseek-v4-pro",
    [{ role: "user", content: "use tools" }],
    undefined,
    {
      taskType: "agent",
      agentStage: "tool",
      settings: {
        deepseek: { thinking: "max" }
      },
      tools: [{ type: "function", function: { name: "x", description: "x", parameters: {} } }]
    }
  );
  assert.deepEqual(body.thinking, { type: "enabled" });
  assert.equal(body.reasoning_effort, "max");
});

test("DeepSeek V4 thinking 工具请求省略不兼容的 tool_choice，并完整回放 assistant", () => {
  const gateway = new ModelGateway();
  const toolCalls = [{
    id: "call-1",
    type: "function",
    function: { name: "search_memory", arguments: "{}" }
  }];
  const messages = [
    { role: "user", content: "查一下" },
    {
      role: "assistant",
      content: "我先检索记忆。",
      reasoning_content: "先查记忆。",
      tool_calls: toolCalls
    },
    { role: "tool", tool_call_id: "call-1", content: "结果" }
  ];
  const tools = [{
    type: "function",
    function: { name: "search_memory", description: "search", parameters: { type: "object", properties: {} } }
  }];

  const body = gateway.buildOpenAICompatibleBody(
    provider,
    "deepseek-v4-pro",
    messages,
    undefined,
    { taskType: "agent", settings, tools, toolChoice: "required" }
  );

  assert.equal(Object.hasOwn(body, "tool_choice"), false);
  assert.deepEqual(body.tools, tools);
  assert.equal(body.messages[1].content, "我先检索记忆。");
  assert.equal(body.messages[1].reasoning_content, "先查记忆。");
  assert.deepEqual(body.messages[1].tool_calls, toolCalls);
  assert.equal(messages[1].content, "我先检索记忆。", "构造请求不能原地污染调用方 messages");

  const nullContentBody = gateway.buildOpenAICompatibleBody(
    provider,
    "deepseek-v4-pro",
    [{ role: "assistant", content: null, reasoning_content: "继续。", tool_calls: toolCalls }],
    undefined,
    { taskType: "agent", settings, tools }
  );
  assert.equal(nullContentBody.messages[0].content, "", "DeepSeek 工具回放把 null 正规化为空字符串");

  const directBody = gateway.buildOpenAICompatibleBody(
    provider,
    "deepseek-v4-flash",
    [{ role: "user", content: "查一下" }],
    undefined,
    {
      taskType: "agent",
      settings: { deepseek: { thinking: "disabled" } },
      tools,
      toolChoice: "required"
    }
  );
  assert.equal(directBody.tool_choice, "required", "非思考模式仍允许显式 tool_choice");
});

test("DeepSeek V4 tool-call 响应完整保留可直接回放的 assistantMessage", async () => {
  const gateway = new ModelGateway();
  const toolCalls = [{
    id: "call-2",
    type: "function",
    function: { name: "search_memory", arguments: "{}" }
  }];
  const result = await withMockFetch(async () => new Response(JSON.stringify({
    choices: [{
      message: {
        content: "正在检索。",
        reasoning_content: "需要先检索。",
        tool_calls: toolCalls
      },
      finish_reason: "tool_calls"
    }]
  }), { status: 200 }), () => gateway.completeOpenAICompatibleDetailed(
    provider,
    "deepseek-v4-pro",
    [{ role: "user", content: "查一下" }],
    { taskType: "agent", settings, tools: [] }
  ));

  assert.equal(result.assistantMessage.content, "正在检索。");
  assert.equal(result.assistantMessage.reasoning_content, "需要先检索。");
  assert.deepEqual(result.assistantMessage.tool_calls, toolCalls);
});

test("DeepSeek V4 在发出请求前拒绝超过官方上限的 tools", () => {
  const gateway = new ModelGateway();
  const tools = Array.from({ length: 129 }, (_, index) => ({
    type: "function",
    function: { name: `tool_${index}`, description: "x", parameters: { type: "object", properties: {} } }
  }));
  assert.throws(
    () => gateway.buildOpenAICompatibleBody(
      provider,
      "deepseek-v4-pro",
      [{ role: "user", content: "run" }],
      undefined,
      { taskType: "agent", settings, tools }
    ),
    (error) => error.code === "MODEL_TOOL_LIMIT_EXCEEDED"
  );
});

test("response-format fallback 只移除格式字段，保留 tools/maxTokens/thinking policy", async () => {
  const gateway = new ModelGateway();
  const bodies = [];
  const tools = [{
    type: "function",
    function: {
      name: "search_memory",
      description: "search",
      parameters: { type: "object", properties: {} }
    }
  }];

  const result = await withMockFetch(async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    if (bodies.length === 1) {
      return new Response("unsupported response_format", { status: 400 });
    }
    return new Response(JSON.stringify({
      choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 2 }
    }), { status: 200 });
  }, () => gateway.completeOpenAICompatibleDetailed(
    provider,
    "deepseek-v4-pro",
    [{ role: "user", content: "review" }],
    {
      jsonMode: true,
      taskType: "review",
      settings,
      maxTokens: 16384,
      tools
    }
  ));

  assert.equal(result.content, "ok");
  assert.equal(bodies.length, 2);
  assert.deepEqual(bodies[0].response_format, { type: "json_object" });
  assert.equal(Object.hasOwn(bodies[1], "response_format"), false);
  assert.equal(bodies[1].max_tokens, 16384);
  assert.deepEqual(bodies[1].tools, tools);
  assert.deepEqual(bodies[1].thinking, { type: "enabled" });
  assert.equal(bodies[1].reasoning_effort, "max");
  assert.equal(Object.hasOwn(bodies[1], "temperature"), false);
});

test("finish_reason=length 且只有 reasoning_content 时仍抛出 typed truncation error", async () => {
  const gateway = new ModelGateway();
  await withMockFetch(async () => new Response(JSON.stringify({
    choices: [{
      message: { content: "", reasoning_content: "internal reasoning" },
      finish_reason: "length"
    }],
    usage: {
      prompt_tokens: 20,
      completion_tokens: 16,
      completion_tokens_details: { reasoning_tokens: 16 }
    }
  }), { status: 200 }), async () => {
    await assert.rejects(
      gateway.completeOpenAICompatibleDetailed(
        provider,
        "deepseek-v4-pro",
        [{ role: "user", content: "draft" }],
        { taskType: "draft", settings, maxTokens: 16 }
      ),
      (error) => {
        assert.equal(error.code, "MODEL_OUTPUT_TRUNCATED");
        assert.equal(error.finishReason, "length");
        return true;
      }
    );
  });
});

test("Agent 可选择保留 length 响应中的 reasoning 与 finish reason 交给 Pi 续接", async () => {
  const gateway = new ModelGateway();
  const result = await withMockFetch(async () => new Response(JSON.stringify({
    choices: [{
      message: { content: "", reasoning_content: "internal reasoning" },
      finish_reason: "length"
    }],
    usage: {
      prompt_tokens: 20,
      completion_tokens: 16,
      completion_tokens_details: { reasoning_tokens: 16 }
    }
  }), { status: 200 }), () => gateway.completeOpenAICompatibleDetailed(
    provider,
    "deepseek-v4-pro",
    [{ role: "user", content: "agent" }],
    {
      taskType: "agent",
      settings,
      maxTokens: 16,
      allowTruncatedResponse: true
    }
  ));

  assert.equal(result.content, "");
  assert.equal(result.reasoningContent, "internal reasoning");
  assert.equal(result.finishReason, "length");
});

test("DeepSeek usage 将 reasoning token 作为 completion 子集归一化", () => {
  const usage = new ModelGateway().normalizeUsage({
    prompt_tokens: 100,
    completion_tokens: 40,
    prompt_cache_hit_tokens: 60,
    prompt_cache_miss_tokens: 40,
    completion_tokens_details: { reasoning_tokens: 12 }
  });
  assert.equal(usage.completionTokens, 40);
  assert.equal(usage.reasoningTokens, 12);
  assert.equal(usage.visibleCompletionTokens, 28);
  assert.equal(usage.cacheHitRate, 0.6);
});
