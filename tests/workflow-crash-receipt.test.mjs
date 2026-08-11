import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const require = createRequire(import.meta.url);
const { WorkflowEngine } = require("../src/application/workflows/workflowEngine.js");
const { TaskSessionStore } = require("../src/platform/sessions/taskSessionStore.js");
const {
  beginWorkflowStepExecution,
  ensureWorkflowStepExecutionIdentity
} = require("../src/application/agent/workflowStepExecution.js");

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createHarness(root, sessionStore) {
  const runDir = join(root, "projects", "p1", "tasks", "t1", "runs", "r1");
  let persisted = {
    id: "r1",
    projectId: "p1",
    taskId: "t1",
    topic: "安全执行",
    command: "生成并发布报告",
    runDir,
    status: "pending",
    steps: [{
      id: "01-agent-delivery",
      index: 0,
      title: "Agent 完整交付",
      instruction: "完成当前请求",
      outputFile: "outputs/result.md",
      status: "pending"
    }]
  };
  const engine = Object.create(WorkflowEngine.prototype);
  engine.taskSessionStore = sessionStore;
  engine.readRun = async () => clone(persisted);
  engine.writeRun = async (state) => { persisted = clone(state); };
  engine.getRun = async () => ({ run: clone(persisted) });
  engine.getReadySteps = (state) => state.steps.filter((step) => ["pending", "blocked"].includes(step.status));
  engine.pickRunnableBatch = (steps) => [steps[0]];
  engine.pendingDecisionCards = () => [];
  engine.runBlockingDecisionCards = () => [];
  engine.savePlatformStepState = async () => null;
  engine.savePlatformStepArtifact = async () => null;
  engine.recordRunEvent = async () => null;
  engine.emitActivity = () => {};
  engine.cleanStepResultText = (_step, text) => text;
  engine.buildFallbackHandoff = () => ({});
  engine.applyHandoffToState = async () => null;
  engine.appendStepCheckpoint = async () => null;
  engine.ensureRunArtifact = async () => null;
  engine.appendAgentMessage = async () => null;
  engine.stripInternalDisclosure = (text) => text;
  return {
    engine,
    getState: () => clone(persisted),
    setState: (state) => { persisted = clone(state); },
    runDir
  };
}

test("工作流 Agent 在工具副作用前同步 started receipt，运行状态提交后才写终态", async () => {
  const root = await mkdtemp(join(tmpdir(), "yaoguo-workflow-receipt-"));
  const projectService = {
    getTaskDir: (projectId, taskId) => join(root, "projects", projectId, "tasks", taskId)
  };
  const sessionStore = new TaskSessionStore({ projectService });
  const harness = createHarness(root, sessionStore);
  let sideEffects = 0;
  const outcomeReceiptStates = [];
  try {
    await mkdir(join(harness.runDir, "outputs"), { recursive: true });
    harness.engine.appendAgentMessage = async (entry) => {
      const receipt = await sessionStore.findTurnExecution({
        projectId: entry.projectId,
        taskId: entry.taskId,
        turnId: entry.turnId
      });
      outcomeReceiptStates.push(receipt.state);
      return sessionStore.appendMessage(entry);
    };
    harness.engine.executeStep = async (state, step) => {
      const receipt = await sessionStore.findTurnExecution({
        projectId: state.projectId,
        taskId: state.taskId,
        turnId: step.agentExecution.turnId
      });
      assert.equal(receipt.state, "interrupted", "executeStep 前 started receipt 必须已经 sync");
      sideEffects += 1;
      return { text: "报告已完成", files: [] };
    };

    const result = await harness.engine.runNextStep("r1");
    const state = harness.getState();
    const receipt = await sessionStore.findTurnExecution({
      projectId: "p1",
      taskId: "t1",
      turnId: state.steps[0].agentExecution.turnId
    });

    assert.equal(sideEffects, 1);
    assert.equal(result.run.status, "completed");
    assert.equal(receipt.state, "terminal");
    assert.equal(receipt.terminal.status, "completed");
    assert.deepEqual(outcomeReceiptStates, ["interrupted"], "assistant outcome 必须先于 terminal receipt 提交");
    const messages = await sessionStore.listMessages({ projectId: "p1", taskId: "t1" });
    assert.deepEqual(messages.map((row) => [row.role, row.content, row.status]), [
      ["assistant", "报告已完成", "completed"]
    ]);
    assert.equal(await readFile(join(harness.runDir, "outputs", "result.md"), "utf8"), "报告已完成");
    const events = await readFile(sessionStore.getEventsFile("p1", "t1"), "utf8");
    assert.equal(events.includes("生成并发布报告"), false, "receipt 只能保存输入摘要，不能复制用户正文");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("工作流 assistant outcome 写入失败时中断终态提交，不得吞错或伪造 terminal receipt", async () => {
  const root = await mkdtemp(join(tmpdir(), "yaoguo-workflow-outcome-failure-"));
  const projectService = {
    getTaskDir: (projectId, taskId) => join(root, "projects", projectId, "tasks", taskId)
  };
  const sessionStore = new TaskSessionStore({ projectService });
  const harness = createHarness(root, sessionStore);
  const activities = [];
  try {
    await mkdir(join(harness.runDir, "outputs"), { recursive: true });
    harness.engine.executeStep = async () => ({ text: "已经产生副作用的结果", files: [] });
    harness.engine.appendAgentMessage = async () => {
      throw Object.assign(new Error("session fsync failed"), { code: "SESSION_FSYNC_FAILED" });
    };
    harness.engine.emitActivity = (event) => activities.push(event.status);

    await assert.rejects(
      () => harness.engine.runNextStep("r1"),
      (error) => error.code === "AGENT_OUTCOME_PERSIST_FAILED"
        && error.cause?.code === "SESSION_FSYNC_FAILED"
    );

    const state = harness.getState();
    assert.equal(state.status, "interrupted");
    assert.equal(state.steps[0].status, "failed");
    assert.equal(state.steps[0].stopCode, "AGENT_OUTCOME_PERSIST_FAILED");
    assert.match(state.steps[0].error, /不会自动重试/);
    assert.equal(activities.includes("run_completed"), false);
    assert.equal(activities.at(-1), "interrupted");
    const receipt = await sessionStore.findTurnExecution({
      projectId: "p1",
      taskId: "t1",
      turnId: state.steps[0].agentExecution.turnId
    });
    assert.equal(receipt.state, "interrupted", "outcome 缺失时不得写 terminal receipt");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workflow 阻塞与失败终态复用统一 outcome 持久化，并与各自 receipt 身份对齐", async (t) => {
  for (const scenario of [
    {
      name: "historical blocked",
      taskType: "draft",
      execute: async () => ({
        text: "需要用户补充资料",
        message: "需要用户补充资料",
        blocked: true,
        stopCode: "AGENT_INPUT_REQUIRED",
        files: []
      }),
      runStatus: "blocked",
      receiptStatus: "blocked",
      messageStatus: "blocked",
      stopCode: "AGENT_INPUT_REQUIRED"
    },
    {
      name: "canonical failed",
      taskType: "agent",
      execute: async () => {
        throw Object.assign(new Error("模型服务不可用"), { code: "MODEL_UNAVAILABLE" });
      },
      runStatus: "blocked",
      receiptStatus: "failed",
      messageStatus: "blocked",
      stopCode: "MODEL_UNAVAILABLE"
    }
  ]) {
    await t.test(scenario.name, async () => {
      const root = await mkdtemp(join(tmpdir(), "yaoguo-workflow-terminal-"));
      const projectService = {
        getTaskDir: (projectId, taskId) => join(root, "projects", projectId, "tasks", taskId)
      };
      const sessionStore = new TaskSessionStore({ projectService });
      const harness = createHarness(root, sessionStore);
      try {
        await mkdir(join(harness.runDir, "outputs"), { recursive: true });
        const state = harness.getState();
        state.steps[0].taskType = scenario.taskType;
        harness.setState(state);
        harness.engine.executeStep = scenario.execute;
        harness.engine.appendAgentMessage = (entry) => sessionStore.appendMessage(entry);

        const result = await harness.engine.runNextStep("r1");
        const terminalState = harness.getState();
        const turnId = terminalState.steps[0].agentExecution.turnId;
        const receipt = await sessionStore.findTurnExecution({
          projectId: "p1", taskId: "t1", turnId
        });
        const messages = await sessionStore.listMessages({ projectId: "p1", taskId: "t1" });

        assert.equal(result.run.status, scenario.runStatus);
        assert.equal(receipt.state, "terminal");
        assert.equal(receipt.terminal.status, scenario.receiptStatus);
        assert.equal(receipt.terminal.stopCode, scenario.stopCode);
        assert.equal(messages.length, 1);
        assert.equal(messages[0].turnId, turnId);
        assert.equal(messages[0].status, scenario.messageStatus);
        assert.equal(messages[0].stopCode, scenario.stopCode);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

test("崩溃遗留 started receipt 后，即使 run state 被复位 pending 也不会重放 Agent 副作用", async () => {
  const root = await mkdtemp(join(tmpdir(), "yaoguo-workflow-crash-"));
  const projectService = {
    getTaskDir: (projectId, taskId) => join(root, "projects", projectId, "tasks", taskId)
  };
  const sessionStore = new TaskSessionStore({ projectService });
  const harness = createHarness(root, sessionStore);
  let sideEffects = 0;
  try {
    const state = harness.getState();
    const step = state.steps[0];
    ensureWorkflowStepExecutionIdentity(state, step);
    const started = await beginWorkflowStepExecution({ taskSessionStore: sessionStore }, state, step);
    assert.equal(started.state, "started");
    step.status = "pending";
    state.status = "pending";
    harness.setState(state);
    harness.engine.executeStep = async () => {
      sideEffects += 1;
      return { text: "不应执行", files: [] };
    };

    const result = await harness.engine.runUntilBlocked("r1");

    assert.equal(sideEffects, 0);
    assert.equal(result.run.status, "interrupted");
    assert.equal(result.run.steps[0].status, "failed");
    assert.equal(result.run.steps[0].stopCode, "AGENT_EXECUTION_INTERRUPTED");
    assert.match(result.run.steps[0].error, /不会自动重试/);
    const receipt = await sessionStore.findTurnExecution({
      projectId: "p1",
      taskId: "t1",
      turnId: result.run.steps[0].agentExecution.turnId
    });
    assert.equal(receipt.state, "interrupted", "不确定执行不能伪造终态 receipt");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
