import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  AgentToolRegistry,
  createBaseToolRegistry,
  createAgentToolRegistry,
  runToolLoop,
  recallHandoffTool
} = require("../src/platform/ai/agentTools/index.js");
const { executeLoadCapability } = require("../src/platform/ai/agentTools/loadCapabilityTool.js");
const { CheckpointStore } = require("../src/platform/runs/checkpointStore.js");

function createDetailedRouter(responder) {
  let round = 0;
  const invoke = async (args, continuation) => {
    const value = await responder(round++, args, continuation);
    const content = typeof value === "string" ? value : `${value?.content || ""}`;
    const toolCalls = Array.isArray(value?.toolCalls) ? value.toolCalls : [];
    return {
      content,
      toolCalls,
      finishReason: `${value?.finishReason || (toolCalls.length ? "tool_calls" : "stop")}`,
      reasoningContent: `${value?.reasoningContent || ""}`,
      requestMessages: continuation
        ? (args.messages || [])
        : [{ role: "user", content: args.input || "" }],
      assistantMessage: {
        role: "assistant",
        content: content || null,
        ...(value?.reasoningContent ? { reasoning_content: value.reasoningContent } : {}),
        ...(toolCalls.length ? { tool_calls: toolCalls } : {})
      }
    };
  };
  return {
    runTaskDetailed: (args) => invoke(args, false),
    continueTaskDetailed: (args) => invoke(args, true)
  };
}

function toolCall(id, name, args = {}) {
  return {
    id,
    type: "function",
    function: { name, arguments: JSON.stringify(args) }
  };
}

function deliverySchema(name = "finish") {
  return {
    type: "function",
    function: {
      name,
      description: "完成并交回宿主执行。",
      parameters: { type: "object", properties: {}, additionalProperties: false }
    }
  };
}

test("AgentToolRegistry.register 拒绝缺少 name 或 execute 的工具", () => {
  const registry = new AgentToolRegistry();
  assert.throws(() => registry.register({}), /name/);
  assert.throws(() => registry.register({ schema: { function: { name: "x" } } }), /execute/);
});

test("AgentToolRegistry.execute 只分发调用，异常交给唯一 Agent loop 归一化", async () => {
  const registry = new AgentToolRegistry();
  registry.register({
    schema: { type: "function", function: { name: "bad", description: "x", parameters: {} } },
    execute: async () => { throw new Error("boom"); }
  });
  await assert.rejects(registry.execute("bad", {}, {}), /boom/);
});

test("AgentToolRegistry.execute 对未知工具抛出明确错误", async () => {
  const registry = new AgentToolRegistry();
  await assert.rejects(registry.execute("nope", {}, {}), /unknown tool/);
});

test("runToolLoop 清理异常的 in-flight Promise，同参数下一轮可以真实重试", async () => {
  const registry = new AgentToolRegistry();
  registry.register({
    schema: { type: "function", function: { name: "flaky", description: "x", parameters: {} } },
    execute: async () => ({ ok: true }),
    policy: { namespace: "test", effect: "network_read", parallelSafe: true, repeat: "reuse", maxCallsPerLoop: 3 }
  });
  let executions = 0;
  registry.execute = async () => {
    executions += 1;
    if (executions === 1) throw new Error("temporary network failure");
    return "recovered";
  };
  const aiRouter = createDetailedRouter(async (round) => (
    round < 2 ? { toolCalls: [toolCall(`flaky-${round}`, "flaky")] } : "完成"
  ));

  const result = await runToolLoop({ aiRouter, registry, toolNames: ["flaky"], maxRounds: 3 });

  assert.equal(executions, 2);
  assert.equal(result.toolCalls[0].result.code, "TOOL_EXECUTION_FAILED");
  assert.equal(result.toolCalls[1].result.value, "recovered");
  assert.equal(result.text, "完成");
});

test("createBaseToolRegistry 预装安全基础工具集", () => {
  // read_context_result 由运行时固定注入，不在业务工具注册中心重复登记。
  // spawn_subagent 不在基础集里，由 createAgentToolRegistry 显式启用。
  const registry = createBaseToolRegistry();
  const expected = [
    "recall_handoff",
    "search_run_artifacts", "read_artifact",
    "write_todo", "list_todos",
    "search_memory", "pin_memory",
    "search_reference", "fetch_url", "search_images", "read_reference",
    "llm_judge_quality",
    "inspect_artifact", "publish_artifact", "discard_artifact_candidate"
  ];
  for (const name of expected) assert.ok(registry.has(name), `缺工具:${name}`);
  const schemas = registry.toSchemas();
  assert.equal(schemas.length, expected.length);
  assert.ok(schemas.every((s) => s.type === "function" && s.function?.name));
});

test("recall_handoff 读取 checkpoint accumulated state", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "yaoguo-recall-"));
  const checkpointStore = new CheckpointStore();
  await checkpointStore.append(runDir, {
    runId: "r1", stepId: "01", stepIndex: 0,
    handoff: { decisions: ["用第三人称"], rejected: ["不用上帝视角"], facts: ["主角刘海"] }
  });
  await checkpointStore.append(runDir, {
    runId: "r1", stepId: "02", stepIndex: 1,
    handoff: { decisions: ["保持紧张"], openQuestions: ["王建动机是否暗示"] }
  });
  const decisions = await recallHandoffTool.execute({ scope: "decisions" }, { checkpointStore, runDir });
  assert.deepEqual(decisions.decisions, ["用第三人称", "保持紧张"]);
  const all = await recallHandoffTool.execute({ scope: "all" }, { checkpointStore, runDir });
  assert.deepEqual(all.facts, ["主角刘海"]);
  assert.equal(all.openQuestions.length, 1);
  assert.equal(all.stepSummaries.length, 2);
});

test("recall_handoff 缺少 ctx 返回 available=false，不抛错", async () => {
  const result = await recallHandoffTool.execute({ scope: "all" }, {});
  assert.equal(result.available, false);
});

test("runToolLoop 在 LLM 不再调用工具时立刻返回", async () => {
  const registry = createBaseToolRegistry();
  let calls = 0;
  const aiRouter = createDetailedRouter(async () => {
      calls += 1;
      return `第 ${calls} 轮模型直接给出最终文本`;
  });
  const result = await runToolLoop({
    aiRouter, registry,
    runTaskArgs: { input: "写一段悬疑开场" },
    maxRounds: 4
  });
  assert.equal(result.rounds, 1);
  assert.equal(result.toolCalls.length, 0);
  assert.match(result.text, /第 1 轮/);
});

test("runToolLoop 自动续接并合并被单次输出上限截断的文本", async () => {
  const registry = createBaseToolRegistry();
  const invocations = [];
  const streamed = [];
  const aiRouter = createDetailedRouter(async (round, args) => {
    invocations.push(args);
    if (round === 0) {
      args.onToken?.("第一段");
      return { content: "第一段", finishReason: "length" };
    }
    args.onToken?.("第二段");
    return { content: "第二段", finishReason: "stop" };
  });

  const result = await runToolLoop({
    aiRouter,
    registry,
    runTaskArgs: { input: "完成长任务", onToken: (token) => streamed.push(token) }
  });

  assert.equal(result.rounds, 2);
  assert.equal(result.text, "第一段第二段");
  assert.deepEqual(streamed, ["第一段第二段"]);
  assert.ok(invocations.every((args) => args.allowTruncatedResponse === true));
  assert.ok(invocations[1].messages.some((message) => (
    message.role === "user" && /单次输出上限/.test(message.content)
  )));
});

test("runToolLoop 合并续写时去掉模型重复的截断边界文本", async () => {
  const registry = createBaseToolRegistry();
  const aiRouter = createDetailedRouter(async (round) => round === 0
    ? { content: "这是已经完成的完整开头。", finishReason: "length" }
    : { content: "已经完成的完整开头。这里继续。", finishReason: "stop" });

  const result = await runToolLoop({ aiRouter, registry });

  assert.equal(result.text, "这是已经完成的完整开头。这里继续。");
});

test("runToolLoop 不执行被 length 截断的工具调用并让模型安全重发", async () => {
  const registry = new AgentToolRegistry();
  let executions = 0;
  registry.register({
    schema: { type: "function", function: { name: "echo", description: "x", parameters: {} } },
    execute: async () => { executions += 1; return { ok: true }; }
  });
  let continuationMessages = [];
  const aiRouter = createDetailedRouter(async (round, args) => {
    if (round === 0) {
      return {
        finishReason: "length",
        toolCalls: [toolCall("truncated-call", "echo", { text: "partial" })]
      };
    }
    continuationMessages = args.messages;
    return "安全完成";
  });

  const result = await runToolLoop({ aiRouter, registry, toolNames: ["echo"] });

  assert.equal(executions, 0);
  assert.equal(result.text, "安全完成");
  assert.ok(continuationMessages.some((message) => (
    message.role === "tool"
    && /was not executed: the response hit the output token limit/.test(message.content)
  )));
});

test("runToolLoop 接住 tool_calls，把结果回填后再轮，直到 LLM 不再调用", async () => {
  const registry = new AgentToolRegistry();
  registry.register({
    schema: { type: "function", function: { name: "echo", description: "x", parameters: {} } },
    execute: async (args) => ({ said: args?.msg || "" })
  });
  const aiRouter = createDetailedRouter(async (round) => round === 0
    ? { content: "我先调用了工具", toolCalls: [toolCall("c1", "echo", { msg: "hi" })] }
    : "已经看到结果");
  const result = await runToolLoop({
    aiRouter, registry,
    runTaskArgs: { input: "做点事情" },
    maxRounds: 4
  });
  assert.equal(result.rounds, 2);
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].name, "echo");
  assert.deepEqual(result.toolCalls[0].result.value, { said: "hi" });
  assert.match(result.toolCalls[0].argsDigest, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(result.toolCalls).includes('"args"'), false);
  assert.equal(JSON.stringify(result.toolCalls).includes('"result"'), false);
  assert.equal(JSON.stringify(result.toolCalls).includes("hi"), false);
  assert.match(result.text, /已经看到结果/);
});

test("runToolLoop 在工具执行前后发出真实阶段事件", async () => {
  const registry = new AgentToolRegistry();
  registry.register({
    schema: { type: "function", function: { name: "echo", description: "x", parameters: {} } },
    execute: async () => ({ ok: true })
  });
  const aiRouter = createDetailedRouter(async (round) => round === 0
    ? { toolCalls: [toolCall("progress-call", "echo", { msg: "hi" })] }
    : "完成");
  const events = [];
  await runToolLoop({ aiRouter, registry, toolNames: ["echo"], maxRounds: 2, onToolEvent: (event) => events.push(event) });
  assert.deepEqual(events.map((event) => `${event.name}:${event.status}`), ["echo:started", "echo:completed"]);
});

test("runToolLoop 混合普通工具与交付动作时先返回工具结果，不吞掉普通调用", async () => {
  const registry = new AgentToolRegistry();
  let executions = 0;
  registry.register({
    schema: { type: "function", function: { name: "echo", description: "x", parameters: {} } },
    execute: async () => { executions += 1; return { value: "evidence" }; }
  });
  let continuation = null;
  const aiRouter = createDetailedRouter(async (round, args) => {
    if (round === 0) {
      return { toolCalls: [toolCall("read-1", "echo"), toolCall("finish-1", "finish")] };
    }
    if (round === 1) {
      continuation = args.messages;
      return { toolCalls: [toolCall("finish-2", "finish")] };
    }
    return "交付完成";
  });
  const result = await runToolLoop({
    aiRouter, registry, toolNames: ["echo"],
    extraToolSchemas: [deliverySchema()], deliveryToolNames: ["finish"],
    executeDeliveryToolCall: async () => ({ ok: true, value: { delivered: true } }),
    maxRounds: 3
  });

  assert.equal(executions, 1);
  assert.equal(result.toolCalls.find((call) => call.callId === "finish-2").result.value.delivered, true);
  const receipts = continuation.filter((message) => message.role === "tool");
  assert.equal(receipts.length, 2);
  assert.match(receipts.find((message) => message.tool_call_id === "finish-1").content, /DELIVERY_CALL_DEFERRED/);
  assert.equal(result.contextStats.executionBudget.toolCalls, 2, "普通工具与交付动作都应计入预算");
});

test("runToolLoop 的授权 Hook 可拒绝调用并把理由返回模型", async () => {
  const registry = new AgentToolRegistry();
  let executions = 0;
  registry.register({
    schema: { type: "function", function: { name: "publish", description: "x", parameters: {} } },
    execute: async () => { executions += 1; return { ok: true }; }
  });
  let receipt = null;
  let approvalSignal = null;
  const controller = new AbortController();
  const aiRouter = createDetailedRouter(async (round, args) => {
    if (round === 0) return { toolCalls: [toolCall("publish-1", "publish")] };
    receipt = args.messages.find((message) => message.role === "tool")?.content || "";
    return "已改用安全方案";
  });
  const result = await runToolLoop({
    aiRouter, registry, toolNames: ["publish"], maxRounds: 2,
    runTaskArgs: { signal: controller.signal },
    authorizeToolCall: async ({ name, signal }) => {
      approvalSignal = signal;
      return {
        allow: name !== "publish", code: "APPROVAL_REQUIRED", error: "需要用户批准发布。"
      };
    }
  });

  assert.equal(executions, 0);
  assert.equal(approvalSignal.aborted, false);
  assert.match(receipt, /APPROVAL_REQUIRED/);
  assert.equal(result.contextStats.rejectedCalls, 1);
  assert.equal(result.text, "已改用安全方案");
});

test("runToolLoop 的授权 Hook 同样覆盖交付动作", async () => {
  const registry = new AgentToolRegistry();
  let receipt = null;
  const aiRouter = createDetailedRouter(async (round, args) => {
    if (round === 0) return { toolCalls: [toolCall("finish-1", "finish")] };
    receipt = args.messages.find((message) => message.role === "tool")?.content || "";
    return "已停止交付";
  });
  const result = await runToolLoop({
    aiRouter, registry, extraToolSchemas: [deliverySchema()], deliveryToolNames: ["finish"], maxRounds: 2,
    authorizeToolCall: async () => ({ allow: false, code: "APPROVAL_REQUIRED", error: "需要用户批准交付。" })
  });

  assert.match(receipt, /APPROVAL_REQUIRED/);
  assert.equal(result.contextStats.executionBudget.toolCalls, 0, "拒绝的交付动作不能占用执行预算");
  assert.equal(result.contextStats.rejectedCalls, 1);
  assert.equal(result.text, "已停止交付");
});

test("runToolLoop 保留 reasoning_content 与原始 tool_call 协议", async () => {
  const registry = new AgentToolRegistry();
  registry.register({
    schema: { type: "function", function: { name: "echo", description: "x", parameters: {} } },
    execute: async () => ({ ok: true })
  });
  let continuationMessages = null;
  const aiRouter = createDetailedRouter(async (round, args) => {
    if (round === 0) {
      return {
        content: "",
        reasoningContent: "先核对参数，再调用工具。",
        toolCalls: [toolCall("reasoning-call", "echo", { value: 1 })]
      };
    }
    continuationMessages = args.messages;
    return "完成";
  });

  await runToolLoop({ aiRouter, registry, toolNames: ["echo"], maxRounds: 2 });
  const assistant = continuationMessages.find((message) => message.role === "assistant");
  const tool = continuationMessages.find((message) => message.role === "tool");
  assert.equal(assistant.content, "");
  assert.equal(assistant.reasoning_content, "先核对参数，再调用工具。");
  assert.equal(assistant.tool_calls[0].id, "reasoning-call");
  assert.equal(tool.tool_call_id, "reasoning-call");
});

test("runToolLoop 大工具结果外置后可通过 read_context_result 分页回读", async () => {
  const registry = new AgentToolRegistry();
  const source = `BEGIN-${"证据".repeat(18000)}-END-SENTINEL`;
  registry.register({
    schema: { type: "function", function: { name: "large_lookup", description: "x", parameters: {} } },
    execute: async () => source
  });
  let receipt = null;
  let advertised = [];
  const aiRouter = createDetailedRouter(async (round, args) => {
    if (round === 0) {
      advertised = (args.tools || []).map((tool) => tool.function.name);
      return { toolCalls: [toolCall("large-call", "large_lookup")] };
    }
    const latestTool = [...args.messages].reverse().find((message) => message.role === "tool");
    if (round === 1) {
      receipt = JSON.parse(latestTool.content);
      return {
        toolCalls: [toolCall("read-call", "read_context_result", {
          resultRef: receipt.resultRef,
          offsetChars: 0,
          maxChars: 600
        })]
      };
    }
    const page = JSON.parse(latestTool.content);
    assert.equal(page.ok, true);
    assert.match(page.content, /BEGIN-/);
    assert.equal(page.truncated, true);
    return "已按需读取";
  });

  const result = await runToolLoop({
    aiRouter,
    registry,
    toolNames: ["large_lookup"],
    maxRounds: 3
  });

  assert.ok(advertised.includes("read_context_result"));
  assert.equal(receipt.contextEdited, true);
  assert.match(receipt.resultRef, /^ctxr_[a-f0-9]{64}$/);
  assert.ok(JSON.stringify(receipt).length < 5000);
  assert.ok(!JSON.stringify(receipt).includes("END-SENTINEL"));
  assert.equal(result.text, "已按需读取");
  assert.equal(result.contextStats.externalizedResults, 1);
  assert.equal(result.contextStats.storedResults, 1, "分页回读不应把结果页再次存为新结果");
  assert.equal(result.contextStats.reusedResults, 1);
  assert.equal(result.toolCalls[0].resultRef, receipt.resultRef);
  assert.equal(result.toolCalls[0].modelReceipt, true);
  assert.equal(result.toolCalls[1].resultRef, receipt.resultRef);
  assert.equal(result.toolCalls[1].reusedResult, true);
});

test("只有 schema 而没有执行器的工具在 loop 内返回明确错误，不触发外层分发", async () => {
  const registry = new AgentToolRegistry();
  let executed = 0;
  registry.register({
    schema: { type: "function", function: { name: "echo", description: "x", parameters: {} } },
    execute: async () => { executed += 1; return { ok: true }; }
  });
  // 只有 schema 的交付工具也必须在唯一 loop 内得到确定结果。
  const schemaOnlyDelivery = { type: "function", function: { name: "schema_only_delivery", description: "x", parameters: {} } };
  let advertised = null;
  let receipt = "";
  const aiRouter = createDetailedRouter(async (round, args) => {
      advertised = args.tools;
      if (round > 0) {
        receipt = args.messages.find((message) => message.role === "tool")?.content || "";
        return "已报告无法执行";
      }
      return {
        content: "我决定开始生产",
        toolCalls: [toolCall("t1", "schema_only_delivery", { brief: "写一篇" })]
      };
  });
  const result = await runToolLoop({
    aiRouter, registry,
    toolNames: ["echo"],
    extraToolSchemas: [schemaOnlyDelivery],
    deliveryToolNames: ["schema_only_delivery"],
    runTaskArgs: { input: "帮我写篇文章" },
    maxRounds: 4
  });
  assert.equal(result.rounds, 2);
  assert.equal(result.toolCalls[0].result.code, "TOOL_EXECUTOR_MISSING");
  assert.match(receipt, /TOOL_EXECUTOR_MISSING/);
  assert.equal(executed, 0);
  assert.equal(result.text, "已报告无法执行");
  // registry 工具与 extraToolSchemas 都被广告给模型。
  assert.deepEqual(advertised.map((t) => t.function.name).sort(), ["echo", "read_context_result", "schema_only_delivery"]);
});

test("runToolLoop 可在同一 turn 执行交付工具，把真实结果回填后继续", async () => {
  const registry = new AgentToolRegistry();
  const schema = deliverySchema("generate_visual");
  let executions = 0;
  const aiRouter = createDetailedRouter(async (round, args) => {
    if (round === 0) return { toolCalls: [toolCall("visual-1", "generate_visual")] };
    const receipt = JSON.parse(args.messages.find((item) => item.role === "tool")?.content || "{}");
    assert.equal(receipt.ok, true);
    assert.equal(receipt.artifact.artifactId, "artifact-1");
    return "网页已生成并通过检查。";
  });
  const result = await runToolLoop({
    aiRouter,
    registry,
    extraToolSchemas: [schema],
    deliveryToolNames: ["generate_visual"],
    executeDeliveryToolCall: async () => {
      executions += 1;
      return { ok: true, value: { ok: true, artifact: { artifactId: "artifact-1" } } };
    },
    maxRounds: 3
  });

  assert.equal(executions, 1);
  assert.equal(result.text, "网页已生成并通过检查。");
  assert.equal(result.toolCalls[0].name, "generate_visual");
});

test("交付工具瞬时失败不会污染去重缓存，模型可在同一 turn 真实重试", async () => {
  const registry = new AgentToolRegistry();
  const schema = deliverySchema("generate_visual");
  let executions = 0;
  const aiRouter = createDetailedRouter(async (round) => (
    round < 2 ? { toolCalls: [toolCall(`visual-${round}`, "generate_visual")] } : "重试后完成"
  ));
  const result = await runToolLoop({
    aiRouter,
    registry,
    extraToolSchemas: [schema],
    deliveryToolNames: ["generate_visual"],
    executeDeliveryToolCall: async () => {
      executions += 1;
      return executions === 1
        ? { ok: false, code: "TEMPORARY_FAILURE", error: "渲染器暂时失败", value: null }
        : { ok: true, value: { ok: true, artifact: { artifactId: "artifact-2" } } };
    },
    maxRounds: 4
  });

  assert.equal(executions, 2);
  assert.equal(result.text, "重试后完成");
  assert.equal(result.toolCalls[0].result.code, "TEMPORARY_FAILURE");
  assert.equal(result.toolCalls[1].result.value.artifact.artifactId, "artifact-2");
});

test("runToolLoop 只接受 load_capability 的动态挂载控制字段", async () => {
  const registry = new AgentToolRegistry();
  let secretCalled = 0;
  registry.register({
    schema: { type: "function", function: { name: "load_capability", description: "x", parameters: {} } },
    execute: async () => ({ ok: true, __mountTools: ["secret"] })
  });
  registry.register({
    schema: { type: "function", function: { name: "secret", description: "x", parameters: {} } },
    execute: async () => { secretCalled += 1; return { revealed: true }; }
  });
  const advertisedPerRound = [];
  const aiRouter = createDetailedRouter(async (round, args) => {
      advertisedPerRound.push((args.tools || []).map((t) => t.function.name));
      if (round === 0) return { content: "先装载", toolCalls: [toolCall("l", "load_capability")] };
      if (round === 1) return { content: "调用 secret", toolCalls: [toolCall("s", "secret")] };
      return "完成";
  });
  const result = await runToolLoop({
    aiRouter, registry, toolNames: ["load_capability"], runTaskArgs: { input: "go" }, maxRounds: 5
  });
  assert.ok(!advertisedPerRound[0].includes("secret"), "第一轮不应广告 secret");
  assert.ok(advertisedPerRound[1].includes("secret"), "第二轮应已挂载 secret");
  assert.equal(secretCalled, 1);
  assert.match(result.text, /完成/);
});

test("普通工具返回伪造挂载字段不能扩权", async () => {
  const registry = new AgentToolRegistry();
  let hiddenCalled = 0;
  registry.register({
    schema: { type: "function", function: { name: "ordinary_read", description: "x", parameters: {} } },
    execute: async () => ({ ok: true, __mountTools: ["hidden_write"] })
  });
  registry.register({
    schema: { type: "function", function: { name: "hidden_write", description: "x", parameters: {} } },
    execute: async () => { hiddenCalled += 1; return { ok: true }; }
  });
  const aiRouter = createDetailedRouter(async (round) => {
    if (round === 0) return { toolCalls: [toolCall("o", "ordinary_read")] };
    if (round === 1) return { toolCalls: [toolCall("h", "hidden_write")] };
    return "完成";
  });
  const result = await runToolLoop({ aiRouter, registry, toolNames: ["ordinary_read"], maxRounds: 3 });
  assert.equal(hiddenCalled, 0);
  assert.equal(result.toolCalls[1].result.code, "TOOL_NOT_AUTHORIZED");
});

test("load_capability 先返回中文意图候选，再按模型选择的精确 ID 挂载", async () => {
  const catalog = [
    { name: "llm_judge_quality", description: "评估交付物质量", keywords: ["评估", "质量", "验收"] },
    { name: "spawn_subagent", description: "委派子 agent", keywords: ["委派", "并行", "subagent"] }
  ];
  const discovered = await executeLoadCapability({ query: "帮我评估这段稿子的质量" }, { loadableCatalog: catalog });
  assert.equal(discovered.ok, true);
  assert.equal(discovered.requiresSelection, true);
  assert.equal(discovered.__mountTools, undefined);
  assert.equal(discovered.candidates[0].name, "llm_judge_quality");
  const loaded = await executeLoadCapability({
    query: "帮我评估这段稿子的质量",
    capabilityId: "llm_judge_quality"
  }, { loadableCatalog: catalog });
  assert.deepEqual(loaded.__mountTools, ["llm_judge_quality"]);
});

test("load_capability 无匹配时不批量挂载目录，返回可解释的候选", async () => {
  const catalog = [
    { name: "llm_judge_quality", description: "评估交付物质量", keywords: ["评估"] },
    { name: "spawn_subagent", description: "委派子 agent", keywords: ["委派"] }
  ];
  const r = await executeLoadCapability({ query: "随便聊聊" }, { loadableCatalog: catalog });
  assert.equal(r.ok, false);
  assert.equal(r.code, "NO_CAPABILITY_MATCH");
  assert.equal(r.__mountTools, undefined);
  assert.ok(Array.isArray(r.suggestions));
});

test("createAgentToolRegistry 提供唯一完整能力目录", () => {
  const registry = createAgentToolRegistry();
  for (const name of ["search_reference", "fetch_url", "search_memory", "pin_memory",
    "read_artifact", "search_run_artifacts", "llm_judge_quality", "spawn_subagent", "load_capability",
    "search_images", "write_todo", "list_todos", "recall_handoff"]) {
    assert.ok(registry.has(name), `应含 ${name}`);
  }
  assert.equal(registry.has("read_context_result"), false);
});

test("runToolLoop 工具异常被安全处理，不中断主循环", async () => {
  const registry = new AgentToolRegistry();
  registry.register({
    schema: { type: "function", function: { name: "broken", description: "x", parameters: {} } },
    execute: async () => { throw new Error("tool went bad"); }
  });
  const aiRouter = createDetailedRouter(async (round, args) => {
    if (round === 0) return { content: "调用工具", toolCalls: [toolCall("c1", "broken")] };
    return `继续即使工具坏了：${JSON.stringify(args.messages || []).includes("tool went bad")}`;
  });
  const result = await runToolLoop({ aiRouter, registry, runTaskArgs: { input: "x" }, maxRounds: 3 });
  assert.equal(result.rounds, 2);
  assert.equal(result.toolCalls[0].result.ok, false);
  assert.match(result.toolCalls[0].result.error, /tool went bad/);
  assert.match(result.text, /true$/);
});

test("runToolLoop 不会把非法 arguments 静默改成空对象", async () => {
  const registry = new AgentToolRegistry();
  let executed = false;
  registry.register({
    schema: { type: "function", function: { name: "strict_tool", description: "x", parameters: {} } },
    execute: async () => { executed = true; return {}; }
  });
  const invalidCall = {
    id: "invalid-json",
    type: "function",
    function: { name: "strict_tool", arguments: "{not-json" }
  };
  const aiRouter = createDetailedRouter(async (round, args) => {
    if (round === 0) return { content: "", toolCalls: [invalidCall] };
    assert.match(JSON.stringify(args.messages), /arguments.*JSON/);
    return "已看到工具参数错误";
  });
  const result = await runToolLoop({ aiRouter, registry, toolNames: ["strict_tool"], maxRounds: 2 });
  assert.equal(executed, false);
  assert.equal(result.toolCalls[0].result.ok, false);
  assert.equal(result.toolCalls[0].args.rawArguments, "{not-json");
});

test("runToolLoop 达到轮次上限时保留工具契约并显式停止", async () => {
  const registry = new AgentToolRegistry();
  registry.register({
    schema: { type: "function", function: { name: "loop", description: "x", parameters: {} } },
    execute: async () => ({ ok: true })
  });
  const advertised = [];
  const aiRouter = createDetailedRouter(async (round, args) => {
    advertised.push((args.tools || []).map((tool) => tool.function.name));
    return {
      content: "再来一次",
      toolCalls: [toolCall(`c${round}`, "loop")]
    };
  });
  const result = await runToolLoop({ aiRouter, registry, runTaskArgs: { input: "x" }, maxRounds: 3 });
  assert.equal(result.rounds, 3);
  assert.equal(result.exhausted, true);
  assert.equal(result.stopCode, "AGENT_ROUND_LIMIT");
  assert.equal(result.toolCalls.length, 3);
  assert.ok(result.toolCalls.every((call) => call.result.code !== "TOOL_NOT_AUTHORIZED"));
  assert.ok(advertised.every((names) => names.includes("loop")), "达到上限前不得静默移除工具");
});

test("runToolLoop 默认不设轮次或总调用上限，长任务超过十二轮后自然完成", async () => {
  const registry = new AgentToolRegistry();
  registry.register({
    schema: { type: "function", function: { name: "long_read", description: "x", parameters: {} } },
    execute: async (args) => ({ round: args.round }),
    policy: {
      namespace: "long-task",
      effect: "read",
      parallelSafe: true,
      repeat: "reuse",
      maxCallsPerLoop: 32
    }
  });
  const aiRouter = createDetailedRouter(async (round) => (
    round < 14
      ? { toolCalls: [toolCall(`long-${round}`, "long_read", { round })] }
      : "长任务自然完成"
  ));

  const result = await runToolLoop({
    aiRouter,
    registry,
    toolNames: ["long_read"],
    runTaskArgs: { input: "执行长任务" }
  });

  assert.equal(result.rounds, 15);
  assert.equal(result.text, "长任务自然完成");
  assert.equal(result.exhausted, false);
  assert.equal(result.contextStats.executionBudget.maxModelCalls, null);
  assert.equal(result.contextStats.executionBudget.maxToolCalls, null);
  assert.equal(result.contextStats.executionBudget.wallClockMs, null);
});

test("runToolLoop 默认不把重复工具调用误判为停滞", async () => {
  const registry = new AgentToolRegistry();
  registry.register({
    schema: { type: "function", function: { name: "poll_read", description: "x", parameters: {} } },
    execute: async () => ({ status: "pending" }),
    policy: {
      namespace: "poll-task",
      effect: "read",
      parallelSafe: true,
      repeat: "rerun",
      maxCallsPerLoop: 16
    }
  });
  const aiRouter = createDetailedRouter(async (round) => (
    round < 5
      ? { toolCalls: [toolCall(`poll-${round}`, "poll_read", { same: true })] }
      : "轮询完成"
  ));

  const result = await runToolLoop({ aiRouter, registry, toolNames: ["poll_read"] });

  assert.equal(result.rounds, 6);
  assert.equal(result.text, "轮询完成");
  assert.equal(result.exhausted, false);
  assert.equal(result.toolCalls.length, 5);
});

test("runToolLoop 仅在宿主显式配置时启用重复批次停滞保护", async () => {
  const registry = new AgentToolRegistry();
  registry.register({
    schema: { type: "function", function: { name: "stalled_read", description: "x", parameters: {} } },
    execute: async () => ({ ok: true }),
    policy: {
      namespace: "stalled-task",
      effect: "read",
      parallelSafe: true,
      repeat: "reuse",
      maxCallsPerLoop: 8
    }
  });
  const aiRouter = createDetailedRouter(async (round) => ({
    toolCalls: [toolCall(`stalled-${round}`, "stalled_read", { same: true })]
  }));

  const result = await runToolLoop({
    aiRouter,
    registry,
    toolNames: ["stalled_read"],
    maxRepeatedToolBatches: 3
  });

  assert.equal(result.rounds, 3);
  assert.equal(result.exhausted, true);
  assert.equal(result.stopCode, "AGENT_STALLED");
  assert.equal(result.toolCalls.length, 3);
  assert.equal(result.toolCalls.filter((call) => call.reusedExecution).length, 2);
});

test("runToolLoop 拦截带过程文字的内部工具协议，不把残片或伪完成文本流到界面", async () => {
  const leaked = [
    "正在继续修改文件。",
    "<｜｜DSML｜｜tool_calls>",
    "<｜｜DSML｜｜invoke name=\"write\">",
    "<｜｜DSML｜｜parameter name=\"path\">result.html</｜｜DSML｜｜parameter>",
    "</｜｜DSML｜｜invoke>",
    "</｜｜DSML｜｜tool_calls>"
  ].join("\n");
  const streamed = [];
  const response = {
    content: leaked,
    toolCalls: [],
    requestMessages: [{ role: "user", content: "x" }],
    assistantMessage: { role: "assistant", content: leaked }
  };
  const aiRouter = {
    async runTaskDetailed(args) {
      args.onToken?.("<");
      args.onToken?.(leaked.slice(1));
      return response;
    },
    async continueTaskDetailed() {
      throw new Error("不应续轮");
    }
  };

  const result = await runToolLoop({
    aiRouter,
    registry: new AgentToolRegistry(),
    runTaskArgs: { input: "x", onToken: (token) => streamed.push(token) },
    maxRounds: 3
  });

  assert.equal(result.text, "");
  assert.equal(result.exhausted, true);
  assert.equal(result.stopCode, "AGENT_TOOL_PROTOCOL_LEAK");
  assert.deepEqual(streamed, []);
});
