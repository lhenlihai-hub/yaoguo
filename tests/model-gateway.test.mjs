import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { ModelGateway } = require("../src/platform/ai/modelGateway.js");

test("ModelGateway 使用唯一 DeepSeek 配置的 temperature", () => {
  const gateway = new ModelGateway();
  assert.equal(
    gateway.resolveTemperature({ id: "deepseek", temperature: 0.2 }, "deepseek-v4-pro"),
    0.2
  );
});

test("ModelGateway usage 归一化支持 DeepSeek 缓存字段与命中率", () => {
  const gateway = new ModelGateway();
  const usage = gateway.normalizeUsage({
    prompt_tokens: 100,
    completion_tokens: 40,
    prompt_cache_hit_tokens: 25,
    prompt_cache_miss_tokens: 75
  });
  assert.equal(usage.promptTokens, 100);
  assert.equal(usage.completionTokens, 40);
  assert.equal(usage.cacheHitTokens, 25);
  assert.equal(usage.cacheMissTokens, 75);
  assert.equal(usage.cacheHitRate, 0.25);
});

test("ModelGateway 流式请求开启 usage，并保留末尾 DeepSeek 缓存统计", async () => {
  const gateway = new ModelGateway();
  const originalFetch = globalThis.fetch;
  let body = null;
  globalThis.fetch = async (_url, init) => {
    body = JSON.parse(init.body);
    const stream = [
      'data: {"choices":[{"delta":{"content":"完成"}}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":120,"completion_tokens":8,"prompt_cache_hit_tokens":80,"prompt_cache_miss_tokens":40}}\n\n',
      "data: [DONE]\n\n"
    ].join("");
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  try {
    const response = await gateway.completeOpenAICompatibleStreamDetailed(
      { id: "deepseek", apiKey: "test", baseUrl: "https://api.deepseek.com" },
      "deepseek-v4-pro",
      [{ role: "user", content: "hi" }],
      { onToken: () => {}, taskType: "agent", settings: { deepseek: { thinking: "disabled" } } }
    );
    assert.deepEqual(body.stream_options, { include_usage: true });
    assert.equal(response.usage.promptTokens, 120);
    assert.equal(response.usage.cacheHitTokens, 80);
    assert.equal(response.usage.cacheMissTokens, 40);
    assert.equal(response.usage.cacheHitRate, 0.6667);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ModelGateway jsonMode 会设置 OpenAI-compatible response_format", () => {
  const gateway = new ModelGateway();
  const body = gateway.buildOpenAICompatibleBody(
    { maxTokens: 1234 },
    "model-a",
    [{ role: "user", content: "hi" }],
    undefined,
    { jsonMode: true }
  );
  assert.deepEqual(body.response_format, { type: "json_object" });
  assert.equal(body.max_tokens, 1234);
});

test("ModelGateway 只为明确不支持 streaming 的错误降级", () => {
  const gateway = new ModelGateway();
  assert.equal(gateway.isStreamingUnsupportedError(new Error("unknown parameter: stream")), true);
  assert.equal(gateway.isStreamingUnsupportedError(new Error("streaming is not supported")), true);
  assert.equal(gateway.isStreamingUnsupportedError(new Error("upstream stream timeout")), false);
  assert.equal(gateway.isStreamingUnsupportedError(new Error("invalid_request: quota exceeded")), false);
});

test("ModelGateway jsonMode fallback 去掉 response_format 后仍处理 temperature=1 回退", async () => {
  const gateway = new ModelGateway();
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    if (calls.length === 1) {
      return new Response("unsupported response_format", { status: 400 });
    }
    if (calls.length === 2) {
      assert.equal(body.response_format, undefined);
      return new Response("only 1 is allowed for temperature", { status: 400 });
    }
    assert.equal(body.response_format, undefined);
    assert.equal(body.temperature, 1);
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
  };
  try {
    const out = await gateway.completeOpenAICompatible(
      { apiKey: "sk-test", baseUrl: "https://example.test", temperature: 0.2 },
      "model-a",
      [{ role: "user", content: "hi" }],
      { jsonMode: true }
    );
    assert.equal(out, "ok");
    assert.equal(calls.length, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ModelGateway.buildStreamAbortSignals idle 超时单独触发", async () => {
  const gateway = new ModelGateway();
  const { signal, cleanup } = gateway.buildStreamAbortSignals(10000, 50, null);
  try {
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(signal.aborted, true);
    assert.match(`${signal.reason?.message || signal.reason || ""}`, /idle timeout/);
  } finally {
    cleanup();
  }
});

test("ModelGateway.buildStreamAbortSignals refreshIdle 可避免 idle abort", async () => {
  const gateway = new ModelGateway();
  const { signal, refreshIdle, cleanup } = gateway.buildStreamAbortSignals(10000, 100, null);
  try {
    await new Promise((resolve) => setTimeout(resolve, 70));
    refreshIdle();
    await new Promise((resolve) => setTimeout(resolve, 70));
    assert.equal(signal.aborted, false);
  } finally {
    cleanup();
  }
});

test("ModelGateway.buildStreamAbortSignals 墙钟超时触发即便持续 refresh", async () => {
  const gateway = new ModelGateway();
  const { signal, refreshIdle, cleanup } = gateway.buildStreamAbortSignals(80, 10000, null);
  try {
    const ticker = setInterval(refreshIdle, 10);
    await new Promise((resolve) => setTimeout(resolve, 130));
    clearInterval(ticker);
    assert.equal(signal.aborted, true);
    assert.match(`${signal.reason?.message || signal.reason || ""}`, /wall-clock timeout/);
  } finally {
    cleanup();
  }
});

test("ModelGateway.buildStreamAbortSignals externalSignal abort 传递到合并 signal", async () => {
  const gateway = new ModelGateway();
  const controller = new AbortController();
  const { signal, cleanup } = gateway.buildStreamAbortSignals(10000, 10000, controller.signal);
  try {
    controller.abort(new Error("user cancel"));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(signal.aborted, true);
  } finally {
    cleanup();
  }
});
