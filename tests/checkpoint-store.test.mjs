import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { CheckpointStore, CHECKPOINT_VERSION } = require("../src/platform/runs/checkpointStore.js");

function makeRunDir() {
  return mkdtempSync(join(tmpdir(), "yaoguo-checkpoint-"));
}

test("CheckpointStore.normalize 填全默认字段并清洗 handoff 列表", () => {
  const store = new CheckpointStore();
  const row = store.normalize({
    runId: "r1",
    stepId: "01-brief",
    stepIndex: 0,
    title: "连续性简报",
    taskType: "memory",
    handoff: {
      decisions: ["  用第三人称  ", "", " 保持紧张感"],
      rejected: "非法值不应崩",
      openQuestions: null,
      facts: ["天空是蓝色"]
    }
  });
  assert.equal(row.v, CHECKPOINT_VERSION);
  assert.equal(row.stepId, "01-brief");
  assert.equal(row.status, "completed");
  assert.deepEqual(row.handoff.decisions, ["用第三人称", "保持紧张感"]);
  assert.deepEqual(row.handoff.rejected, []);
  assert.deepEqual(row.handoff.openQuestions, []);
  assert.deepEqual(row.handoff.facts, ["天空是蓝色"]);
});

test("CheckpointStore.append 写入 JSONL 并被 loadHistory / loadLatest 准确读出", async () => {
  const runDir = makeRunDir();
  const store = new CheckpointStore();
  await store.append(runDir, {
    runId: "r1", stepId: "01", stepIndex: 0, title: "S1", taskType: "memory",
    handoff: { decisions: ["A"] }
  });
  await store.append(runDir, {
    runId: "r1", stepId: "02", stepIndex: 1, parentStepId: "01",
    title: "S2", taskType: "outline",
    handoff: { decisions: ["B"], rejected: ["X"] }
  });
  const history = await store.loadHistory(runDir);
  assert.equal(history.length, 2);
  assert.equal(history[0].stepId, "01");
  assert.equal(history[1].parentStepId, "01");
  const latest = await store.loadLatest(runDir);
  assert.equal(latest.stepId, "02");
});

test("CheckpointStore.loadAccumulatedState 合并去重所有 completed step 的 handoff", async () => {
  const runDir = makeRunDir();
  const store = new CheckpointStore();
  await store.append(runDir, {
    runId: "r1", stepId: "01", stepIndex: 0, status: "completed",
    handoff: { decisions: ["用第一人称"], facts: ["主角叫刘海"] }
  });
  await store.append(runDir, {
    runId: "r1", stepId: "02", stepIndex: 1, status: "completed",
    handoff: { decisions: ["用第一人称", "保持悬疑"], rejected: ["不用上帝视角"] }
  });
  await store.append(runDir, {
    runId: "r1", stepId: "03-skipped", stepIndex: 2, status: "blocked",
    handoff: { decisions: ["这条不该出现"] }
  });
  const acc = await store.loadAccumulatedState(runDir);
  // 去重：用第一人称只出现一次
  assert.deepEqual(acc.decisions, ["用第一人称", "保持悬疑"]);
  assert.deepEqual(acc.rejected, ["不用上帝视角"]);
  assert.deepEqual(acc.facts, ["主角叫刘海"]);
  // blocked 的 step 不进入 accumulated state
  assert.equal(acc.stepSummaries.length, 2);
});

test("CheckpointStore.loadAccumulatedState 支持 untilStepId 截断（time travel 基础）", async () => {
  const runDir = makeRunDir();
  const store = new CheckpointStore();
  await store.append(runDir, { runId: "r1", stepId: "01", stepIndex: 0, handoff: { decisions: ["A"] } });
  await store.append(runDir, { runId: "r1", stepId: "02", stepIndex: 1, handoff: { decisions: ["B"] } });
  await store.append(runDir, { runId: "r1", stepId: "03", stepIndex: 2, handoff: { decisions: ["C"] } });
  const acc = await store.loadAccumulatedState(runDir, { untilStepId: "02" });
  assert.deepEqual(acc.decisions, ["A", "B"]);
  assert.equal(acc.stepSummaries.length, 2);
});

test("CheckpointStore.fork 按 stepId 截断到目标 run，支持 time travel", async () => {
  const srcDir = makeRunDir();
  const dstDir = makeRunDir();
  const store = new CheckpointStore();
  await store.append(srcDir, { runId: "r1", stepId: "01", stepIndex: 0 });
  await store.append(srcDir, { runId: "r1", stepId: "02", stepIndex: 1 });
  await store.append(srcDir, { runId: "r1", stepId: "03", stepIndex: 2 });
  const result = await store.fork(srcDir, dstDir, { untilStepId: "02" });
  assert.equal(result.copied, 2);
  const forked = await store.loadHistory(dstDir);
  assert.equal(forked.length, 2);
  assert.equal(forked[1].stepId, "02");
});

test("CheckpointStore.loadHistory 跳过损坏行（崩溃恢复语义）", async () => {
  const runDir = makeRunDir();
  const store = new CheckpointStore();
  await store.append(runDir, { runId: "r1", stepId: "01", stepIndex: 0 });
  // 手动追加一行半截 JSON 模拟崩溃
  const { appendFile } = await import("node:fs/promises");
  await appendFile(join(runDir, "checkpoints.jsonl"), '{"v":1,"stepId":"bad",,broken\n', "utf8");
  await store.append(runDir, { runId: "r1", stepId: "02", stepIndex: 1 });
  const history = await store.loadHistory(runDir);
  assert.equal(history.length, 2);
  assert.deepEqual(history.map((row) => row.stepId), ["01", "02"]);
});

test("CheckpointStore.findByStepId 同 stepId 多次重跑取最新", async () => {
  const runDir = makeRunDir();
  const store = new CheckpointStore();
  await store.append(runDir, { runId: "r1", stepId: "02", stepIndex: 1, summary: "第一次" });
  await store.append(runDir, { runId: "r1", stepId: "01", stepIndex: 0, summary: "无关步骤" });
  await store.append(runDir, { runId: "r1", stepId: "02", stepIndex: 1, summary: "重跑" });
  const found = await store.findByStepId(runDir, "02");
  assert.equal(found.summary, "重跑");
});

test("CheckpointStore JSONL 文件每行严格自含 JSON", async () => {
  const runDir = makeRunDir();
  const store = new CheckpointStore();
  await store.append(runDir, { runId: "r1", stepId: "01", stepIndex: 0, handoff: { decisions: ["x"] } });
  await store.append(runDir, { runId: "r1", stepId: "02", stepIndex: 1 });
  const raw = await readFile(join(runDir, "checkpoints.jsonl"), "utf8");
  for (const line of raw.trim().split("\n")) {
    const parsed = JSON.parse(line);
    assert.equal(parsed.v, CHECKPOINT_VERSION);
  }
});
