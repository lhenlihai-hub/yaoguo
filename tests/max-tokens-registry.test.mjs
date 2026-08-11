import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  resolveMaxTokens,
  resolveModelMax,
  DEFAULT_MODEL_MAX
} = require("../src/platform/ai/maxTokensRegistry.js");

test("B2: resolveModelMax 只注册 DeepSeek V4 物理上限", () => {
  assert.equal(resolveModelMax("deepseek-v4-pro"), 384000);
  assert.equal(resolveModelMax("deepseek-v4-flash"), 384000);
  assert.equal(resolveModelMax("deepseek-reasoner"), DEFAULT_MODEL_MAX);
  assert.equal(resolveModelMax("kimi-k2"), DEFAULT_MODEL_MAX);
});

test("B2: resolveModelMax 未注册的 model 回落默认值", () => {
  assert.equal(resolveModelMax(""), DEFAULT_MODEL_MAX);
  assert.equal(resolveModelMax("some-unknown-model-x"), DEFAULT_MODEL_MAX);
  assert.equal(resolveModelMax(null), DEFAULT_MODEL_MAX);
});

test("B2: resolveMaxTokens 不按 taskType 暗中限制模型输出", () => {
  assert.equal(resolveMaxTokens({ taskType: "draft", model: "deepseek-v4-pro" }), 384000);
  assert.equal(resolveMaxTokens({ taskType: "title", model: "deepseek-v4-pro" }), 384000);
  assert.equal(resolveMaxTokens({ taskType: "classify", model: "deepseek-v4-pro" }), 384000);
});

test("B2: resolveMaxTokens 只在显式配置与模型物理上限之间取小", () => {
  assert.equal(resolveMaxTokens({ taskType: "draft", model: "gpt-3.5-turbo" }), 4096);
  // override 存在 + 比 modelMax 小 → 用 override
  assert.equal(resolveMaxTokens({ taskType: "draft", model: "deepseek-v4-pro", providerOverride: 4000 }), 4000);
  // override 存在 + 低于 modelMax → 保留用户配置
  assert.equal(resolveMaxTokens({ taskType: "draft", model: "deepseek-v4-pro", providerOverride: 20000 }), 20000);
  // override 超过 modelMax → 只受物理上限约束
  assert.equal(resolveMaxTokens({ taskType: "draft", model: "deepseek-v4-pro", providerOverride: 500000 }), 384000);
  // override 为 0 或负或非数字 → 按 null 处理
  assert.equal(resolveMaxTokens({ taskType: "draft", model: "deepseek-v4-pro", providerOverride: 0 }), 384000);
  assert.equal(resolveMaxTokens({ taskType: "draft", model: "deepseek-v4-pro", providerOverride: -1 }), 384000);
});

test("B2: resolveMaxTokens 未知 model 回落模型默认值", () => {
  assert.equal(resolveMaxTokens({}), DEFAULT_MODEL_MAX);
});

test("B2 P0 修复：aiRouter.complete 为绕过 runTask 的调用方默认填充 maxTokens", async () => {
  // 验证 aiRouter.complete 包装层在调用方没传 maxTokens 时会自动填充。
  // 这防止直接调 complete 时回退到 modelGateway 4096 兜底。
  const { AiRouter } = require("../src/platform/ai/aiRouter.js");
  const router = new AiRouter({ get: async () => ({}) });
  let capturedOptions = null;
  router.modelGateway = {
    complete: async (provider, model, messages, options) => {
      capturedOptions = options;
      return "ok";
    }
  };
  // 调用方不传 maxTokens
  await router.complete({ id: "deepseek", maxTokens: null }, "deepseek-v4-pro", [{ role: "user", content: "x" }], {
    taskType: "draft"
  });
  // taskType 不改变模型物理上限。
  assert.equal(capturedOptions.maxTokens, 384000);
});

test("B2: aiRouter.completeDetailed 默认填充模型物理上限", async () => {
  const { AiRouter } = require("../src/platform/ai/aiRouter.js");
  const router = new AiRouter({ get: async () => ({}) });
  let capturedOptions = null;
  router.modelGateway = {
    completeDetailed: async (_provider, _model, _messages, options) => {
      capturedOptions = options;
      return { content: "ok" };
    }
  };

  const result = await router.completeDetailed(
    { id: "deepseek", maxTokens: null },
    "deepseek-v4-pro",
    [{ role: "user", content: "x" }],
    { taskType: "agent" }
  );

  assert.equal(result.content, "ok");
  assert.equal(capturedOptions.maxTokens, 384000);
});

test("B2 P0 修复：调用方显式传 maxTokens 不被覆盖", async () => {
  const { AiRouter } = require("../src/platform/ai/aiRouter.js");
  const router = new AiRouter({ get: async () => ({}) });
  let capturedOptions = null;
  router.modelGateway = {
    complete: async (provider, model, messages, options) => {
      capturedOptions = options;
      return "ok";
    }
  };
  await router.complete({ id: "deepseek" }, "deepseek-v4-pro", [{ role: "user", content: "x" }], {
    maxTokens: 1000
  });
  assert.equal(capturedOptions.maxTokens, 1000);
});
