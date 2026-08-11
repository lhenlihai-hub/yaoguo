// @ts-check
// search_reference —— 让 LLM 在生成过程中检索外部参考(联网 + 本地素材)。
//
// 一次调用只执行模型指定的一条查询，不在工具层扩写检索词或自动抓全文。

const { observeReferenceUrl, observeReferencePath } = require("./referenceObservation");

const SEARCH_REFERENCE_TOOL_SCHEMA = {
  type: "function",
  function: {
    name: "search_reference",
    description: [
      "检索联网来源和本地素材，返回标题、URL 与摘要。",
      "用户明确要求搜索，问题涉及新闻、价格、法规、人物近况等可变信息，或现有上下文缺少关键事实时调用。",
      "稳定常识、闲聊和只需读取当前成品的问题不调用。",
      "摘要只能用于筛选来源；支持结论前，用 fetch_url 读取所选网页正文。",
      "scope=all 同时检索联网与本地，internet 只联网，local 只查本地。"
    ].join(""),
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "必填。检索关键词或主题。"
        },
        scope: {
          type: "string",
          enum: ["all", "internet", "local"],
          description: "可选。检索范围,默认 \"all\"。"
        },
        topInternet: {
          type: "integer",
          description: "可选。联网结果上限,默认 5,最大 12。"
        },
        topLocal: {
          type: "integer",
          description: "可选。本地结果上限,默认 3,最大 8。"
        }
      },
      required: ["query"]
    }
  }
};

async function executeSearchReference(args = {}, ctx = {}) {
  const { referenceService } = ctx;
  if (!referenceService || typeof referenceService.search !== "function") {
    return { ok: false, error: "search_reference 缺少 ctx.referenceService" };
  }
  const query = `${args.query || ""}`.trim();
  if (!query) return { ok: false, error: "query 不能为空" };
  const scope = ["all", "internet", "local"].includes(args.scope) ? args.scope : "all";
  const topInternet = Math.max(1, Math.min(12, Number(args.topInternet) || 5));
  const topLocal = Math.max(1, Math.min(8, Number(args.topLocal) || 3));
  try {
    const r = await referenceService.search({
      query,
      scope,
      projectId: ctx.projectId || "",
      taskId: ctx.taskId || "",
      signal: ctx.signal || null
    });
    const internet = Array.isArray(r?.internet) ? r.internet : [];
    const local = Array.isArray(r?.local) ? r.local : [];
    const internetResults = internet.slice(0, topInternet).map((item) => ({
      title: item?.title || "",
      url: item?.url || "",
      snippet: item?.snippet || "",
      source: item?.source || item?.searchProvider || "",
      date: item?.datePublished || ""
    }));
    const localResults = local.slice(0, topLocal).map((item) => ({
      name: item?.name || item?.title || "",
      path: item?.absolute || item?.path || item?.relative || "",
      snippet: item?.snippet || item?.preview || ""
    }));
    for (const item of internetResults) observeReferenceUrl(ctx, item);
    for (const item of localResults) observeReferencePath(ctx, item.path);
    return {
      ok: true,
      query,
      scope,
      notices: Array.isArray(r?.notices) ? r.notices : [],
      // 精简内容字段,避免一次性塞太多元数据
      internet: internetResults,
      local: localResults,
      total: internet.length + local.length
    };
  } catch (err) {
    return { ok: false, error: `${err?.message || err}` };
  }
}

const searchReferenceTool = {
  schema: SEARCH_REFERENCE_TOOL_SCHEMA,
  execute: executeSearchReference
};

module.exports = {
  searchReferenceTool,
  SEARCH_REFERENCE_TOOL_SCHEMA,
  executeSearchReference
};
