import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const agentExecutionActions = require("../src/application/workflows/mixins/agentExecutionActions.js");
const { TodoStore } = require("../src/platform/runs/todoStore.js");
const { ArtifactStore } = require("../src/platform/artifacts/artifactStore.js");
const { CheckpointStore } = require("../src/platform/runs/checkpointStore.js");

function makeRunDir() {
  return mkdtempSync(path.join(tmpdir(), "step-tool-loop-"));
}

/**
 * 构造一个最小化的 WorkflowEngine-like 宿主，把 mixin 注到 prototype 上。
 * 通过 stub aiRouter 控制 LLM 行为(模拟 tool_calls / 终止)。
 */
function makeHost(overrides = {}) {
  class StubEngine {}
  Object.assign(StubEngine.prototype, agentExecutionActions);
  const host = new StubEngine();
  host.aiRouter = overrides.aiRouter || makeFakeRouter([{ text: "default" }]);
  host.artifactStore = overrides.artifactStore || null;
  host.todoStore = overrides.todoStore || new TodoStore();
  host.checkpointStore = overrides.checkpointStore || new CheckpointStore();
  host.toolPermissionService = overrides.toolPermissionService || {
    authorize: async () => ({ allow: true, decision: "allow_once" })
  };
  return host;
}

/**
 * 假 AiRouter:按 scripted 行为返回原生 detailed 响应。
 * scripts = [{ text, toolCalls? }, ...] —— 第 i 轮按第 i 条响应。
 */
function makeFakeRouter(scripts = []) {
  let i = 0;
  let invocations = 0;
  const invoke = async (args, continuation) => {
    invocations += 1;
    const script = scripts[i] || scripts[scripts.length - 1] || { text: "" };
    i += 1;
    const toolCalls = (script.toolCalls || []).map((call, index) => ({
      id: call.id || `call_${i}_${index}`,
      type: call.type || "function",
      function: call.function
    }));
    const content = script.text || "";
    return {
      content,
      toolCalls,
      requestMessages: continuation ? (args.messages || []) : [{ role: "user", content: args.input || "" }],
      assistantMessage: { role: "assistant", content: content || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) }
    };
  };
  return {
    invocations: () => invocations,
    runTaskDetailed: (args) => invoke(args, false),
    continueTaskDetailed: (args) => invoke(args, true)
  };
}

async function executeAgent(host, state, step, runTaskArgs, requestedToolNames) {
  const turn = await host._executeAgent({
    runTaskArgs,
    projectId: state.projectId || "",
    taskId: state.taskId || "",
    runId: state.id || "",
    runDir: state.runDir || "",
    handoffDir: step.taskType && step.taskType !== "agent" ? (state.runDir || "") : "",
    stepId: step.id || "",
    requestedToolNames,
    maxRounds: step.maxToolRounds
  });
  step.toolTrace = turn.toolTrace;
  if (turn.blocked) throw new Error(host._describeAgentStop(turn.stopCode, turn.toolTrace?.maxRounds));
  if (!turn.text.trim()) throw new Error("Agent 没有返回可交付结果。");
  return turn.text;
}

// ============ _resolveAgentTools ============

test("_resolveAgentTools: 数组直传,过滤空串", () => {
  const host = makeHost();
  assert.deepEqual(
    host._resolveAgentTools(["recall_handoff", "", "read_artifact"]),
    ["recall_handoff", "read_artifact"]
  );
});

test("_resolveAgentTools: 空数组 → null", () => {
  const host = makeHost();
  assert.equal(host._resolveAgentTools([]), null);
});

test("_resolveAgentTools: 退役的 auto 不再暗中分配能力", () => {
  const host = makeHost();
  assert.equal(host._resolveAgentTools("auto"), null);
});

test("_resolveAgentTools: null/其他字符串 → null", () => {
  const host = makeHost();
  assert.equal(host._resolveAgentTools(null), null);
  assert.equal(host._resolveAgentTools("false"), null);
});

test("_buildAgentRequest: 所有工作输入使用统一 token 预算，不截断原始消息", () => {
  const host = makeHost();
  const input = "完整需求与资料。".repeat(20000);
  const request = host._buildAgentRequest({ input, runContext: "工作历史" });

  assert.equal(request.taskType, "agent");
  assert.equal(request.input, input);
  assert.deepEqual(request.conversationMessages, []);
  assert.deepEqual(request.contextBudget, {
    runContextTokens: 180000,
    inputTokens: 64000
  });
  assert.equal(Object.keys(request.contextBudget).some((key) => key.endsWith("Chars")), false);
});

test("_buildAgentToolContext 按任务 Agent profile 绑定唯一 Memdir", async () => {
  const workspace = makeRunDir();
  let captured = null;
  const host = makeHost();
  host.projectService = {
    getTaskDir: () => workspace,
    getTask: async () => ({
      workspacePath: workspace,
      agentMemory: { agentType: "code-review", scope: "agent", mode: "append-only" }
    }),
    resolveTaskWorkspace: async () => ({ workspacePath: workspace }),
    memoryStore: {
      async forContext(context) {
        captured = context;
        return { indexContext: async () => "" };
      }
    }
  };
  try {
    const context = await host._buildAgentToolContext({
      projectId: "p1",
      taskId: "t1",
      runDir: workspace,
      stepId: "step-1"
    });
    assert.deepEqual(captured, {
      workspaceRoot: workspace,
      agentType: "code-review",
      memoryScope: "agent",
      memoryMode: "append-only"
    });
    assert.equal(context.memoryStore != null, true);
    assert.deepEqual(context.memoryContext, {
      enabled: true,
      scope: "agent",
      storageMode: "append-only",
      autoDream: false,
      sessionMemory: false,
      transcript: false,
      contextResults: true
    });
    assert.deepEqual(context.contextManagement, {
      enabled: true,
      toolResultMasking: true,
      fileOffloading: true,
      sessionCompaction: false,
      deterministicCheckpoint: true,
      subagentIsolation: false
    });
    assert.equal(context.scratchpadDirectory, path.join(workspace, ".candidates"));
    assert.equal(typeof context.environmentContext.platform, "string");
    assert.equal(typeof context.environmentContext.architecture, "string");
    assert.equal(typeof context.environmentContext.gitRepository, "boolean");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

// ============ _executeAgent ============

test("_executeAgent: 单轮收敛并返回 LLM 文本", async () => {
  const router = makeFakeRouter([{ text: "draft 第一稿成品" }]);
  const host = makeHost({ aiRouter: router });
  const state = { runDir: makeRunDir(), projectId: "p1", taskId: "t1", id: "r1" };
  const step = { id: "s1", taskType: "draft" };
  const text = await executeAgent(host, state, step, { taskType: "agent" }, ["recall_handoff"]);
  assert.equal(text, "draft 第一稿成品");
  assert.equal(router.invocations(), 1, "无 tool_calls 应只调一次 LLM");
  assert.equal(step.toolTrace.rounds, 1);
  assert.equal(step.toolTrace.toolCallsCount, 0);
  await rm(state.runDir, { recursive: true, force: true });
});

test("_executeAgent: 多轮 tool_calls, trace 落到统一位置", async () => {
  // 第一轮调用 recall_handoff，第二轮自然回复并结束。
  const router = makeFakeRouter([
    {
      text: "我先查一下决定...",
      toolCalls: [
        {
          function: {
            name: "recall_handoff",
            arguments: JSON.stringify({ scope: "decisions" })
          }
        }
      ]
    },
    { text: "基于查到的决定,这是最终稿" }
  ]);
  const host = makeHost({ aiRouter: router });
  const state = { runDir: makeRunDir(), projectId: "p1", taskId: "t1", id: "r1" };
  const step = { id: "step-with-tool", taskType: "draft" };
  const text = await executeAgent(host, state, step, { taskType: "agent" }, ["recall_handoff"]);
  assert.equal(text, "基于查到的决定,这是最终稿");
  assert.equal(router.invocations(), 2);
  assert.equal(step.toolTrace.toolCallsCount, 1);
  assert.equal(step.toolTrace.rounds, 2);
  assert.equal(step.toolTrace.roundsOutline.length, 2);
  assert.equal(step.toolTrace.roundsOutline[0].toolCalls[0].name, "recall_handoff");

  // 验证 trace 已落到磁盘
  const traceFile = path.join(state.runDir, "steps", "step-with-tool", "tool-trace.jsonl");
  const content = await readFile(traceFile, "utf8");
  const rows = content.trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].stepId, "step-with-tool");
  assert.equal(rows[0].toolCallsCount, 1);
  assert.ok(Array.isArray(rows[0].toolCalls));
  assert.equal(rows[0].toolCalls[0].name, "recall_handoff");
  await rm(state.runDir, { recursive: true, force: true });
});

test("_executeAgent: maxToolRounds 为显式自动化边界", async () => {
  // 编一个永远调工具的 LLM
  const persistentCall = {
    text: "继续...",
    toolCalls: [{ function: { name: "recall_handoff", arguments: "{\"scope\":\"all\"}" } }]
  };
  const router = makeFakeRouter([persistentCall, persistentCall, persistentCall, persistentCall, persistentCall, persistentCall]);
  const host = makeHost({ aiRouter: router });
  const state = { runDir: makeRunDir(), projectId: "p1", taskId: "t1", id: "r1" };
  const step = { id: "s2", taskType: "draft", maxToolRounds: 2 };
  await assert.rejects(
    executeAgent(host, state, step, { taskType: "agent" }, ["recall_handoff"]),
    /2 轮执行上限/
  );
  assert.equal(step.toolTrace.maxRounds, 2);
  assert.equal(step.toolTrace.exhausted, true, "用尽 maxRounds 应标 exhausted=true");
  assert.equal(router.invocations(), 2, "达到轮次上限后应显式停止，不得追加移除工具的伪收束请求");
  await rm(state.runDir, { recursive: true, force: true });
});

test("_executeAgent: 内部工具协议按真实原因阻塞", async () => {
  const leaked = [
    "正在生成文件。",
    "<｜｜DSML｜｜tool_calls>",
    "<｜｜DSML｜｜invoke name=\"write\">",
    "</｜｜DSML｜｜invoke>",
    "</｜｜DSML｜｜tool_calls>"
  ].join("\n");
  const router = makeFakeRouter([{ text: leaked }]);
  const host = makeHost({ aiRouter: router });
  const state = { runDir: makeRunDir(), projectId: "p1", taskId: "t1", id: "r1" };
  const step = { id: "protocol-leak", taskType: "draft" };

  await assert.rejects(
    executeAgent(host, state, step, { taskType: "agent" }, ["recall_handoff"]),
    /无法安全执行的工具指令/
  );

  assert.equal(router.invocations(), 1);
  assert.equal(step.toolTrace.exhausted, true);
  assert.equal(step.toolTrace.rounds, 1);
  await rm(state.runDir, { recursive: true, force: true });
});

test("_executeAgent: 显式 maxToolRounds 不被旧上限钳制", async () => {
  const router = makeFakeRouter([{ text: "ok" }]);
  const host = makeHost({ aiRouter: router });
  const state = { runDir: makeRunDir(), projectId: "p1", taskId: "t1", id: "r1" };
  const step = { id: "s3", taskType: "draft", maxToolRounds: 99 };
  await executeAgent(host, state, step, { taskType: "agent" }, ["recall_handoff"]);
  assert.equal(step.toolTrace.maxRounds, 99);
  await rm(state.runDir, { recursive: true, force: true });
});

test("_executeAgent: 默认超过十二轮后仍可自然交付", async () => {
  const scripts = Array.from({ length: 14 }, (_, round) => ({
    text: "继续处理",
    toolCalls: [{
      function: {
        name: "read",
        arguments: JSON.stringify({ path: `missing-${round}.txt` })
      }
    }]
  }));
  scripts.push({ text: "长任务最终交付" });
  const router = makeFakeRouter(scripts);
  const host = makeHost({ aiRouter: router });
  const state = { runDir: makeRunDir(), projectId: "p1", taskId: "t1", id: "r1" };
  const step = { id: "long-agent", taskType: "agent", tools: "agent" };

  const text = await executeAgent(host, state, step, { taskType: "agent" }, ["recall_handoff"]);

  assert.equal(text, "长任务最终交付");
  assert.equal(router.invocations(), 15);
  assert.equal(step.toolTrace.maxRounds, null);
  assert.equal(step.toolTrace.exhausted, false);
  await rm(state.runDir, { recursive: true, force: true });
});

test("_executeAgent: 无效参数在执行前被 schema 拒绝，LLM 仍能收敛", async () => {
  // 第一轮 LLM 调 write_todo 但缺 action；注册中心应在调用业务代码前拒绝，
  // 并把结构化参数错误回传给下一轮模型。
  const router = makeFakeRouter([
    {
      text: "我试试 write_todo",
      toolCalls: [{ function: { name: "write_todo", arguments: "{}" } }]
    },
    { text: "工具说参数错,我手动给出方案" }
  ]);
  const host = makeHost({ aiRouter: router });
  const state = { runDir: makeRunDir(), projectId: "p1", taskId: "t1", id: "r1" };
  const step = { id: "s4", taskType: "plan" };
  const text = await executeAgent(host, state, step, { taskType: "agent" }, ["write_todo"]);
  assert.equal(text, "工具说参数错,我手动给出方案");
  assert.equal(step.toolTrace.toolCallsCount, 1);
  const traceFile = path.join(state.runDir, "steps", "s4", "tool-trace.jsonl");
  const content = await readFile(traceFile, "utf8");
  const rows = content.trim().split("\n").map((l) => JSON.parse(l));
  const persisted = rows[0].toolCalls[0];
  assert.equal(persisted.ok, false);
  assert.equal(persisted.code, "TOOL_INPUT_INVALID");
  assert.match(persisted.argsDigest, /^[a-f0-9]{64}$/);
  assert.equal("valuePreview" in persisted, false);
  assert.equal("error" in persisted, false);
  await rm(state.runDir, { recursive: true, force: true });
});

test("_persistAgentTrace: 外层执行成功但业务 {ok:false} 必须持久化为失败", async () => {
  const host = makeHost();
  const state = { runDir: makeRunDir() };
  const step = { id: "business-failure", taskType: "agent" };
  await host._persistAgentTrace({
    runDir: state.runDir,
    stepId: step.id,
    result: {
    rounds: 1,
    exhausted: false,
    contextStats: {},
    toolCalls: [{
      round: 0,
      name: "run_skill",
      args: { skillId: "skill://demo@1", action: "preview" },
      result: { ok: true, value: { ok: false, error: { code: "DEP_MISSING", message: "缺少依赖" } } }
    }]
    },
    traceRows: []
  });
  const content = await readFile(path.join(state.runDir, "steps", step.id, "tool-trace.jsonl"), "utf8");
  const persisted = JSON.parse(content.trim()).toolCalls[0];
  assert.equal(persisted.ok, false);
  assert.equal(persisted.code, "DEP_MISSING");
  assert.match(persisted.resultDigest, /^[a-f0-9]{64}$/);
  assert.equal("valuePreview" in persisted, false);
  assert.equal("error" in persisted, false);
  await rm(state.runDir, { recursive: true, force: true });
});

test("_executeAgent: toolCtx 透传 projectId/taskId/runId/currentStepId", async () => {
  // 编一个 spy router,只调一次 LLM 不发 tool_calls;
  // 但通过 register 一个 spy 工具,验证 ctx 被透传 —— 不,工具是 registry 内的,改个角度:
  // 用 list_todos 工具,创建一条 todo,验证 sourceStepId 是 step.id
  // (write_todo 会从 ctx.currentStepId 自动注入 sourceStepId)
  const router = makeFakeRouter([
    {
      text: "我建一条 todo",
      toolCalls: [{ function: { name: "write_todo", arguments: JSON.stringify({ action: "create", text: "完成模块 1" }) } }]
    },
    { text: "done" }
  ]);
  const host = makeHost({ aiRouter: router });
  const state = { runDir: makeRunDir(), projectId: "p1", taskId: "t1", id: "r1" };
  const step = { id: "outline-step", taskType: "outline" };
  await executeAgent(host, state, step, { taskType: "agent" }, ["write_todo"]);
  const todos = await host.todoStore.list(path.join(state.runDir, "agent-state"), {});
  assert.equal(todos.length, 1);
  assert.equal(todos[0].text, "完成模块 1");
  assert.equal(todos[0].sourceStepId, "outline-step", "ctx.currentStepId 应该被 write_todo 注入到 sourceStepId");
  await rm(state.runDir, { recursive: true, force: true });
});
