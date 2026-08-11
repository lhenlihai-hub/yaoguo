// 开机自愈 + 显式恢复：未开始的 pending step 可续跑，已开始的 running step 必须 fail closed。

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { WorkflowEngine } = require("../src/application/workflows/workflowEngine.js");
const { RunStore } = require("../src/platform/runs/runStore.js");

test("reconcileInterruptedRuns：残留 running step 标记执行中断，不复位为 pending", async () => {
  const engine = Object.create(WorkflowEngine.prototype);
  const saved = [];
  engine.projectService = { listProjects: async () => [{ id: "p1" }] };
  engine.listRuns = async () => [
    { id: "r1", status: "running" },
    { id: "r2", status: "completed" }
  ];
  engine.readRun = async (id) => (id === "r1"
    ? { id: "r1", status: "running", steps: [{ status: "running" }, { status: "pending" }] }
    : null);
  engine.writeRun = async (s) => { saved.push(s); };

  const res = await engine.reconcileInterruptedRuns();
  assert.equal(res.reconciled, 1, "只处理 running/pending 的 run");
  assert.equal(saved.length, 1);
  assert.equal(saved[0].status, "interrupted");
  assert.equal(saved[0].steps[0].status, "failed", "已开始步骤不得复位后自动重放");
  assert.equal(saved[0].steps[0].stopCode, "AGENT_EXECUTION_INTERRUPTED");
  assert.match(saved[0].steps[0].error, /不会自动重试/);
  assert.ok(saved[0].interruptedAt);
});

test("resumeRun：执行终态不确定的 step 保持 interrupted，不进入 runUntilBlocked", async () => {
  const engine = Object.create(WorkflowEngine.prototype);
  const saved = [];
  let ranCalled = false;
  engine.readRun = async () => ({
    id: "r-interrupted",
    status: "interrupted",
    steps: [{ id: "agent", status: "running" }]
  });
  engine.writeRun = async (state) => { saved.push(state); };
  engine.getRun = async () => ({ run: saved.at(-1) });
  engine.runUntilBlocked = async () => { ranCalled = true; };

  const result = await engine.resumeRun("r-interrupted");

  assert.equal(ranCalled, false);
  assert.equal(result.run.status, "interrupted");
  assert.equal(result.run.steps[0].status, "failed");
  assert.equal(result.run.steps[0].stopCode, "AGENT_EXECUTION_INTERRUPTED");
});

test("resumeRun：有未完步骤 → 置 pending 并续跑", async () => {
  const engine = Object.create(WorkflowEngine.prototype);
  const saved = [];
  let ranId = null;
  engine.readRun = async () => ({ id: "r1", status: "interrupted", steps: [{ status: "pending" }] });
  engine.writeRun = async (s) => { saved.push(s); };
  engine.runUntilBlocked = async (id) => { ranId = id; return { run: { id, status: "running" } }; };
  engine.getRun = async (id) => ({ run: { id, status: "completed" } });

  await engine.resumeRun("r1");
  assert.equal(saved[0].status, "pending");
  assert.equal(ranId, "r1", "应调用 runUntilBlocked 续跑");
});

test("resumeRun：没有未完步骤 → 直接置完成，不续跑", async () => {
  const engine = Object.create(WorkflowEngine.prototype);
  const saved = [];
  let ranCalled = false;
  engine.readRun = async () => ({ id: "r2", status: "interrupted", steps: [{ status: "completed" }] });
  engine.writeRun = async (s) => { saved.push(s); };
  engine.runUntilBlocked = async () => { ranCalled = true; };
  engine.getRun = async (id) => ({ run: { id, status: "completed" } });

  await engine.resumeRun("r2");
  assert.equal(ranCalled, false, "无可续步骤不应续跑");
  assert.equal(saved[0].status, "completed");
});

test("listRuns/readRun：新索引为空时发现旧项目 run，并迁移退役 taskType", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "yaoguo-legacy-run-"));
  const taskDir = path.join(root, "projects", "p1", "tasks", "t1");
  const runDir = path.join(taskDir, "runs", "r-old");
  const legacyRun = {
    id: "r-old",
    projectId: "p1",
    taskId: "t1",
    runDir,
    status: "completed",
    createdAt: "2025-01-01T00:00:00.000Z",
    steps: [{ id: "clean", taskType: "deAI", status: "completed" }],
    workflowManifest: {
      id: "legacy-workflow",
      steps: [{ id: "clean", taskType: "deAI" }]
    }
  };
  try {
    await mkdir(runDir, { recursive: true });
    await writeFile(path.join(runDir, "run.json"), JSON.stringify(legacyRun), "utf8");
    const engine = Object.create(WorkflowEngine.prototype);
    engine.paths = {
      workspace: root,
      projectsDir: path.join(root, "projects"),
      privateDir: path.join(root, "private"),
      runsDir: path.join(root, "runs")
    };
    engine.runStore = new RunStore(engine.paths);
    engine.projectService = {
      getProject: async () => ({ id: "p1" }),
      listProjects: async () => [{ id: "p1" }],
      getTask: async () => ({ id: "t1" }),
      listTasks: async () => [{ id: "t1" }],
      getTaskDir: () => taskDir
    };

    const listed = await engine.listRuns("p1", "t1");
    assert.equal(listed.length, 1);
    assert.equal(listed[0].steps[0].taskType, "revise");

    const loaded = await engine.readRun("r-old");
    assert.equal(loaded.steps[0].taskType, "revise");
    assert.equal(loaded.workflowManifest.steps[0].taskType, "revise");

    const index = JSON.parse(await readFile(path.join(root, "private", "run-index.json"), "utf8"));
    assert.equal(index.runs[0].id, "r-old", "发现旧 run 后应补进新索引");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
