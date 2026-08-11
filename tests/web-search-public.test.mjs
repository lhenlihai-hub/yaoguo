// 免-key 公开检索：默认走 Jina s.jina.ai，失败回落 Bing RSS。

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { WebSearchService } = require("../src/platform/research/referenceServices.js");

function makeService() {
  return new WebSearchService({}, { get: async () => ({}) });
}

const lookupImpl = async () => [{ address: "93.184.216.34", family: 4 }];

function response(body, status = 200, headers = {}) {
  return new Response(body, { status, headers });
}

test("searchPublicWeb 默认走 Jina，解析 data[] 为 snippet 列表", async () => {
  const fetchImpl = async (url) => {
    assert.ok(url.includes("s.jina.ai"), "应命中 Jina 端点");
    return response(JSON.stringify({
      data: [
        { title: "高考时间公告", url: "https://gov.cn/a", description: "2026 年高考 6 月 7 日开始" },
        { title: "无 url 的脏数据", description: "应被过滤" }
      ]
    }), 200, { "content-type": "application/json" });
  };
  const svc = makeService();
  const rows = await svc.searchPublicWeb("2026 高考时间", { fetchImpl, lookupImpl });
  assert.equal(rows.length, 1, "无 url 的结果应被过滤");
  assert.equal(rows[0].searchProvider, "jina");
  assert.equal(rows[0].url, "https://gov.cn/a");
  assert.match(rows[0].snippet, /6 月 7 日/);
});

test("searchPublicWeb：Jina 失败时静默回落 Bing RSS", async () => {
  const rss = `<rss><channel>
    <item><title>回落结果</title><link>https://example.com/x</link><description>来自 RSS</description></item>
  </channel></rss>`;
  const fetchImpl = async (url) => (
    url.includes("s.jina.ai")
      ? response("rate limited", 429)
      : response(rss, 200, { "content-type": "application/rss+xml" })
  );
  const svc = makeService();
  const rows = await svc.searchPublicWeb("x", { fetchImpl, lookupImpl });
  assert.ok(rows.length >= 1);
  assert.equal(rows[0].searchProvider, "public-rss");
  assert.equal(rows[0].url, "https://example.com/x");
});

test("searchPublicWeb：publicProvider=bing-rss 时跳过 Jina 直连 RSS", async () => {
  let jinaCalled = false;
  const rss = `<rss><channel><item><title>t</title><link>https://e.com/1</link><description>d</description></item></channel></rss>`;
  const fetchImpl = async (url) => {
    if (url.includes("s.jina.ai")) jinaCalled = true;
    return response(rss, 200, { "content-type": "application/rss+xml" });
  };
  const svc = makeService();
  const rows = await svc.searchPublicWeb("x", {
    publicProvider: "bing-rss",
    fetchImpl,
    lookupImpl
  });
  assert.equal(jinaCalled, false, "强制 RSS 时不应调用 Jina");
  assert.equal(rows[0].searchProvider, "public-rss");
});
