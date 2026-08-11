import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  executeSearchImages,
  searchOpenLicensedImages
} = require("../src/platform/ai/agentTools/searchImagesTool.js");

const fakeRow = (id, extra = {}) => ({
  title: `Pic ${id}`,
  url: `https://images.example/${id}.jpg`,
  credit: `Author ${id}`,
  license: "CC BY-SA",
  ...extra
});

test("search_images：模型提供查询，工具只检索并返回可引用 assetId", async () => {
  const seen = [];
  const imageAssets = new Map();
  const result = await executeSearchImages({ query: "maotai bottle", limit: 2 }, {
    imageAssets,
    searchImages: async (query, options) => {
      seen.push({ query, limit: options.limit });
      return [fakeRow("a"), fakeRow("b"), fakeRow("c")];
    }
  });
  assert.deepEqual(seen, [{ query: "maotai bottle", limit: 2 }]);
  assert.equal(result.count, 2);
  assert.match(result.assets[0].assetId, /^image_[a-f0-9]{16}$/);
  assert.deepEqual(result.assets.map((item) => item.url), [
    "https://images.example/a.jpg",
    "https://images.example/b.jpg"
  ]);
  assert.equal(imageAssets.get(result.assets[0].assetId).credit, "Author a");
});

test("search_images：URL 去重并拒绝非 http(s) 结果", async () => {
  const result = await executeSearchImages({ query: "garden" }, {
    searchImages: async () => [
      fakeRow("a"),
      fakeRow("duplicate", { url: "https://images.example/a.jpg" }),
      fakeRow("local", { url: "file:///tmp/x.png" })
    ]
  });
  assert.equal(result.count, 1);
});

test("searchOpenLicensedImages：一个图库失败时保留另一个图库结果", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (`${url}`.includes("wikimedia")) throw new Error("offline");
    return {
      ok: true,
      json: async () => ({ results: [{
        title: "Open image",
        thumbnail: "https://images.example/open.jpg",
        creator: "Creator",
        license: "cc0"
      }] })
    };
  };
  try {
    const rows = await searchOpenLicensedImages("open image", { limit: 2 });
    assert.deepEqual(rows.map((item) => item.title), ["Open image"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
