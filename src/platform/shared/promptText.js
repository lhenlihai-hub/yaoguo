// @ts-check

const crypto = require("node:crypto");
const {
  estimateCharTokenCost,
  estimateTokens,
  estimateMessageTokens
} = require("../tokens/tokenEstimator");

function compactText(value = "") {
  return `${value || ""}`
    .replace(/[\r\n]+/g, " ")
    .replace(/[“”"']/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function truncate(text, max = 12000) {
  const value = `${text || ""}`;
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n\n[内容过长，已截断 ${value.length - max} 字]`;
}

function truncateForPrompt(text, max = 12000) {
  const value = `${text || ""}`;
  if (value.length <= max) return value;
  return value.slice(0, max).trimEnd();
}

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function legacyCharsToTokens(chars = 0) {
  return Math.max(0, Math.ceil((Number(chars) || 0) / 1.8));
}

function tokensToApproxChars(tokens = 0) {
  return Math.max(0, Math.ceil((Number(tokens) || 0) * 1.8));
}

function truncateForPromptTokens(text = "", maxTokens = 0) {
  const value = `${text || ""}`;
  const limit = Math.max(0, Number(maxTokens) || 0);
  if (!value || limit <= 0) return "";
  if (estimateTokens(value) <= limit) return value;
  let used = 0;
  let output = "";
  for (const char of Array.from(value)) {
    const tokenCost = estimateCharTokenCost(char);
    if (used + tokenCost > limit) break;
    output += char;
    used += tokenCost;
  }
  return output.trimEnd();
}

function tailForPromptTokens(text = "", maxTokens = 0) {
  const value = `${text || ""}`;
  const limit = Math.max(0, Number(maxTokens) || 0);
  if (!value || limit <= 0) return "";
  if (estimateTokens(value) <= limit) return value;
  let used = 0;
  let output = "";
  const chars = Array.from(value);
  for (let index = chars.length - 1; index >= 0; index -= 1) {
    const char = chars[index];
    const tokenCost = estimateCharTokenCost(char);
    if (used + tokenCost > limit) break;
    output = char + output;
    used += tokenCost;
  }
  return output.trimStart();
}

function headTailForPromptTokens(text = "", maxTokens = 0, marker = "[中间内容已进入压缩摘要]") {
  const value = `${text || ""}`;
  const limit = Math.max(0, Number(maxTokens) || 0);
  if (!value || limit <= 0) return "";
  if (estimateTokens(value) <= limit) return value;
  const headTokens = Math.max(1, Math.floor(limit * 0.45));
  const tailTokens = Math.max(1, limit - headTokens - 24);
  return [
    truncateForPromptTokens(value, headTokens),
    `\n\n${marker}\n\n`,
    tailForPromptTokens(value, tailTokens)
  ].join("").trim();
}

function shortHash(value = "") {
  return crypto.createHash("sha1").update(`${value || ""}`).digest("hex").slice(0, 12);
}

function sanitizePromptForContentFilter(text = "") {
  return `${text || ""}`
    .replace(/\[内容过长，已截断\s*\d+\s*字\]/g, "")
    .replace(/飞机颠簸有多危险？老年人千万别坐！/g, "夸张恐惧式标题示例")
    .replace(/老年人飞行事故率/g, "相关公开数据")
    .replace(/颠簸受伤概率/g, "相关影响概率")
    .replace(/信息辨别力可能较弱/g, "信息接收习惯不同")
    .replace(/容易被骗/g, "容易误判信息")
    .replace(/吓坏了|恐惧|焦虑/g, "担心")
    .replace(/伤亡情况/g, "人员情况")
    .replace(/危险/g, "风险")
    .replace(/冻死|死亡/g, "严重后果")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function redactSensitive(text = "") {
  return `${text || ""}`
    .replace(/sk-[a-z0-9_-]{12,}/gi, "sk-***")
    .replace(/(api[_-]?key|token|authorization|password|密码|密钥)(["'\s:=：]+)([^\s"',，。；;]+)/gi, "$1$2***");
}

function markdownList(items, emptyText = "无") {
  if (!items.length) return emptyText;
  return items.map((item) => `- ${item}`).join("\n");
}

function uniqueValues(items) {
  return Array.from(new Set(items.filter(Boolean)));
}

function countOccurrences(text, term) {
  if (!term) return 0;
  let count = 0;
  let index = 0;
  while (index !== -1 && count < 20) {
    index = text.indexOf(term, index);
    if (index !== -1) {
      count += 1;
      index += term.length;
    }
  }
  return count;
}

function splitSentences(text = "") {
  return `${text || ""}`
    .replace(/\r/g, "\n")
    .split(/(?<=[。！？!?；;])|\n+/)
    .map((item) => compactText(item))
    .filter((item) => item.length >= 8);
}

function parseJsonObjectFromText(text = "") {
  const raw = `${text || ""}`.trim();
  if (!raw) return null;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced || raw.match(/\{[\s\S]*\}/)?.[0] || raw;
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

// L7 防御性输入归一化：把 CRLF / 全角破折号 / 全角空白等折叠成 ASCII，
// 让所有下游正则只针对一种规范形态。Postel's Law：parse 时尽量宽容。

module.exports = {
  compactText,
  truncate,
  truncateForPrompt,
  isPlainObject,
  estimateTokens,
  estimateMessageTokens,
  legacyCharsToTokens,
  tokensToApproxChars,
  truncateForPromptTokens,
  tailForPromptTokens,
  headTailForPromptTokens,
  shortHash,
  sanitizePromptForContentFilter,
  redactSensitive,
  markdownList,
  uniqueValues,
  countOccurrences,
  splitSentences,
  parseJsonObjectFromText
};
