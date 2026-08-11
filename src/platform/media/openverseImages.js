// @ts-check

// Openverse 是 Wikimedia Commons 之外的开放授权图片来源。
// 匿名 API 可直接使用；这里只保留允许商业使用和修改的常见开放许可。

const ENDPOINT = "https://api.openverse.org/v1/images/";

function isReusableLicense(value = "") {
  const license = `${value || ""}`.toLowerCase().replace(/[_\s]+/g, "-").trim();
  if (!license || /(?:^|-)nc(?:-|$)|(?:^|-)nd(?:-|$)/.test(license)) return false;
  return ["cc0", "pdm", "by", "by-sa"].includes(license)
    || /public-domain/.test(license)
    || /^cc-by(?:-sa)?$/.test(license);
}

function parseOpenverseResponse(json, { limit = 6 } = {}) {
  const rows = [];
  for (const item of Array.isArray(json?.results) ? json.results : []) {
    if (!isReusableLicense(item?.license)) continue;
    const url = `${item?.thumbnail || item?.url || ""}`.trim();
    if (!/^https?:\/\//i.test(url)) continue;
    rows.push({
      title: `${item.title || ""}`.trim(),
      url,
      fullUrl: `${item.url || url}`.trim(),
      sourceUrl: `${item.foreign_landing_url || item.detail_url || ""}`.trim(),
      credit: `${item.creator || item.attribution || ""}`.trim(),
      license: `${item.license || ""}`.trim(),
      source: "openverse"
    });
    if (rows.length >= limit) break;
  }
  return rows;
}

async function searchOpenverseImages(query, config = {}) {
  const q = `${query || ""}`.trim();
  if (!q) return [];
  const limit = Math.max(1, Math.min(20, Number(config.limit) || 6));
  const params = new URLSearchParams({ q, page_size: `${limit}`, mature: "false" });
  const signal = config.signal || AbortSignal.timeout(Math.max(1000, Number(config.timeoutMs) || 8000));
  const response = await fetch(`${ENDPOINT}?${params.toString()}`, {
    headers: { "User-Agent": config.userAgent || "yaoguo/1.0 (open-licensed image search)" },
    signal
  });
  if (!response.ok) throw new Error(`Openverse 检索失败 ${response.status}`);
  return parseOpenverseResponse(await response.json(), { limit });
}

module.exports = { searchOpenverseImages, parseOpenverseResponse, isReusableLicense };
