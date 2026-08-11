import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { ModelGateway } = require("../src/platform/ai/modelGateway");

function gateway() {
  return new ModelGateway();
}

test("T1: isReasoningTask 命中 deepseek-reasoner / kimi-k2-thinking", () => {
  const g = gateway();
  assert.equal(g.isReasoningTask({ modelId: "deepseek-reasoner" }), true);
  assert.equal(g.isReasoningTask({ modelId: "kimi-k2-thinking" }), true);
  assert.equal(g.isReasoningTask({ modelId: "claude-sonnet-4-5-thinking" }), true);
});

test("T1: isReasoningTask 命中 OpenAI o1/o3/o4 但不误判普通模型", () => {
  const g = gateway();
  assert.equal(g.isReasoningTask({ modelId: "o1-preview" }), true);
  assert.equal(g.isReasoningTask({ modelId: "o3-mini" }), true);
  assert.equal(g.isReasoningTask({ modelId: "openai-o4" }), true);
  // 不应误判
  assert.equal(g.isReasoningTask({ modelId: "deepseek-v4-pro" }), false);
  assert.equal(g.isReasoningTask({ modelId: "kimi-k2.5" }), false);
  assert.equal(g.isReasoningTask({ modelId: "gpt-5.4" }), false);
});

test("T1: isReasoningTask 长输出 taskType 触发 reasoning profile", () => {
  const g = gateway();
  assert.equal(g.isReasoningTask({ modelId: "deepseek-v4-pro", taskType: "draft" }), true);
  assert.equal(g.isReasoningTask({ modelId: "deepseek-v4-pro", taskType: "revise" }), true);
  assert.equal(g.isReasoningTask({ modelId: "deepseek-v4-pro", taskType: "memory" }), false);
});

test("T1: reasoningOverride 显式覆盖优先级最高", () => {
  const g = gateway();
  // 显式 false 即便 model 命中 regex 也算非 reasoning
  assert.equal(g.isReasoningTask({ modelId: "deepseek-reasoner", reasoningOverride: false }), false);
  // 显式 true 即便 model 完全无关也算 reasoning
  assert.equal(g.isReasoningTask({ modelId: "gpt-5.4", reasoningOverride: true }), true);
});

test("T1: DeepSeek V4 policy 的 enabled 映射为 timeout reasoningOverride", () => {
  const g = gateway();
  assert.equal(g.resolveReasoningOverride({ deepseekPolicy: { enabled: true } }), true);
  assert.equal(g.resolveReasoningOverride({ deepseekPolicy: { enabled: false } }), false);
  assert.equal(g.resolveReasoningOverride({}), null);

  const override = g.resolveReasoningOverride({ deepseekPolicy: { enabled: true } });
  const p = g.resolveTimeoutProfile({ modelId: "deepseek-v4-pro", reasoningOverride: override });
  assert.equal(p.kind, "reasoning");
  assert.equal(p.wallMs, 1500000);
});

test("T1: resolveTimeoutProfile 默认非 reasoning → 60s/90s/600s", () => {
  const g = gateway();
  const p = g.resolveTimeoutProfile({ modelId: "deepseek-v4-pro" });
  assert.equal(p.kind, "default");
  assert.equal(p.ttftMs, 60000);
  assert.equal(p.idleMs, 90000);
  assert.equal(p.wallMs, 600000);
});

test("T1: resolveTimeoutProfile reasoning 模型 → 240s/180s/1500s", () => {
  const g = gateway();
  const p = g.resolveTimeoutProfile({ modelId: "deepseek-reasoner" });
  assert.equal(p.kind, "reasoning");
  assert.equal(p.ttftMs, 240000);
  assert.equal(p.idleMs, 180000);
  assert.equal(p.wallMs, 1500000);
});

test("T1: resolveTimeoutProfile settings.timeouts 可覆盖默认值", () => {
  const g = gateway();
  const settings = { timeouts: { ttftDefaultMs: 30000, idleReasoningMs: 60000 } };
  const pDefault = g.resolveTimeoutProfile({ modelId: "x", settings });
  assert.equal(pDefault.ttftMs, 30000, "settings override 走非 reasoning 默认值");
  const pReasoning = g.resolveTimeoutProfile({ modelId: "deepseek-reasoner", settings });
  assert.equal(pReasoning.idleMs, 60000, "settings override 走 reasoning 默认值");
  // 未覆盖的字段保持 hardcoded 默认
  assert.equal(pReasoning.ttftMs, 240000);
});

test("T1: resolveTimeoutProfile options.ttftMs 单次调用级显式覆盖最高", () => {
  const g = gateway();
  const p = g.resolveTimeoutProfile({
    modelId: "deepseek-reasoner",
    settings: { timeouts: { ttftReasoningMs: 999999 } },
    options: { ttftMs: 5000 }
  });
  assert.equal(p.ttftMs, 5000);
});

test("T1: buildStreamAbortSignals 加 ttftMs 时第一次 refreshIdle 清掉 TTFT 计时", async () => {
  const g = gateway();
  // ttft 50ms，idle 500ms，wall 5000ms
  const signals = g.buildStreamAbortSignals(5000, 500, null, { ttftMs: 50 });
  // 30ms 后 refreshIdle（模拟第一个 chunk 到达）
  await new Promise((r) => setTimeout(r, 30));
  signals.refreshIdle();
  // 再等 100ms（超过原 ttft 50ms），不应被 abort（已被 refreshIdle 清掉）
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(signals.signal.aborted, false, "first chunk 后 TTFT 不应再触发");
  signals.cleanup();
});

test("T1: buildStreamAbortSignals 未到 ttftMs 收到任何 chunk → 不 abort", async () => {
  const g = gateway();
  const signals = g.buildStreamAbortSignals(5000, 500, null, { ttftMs: 100 });
  // 150ms 不调 refreshIdle → 应 ttft abort
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(signals.signal.aborted, true);
  assert.match(signals.reasons.ttft?.message || "", /TTFT timeout/);
  signals.cleanup();
});

test("T1: buildStreamAbortSignals 不传 ttftMs 保持原双层（idle + wall）行为", async () => {
  const g = gateway();
  // 不传 opts.ttftMs，应该走 idle 路径
  const signals = g.buildStreamAbortSignals(5000, 80, null);
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(signals.signal.aborted, true);
  assert.match(signals.reasons.idle?.message || "", /idle timeout/);
  signals.cleanup();
});

test("T1: buildStreamAbortSignals 第一次 chunk 后 idle 接管，正常持续 chunk 不超时", async () => {
  const g = gateway();
  const signals = g.buildStreamAbortSignals(5000, 100, null, { ttftMs: 50 });
  // first chunk at 30ms
  await new Promise((r) => setTimeout(r, 30));
  signals.refreshIdle();
  // 每 50ms 来一个 chunk 持续 300ms
  for (let i = 0; i < 6; i += 1) {
    await new Promise((r) => setTimeout(r, 50));
    signals.refreshIdle();
  }
  assert.equal(signals.signal.aborted, false, "持续 chunk 应被持续 refresh idle");
  signals.cleanup();
});
