import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const { AiRouter } = require("../src/platform/ai/aiRouter.js");

function settings(overrides = {}) {
  return {
    get: async () => ({
      deepseek: {
        enabled: true,
        apiKey: "test",
        baseUrl: "https://api.deepseek.com",
        model: "deepseek-v4-pro",
        maxTokens: 1000,
        thinking: "disabled"
      },
      context: {
        tokenBudgets: { defaultModelTokens: 64000, outputReserveTokens: 1000 }
      },
      ...overrides
    })
  };
}

test("AiRouter.resolve 对所有任务只返回唯一 DeepSeek 模型", async () => {
  const router = new AiRouter(settings());

  const resolved = await router.resolve("draft");
  assert.equal(resolved.provider.id, "deepseek");
  assert.equal(resolved.model, "deepseek-v4-pro");

  const normal = await router.resolve("agent");
  assert.equal(normal.model, "deepseek-v4-pro");
  assert.equal(normal.provider.id, resolved.provider.id);
});

test("AiRouter.runTaskDetailed 只组装显式上下文，并保留详细响应", async () => {
  const calls = [];
  const router = new AiRouter(
    settings(),
    { registriesDir: path.join(process.cwd(), "workspace", "registries") }
  );
  router.completeDetailed = async (_provider, _model, messages, options) => {
    calls.push({ messages, options });
    return {
      content: "完成正文",
      reasoningContent: "",
      toolCalls: [],
      finishReason: "stop",
      usage: {
        promptTokens: 10,
        completionTokens: 2,
        cacheHitTokens: 1,
        cacheMissTokens: 9,
        cacheHitRate: 0.1
      },
      assistantMessage: { role: "assistant", content: "完成正文" }
    };
  };
  const logged = [];
  router.logCall = async (entry) => {
    logged.push(entry);
  };

  const out = await router.runTaskDetailed({
    taskType: "draft",
    title: "初稿",
    instruction: "写一段",
    input: "主题",
    runContext: "上下文"
  });

  assert.equal(out.content, "完成正文");
  assert.equal(out.finishReason, "stop");
  assert.equal(logged[0].status, "completed");
  assert.equal(logged[0].actualPromptTokens, 10);
  assert.doesNotMatch(calls[0].messages[1].content, /【本地记忆】/);
});

test("模型拒绝上下文长度时明确失败，不降级 profile 后静默截断重试", async () => {
  const router = new AiRouter(settings());
  let retries = 0;
  router.runTaskDetailed = async () => { retries += 1; };
  const error = Object.assign(new Error("context length exceeded"), {
    code: "MODEL_CONTEXT_EXCEEDED"
  });

  await assert.rejects(
    router.retryTaskAfterError({
      error,
      retry: { totalAttempts: 0, transientAttempts: 0 },
      streamedAnyToken: false,
      propagated: { contextProfile: "heavy" },
      request: {
        profile: "heavy",
        tokenBudget: { runContextTokens: 96000, inputTokens: 64000 }
      }
    }),
    (caught) => caught === error
  );
  assert.equal(retries, 0);
});

test("内部旁路调用可把模型输出预算收紧到 512 tokens", async () => {
  const router = new AiRouter(
    settings(),
    { registriesDir: path.join(process.cwd(), "workspace", "registries") }
  );
  let receivedOptions = null;
  router.completeDetailed = async (_provider, _model, _messages, options) => {
    receivedOptions = options;
    return {
      content: '{"files":[]}',
      reasoningContent: "",
      toolCalls: [],
      finishReason: "stop",
      usage: null,
      assistantMessage: { role: "assistant", content: '{"files":[]}' }
    };
  };
  router.logCall = async () => {};
  const result = await router.runTaskDetailed({
    taskType: "memory",
    instruction: "只输出 JSON",
    input: "{}",
    internalCall: true,
    jsonMode: true,
    maxOutputTokens: 512
  });
  assert.equal(receivedOptions.maxTokens, 512);
  assert.equal(result.maxTokens, 512);
});

test("AiRouter 只保留运行所需的 ModelGateway 完成入口", async () => {
  const router = new AiRouter(settings());
  const calls = [];
  router.modelGateway = {
    complete: async (...args) => {
      calls.push(["complete", args]);
      return "ok";
    },
    completeDetailed: async (...args) => {
      calls.push(["completeDetailed", args]);
      return { content: "ok-detailed" };
    }
  };

  assert.equal(await router.complete({ id: "p" }, "m", []), "ok");
  assert.deepEqual(await router.completeDetailed({ id: "p" }, "m", []), { content: "ok-detailed" });
  assert.deepEqual(calls.map(([name]) => name), [
    "complete",
    "completeDetailed"
  ]);
});

test("AiRouter 把本轮上下文放进当前输入，并保留原生会话顺序", () => {
  const router = new AiRouter(settings(), null);
  const context = router.buildTaskContextMessage({
    runContext: "稳定上下文",
    pinnedSections: ["稳定项目契约"],
    budget: { runContextTokens: 1000, inputTokens: 1000 }
  });
  const current = router.buildTaskUserMessage({
    taskType: "draft", title: "变化标题", instruction: "变化要求",
    input: "变化输入", context, budget: { inputTokens: 1000 }
  });
  const messages = router.buildTaskMessages({
    system: "系统",
    conversation: [
      { role: "user", content: "历史输入" },
      { role: "assistant", content: "历史回答" }
    ],
    user: current
  });
  assert.deepEqual(messages.map((message) => message.role), ["system", "user", "assistant", "user"]);
  assert.equal(messages[1].content, "历史输入");
  assert.match(messages.at(-1).content, /稳定项目契约[\s\S]*稳定上下文[\s\S]*变化标题[\s\S]*变化输入/);
});

test("Compact 类内部请求把操作指令追加到输入末尾", () => {
  const router = new AiRouter(settings(), null);
  const message = router.buildTaskUserMessage({
    taskType: "memory",
    title: "维护会话摘要",
    instruction: "压缩以上历史",
    input: "A\nB\nC",
    budget: { inputTokens: 1000 },
    instructionPlacement: "after-input"
  });
  assert.ok(message.indexOf("A\nB\nC") < message.indexOf("压缩以上历史"));
  assert.match(message, /【末尾操作指令】/);
});

test("连续两轮请求完整复用上一轮 messages 作为严格前缀", async () => {
  const router = new AiRouter(
    settings(),
    { registriesDir: path.join(process.cwd(), "workspace", "registries") }
  );
  const common = {
    taskType: "agent",
    title: "腰果 Agent",
    instruction: "",
    contextProfile: "heavy",
    contextBudget: { runContextTokens: 4000, inputTokens: 4000 },
    provider: { id: "deepseek" },
    model: "deepseek-v4-pro",
    callMaxTokens: 1000,
    settings: await settings().get()
  };
  const first = await router.prepareTaskRequest({
    ...common,
    input: "第一问",
    runContext: "第一轮上下文"
  });
  const firstUser = first.messages.at(-1).content;
  const second = await router.prepareTaskRequest({
    ...common,
    input: "第二问",
    runContext: "第二轮上下文",
    conversationMessages: [
      { role: "user", content: firstUser, modelReady: true },
      { role: "assistant", content: "第一答" }
    ]
  });
  assert.deepEqual(second.messages.slice(0, first.messages.length), first.messages);
  assert.equal(second.messages.at(-2).content, "第一答");
  assert.match(second.messages.at(-1).content, /第二轮上下文[\s\S]*第二问/);
});

test("上下文接近硬上限时只从最旧历史开始裁剪，不改写保留消息", () => {
  const router = new AiRouter(settings(), null);
  const old = { role: "user", content: "旧".repeat(3000) };
  const recent = { role: "assistant", content: "新".repeat(3000) };
  const fitted = router.fitTaskConversationMessages({
    messages: [old, recent],
    system: "系统".repeat(200),
    user: "当前".repeat(200),
    modelContextTokens: 12000,
    outputReserveTokens: 1000
  });
  assert.deepEqual(fitted, [recent]);
});

test("AiRouter.resolveCallTimeoutMs 不覆盖 ModelGateway 的任务级 timeout profile", () => {
  const router = new AiRouter(settings());
  // AiRouter 不传入固定值，由 ModelGateway 按任务和思考策略选择 timeout profile。
  assert.equal(router.resolveCallTimeoutMs({ jsonMode: true }), undefined);
  assert.equal(router.resolveCallTimeoutMs({ responseFormat: { type: "json_object" } }), undefined);
  assert.equal(router.resolveCallTimeoutMs({}), undefined);
  assert.equal(router.resolveCallTimeoutMs({ jsonMode: false, responseFormat: null }), undefined);
});

test("AiRouter.shouldDefaultToStream 黑名单语义：jsonMode/responseFormat 排除，其他默认流式", () => {
  const router = new AiRouter(settings());
  assert.equal(router.shouldDefaultToStream({}), true);
  assert.equal(router.shouldDefaultToStream({ jsonMode: true }), false);
  assert.equal(router.shouldDefaultToStream({ responseFormat: { type: "json_object" } }), false);
  assert.equal(router.shouldDefaultToStream({ jsonMode: false, responseFormat: null }), true);
});

test("AiRouter.resolveEffectiveOnToken 在 jsonMode 下返回 null（关闭流式），自由文本下返回 noop", () => {
  const router = new AiRouter(settings());
  // jsonMode 关闭
  assert.equal(router.resolveEffectiveOnToken({ jsonMode: true }), null);
  // 自由文本 + 无 onToken：返回 noop
  const noop = router.resolveEffectiveOnToken({});
  assert.equal(typeof noop, "function");
  assert.equal(noop("delta"), undefined);
  // 调用方显式传 onToken：使用调用方的
  const user = () => "x";
  assert.equal(router.resolveEffectiveOnToken({ onToken: user }), user);
});
