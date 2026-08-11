import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  DEEPSEEK_V4_CONTEXT_WINDOW_TOKENS,
  DEEPSEEK_V4_MAX_OUTPUT_TOKENS,
  isDeepSeekV4,
  resolveDeepSeekV4Policy
} = require("../src/platform/ai/deepseekV4Policy.js");
const { AiRouter } = require("../src/platform/ai/aiRouter.js");
const { mergeSettings } = require("../src/platform/config/settingsService.js");

const provider = {
  id: "deepseek",
  name: "DeepSeek V4",
  baseUrl: "https://api.deepseek.com"
};

test("DeepSeek V4 官方物理上限在策略、路由与 settings 迁移中一致", () => {
  assert.equal(DEEPSEEK_V4_CONTEXT_WINDOW_TOKENS, 1_000_000);
  assert.equal(DEEPSEEK_V4_MAX_OUTPUT_TOKENS, 384_000);

  const router = new AiRouter({ get: async () => ({}) });
  assert.equal(router.getModelContextTokens(provider, "deepseek-v4-pro", {}), 1_000_000);
  assert.equal(router.getModelContextTokens(
    { ...provider, contextWindow: 2_000_000 },
    "deepseek-v4-pro",
    { context: { tokenBudgets: { models: { "deepseek-v4-pro": 1_048_576 } } } }
  ), 1_000_000);

  const migrated = mergeSettings({
    context: {
      tokenBudgets: {
        models: {
          "deepseek-v4-pro": 1_048_576,
          "deepseek-v4-flash": 2_000_000
        }
      }
    }
  });
  assert.equal(migrated.context.tokenBudgets.models["deepseek-v4-pro"], 1_000_000);
  assert.equal(migrated.context.tokenBudgets.models["deepseek-v4-flash"], 1_000_000);
});

test("DeepSeek V4 policy 识别 Pro/Flash，不污染其他 OpenAI-compatible provider", () => {
  assert.equal(isDeepSeekV4(provider, "deepseek-v4-pro"), true);
  assert.equal(isDeepSeekV4(provider, "deepseek-v4-flash"), true);
  assert.equal(isDeepSeekV4({ id: "openai" }, "gpt-5.4"), false);
  assert.equal(
    resolveDeepSeekV4Policy({ provider: { id: "openai" }, model: "gpt-5.4" }).applicable,
    false
  );
});

test("DeepSeek V4 policy 对所有调用使用同一个全局思考能力", () => {
  const policy = resolveDeepSeekV4Policy({
    provider,
    model: "deepseek-v4-flash",
    taskType: "futureTask",
    settings: { deepseek: { thinking: "high" } }
  });
  assert.deepEqual(policy, {
    applicable: true,
    enabled: true,
    thinking: "enabled",
    reasoningEffort: "high"
  });
});

test("DeepSeek V4 policy 在全局关闭时不因工具或任务类型重新开启", () => {
  const policy = resolveDeepSeekV4Policy({
    provider,
    model: "deepseek-v4-pro",
    taskType: "agent",
    hasTools: true,
    settings: {
      deepseek: { thinking: "disabled" }
    }
  });
  assert.equal(policy.enabled, false);
  assert.equal(policy.reasoningEffort, null);
});

test("DeepSeek V4 universal agent 初始调用与连续工具轮保持同一强度", () => {
  const settings = {
    deepseek: { thinking: "max" }
  };
  const initial = resolveDeepSeekV4Policy({
    provider, model: "deepseek-v4-pro", taskType: "agent", hasTools: true, settings
  });
  const toolRound = resolveDeepSeekV4Policy({
    provider, model: "deepseek-v4-pro", taskType: "agent", hasTools: true,
    agentStage: "tool", settings
  });
  assert.equal(initial.reasoningEffort, "max");
  assert.equal(toolRound.reasoningEffort, "max");
});

test("DeepSeek V4 policy 支持 thinking 关闭与 effort 显式覆盖", () => {
  const disabled = resolveDeepSeekV4Policy({
    provider,
    model: "deepseek-v4-pro",
    taskType: "workflow",
    settings: { deepseek: { thinking: "max" } },
    thinkingOverride: false
  });
  assert.equal(disabled.thinking, "disabled");
  assert.equal(disabled.reasoningEffort, null);

  const lowered = resolveDeepSeekV4Policy({
    provider,
    model: "deepseek-v4-pro",
    taskType: "workflow",
    settings: { deepseek: { thinking: "max" } },
    reasoningEffortOverride: "high"
  });
  assert.equal(lowered.thinking, "enabled");
  assert.equal(lowered.reasoningEffort, "high");

  const enabled = resolveDeepSeekV4Policy({
    provider,
    model: "deepseek-v4-flash",
    taskType: "title",
    thinkingOverride: true,
    reasoningEffortOverride: "max"
  });
  assert.equal(enabled.thinking, "enabled");
  assert.equal(enabled.reasoningEffort, "max");
});

test("DeepSeek V4 显式 thinking/effort override 在有工具和关闭工具的连续轮持续生效", async () => {
  const router = new AiRouter({ get: async () => ({}) });
  const observed = [];
  router.getModelContextTokens = () => 1_000_000;
  router.getOutputReserveTokens = () => 10_000;
  router.assertContextWindow = () => {};
  router.logCall = async () => {};
  router.completeDetailed = async (_provider, _model, _messages, options) => {
    observed.push({ policy: options.deepseekPolicy, maxTokens: options.maxTokens });
    return { content: "ok", toolCalls: [], usage: null };
  };
  const base = {
    provider,
    model: "deepseek-v4-pro",
    settings: { deepseek: { thinking: "max" } },
    taskType: "agent",
    maxTokens: 8192,
    thinkingOverride: false,
    reasoningEffortOverride: "max"
  };
  await router.continueTaskDetailed({ base, messages: [{ role: "user", content: "x" }], tools: [{}], agentStage: "tool" });
  await router.continueTaskDetailed({ base, messages: [{ role: "user", content: "x" }], tools: [], agentStage: "tool" });
  assert.deepEqual(observed.map((item) => [item.policy.thinking, item.policy.reasoningEffort]), [
    ["disabled", null],
    ["disabled", null]
  ]);
  assert.deepEqual(observed.map((item) => item.maxTokens), [8192, 8192]);
});

test("DeepSeek V4 高思考工具轮沿用 Agent 的完整 completion 预算", async () => {
  const router = new AiRouter({ get: async () => ({}) });
  let observedMaxTokens = 0;
  router.getModelContextTokens = () => 1_000_000;
  router.getOutputReserveTokens = () => 20_000;
  router.assertContextWindow = () => {};
  router.logCall = async () => {};
  router.completeDetailed = async (_provider, _model, _messages, options) => {
    observedMaxTokens = options.maxTokens;
    return { content: "ok", toolCalls: [], usage: null };
  };
  await router.continueTaskDetailed({
    base: {
      provider,
      model: "deepseek-v4-pro",
      settings: { deepseek: { thinking: "max" } },
      taskType: "agent",
      maxTokens: 65536
    },
    messages: [{ role: "user", content: "x" }],
    tools: [{}],
    agentStage: "tool"
  });
  assert.equal(observedMaxTokens, 65536);
});
