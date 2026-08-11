import test from "node:test";
import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { AgentToolRegistry } = require("../src/platform/ai/agentTools/agentToolRegistry.js");
const { runToolLoop: runToolLoopRaw } = require("../src/platform/ai/agentLoop/agentLoop.js");
const { AgentToolRuntime } = require("../src/platform/ai/agentLoop/toolRuntime.js");
const {
  ScopedNodeExecutionEnv,
  assertScopedShellCommand,
  createScopedTools,
  parseExternalOpenCommand
} = require("../src/platform/ai/agentLoop/scopedTools.js");
const {
  ShellSandbox,
  hostUserDataRoots,
  systemCommandPath,
  systemRuntimeReadRoots
} = require("../src/platform/ai/agentLoop/shellSandbox.js");
const {
  captureWorkspaceIdentity
} = require("../src/platform/projects/workspaceIdentity.js");
const agentExecutionActions = require("../src/application/workflows/mixins/agentExecutionActions.js");
const { isToolAvailable } = require("../src/platform/ai/agentTools/toolCapabilityPolicy.js");

const testShellSandboxFactory = async () => ({
  tempDir: tmpdir(),
  wrap: async (command) => command,
  cleanupAfterCommand() {},
  async cleanup() {}
});

async function supervisedProcessSnapshot(sandbox, detachedPidFile = "") {
  const rows = [];
  const processGroup = Number(
    await readFile(sandbox.processGroupFile, "utf8").catch(() => "")
  );
  if (Number.isSafeInteger(processGroup) && processGroup > 1) {
    rows.push({
      pid: processGroup,
      ppid: process.pid,
      pgid: processGroup,
      birth: `supervisor-${processGroup}`,
      hasToken: true
    });
  }
  const detachedPid = Number(
    detachedPidFile
      ? await readFile(detachedPidFile, "utf8").catch(() => "")
      : ""
  );
  if (Number.isSafeInteger(detachedPid) && detachedPid > 1) {
    try {
      process.kill(detachedPid, 0);
      rows.push({
        pid: detachedPid,
        ppid: 1,
        pgid: detachedPid,
        birth: `detached-${detachedPid}`,
        hasToken: true
      });
    } catch {}
  }
  return rows;
}

const runToolLoop = (options) => runToolLoopRaw({
  ...options,
  shellSandboxFactory: testShellSandboxFactory
});

function call(id, name, args) {
  return {
    id,
    type: "function",
    function: { name, arguments: JSON.stringify(args) }
  };
}

function scriptedRouter(scripts) {
  let index = 0;
  const invocations = [];
  const next = (args, continuation) => {
    invocations.push(args);
    const script = scripts[index++] || scripts.at(-1) || { content: "" };
    const toolCalls = script.toolCalls || [];
    return {
      content: script.content || "",
      reasoningContent: "",
      toolCalls,
      finishReason: toolCalls.length ? "tool_calls" : "stop",
      usage: script.usage || { promptTokens: 20, completionTokens: 5, totalTokens: 25 },
      requestMessages: continuation
        ? args.messages
        : [
          { role: "system", content: "soul + aesthetic" },
          { role: "user", content: args.input || "" }
        ],
      assistantMessage: {
        role: "assistant",
        content: script.content || null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {})
      },
      provider: { id: "deepseek", baseUrl: "https://api.deepseek.com" },
      model: "deepseek-v4",
      settings: {},
      taskType: "agent",
      modelContextTokens: 1024 * 1024,
      maxTokens: 65536
    };
  };
  return {
    invocations,
    async runTaskDetailed(args) { return next(args, false); },
    async continueTaskDetailed(args) { return next(args, true); }
  };
}

test("通用 Agent loop 通过基础 read 工具后继续完成交付", async () => {
  const workDir = await mkdtemp(path.join(tmpdir(), "yaoguo-agent-"));
  try {
    await writeFile(path.join(workDir, "input.txt"), "腰果审美基线", "utf8");
    const router = scriptedRouter([
      {
        toolCalls: [call("agent-read-1", "read", { path: "input.txt" })],
        usage: {
          promptTokens: 100, completionTokens: 10, reasoningTokens: 8,
          cacheHitTokens: 80, cacheMissTokens: 20
        }
      },
      {
        content: "已读取腰果审美基线。",
        usage: {
          promptTokens: 60, completionTokens: 20, reasoningTokens: 5,
          cacheHitTokens: 40, cacheMissTokens: 20
        }
      }
    ]);
    const result = await runToolLoop({
      aiRouter: router,
      registry: new AgentToolRegistry(),
      toolNames: [],
      toolCtx: {
        runDir: workDir,
        agentWorkDir: workDir,
        agentScopeAllow: [workDir]
      },
      runTaskArgs: { taskType: "agent", input: "读取 input.txt 后交付" },
      maxRounds: 4
    });

    assert.equal(result.text, "已读取腰果审美基线。");
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0].name, "read");
    assert.equal(result.toolCalls[0].result.ok, true, JSON.stringify(result.toolCalls[0], null, 2));
    assert.equal(router.invocations.length, 2);
    assert.deepEqual(
      router.invocations[0].tools.map((tool) => tool.function.name).slice(0, 4),
      ["read", "write", "edit", "bash"]
    );
    assert.equal(result.contextStats.executionBudget.modelCalls, 2);
    assert.equal(result.contextStats.executionBudget.toolCalls, 1);
    assert.deepEqual(result.usage, {
      modelCalls: 2,
      promptTokens: 160,
      completionTokens: 30,
      reasoningTokens: 13,
      cacheHitTokens: 120,
      cacheMissTokens: 40,
      totalTokens: 190,
      cacheHitRate: 0.75
    });
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test("Pi 基础工具按声明映射原生并行模式，写入与命令保持串行", async () => {
  const workDir = await mkdtemp(path.join(tmpdir(), "yaoguo-agent-tool-mode-"));
  try {
    const tools = await createScopedTools({
      cwd: workDir,
      roots: [workDir],
      shellSandboxFactory: testShellSandboxFactory
    });
    const modes = Object.fromEntries(tools.map((tool) => [tool.name, tool.executionMode]));
    assert.deepEqual(modes, {
      read: "parallel",
      write: "sequential",
      edit: "sequential",
      bash: "sequential"
    });
    for (const name of ["write", "edit"]) {
      const tool = tools.find((item) => item.name === name);
      assert.ok(tool.parameters.required.includes("deliverable"));
      assert.equal(tool.parameters.properties.deliverable.type, "boolean");
    }
    await tools.cleanup();
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test("通用 Agent 的 write、edit、bash 在任务目录内完成完整文件操作", async () => {
  const workDir = await mkdtemp(path.join(tmpdir(), "yaoguo-agent-files-"));
  try {
    const router = scriptedRouter([
      { toolCalls: [call("agent-write-1", "write", {
        path: "draft.txt",
        content: "第一稿",
        deliverable: false
      })] },
      {
        toolCalls: [call("agent-edit-1", "edit", {
          path: "draft.txt",
          edits: [{ oldText: "第一稿", newText: "审美校订稿" }],
          deliverable: false
        })]
      },
      { toolCalls: [call("agent-bash-1", "bash", { command: "printf shell-ok > shell.txt" })] },
      { content: "文件操作已验证。" }
    ]);
    const result = await runToolLoop({
      aiRouter: router,
      registry: new AgentToolRegistry(),
      toolNames: [],
      toolCtx: {
        runDir: workDir,
        agentWorkDir: workDir,
        agentScopeAllow: [workDir]
      },
      runTaskArgs: { taskType: "agent", input: "写入、修改并检查任务文件" },
      maxRounds: 6
    });

    assert.equal(result.text, "文件操作已验证。");
    assert.deepEqual(result.toolCalls.map((item) => item.name), ["write", "edit", "bash"]);
    assert.ok(result.toolCalls.every((item) => item.result.ok), JSON.stringify(result.toolCalls, null, 2));
    assert.equal(await readFile(path.join(workDir, "draft.txt"), "utf8"), "审美校订稿");
    assert.equal(await readFile(path.join(workDir, "shell.txt"), "utf8"), "shell-ok");
    assert.equal(result.contextStats.executionBudget.modelCalls, 4);
    assert.equal(result.contextStats.executionBudget.toolCalls, 3);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test("通用 Agent 可按需重复执行相同的 Pi 基础命令", async () => {
  const workDir = await mkdtemp(path.join(tmpdir(), "yaoguo-agent-repeat-"));
  try {
    const repeated = { command: "printf x >> repeated.txt" };
    const router = scriptedRouter([
      { toolCalls: [call("agent-bash-repeat-1", "bash", repeated)] },
      { toolCalls: [call("agent-bash-repeat-2", "bash", repeated)] },
      { content: "命令已按需执行两次。" }
    ]);
    const result = await runToolLoop({
      aiRouter: router,
      registry: new AgentToolRegistry(),
      toolNames: [],
      toolCtx: {
        runDir: workDir,
        agentWorkDir: workDir,
        agentScopeAllow: [workDir]
      },
      runTaskArgs: { taskType: "agent", input: "执行两次相同命令" },
      maxRounds: 4
    });

    assert.equal(result.text, "命令已按需执行两次。");
    assert.equal(result.toolCalls.length, 2);
    assert.ok(result.toolCalls.every((item) => item.result.ok), JSON.stringify(result.toolCalls, null, 2));
    assert.equal(await readFile(path.join(workDir, "repeated.txt"), "utf8"), "xx");
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test("通用 Agent 可编辑用户已授权的工作区外文件", async () => {
  const workDir = await mkdtemp(path.join(tmpdir(), "yaoguo-agent-workspace-"));
  const authorizedDir = await mkdtemp(path.join(tmpdir(), "yaoguo-agent-authorized-"));
  const target = path.join(authorizedDir, "local.txt");
  try {
    await writeFile(target, "旧内容", "utf8");
    const router = scriptedRouter([
      {
        toolCalls: [call("agent-edit-local", "edit", {
          path: target,
          edits: [{ oldText: "旧内容", newText: "新内容" }],
          deliverable: false
        })]
      },
      { content: "本地文件已修改。" }
    ]);
    const result = await runToolLoop({
      aiRouter: router,
      registry: new AgentToolRegistry(),
      toolNames: [],
      toolCtx: {
        runDir: workDir,
        agentWorkDir: workDir,
        agentScopeAllow: [workDir, target]
      },
      runTaskArgs: { taskType: "agent", input: `修改 ${target}` },
      maxRounds: 4
    });

    assert.equal(result.text, "本地文件已修改。");
    assert.equal(await readFile(target, "utf8"), "新内容");
  } finally {
    await rm(workDir, { recursive: true, force: true });
    await rm(authorizedDir, { recursive: true, force: true });
  }
});

test("完整文件系统访问开启后，通用 Agent 可直接修改工作区外文件", async () => {
  const workDir = await mkdtemp(path.join(tmpdir(), "yaoguo-agent-request-workspace-"));
  const externalDir = await mkdtemp(path.join(tmpdir(), "yaoguo-agent-request-external-"));
  const target = path.join(externalDir, "local.txt");
  try {
    await writeFile(target, "修改前", "utf8");
    const router = scriptedRouter([
      {
        toolCalls: [call("agent-request-edit", "edit", {
          path: target,
          edits: [{ oldText: "修改前", newText: "修改后" }],
          deliverable: false
        })]
      },
      { content: "已按授权修改文件。" }
    ]);
    const result = await runToolLoop({
      aiRouter: router,
      registry: new AgentToolRegistry(),
      toolNames: [],
      toolCtx: {
        runDir: workDir,
        agentWorkDir: workDir,
        agentScopeAllow: [workDir, path.parse(target).root],
        fullFileSystemAccess: true
      },
      runTaskArgs: { taskType: "agent", input: `修改 ${target}` },
      maxRounds: 4
    });

    assert.equal(result.text, "已按授权修改文件。");
    assert.equal(result.toolCalls[0].result.ok, true, JSON.stringify(result.toolCalls[0], null, 2));
    assert.equal(await readFile(target, "utf8"), "修改后");
  } finally {
    await rm(workDir, { recursive: true, force: true });
    await rm(externalDir, { recursive: true, force: true });
  }
});

test("完整文件系统访问关闭时，通用 Agent 不能修改工作区外文件", async () => {
  const workDir = await mkdtemp(path.join(tmpdir(), "yaoguo-agent-denied-workspace-"));
  const externalDir = await mkdtemp(path.join(tmpdir(), "yaoguo-agent-denied-external-"));
  const target = path.join(externalDir, "local.txt");
  try {
    await writeFile(target, "保持原样", "utf8");
    const router = scriptedRouter([
      {
        toolCalls: [call("agent-denied-edit", "edit", {
          path: target,
          edits: [{ oldText: "保持原样", newText: "不应写入" }],
          deliverable: false
        })]
      },
      { content: "用户未授权，因此没有修改文件。" }
    ]);
    const result = await runToolLoop({
      aiRouter: router,
      registry: new AgentToolRegistry(),
      toolNames: [],
      toolCtx: {
        runDir: workDir,
        agentWorkDir: workDir,
        agentScopeAllow: [workDir],
        fullFileSystemAccess: false
      },
      runTaskArgs: { taskType: "agent", input: `修改 ${target}` },
      maxRounds: 4
    });

    assert.equal(result.text, "用户未授权，因此没有修改文件。");
    assert.equal(result.toolCalls[0].result.ok, false);
    assert.match(result.toolCalls[0].result.error, /越出 Agent 工作区/);
    assert.equal(await readFile(target, "utf8"), "保持原样");
  } finally {
    await rm(workDir, { recursive: true, force: true });
    await rm(externalDir, { recursive: true, force: true });
  }
});

test("Agent 文件工具不能修改 .git/.agents/.codex 宿主控制目录", async () => {
  const workDir = await mkdtemp(path.join(tmpdir(), "yaoguo-agent-protected-"));
  try {
    await mkdir(path.join(workDir, ".git"), { recursive: true });
    await writeFile(path.join(workDir, ".git", "config"), "original", "utf8");
    const result = await runToolLoop({
      aiRouter: scriptedRouter([
        { toolCalls: [call("protected-write", "write", {
          path: ".git/config",
          content: "tampered",
          deliverable: false
        })] },
        { content: "宿主控制目录保持只读。" }
      ]),
      registry: new AgentToolRegistry(),
      toolNames: [],
      toolCtx: {
        runDir: workDir,
        agentWorkDir: workDir,
        agentScopeAllow: [workDir]
      },
      runTaskArgs: { taskType: "agent", input: "修改 .git/config" },
      maxRounds: 3
    });

    assert.equal(result.toolCalls[0].result.ok, false);
    assert.match(result.toolCalls[0].result.error, /宿主控制目录/);
    assert.equal(await readFile(path.join(workDir, ".git", "config"), "utf8"), "original");
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test("任意工作入口开启 Agent loop 时始终保留四个基础工具", async () => {
  const workDir = await mkdtemp(path.join(tmpdir(), "yaoguo-agent-session-"));
  try {
    const router = scriptedRouter([{ content: "基础能力已启用。" }]);
    const engine = {
      ...agentExecutionActions,
      shellSandboxFactory: testShellSandboxFactory,
      aiRouter: router,
      projectService: {
        getTaskDir() { return workDir; }
      }
    };
    const result = await engine._executeAgent({
      runTaskArgs: { taskType: "agent", input: "检查基础能力" },
      projectId: "project-test",
      taskId: "task-test"
    });

    assert.equal(result.text, "基础能力已启用。");
    assert.deepEqual(
      router.invocations[0].tools.map((tool) => tool.function.name).slice(0, 4),
      ["read", "write", "edit", "bash"]
    );
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test("Agent 工具上下文把完整文件权限只转换为读取根，未绑定时写入候选区", async () => {
  const workDir = await mkdtemp(path.join(tmpdir(), "yaoguo-agent-full-scope-"));
  try {
    const engine = {
      ...agentExecutionActions,
      settingsService: {
        get: async () => ({ permissions: { fileSystem: { fullAccess: true } } })
      },
      projectService: {
        getTaskDir() { return workDir; }
      }
    };
    const toolCtx = await engine._buildAgentToolContext({
      projectId: "project-test",
      taskId: "task-test"
    });

    assert.equal(toolCtx.fullFileSystemAccess, true);
    assert.equal(toolCtx.agentWorkDir, path.join(workDir, ".candidates"));
    assert.ok(toolCtx.agentReadScopeAllow.includes(path.parse(workDir).root));
    assert.deepEqual(toolCtx.agentWriteScopeAllow, [path.join(workDir, ".candidates")]);
    assert.equal(toolCtx.agentWriteScopeAllow.includes(path.parse(workDir).root), false);
    assert.ok(toolCtx.agentReadScopeDeny.includes(path.join(workDir, "session")));
    assert.ok(toolCtx.agentReadScopeDeny.includes(path.join(workDir, "context-results")));
    assert.deepEqual(toolCtx.agentShellReadScopeAllow, []);
    assert.match(toolCtx.contextResultDir, /\/context-results\/agent$/);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test("直接输入与 canonical workflow 使用同一 task-scoped 工具能力", async () => {
  const taskDir = await mkdtemp(path.join(tmpdir(), "yaoguo-agent-tool-parity-"));
  try {
    const engine = {
      ...agentExecutionActions,
      todoStore: {},
      checkpointStore: {},
      settingsService: { get: async () => ({ permissions: { fileSystem: { fullAccess: false } } }) },
      projectService: {
        getTaskDir() { return taskDir; },
        async getTask() { return { workspacePath: "" }; }
      }
    };
    const direct = await engine._buildAgentToolContext({
      projectId: "p1", taskId: "t1", turnId: "turn-direct"
    });
    const workflow = await engine._buildAgentToolContext({
      projectId: "p1", taskId: "t1", runId: "r1",
      runDir: path.join(taskDir, "runs", "r1"), stepId: "agent", turnId: "workflow-r1"
    });

    assert.equal(direct.todoDir, path.join(taskDir, "agent-state"));
    assert.equal(workflow.todoDir, direct.todoDir);
    assert.equal(isToolAvailable("write_todo", direct), true);
    assert.equal(isToolAvailable("write_todo", workflow), true);
    assert.equal(isToolAvailable("recall_handoff", direct), false);
    assert.equal(isToolAvailable("recall_handoff", workflow), false);
    assert.equal(direct.artifactRunId, "");
    assert.equal(workflow.artifactRunId, "");

    const historical = await engine._buildAgentToolContext({
      projectId: "p1", taskId: "t1", runId: "old-run",
      runDir: path.join(taskDir, "runs", "old-run"),
      handoffDir: path.join(taskDir, "runs", "old-run"),
      stepId: "legacy-step", turnId: "legacy-turn"
    });
    assert.equal(isToolAvailable("recall_handoff", historical), true);
    assert.equal(historical.artifactRunId, "old-run");
  } finally {
    await rm(taskDir, { recursive: true, force: true });
  }
});

test("Agent 工具上下文拒绝 turnId 路径穿越", async () => {
  const taskDir = await mkdtemp(path.join(tmpdir(), "yaoguo-agent-context-scope-"));
  try {
    const engine = {
      ...agentExecutionActions,
      settingsService: { get: async () => ({ permissions: { fileSystem: { fullAccess: false } } }) },
      projectService: {
        getTaskDir() { return taskDir; },
        async getTask() { return { workspacePath: "" }; }
      }
    };
    await assert.rejects(
      () => engine._buildAgentToolContext({ projectId: "p1", taskId: "t1", turnId: "../../escape" }),
      (error) => error.code === "PATH_SEGMENT_INVALID"
    );
  } finally {
    await rm(taskDir, { recursive: true, force: true });
  }
});

test("ContextResultStore 只使用宿主保护路径，不因 workflow runDir 产生可旁路副本", () => {
  const protectedDir = path.join(tmpdir(), "task", "context-results", "turn-1");
  const runtime = new AgentToolRuntime({
    registry: new AgentToolRegistry(),
    runTaskArgs: {},
    toolCtx: {
      runDir: path.join(tmpdir(), "task", "runs", "run-1"),
      contextResultDir: protectedDir
    }
  }, null);
  assert.equal(runtime.resultStore.directory, path.resolve(protectedDir));
});

test("产品 Agent 缺少权限服务时只允许安全读取，副作用工具失败关闭", async () => {
  const runtime = new AgentToolRuntime({
    registry: new AgentToolRegistry(),
    runTaskArgs: {},
    toolCtx: {},
    requireToolAuthorization: true
  }, null);
  assert.equal(await runtime.authorize("read", { path: "a.md" }, { effect: "read" }), null);
  const rejected = await runtime.authorize("write", { path: "a.md" }, { effect: "workspace_write" });
  assert.equal(rejected.code, "TOOL_PERMISSION_UNAVAILABLE");
});

test("AgentToolRuntime 结束时删除自己创建的 turn 级工具原文", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "yaoguo-runtime-results-"));
  const resultDir = path.join(parent, "turn-1");
  try {
    const runtime = new AgentToolRuntime({
      registry: new AgentToolRegistry(),
      runTaskArgs: {},
      toolCtx: { contextResultDir: resultDir }
    }, null);
    await runtime.resultStore.save({ toolName: "fetch", callId: "c1", value: "secret" });
    await realpath(resultDir);

    await runtime.cleanup();

    await assert.rejects(realpath(resultDir));
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("Agent 工具上下文注入统一的宿主授权能力", async () => {
  const workDir = await mkdtemp(path.join(tmpdir(), "yaoguo-agent-host-capabilities-"));
  try {
    const decisions = [];
    const engine = {
      ...agentExecutionActions,
      settingsService: {
        get: async () => ({ permissions: { fileSystem: { fullAccess: false } } })
      },
      toolPermissionService: {
        authorize: async (input) => {
          decisions.push(input);
          return { allow: true };
        }
      },
      projectService: {
        getTaskDir() { return workDir; }
      }
    };
    const toolCtx = await engine._buildAgentToolContext({
      projectId: "project-test",
      taskId: "task-test"
    });

    assert.equal(typeof toolCtx.authorizeToolCall, "function");
    await toolCtx.authorizeToolCall({ name: "bash", policy: { effect: "command_execute" } });
    assert.equal(decisions[0].name, "bash");
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test("未绑定工作空间时，完整文件读取权限不能把外部参考目录变成写入位置", async () => {
  const taskDir = await mkdtemp(path.join(tmpdir(), "yaoguo-agent-internal-output-"));
  const externalDir = await mkdtemp(path.join(tmpdir(), "yaoguo-agent-readonly-reference-"));
  const target = path.join(externalDir, "reference.md");
  try {
    await writeFile(target, "# 参考原文", "utf8");
    const engine = {
      ...agentExecutionActions,
      settingsService: {
        get: async () => ({ permissions: { fileSystem: { fullAccess: true } } })
      },
      projectService: {
        getTaskDir() { return taskDir; },
        async getTask() { return { workspacePath: "" }; }
      }
    };
    const toolCtx = await engine._buildAgentToolContext({
      projectId: "project-test",
      taskId: "task-test",
      fileReferences: [await realpath(target)]
    });
    const result = await runToolLoop({
      aiRouter: scriptedRouter([
        {
          toolCalls: [call("agent-edit-reference", "edit", {
            path: target,
            edits: [{ oldText: "参考原文", newText: "不应写入" }],
            deliverable: false
          })]
        },
        { content: "外部参考保持只读。" }
      ]),
      registry: new AgentToolRegistry(),
      toolNames: [],
      toolCtx,
      runTaskArgs: { taskType: "agent", input: "读取参考后生成新稿" },
      maxRounds: 4
    });

    assert.equal(result.toolCalls[0].result.ok, false);
    assert.match(result.toolCalls[0].result.error, /越出 Agent 工作区/);
    assert.equal(await readFile(target, "utf8"), "# 参考原文");
  } finally {
    await rm(taskDir, { recursive: true, force: true });
    await rm(externalDir, { recursive: true, force: true });
  }
});

test("基础文件工具没有固定单任务次数上限，十次 bash 后仍可完成", async () => {
  const workDir = await mkdtemp(path.join(tmpdir(), "yaoguo-agent-long-shell-"));
  try {
    const scripts = Array.from({ length: 10 }, (_, index) => ({
      toolCalls: [call(`agent-bash-${index}`, "bash", {
        command: `printf ${index} > shell-${index}.txt`
      })]
    }));
    scripts.push({ content: "十轮文件处理已完成。" });
    const result = await runToolLoop({
      aiRouter: scriptedRouter(scripts),
      registry: new AgentToolRegistry(),
      toolNames: [],
      toolCtx: {
        runDir: workDir,
        agentWorkDir: workDir,
        agentScopeAllow: [workDir]
      },
      runTaskArgs: { taskType: "agent", input: "连续完成十轮文件处理" },
      maxRounds: 12
    });

    assert.equal(result.text, "十轮文件处理已完成。");
    assert.equal(result.toolCalls.length, 10);
    assert.ok(result.toolCalls.every((item) => item.result.ok), JSON.stringify(result.toolCalls, null, 2));
    assert.equal(await readFile(path.join(workDir, "shell-9.txt"), "utf8"), "9");
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test("工作绑定工作空间后，Agent cwd 与文件技能交付目录都切到工作空间", async () => {
  const taskDir = await mkdtemp(path.join(tmpdir(), "yaoguo-agent-task-storage-"));
  const workspacePath = await mkdtemp(path.join(tmpdir(), "yaoguo-agent-workspace-"));
  const replacementPath = await mkdtemp(path.join(tmpdir(), "yaoguo-agent-workspace-rebound-"));
  try {
    const workspaceIdentity = await captureWorkspaceIdentity(workspacePath);
    const engine = {
      ...agentExecutionActions,
      settingsService: {
        get: async () => ({ permissions: { fileSystem: { fullAccess: false } } })
      },
      projectService: {
        getTaskDir() { return taskDir; },
        async getTask() {
          return {
            workspacePath: workspaceIdentity.canonicalPath,
            workspaceIdentity
          };
        }
      }
    };
    const toolCtx = await engine._buildAgentToolContext({
      projectId: "project-test",
      taskId: "task-test"
    });

    assert.equal(toolCtx.agentWorkDir, workspaceIdentity.canonicalPath);
    assert.equal(toolCtx.skillWorkDir, workspaceIdentity.canonicalPath);
    assert.ok(toolCtx.agentReadScopeAllow.includes(workspaceIdentity.canonicalPath));
    assert.ok(toolCtx.agentReadScopeAllow.includes(taskDir));
    assert.deepEqual(toolCtx.agentWriteScopeAllow, [workspaceIdentity.canonicalPath]);

    await rm(workspaceIdentity.canonicalPath, { recursive: true, force: true });
    await symlink(replacementPath, workspaceIdentity.canonicalPath);
    await assert.rejects(
      () => engine._buildAgentToolContext({
        projectId: "project-test",
        taskId: "task-test"
      }),
      /工作空间根目录不能是符号链接/
    );
  } finally {
    await rm(taskDir, { recursive: true, force: true });
    await rm(workspacePath, { recursive: true, force: true });
    await rm(replacementPath, { recursive: true, force: true });
  }
});

test("Agent 工具上下文拒绝授权后被符号链接换绑的本地引用", async () => {
  const taskDir = await mkdtemp(path.join(tmpdir(), "yaoguo-agent-reference-task-"));
  const referenceRoot = await mkdtemp(path.join(tmpdir(), "yaoguo-agent-reference-root-"));
  const outsideRoot = await mkdtemp(path.join(tmpdir(), "yaoguo-agent-reference-outside-"));
  const granted = path.join(referenceRoot, "material");
  try {
    await mkdir(granted);
    const canonical = await realpath(granted);
    await rm(granted, { recursive: true, force: true });
    await symlink(outsideRoot, granted);
    const engine = {
      ...agentExecutionActions,
      settingsService: { get: async () => ({ permissions: { fileSystem: { fullAccess: false } } }) },
      projectService: {
        getTaskDir() { return taskDir; },
        async getTask() { return { workspacePath: "" }; }
      }
    };

    await assert.rejects(
      () => engine._buildAgentToolContext({
        projectId: "project-test",
        taskId: "task-test",
        fileReferences: [canonical]
      }),
      /本地文件授权已失效/
    );
  } finally {
    await rm(taskDir, { recursive: true, force: true });
    await rm(referenceRoot, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  }
});

test("bash 由工作空间沙箱约束数据操作，只硬挡提权、宿主级命令和外部应用逃逸", () => {
  assert.doesNotThrow(() => assertScopedShellCommand("node --version"));
  assert.doesNotThrow(() => assertScopedShellCommand("find . -maxdepth 2 -type f"));
  assert.throws(() => assertScopedShellCommand("sudo npm install"), /不允许提权命令/);
  assert.throws(() => assertScopedShellCommand("/usr/bin/sudo npm install"), /不允许提权命令/);
  assert.throws(() => assertScopedShellCommand("open https://example.com"), /外部应用/);
  assert.throws(() => assertScopedShellCommand("/usr/bin/open https://example.com"), /外部应用/);
  assert.throws(() => assertScopedShellCommand("osascript -e 'display dialog 1'"), /外部应用/);
  assert.doesNotThrow(() => assertScopedShellCommand("curl https://example.com"));
  assert.doesNotThrow(() => assertScopedShellCommand("cat ../settings.local.json"));
  assert.doesNotThrow(() => assertScopedShellCommand("cat /etc/passwd"));
  assert.doesNotThrow(() => assertScopedShellCommand("rm -rf build"));
  assert.doesNotThrow(() => assertScopedShellCommand("/bin/rm -rf build"));
  assert.doesNotThrow(() => assertScopedShellCommand("git -C ../repo reset --hard"));
  assert.doesNotThrow(() => assertScopedShellCommand("/usr/bin/git -C ../repo clean -fd"));
  assert.throws(() => assertScopedShellCommand("diskutil eraseDisk APFS Empty /dev/disk9"), /宿主级系统命令/);
  assert.doesNotThrow(() => assertScopedShellCommand(`printf %s ${"x".repeat(8192)}`));
});

test("网页打开只接受单个公开 HTTP\(S\) URL，不经 AppleEvents", async () => {
  assert.equal(parseExternalOpenCommand("open https://example.com/docs?q=1"), "https://example.com/docs?q=1");
  assert.equal(parseExternalOpenCommand("/usr/bin/open 'http://example.com/a'"), "http://example.com/a");
  assert.equal(parseExternalOpenCommand("open file:///tmp/a"), null);
  assert.equal(parseExternalOpenCommand("open http://127.0.0.1:3000"), null);
  assert.equal(parseExternalOpenCommand("open http://[::ffff:127.0.0.1]"), null);
  assert.equal(parseExternalOpenCommand("open https://user:pass@example.com"), null);
  assert.equal(parseExternalOpenCommand("open https://example.com && whoami"), null);
  assert.doesNotThrow(() => assertScopedShellCommand("open https://example.com", { allowExternalOpen: true }));

  const opened = [];
  const env = new ScopedNodeExecutionEnv({}, {
    cwd: process.cwd(),
    readRoots: [process.cwd()],
    writeRoots: [process.cwd()],
    openExternal: async (url) => opened.push(url)
  });
  const result = await env.exec("open https://example.com/docs");
  assert.equal(result.ok, true);
  assert.deepEqual(opened, ["https://example.com/docs"]);
});

test("Pi 文件工具固定使用校验后的 canonical path，不沿符号链接越界", async () => {
  const workDir = await mkdtemp(path.join(tmpdir(), "yaoguo-canonical-work-"));
  const externalDir = await mkdtemp(path.join(tmpdir(), "yaoguo-canonical-external-"));
  try {
    const internal = path.join(workDir, "inside.txt");
    const external = path.join(externalDir, "outside.txt");
    await writeFile(internal, "inside", "utf8");
    await writeFile(external, "outside", "utf8");
    await symlink(internal, path.join(workDir, "inside-link"));
    await symlink(external, path.join(workDir, "outside-link"));
    await symlink(externalDir, path.join(workDir, "outside-dir"));
    const env = new ScopedNodeExecutionEnv({}, {
      cwd: workDir,
      readRoots: [workDir],
      writeRoots: [workDir]
    });

    assert.equal(await env.guardPath("inside-link"), await realpath(internal));
    await assert.rejects(env.guardPath("inside-link", false, "write"), /不可通过符号链接/);
    await assert.rejects(env.guardPath("outside-link"), /越出 Agent 工作区/);
    await assert.rejects(env.guardPath("outside-dir/new.txt", true, "write"), /符号链接|越出 Agent 工作区/);
  } finally {
    await rm(workDir, { recursive: true, force: true });
    await rm(externalDir, { recursive: true, force: true });
  }
});

test("Pi 写入工具拒绝经工作区硬链接修改外部 inode", async () => {
  const workDir = await mkdtemp(path.join(tmpdir(), "yaoguo-hardlink-work-"));
  const externalDir = await mkdtemp(path.join(tmpdir(), "yaoguo-hardlink-external-"));
  try {
    const external = path.join(externalDir, "outside.txt");
    const linked = path.join(workDir, "linked.txt");
    await writeFile(external, "outside", "utf8");
    await link(external, linked);
    const env = new ScopedNodeExecutionEnv({}, {
      cwd: workDir,
      readRoots: [workDir],
      writeRoots: [workDir]
    });

    await assert.rejects(env.guardPath(linked, false, "write"), /多个硬链接/);
    assert.equal(await readFile(external, "utf8"), "outside");
  } finally {
    await rm(workDir, { recursive: true, force: true });
    await rm(externalDir, { recursive: true, force: true });
  }
});

test("完整磁盘权限只扩大 Pi read，bash 不接收文件系统根目录", async () => {
  const workDir = await mkdtemp(path.join(tmpdir(), "yaoguo-shell-read-scope-"));
  const referenceDir = await mkdtemp(path.join(tmpdir(), "yaoguo-shell-reference-"));
  let sandboxOptions;
  try {
    const tools = await createScopedTools({
      cwd: workDir,
      readRoots: [path.parse(workDir).root, referenceDir],
      writeRoots: [workDir],
      shellReadRoots: [path.parse(workDir).root, referenceDir],
      fullFileSystemAccess: true,
      toolNames: ["read", "bash"],
      shellSandboxFactory: async (options) => {
        sandboxOptions = options;
        return testShellSandboxFactory();
      }
    });
    assert.equal(sandboxOptions.readRoots.includes(path.parse(workDir).root), false);
    assert.ok(sandboxOptions.readRoots.includes(await realpath(workDir)));
    assert.ok(sandboxOptions.readRoots.includes(await realpath(referenceDir)));
    assert.equal(sandboxOptions.allowAppleEvents, false);
    await tools.cleanup();
  } finally {
    await rm(workDir, { recursive: true, force: true });
    await rm(referenceDir, { recursive: true, force: true });
  }
});

test("bash 不继承 taskDir/runDir 等 Pi read 根，只接收 cwd、写入根和显式参考", async () => {
  const taskDir = await mkdtemp(path.join(tmpdir(), "yaoguo-shell-task-control-"));
  const candidateDir = path.join(taskDir, ".candidates");
  const referenceDir = await mkdtemp(path.join(tmpdir(), "yaoguo-shell-explicit-reference-"));
  let sandboxOptions;
  try {
    await mkdir(candidateDir, { recursive: true });
    const tools = await createScopedTools({
      cwd: candidateDir,
      readRoots: [taskDir, candidateDir],
      writeRoots: [candidateDir],
      shellReadRoots: [referenceDir],
      toolNames: ["bash"],
      shellSandboxFactory: async (options) => {
        sandboxOptions = options;
        return testShellSandboxFactory();
      }
    });
    assert.equal(sandboxOptions.readRoots.includes(await realpath(taskDir)), false);
    assert.ok(sandboxOptions.readRoots.includes(await realpath(candidateDir)));
    assert.ok(sandboxOptions.readRoots.includes(await realpath(referenceDir)));
    await tools.cleanup();
  } finally {
    await rm(taskDir, { recursive: true, force: true });
    await rm(referenceDir, { recursive: true, force: true });
  }
});

test("ShellSandbox 即使收到宽权参数也始终拒绝 AppleEvents 和宿主用户目录", async () => {
  let policy;
  const sandbox = new ShellSandbox({
    cwd: process.cwd(),
    readRoots: [process.cwd()],
    writeRoots: [process.cwd()],
    fullFileSystemAccess: true,
    allowAppleEvents: true
  });
  sandbox.runtime = {
    SandboxManager: {
      wrapWithSandbox(command, _unused, options) {
        policy = options;
        return command;
      }
    }
  };
  sandbox.tempDir = tmpdir();
  sandbox.controlDir = path.join(tmpdir(), "yaoguo-test-control");
  assert.equal(await sandbox.wrap("pwd"), "pwd");
  assert.equal(policy.allowAppleEvents, false);
  assert.ok(policy.filesystem.denyRead.includes(path.parse(process.cwd()).root));
  for (const denied of hostUserDataRoots()) assert.ok(policy.filesystem.denyRead.includes(denied));
  for (const allowed of systemRuntimeReadRoots()) assert.ok(policy.filesystem.allowRead.includes(allowed));
  for (const broadHostPath of ["/etc", "/var"]) {
    assert.equal(policy.filesystem.allowRead.includes(path.resolve(broadHostPath)), false);
  }
  assert.equal(policy.filesystem.allowRead.includes(path.resolve("/dev")), false);
  for (const standardDevice of ["/dev/null", "/dev/zero", "/dev/random", "/dev/urandom"]) {
    assert.ok(policy.filesystem.allowRead.includes(path.resolve(standardDevice)));
  }
  assert.ok(policy.filesystem.denyRead.includes(sandbox.controlDir));
  assert.ok(policy.filesystem.denyWrite.includes(sandbox.controlDir));
});

test("macOS 系统命令只放行运行时代码目录，不重新开放包管理器配置和数据根", () => {
  const developerDir = "/Applications/Xcode.app/Contents/Developer";
  const roots = systemRuntimeReadRoots({
    platform: "darwin",
    pathExists: () => true,
    developerDir,
    executablePaths: []
  });
  const covers = (target) => roots.some((root) => (
    target === root || target.startsWith(`${root}${path.sep}`)
  ));

  for (const broadRoot of [
    "/System",
    "/usr",
    "/usr/local",
    "/opt/homebrew",
    "/opt/local",
    "/Library/Apple",
    "/Library/Developer/CommandLineTools",
    developerDir
  ]) {
    assert.equal(roots.includes(path.resolve(broadRoot)), false);
  }
  for (const sensitivePath of [
    "/System/Volumes/Data/Users",
    "/System/Volumes/Data/private",
    "/Library/Apple/System/Library/LaunchDaemons",
    "/Library/Developer/CommandLineTools/SDKs",
    `${developerDir}/Platforms`,
    "/usr/local/etc",
    "/usr/local/var",
    "/opt/homebrew/etc",
    "/opt/homebrew/var",
    "/opt/local/etc",
    "/opt/local/var"
  ]) {
    assert.equal(covers(path.resolve(sensitivePath)), false, `${sensitivePath} 不应可读`);
  }
  for (const runtimePath of [
    "/bin/bash",
    "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation",
    "/System/Volumes/Preboot/Cryptexes/OS/usr/lib/libSystem.B.dylib",
    "/usr/bin/git",
    "/usr/lib/libSystem.B.dylib",
    "/opt/homebrew/bin/node",
    "/opt/homebrew/Cellar/node/24.0.0/bin/node",
    "/opt/local/lib/libiconv.dylib",
    `${developerDir}/usr/bin/git`,
    `${developerDir}/usr/libexec/git-core/git-status`
  ]) {
    assert.equal(covers(path.resolve(runtimePath)), true, `${runtimePath} 应由运行时根覆盖`);
  }

  const commandPaths = systemCommandPath(process.cwd(), {
    platform: "darwin",
    pathExists: () => true,
    developerDir
  }).split(path.delimiter);
  assert.ok(commandPaths.indexOf(`${developerDir}/usr/bin`) < commandPaths.indexOf("/usr/bin"));

  const executable = realpathSync(process.execPath);
  const executableBin = path.dirname(executable);
  if (path.basename(executableBin) === "bin") {
    const executablePrefix = path.dirname(executableBin);
    const executableRoots = systemRuntimeReadRoots({
      platform: "darwin",
      pathExists: () => true,
      developerDir,
      executablePaths: [process.execPath]
    });
    assert.equal(executableRoots.includes(executablePrefix), false);
    assert.ok(executableRoots.includes(executableBin));
    assert.ok(executableRoots.includes(path.join(executablePrefix, "lib")));
  }
});

test("bash 正常返回时宿主回收同进程组后台任务", async () => {
  const workDir = await mkdtemp(path.join(tmpdir(), "yaoguo-shell-process-group-"));
  let sandbox;
  try {
    const tools = await createScopedTools({
      cwd: workDir,
      readRoots: [workDir],
      writeRoots: [workDir],
      toolNames: ["bash"],
      shellSandboxFactory: async (options) => {
        sandbox = new ShellSandbox(options);
        sandbox.runtime = {
          SandboxManager: {
            wrapWithSandbox(command) { return command; },
            cleanupAfterCommand() {}
          }
        };
        await sandbox.initializeProcessSupervisor();
        sandbox.processSnapshotProvider = () => supervisedProcessSnapshot(sandbox);
        return sandbox;
      }
    });
    const bash = tools.find((tool) => tool.name === "bash");
    const result = await bash.execute(
      "background-process",
      { command: "(sleep 0.25; printf escaped > escaped.txt) & printf launched" },
      undefined
    );
    assert.match(result.content[0].text, /launched/);
    await assert.rejects(
      bash.execute("preserve-exit-status", { command: "exit 7" }, undefined),
      /code 7/
    );
    await new Promise((resolve) => setTimeout(resolve, 450));
    await assert.rejects(readFile(path.join(workDir, "escaped.txt"), "utf8"), /ENOENT/);
    assert.equal(sandbox.activeProcessGroups.size, 0);
    await tools.cleanup();
  } finally {
    await sandbox?.cleanup();
    await rm(workDir, { recursive: true, force: true });
  }
});

test("bash 取消时同一进程组的后台任务一并回收", async () => {
  const workDir = await mkdtemp(path.join(tmpdir(), "yaoguo-shell-abort-group-"));
  let tools;
  let sandbox;
  try {
    tools = await createScopedTools({
      cwd: workDir,
      readRoots: [workDir],
      writeRoots: [workDir],
      toolNames: ["bash"],
      shellSandboxFactory: async (options) => {
        sandbox = new ShellSandbox(options);
        sandbox.runtime = {
          SandboxManager: {
            wrapWithSandbox(command) { return command; },
            cleanupAfterCommand() {}
          }
        };
        await sandbox.initializeProcessSupervisor();
        sandbox.processSnapshotProvider = () => supervisedProcessSnapshot(sandbox);
        return sandbox;
      }
    });
    const controller = new AbortController();
    const bash = tools.find((tool) => tool.name === "bash");
    const execution = bash.execute(
      "abort-process-group",
      { command: "(sleep 0.25; printf escaped > abort-escaped.txt) & wait" },
      controller.signal
    );
    setTimeout(() => controller.abort(new Error("permission changed")), 40);
    await assert.rejects(execution, /aborted/i);
    await new Promise((resolve) => setTimeout(resolve, 400));
    await assert.rejects(readFile(path.join(workDir, "abort-escaped.txt"), "utf8"), /ENOENT/);
    assert.equal(sandbox.activeProcessGroups.size, 0);
  } finally {
    await tools?.cleanup();
    await sandbox?.cleanup();
    await rm(workDir, { recursive: true, force: true });
  }
});

test("bash 回收显式 detached + unref 的新 session 子进程", async () => {
  const workDir = await mkdtemp(path.join(tmpdir(), "yaoguo-shell-detached-session-"));
  const detachedPidFile = path.join(workDir, "detached.pid");
  let tools;
  let sandbox;
  try {
    tools = await createScopedTools({
      cwd: workDir,
      readRoots: [workDir],
      writeRoots: [workDir],
      toolNames: ["bash"],
      shellSandboxFactory: async (options) => {
        sandbox = new ShellSandbox(options);
        sandbox.runtime = {
          SandboxManager: {
            wrapWithSandbox(command) { return command; },
            cleanupAfterCommand() {}
          }
        };
        await sandbox.initializeProcessSupervisor();
        sandbox.processSnapshotProvider = () => (
          supervisedProcessSnapshot(sandbox, detachedPidFile)
        );
        return sandbox;
      }
    });
    const bash = tools.find((tool) => tool.name === "bash");
    const payload = [
      "const fs=require('node:fs');",
      "const {spawn}=require('node:child_process');",
      "const child=spawn('/bin/bash',['-c','sleep .25; printf escaped > detached.txt'],",
      "{detached:true,stdio:'ignore'});",
      "fs.writeFileSync('detached.pid',String(child.pid));",
      "child.unref();"
    ].join("");
    await bash.execute(
      "detached-session",
      { command: `node -e ${JSON.stringify(payload)}` },
      undefined
    );
    await new Promise((resolve) => setTimeout(resolve, 450));
    await assert.rejects(readFile(path.join(workDir, "detached.txt"), "utf8"), /ENOENT/);
    assert.equal(sandbox.activeProcessGroups.size, 0);
    assert.equal(sandbox.activeTracker, null);
  } finally {
    await tools?.cleanup();
    await sandbox?.cleanup();
    await rm(workDir, { recursive: true, force: true });
  }
});
