// @ts-check

const READ_CONTEXT_RESULT_TOOL_SCHEMA = {
  type: "function",
  function: {
    name: "read_context_result",
    description: [
      "分页读取此前已外置的完整工具结果。",
      "resultRef 只接受工具返回的 ctxr_ 引用，不接受文件路径。",
      "offsetChars 从 0 开始；maxChars 默认 12000，Agent 活动窗口内最大 24000。",
      "返回 totalChars、truncated 和 nextOffset，分页内容不会被标记为完整结果。"
    ].join(""),
    parameters: {
      type: "object",
      properties: {
        resultRef: {
          type: "string",
          description: "必填。工具结果描述中的 ctxr_ 引用。"
        },
        offsetChars: {
          type: "integer",
          description: "起始字符位置，默认 0。"
        },
        maxChars: {
          type: "integer",
          description: "本页字符上限，默认 12000，范围 1-24000。"
        }
      },
      required: ["resultRef"]
    }
  }
};

async function executeReadContextResult(args = {}, ctx = {}) {
  const store = ctx.contextResultStore;
  if (!store || typeof store.read !== "function") {
    return { ok: false, error: "read_context_result 缺少 ctx.contextResultStore" };
  }
  const resultRef = `${args.resultRef || ""}`.trim();
  if (!resultRef) return { ok: false, error: "resultRef 不能为空" };
  try {
    return await store.read({
      resultRef,
      offsetChars: Number.isFinite(args.offsetChars) ? Number(args.offsetChars) : undefined,
      maxChars: Number.isFinite(args.maxChars) ? Number(args.maxChars) : undefined
    });
  } catch (error) {
    return { ok: false, error: `${error?.message || error}` };
  }
}

module.exports = {
  READ_CONTEXT_RESULT_TOOL_SCHEMA,
  executeReadContextResult
};
