// @ts-check
// spawn_subagent —— 让主 agent 在独立 context window 中委派一个子任务给子 agent。
//
// 业界对标：Claude Code Task tool / AutoGen handoff / Cognition Devin sub-agent。
//   Claude Code: 主 agent 调 Task(prompt, subagent_type)，子 agent 从空 context 开始
//                只看主 agent 给的 prompt，不污染主 context，跑完返回结果给主 agent。
//
// 关键设计：
//   1. 子 agent 用 fresh context（runTaskArgs.input 由 prompt 参数完全提供）—— 避免长 workflow
//      第 6+ 步 context 越塞越大的"上下文污染"。
//   2. 子 agent 跑独立 toolLoop，可以用允许的工具子集；默认禁用 spawn_subagent 自身，
//      避免无限递归爆栈（与 Claude Code 同语义——sub-agent 不能再 Task() ）。
//   3. 返回值精简：只回主 agent {result, toolCallsCount, rounds}，不回完整 trace。
//      详细 trace 由 spawn 端通过 onTrace 回调持久化到 runs/<runId>/subagents/。
//
// spawn_subagent 不直接挂到 modelGateway——它是高级"高阶工具"，由 aiRouter / workflowEngine
// 显式启用，并必须在 ctx 里传入 aiRouter + registry。

const crypto = require("node:crypto");
const { runToolLoop } = require("../agentLoop/agentLoop");
const { estimateTokens } = require("../../tokens/tokenEstimator");

const SPAWN_SUBAGENT_TOOL_SCHEMA = {
  type: "function",
  function: {
    name: "spawn_subagent",
    description: [
      "在一个干净的、与当前 Agent 上下文隔离的 context window 中启动一个子 agent，让它完成一个聚焦的子任务。",
      "适合：独立分析一个问题、校验一组结果、提取一批数据，或检索并整理某类资料。",
      "子 agent 看不到主 Agent 的任务历史，只看到你给它的 prompt——所以 prompt 必须自包含，",
      "必要的背景、约束、输出格式都要写清楚。子 agent 跑完会把结果作为字符串返回给你。",
      "不要委派可以直接回答的小问题，子 agent 是有成本的（一轮 LLM 至少几秒）。"
    ].join(""),
    parameters: {
      type: "object",
      properties: {
        purpose: {
          type: "string",
          description: "本次委派要解决的具体目标，一句话。日志/调试用，不会传给子 agent。"
        },
        prompt: {
          type: "string",
          description: "完整自包含的子任务 prompt。必须包含：背景、约束、输入数据、期望输出形态。子 agent 看不到主 Agent 的任务历史。"
        },
        allowedTools: {
          type: "array",
          description: "可选。限定子 agent 能使用的工具名子集（如 ['recall_handoff','search_reference']）。留空表示用默认安全子集（不含 spawn_subagent 自身）。",
          items: { type: "string" }
        },
        maxRounds: {
          type: "integer",
          description: "可选。仅当当前任务确实需要显式预算时，限定子 Agent 的最大模型轮数。"
        }
      },
      required: ["purpose", "prompt"]
    }
  }
};

// 默认允许的子 agent 工具集(只读为主 + 联网研究,与主 agent 隔离):
//   - recall_handoff         查 typed handoff
//   - search_run_artifacts   检索前文(对标 Claude Code Grep)
//   - read_artifact          精读前文(对标 Claude Code Read)
//   - list_todos             查 working plan(只读,不写)
//   - search_memory          查跨 run 长期记忆(只读,不 pin)
//   - search_reference       联网 + 本地素材检索(对标 Claude Code 子 agent 也带 WebSearch)
//   - fetch_url              抓 URL 全文(对标 Claude Code 子 agent 也带 WebFetch)
// 不允许 spawn_subagent / write_todo / pin_memory,避免:
//   - spawn 递归(对齐 Claude Code 子 agent 不能再 Task())
//   - 主 plan 被子 agent 干扰(主从竞态难调试)
//   - 主项目长期记忆被子 agent 污染(pin 是主 agent 职责)
const DEFAULT_SUBAGENT_TOOL_NAMES = [
  "recall_handoff",
  "search_run_artifacts",
  "read_artifact",
  "list_todos",
  "search_memory",
  "search_reference",
  "read_reference",
  "fetch_url"
];

/**
 * spawn_subagent 的 execute。ctx 必须提供：
 *   - aiRouter      用于子 agent 内部跑 toolLoop
 *   - registry      AgentToolRegistry 实例（同主 agent 的注册中心）
 *   - subAgentTaskType（可选）子 agent 调用的 taskType，默认 "agent"
 *   - onTrace(traceObj)（可选）接收子 agent trace 的回调。原始正文可直接读取，
 *     但不参与 JSON 序列化；可持久化部分只含元数据与 digest。
 *   - 任意需要透传给工具的字段（checkpointStore / runDir / ...）
 */
async function executeSpawnSubagent(args = {}, ctx = {}) {
  const { aiRouter, registry } = ctx;
  const purpose = `${args.purpose || ""}`.trim();
  const prompt = `${args.prompt || ""}`.trim();
  if (!prompt) return { ok: false, error: "spawn_subagent 缺少 prompt" };
  if (!aiRouter || typeof aiRouter.runTaskDetailed !== "function" || typeof aiRouter.continueTaskDetailed !== "function") {
    return { ok: false, error: "spawn_subagent 缺少支持原生 tool-call 的 ctx.aiRouter" };
  }
  if (!registry || typeof registry.toSchemas !== "function") {
    return { ok: false, error: "spawn_subagent 缺少 ctx.registry" };
  }
  const availableSafeTools = resolveAvailableSubagentTools(ctx, registry);
  const requestedTools = Array.isArray(args.allowedTools) && args.allowedTools.length
    ? args.allowedTools.map((name) => `${name || ""}`.trim()).filter(Boolean)
    : availableSafeTools;
  const allowedTools = [...new Set(requestedTools.filter((name) => availableSafeTools.includes(name)))];
  const deniedTools = [...new Set(requestedTools.filter((name) => !allowedTools.includes(name)))];
  const requestedMaxRounds = Number.isFinite(args.maxRounds) && args.maxRounds > 0
    ? Math.max(1, Math.floor(args.maxRounds))
    : Infinity;
  const remainingModelCalls = typeof ctx.executionBudget?.remaining === "function"
    ? ctx.executionBudget.remaining("model")
    : Infinity;
  const parentModelReserve = Number.isInteger(ctx.parentModelReserve) && ctx.parentModelReserve > 0
    ? ctx.parentModelReserve
    : 1;
  // 为父 Agent 保留一次接收子结果后的自然续轮。
  // model-compute 工具被串行执行，因此动态剩余额度检查也是原子的。
  const childModelAllowance = ctx.executionBudget
    ? Math.max(0, remainingModelCalls - parentModelReserve)
    : remainingModelCalls;
  if (childModelAllowance <= 0) {
    return {
      ok: false,
      code: "AGENT_MODEL_BUDGET_RESERVED_FOR_PARENT",
      error: `模型预算不足：必须为父 Agent 保留 ${parentModelReserve} 次后续调用。`
    };
  }
  const maxRounds = Math.min(requestedMaxRounds, childModelAllowance);
  const signal = ctx.executionBudget?.signal || ctx.signal || null;
  const memoryIndex = await ctx.memoryStore?.indexContext?.();

  const traceRows = [];
  const subResult = await runToolLoop({
    aiRouter,
    registry,
    toolNames: allowedTools,
    baseToolNames: ["read"],
    toolCtx: ctx,
    runTaskArgs: {
      taskType: ctx.subAgentTaskType || "agent",
      title: `subagent: ${purpose || prompt.slice(0, 40)}`,
      instruction: "你是一个干净上下文的子智能体，只看到下方的 prompt——完成它并返回最终文本。",
      input: prompt,
      runContext: "",
      pinnedSections: memoryIndex ? [memoryIndex] : [],
      contextProfile: "minimal",
      contextBudget: { runContextTokens: 0, inputTokens: 32000 },
      projectId: ctx.projectId || "",
      taskId: ctx.taskId || "",
      runId: ctx.runId || "",
      stepId: ctx.currentStepId || "",
      signal
    },
    ...(Number.isFinite(maxRounds) ? { maxRounds } : {}),
    ...(Number.isFinite(childModelAllowance) ? { maxAgentModelCalls: childModelAllowance } : {}),
    onRound: (round, calls) => {
      traceRows.push({
        round,
        toolCalls: calls.map((call) => ({
          name: call?.function?.name || "",
          argsDigest: digestTraceValue(call?.function?.arguments || "")
        }))
      });
    }
  });

  if (typeof ctx.onTrace === "function") {
    try {
      const trace = {
        allowedTools,
        deniedToolCount: deniedTools.length,
        deniedToolDigests: deniedTools.map(digestTraceValue),
        maxRounds,
        rounds: subResult.rounds,
        exhausted: Boolean(subResult.exhausted),
        contextStats: subResult.contextStats || null,
        toolCallsTrace: subResult.toolCalls,
        rounds_outline: traceRows
      };
      attachEphemeralSpawnTraceData(trace, {
        purpose,
        prompt,
        finalText: subResult.text,
        deniedTools
      });
      await ctx.onTrace(trace);
    } catch {}
  }

  const result = `${subResult.text || ""}`;

  if (subResult.exhausted || !result.trim()) {
    return {
      ok: false,
      error: subResult.exhausted ? "子 Agent 用尽工具预算后仍未完成任务。" : "子 Agent 没有返回结果。",
      rounds: subResult.rounds,
      toolCallsCount: subResult.toolCalls.length,
      exhausted: Boolean(subResult.exhausted),
      contextStats: subResult.contextStats || null,
      deniedTools
    };
  }
  return {
    ok: true,
    result,
    resultTokens: estimateTokens(result),
    rounds: subResult.rounds,
    toolCallsCount: subResult.toolCalls.length,
    exhausted: Boolean(subResult.exhausted),
    contextStats: subResult.contextStats || null,
    deniedTools
  };
}

function resolveAvailableSubagentTools(ctx = {}, registry = null) {
  const available = [];
  const add = (name, condition) => {
    if (condition && registry?.has?.(name) && DEFAULT_SUBAGENT_TOOL_NAMES.includes(name)) available.push(name);
  };
  add("recall_handoff", ctx.checkpointStore && ctx.handoffDir);
  add("search_run_artifacts", ctx.artifactStore);
  add("read_artifact", ctx.artifactStore);
  add("list_todos", ctx.todoStore && ctx.todoDir);
  add("search_memory", ctx.memoryStore);
  add("search_reference", ctx.referenceService);
  add("read_reference", ctx.referenceService || ctx.projectService);
  add("fetch_url", ctx.webSearchService);
  return available;
}

function digestTraceValue(value = "") {
  return crypto.createHash("sha256").update(`${value || ""}`, "utf8").digest("hex");
}

function attachEphemeralSpawnTraceData(trace, values) {
  Object.defineProperties(trace, {
    purpose: { configurable: false, enumerable: false, value: values.purpose },
    prompt: { configurable: false, enumerable: false, value: values.prompt },
    finalText: { configurable: false, enumerable: false, value: values.finalText },
    deniedTools: { configurable: false, enumerable: false, value: values.deniedTools }
  });
}

const spawnSubagentTool = {
  schema: SPAWN_SUBAGENT_TOOL_SCHEMA,
  execute: executeSpawnSubagent
};

module.exports = {
  spawnSubagentTool,
  SPAWN_SUBAGENT_TOOL_SCHEMA,
  DEFAULT_SUBAGENT_TOOL_NAMES,
  executeSpawnSubagent,
  resolveAvailableSubagentTools
};
