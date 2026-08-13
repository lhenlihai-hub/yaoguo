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

// 终端输出安全：剥离 ANSI/CSI/OSC 转义序列，以及除 \t\n\r 外的全部 C0/C1
// 控制字符。模型输出、磁盘文件名与错误文本在进入终端前都必须经过这里，
// 防止终端标题篡改、清屏或 OSC 52 剪贴板写入等终端控制注入。
const ANSI_ESCAPE_SEQUENCE_PATTERN = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*|[a-zA-Z\d]+(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

function stripTerminalControlSequences(value = "") {
  return `${value || ""}`
    .replace(ANSI_ESCAPE_SEQUENCE_PATTERN, "")
    .replace(CONTROL_CHARACTER_PATTERN, "");
}

module.exports = {
  estimateTokens,
  estimateMessageTokens,
  truncate,
  compactText,
  sha1,
  stableJson,
  hashObject,
  redactSensitive,
  stripTerminalControlSequences
};
