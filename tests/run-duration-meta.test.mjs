import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const persistenceActions = require("../src/application/workflows/mixins/runLifecycle/runPersistenceActions");

function engine() {
  return Object.create(persistenceActions);
}

test("T9: computeRunDurationMeta completedAt - createdAt = total，userWaitMs 减出 net", () => {
  const e = engine();
  const run = {
    createdAt: "2026-05-20T10:00:00.000Z",
    completedAt: "2026-05-20T10:17:05.000Z", // 17m05s 后
    totalUserWaitMs: 162_000 // 2m42s 用户等待
  };
  const meta = e.computeRunDurationMeta(run);
  assert.equal(meta.totalDurationMs, 17 * 60_000 + 5_000);
  assert.equal(meta.userWaitMs, 162_000);
  assert.equal(meta.netProductionMs, meta.totalDurationMs - meta.userWaitMs);
});

test("T9: 缺 completedAt 时 fallback 用 updatedAt", () => {
  const e = engine();
  const meta = e.computeRunDurationMeta({
    createdAt: "2026-05-20T10:00:00.000Z",
    updatedAt: "2026-05-20T10:10:00.000Z",
    totalUserWaitMs: 0
  });
  assert.equal(meta.totalDurationMs, 600_000);
  assert.equal(meta.netProductionMs, 600_000);
});

test("T9: 缺 createdAt → total 为 0，所有字段 0 (不显示)", () => {
  const e = engine();
  const meta = e.computeRunDurationMeta({ completedAt: "2026-05-20T10:00:00.000Z" });
  assert.equal(meta.totalDurationMs, 0);
  assert.equal(meta.netProductionMs, 0);
});

test("T9: totalUserWaitMs 缺失视为 0", () => {
  const e = engine();
  const meta = e.computeRunDurationMeta({
    createdAt: "2026-05-20T10:00:00.000Z",
    completedAt: "2026-05-20T10:05:00.000Z"
  });
  assert.equal(meta.userWaitMs, 0);
  assert.equal(meta.netProductionMs, 300_000);
});

test("T9: 用户等待时间 > 总耗时（异常数据）→ netProductionMs 不为负，钳到 0", () => {
  const e = engine();
  const meta = e.computeRunDurationMeta({
    createdAt: "2026-05-20T10:00:00.000Z",
    completedAt: "2026-05-20T10:00:30.000Z",
    totalUserWaitMs: 60_000 // 1 分钟 wait > 30s 总
  });
  assert.equal(meta.netProductionMs, 0, "net 不能 < 0");
  assert.equal(meta.totalDurationMs, 30_000);
});

test("T9: 负 createdAt 时间戳（异常）→ total 计算返回 0 而不是负数", () => {
  const e = engine();
  const meta = e.computeRunDurationMeta({
    createdAt: "2026-05-20T10:05:00.000Z",
    completedAt: "2026-05-20T10:00:00.000Z" // 早于 createdAt（时钟回退）
  });
  assert.equal(meta.totalDurationMs, 0);
  assert.equal(meta.netProductionMs, 0);
});
