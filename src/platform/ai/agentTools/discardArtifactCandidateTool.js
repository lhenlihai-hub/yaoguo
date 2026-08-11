// @ts-check

const { resolveScopedArtifactPath, candidateRegistry } = require("./artifactInspectionTool");

const DISCARD_ARTIFACT_CANDIDATE_TOOL_SCHEMA = {
  type: "function",
  function: {
    name: "discard_artifact_candidate",
    description: [
      "把一个不应交给用户的候选文件标记为废弃，不会删除文件。",
      "只用于已经生成但检查后不采用的候选；工作脚本和普通草稿无需调用。"
    ].join(""),
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          minLength: 1,
          description: "要放弃的候选文件路径。"
        },
        reason: {
          type: "string",
          minLength: 1,
          maxLength: 400,
          description: "基于真实检查结果说明为什么不采用。"
        }
      },
      required: ["path", "reason"],
      additionalProperties: false
    }
  }
};

const discardArtifactCandidateTool = {
  schema: DISCARD_ARTIFACT_CANDIDATE_TOOL_SCHEMA,
  async execute(args = {}, ctx = {}) {
    const absolute = await resolveScopedArtifactPath(args.path, ctx);
    const candidates = candidateRegistry(ctx);
    const current = candidates.get(absolute);
    if (!current) throw new Error("该文件没有进入候选状态，无需废弃。");
    candidates.set(absolute, {
      ...current,
      status: "discarded",
      discardedAt: new Date().toISOString(),
      discardReason: `${args.reason || ""}`.trim()
    });
    return {
      absolute,
      discarded: true,
      reason: `${args.reason || ""}`.trim()
    };
  }
};

module.exports = {
  discardArtifactCandidateTool,
  DISCARD_ARTIFACT_CANDIDATE_TOOL_SCHEMA
};
