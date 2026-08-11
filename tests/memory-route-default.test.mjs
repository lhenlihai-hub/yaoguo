import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";

const require = createRequire(import.meta.url);
const { WorkflowEngine } = require("../src/application/workflows/workflowEngine");

test("canonical Agent run 不创建历史 memoryRoute 或 state.md", async () => {
  const root = mkdtempSync(join(tmpdir(), "yaoguo-canonical-run-"));
  const taskDir = join(root, "projects", "p1", "tasks", "t1");
  const runDir = join(taskDir, "runs", "r1");
  const engine = Object.create(WorkflowEngine.prototype);
  engine.paths = { workflowsDir: join(root, "workflows"), runsDir: join(root, "runs") };
  engine.projectService = {
    getProject: async () => ({
      id: "p1",
      name: "测试项目",
      type: "general"
    }),
    getTask: async () => ({
      id: "t1",
      title: "测试任务",
      brief: ""
    }),
    getTaskDir: () => taskDir,
    updateTask: async () => {},
  };
  engine.runStore = {
    createRunId: () => "r1",
    ensureRunDirs: async () => runDir,
    saveStepManifest: async () => null,
    appendEvent: async () => null
  };
  engine.loadAgentWorkflow = async () => ({
    id: "agent-default",
    name: "通用 Agent",
    steps: [{ id: "01-agent-delivery", taskType: "agent", tools: "agent" }]
  });
  engine.findActiveRunForTask = async () => null;
  engine.scheduleAutoNameFromFirstMessage = () => {};
  engine.appendAgentMessage = async () => null;
  engine.getRun = async () => ({
    run: JSON.parse(await readFile(join(runDir, "run.json"), "utf8"))
  });

  try {
    const result = await engine._startRun({
      projectId: "p1",
      taskId: "t1",
      topic: "统一 Agent",
      command: "完成用户请求"
    });

    assert.equal("memoryRoute" in result.run, false);
    assert.equal(existsSync(join(runDir, "state.md")), false);
    const persisted = JSON.parse(await readFile(join(runDir, "run.json"), "utf8"));
    assert.equal("memoryRoute" in persisted, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
