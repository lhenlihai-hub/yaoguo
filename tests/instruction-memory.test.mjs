import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { InstructionMemoryService } = require("../src/platform/memory/instructions");
const { AiRouter } = require("../src/platform/ai/aiRouter");
const { AgentToolRegistry } = require("../src/platform/ai/agentTools/agentToolRegistry.js");
const { runToolLoop } = require("../src/platform/ai/agentLoop/agentLoop");

const registriesDir = path.resolve("workspace/registries");

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "yaoguo-instruction-memory-"));
  const managedRoot = path.join(root, "managed");
  const userRoot = path.join(root, "user");
  const workspace = path.join(root, "workspace");
  await Promise.all([managedRoot, userRoot, workspace].map((directory) => mkdir(directory, { recursive: true })));
  const service = new InstructionMemoryService({
    managedRoot,
    userRoot,
    platform: "linux",
    settingsService: { get: async () => ({ instructions: {} }) }
  });
  return { root, managedRoot, userRoot, workspace, service };
}

async function put(file, content) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, "utf8");
}

test("指令记忆按 Managed → User → Project 根到 CWD → Local 加载", async () => {
  const f = await fixture();
  try {
    const cwd = path.join(f.workspace, "src");
    await mkdir(cwd, { recursive: true });
    await put(path.join(f.managedRoot, "YAOGUO.md"), "managed-rule");
    await put(path.join(f.userRoot, "YAOGUO.md"), "user-rule");
    await put(path.join(f.workspace, "YAOGUO.md"), "project-root-rule");
    await put(path.join(cwd, "YAOGUO.md"), "project-near-rule");
    await put(path.join(f.workspace, "YAOGUO.local.md"), "local-rule");

    const turn = await f.service.beginTurn({ scopeRoot: f.workspace, cwd });
    const sources = turn.summary().sources;
    assert.deepEqual(sources, [
      "managed:YAOGUO.md",
      "user:YAOGUO.md",
      "project:YAOGUO.md",
      "project:src/YAOGUO.md",
      "local:YAOGUO.local.md"
    ]);
    const reminder = turn.initialReminder();
    const ordered = ["managed-rule", "user-rule", "project-root-rule", "project-near-rule", "local-rule"];
    for (let index = 1; index < ordered.length; index += 1) {
      assert.ok(reminder.indexOf(ordered[index - 1]) < reminder.indexOf(ordered[index]));
    }
    assert.match(reminder, /^<system-reminder>/);
    assert.match(reminder, /<instruction-memory version="1" kind="initial"/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("@include 原位展开并检测间接循环", async () => {
  const f = await fixture();
  try {
    await put(path.join(f.workspace, "YAOGUO.md"), "root\n@include ./a.md\nend");
    await put(path.join(f.workspace, "a.md"), "a\n@include ./b.md");
    await put(path.join(f.workspace, "b.md"), "b\n@include ./a.md");
    const turn = await f.service.beginTurn({ scopeRoot: f.workspace, cwd: f.workspace });
    const reminder = turn.initialReminder();
    assert.match(reminder, /root[\s\S]*a[\s\S]*b[\s\S]*end/);
    assert.ok(turn.summary().diagnostics.some((item) => item.code === "INSTRUCTION_INCLUDE_CYCLE"));
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("@include 最多展开 5 层并拒绝第 6 层", async () => {
  const f = await fixture();
  try {
    await put(path.join(f.workspace, "YAOGUO.md"), "root\n@include ./level-1.md");
    for (let level = 1; level <= 6; level += 1) {
      await put(path.join(f.workspace, `level-${level}.md`), [
        `level-${level}-rule`,
        ...(level < 6 ? [`@include ./level-${level + 1}.md`] : [])
      ].join("\n"));
    }
    const turn = await f.service.beginTurn({ scopeRoot: f.workspace, cwd: f.workspace });
    assert.match(turn.initialReminder(), /level-5-rule/);
    assert.doesNotMatch(turn.initialReminder(), /level-6-rule/);
    assert.ok(turn.summary().diagnostics.some((item) => item.code === "INSTRUCTION_INCLUDE_DEPTH_EXCEEDED"));
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("pat 使用完整 glob、负匹配，并在访问子目录时激活嵌套规则", async () => {
  const f = await fixture();
  try {
    await put(path.join(f.workspace, ".yaoguo", "rules", "react.md"), [
      "---",
      "pat:",
      "  - \"src/components/**/*.{js,jsx,ts,tsx}\"",
      "  - \"!src/components/generated/**\"",
      "---",
      "react-rule"
    ].join("\n"));
    await put(path.join(f.workspace, "src", "components", "YAOGUO.md"), "component-locality-rule");
    await put(path.join(f.workspace, "src", "components", "Button.tsx"), "export const Button = 1;");
    await put(path.join(f.workspace, "src", "components", "generated", "Auto.tsx"), "export const Auto = 1;");

    const turn = await f.service.beginTurn({ scopeRoot: f.workspace, cwd: f.workspace });
    assert.equal(turn.initialReminder(), "");
    await turn.prepareToolBatch([call("r0", "read", { path: "src/components/generated/Auto.tsx" })]);
    assert.deepEqual(turn.summary().sources, ["project:src/components/YAOGUO.md"]);
    turn.markDelivered();
    await turn.prepareToolBatch([call("r1", "read", { path: "src/components/Button.tsx" })]);
    assert.deepEqual(turn.summary().sources, [
      "project:.yaoguo/rules/react.md",
      "project:src/components/YAOGUO.md"
    ]);
    assert.match(turn.dynamicReminder(), /react-rule/);
    assert.match(turn.dynamicReminder(), /component-locality-rule/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("pat 拒绝非字符串、纯负向与越级 pattern，并给出稳定诊断", async () => {
  const f = await fixture();
  try {
    await put(path.join(f.workspace, ".yaoguo", "rules", "number.md"), "---\npat: 42\n---\nnumber-rule");
    await put(path.join(f.workspace, ".yaoguo", "rules", "negative.md"), "---\npat: '!src/generated/**'\n---\nnegative-rule");
    await put(path.join(f.workspace, ".yaoguo", "rules", "parent.md"), "---\npat: '../**'\n---\nparent-rule");
    const turn = await f.service.beginTurn({ scopeRoot: f.workspace, cwd: f.workspace });
    assert.equal(turn.initialReminder(), "");
    assert.equal(
      turn.summary().diagnostics.filter((item) => item.code === "INSTRUCTION_PAT_INVALID").length,
      3
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("初始 Token 超限时按高到低选入，Local 不被 Managed 挤占", async () => {
  const f = await fixture();
  try {
    const service = new InstructionMemoryService({
      managedRoot: f.managedRoot,
      userRoot: f.userRoot,
      platform: "linux",
      settingsService: {
        get: () => ({ instructions: { initialTokens: 1000, activeTokens: 2000 } })
      }
    });
    await put(path.join(f.managedRoot, "YAOGUO.md"), `managed-marker ${"managed ".repeat(300)}`);
    await put(path.join(f.workspace, "YAOGUO.local.md"), `local-marker ${"local ".repeat(300)}`);
    const turn = await service.beginTurn({ scopeRoot: f.workspace, cwd: f.workspace });
    assert.match(turn.initialReminder(), /local-marker/);
    assert.doesNotMatch(turn.initialReminder(), /managed-marker/);
    assert.ok(turn.summary().diagnostics.some((item) => item.code === "INSTRUCTION_TOKEN_BUDGET_EXCEEDED"));
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("通道 A 是首条 user message，通道 B 是独立稳定 system section", async () => {
  const router = new AiRouter(
    { get: async () => ({}) },
    { registriesDir }
  );
  const reminder = "<system-reminder>\n<instruction-memory>project-rule</instruction-memory>\n</system-reminder>";
  const request = await router.prepareTaskRequest({
    taskType: "agent",
    title: "双轨消息",
    instruction: "完成请求",
    input: "当前用户输入",
    runContext: "",
    pinnedSections: [],
    instructionReminder: reminder,
    contextProfile: "heavy",
    provider: { id: "deepseek" },
    model: "deepseek-v4-pro",
    callMaxTokens: 1000,
    settings: {
      context: {
        tokenBudgets: { defaultModelTokens: 128000, outputReserveTokens: 6000 }
      }
    }
  });

  assert.deepEqual(request.messages.map((message) => message.role), ["system", "user", "user"]);
  assert.equal(request.messages[1].content, reminder);
  assert.match(request.messages[2].content, /当前用户输入/);
  assert.match(request.messages[0].content, /<memory_behavior>/);
  assert.doesNotMatch(request.messages[0].content, /project-rule/);
  const promptSectionCacheKeys = [...router._systemPromptSectionCache.keys()];
  assert.deepEqual(
    promptSectionCacheKeys.filter((key) => !key.startsWith("dynamic:")).sort(),
    ["memory.behavior", "memory.cache"]
  );
  assert.equal(
    promptSectionCacheKeys.filter((key) => key.startsWith("dynamic:tool-guidance:")).length,
    1
  );

  const internal = await router.prepareTaskRequest({
    taskType: "review",
    title: "内部调用",
    instruction: "输出 JSON",
    input: "{}",
    runContext: "",
    pinnedSections: [],
    instructionReminder: reminder,
    internalCall: true,
    contextProfile: "minimal",
    provider: { id: "deepseek" },
    model: "deepseek-v4-pro",
    callMaxTokens: 1000,
    settings: {
      context: {
        tokenBudgets: { defaultModelTokens: 128000, outputReserveTokens: 6000 },
        compaction: { enabled: false }
      }
    }
  });
  assert.deepEqual(internal.messages.map((message) => message.role), ["system", "user"]);
  assert.doesNotMatch(internal.messages[0].content, /<memory_behavior>/);
});

test("首次写入嵌套目录先注入局部规则，重试后才产生副作用", async () => {
  const f = await fixture();
  try {
    await put(path.join(f.workspace, "src", "YAOGUO.md"), "nested-write-rule");
    const turn = await f.service.beginTurn({ scopeRoot: f.workspace, cwd: f.workspace });
    const router = scriptedRouter([
      { toolCalls: [call("write-1", "write", { path: "src/output.txt", content: "first", deliverable: false })] },
      { toolCalls: [call("write-2", "write", { path: "src/output.txt", content: "second", deliverable: false })] },
      { content: "写入完成" }
    ]);
    const result = await runToolLoop({
      aiRouter: router,
      registry: new AgentToolRegistry(),
      toolNames: [],
      toolCtx: {
        agentWorkDir: f.workspace,
        agentScopeAllow: [f.workspace],
        instructionMemoryTurn: turn
      },
      runTaskArgs: { taskType: "agent", input: "写入 src/output.txt" },
      maxRounds: 4
    });

    assert.equal(result.text, "写入完成");
    assert.equal(await readFile(path.join(f.workspace, "src", "output.txt"), "utf8"), "second");
    assert.equal(result.toolCalls[0].code, "INSTRUCTION_SCOPE_ACTIVATED");
    assert.equal(result.toolCalls[0].ok, false);
    assert.equal(result.toolCalls[1].ok, true);
    const continuation = router.invocations[1].messages;
    const dynamicRoot = continuation.find((message) => (
      message.role === "user" && `${message.content || ""}`.includes("path-activated")
    ));
    assert.ok(dynamicRoot);
    assert.match(dynamicRoot.content, /nested-write-rule/);
    assert.deepEqual(result.contextStats.instructionMemory.sources, ["project:src/YAOGUO.md"]);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("普通 Agent 的 write、edit 与 bash 不能修改指令控制文件", async () => {
  const f = await fixture();
  try {
    const controlFile = path.join(f.workspace, "YAOGUO.md");
    await put(controlFile, "original-rule");
    const turn = await f.service.beginTurn({ scopeRoot: f.workspace, cwd: f.workspace });
    const router = scriptedRouter([
      { toolCalls: [call("bash-1", "bash", { command: "printf changed >YAOGUO.md" })] },
      { content: "已停止修改" }
    ]);
    const result = await runToolLoop({
      aiRouter: router,
      registry: new AgentToolRegistry(),
      toolNames: [],
      toolCtx: {
        agentWorkDir: f.workspace,
        agentScopeAllow: [f.workspace],
        instructionMemoryTurn: turn
      },
      runTaskArgs: { taskType: "agent", input: "修改规则" },
      shellSandboxFactory: async () => ({
        wrap: async (command) => command,
        cleanupAfterCommand() {},
        async cleanup() {}
      }),
      maxRounds: 3
    });
    assert.equal(result.toolCalls[0].code, "INSTRUCTION_FILE_PROTECTED");
    assert.equal(result.toolCalls[0].ok, false);
    assert.equal(await readFile(controlFile, "utf8"), "original-rule");
    assert.equal(turn.isProtectedPath("YAOGUO.local.md"), true);
    assert.equal(turn.isProtectedPath("src/.yaoguo/rules/react.md"), true);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

function call(id, name, args) {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

function scriptedRouter(scripts) {
  let index = 0;
  const invocations = [];
  const response = (args, continuation) => {
    invocations.push(args);
    const script = scripts[index++] || scripts.at(-1) || { content: "" };
    const toolCalls = script.toolCalls || [];
    return {
      content: script.content || "",
      reasoningContent: "",
      toolCalls,
      finishReason: toolCalls.length ? "tool_calls" : "stop",
      usage: { promptTokens: 20, completionTokens: 5, totalTokens: 25 },
      requestMessages: continuation ? args.messages : [
        { role: "system", content: "system" },
        ...(args.instructionReminder ? [{ role: "user", content: args.instructionReminder }] : []),
        { role: "user", content: args.input || "" }
      ],
      assistantMessage: {
        role: "assistant",
        content: script.content || null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {})
      },
      provider: { id: "deepseek" },
      model: "deepseek-v4",
      settings: {},
      taskType: "agent",
      modelContextTokens: 1024 * 1024,
      maxTokens: 65536
    };
  };
  return {
    invocations,
    async runTaskDetailed(args) { return response(args, false); },
    async continueTaskDetailed(args) { return response(args, true); }
  };
}

test("会话内编辑规则文件在下一个 turn 生效，新建规则文件不再被负缓存吞掉", async () => {
  const f = await fixture();
  const { MemoryCacheService } = require("../src/platform/memory/cache");
  f.service.memoryCacheService = new MemoryCacheService();
  const cacheScope = "task:p1:t1";
  try {
    const cwd = f.workspace;
    await put(path.join(cwd, "YAOGUO.md"), "规则 v1");
    const first = await f.service.beginTurn({ scopeRoot: f.workspace, cwd, cacheScope });
    assert.match(first.initialReminder(), /规则 v1/);

    // 编辑已有规则：必须在下个 turn 生效。
    await writeFile(path.join(cwd, "YAOGUO.md"), "规则 v2 已更新", "utf8");
    const second = await f.service.beginTurn({ scopeRoot: f.workspace, cwd, cacheScope });
    assert.match(second.initialReminder(), /规则 v2 已更新/);
    assert.doesNotMatch(second.initialReminder(), /规则 v1\b/);

    // 新建规则文件：曾在发现过的目录里新建，不能被负缓存或 discoveredOwners 吞掉。
    await put(path.join(cwd, "YAOGUO.local.md"), "新增本地规则");
    const third = await f.service.beginTurn({ scopeRoot: f.workspace, cwd, cacheScope });
    assert.match(third.initialReminder(), /新增本地规则/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("只修改被 include 的规则文件也会在下一个 turn 生效", async () => {
  const f = await fixture();
  const { MemoryCacheService } = require("../src/platform/memory/cache");
  f.service.memoryCacheService = new MemoryCacheService();
  try {
    const included = path.join(f.workspace, "shared-rule.md");
    await put(path.join(f.workspace, "YAOGUO.md"), "根规则\n@include shared-rule.md");
    await put(included, "子规则 v1");
    const first = await f.service.beginTurn({ scopeRoot: f.workspace, cwd: f.workspace, cacheScope: "task:p1:include" });
    assert.match(first.initialReminder(), /子规则 v1/);

    await writeFile(included, "子规则 v2 已更新", "utf8");
    const second = await f.service.beginTurn({ scopeRoot: f.workspace, cwd: f.workspace, cacheScope: "task:p1:include" });
    assert.match(second.initialReminder(), /子规则 v2 已更新/);
    assert.doesNotMatch(second.initialReminder(), /子规则 v1\b/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
