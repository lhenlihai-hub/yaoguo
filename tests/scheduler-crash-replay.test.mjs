import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const require = createRequire(import.meta.url);
const { SchedulerService } = require("../src/application/scheduler/schedulerService.js");
const { WorkflowEngine } = require("../src/application/workflows/workflowEngine.js");

test("同一计划触发在崩溃重启后复用稳定 runId，不创建第二次 Agent 执行身份", async () => {
  const root = await mkdtemp(join(tmpdir(), "yaoguo-scheduler-receipt-"));
  const jobsFile = join(root, "jobs.json");
  const scheduledFor = "2026-08-01T01:00:00.000Z";
  const job = {
    id: "job-1",
    active: true,
    projectId: "p1",
    taskId: "t1",
    topic: "日报",
    command: "生成并发布日报",
    schedule: { type: "daily", time: "09:00" },
    nextRunAt: scheduledFor
  };
  const seenRunIds = [];
  const workflowEngine = {
    startRun: async (payload) => {
      seenRunIds.push(payload.runId);
      return { run: { id: payload.runId } };
    },
    runUntilBlocked: async () => {
      throw new Error("模拟 Agent 已产生副作用后的进程崩溃");
    }
  };
  try {
    await writeFile(jobsFile, `${JSON.stringify([job])}\n`, "utf8");
    const firstProcess = new SchedulerService({ schedulesDir: root, jobsFile }, workflowEngine);
    await assert.rejects(() => firstProcess.execute(job.id), /模拟 Agent/);
    assert.deepEqual(JSON.parse(await readFile(jobsFile, "utf8")), [job], "崩溃前调度状态保持旧触发时间");

    const restartedProcess = new SchedulerService({ schedulesDir: root, jobsFile }, workflowEngine);
    await assert.rejects(() => restartedProcess.execute(job.id), /模拟 Agent/);

    assert.equal(seenRunIds.length, 2);
    assert.equal(seenRunIds[0], seenRunIds[1]);
    assert.match(seenRunIds[0], /^scheduled-[a-f0-9]{24}$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("同一调度触发并发只执行一次，旧 workflowId 不再进入规范请求或持久化", async () => {
  const root = await mkdtemp(join(tmpdir(), "yaoguo-scheduler-concurrent-"));
  const jobsFile = join(root, "jobs.json");
  let releaseRun;
  const runGate = new Promise((resolve) => { releaseRun = resolve; });
  let notifyStarted;
  const started = new Promise((resolve) => { notifyStarted = resolve; });
  const startPayloads = [];
  const job = {
    id: "job-concurrent",
    active: true,
    projectId: "p1",
    taskId: "t1",
    workflowId: "retired-custom-workflow",
    topic: "周报",
    command: "生成周报",
    schedule: { type: "daily", time: "09:00" },
    nextRunAt: "2026-08-01T01:00:00.000Z"
  };
  const workflowEngine = {
    startRun: async (payload) => {
      startPayloads.push(payload);
      notifyStarted();
      return { run: { id: payload.runId } };
    },
    runUntilBlocked: async (runId) => {
      await runGate;
      return { run: { id: runId, status: "completed" } };
    }
  };
  try {
    await writeFile(jobsFile, `${JSON.stringify([job])}\n`, "utf8");
    const service = new SchedulerService({ schedulesDir: root, jobsFile }, workflowEngine);
    service.reload = async () => {};
    const first = service.execute(job.id);
    const second = service.execute(job.id);
    await started;
    assert.equal(startPayloads.length, 1);
    assert.equal("workflowId" in startPayloads[0], false);
    releaseRun();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    assert.deepEqual(secondResult, firstResult);
    const persisted = JSON.parse(await readFile(jobsFile, "utf8"));
    assert.equal("workflowId" in persisted[0], false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("startRun 收到已存在的幂等 runId 时直接返回原状态，不再创建任务或工作流", async () => {
  const engine = Object.create(WorkflowEngine.prototype);
  const existing = {
    id: "scheduled-0123456789abcdef01234567",
    projectId: "p1",
    taskId: "t-existing",
    topic: "日报",
    command: "生成并发布日报",
    status: "interrupted"
  };
  let projectCalls = 0;
  engine.readRun = async () => existing;
  engine.getRun = async () => ({ run: existing });
  engine.projectService = {
    getProject: async () => { projectCalls += 1; throw new Error("不应创建项目运行"); }
  };

  const result = await engine._startRun({
    projectId: "p1",
    topic: "日报",
    command: "生成并发布日报",
    runId: existing.id
  });

  assert.equal(result.run, existing);
  assert.equal(projectCalls, 0);
});

test("startRun 拒绝用同一 runId 静默替换任务输入", async () => {
  const engine = Object.create(WorkflowEngine.prototype);
  const existing = {
    id: "scheduled-fedcba9876543210fedcba98",
    projectId: "p1",
    taskId: "t1",
    topic: "日报",
    command: "生成并发布日报",
    status: "interrupted"
  };
  engine.readRun = async () => existing;

  await assert.rejects(
    () => engine._startRun({
      projectId: "p1",
      taskId: "t1",
      topic: "日报",
      command: "删除日报",
      runId: existing.id
    }),
    (error) => error.code === "RUN_ID_INPUT_CONFLICT"
  );
});

test("不同调度并发完成时串行合并运行状态，不互相覆盖", async () => {
  const root = await mkdtemp(join(tmpdir(), "yaoguo-scheduler-mutation-race-"));
  const jobsFile = join(root, "jobs.json");
  const jobs = ["a", "b"].map((id) => ({
    id,
    active: true,
    projectId: "p1",
    taskId: `task-${id}`,
    topic: `任务 ${id}`,
    command: `执行 ${id}`,
    schedule: { type: "daily", time: "09:00" },
    lastRunAt: null,
    nextRunAt: `2026-08-01T0${id === "a" ? 1 : 2}:00:00.000Z`
  }));
  let started = 0;
  let releaseBoth;
  const bothStarted = new Promise((resolve) => { releaseBoth = resolve; });
  const workflowEngine = {
    startRun: async (payload) => {
      started += 1;
      if (started === 2) releaseBoth();
      await bothStarted;
      return { run: { id: payload.runId } };
    },
    runUntilBlocked: async (runId) => ({ run: { id: runId, status: "completed" } })
  };
  try {
    await writeFile(jobsFile, `${JSON.stringify(jobs)}\n`, "utf8");
    const service = new SchedulerService({ schedulesDir: root, jobsFile }, workflowEngine);
    service.reload = async () => {};
    await Promise.all(jobs.map((job) => service.execute(job.id)));
    const persisted = JSON.parse(await readFile(jobsFile, "utf8"));
    assert.equal(persisted.length, 2);
    assert.equal(persisted.every((job) => Boolean(job.lastRunAt)), true);
    assert.equal(persisted.every((job) => job.nextRunAt !== jobs.find((row) => row.id === job.id).nextRunAt), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stop 期间完成的调度不会重新挂载定时器", async () => {
  const root = await mkdtemp(join(tmpdir(), "yaoguo-scheduler-stop-race-"));
  const jobsFile = join(root, "jobs.json");
  const job = {
    id: "stop-race",
    active: true,
    projectId: "p1",
    taskId: "t1",
    topic: "停止竞态",
    command: "执行",
    schedule: { type: "daily", time: "09:00" },
    lastRunAt: null,
    nextRunAt: "2026-08-01T01:00:00.000Z"
  };
  let notifyStarted;
  let releaseRun;
  const started = new Promise((resolve) => { notifyStarted = resolve; });
  const gate = new Promise((resolve) => { releaseRun = resolve; });
  const workflowEngine = {
    startRun: async (payload) => {
      notifyStarted();
      return { run: { id: payload.runId } };
    },
    runUntilBlocked: async (runId) => {
      await gate;
      return { run: { id: runId, status: "completed" } };
    }
  };
  try {
    await writeFile(jobsFile, `${JSON.stringify([job])}\n`, "utf8");
    const service = new SchedulerService({ schedulesDir: root, jobsFile }, workflowEngine);
    const execution = service.execute(job.id);
    await started;
    const stopping = service.stop();
    releaseRun();
    await Promise.all([execution, stopping]);
    assert.equal(service.accepting, false);
    assert.equal(service.timers.size, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
