import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  parseArgs,
  resolveDataRoot,
  openLocalPathWithSystem,
  helpText,
  createApprovalHandler,
  ensureModelAvailable,
  isModelCommand,
  modelConfiguration,
  runModelMenu,
  permissionConfiguration,
  runPermissionMenu,
  formatUsage,
  formatTuiUsage,
  isUsageCommand,
  sessionUsage,
  workspaceTaskId,
  resolveWorkspaceSelection,
  resolveSession,
  createNewSession,
  runResumeMenu,
  resolveExplicitOutputTargets,
  resolveExplicitOpenTargets,
  runTurn,
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
    cacheMissTokens: 3000,
    currentContextTokens: 120000,
    contextWindowTokens: 1000000,
    contextUsageRatio: 0.12
  };
  assert.equal(
    formatUsage(usage, { durationMs: 12500 }),
    "本轮 3 次模型调用 · 输入 12,345 · 输出 678 · 推理 120 · 缓存命中 75%（9,000/12,000） · 上下文 12%（120k/1.0m） · 12.5s"
  );
  assert.equal(isUsageCommand(" /usage "), true);
  assert.equal(isUsageCommand("/tokens"), true);
  assert.equal(isUsageCommand("usage"), false);
  assert.equal(formatTuiUsage(usage), "缓存 75% · 上下文 12%");
  const sessionUsageWithBackground = {
    ...usage,
    modelCalls: 5,
    foreground: { ...usage, modelCalls: 3 },
    background: {
      modelCalls: 2,
      cacheHitTokens: 100,
      cacheMissTokens: 900
    }
  };
  assert.equal(
    formatUsage(sessionUsageWithBackground, { label: "会话累计" }),
    "会话累计 5 次模型调用 · 输入 12,345 · 输出 678 · 推理 120 · 前台缓存 75%（9,000/12,000） · 上下文 12%（120k/1.0m） · 后台 2 次，缓存 10%"
  );
  assert.equal(formatTuiUsage(sessionUsageWithBackground), "缓存 75% · 上下文 12%");
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
  assert.match(helpText(), /\/clear/);
  assert.match(helpText(), /\/resume/);
  assert.match(helpText(), /All agree/);
  assert.doesNotMatch(helpText(), /^  \/tokens/m);
  assert.match(helpText(), /Shift\+Enter/);
});

test("CLI 本地打开宿主使用系统命令与参数数组，不经过 shell", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "yaoguo-cli-open-"));
  const file = path.join(root, "带 空格.md");
  const calls = [];
  try {
    await writeFile(file, "ok", "utf8");
    const result = await openLocalPathWithSystem(file, {
      platform: "darwin",
      spawnProcess(command, args, options) {
        calls.push({ command, args, options });
        const child = new EventEmitter();
        child.unref = () => {};
        queueMicrotask(() => child.emit("spawn"));
        return child;
      }
    });
    assert.equal(result.ok, true);
    assert.equal(calls[0].command, "open");
    assert.deepEqual(calls[0].args, [await realpath(file)]);
    assert.deepEqual(calls[0].options, { detached: true, stdio: "ignore" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI 非交互默认拒绝授权，--yes 只授权本次进程", async () => {
  const base = { interactive: false, rl: null, error: { write() {} } };
  assert.deepEqual(await createApprovalHandler({ ...base, options: { autoApprove: false } })({}), { decision: "deny" });
  assert.deepEqual(await createApprovalHandler({ ...base, options: { autoApprove: true } })({}), { decision: "allow_session" });
});

test("CLI TUI 在界内显示完整授权边界并只返回允许的选择", async () => {
  let dialog;
  const handler = createApprovalHandler({
    interactive: true,
    options: { autoApprove: false },
    ui: {
      async choose(value) {
        dialog = value;
        return "allow_once";
      }
    }
  });
  assert.deepEqual(await handler({
    summary: "写入文件",
    target: "/tmp/work/report.md",
    boundary: "仅当前工作空间",
    allowedDecisions: ["allow_once", "deny"]
  }), { decision: "allow_once" });
  assert.match(dialog.description, /仅当前工作空间/);
  assert.deepEqual(dialog.items.map((item) => item.value), ["allow_once", "deny"]);
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

test("CLI TUI /model 通过选择器与密钥弹层完成配置", async () => {
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
  const notices = [];
  const terminal = {
    ui: {
      async choose() { return "flash"; },
      async promptSecret() { return "sk-tui-secret"; },
      addSuccess(message) { notices.push(message); },
      updateModel(model) { notices.push(model.modelLabel); }
    }
  };
  const configured = await runModelMenu(settingsService, terminal, {});
  assert.equal(configured.model, "deepseek-v4-flash");
  assert.equal(configured.available, true);
  assert.equal(settings.deepseek.apiKey, "sk-tui-secret");
  assert.deepEqual(notices, [
    "API Key 已保存到本机私有配置。",
    "Flash",
    "已选择 Flash。"
  ]);
});

test("CLI TUI /model 会把思考强度写入真实 DeepSeek 配置", async () => {
  let settings = {
    deepseek: {
      enabled: true,
      apiKey: "sk-local",
      apiKeyEnv: "DEEPSEEK_API_KEY",
      model: "deepseek-v4-pro",
      thinking: "max"
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
  const choices = ["thinking", "high"];
  const updates = [];
  const configured = await runModelMenu(settingsService, {
    ui: {
      async choose() { return choices.shift(); },
      async promptSecret() { throw new Error("不应询问 API Key"); },
      addSuccess(message) { updates.push(message); },
      updateModel(model) { updates.push(model.thinkingLabel); }
    }
  }, {});
  assert.equal(configured.thinking, "high");
  assert.equal(settings.deepseek.thinking, "high");
  assert.deepEqual(updates, ["High", "思考强度已设为 High。"]);
});

test("CLI 授权菜单真实切换 Ask 与 All agree", async () => {
  let mode = "ask";
  const settingsService = {
    async get() { return { permissions: { agent: { mode } } }; },
    async setAgentPermissionMode(next) { mode = next; }
  };
  const updates = [];
  const terminal = {
    options: { autoApprove: false },
    ui: {
      async choose() { return "allow"; },
      updatePermissionMode(label) { updates.push(label); },
      addSuccess(message) { updates.push(message); }
    }
  };
  const configured = await runPermissionMenu(settingsService, terminal);
  assert.deepEqual(configured, { mode: "allow", label: "All agree" });
  assert.deepEqual(await permissionConfiguration(settingsService, terminal), configured);
  assert.equal(mode, "allow");
  assert.equal(terminal.options.autoApprove, true);
  assert.deepEqual(updates, ["All agree", "授权模式已切换为 All agree。"]);
});

test("CLI /resume 可打开历史会话并恢复对话与 usage", async () => {
  const tasks = [
    { id: "t1", title: "当前会话", workspacePath: "/tmp/work", updatedAt: "2026-08-12T00:00:00.000Z" },
    { id: "t2", title: "历史会话", workspacePath: "/tmp/work", updatedAt: "2026-08-11T00:00:00.000Z" }
  ];
  const choices = ["t2", "open"];
  const events = [];
  const services = {
    projectService: {
      async listTasks() { return tasks; },
      async resolveTaskWorkspace(_projectId, taskId) {
        return { task: tasks.find((task) => task.id === taskId), workspacePath: "/tmp/work" };
      }
    },
    workflowEngine: {
      async listAgentMessages() { return [{ role: "user", content: "历史问题" }]; }
    },
    platformKernel: {
      tokenLedger: {
        async summarizeUsage() { return { promptTokens: 1200, completionTokens: 80 }; }
      }
    }
  };
  const terminal = {
    ui: {
      async choose() { return choices.shift(); },
      updateSession(value) { events.push(["session", value]); },
      replaceConversationHistory(value) { events.push(["history", value]); },
      setUsageText(value) { events.push(["usage", value]); },
      addNotice(value) { events.push(["notice", value]); }
    }
  };
  const session = { project: { id: "terminal" }, task: tasks[0], workspacePath: "/tmp/work" };
  await runResumeMenu(services, terminal, session);
  assert.equal(session.task.id, "t2");
  assert.deepEqual(events[0], ["session", { workspacePath: "/tmp/work", taskTitle: "历史会话" }]);
  assert.deepEqual(events[1], ["history", [{ role: "user", content: "历史问题" }]]);
  assert.deepEqual(events[2], ["usage", "缓存 — · 上下文 —"]);
});

test("CLI /resume 用首条用户消息修复旧默认会话名", async () => {
  const tasks = [
    { id: "current", title: "新任务", workspacePath: "/tmp/work", createdAt: "2026-08-12T00:00:00.000Z" },
    { id: "legacy", title: "work · 新会话", workspacePath: "/tmp/work", createdAt: "2026-08-11T00:00:00.000Z" }
  ];
  const updated = [];
  let dialog = null;
  const services = {
    projectService: {
      async listTasks() { return tasks; },
      async updateTask(projectId, taskId, patch) {
        updated.push([projectId, taskId, patch.title]);
        return { ...tasks.find((task) => task.id === taskId), ...patch };
      }
    },
    workflowEngine: {
      async listAgentMessages({ taskId }) {
        return taskId === "legacy"
          ? [{ role: "user", content: "帮我优化支付错误处理" }]
          : [];
      }
    }
  };
  await runResumeMenu(services, {
    ui: {
      async choose(options) {
        dialog = options;
        return null;
      }
    }
  }, { project: { id: "terminal" }, task: tasks[0], workspacePath: "/tmp/work" });
  assert.equal(dialog.items.find((item) => item.value === "legacy").label, "优化支付错误处理");
  assert.deepEqual(updated, [["terminal", "legacy", "优化支付错误处理"]]);
});

test("CLI /resume 只删除选中会话数据，不改变当前工作空间", async () => {
  const tasks = [
    { id: "current", title: "当前", workspacePath: "/tmp/work" },
    { id: "old", title: "可删除历史", workspacePath: "/tmp/work" }
  ];
  const choices = ["old", "delete", "delete"];
  const deleted = [];
  const notices = [];
  const services = {
    projectService: {
      async listTasks() { return tasks; },
      async deleteTask(projectId, taskId) { deleted.push([projectId, taskId]); }
    }
  };
  const terminal = {
    ui: {
      async choose() { return choices.shift(); },
      addSuccess(message) { notices.push(message); }
    }
  };
  const session = { project: { id: "terminal" }, task: tasks[0], workspacePath: "/tmp/work" };
  await runResumeMenu(services, terminal, session);
  assert.deepEqual(deleted, [["terminal", "old"]]);
  assert.equal(session.task.id, "current");
  assert.match(notices[0], /已删除任务/);
});

test("CLI /new 创建并切换到真实的新会话", async () => {
  const events = [];
  const services = {
    projectService: {
      async createTask(projectId, payload) {
        events.push(["create", projectId, payload.title]);
        return { id: payload.id, title: payload.title, workspacePath: "" };
      },
      async bindTaskWorkspace(projectId, taskId, workspacePath) {
        events.push(["bind", projectId, taskId, workspacePath]);
        return { id: taskId, title: "新任务", workspacePath };
      }
    }
  };
  const terminal = {
    ui: {
      updateSession(value) { events.push(["session", value]); },
      replaceConversationHistory(value) { events.push(["history", value]); },
      addNotice() {},
      addSuccess(message) { events.push(["success", message]); }
    }
  };
  const session = {
    project: { id: "terminal" },
    task: { id: "current" },
    workspacePath: "/tmp/work"
  };
  await createNewSession(services, terminal, session);
  assert.notEqual(session.task.id, "current");
  assert.equal(session.workspacePath, "/tmp/work");
  assert.equal(events.some((event) => event[0] === "bind"), true);
  assert.deepEqual(events.find((event) => event[0] === "create"), ["create", "terminal", "新任务"]);
  assert.deepEqual(events.find((event) => event[0] === "session"), [
    "session", { workspacePath: "/tmp/work", taskTitle: "新任务" }
  ]);
  assert.deepEqual(events.find((event) => event[0] === "history"), ["history", []]);
  assert.deepEqual(events.at(-1), ["success", "已创建新任务。"]);
});

test("CLI /new 重复执行时复用唯一空任务", async () => {
  const blank = { id: "blank", title: "新任务", workspacePath: "/tmp/work" };
  let createCalls = 0;
  const services = {
    projectService: {
      async listTasks() { return [blank]; },
      async isBlankTask(_projectId, task) { return task.id === blank.id; },
      async createTask() { createCalls += 1; throw new Error("不应创建第二个空任务"); }
    }
  };
  const notices = [];
  const terminal = { ui: { addSuccess(message) { notices.push(message); } } };
  const session = {
    project: { id: "terminal" },
    task: blank,
    workspacePath: "/tmp/work"
  };
  await createNewSession(services, terminal, session);
  await createNewSession(services, terminal, session);
  assert.equal(createCalls, 0);
  assert.deepEqual(notices, ["当前已是空白新任务。", "当前已是空白新任务。"]);
});

test("CLI 删除当前任务时复用已有空任务并清理重复空记录", async () => {
  const current = { id: "current", title: "正在删除", workspacePath: "/tmp/work" };
  const firstBlank = { id: "blank-new", title: "新任务", workspacePath: "/tmp/work" };
  const secondBlank = { id: "blank-old", title: "新任务", workspacePath: "/tmp/work" };
  const tasks = [current, firstBlank, secondBlank];
  const choices = ["current", "delete", "delete"];
  const deleted = [];
  let createCalls = 0;
  const services = {
    projectService: {
      async listTasks() { return tasks.filter((task) => !deleted.includes(task.id)); },
      async isBlankTask(_projectId, task) { return task.id.startsWith("blank-"); },
      async deleteTask(_projectId, taskId) { deleted.push(taskId); },
      async createTask() { createCalls += 1; throw new Error("不应新增空任务"); },
      async resolveTaskWorkspace(_projectId, taskId) {
        const task = tasks.find((item) => item.id === taskId);
        return { task, workspacePath: task.workspacePath };
      }
    }
  };
  const successes = [];
  const terminal = {
    ui: {
      async choose() { return choices.shift(); },
      updateSession() {},
      replaceConversationHistory() {},
      addSuccess(message) { successes.push(message); }
    }
  };
  const session = { project: { id: "terminal" }, task: current, workspacePath: "/tmp/work" };
  await runResumeMenu(services, terminal, session);
  assert.equal(createCalls, 0);
  assert.equal(session.task.id, "blank-new");
  assert.deepEqual(deleted, ["current", "blank-old"]);
  assert.match(successes[0], /已删除任务/);
});

test("CLI 从自然语言中确认用户明确指定的输出目录", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "yaoguo-cli-output-"));
  const requested = path.join(root, "测试 222");
  try {
    await mkdir(requested);
    const targets = await resolveExplicitOutputTargets(
      `${requested} 在这里帮我做一个 ppt 课件。`
    );
    assert.deepEqual(targets, [{ path: await realpath(requested), kind: "directory" }]);
    const requestedFile = path.join(root, "交付课件.pptx");
    assert.deepEqual(
      await resolveExplicitOutputTargets(`请把课件保存到 \`${requestedFile}\`。`),
      [{ path: requestedFile, kind: "file" }]
    );
    assert.deepEqual(
      await resolveExplicitOutputTargets(`读取 ${requested} 中的文件，并生成一份总结。`),
      [],
      "作为输入来源提及的路径不应被误认为交付位置"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI 只从明确打开语义中确认本地打开目标", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "yaoguo-cli-open-target-"));
  const requested = path.join(root, "测试目录");
  try {
    await mkdir(requested);
    assert.deepEqual(
      await resolveExplicitOpenTargets(`请打开 ${requested}`),
      [{ path: await realpath(requested), kind: "directory" }]
    );
    assert.deepEqual(
      await resolveExplicitOpenTargets(`请打开一下这个文件夹 ${requested}`),
      [{ path: await realpath(requested), kind: "directory" }]
    );
    assert.deepEqual(await resolveExplicitOpenTargets(`读取 ${requested} 并总结`), []);
    assert.deepEqual(await resolveExplicitOpenTargets(`把文件保存到 ${requested}`), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI TUI 将模型 token 流、成品与 usage 交给同一对话界面", async () => {
  const events = [];
  const stream = { text: "" };
  const terminal = {
    options: { json: false, quiet: false },
    ui: {
      beginAssistant() { events.push("begin"); return stream; },
      appendAssistant(target, delta) { target.text += delta; events.push(`delta:${delta}`); },
      finishAssistant(target, fallback) { events.push(`finish:${target.text || fallback}`); },
      addArtifact(absolute) { events.push(`artifact:${absolute}`); },
      setUsageText(text) { events.push(`usage:${text}`); },
      cancelAssistant() { events.push("cancel"); }
    }
  };
  const result = await runTurn({
    workflowEngine: {
      async submitAgentInput(_payload, options) {
        assert.deepEqual(_payload.explicitOpenTargets, []);
        options.onToken("已经");
        options.onToken("完成。");
        return {
          reply: "已经完成。",
          artifacts: [{ absolute: "/tmp/work/report.md" }],
          usage: {
            promptTokens: 2000,
            completionTokens: 120,
            cacheHitTokens: 1500,
            cacheMissTokens: 500
          }
        };
      }
    }
  }, terminal, {
    project: { id: "terminal" },
    task: { id: "task" }
  }, "完成报告");
  assert.equal(result.reply, "已经完成。");
  assert.deepEqual(events, [
    "begin",
    "delta:已经",
    "delta:完成。",
    "finish:已经完成。",
    "artifact:/tmp/work/report.md",
    "usage:缓存 75% · 上下文 —"
  ]);
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

test("CLI 首次按 canonical 工作空间创建稳定新任务，已有任务后启动优先创建新任务", async () => {
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
    async listTasks(projectId) {
      return [...tasks.values()].filter((task) => task.projectId === projectId);
    },
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
    assert.equal(first.task.title, "新任务");
    first.task.title = "已有任务";
    const second = await resolveSession({ projectService }, { workspace });
    assert.equal(first.project.id, "terminal");
    assert.equal(first.task.id, workspaceTaskId(canonical));
    assert.equal(first.task.title, "已有任务");
    assert.notEqual(second.task.id, first.task.id);
    assert.equal(second.task.title, "新任务");
    assert.equal(second.workspacePath, canonical);
    assert.equal(tasks.size, 2);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("CLI 启动时清理同一工作空间的重复空任务", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "yaoguo-cli-deduplicate-"));
  const canonical = await realpath(workspace);
  const project = { id: "terminal", name: "终端工作区" };
  const tasks = [
    { id: "blank-new", projectId: "terminal", title: "新任务", workspacePath: canonical },
    {
      id: "blank-old",
      projectId: "terminal",
      title: `${path.basename(canonical)} · 新会话`,
      workspacePath: canonical
    }
  ];
  const deleted = [];
  const projectService = {
    async getProject() { return project; },
    async listTasks() { return tasks.filter((task) => !deleted.includes(task.id)); },
    async isBlankTask(_projectId, task) { return task.title === "新任务"; },
    async deleteTask(_projectId, taskId) { deleted.push(taskId); },
    async getTask(_projectId, taskId) {
      return tasks.find((task) => task.id === taskId && !deleted.includes(task.id)) || null;
    },
    async resolveTaskWorkspace(_projectId, taskId) {
      const task = tasks.find((item) => item.id === taskId);
      return { task, workspacePath: canonical };
    }
  };
  try {
    const session = await resolveSession({ projectService }, { workspace });
    assert.equal(session.task.id, "blank-new");
    assert.deepEqual(deleted, ["blank-old"]);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("CLI 启动时移除其他工作空间遗留的空任务", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "yaoguo-cli-cross-workspace-"));
  const canonical = await realpath(workspace);
  const project = { id: "terminal", name: "终端工作区" };
  const stale = { id: "stale", projectId: "terminal", title: "新任务", workspacePath: "/tmp/old-work" };
  const tasks = [stale];
  const deleted = [];
  const created = [];
  const projectService = {
    async getProject() { return project; },
    async listTasks() { return tasks.filter((task) => !deleted.includes(task.id)); },
    async isBlankTask(_projectId, task) { return task.title === "新任务"; },
    async deleteTask(_projectId, taskId) { deleted.push(taskId); },
    async getTask(_projectId, taskId) {
      return created.find((task) => task.id === taskId) || null;
    },
    async createTask(projectId, payload) {
      const task = { ...payload, projectId, workspacePath: "" };
      created.push(task);
      return task;
    },
    async bindTaskWorkspace(_projectId, taskId, workspacePath) {
      const task = created.find((item) => item.id === taskId);
      task.workspacePath = workspacePath;
      return task;
    }
  };
  try {
    const session = await resolveSession({ projectService }, { workspace });
    assert.deepEqual(deleted, ["stale"]);
    assert.equal(created.length, 1);
    assert.equal(session.task.workspacePath, canonical);
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
