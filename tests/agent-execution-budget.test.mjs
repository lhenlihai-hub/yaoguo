import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  AgentToolRegistry,
  AgentExecutionBudget,
  runToolLoop,
  spawnSubagentTool
} = require("../src/platform/ai/agentTools/index.js");
const { executeSpawnSubagent } = require("../src/platform/ai/agentTools/subAgentTool.js");
const { judgeContentQuality } = require("../src/platform/ai/judges/contentQualityJudge.js");
const { llmJudgeQualityTool } = require("../src/platform/ai/agentTools/llmJudgeQualityTool.js");
const { getToolCapabilityPolicy } = require("../src/platform/ai/agentTools/toolCapabilityPolicy.js");
const { combineAbortSignals } = require("../src/platform/ai/agentTools/executionBudget.js");

function toolCall(id, name, args = {}) {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

function detailedRouter(responder) {
  let index = 0;
  const invocations = [];
  const invoke = async (args, continuation) => {
    invocations.push({ args, continuation });
    const value = await responder(index++, args, continuation);
    const content = typeof value === "string" ? value : `${value?.content || ""}`;
    const toolCalls = Array.isArray(value?.toolCalls) ? value.toolCalls : [];
    return {
      content,
      toolCalls,
      taskType: continuation ? args.base?.taskType : args.taskType,
      title: continuation ? args.base?.title : args.title,
      requestMessages: continuation ? args.messages : [{ role: "user", content: args.input || "" }],
      assistantMessage: { role: "assistant", content: content || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) }
    };
  };
  return {
    invocations,
    runTaskDetailed: (args) => invoke(args, false),
    continueTaskDetailed: (args) => invoke(args, true)
  };
}

function registerRead(registry, name, execute) {
  registry.register({
    schema: {
      type: "function",
      function: { name, description: `read ${name}`, parameters: { type: "object", properties: {} } }
    },
    execute,
    policy: { namespace: "budget-test", effect: "read", parallelSafe: true, repeat: "reuse", maxCallsPerLoop: 8 }
  });
}

test("combineAbortSignals 在 AbortSignal.any 不可用时仍保留 wall-clock deadline", async () => {
  const parent = new AbortController();
  const combined = combineAbortSignals(parent.signal, 20, {
    timeout: AbortSignal.timeout.bind(AbortSignal),
    any: undefined
  });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(combined.aborted, true);
  assert.equal(parent.signal.aborted, false);
});

test("AgentExecutionBudget 支持由交互式主 Agent 显式关闭总量与墙钟上限", () => {
  const parent = new AbortController();
  const budget = new AgentExecutionBudget({
    maxModelCalls: Number.POSITIVE_INFINITY,
    maxToolCalls: Number.POSITIVE_INFINITY,
    wallClockMs: Number.POSITIVE_INFINITY,
    signal: parent.signal
  });

  for (let index = 0; index < 40; index += 1) {
    assert.equal(budget.claim("model").ok, true);
    assert.equal(budget.claim("tool").ok, true);
  }
  const snapshot = budget.snapshot();
  assert.equal(snapshot.maxModelCalls, null);
  assert.equal(snapshot.remainingModelCalls, null);
  assert.equal(snapshot.maxToolCalls, null);
  assert.equal(snapshot.wallClockMs, null);
  assert.equal(snapshot.deadlineAt, null);
  assert.equal(budget.signal, parent.signal);
});

test("AgentExecutionBudget 默认不以宿主的任意额度限制模型工作方式", () => {
  const budget = new AgentExecutionBudget();
  const snapshot = budget.snapshot();
  assert.equal(snapshot.maxModelCalls, null);
  assert.equal(snapshot.maxToolCalls, null);
  assert.equal(snapshot.wallClockMs, null);
  assert.equal(snapshot.deadlineAt, null);
});

test("共享预算只统计真实执行，in-flight 读取复用不重复扣工具额度", async () => {
  const registry = new AgentToolRegistry();
  let executions = 0;
  registerRead(registry, "shared_read", async () => {
    executions += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { value: 1 };
  });
  const router = detailedRouter(async (round) => round === 0
    ? { toolCalls: [toolCall("a", "shared_read"), toolCall("b", "shared_read")] }
    : "完成");
  const result = await runToolLoop({
    aiRouter: router,
    registry,
    maxRounds: 2,
    maxTotalToolCalls: 1,
    maxTotalModelCalls: 3
  });
  assert.equal(executions, 1);
  assert.equal(result.contextStats.executionBudget.toolCalls, 1);
  assert.equal(result.contextStats.executionBudget.modelCalls, 2);
  assert.equal(result.text, "完成");
});

test("父 Agent、spawn 子 Agent 与子工具共享同一份全局预算", async () => {
  const registry = new AgentToolRegistry();
  registry.register(spawnSubagentTool);
  registerRead(registry, "recall_handoff", async () => ({ decisions: ["保留约束"] }));
  const router = detailedRouter(async (_round, args, continuation) => {
    const child = `${args.title || args.base?.title || ""}`.startsWith("subagent:");
    if (child && !continuation) return { toolCalls: [toolCall("read", "recall_handoff")] };
    if (child) return "子 Agent 完成";
    if (!continuation) return { toolCalls: [toolCall("spawn", "spawn_subagent", { purpose: "检查", prompt: "检查约束", maxRounds: 2 })] };
    return "父 Agent 完成";
  });
  const result = await runToolLoop({
    aiRouter: router,
    registry,
    toolNames: ["spawn_subagent"],
    // 本测试显式模拟历史 workflow handoff 作用域，不代表 canonical Agent 能力。
    toolCtx: {
      aiRouter: router,
      registry,
      checkpointStore: {},
      runDir: "/tmp/run",
      handoffDir: "/tmp/run"
    },
    runTaskArgs: { taskType: "draft" },
    maxRounds: 2,
    maxTotalModelCalls: 4,
    maxTotalToolCalls: 2
  });
  assert.equal(result.text, "父 Agent 完成");
  assert.equal(result.contextStats.executionBudget.modelCalls, 4);
  assert.equal(result.contextStats.executionBudget.toolCalls, 2);
  assert.equal(router.invocations.length, 4);
});

test("父级 AbortSignal 直接阻止子 Agent 启动模型调用", async () => {
  const controller = new AbortController();
  const budget = new AgentExecutionBudget({ maxModelCalls: 4, maxToolCalls: 2, signal: controller.signal });
  controller.abort("user cancelled");
  const router = detailedRouter(async () => "不应执行");
  const registry = new AgentToolRegistry();
  const result = await executeSpawnSubagent(
    { purpose: "取消测试", prompt: "执行任务" },
    { aiRouter: router, registry, executionBudget: budget }
  );
  assert.equal(result.ok, false);
  assert.equal(result.exhausted, true);
  assert.equal(router.invocations.length, 0);
  assert.equal(budget.snapshot().stopCode, "AGENT_ABORTED");
});

test("LLM judge 多采样逐次扣模型预算、透传共享 signal 并默认保留一次后续调用", async () => {
  const budget = new AgentExecutionBudget({ maxModelCalls: 2, maxToolCalls: 1 });
  const invocations = [];
  const aiRouter = {
    async runTask(args) {
      invocations.push(args);
      return JSON.stringify({ scores: { information_density: 5 }, findings: [], summary: "" });
    }
  };
  const result = await judgeContentQuality({
    aiRouter,
    text: "待评文本",
    dimensions: ["information_density"],
    samples: 5,
    executionBudget: budget
  });
  assert.equal(result.modelInvocations, 1);
  assert.equal(result.samples, 1);
  assert.equal(result.budgetExhausted, true);
  assert.equal(result.stopCode, "AGENT_MODEL_BUDGET_RESERVED_FOR_PARENT");
  assert.equal(budget.remaining("model"), 1);
  assert.ok(invocations.every((args) => args.signal === budget.signal));
});

test("工具结果后的自然响应直接成为 Universal Agent 交付，不再追加 final pass", async () => {
  const registry = new AgentToolRegistry();
  registerRead(registry, "fact_read", async () => ({ fact: 42 }));
  const streamed = [];
  const router = detailedRouter(async (round) => round === 0
    ? { toolCalls: [toolCall("read", "fact_read")] }
    : { content: "基于工具结果完成的答案" });
  const result = await runToolLoop({
    aiRouter: router,
    registry,
    runTaskArgs: { taskType: "agent", onToken: (token) => streamed.push(token) },
    maxRounds: 3,
    maxTotalModelCalls: 2
  });
  assert.equal(result.exhausted, false);
  assert.equal(result.text, "基于工具结果完成的答案");
  assert.equal(result.stopCode, "");
  assert.equal(result.contextStats.executionBudget.modelCalls, 2);
  assert.deepEqual(streamed, []);
});

test("子 Agent 与父 Agent 共用预算，父 Agent 以一次自然续轮完成交付", async () => {
  const registry = new AgentToolRegistry();
  registry.register(spawnSubagentTool);
  registerRead(registry, "recall_handoff", async () => ({ decisions: ["已读取"] }));

  let childModelCalls = 0;
  let parentToolContinuations = 0;
  const router = detailedRouter(async (index, args, continuation) => {
    const title = `${args.title || args.base?.title || ""}`;
    if (title.startsWith("subagent:")) {
      childModelCalls += 1;
      return { toolCalls: [toolCall(`child-read-${index}`, "recall_handoff")] };
    }
    if (!continuation) {
      return {
        toolCalls: [toolCall("spawn", "spawn_subagent", {
          purpose: "耗尽轮次验证",
          prompt: "每轮都读取交接，直到子 Agent 轮次耗尽。",
          maxRounds: 4
        })]
      };
    }
    parentToolContinuations += 1;
    return { content: "父 Agent 最终交付" };
  });

  const result = await runToolLoop({
    aiRouter: router,
    registry,
    toolNames: ["spawn_subagent"],
    // 本测试显式模拟历史 workflow handoff 作用域，不代表 canonical Agent 能力。
    toolCtx: {
      aiRouter: router,
      registry,
      checkpointStore: {},
      runDir: "/tmp/run",
      handoffDir: "/tmp/run"
    },
    runTaskArgs: { taskType: "agent", title: "父 Universal Agent" },
    maxRounds: 3,
    maxTotalModelCalls: 5,
    maxTotalToolCalls: 8
  });

  assert.equal(childModelCalls, 3);
  assert.equal(parentToolContinuations, 1);
  assert.equal(result.text, "父 Agent 最终交付");
  assert.equal(result.exhausted, false);
  assert.equal(result.contextStats.executionBudget.modelCalls, 5);
});

test("LLM judge 与父 Agent 共用预算，评审后由自然续轮直接交付", async () => {
  const registry = new AgentToolRegistry();
  registry.register(llmJudgeQualityTool);

  let judgeModelCalls = 0;
  let parentToolContinuations = 0;
  const detailed = detailedRouter(async (_index, args, continuation) => {
    if (!continuation) {
      return {
        toolCalls: [toolCall("judge", "llm_judge_quality", {
          text: "待评文本",
          dimensions: ["information_density"],
          samples: 5
        })]
      };
    }
    parentToolContinuations += 1;
    return { content: "含评审结论的最终交付" };
  });
  const router = {
    ...detailed,
    async runTask() {
      judgeModelCalls += 1;
      return JSON.stringify({ scores: { information_density: 8 }, findings: [], summary: "通过" });
    }
  };

  const result = await runToolLoop({
    aiRouter: router,
    registry,
    toolNames: ["llm_judge_quality"],
    toolCtx: { aiRouter: router },
    runTaskArgs: { taskType: "agent", title: "父 Universal Agent" },
    maxRounds: 3,
    maxTotalModelCalls: 4,
    maxTotalToolCalls: 2
  });

  assert.equal(judgeModelCalls, 2);
  assert.equal(parentToolContinuations, 1);
  assert.equal(result.text, "含评审结论的最终交付");
  assert.equal(result.exhausted, false);
  assert.equal(result.contextStats.executionBudget.modelCalls, 4);
});

test("model_compute 工具不得在同一轮并发争抢共享预算", () => {
  assert.equal(getToolCapabilityPolicy("spawn_subagent").parallelSafe, false);
  assert.equal(getToolCapabilityPolicy("llm_judge_quality").parallelSafe, false);
});

test("Universal Agent 的自然续轮遇到 AbortError 时返回中止态", async () => {
  const controller = new AbortController();
  const registry = new AgentToolRegistry();
  registerRead(registry, "abort_read", async () => ({ fact: 42 }));
  const router = detailedRouter(async (round, args) => {
    if (round === 0) return { toolCalls: [toolCall("abort-read", "abort_read")] };
    assert.equal(args.agentStage, "tool");
    controller.abort("cancel during continuation");
    const error = new Error("cancel during continuation");
    error.name = "AbortError";
    throw error;
  });

  const result = await runToolLoop({
    aiRouter: router,
    registry,
    toolNames: ["abort_read"],
    runTaskArgs: { taskType: "agent", signal: controller.signal },
    maxRounds: 3,
    maxTotalModelCalls: 5
  });

  assert.equal(result.text, "");
  assert.equal(result.exhausted, true);
  assert.equal(result.aborted, true);
  assert.equal(result.budgetExhausted, false);
  assert.equal(result.stopCode, "AGENT_ABORTED");
  assert.equal(result.contextStats.executionBudget.stopCode, "AGENT_ABORTED");
});
