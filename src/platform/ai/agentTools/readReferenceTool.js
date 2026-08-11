// @ts-check

const path = require("node:path");
const { observeReferenceUrl, observeReferencePath } = require("./referenceObservation");

const READ_REFERENCE_TOOL_SCHEMA = {
  type: "function",
  function: {
    name: "read_reference",
    description: [
      "分页精读已引用参考、本地资料或网页正文。",
      "通常先用 search_reference 定位，再传 referenceId、url 或 path 之一。",
      "offsetChars 从 0 开始；返回 totalChars、truncated 和 nextOffset，不会把截断片段伪装成完整资料。"
    ].join(""),
    parameters: {
      type: "object",
      properties: {
        referenceId: { type: "string", description: "当前任务已引用资料的 id。" },
        url: { type: "string", description: "http/https 网址。" },
        path: { type: "string", description: "search_reference 返回的本地绝对路径。" },
        offsetChars: { type: "integer", description: "起始字符位置，默认 0。" },
        maxChars: { type: "integer", description: "本页最多返回的字符数，默认 24000，最大 128000。" }
      },
      required: []
    }
  }
};

async function executeReadReference(args = {}, ctx = {}) {
  const referenceId = `${args.referenceId || ""}`.trim();
  const url = `${args.url || ""}`.trim();
  const localPath = `${args.path || ""}`.trim();
  if (!referenceId && !url && !localPath) {
    return { ok: false, error: "referenceId、url 或 path 至少提供一个。" };
  }
  const offsetChars = Math.max(0, Math.floor(Number(args.offsetChars) || 0));
  const maxChars = Math.max(1000, Math.min(128000, Math.floor(Number(args.maxChars) || 24000)));

  const projectService = ctx.projectService;
  if (projectService && ctx.projectId && ctx.taskId && typeof projectService.listReferences === "function") {
    const references = await projectService.listReferences(ctx.projectId, ctx.taskId).catch(() => []);
    const saved = (Array.isArray(references) ? references : []).find((item) => (
      (referenceId && item.id === referenceId)
      || (url && item.url === url)
      || (localPath && [item.absolute, item.relative].includes(localPath))
    ));
    if (saved) {
      const fullContent = `${saved.content || saved.snippet || ""}`;
      const content = fullContent.slice(offsetChars, offsetChars + maxChars);
      const nextOffset = offsetChars + content.length < fullContent.length
        ? offsetChars + content.length
        : null;
      observeReferenceUrl(ctx, saved);
      observeReferencePath(ctx, saved.absolute || "");
      return {
        ok: true,
        referenceId: saved.id,
        title: saved.title || "",
        url: saved.url || "",
        path: saved.absolute || saved.relative || "",
        content,
        offsetChars,
        totalChars: fullContent.length,
        truncated: nextOffset !== null,
        nextOffset
      };
    }
  }

  if (localPath) {
    const normalizedPath = path.isAbsolute(localPath) ? path.resolve(localPath) : "";
    const observed = ctx.observedReferencePaths;
    if (!normalizedPath || !(observed instanceof Set) || !observed.has(normalizedPath)) {
      return {
        ok: false,
        code: "REFERENCE_NOT_OBSERVED",
        error: "该本地路径未出现在本轮真实 search_reference 结果或宿主授权资料中，拒绝直接读取。"
      };
    }
  }

  const referenceService = ctx.referenceService;
  if (!referenceService || typeof referenceService.preview !== "function") {
    return { ok: false, error: "没有可用的参考资料读取服务。" };
  }
  try {
    const preview = await referenceService.preview({
      sourceType: localPath ? "local" : "internet",
      absolute: localPath || undefined,
      url: url || undefined,
      offsetChars,
      maxChars
    });
    observeReferenceUrl(ctx, {
      url: preview?.url || url,
      title: preview?.title || "",
      content: preview?.content || preview?.snippet || ""
    });
    observeReferencePath(ctx, preview?.absolute || preview?.path || localPath);
    return { ok: true, ...preview };
  } catch (error) {
    return { ok: false, error: `${error?.message || error}` };
  }
}

const readReferenceTool = {
  schema: READ_REFERENCE_TOOL_SCHEMA,
  execute: executeReadReference
};

module.exports = {
  readReferenceTool,
  READ_REFERENCE_TOOL_SCHEMA,
  executeReadReference
};
