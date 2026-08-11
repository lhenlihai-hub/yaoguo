import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  parseArgs,
  resolveDataRoot,
  helpText,
  createApprovalHandler,
  ensureModelAvailable,
  isModelCommand,
  modelConfiguration,
  runModelMenu,
  formatUsage,
  isUsageCommand,
  sessionUsage,
  workspaceTaskId,
  resolveWorkspaceSelection,
  resolveSession,
  runInteractive
} = require("../src/cli/cli.js");

test("CLI 参数同时支持选项、位置任务和显式分隔符", () => {
  assert.deepEqual(parseArgs([
    "--workspace", "/tmp/work", "--project=p1", "--task", "t1", "-n", "-y", "检查", "项目"
  ]), {
    prompt: "检查 项目",
    workspace: "/tmp/work",
    dataDir: "",
    projectId: "p1",
    taskId: "t1",
    newSession: true,
    autoApprove: true,
    json: false,
    verbose: false,
    quiet: false,
    help: false,
    version: false
  });
  const separated = parseArgs(["--json", "--", "检查", "--fix"]);
  assert.equal(separated.prompt, "检查 --fix");
  assert.equal(separated.json, true);
  assert.throws(() => parseArgs(["--unknown"]), /未知参数/);
  assert.throws(() => parseArgs(["--quiet", "--verbose"]), /不能同时使用/);
});

test("CLI 格式化本轮 token、推理与缓存命中，并识别内置统计命令", async () => {
  const usage = {
    modelCalls: 3,
    promptTokens: 12345,
    completionTokens: 678,
    reasoningTokens: 120,
    cacheHitTokens: 9000,
    cacheMissTokens: 3000
  };
  assert.equal(
    formatUsage(usage, { durationMs: 12500 }),
    "本轮 3 次模型调用 · 输入 12,345 · 输出 678 · 推理 120 · 缓存命中 75%（9,000/12,000） · 12.5s"
  );
  assert.equal(isUsageCommand(" /usage "), true);
  assert.equal(isUsageCommand("/tokens"), true);
  assert.equal(isUsageCommand("usage"), false);
  assert.deepEqual(await sessionUsage({
    platformKernel: {
      tokenLedger: {
        summarizeUsage: async (scope) => ({ ...scope, ...usage })
      }
    }
  }, { project: { id: "p1" }, task: { id: "t1" } }), {
    projectId: "p1",
    taskId: "t1",
    ...usage
  });
});

test("CLI 数据目录优先使用参数，其次环境变量，最后使用用户目录", () => {
  assert.equal(resolveDataRoot({ dataDir: "/tmp/explicit" }, { YAOGUO_HOME: "/tmp/env" }, "/home/test"), "/tmp/explicit");
  assert.equal(resolveDataRoot({}, { YAOGUO_HOME: "/tmp/env" }, "/home/test"), "/tmp/env");
  assert.equal(resolveDataRoot({}, {}, "/home/test"), "/home/test/.yaoguo/runtime");
  assert.match(helpText(), /DEEPSEEK_API_KEY/);
});

test("CLI 非交互默认拒绝授权，--yes 只授权本次进程", async () => {
  const base = { interactive: false, rl: null, error: { write() {} } };
  assert.deepEqual(await createApprovalHandler({ ...base, options: { autoApprove: false } })({}), { decision: "deny" });
  assert.deepEqual(await createApprovalHandler({ ...base, options: { autoApprove: true } })({}), { decision: "allow_session" });
});

test("CLI 检查模型密钥并只持久化启用状态", async () => {
  let settings = {
    deepseek: { enabled: false, apiKeyEnv: "DEEPSEEK_API_KEY" }
  };
  const service = {
    async get() { return structuredClone(settings); },
    async mutate(operation) {
      const next = structuredClone(settings);
      await operation(next);
      settings = next;
    }
  };
  await assert.rejects(ensureModelAvailable(service, {}), /缺少 DeepSeek API Key/);
  await ensureModelAvailable(service, { DEEPSEEK_API_KEY: "local-test-key" });
  assert.equal(settings.deepseek.enabled, true);
  assert.equal("apiKey" in settings.deepseek, false);
});

test("CLI /model 选择 Flash 并通过隐藏输入保存本机 API Key", async () => {
  let settings = {
    deepseek: {
      enabled: false,
      apiKeyEnv: "DEEPSEEK_API_KEY",
      model: "deepseek-v4-pro"
    }
  };
  const settingsService = {
    async get() { return structuredClone(settings); },
    async mutate(operation) {
      const next = structuredClone(settings);
      await operation(next);
      settings = next;
      return structuredClone(settings);
    }
  };
  const answers = ["2", "sk-test-secret"];
  const output = [];
  const terminal = {
    interactive: true,
    error: { write(value) { output.push(`${value}`); } },
    readlineState: { hidden: false },
    rl: {
      history: ["sk-test-secret"],
      async question() { return answers.shift(); }
    }
  };
  const configured = await runModelMenu(settingsService, terminal, {});
  assert.equal(isModelCommand(" /MODEL "), true);
  assert.equal(configured.model, "deepseek-v4-flash");
  assert.equal(configured.keySource, "本机私有配置");
  assert.equal(settings.deepseek.enabled, true);
  assert.equal(settings.deepseek.apiKey, "sk-test-secret");
  assert.equal(terminal.readlineState.hidden, false);
  assert.deepEqual(terminal.rl.history, []);
  assert.doesNotMatch(output.join(""), /sk-test-secret/);
  assert.deepEqual(await modelConfiguration(settingsService, {}), configured);
});

test("CLI 无 API Key 仍可进入交互终端，普通消息只提示 /model", async () => {
  const output = [];
  const messages = ["你好", "/exit"];
  let modelCalls = 0;
  const terminal = {
    error: { write(value) { output.push(`${value}`); } },
    rl: { async question() { return messages.shift(); } },
    exitRequested: false
  };
  await runInteractive({
    settingsService: {
      async get() {
        return { deepseek: { model: "deepseek-v4-pro", apiKeyEnv: "DEEPSEEK_API_KEY" } };
      }
    },
    workflowEngine: {
      async submitAgentInput() { modelCalls += 1; }
    }
  }, terminal, {
    project: { id: "terminal" },
    task: { id: "task" },
    workspacePath: "/tmp/workspace"
  }, {});
  assert.equal(modelCalls, 0);
  assert.match(output.join(""), /API Key 未配置/);
  assert.match(output.join(""), /输入 \/model/);
});

test("CLI 默认按 canonical 工作空间复用稳定会话", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "yaoguo-cli-workspace-"));
  const projects = new Map();
  const tasks = new Map();
  const projectService = {
    async getProject(id) { return projects.get(id) || null; },
    async createProject(payload) {
      const project = { id: payload.id, name: payload.name };
      projects.set(project.id, project);
      return project;
    },
    async getTask(projectId, taskId) { return tasks.get(`${projectId}:${taskId}`) || null; },
    async createTask(projectId, payload) {
      const task = { id: payload.id, projectId, title: payload.title, workspacePath: "" };
      tasks.set(`${projectId}:${task.id}`, task);
      return task;
    },
    async bindTaskWorkspace(projectId, taskId, workspacePath) {
      const task = tasks.get(`${projectId}:${taskId}`);
      Object.assign(task, { workspacePath });
      return task;
    },
    async resolveTaskWorkspace(projectId, taskId) {
      const task = tasks.get(`${projectId}:${taskId}`);
      return { task, workspacePath: task.workspacePath };
    }
  };
  try {
    const canonical = await realpath(workspace);
    const first = await resolveSession({ projectService }, { workspace });
    const second = await resolveSession({ projectService }, { workspace });
    assert.equal(first.project.id, "terminal");
    assert.equal(first.task.id, workspaceTaskId(canonical));
    assert.equal(second.task.id, first.task.id);
    assert.equal(second.workspacePath, canonical);
    assert.equal(tasks.size, 1);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("CLI 从主目录启动时使用独立默认工作空间，但显式危险目录仍被拒绝", async () => {
  const testRoot = await mkdtemp(path.join(tmpdir(), "yaoguo-cli-home-"));
  const homeDirectory = path.join(testRoot, "home");
  const hostWorkspace = path.join(homeDirectory, ".yaoguo", "runtime", "workspace");
  const projectService = { paths: { workspace: hostWorkspace } };
  try {
    await mkdir(hostWorkspace, { recursive: true });
    const selection = await resolveWorkspaceSelection(
      { projectService },
      {},
      { currentDirectory: homeDirectory, homeDirectory }
    );
    assert.equal(selection.workspacePath, await realpath(path.join(homeDirectory, "Yaoguo Workspace")));
    assert.equal(selection.autoSelected, true);
    await assert.rejects(
      resolveWorkspaceSelection(
        { projectService },
        { workspace: homeDirectory },
        { currentDirectory: homeDirectory, homeDirectory }
      ),
      /--workspace 选择独立目录/
    );
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
});
