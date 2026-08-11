import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const require = createRequire(import.meta.url);
const { WorkflowEngine } = require("../src/application/workflows/workflowEngine.js");
const { RunStore } = require("../src/platform/runs/runStore.js");
const { TaskSessionStore } = require("../src/platform/sessions/taskSessionStore.js");
const { createPaths } = require("../src/platform/storage/workspaceRuntime.js");

test("WorkflowEngine 支持注入 runStore 与 artifactStore，方便核心逻辑单测", () => {
  const runStore = { injected: "run" };
  const artifactStore = { injected: "artifact" };
  const engine = new WorkflowEngine({
    paths: { workflowsDir: mkdtempSync(join(tmpdir(), "yaoguo-workflows-")) },
    runStore,
    artifactStore
  });

  assert.equal(engine.runStore, runStore);
  assert.equal(engine.artifactStore, artifactStore);
});

test("WorkflowEngine 缺少 paths 时显式失败，而不是在构造深处抛隐晦错误", () => {
  assert.throws(
    () => new WorkflowEngine(),
    /缺少 paths 依赖/
  );
});

test("agent-default 只从全局真相源加载，不再接受工作流选择", async () => {
  const engine = new WorkflowEngine({
    paths: { workflowsDir: join(process.cwd(), "workspace", "workflows") }
  });

  const workflow = await engine.loadAgentWorkflow();
  assert.equal(workflow.id, "agent-default");
  assert.equal(workflow.name, "通用 Agent");
  assert.equal(engine.loadWorkflow, undefined);
});

test("listRuns 是只读操作，不为没有运行记录的任务创建 runs 目录", async () => {
  const root = mkdtempSync(join(tmpdir(), "yaoguo-list-runs-"));
  const runsDir = join(root, "legacy-runs");
  const taskDir = join(root, "projects", "p1", "tasks", "t1");
  const engine = new WorkflowEngine({
    paths: { workflowsDir: root, runsDir },
    runStore: { listRuns: async () => [] },
    projectService: {
      listProjects: async () => [{ id: "p1" }],
      listTasks: async () => [{ id: "t1" }],
      getTaskDir: () => taskDir
    }
  });

  const rows = await engine.listRuns();
  assert.deepEqual(rows, []);
  assert.equal(existsSync(join(taskDir, "runs")), false);
  assert.equal(existsSync(runsDir), false);
});

test("readRun 不再通过 listRuns 全量扫描所有项目任务", async () => {
  const root = mkdtempSync(join(tmpdir(), "yaoguo-read-run-"));
  let listProjectsCalled = 0;
  const engine = new WorkflowEngine({
    paths: { workflowsDir: root, runsDir: join(root, "runs") },
    runStore: { loadRunById: async () => null },
    projectService: {
      listProjects: async () => {
        listProjectsCalled += 1;
        return [];
      }
    }
  });

  await assert.rejects(() => engine.readRun("missing-run"), /找不到运行记录/);
  assert.equal(listProjectsCalled, 0);
});

test("readRun 在调用存储层前拒绝 runId 路径穿越", async () => {
  const root = mkdtempSync(join(tmpdir(), "yaoguo-read-run-scope-"));
  let storeCalled = 0;
  const engine = new WorkflowEngine({
    paths: { workflowsDir: root, runsDir: join(root, "runs") },
    runStore: {
      loadRunById: async () => {
        storeCalled += 1;
        return null;
      }
    }
  });

  await assert.rejects(
    () => engine.readRun("../../config/settings"),
    (error) => error.code === "PATH_SEGMENT_INVALID"
  );
  assert.equal(storeCalled, 0);
});

test("旧 parallelGroup 被迁移为串行，单一 task actor 不启动并发 Agent", () => {
  const engine = new WorkflowEngine({
    paths: { workflowsDir: mkdtempSync(join(tmpdir(), "yaoguo-parallel-")) }
  });
  const legacy = engine.prepareWorkflowForRun({ steps: [
    { id: "memory", index: 0, taskType: "memory", parallelGroup: "setup" },
    { id: "research", index: 1, taskType: "research", parallelGroup: "setup" }
  ] });
  assert.ok(legacy.steps.every((step) => !("parallelGroup" in step)));
  assert.deepEqual(engine.pickRunnableBatch(legacy.steps).map((step) => step.id), ["memory"]);
});

test("executeStep 从任务会话组装历史并交给同一个 Agent", async () => {
  const engine = Object.create(WorkflowEngine.prototype);
  let captured = null;
  engine.buildRunContext = async () => "";
  engine.loadLatestDeliverable = async () => null;
  engine.settingsService = { get: async () => ({ context: { agentHistory: {} } }) };
  engine.listAgentMessageWindow = async () => ({
    rows: [{ role: "user", content: "给董事会看，保留三组对比数据。", turnId: "turn-previous" }],
    total: 1
  });
  engine._executeAgent = async (payload) => {
    captured = payload.runTaskArgs;
    return {
      text: "交付结果",
      artifacts: [{
        title: "报告",
        absolute: "/tmp/final/report.md",
        relative: "final/report.md",
        source: "agent-publish",
        sha256: "a".repeat(64),
        content: "不应复制进 run.json 的正文"
      }],
      blocked: false
    };
  };
  const state = {
    id: "r1",
    projectId: "p1",
    taskId: "t1",
    command: "按刚才要求完成",
    taskBrief: "制作对比报告",
    topic: "季度对比"
  };
  const step = {
    id: "01-agent-delivery",
    title: "Agent 完整交付",
    taskType: "agent",
    tools: null,
    instruction: "完成交付"
  };

  const result = await engine.executeStep(state, step);

  assert.match(captured.runContext, /任务历史/);
  assert.match(captured.runContext, /给董事会看/);
  assert.match(captured.runContext, /三组对比数据/);
  assert.equal(captured.input, state.command);
  assert.equal("memoryQuery" in captured, false);
  assert.equal("memoryFiles" in captured, false);
  assert.equal("memoryTopK" in captured, false);
  assert.equal(result.files[0].absolute, "/tmp/final/report.md");
  assert.equal(result.files[0].sha256, "a".repeat(64));
  assert.equal("content" in result.files[0], false, "run 状态只保存成品引用，不复制正文");
});

test("超长 workflow 输入与任务消息复用内容寻址正文，run.json 只保存引用", async () => {
  const root = mkdtempSync(join(tmpdir(), "yaoguo-run-command-ref-"));
  const paths = createPaths(root);
  const projectService = {
    getTaskDir: (projectId, taskId) => join(paths.projectsDir, projectId, "tasks", taskId)
  };
  const taskSessionStore = new TaskSessionStore({ projectService });
  const engine = new WorkflowEngine({
    paths,
    projectService,
    taskSessionStore,
    runStore: new RunStore(paths)
  });
  const command = `超长运行输入\n${"完整正文".repeat(20000)}\n尾部校验`;
  const state = {
    id: "run-large-input",
    projectId: "p1",
    taskId: "t1",
    topic: "大输入",
    command,
    status: "pending",
    steps: []
  };

  await engine.writeRun(state);
  await taskSessionStore.appendMessage({
    projectId: "p1",
    taskId: "t1",
    turnId: "run:run-large-input",
    runId: "run-large-input",
    role: "user",
    content: command
  });
  const runFile = join(
    projectService.getTaskDir("p1", "t1"),
    "runs",
    "run-large-input",
    "run.json"
  );
  const raw = JSON.parse(await readFile(runFile, "utf8"));
  assert.equal(raw.command, undefined);
  assert.equal(raw.commandRef.storage, "task-session-content");
  const bodyFile = taskSessionStore.getContentBodyFile("p1", "t1", raw.commandRef.sha256);
  assert.equal(await readFile(bodyFile, "utf8"), command);
  const rawEvent = JSON.parse((await readFile(taskSessionStore.getEventsFile("p1", "t1"), "utf8")).trim());
  assert.equal(rawEvent.content, undefined);
  assert.equal(rawEvent.contentRef.sha256, raw.commandRef.sha256);
  assert.equal((await engine.readRun("run-large-input")).command, command);
  const presentation = await engine.getRun("run-large-input");
  assert.equal(presentation.run.command, "");
  assert.equal(presentation.run.commandExternalized, true);
});

test("runNextStep 执行中撤回不会被旧 state 写回覆盖", async () => {
  const root = mkdtempSync(join(tmpdir(), "yaoguo-cancel-run-"));
  const runDir = join(root, "runs", "r1");
  let state = {
    id: "r1",
    projectId: "p1",
    taskId: "t1",
    runDir,
    status: "pending",
    steps: [
      { id: "draft", index: 0, title: "初稿", taskType: "draft", status: "pending", outputFile: "draft.md" }
    ]
  };
  const clone = (value) => JSON.parse(JSON.stringify(value));
  let activeSignal = null;
  const assistantMessages = [];
  const engine = Object.create(WorkflowEngine.prototype);
  engine.paths = { workflowsDir: root, runsDir: join(root, "runs") };
  engine.readRun = async () => clone(state);
  engine.writeRun = async (next) => { state = clone(next); };
  engine.getRun = async () => ({ run: clone(state) });
  engine.getReadySteps = (current) => current.steps.filter((step) => step.status === "pending");
  engine.pickRunnableBatch = (steps) => [steps[0]];
  engine.pendingDecisionCards = () => [];
  engine.savePlatformStepState = async () => {};
  engine.recordRunEvent = async () => {};
  engine.emitActivity = () => {};
  engine.appendAgentMessage = async (entry) => { assistantMessages.push(entry); };
  engine.executeStep = async (_current, _step, { signal } = {}) => {
    activeSignal = signal;
    assert.equal(signal?.aborted, false);
    await engine.cancelRun("r1", { reason: "test-cancel" });
    assert.equal(signal?.aborted, true);
    return { text: "这段输出不应在撤回后落盘。", files: [] };
  };
  engine.cleanStepResultText = (_step, text) => text;
  engine.savePlatformStepArtifact = async () => {};
  engine.ensureRunArtifact = async () => null;

  const result = await engine.runNextStep("r1");

  assert.equal(result.run.status, "cancelled");
  assert.equal(state.status, "cancelled");
  assert.equal(activeSignal?.aborted, true);
  assert.deepEqual(assistantMessages.map((entry) => [entry.content, entry.status, entry.stopCode]), [
    ["已停止当前任务。", "cancelled", "AGENT_EXECUTION_CANCELLED"]
  ]);
  await assert.rejects(() => readFile(join(runDir, "draft.md"), "utf8"));
});
