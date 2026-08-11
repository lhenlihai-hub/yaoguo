// @ts-check
// recall_handoff —— 让 LLM 在生成过程中查询当前 run 已累积的 typed handoff。
//
// 业界对标：Claude Code 的 sub-agent 通过 todo file 共享状态、
// Cursor Composer 通过 plan 检索过去决定。我们用 L2.1 的 checkpoint typed state。
//
// scope:
//   - "decisions"     已做决定
//   - "rejected"      已否决方向
//   - "openQuestions" 待确认项
//   - "facts"         关键事实锚点
//   - "all"           上面四类合并 + step 摘要
//
// untilStepId 用于 time-travel——查询到某步为止的累积状态。

const RECALL_HANDOFF_TOOL_SCHEMA = {
  type: "function",
  function: {
    name: "recall_handoff",
    description: [
      "查询当前运行已经累积的 typed handoff state（跨步骤决定、否决、待确认、关键事实）。",
      "用来：确认某项约束是否已由前序步骤确立、避免与既有决定冲突、检查尚未解决的问题。",
      "只在需要明确运行状态时调用。"
    ].join(""),
    parameters: {
      type: "object",
      properties: {
        scope: {
          type: "string",
          enum: ["decisions", "rejected", "openQuestions", "facts", "all"],
          description: "查询范围。all 会返回四类聚合 + 各步骤摘要。"
        },
        untilStepId: {
          type: "string",
          description: "可选。查到某 step 为止（含），便于回看历史决策。留空 = 查到最新。"
        }
      },
      required: ["scope"]
    }
  }
};

/**
 * Tool execute：从 ctx.checkpointStore + ctx.runDir 读取累积 state。
 * 返回值是结构化对象，toolLoop 会 JSON.stringify 后回填给 LLM。
 */
async function executeRecallHandoff(args = {}, ctx = {}) {
  const { checkpointStore } = ctx;
  const runDir = ctx.handoffDir || ctx.runDir || "";
  if (!checkpointStore || !runDir) return { available: false, reason: "checkpointStore / runDir 未就绪" };
  const acc = await checkpointStore.loadAccumulatedState(runDir, {
    untilStepId: args.untilStepId || ""
  });
  switch (args.scope) {
    case "decisions": return { decisions: acc.decisions };
    case "rejected": return { rejected: acc.rejected };
    case "openQuestions": return { openQuestions: acc.openQuestions };
    case "facts": return { facts: acc.facts };
    case "all":
    default: return acc;
  }
}

const recallHandoffTool = {
  schema: RECALL_HANDOFF_TOOL_SCHEMA,
  execute: executeRecallHandoff
};

module.exports = { recallHandoffTool, RECALL_HANDOFF_TOOL_SCHEMA, executeRecallHandoff };
