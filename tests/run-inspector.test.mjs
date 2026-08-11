import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { inspectRun } = require("../src/platform/runs/runInspector.js");

function makeRunDir() {
  return mkdtempSync(path.join(tmpdir(), "run-inspector-"));
}

async function writeJson(file, obj) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(obj), "utf8");
}

async function writeJsonl(file, rows) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
}

// ============ 不存在的 runDir ============

test("inspectRun 不存在的目录返回 exists=false + 空 summary", async () => {
  const r = await inspectRun("/tmp/nonexistent-run-dir-xyz");
  assert.equal(r.exists, false);
  assert.equal(r.steps.length, 0);
  assert.equal(r.spawns.length, 0);
  assert.equal(r.todos.length, 0);
});

test("inspectRun 空 runDir(目录存在但无任何产物)所有维度返回空", async () => {
  const runDir = makeRunDir();
  const r = await inspectRun(runDir);
  assert.equal(r.exists, true);
  assert.equal(r.steps.length, 0);
  assert.equal(r.spawns.length, 0);
  assert.equal(r.todos.length, 0);
  assert.equal(r.checkpoints.length, 0);
  assert.equal(r.summary.stepCount, 0);
  assert.equal(r.summary.totalToolCalls, 0);
  await rm(runDir, { recursive: true, force: true });
});

// ============ steps tool-trace ============

test("inspectRun 读多个 step 的 tool-trace.jsonl,按最新优先排序", async () => {
  const runDir = makeRunDir();
  // step-1:旧
  await writeJsonl(
    path.join(runDir, "steps", "step-1", "tool-trace.jsonl"),
    [{ persistedAt: "2026-01-01T00:00:00Z", stepId: "step-1", toolCallsCount: 2, toolCalls: [
      { round: 0, name: "recall_handoff", argsDigest: "a".repeat(64), ok: true },
      { round: 1, name: "llm_judge_quality", argsDigest: "b".repeat(64), ok: true }
    ] }]
  );
  // step-2:新
  await writeJsonl(
    path.join(runDir, "steps", "step-2", "tool-trace.jsonl"),
    [{ persistedAt: "2026-02-01T00:00:00Z", stepId: "step-2", toolCallsCount: 1, toolCalls: [
      { round: 0, name: "search_run_artifacts", argsDigest: "c".repeat(64), ok: false, code: "TOOL_FAILED" }
    ] }]
  );
  const r = await inspectRun(runDir);
  assert.equal(r.steps.length, 2);
  assert.equal(r.steps[0].stepId, "step-2", "最新 persistedAt 应在前");
  assert.equal(r.steps[1].stepId, "step-1");
  assert.equal(r.summary.totalToolCalls, 3);
  await rm(runDir, { recursive: true, force: true });
});

test("inspectRun tool-trace.jsonl 含损坏行时跳过不抛", async () => {
  const runDir = makeRunDir();
  const file = path.join(runDir, "steps", "s1", "tool-trace.jsonl");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, [
    JSON.stringify({ persistedAt: "2026-01-01T00:00:00Z", stepId: "s1", toolCallsCount: 1 }),
    "{ 损坏行",
    JSON.stringify({ persistedAt: "2026-01-02T00:00:00Z", stepId: "s1", toolCallsCount: 2 })
  ].join("\n") + "\n", "utf8");
  const r = await inspectRun(runDir);
  assert.equal(r.steps[0].traces.length, 2, "损坏行应被跳过,其他 2 行保留");
  await rm(runDir, { recursive: true, force: true });
});

// ============ spawns ============

test("inspectRun 只读 spawn 安全 trace，不暴露历史 output.md 正文", async () => {
  const runDir = makeRunDir();
  const dir = path.join(runDir, "spawns", "spawn_abc123");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "output.md"), "子 agent 写的成品", "utf8");
  await writeJsonl(path.join(dir, "trace.jsonl"), [
    {
      spawnId: "spawn_abc123",
      spawnedByStepId: "step-draft",
      spawnedByTaskType: "draft",
      purposeDigest: "d".repeat(64),
      promptDigest: "e".repeat(64),
      resultDigest: "f".repeat(64),
      resultChars: 12,
      maxRounds: 4,
      rounds: 3,
      exhausted: false,
      allowedTools: ["recall_handoff", "search_run_artifacts"],
      toolCalls: [{ round: 0, name: "recall_handoff", argsDigest: "1".repeat(64), ok: true }],
      completedAt: "2026-01-01T00:00:00Z"
    }
  ]);
  const r = await inspectRun(runDir);
  assert.equal(r.spawns.length, 1);
  assert.equal(r.spawns[0].id, "spawn_abc123");
  assert.equal(r.spawns[0].output, undefined);
  assert.equal(r.spawns[0].trace.resultDigest, "f".repeat(64));
  assert.equal(r.summary.spawnCount, 1);
  await rm(runDir, { recursive: true, force: true });
});

test("inspectRun 忽略不以 spawn_ 开头的目录(防误读其他子目录)", async () => {
  const runDir = makeRunDir();
  await mkdir(path.join(runDir, "spawns", "garbage"), { recursive: true });
  await mkdir(path.join(runDir, "spawns", "spawn_real"), { recursive: true });
  await writeFile(path.join(runDir, "spawns", "spawn_real", "output.md"), "x", "utf8");
  const r = await inspectRun(runDir);
  assert.equal(r.spawns.length, 1);
  assert.equal(r.spawns[0].id, "spawn_real");
  await rm(runDir, { recursive: true, force: true });
});

// ============ todos ============

test("inspectRun 读 todos.json 并按 status 分布统计", async () => {
  const runDir = makeRunDir();
  await writeJson(path.join(runDir, "todos.json"), {
    version: 1,
    todos: [
      { id: "t1", text: "a", status: "pending" },
      { id: "t2", text: "b", status: "done" },
      { id: "t3", text: "c", status: "in_progress" },
      { id: "t4", text: "d", status: "blocked", blockedReason: "等输入" }
    ]
  });
  const r = await inspectRun(runDir);
  assert.equal(r.todos.length, 4);
  assert.equal(r.summary.todosByStatus.pending, 1);
  assert.equal(r.summary.todosByStatus.done, 1);
  assert.equal(r.summary.todosByStatus.in_progress, 1);
  assert.equal(r.summary.todosByStatus.blocked, 1);
  await rm(runDir, { recursive: true, force: true });
});

// ============ checkpoints ============

test("inspectRun 读 checkpoints.jsonl", async () => {
  const runDir = makeRunDir();
  await writeJsonl(path.join(runDir, "checkpoints.jsonl"), [
    { stepId: "s1", handoff: { decisions: ["第三人称"], facts: ["主角姓陈"] } },
    { stepId: "s2", handoff: { rejected: ["上帝视角"] } }
  ]);
  const r = await inspectRun(runDir);
  assert.equal(r.checkpoints.length, 2);
  assert.equal(r.checkpoints[0].stepId, "s1");
  await rm(runDir, { recursive: true, force: true });
});

// ============ graceful 边界 ============

test("inspectRun:steps 目录存在但子 step 目录无 tool-trace 文件 → 跳过", async () => {
  const runDir = makeRunDir();
  await mkdir(path.join(runDir, "steps", "s-empty"), { recursive: true });
  const r = await inspectRun(runDir);
  assert.equal(r.steps.length, 0);
  await rm(runDir, { recursive: true, force: true });
});

// ============ 综合 ============

test("inspectRun 完整产物 timeline:steps + spawns + todos + checkpoints", async () => {
  const runDir = makeRunDir();
  // step
  await writeJsonl(
    path.join(runDir, "steps", "draft-step", "tool-trace.jsonl"),
    [{ persistedAt: "2026-01-01T00:00:00Z", stepId: "draft-step", toolCallsCount: 2,
       toolCalls: [
         { round: 0, name: "recall_handoff", args: {}, ok: true },
         { round: 1, name: "search_memory", args: { query: "偏好" }, ok: true }
       ] }]
  );
  // spawn
  const spawnDir = path.join(runDir, "spawns", "spawn_x");
  await mkdir(spawnDir, { recursive: true });
  await writeFile(path.join(spawnDir, "output.md"), "spawn 产出", "utf8");
  await writeJsonl(path.join(spawnDir, "trace.jsonl"), [
    { spawnId: "spawn_x", spawnedByStepId: "draft-step", purpose: "x", rounds: 2, completedAt: "2026-01-01" }
  ]);
  // todos
  await writeJson(path.join(runDir, "todos.json"), {
    todos: [{ id: "t1", text: "todo 1", status: "pending" }]
  });
  // checkpoints
  await writeJsonl(path.join(runDir, "checkpoints.jsonl"), [
    { stepId: "draft-step", handoff: { decisions: ["x"] } }
  ]);

  const r = await inspectRun(runDir);
  assert.equal(r.exists, true);
  assert.equal(r.summary.stepCount, 1);
  assert.equal(r.summary.totalToolCalls, 2);
  assert.equal(r.summary.spawnCount, 1);
  assert.equal(r.summary.todosByStatus.pending, 1);
  assert.equal(r.checkpoints.length, 1);
  await rm(runDir, { recursive: true, force: true });
});
