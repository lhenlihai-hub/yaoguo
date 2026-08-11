// @ts-check
// read_artifact —— 让 LLM 精读某一个 artifact 的全文(段落级 offset/limit)。
//
// 业界对标:
//   - Claude Code Read:agent 读源码,长任务的精读工具
//   - 配合 Grep(search_run_artifacts)使用:先搜定位 artifactId → 再精读
//
// 安全闭包:
//   - 只接受 ArtifactStore 管辖的 artifactId 或 (projectId, runId, stepId, artifactType)
//   - 不接受任意文件路径——避免 LLM 越权读 secrets / 配置 / 跨项目文件
//
// 截断策略:
//   - 段落级 offset/limit,默认 limit=32(约 6-10K 字符),够精读一个小节
//   - 不开放无界读取,避免一次性把整章塞进 context

const READ_ARTIFACT_TOOL_SCHEMA = {
  type: "function",
  function: {
    name: "read_artifact",
    description: [
      "精读某一个 artifact 的全文,段落级分页。通常配合 search_run_artifacts 使用——",
      "先搜定位 artifactId,再用本工具读完整段落。",
      "两种定位方式(二选一):",
      "  A. 传 artifactId(从 search 结果拿到)",
      "  B. 传 stepId + artifactType (默认 runId 用当前 run,可显式指定)",
      "用 offset/limit 控制读多少段;默认 limit=32 段(约 6-10K 字符)。",
      "返回 totalParagraphs 让你判断要不要翻页;truncated=true 时还有更多。",
      "不要无脑用 limit=200 拉整章——精读应该聚焦,先 search 找命中段附近再精读。"
    ].join(""),
    parameters: {
      type: "object",
      properties: {
        artifactId: {
          type: "string",
          description: "定位方式 A:artifact 的全局唯一 id,通常从 search_run_artifacts 的 hit 拿到。"
        },
        stepId: {
          type: "string",
          description: "定位方式 B:step 的 id,与 artifactType 联合定位。"
        },
        artifactType: {
          type: "string",
          description: "定位方式 B:artifact 类型,比如 'step-output' / 'draft' / 'outline'。"
        },
        runId: {
          type: "string",
          description: "可选。仅定位方式 B 用;留空默认当前 run(toolCtx)。"
        },
        offset: {
          type: "integer",
          description: "可选。从第几段开始读(0 起,默认 0)。"
        },
        limit: {
          type: "integer",
          description: "可选。读多少段,默认 32,最大 200。建议精读时 ≤ 64。"
        },
        maxChars: {
          type: "integer",
          description: "可选。字符数硬上限,默认 16000(约 5K tokens),边界 [500, 64000]。防止单段过长突破 context;超过会停止累计并标 truncated=true。"
        }
      },
      required: []
    }
  }
};

async function executeReadArtifact(args = {}, ctx = {}) {
  const { artifactStore, projectId } = ctx;
  if (!artifactStore || typeof artifactStore.readArtifact !== "function") {
    return { ok: false, error: "read_artifact 缺少 ctx.artifactStore" };
  }
  if (!projectId) {
    return { ok: false, error: "read_artifact 缺少 ctx.projectId" };
  }

  const artifactId = `${args.artifactId || ""}`.trim();
  const stepId = `${args.stepId || ""}`.trim();
  const artifactType = `${args.artifactType || ""}`.trim();
  const runId = `${args.runId || ""}`.trim() || ctx.artifactRunId || "";

  if (!artifactId && !(stepId && artifactType && runId)) {
    return {
      ok: false,
      error: "需要 artifactId，或同时提供 runId + stepId + artifactType"
    };
  }

  const result = await artifactStore.readArtifact({
    artifactId: artifactId || undefined,
    projectId,
    taskId: ctx.taskId || "",
    runId,
    stepId: stepId || undefined,
    artifactType: artifactType || undefined,
    offset: Number.isFinite(args.offset) ? Number(args.offset) : 0,
    limit: Number.isFinite(args.limit) ? Number(args.limit) : 32,
    maxChars: Number.isFinite(args.maxChars) ? Number(args.maxChars) : undefined
  });

  if (!result.ok) return { ok: false, error: result.reason || "read failed" };

  return {
    ok: true,
    artifactId: result.artifactId,
    meta: result.meta,
    totalParagraphs: result.totalParagraphs,
    offset: result.paragraphsRead.offset,
    limit: result.paragraphsRead.limit,
    paragraphs: result.paragraphsRead.paragraphs,
    charCount: result.paragraphsRead.charCount,
    truncated: result.truncated,
    truncationReason: result.truncationReason
  };
}

const readArtifactTool = {
  schema: READ_ARTIFACT_TOOL_SCHEMA,
  execute: executeReadArtifact
};

module.exports = {
  readArtifactTool,
  READ_ARTIFACT_TOOL_SCHEMA,
  executeReadArtifact
};
