// @ts-check
// fetch_url —— 让 LLM 主动抓某个 URL 的 readable 全文。
//
// 业界对标:Claude Code WebFetch:url → readable page,LLM cited。
//
// 只抓取用户已授权的原始 URL。失败时直接返回错误，不把 URL 隐式转发给
// 第三方 Reader；maxPreviewChars 负责限制进入模型上下文的正文长度。
//
// 安全闭包:
//   - 只接受 http / https 协议;通过 new URL(url) 隐式校验
//   - maxChars 边界 [1000, 30000];防止单次拉太多炸 context
//
// 设计选择:**LLM 显式抓单 URL** —— 不接受批量列表;
// 想抓多个走多次工具调用,每次都让 LLM 有机会评估上次结果再决定。

const { assertSafeHttpUrl } = require("../../shared/urlSafety");
const { observeReferenceUrl } = require("./referenceObservation");

const FETCH_URL_TOOL_SCHEMA = {
  type: "function",
  function: {
    name: "fetch_url",
    description: [
      "读取一个 http/https 网页的正文，用于核对搜索摘要或用户提供的链接。",
      "一次读取一个 URL；返回内容达到 maxChars 时会标记 truncated。",
      "本地文件使用 read_artifact 或 read_reference，不要传 file URL。"
    ].join(""),
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "必填。要抓取的 URL,必须 http 或 https。"
        },
        maxChars: {
          type: "integer",
          description: "可选。返回内容字符上限,默认 8000,边界 [1000, 30000]。"
        }
      },
      required: ["url"]
    }
  }
};

async function executeFetchUrl(args = {}, ctx = {}) {
  const { webSearchService } = ctx;
  if (!webSearchService || typeof webSearchService.fetchReadablePage !== "function") {
    return { ok: false, error: "fetch_url 缺少 ctx.webSearchService" };
  }
  const url = `${args.url || ""}`.trim();
  if (!url) return { ok: false, error: "url 不能为空" };
  try { await assertSafeHttpUrl(url, { resolveDns: true }); }
  catch (error) { return { ok: false, code: error?.code || "URL_BLOCKED", error: `${error?.message || error}` }; }
  const maxChars = Math.max(1000, Math.min(30000, Number(args.maxChars) || 8000));
  try {
    const text = await webSearchService.fetchReadablePage(url, {
      maxPreviewChars: maxChars,
      signal: ctx.signal || null,
      readerFallback: false
    });
    const content = `${text || ""}`;
    const observedUrl = observeReferenceUrl(ctx, { url, content });
    return {
        ok: true,
        url: observedUrl || url,
        content,
        contentLength: content.length,
      // fetchReadablePage 内部 truncate 到 maxPreviewChars;长度等于上限基本就是截过
        truncated: content.length >= maxChars,
        maxCharsApplied: maxChars,
        nextOffset: content.length >= maxChars ? content.length : null,
        continuation: content.length >= maxChars
          ? "使用 read_reference，传入同一 url 与 offsetChars=nextOffset 继续分页读取。"
          : null
      };
  } catch (err) {
    return { ok: false, error: `${err?.message || err}` };
  }
}

const fetchUrlTool = {
  schema: FETCH_URL_TOOL_SCHEMA,
  execute: executeFetchUrl
};

module.exports = {
  fetchUrlTool,
  FETCH_URL_TOOL_SCHEMA,
  executeFetchUrl
};
