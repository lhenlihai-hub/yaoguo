import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { TokenLedger } = require("../src/platform/telemetry/tokenLedger.js");

function makeLedger(dir) {
  return new TokenLedger({
    privateDir: dir,
    aiCallsFile: join(dir, "ai-calls.jsonl"),
    tokenLedgerFile: join(dir, "token-ledger.jsonl"),
    tokenSummaryFile: join(dir, "token-summary.json")
  });
}

test("TokenLedger 持久化 DeepSeek thinking 与 finish_reason 可观测字段", async () => {
  const dir = mkdtempSync(join(tmpdir(), "yaoguo-token-ledger-"));
  try {
    // 模拟旧版 summary：没有 reasoningTokens，升级后必须可原地累加。
    writeFileSync(join(dir, "token-summary.json"), JSON.stringify({
      version: 1,
      totals: { calls: 2, promptTokens: 20, completionTokens: 8, cacheHitTokens: 4 },
      byTaskType: {
        workflow: { calls: 1, promptTokens: 10, completionTokens: 4, cacheHitTokens: 2, durationMs: 100 }
      },
      byModel: {}
    }));

    const ledger = makeLedger(dir);
    const normalized = await ledger.recordCall({
      id: "call-1",
      taskType: "workflow",
      providerId: "deepseek",
      model: "deepseek-v4-pro",
      status: "completed",
      actualPromptTokens: 100,
      actualCompletionTokens: 40,
      reasoningTokens: 12,
      cacheHitTokens: 60,
      cacheMissTokens: 40,
      contextUsageRatio: 0.2,
      actualContextUsageRatio: 0.125,
      finishReason: "stop",
      thinkingMode: "enabled",
      reasoningEffort: "max"
    });

    assert.equal(normalized.reasoningTokens, 12);
    assert.equal(normalized.totalTokens, 140, "reasoning token 已包含在 completion 内，不得重复计数");
    assert.equal(normalized.finishReason, "stop");
    assert.equal(normalized.thinkingMode, "enabled");
    assert.equal(normalized.reasoningEffort, "max");
    assert.equal(normalized.actualContextUsageRatio, 0.125);

    const persisted = readFileSync(join(dir, "token-ledger.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(persisted.at(-1).reasoningTokens, 12);
    assert.equal(persisted.at(-1).finishReason, "stop");

    const summary = JSON.parse(readFileSync(join(dir, "token-summary.json"), "utf8"));
    assert.equal(summary.totals.reasoningTokens, 12);
    assert.equal(summary.byTaskType.workflow.reasoningTokens, 12);
    assert.equal(summary.byTaskType.workflow.calls, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TokenLedger 读取旧调用时为新字段提供兼容默认值", () => {
  const ledger = makeLedger("");
  const normalized = ledger.normalize({
    actualPromptTokens: 8,
    actualCompletionTokens: 2,
    contextUsageRatio: 0.25
  });
  assert.equal(normalized.reasoningTokens, 0);
  assert.equal(normalized.finishReason, "");
  assert.equal(normalized.thinkingMode, "");
  assert.equal(normalized.reasoningEffort, "");
  assert.equal(normalized.actualContextUsageRatio, 0.25);
});

test("TokenLedger 可按项目会话汇总 token 与缓存命中", async () => {
  const dir = mkdtempSync(join(tmpdir(), "yaoguo-token-usage-"));
  try {
    const ledger = makeLedger(dir);
    await ledger.recordCall({
      projectId: "p1", taskId: "t1", status: "completed",
      actualPromptTokens: 100, actualCompletionTokens: 20, reasoningTokens: 8,
      cacheHitTokens: 70, cacheMissTokens: 30,
      modelContextTokens: 1_000_000
    });
    await ledger.recordCall({
      projectId: "p1", taskId: "t1", status: "completed",
      actualPromptTokens: 50, actualCompletionTokens: 10,
      cacheHitTokens: 20, cacheMissTokens: 30,
      internalCall: true, taskType: "memory"
    });
    await ledger.recordCall({
      projectId: "p1", taskId: "other", status: "completed",
      actualPromptTokens: 999, actualCompletionTokens: 999
    });
    assert.deepEqual(await ledger.summarizeUsage({ projectId: "p1", taskId: "t1" }), {
      modelCalls: 2,
      completedCalls: 2,
      failedCalls: 0,
      promptTokens: 150,
      completionTokens: 30,
      reasoningTokens: 8,
      cacheHitTokens: 90,
      cacheMissTokens: 60,
      totalTokens: 180,
      cacheHitRate: 0.6,
      invalidRows: 0,
      currentContextTokens: 120,
      contextWindowTokens: 1_000_000,
      contextUsageRatio: 0.00012,
      foreground: {
        modelCalls: 1,
        completedCalls: 1,
        failedCalls: 0,
        promptTokens: 100,
        completionTokens: 20,
        reasoningTokens: 8,
        cacheHitTokens: 70,
        cacheMissTokens: 30,
        totalTokens: 120,
        cacheHitRate: 0.7,
        currentContextTokens: 120,
        contextWindowTokens: 1_000_000,
        contextUsageRatio: 0.00012
      },
      background: {
        modelCalls: 1,
        completedCalls: 1,
        failedCalls: 0,
        promptTokens: 50,
        completionTokens: 10,
        reasoningTokens: 0,
        cacheHitTokens: 20,
        cacheMissTokens: 30,
        totalTokens: 60,
        cacheHitRate: 0.4,
        currentContextTokens: 0,
        contextWindowTokens: 0,
        contextUsageRatio: 0
      }
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("原始 ai-calls 副本同样脱敏错误文本", async () => {
  const dir = mkdtempSync(join(tmpdir(), "yaoguo-ledger-redact-"));
  const ledger = makeLedger(dir);
  try {
    await ledger.recordCall({
      taskType: "agent",
      title: "测试",
      providerId: "deepseek",
      providerName: "DeepSeek",
      model: "deepseek-v4-pro",
      error: "请求失败 401：Authorization: Bearer sk-abcdef1234567890 无效"
    });
    const raw = readFileSync(join(dir, "ai-calls.jsonl"), "utf8");
    assert.equal(raw.includes("sk-abcdef1234567890"), false, "原始副本不得包含未脱敏密钥");
    assert.equal(raw.includes("Bearer sk-"), false, "Bearer 凭据必须整体脱敏");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
