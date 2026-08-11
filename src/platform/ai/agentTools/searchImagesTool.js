// @ts-check

const crypto = require("node:crypto");
const { searchPublicDomainImages } = require("../../media/wikimediaImages");
const { searchOpenverseImages } = require("../../media/openverseImages");

const SEARCH_IMAGES_TOOL_SCHEMA = {
  type: "function",
  function: {
    name: "search_images",
    description: "检索 Wikimedia Commons 与 Openverse 的开放授权图片，返回可继续选择的 assetId、预览 URL、作者和授权信息。工具只提供候选资源，不自动修改成品。",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          minLength: 2,
          maxLength: 160,
          description: "图片中应当实际可见的主体、场景、年代、地域或艺术媒介。"
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 8,
          description: "返回候选数量，范围 1-8。"
        }
      },
      required: ["query"],
      additionalProperties: false
    }
  }
};

async function searchOpenLicensedImages(query, config = {}) {
  const settled = await Promise.allSettled([
    searchPublicDomainImages(query, config),
    searchOpenverseImages(query, config)
  ]);
  return settled.flatMap((item) => item.status === "fulfilled" && Array.isArray(item.value) ? item.value : []);
}

async function executeSearchImages(args = {}, ctx = {}) {
  const query = `${args.query || ""}`.trim();
  if (!query) return { ok: false, code: "QUERY_REQUIRED", assets: [] };
  const limit = Math.max(1, Math.min(8, Number(args.limit) || 6));
  const search = typeof ctx.searchImages === "function" ? ctx.searchImages : searchOpenLicensedImages;
  const rows = await search(query, { limit, signal: ctx.signal || null }).catch(() => []);
  const store = ctx.imageAssets instanceof Map ? ctx.imageAssets : new Map();
  if (!(ctx.imageAssets instanceof Map)) ctx.imageAssets = store;
  const seen = new Set();
  const assets = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const url = `${row?.url || ""}`.trim();
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
    seen.add(url);
    const asset = {
      assetId: `image_${crypto.createHash("sha256").update(url).digest("hex").slice(0, 16)}`,
      title: `${row?.title || query}`.trim(),
      url,
      sourceUrl: `${row?.sourceUrl || row?.fullUrl || ""}`.trim(),
      credit: `${row?.credit || ""}`.trim(),
      license: `${row?.license || ""}`.trim()
    };
    store.set(asset.assetId, asset);
    assets.push(asset);
    if (assets.length >= limit) break;
  }
  return { ok: true, query, count: assets.length, assets };
}

const searchImagesTool = {
  schema: SEARCH_IMAGES_TOOL_SCHEMA,
  execute: executeSearchImages
};

module.exports = {
  searchImagesTool,
  SEARCH_IMAGES_TOOL_SCHEMA,
  executeSearchImages,
  searchOpenLicensedImages
};
