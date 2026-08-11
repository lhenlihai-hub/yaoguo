// @ts-check

const crypto = require("node:crypto");
const { estimateTokens, estimateMessageTokens } = require("../tokens/tokenEstimator");

function truncate(text = "", max = 12000) {
  const value = String(text || "");
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n\n[内容过长，已截断 ${value.length - max} 字]`;
}

function compactText(text = "") {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function sha1(text = "") {
  return crypto.createHash("sha1").update(String(text || "")).digest("hex");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function hashObject(value) {
  return sha1(stableJson(value));
}

function redactSensitive(text = "") {
  return String(text || "")
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, "sk-***")
    .replace(/Bearer\s+[A-Za-z0-9._-]{12,}/gi, "Bearer ***")
    .replace(/(api[_-]?key|token|authorization|password|密码|密钥)(["'\s:=：]+)([^\s"',，。；;]+)/gi, "$1$2***");
}

module.exports = {
  estimateTokens,
  estimateMessageTokens,
  truncate,
  compactText,
  sha1,
  stableJson,
  hashObject,
  redactSensitive
};
