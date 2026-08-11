// @ts-check
// wikimediaImages —— 免 key 的公有领域图片检索（Wikimedia Commons API）。
//
// 调用方提供查询词后搜索 Commons，并只返回公有领域 / CC 授权候选。
// 本模块不判断是否需要图片，也不选择图片；纯 fetch + 纯解析。

const ENDPOINT = "https://commons.wikimedia.org/w/api.php";

function stripHtml(s) {
  return `${s == null ? "" : s}`.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

// 只接受公有领域 / CC0 / CC-BY / CC-BY-SA；拒绝非商业和禁止演绎条款。
function isOpenLicense(license) {
  const normalized = `${license || ""}`.toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized) return false;
  if (/\b(?:nc|nd)\b|noncommercial|no derivatives?/.test(normalized)) return false;
  if (normalized.includes("public domain") || /^pd(?:\b|$)/.test(normalized) || /\bcc0\b/.test(normalized)) {
    return true;
  }
  return /\bcc by(?: sa)?(?:\s|$)/.test(normalized);
}

function parseCommonsResponse(json, { limit = 6 } = {}) {
  const pagesRaw = json && json.query ? json.query.pages : null;
  const list = Array.isArray(pagesRaw) ? pagesRaw : Object.values(pagesRaw || {});
  const rows = [];
  for (const page of list) {
    const ii = (page && page.imageinfo && page.imageinfo[0]) || null;
    if (!ii) continue;
    const meta = ii.extmetadata || {};
    const license = (meta.LicenseShortName && meta.LicenseShortName.value) || "";
    if (!isOpenLicense(license)) continue;
    const url = ii.thumburl || ii.url;
    if (!url) continue;
    rows.push({
      title: stripHtml(page.title || "").replace(/^File:/, ""),
      url,
      fullUrl: ii.url || url,
      credit: stripHtml((meta.Artist && meta.Artist.value) || ""),
      license
    });
  }
  return rows.slice(0, limit);
}

async function searchPublicDomainImages(query, config = {}) {
  const q = `${query || ""}`.trim();
  if (!q) return [];
  const limit = Math.max(1, Math.min(20, Number(config.limit) || 6));
  const params = new URLSearchParams({
    action: "query",
    generator: "search",
    gsrsearch: q,
    gsrnamespace: "6",
    gsrlimit: `${limit}`,
    prop: "imageinfo",
    iiprop: "url|extmetadata",
    iiurlwidth: `${Number(config.width) || 1200}`,
    format: "json"
  });
  const signal = config.signal || AbortSignal.timeout(Math.max(1000, Number(config.timeoutMs) || 8000));
  const response = await fetch(`${ENDPOINT}?${params.toString()}`, {
    headers: { "User-Agent": config.userAgent || "yaoguo/1.0 (aesthetic public-domain image search)" },
    signal
  });
  if (!response.ok) throw new Error(`Wikimedia 检索失败 ${response.status}`);
  const json = await response.json();
  return parseCommonsResponse(json, { limit });
}

module.exports = { searchPublicDomainImages, parseCommonsResponse, isOpenLicense };
