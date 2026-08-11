import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { staticVisualIssues, mergeVisualIssues, visualIssueMessages } = require("../src/platform/ai/visualQuality.js");
const { parseOpenverseResponse, isReusableLicense } = require("../src/platform/media/openverseImages.js");

test("staticVisualIssues：不把是否使用图片固化为质量判据", () => {
  const issues = staticVisualIssues({ html: "<style>section{padding:2rem}</style><section>正文</section>", medium: "deck" });
  assert.equal(issues.some((item) => item.code === "IMAGE_UNUSED"), false);
});

test("staticVisualIssues：没有样式或页面容器的文本壳不是视觉成品", () => {
  const issues = staticVisualIssues({ html: "<html><body>无法制作</body></html>", medium: "deck" });
  assert.ok(issues.some((item) => item.code === "VISUAL_STYLE_MISSING"));
  assert.ok(issues.some((item) => item.code === "VISUAL_STRUCTURE_MISSING"));
  assert.ok(issues.some((item) => item.code === "DECK_SECTION_MISSING"));
});

test("staticVisualIssues：只验收模型显式声明的交互能力与必备文字", () => {
  const incomplete = staticVisualIssues({
    html: "<style>main{padding:2rem}</style><main>品牌首页</main>",
    medium: "webpage",
    requirements: { capabilities: ["scroll_interaction"], requiredText: ["飞天茅台"] }
  });
  assert.ok(incomplete.some((item) => item.code === "VISUAL_CAPABILITY_MISSING_SCROLL_INTERACTION"));
  assert.ok(incomplete.some((item) => item.code === "VISUAL_REQUIRED_TEXT_MISSING"));

  const complete = staticVisualIssues({
    html: "<style>main{padding:2rem}</style><main>飞天茅台</main><script>addEventListener('wheel',()=>{})</script>",
    medium: "webpage",
    requirements: { capabilities: ["scroll_interaction"], requiredText: ["飞天茅台"] }
  });
  assert.equal(complete.some((item) => item.code.startsWith("VISUAL_CAPABILITY_MISSING")), false);
  assert.equal(complete.some((item) => item.code === "VISUAL_REQUIRED_TEXT_MISSING"), false);
});

test("mergeVisualIssues：把 DOM 越界与裁切转换成可执行说明", () => {
  const issues = mergeVisualIssues({
    html: "<section><img src='https://x/a.jpg'></section>",
    medium: "deck",
    layout: { issues: [{ code: "TEXT_CLIPPED", pageIndex: 1, selector: ".body", amount: 28 }] }
  });
  assert.match(visualIssueMessages(issues).join("\n"), /第 2 页正文被裁切/);
  assert.match(visualIssueMessages(issues).join("\n"), /\.body/);
});

test("Openverse：只保留允许商业使用与修改的开放许可", () => {
  assert.equal(isReusableLicense("by-sa"), true);
  assert.equal(isReusableLicense("by-nc"), false);
  const rows = parseOpenverseResponse({ results: [
    { title: "A", thumbnail: "https://x/a.jpg", creator: "甲", license: "by-sa" },
    { title: "B", thumbnail: "https://x/b.jpg", creator: "乙", license: "by-nc" }
  ] });
  assert.deepEqual(rows.map((item) => item.title), ["A"]);
});
