import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const {
  AgentToolRegistry,
  createBaseToolRegistry,
  createAgentToolRegistry,
  spawnSubagentTool,
  DEFAULT_SUBAGENT_TOOL_NAMES
} = require("../src/platform/ai/agentTools/index.js");

function createDetailedRouter(responder) {
  let round = 0;
  const invoke = async (args, continuation) => {
    const value = await responder(args, round++, continuation);
    const content = typeof value === "string" ? value : `${value?.content || ""}`;
    const toolCalls = Array.isArray(value?.toolCalls) ? value.toolCalls : [];
    return {
      content,
      toolCalls,
      requestMessages: continuation ? (args.messages || []) : [{ role: "user", content: args.input || "" }],
      assistantMessage: { role: "assistant", content: content || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) }
    };
  };
  return {
    runTaskDetailed: (args) => invoke(args, false),
    continueTaskDetailed: (args) => invoke(args, true)
  };
}

test("createBaseToolRegistry 默认不挂 spawn_subagent（高级工具显式启用）", () => {
  const registry = createBaseToolRegistry();
  assert.equal(registry.has("recall_handoff"), true);
  assert.equal(registry.has("search_reference"), true);
  assert.equal(registry.has("spawn_subagent"), false);
});

test("createAgentToolRegistry 包含 spawn_subagent + 基础工具", () => {
  const registry = createAgentToolRegistry();
  assert.equal(registry.has("recall_handoff"), true);
  assert.equal(registry.has("search_reference"), true);
  assert.equal(registry.has("spawn_subagent"), true);
});

test("spawn_subagent 缺 ctx.aiRouter 返回友好错误而非崩溃", async () => {
  const result = await spawnSubagentTool.execute(
    { purpose: "test", prompt: "写一段开场" },
    {}
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /aiRouter/);
});

test("spawn_subagent 缺 prompt 直接返回错误", async () => {
  const fakeRouter = { runTask: async () => "x" };
  const registry = createBaseToolRegistry();
  const result = await spawnSubagentTool.execute(
    { purpose: "p" },
    { aiRouter: fakeRouter, registry }
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /prompt/);
});

test("spawn_subagent 在干净 context 跑子 toolLoop，返回 final text", async () => {
  let observedInput = null;
  const fakeRouter = createDetailedRouter(async (args) => {
      // 子 agent 应当只看到子 prompt，不应该有主 agent 的对话历史
      observedInput = args.input;
      return "子 agent 完成的开场段落";
  });
  const registry = createBaseToolRegistry();
  const result = await spawnSubagentTool.execute(
    { purpose: "写开场", prompt: "写一段悬疑开场，主角刘海" },
    { aiRouter: fakeRouter, registry }
  );
  assert.equal(result.ok, true);
  assert.equal(result.result, "子 agent 完成的开场段落");
  assert.equal(result.rounds, 1);
  assert.equal(result.toolCallsCount, 0);
  // 验证子 agent 看到的就是 prompt 参数，不含外部对话
  assert.equal(observedInput, "写一段悬疑开场，主角刘海");
});

test("spawn_subagent 默认 allowedTools 不含 spawn_subagent 自身（防递归爆栈）", async () => {
  assert.equal(DEFAULT_SUBAGENT_TOOL_NAMES.includes("spawn_subagent"), false);
});

test("spawn_subagent 即便调用方显式传入 spawn_subagent 也会过滤掉", async () => {
  let toolNamesSeenBySubagent = null;
  const fakeRouter = createDetailedRouter(async (args) => {
      toolNamesSeenBySubagent = (args.tools || []).map((t) => t?.function?.name);
      return "ok";
  });
  const registry = createAgentToolRegistry();
  await spawnSubagentTool.execute(
    {
      purpose: "test",
      prompt: "x",
      allowedTools: ["spawn_subagent", "search_reference"]
    },
    {
      aiRouter: fakeRouter,
      registry,
      checkpointStore: {},
      runDir: "/tmp/subagent-run",
      referenceService: {}
    }
  );
  assert.equal(toolNamesSeenBySubagent.includes("spawn_subagent"), false);
  // 宿主真实可用的其他工具保留。canonical 调用不伪造 handoffDir。
  assert.equal(toolNamesSeenBySubagent.includes("search_reference"), true);
});

test("spawn_subagent onTrace 保留执行期原值，但序列化 trace 只含安全元数据", async () => {
  const sentinel = "TRACE_SECRET_7c9f2b";
  const runDir = mkdtempSync(join(tmpdir(), "yaoguo-subagent-trace-"));
  const fakeRouter = createDetailedRouter(async (_args, round) => round === 0 ? ({
    content: "首轮调用了工具",
    toolCalls: [
      {
        id: "x",
        type: "function",
        function: {
          name: "read",
          arguments: JSON.stringify({ path: `facts-${sentinel}.md` })
        }
      }
    ]
  }) : `子 Agent 结果 ${sentinel}`);
  const registry = new AgentToolRegistry();
  registry.register({
    schema: { type: "function", function: { name: "read", description: "x", parameters: {} } },
    execute: async () => ({ fact: "A" })
  });
  let captured = null;
  try {
    await spawnSubagentTool.execute(
      {
        purpose: `test-${sentinel}`,
        prompt: `查 decisions，不要泄漏 ${sentinel}`,
        maxRounds: 2
      },
      {
        aiRouter: fakeRouter,
        registry,
        checkpointStore: {},
        runDir,
        onTrace: async (trace) => { captured = trace; }
      }
    );
    assert.ok(captured);
    assert.equal(captured.purpose, `test-${sentinel}`);
    assert.equal(captured.prompt, `查 decisions，不要泄漏 ${sentinel}`);
    assert.equal(captured.finalText, `子 Agent 结果 ${sentinel}`);
    assert.equal(captured.toolCallsTrace.length, 1);
    assert.equal(captured.toolCallsTrace[0].name, "read");
    assert.match(captured.rounds_outline[0].toolCalls[0].argsDigest, /^[a-f0-9]{64}$/);
    const serialized = JSON.stringify(captured);
    assert.equal(serialized.includes(sentinel), false);
    assert.equal(serialized.includes('"purpose"'), false);
    assert.equal(serialized.includes('"prompt"'), false);
    assert.equal(serialized.includes('"finalText"'), false);
    assert.equal(serialized.includes('"deniedTools"'), false);
    assert.equal(serialized.includes('"args"'), false);
    assert.equal(serialized.includes('"result"'), false);
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
});

test("spawn_subagent 仅执行模型显式给出的轮次预算，不添加宿主上限", async () => {
  const fakeRouter = createDetailedRouter(async (_args, round) => ({
    content: "x",
    toolCalls: [{
      id: `x${round}`,
      type: "function",
      function: {
        name: "read",
        arguments: JSON.stringify({ path: `round-${round}.md` })
      }
    }]
  }));
  const registry = new AgentToolRegistry();
  registry.register({
    schema: { type: "function", function: { name: "read", description: "x", parameters: {} } },
    execute: async () => ({ fact: "x" })
  });
  // 显式给 3 轮就执行 3 轮；宿主不再擅自改成固定 4/8 轮。
  const result = await spawnSubagentTool.execute(
    { purpose: "loop test", prompt: "x", maxRounds: 3 },
    { aiRouter: fakeRouter, registry, checkpointStore: {}, runDir: "/tmp/subagent-run" }
  );
  assert.equal(result.exhausted, true);
  assert.equal(result.rounds, 3);
});
