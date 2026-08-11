// 视觉之手：buildDeckHtml 把结构化脚本渲染成设计系统化的 HTML（投屏正文上屏、讲解进备注、
// 配色来自基调、无 AI-slop 装饰线），复用 create.js 的解析器。

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { buildDeckHtml } = require(join(root, "workspace/registries/skills/pptx/scripts/deckHtml.js"));

const MD = [
  "## 第1页：开场",
  "",
  "**屏幕主文字**",
  "",
  "> 一句话钩子。",
  "> 第二行钩子。",
  "",
  "**讲解参考词**",
  "",
  "这里是老师的口播稿。",
  "",
  "`┌ 版式 ┐` 左图右文。`└──┘`",
  "",
  "## 数据",
  "",
  "| 指标 | 值 |",
  "|---|---|",
  "| A | 1 |"
].join("\n");

test("buildDeckHtml：封面 + 投屏正文为 hero，不泄露字段标签", () => {
  const html = buildDeckHtml(MD, { title: "测试课件", brief: { accent: "#9e2b25" } });
  assert.match(html, /class="slide cover"/);
  assert.match(html, /测试课件/);
  assert.match(html, /class="hero"/);
  assert.match(html, /一句话钩子/);
  assert.ok(!/屏幕主文字/.test(html), "字段标签不应上屏");
});

test("buildDeckHtml：讲解词 + 版式进备注 aside，不上屏", () => {
  const html = buildDeckHtml(MD, { title: "测试课件" });
  assert.match(html, /class="notes"/);
  assert.match(html, /口播稿/);
  assert.match(html, /版式/);
});

test("buildDeckHtml：配色来自 brief，且零装饰横线（去 AI-slop）", () => {
  const html = buildDeckHtml(MD, { title: "测试课件", brief: { accent: "#9e2b25" } });
  assert.match(html, /#9e2b25/, "强调色应取自 brief");
  assert.ok(!/<hr/.test(html), "不应有装饰横线");
});

test("buildDeckHtml：无屏幕主文字的页走 content（标题 + 表格）", () => {
  const html = buildDeckHtml(MD, { title: "测试课件" });
  assert.match(html, /class="slide content"/);
  assert.match(html, /<table>/);
  assert.match(html, /指标/);
});
