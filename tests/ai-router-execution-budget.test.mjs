import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const { AiRouter } = require("../src/platform/ai/aiRouter.js");
const {
  AgentExecutionBudget,
  AgentToolRegistry,
  runToolLoop
} = require("../src/platform/ai/agentTools/index.js");
const { judgeContentQuality } = require("../src/platform/ai/judges/contentQualityJudge.js");
const registriesDir = path.join(process.cwd(), "workspace", "registries");

function provider(id, model) {
  return {
    id,
    name: id,
    type: "openai-compatible",
    enabled: true,
    apiKey: "test",
    baseUrl: `https://${id}.example.test`,
    defaultModel: model,
    models: [model],
    maxTokens: 1000
  };
}

function settingsService() {
  const first = provider("deepseek", "deepseek-v4-pro");
  const settings = {
    deepseek: {
      ...first,
      model: "deepseek-v4-pro",
      thinking: "disabled",
      agentToolMaxTokens: 1000
    },
    context: {
      tokenBudgets: { defaultModelTokens: 64000, outputReserveTokens: 1000 }
    }
  };
  return { settings, first, service: { get: async () => settings } };
}

function detailed(content = "ok") {
  return {
    content,
    reasoningContent: "",
    toolCalls: [],
    finishReason: "stop",
    usage: null,
    assistantMessage: { role: "assistant", content }
  };
}

test("AiRouter 首轮 setup 失败写入 telemetry", async () => {
  const router = new AiRouter({ get: async () => { throw new Error("settings unreadable"); } }, null);
  const calls = [];
  router.logCall = async (entry) => { calls.push(entry); };

  await assert.rejects(() => router.runTaskDetailed({ taskType: "agent", input: "x" }), /settings unreadable/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].status, "error");
  assert.equal(calls[0].phase, "setup");
  assert.match(calls[0].error, /settings unreadable/);
});

test("AiRouter continuation setup 失败写入 telemetry", async () => {
  const router = new AiRouter({ get: async () => ({}) }, null);
  const calls = [];
  router.logCall = async (entry) => { calls.push(entry); };

  await assert.rejects(() => router.continueTaskDetailed({ base: {}, messages: [] }), /缺少首轮模型上下文/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].phase, "setup");
  assert.equal(calls[0].status, "error");
});

test("AiRouter 遇到模型不可用时不跨供应商回退", async () => {
  const fixture = settingsService();
  const router = new AiRouter(
    fixture.service,
    { registriesDir }
  );
  router.logCall = async () => null;
  const controller = new AbortController();
  const budget = new AgentExecutionBudget({
    maxModelCalls: 2,
    maxToolCalls: 1,
    signal: controller.signal
  });
  assert.equal(budget.claim("model").ok, true);
  const attempts = [];
  router.completeDetailed = async (selectedProvider, _model, _messages, options) => {
    attempts.push({ providerId: selectedProvider.id, options });
    throw new Error("model not found");
  };

  await assert.rejects(router.runTaskDetailed({
    taskType: "default", instruction: "answer", input: "x", jsonMode: true,
    executionBudget: budget, providerAttemptPreclaimed: true
  }), /model not found/);
  assert.deepEqual(attempts.map((item) => item.providerId), ["deepseek"]);
  assert.equal(budget.modelCalls, 1);
  assert.ok(attempts.every((item) => item.options.signal === budget.signal));
});

test("AiRouter 瞬时重试在共享额度不足时不发送第二次请求", async () => {
  const fixture = settingsService();
  const router = new AiRouter(
    fixture.service,
    { registriesDir }
  );
  router.logCall = async () => null;
  const budget = new AgentExecutionBudget({ maxModelCalls: 1, maxToolCalls: 1 });
  assert.equal(budget.claim("model").ok, true);
  let attempts = 0;
  router.completeDetailed = async () => {
    attempts += 1;
    throw new Error("503 service unavailable");
  };

  await assert.rejects(
    router.runTaskDetailed({
      taskType: "default",
      instruction: "answer",
      input: "x",
      jsonMode: true,
      executionBudget: budget,
      providerAttemptPreclaimed: true
    }),
    (error) => error.code === "AGENT_MODEL_BUDGET_EXCEEDED"
  );
  assert.equal(attempts, 1);
  assert.equal(budget.modelCalls, 1);
});

test("continueTaskDetailed 的内部瞬时重试逐次扣共享模型额度", async () => {
  const fixture = settingsService();
  const router = new AiRouter(fixture.service, null);
  router.logCall = async () => null;
  const controller = new AbortController();
  const budget = new AgentExecutionBudget({
    maxModelCalls: 2,
    maxToolCalls: 1,
    signal: controller.signal
  });
  assert.equal(budget.claim("model").ok, true);
  const attempts = [];
  router.completeDetailed = async (_provider, _model, _messages, options) => {
    attempts.push(options);
    if (attempts.length === 1) throw new Error("503 service unavailable");
    return detailed("retry ok");
  };

  const result = await router.continueTaskDetailed({
    base: {
      provider: fixture.first,
      model: "deepseek-v4-pro",
      settings: fixture.settings,
      taskType: "agent",
      title: "Agent",
      maxTokens: 1000
    },
    messages: [{ role: "user", content: "x" }],
    executionBudget: budget,
    providerAttemptPreclaimed: true,
    agentStage: "tool"
  });

  assert.equal(result.content, "retry ok");
  assert.equal(attempts.length, 2);
  assert.equal(budget.modelCalls, 2);
  assert.ok(attempts.every((options) => options.signal === budget.signal));
});

test("toolLoop 把已预扣标记与同一预算实例传给 AiRouter", async () => {
  const registry = new AgentToolRegistry();
  registry.register({
    schema: {
      type: "function",
      function: { name: "echo", description: "echo", parameters: { type: "object", properties: {} } }
    },
    execute: async () => ({ ok: true }),
    policy: { namespace: "test", effect: "read", parallelSafe: true, repeat: "reuse", maxCallsPerLoop: 2 }
  });
  const invocations = [];
  const call = { id: "echo-1", type: "function", function: { name: "echo", arguments: "{}" } };
  const router = {
    async runTaskDetailed(args) {
      invocations.push(args);
      return {
        content: "",
        toolCalls: [call],
        requestMessages: [{ role: "user", content: "x" }],
        assistantMessage: { role: "assistant", content: "", tool_calls: [call] }
      };
    },
    async continueTaskDetailed(args) {
      invocations.push(args);
      return { content: "done", toolCalls: [], assistantMessage: { role: "assistant", content: "done" } };
    }
  };

  const result = await runToolLoop({
    aiRouter: router,
    registry,
    toolNames: ["echo"],
    runTaskArgs: { taskType: "draft", input: "x" },
    maxRounds: 2,
    maxTotalModelCalls: 2
  });

  assert.equal(result.text, "done");
  assert.equal(invocations.length, 2);
  assert.ok(invocations.every((args) => args.providerAttemptPreclaimed === true));
  assert.ok(invocations.every((args) => args.executionBudget === invocations[0].executionBudget));
  assert.ok(invocations.every((args) => args.signal === invocations[0].executionBudget.signal));
});

test("judge 预扣采样后把同一预算与 preclaimed 标记交给 AiRouter", async () => {
  const budget = new AgentExecutionBudget({ maxModelCalls: 3, maxToolCalls: 1 });
  const calls = [];
  const aiRouter = {
    async runTask(args) {
      calls.push(args);
      return JSON.stringify({ scores: { information_density: 8 }, findings: [], summary: "ok" });
    }
  };

  await judgeContentQuality({
    aiRouter,
    text: "待评文本",
    dimensions: ["information_density"],
    samples: 1,
    executionBudget: budget
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].executionBudget, budget);
  assert.equal(calls[0].providerAttemptPreclaimed, true);
  assert.equal(calls[0].signal, budget.signal);
  assert.equal(budget.modelCalls, 1);
});
