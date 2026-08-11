import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const agentExecutionActions = require("../src/application/workflows/mixins/agentExecutionActions.js");
const {
  DEFAULT_SUBAGENT_TOOL_NAMES,
  createAgentToolRegistry
} = require("../src/platform/ai/agentTools/index.js");

function makeRunDir() {
  return mkdtempSync(path.join(tmpdir(), "spawn-wiring-"));
}

function makeHost(overrides = {}) {
  class StubEngine {}
  Object.assign(StubEngine.prototype, agentExecutionActions);
  const host = new StubEngine();
  host.aiRouter = overrides.aiRouter || makeFakeRouter([{ text: "default" }]);
  host.artifactStore = overrides.artifactStore ?? null;
  host.todoStore = overrides.todoStore ?? null;
  host.checkpointStore = overrides.checkpointStore ?? null;
  host.projectService = overrides.projectService ?? null;
  host.referenceService = overrides.referenceService ?? null;
  host.webSearchService = overrides.webSearchService ?? null;
  host.toolPermissionService = { authorize: async () => ({ allow: true }) };
  host.shellSandboxFactory = async () => ({
    tempDir: tmpdir(),
    wrap: async (command) => command,
    cleanupAfterCommand() {},
    async cleanup() {}
  });
  return host;
}

function availableReadServices() {
  const scopedMemory = {
    search: async () => [],
    indexContext: async () => "<long-term-memory-index source=\"memory.md\">（当前 Memdir 为空）</long-term-memory-index>"
  };
  return {
    artifactStore: {},
    todoStore: {},
    checkpointStore: {},
    projectService: { memoryStore: { forContext: async () => scopedMemory } },
    referenceService: {},
    webSearchService: {}
  };
}

function makeFakeRouter(scripts = []) {
  let i = 0;
  const router = {
    invocations: 0,
    async runTask(args) {
      return (await router.runTaskDetailed(args)).content;
    },
    async runTaskDetailed(args) {
      router.invocations += 1;
      const script = scripts[i] || scripts[scripts.length - 1] || { text: "" };
      i += 1;
      return detailedScript(script, args, false, i);
    },
    async continueTaskDetailed(args) {
      router.invocations += 1;
      const script = scripts[i] || scripts[scripts.length - 1] || { text: "" };
      i += 1;
      return detailedScript(script, args, true, i);
    }
  };
  return router;
}

function detailedScript(script, args, continuation, sequence) {
  const toolCalls = (script.toolCalls || []).map((call, index) => ({
    id: call.id || `call_${sequence}_${index}`,
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
}

async function executeAgent(host, state, step, runTaskArgs, requestedToolNames) {
  const turn = await host._executeAgent({
    runTaskArgs: { taskType: "agent", ...runTaskArgs },
    projectId: state.projectId || "",
    taskId: state.taskId || "",
    runId: state.id || "",
    runDir: state.runDir || "",
    stepId: step.id || "",
    requestedToolNames,
    maxRounds: step.maxToolRounds
  });
  step.toolTrace = turn.toolTrace;
  if (turn.blocked) throw new Error(host._describeAgentStop(turn.stopCode, turn.toolTrace?.maxRounds));
  return turn.text;
}

test("createAgentToolRegistry 包含 spawn_subagent", () => {
  const main = createAgentToolRegistry();
  assert.ok(main.has("spawn_subagent"));
  assert.ok(main.has("manage_citations"));
});

test("DEFAULT_SUBAGENT_TOOL_NAMES 不含 spawn_subagent(防递归)", () => {
  assert.ok(!DEFAULT_SUBAGENT_TOOL_NAMES.includes("spawn_subagent"));
});

// ============ step.tools 不含 spawn 时 LLM 看不到 ============

test("非 Agent 内部调用不获得 Agent 工具", () => {
  const host = makeHost();
  assert.equal(host._resolveAgentTools(null), null);
  assert.equal(host._resolveAgentTools("internal"), null);
});

// ============ step.tools 显式声明 spawn 时能调用 ============

test("step.tools 显式含 spawn_subagent + LLM 调用 → trace 落 runs/<runId>/spawns/", async () => {
  // Agent 调 spawn_subagent；子任务不调用工具，直接回复并结束。
  const router = makeFakeRouter([
    // 主 agent 第一轮:发起 spawn
    {
      text: "我让一个子 agent 处理这事",
      toolCalls: [
        {
          function: {
            name: "spawn_subagent",
            arguments: JSON.stringify({
              purpose: "写一个聚焦场景",
              prompt: "写一个夜晚的酒馆场景,主角喝威士忌看雨。300 字以内。"
            })
          }
        }
      ]
    },
    // 子任务不调工具，直接回复并结束。
    { text: "雨夜的酒馆,主角推开吱呀作响的门..." },
    // 父任务第二轮看到返回结果后自然结束。
    { text: "子 agent 已完成,这是最终答案" }
  ]);
  const host = makeHost({ aiRouter: router, ...availableReadServices() });
  const state = { runDir: makeRunDir(), projectId: "p1", taskId: "t1", id: "r1" };
  const step = {
    id: "step-spawn-test",
    taskType: "draft",
    tools: ["spawn_subagent"]
  };
  const text = await executeAgent(host, state, step, {}, ["spawn_subagent"]);
  assert.equal(text, "子 agent 已完成,这是最终答案");
  assert.equal(step.toolTrace.toolCallsCount, 1);

  // 验证 spawn trace 落到 runs/<runId>/spawns/<spawnId>/
  const spawnsDir = path.join(state.runDir, "spawns");
  const spawnIds = readdirSync(spawnsDir);
  assert.equal(spawnIds.length, 1);
  assert.match(spawnIds[0], /^spawn_[a-f0-9]+$/);

  const traceFile = path.join(spawnsDir, spawnIds[0], "trace.jsonl");
  assert.equal(existsSync(path.join(spawnsDir, spawnIds[0], "output.md")), false);

  const traceContent = await readFile(traceFile, "utf8");
  const traceRow = JSON.parse(traceContent.trim());
  assert.equal(traceRow.spawnedByStepId, "step-spawn-test");
  assert.equal(traceRow.spawnedByTaskType, "agent");
  assert.match(traceRow.purposeDigest, /^[a-f0-9]{64}$/);
  assert.match(traceRow.promptDigest, /^[a-f0-9]{64}$/);
  assert.match(traceRow.resultDigest, /^[a-f0-9]{64}$/);
  assert.equal("purpose" in traceRow, false);
  assert.equal("prompt" in traceRow, false);
  assert.deepEqual(
    traceRow.allowedTools,
    DEFAULT_SUBAGENT_TOOL_NAMES.filter((name) => name !== "recall_handoff"),
    "canonical 子 Agent 只获得宿主实际可用的默认只读集"
  );
  await rm(state.runDir, { recursive: true, force: true });
});

test("spawn 路径与 sources/subagents 完全隔离(语义边界)", async () => {
  // 之前 multi-agent draft(executeDelegatedDraftStep)用 sources/subagents/,
  // 我们的 spawn 走 spawns/ —— 不应该出现在同一目录。
  const router = makeFakeRouter([
    {
      text: "spawn",
      toolCalls: [{ function: { name: "spawn_subagent", arguments: JSON.stringify({ purpose: "x", prompt: "y" }) } }]
    },
    { text: "subagent output" },
    { text: "done" }
  ]);
  const host = makeHost({ aiRouter: router, artifactStore: {} });
  const state = { runDir: makeRunDir(), projectId: "p1", taskId: "t1", id: "r1" };
  const step = { id: "s1", taskType: "draft", tools: ["spawn_subagent"] };
  await executeAgent(host, state, step, {}, ["spawn_subagent"]);
  const spawnsDir = path.join(state.runDir, "spawns");
  const sourcesSubagents = path.join(state.runDir, "sources", "subagents");
  assert.ok(readdirSync(spawnsDir).length > 0, "spawns/ 应有 trace");
  // sources/subagents 不应该被 spawn 工具污染
  try {
    readdirSync(sourcesSubagents);
    assert.fail("spawn 不应该写到 sources/subagents/");
  } catch (err) {
    assert.match(err.code, /ENOENT/, "sources/subagents/ 应该不存在");
  }
  await rm(state.runDir, { recursive: true, force: true });
});

test("step.tools=['spawn_subagent', 'read_artifact'] 与基础工具共同进入唯一 loop", async () => {
  const router = makeFakeRouter([{ text: "ok" }]); // 主 LLM 不调工具直接完
  const host = makeHost({ aiRouter: router, artifactStore: {} });
  const state = { runDir: makeRunDir(), projectId: "p1", taskId: "t1", id: "r1" };
  const step = { id: "s1", taskType: "draft", tools: ["spawn_subagent", "read_artifact"] };
  const text = await executeAgent(host, state, step, {}, ["spawn_subagent", "read_artifact"]);
  assert.equal(text, "ok");
  // 验证 toolTrace.toolNames 透传
  assert.deepEqual(step.toolTrace.toolNames, [
    "read", "write", "edit", "bash", "spawn_subagent", "read_artifact", "read_context_result"
  ]);
  await rm(state.runDir, { recursive: true, force: true });
});

test("subAgentTool 内部强制剔除 spawn_subagent(防递归,即使 allowedTools 误传也保险)", async () => {
  // spawn_subagent.execute 接 args.allowedTools 时会过滤掉 spawn_subagent 本身
  // 这是 P0 设计;我们这里端到端验证:即使主 LLM 给子 agent 传 allowedTools 含 spawn,
  // 子 agent 实际看不到 spawn,无法触发递归。
  const router = makeFakeRouter([
    {
      text: "spawn",
      toolCalls: [{
        function: {
          name: "spawn_subagent",
          arguments: JSON.stringify({
            purpose: "x",
            prompt: "y",
            allowedTools: ["spawn_subagent", "read_artifact"] // 故意传 spawn
          })
        }
      }]
    },
    { text: "sub done" },
    { text: "main done" }
  ]);
  const host = makeHost({ aiRouter: router, artifactStore: {} });
  const state = { runDir: makeRunDir(), projectId: "p1", taskId: "t1", id: "r1" };
  const step = { id: "s1", taskType: "draft", tools: ["spawn_subagent"] };
  await executeAgent(host, state, step, {}, ["spawn_subagent"]);
  const spawnsDir = path.join(state.runDir, "spawns");
  const spawnIds = readdirSync(spawnsDir);
  const traceFile = path.join(spawnsDir, spawnIds[0], "trace.jsonl");
  const row = JSON.parse((await readFile(traceFile, "utf8")).trim());
  assert.ok(!row.allowedTools.includes("spawn_subagent"), "子 agent 的 allowedTools 不应含 spawn(P0 设计保险)");
  assert.deepEqual(row.allowedTools, ["read_artifact"]);
  await rm(state.runDir, { recursive: true, force: true });
});
