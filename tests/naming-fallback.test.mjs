import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  summarizeNameFromMessage,
  summarizeProjectNameFromMessage,
  compactGeneratedName,
  extractDeliverableTitle,
  deriveArtifactName
} = require("../src/platform/runtime/contentSignals.js");

test("Bug 2: 命名兜底剥离常见废话前缀，不再返回'我们现在开'", () => {
  const msg = "我们现在开始制作一份风险报告，主题是缓存稳定性，验收标准是给出复现步骤。";
  // 之前 fallback 返回 "我们现在开"（5 字截首字符）
  const projectName = summarizeProjectNameFromMessage(msg, "新项目", 5);
  assert.notEqual(projectName, "我们现在开", "项目名兜底不应是截首字符");
  assert.equal(projectName.startsWith("我们"), false, "项目名不应以 '我们' 开头");
  assert.match(projectName, /缓存|稳定性/, `项目名应反映核心意图，实际：${projectName}`);
});

test("Bug 2: 对话标题剥离多层前缀", () => {
  const msg = "我们现在开始制作一份报告，主题是缓存稳定性";
  const title = summarizeNameFromMessage(msg, "新对话", 10);
  assert.notEqual(title, "我们现在开始写一篇网", "对话标题不应是截首字符");
  assert.equal(title.startsWith("我们"), false);
  assert.match(title, /缓存|稳定性/, `对话标题应包含核心主题，实际：${title}`);
});

test("Bug 2: 短任务命名仍能拿到合理结果（无主题陈述句）", () => {
  // 没有"主题是"的句子也应能提取
  const t1 = summarizeNameFromMessage("帮我制作一个产品介绍方案", "新对话", 10);
  assert.notEqual(t1.startsWith("帮我"), true);
  const t2 = summarizeNameFromMessage("生成一份关于人工智能的行业报告", "新对话", 10);
  assert.notEqual(t2.startsWith("生成一份"), true);
});

test("Bug 2: 目标是 / 题目是 / 主题是 多种触发词都能提取主题", () => {
  const t1 = summarizeNameFromMessage("制作评估，目标是降低缓存抖动", "新对话", 10);
  assert.match(t1, /缓存|抖动/);
  const t2 = summarizeNameFromMessage("生成报告，主题是 AI 安全", "新对话", 10);
  assert.match(t2, /AI|安全/i);
  const t3 = summarizeNameFromMessage("写一篇推文，题目是 GPT-5 评测", "新对话", 18);
  assert.match(t3, /GPT|评测|GPT-5/i);
});

test("Bug 2: 空消息或纯标点回落到 fallback 字符串", () => {
  assert.equal(summarizeNameFromMessage("", "默认对话", 10), "默认对话");
  assert.equal(summarizeNameFromMessage("。。。", "默认对话", 10), "默认对话");
});

test("Bug 2: compactGeneratedName 仍能识别 AI 返回的纯净标题", () => {
  // 模拟 LLM 返回值
  assert.equal(compactGeneratedName("缓存风险评估", "新对话", 10), "缓存风险评估");
  assert.equal(compactGeneratedName("```json\n缓存\n```", "新项目", 5), "缓存");
  // compactGeneratedName 用 maxLength 截 → fallback 5 字 "fallb"
  assert.equal(compactGeneratedName("", "fallback", 8), "fallback");
});

test("命名：最终生成物优先使用正文标题，不再使用整句用户指令", () => {
  const msg = "我们现在来制作一份全新的评估报告，主题是银发用户，目标群体是退休老人。";
  const content = "**标题**：银发用户产品评估\n\n**结论**\n当前交互存在三个主要阻力。";
  assert.equal(extractDeliverableTitle(content), "银发用户产品评估");
  assert.equal(deriveArtifactName({
    message: msg,
    taskTitle: "新对话",
    content,
    fallback: "最终成品"
  }), "银发用户产品评估");
});

test("命名：没有正文标题时，用用户意图摘要而不是原始长句", () => {
  const msg = "我们现在来制作一份全新的评估报告，主题是银发用户，目标群体是退休老人。";
  const name = deriveArtifactName({ message: msg, taskTitle: "", content: "", fallback: "最终成品" });
  assert.equal(name, "银发用户");
});
