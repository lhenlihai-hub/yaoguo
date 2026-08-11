// @ts-check
// search_run_artifacts —— 让 LLM 在执行过程中检索已有 step artifact。
//
// 业界对标:
//   - Claude Code Grep:agent 检索过去的源码,长任务的命门工具
//   - Cursor Composer:在 codebase 内按需检索相关内容
//
// 与 recall_handoff 的语义边界:
//   - recall_handoff:查"已确立的决定/事实/否决/待确认"(append-only typed state)
//   - search_run_artifacts:查已有交付物、计划、报告或中间结果的原文(全文检索)
//
// toolCtx 必需:
//   - artifactStore  (ArtifactStore 实例)
//   - projectId      (默认 scope)
// toolCtx 可选(作为默认 scope):
//   - taskId (默认查当前 task session；runId 只有显式传入时才缩小范围)

const SEARCH_RUN_ARTIFACTS_TOOL_SCHEMA = {
  type: "function",
  function: {
    name: "search_run_artifacts",
    description: [
      "在已有工作产物里使用 BM25 检索相关片段。",
      "用来:确认此前结果、定位已有事实或约束、找到需要精读的 step。",
      "默认搜索当前 task 的全部历史产物；可显式传 runId/stepId/artifactType 缩小范围。",
      "返回每条命中的 artifactId + step 信息 + 命中片段(snippet)。要看全文请配合 read_artifact 使用。",
      "不要把 topK 设太大(默认 8 已经够用),snippet 太多会污染上下文。"
    ].join(""),
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "检索词。支持中英混排与关键词组合。"
        },
        runId: {
          type: "string",
          description: "可选。限定 runId。留空或传 \"*\" = 当前 task 下跨 run 搜索。"
        },
        taskId: {
          type: "string",
          description: "可选。限定 taskId。留空 = 用当前 task(toolCtx 默认值)。传 \"*\" 表示跨 task(项目级);项目级检索通常需同时把 runId 也传 \"*\"。"
        },
        stepId: {
          type: "string",
          description: "可选。限定某一 step 的产出。"
        },
        artifactType: {
          type: "string",
          description: "可选。限定 artifact 类型,比如 'step-output' / 'summary' / 'outline' / 'draft'。"
        },
        topK: {
          type: "integer",
          description: "可选。返回命中数上限,默认 8,建议 ≤ 12。"
        },
        snippetLength: {
          type: "integer",
          description: "可选。命中片段长度(字符),默认 200,建议 150-300。"
        }
      },
      required: ["query"]
    }
  }
};

async function executeSearchRunArtifacts(args = {}, ctx = {}) {
  const { artifactStore, projectId } = ctx;
  if (!artifactStore || typeof artifactStore.searchArtifacts !== "function") {
    return { ok: false, error: "search_run_artifacts 缺少 ctx.artifactStore" };
  }
  if (!projectId) {
    return { ok: false, error: "search_run_artifacts 缺少 ctx.projectId" };
  }
  const query = `${args.query || ""}`.trim();
  if (!query) return { ok: false, error: "query 不能为空" };

  // canonical 默认 scope 是当前 task session，不能因入口是否带 runId 而变化。
  // "*" 表示该维度不限定；显式 runId 才缩小到单次运行。
  const explicitRunId = `${args.runId || ""}`.trim();
  const runId = explicitRunId && explicitRunId !== "*" ? explicitRunId : "";

  const explicitTaskId = `${args.taskId || ""}`.trim();
  let taskId;
  if (explicitTaskId === "*") taskId = "";
  else if (explicitTaskId) taskId = explicitTaskId;
  else taskId = ctx.taskId || "";

  const result = await artifactStore.searchArtifacts({
    query,
    projectId,
    taskId,
    runId,
    stepId: `${args.stepId || ""}`.trim() || "",
    artifactType: `${args.artifactType || ""}`.trim() || "",
    topK: Number.isFinite(args.topK) ? Number(args.topK) : 8,
    snippetLength: Number.isFinite(args.snippetLength) ? Number(args.snippetLength) : 200
  });

  return {
    ok: true,
    query,
    scope: {
      projectId,
      taskId: taskId || "(any)",
      runId: runId || "(any)",
      stepId: args.stepId || "(any)",
      artifactType: args.artifactType || "(any)"
    },
    modeUsed: result.modeUsed,
    total: result.total,
    hits: result.hits
  };
}

const searchRunArtifactsTool = {
  schema: SEARCH_RUN_ARTIFACTS_TOOL_SCHEMA,
  execute: executeSearchRunArtifacts
};

module.exports = {
  searchRunArtifactsTool,
  SEARCH_RUN_ARTIFACTS_TOOL_SCHEMA,
  executeSearchRunArtifacts
};
