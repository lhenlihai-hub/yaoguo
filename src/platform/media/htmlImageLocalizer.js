// @ts-check
// htmlImageLocalizer —— 把视觉 HTML 里的远程图片下载成 data: URI 内联，供 Chromium 离线渲染 PDF。
//
// 为什么必须本地化：pdfRenderer 的资源守卫只放行 data: 与 scope 内 file://，远程 https 图会被拦；
// 且视觉 HTML 自带 CSP「img-src https: data:」——data: 同时满足守卫与 CSP，是唯一两头都通的形态
// （file:// 会被页面 CSP 挡）。所以内联成 base64 data:，而不是落本地文件。
//
// best-effort：下载失败 / 超限 / 非图片的，直接移除其 <img>，避免 PDF 里出现破图框。
// fetchImpl 注入式，确定性解析/改写部分单测、不依赖网络。

const { fetchPublicHttp } = require("../shared/urlSafety");

const EXT_MIME = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
  ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml", ".avif": "image/avif"
};

// 取 <img> 标签里 src 属性的位置与值（兼容双引号/单引号/无引号）。
function parseImgSrc(tag) {
  const m = /\ssrc\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
  if (!m) return null;
  const value = m[2] ?? m[3] ?? m[4] ?? "";
  return { start: m.index, end: m.index + m[0].length, value };
}

function decodeEntities(url) {
  return `${url || ""}`.replace(/&amp;/g, "&").trim();
}

function isRemote(url) {
  return /^https?:\/\//i.test(url);
}

function collectRemoteImageUrls(html, maxImages = 24) {
  const limit = Math.max(0, Math.floor(Number(maxImages) || 0));
  const tags = `${html || ""}`.match(/<img\b[^>]*>/gi) || [];
  const remoteUrls = [];
  const seen = new Set();
  for (const tag of tags) {
    const parsed = parseImgSrc(tag);
    if (!parsed) continue;
    const url = decodeEntities(parsed.value);
    if (!isRemote(url) || seen.has(url)) continue;
    seen.add(url);
    if (remoteUrls.length < limit) remoteUrls.push(url);
  }
  return remoteUrls;
}

function normalizeMime(contentType, url) {
  const ct = `${contentType || ""}`.split(";")[0].trim().toLowerCase();
  if (ct.startsWith("image/")) return ct;
  const ext = (`${url}`.match(/\.[a-z0-9]+(?=$|\?)/i) || [""])[0].toLowerCase();
  return EXT_MIME[ext] || "image/jpeg";
}

function abortAfter(timeoutMs, parentSignal = null) {
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(parentSignal?.reason);
  if (parentSignal?.aborted) forwardAbort();
  else parentSignal?.addEventListener("abort", forwardAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("图片下载超时。")), Math.max(1, timeoutMs));
  return {
    signal: controller.signal,
    clear: () => {
      clearTimeout(timer);
      parentSignal?.removeEventListener("abort", forwardAbort);
    }
  };
}

// 下载单张远程图 → data: URI。失败 / 超限 / 非图片返回 null（由调用方决定移除 <img>）。
async function fetchAsDataUri(url, { fetchImpl, maxBytes, timeoutMs, signal }) {
  const guard = abortAfter(timeoutMs, signal);
  try {
    const res = await fetchPublicHttp(url, { signal: guard.signal }, { fetchImpl, maxRedirects: 5 });
    if (!res || !res.ok) return null;
    const declaredBytes = Number(res.headers?.get?.("content-length"));
    if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) return null;
    const buffer = await readResponseBuffer(res, maxBytes);
    if (!buffer.length || buffer.length > maxBytes) return null;
    const mime = normalizeMime(res.headers?.get?.("content-type"), url);
    if (!mime.startsWith("image/")) return null;
    return `data:${mime};base64,${buffer.toString("base64")}`;
  } catch {
    return null;
  } finally {
    guard.clear();
  }
}

async function readResponseBuffer(response, maxBytes) {
  const reader = response.body?.getReader?.();
  if (!reader) return Buffer.from(await response.arrayBuffer());
  const chunks = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    const chunk = Buffer.from(value);
    total += chunk.length;
    if (total > maxBytes) {
      try { await reader.cancel?.(); } catch {}
      return Buffer.alloc(0);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

// 把 html 里所有远程 <img> 内联成 data:。返回 { html, total, localized, removed }。
// total=远程图总数；localized=成功内联数；removed=下载失败被移除的 <img> 数。
async function localizeHtmlImages({
  html = "", fetchImpl = fetch, maxBytes = 5_000_000, timeoutMs = 12000, maxImages = 24, signal = null
} = {}) {
  const source = `${html || ""}`;
  const remoteUrls = collectRemoteImageUrls(source, maxImages);
  if (!remoteUrls.length) return { html: source, total: 0, localized: 0, removed: 0 };

  const mapping = new Map();
  await Promise.all(remoteUrls.map(async (url) => {
    mapping.set(url, await fetchAsDataUri(url, { fetchImpl, maxBytes, timeoutMs, signal }));
  }));

  let localized = 0;
  let removed = 0;
  const out = source.replace(/<img\b[^>]*>/gi, (tag) => {
    const parsed = parseImgSrc(tag);
    if (!parsed) return tag;
    const url = decodeEntities(parsed.value);
    if (!isRemote(url)) return tag;
    const dataUri = mapping.get(url);
    if (!dataUri) { removed += 1; return ""; }
    localized += 1;
    return `${tag.slice(0, parsed.start)} src="${dataUri}"${tag.slice(parsed.end)}`;
  });
  return { html: out, total: remoteUrls.length, localized, removed };
}

module.exports = {
  localizeHtmlImages,
  parseImgSrc,
  collectRemoteImageUrls,
  normalizeMime,
  fetchAsDataUri
};
