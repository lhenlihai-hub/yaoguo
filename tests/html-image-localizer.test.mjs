// 视觉 HTML 配图本地化：远程 <img> 下载成 data: 内联（供 Chromium 离线渲染 PDF），
// 失败的图移除其 <img>，本地/data: 图原样保留。fetchImpl 注入，不依赖网络。

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  collectRemoteImageUrls,
  localizeHtmlImages,
  parseImgSrc,
  normalizeMime
} = require("../src/platform/media/htmlImageLocalizer.js");

// 假 Response：可控 ok / content-type / 字节。
function okImage(bytes = [1, 2, 3], contentType = "image/png") {
  return {
    ok: true,
    headers: { get: () => contentType },
    arrayBuffer: async () => Uint8Array.from(bytes).buffer
  };
}

test("parseImgSrc：取出 src 位置与值（双/单/无引号）", () => {
  assert.equal(parseImgSrc('<img src="https://x/1.png" alt="a">').value, "https://x/1.png");
  assert.equal(parseImgSrc("<img alt='a' src='https://x/2.png'>").value, "https://x/2.png");
  assert.equal(parseImgSrc("<img src=https://x/3.png>").value, "https://x/3.png");
  assert.equal(parseImgSrc("<img alt='no-src'>"), null);
});

test("normalizeMime：优先 content-type，否则按扩展名，再兜底 jpeg", () => {
  assert.equal(normalizeMime("image/webp; charset=binary", "x"), "image/webp");
  assert.equal(normalizeMime("", "https://x/a.PNG?v=1"), "image/png");
  assert.equal(normalizeMime("text/html", "https://x/a"), "image/jpeg");
});

test("collectRemoteImageUrls 与下载器共享去重和数量边界", () => {
  const html = [
    '<img src="https://8.8.8.8/a.png">',
    '<img src="https://8.8.8.8/a.png">',
    "<img src='https://1.1.1.1/b.png'>",
    '<img src="local.png">'
  ].join("");
  assert.deepEqual(collectRemoteImageUrls(html, 1), ["https://8.8.8.8/a.png"]);
  assert.deepEqual(collectRemoteImageUrls(html, 24), [
    "https://8.8.8.8/a.png",
    "https://1.1.1.1/b.png"
  ]);
});

test("localizeHtmlImages：远程图内联成 data:，本地图不动", async () => {
  const html = '<section><img src="https://8.8.8.8/a.png"><img src="local.png"></section>';
  const r = await localizeHtmlImages({ html, fetchImpl: async () => okImage() });
  assert.equal(r.total, 1);
  assert.equal(r.localized, 1);
  assert.match(r.html, /<img src="data:image\/png;base64,[A-Za-z0-9+/=]+">/);
  assert.match(r.html, /<img src="local\.png">/);
});

test("localizeHtmlImages：下载失败 / 超限 → 移除该 <img>", async () => {
  const html = '<img src="https://8.8.8.8/bad.png"><img src="https://8.8.8.8/big.png">';
  const fetchImpl = async (url) => url.includes("bad")
    ? { ok: false, headers: { get: () => "" }, arrayBuffer: async () => new ArrayBuffer(0) }
    : okImage([0, 0, 0, 0, 0]); // 5 字节
  const r = await localizeHtmlImages({ html, fetchImpl, maxBytes: 3 }); // big 超 3 字节
  assert.equal(r.removed, 2);
  assert.equal(r.localized, 0);
  assert.doesNotMatch(r.html, /<img/);
});

test("localizeHtmlImages：同一 URL 只下载一次，两个 <img> 都替换", async () => {
  let calls = 0;
  const html = '<img src="https://8.8.8.8/same.png"><img src="https://8.8.8.8/same.png">';
  const r = await localizeHtmlImages({ html, fetchImpl: async () => { calls += 1; return okImage(); } });
  assert.equal(calls, 1);
  assert.equal((r.html.match(/data:image/g) || []).length, 2);
});

test("localizeHtmlImages：无远程图原样返回", async () => {
  const html = "<section>纯文字</section>";
  const r = await localizeHtmlImages({ html, fetchImpl: async () => okImage() });
  assert.equal(r.total, 0);
  assert.equal(r.html, html);
});

test("localizeHtmlImages：私网图片在发起请求前被 SSRF 守卫移除", async () => {
  let calls = 0;
  const html = '<img src="http://127.0.0.1/admin.png">';
  const result = await localizeHtmlImages({
    html,
    fetchImpl: async () => { calls += 1; return okImage(); }
  });
  assert.equal(calls, 0);
  assert.equal(result.removed, 1);
  assert.doesNotMatch(result.html, /<img/);
});

test("localizeHtmlImages：重定向到私网时停止，不跟随第二跳", async () => {
  let calls = 0;
  const result = await localizeHtmlImages({
    html: '<img src="https://8.8.8.8/redirect.png">',
    fetchImpl: async () => {
      calls += 1;
      return {
        ok: false,
        status: 302,
        headers: { get: (name) => name === "location" ? "http://127.0.0.1/private.png" : "" }
      };
    }
  });
  assert.equal(calls, 1);
  assert.equal(result.removed, 1);
});

test("localizeHtmlImages：流式响应超过 maxBytes 时提前取消", async () => {
  const response = new Response(Uint8Array.from([1, 2, 3, 4, 5]), {
    status: 200,
    headers: { "content-type": "image/png" }
  });
  const result = await localizeHtmlImages({
    html: '<img src="https://8.8.8.8/large.png">',
    fetchImpl: async () => response,
    maxBytes: 3
  });
  assert.equal(result.localized, 0);
  assert.equal(result.removed, 1);
});
