// @ts-check

const crypto = require("node:crypto");
const {
  MEMORY_TYPES,
  MAX_INDEX_SUMMARY_CHARS,
  oneLine,
  charLength,
  memdirError
} = require("./memdirFormat");

const TYPE_BASIS = Object.freeze({
  user: "user-stated-profile",
  feedback: "user-evaluated-ai-behavior",
  project: "user-stated-noncode-context",
  reference: "external-system-pointer"
});
const FEEDBACK_POLARITIES = Object.freeze(["positive", "negative"]);
const MAX_NAME_CHARS = 80;
const MAX_CONTENT_CHARS = 8000;
const MAX_RATIONALE_CHARS = 300;
const MAX_REFERENCE_CHARS = 2048;

function validateMemoryWrite(input = {}) {
  const type = `${input.type || ""}`.trim();
  if (!MEMORY_TYPES.includes(type)) {
    throw memdirError("MEMDIR_TYPE_INVALID", `type 只允许 ${MEMORY_TYPES.join("/")}`);
  }
  const basis = `${input.basis || ""}`.trim();
  if (basis !== TYPE_BASIS[type]) {
    throw memdirError("MEMDIR_BASIS_INVALID", `${type} 必须声明 basis=${TYPE_BASIS[type]}`);
  }
  const topic = `${input.topic || ""}`.trim().toLowerCase();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(topic) || topic.length > 60) {
    throw memdirError("MEMDIR_TOPIC_INVALID", "topic 必须是 ≤60 字符的小写 ASCII kebab-case");
  }
  const name = oneLine(input.name);
  if (!name || charLength(name) > MAX_NAME_CHARS) {
    throw memdirError("MEMDIR_NAME_INVALID", `name 必须为 1–${MAX_NAME_CHARS} 字符`);
  }
  const description = oneLine(input.description);
  if (!description || charLength(description) > MAX_INDEX_SUMMARY_CHARS) {
    throw memdirError("MEMDIR_DESCRIPTION_INVALID", `description 必须为 1–${MAX_INDEX_SUMMARY_CHARS} 字符的单行摘要`);
  }
  const content = `${input.content || ""}`.replace(/\r\n?/g, "\n").trim();
  if (!content || charLength(content) > MAX_CONTENT_CHARS) {
    throw memdirError("MEMDIR_CONTENT_INVALID", `content 必须为 1–${MAX_CONTENT_CHARS} 字符`);
  }
  const rationale = oneLine(input.valueBeyondCode);
  if (!rationale || charLength(rationale) > MAX_RATIONALE_CHARS) {
    throw memdirError("MEMDIR_VALUE_BASIS_INVALID", `valueBeyondCode 必须为 1–${MAX_RATIONALE_CHARS} 字符`);
  }
  if (containsCredential(`${name}\n${description}\n${content}\n${rationale}`)) {
    throw memdirError("MEMDIR_SECRET_REJECTED", "长期记忆不能保存密钥、令牌或凭据");
  }
  if (/<!--\s*yaoguo:memory:/i.test(content)) {
    throw memdirError("MEMDIR_RESERVED_MARKER_REJECTED", "长期记忆正文不能包含宿主保留的去重标记");
  }
  if (type === "project" && containsRelativeDate(`${name}\n${description}\n${content}\n${rationale}`)) {
    throw memdirError(
      "MEMDIR_RELATIVE_DATE_REJECTED",
      `project 记忆中的相对日期必须改成绝对日期；当前日期为 ${localDate()}`
    );
  }
  const polarity = `${input.polarity || ""}`.trim();
  if (type === "feedback" && !FEEDBACK_POLARITIES.includes(polarity)) {
    throw memdirError("MEMDIR_FEEDBACK_POLARITY_REQUIRED", "feedback 必须声明 polarity=positive 或 negative");
  }
  if (type !== "feedback" && polarity) {
    throw memdirError("MEMDIR_FEEDBACK_POLARITY_INVALID", "只有 feedback 可以声明 polarity");
  }
  const reference = oneLine(input.reference);
  if (type === "reference") validateExternalPointer(reference);
  if (type !== "reference" && reference) {
    throw memdirError("MEMDIR_REFERENCE_INVALID", "只有 reference 可以声明 reference 指针");
  }
  const file = `${type}-${topic}.md`;
  const entryDigest = crypto.createHash("sha256").update(JSON.stringify({
    type, content, polarity, reference
  })).digest("hex");
  return {
    type,
    basis,
    topic,
    file,
    name,
    description,
    content,
    rationale,
    polarity,
    reference,
    entryDigest
  };
}

function renderMemoryEntry(memory, now = new Date().toISOString()) {
  const rows = [
    `<!-- yaoguo:memory:${memory.entryDigest} -->`,
    `## ${now}`
  ];
  if (memory.type === "feedback") {
    rows.push(`**反馈方向：** ${memory.polarity === "positive" ? "正向确认" : "负向纠正"}`);
  }
  if (memory.type === "reference") {
    rows.push(`**外部指针：** \`${escapeBackticks(memory.reference)}\``);
  }
  rows.push("", memory.content, "", `**跨会话价值：** ${memory.rationale}`);
  return rows.join("\n").trim();
}

function containsRelativeDate(value = "") {
  return /(?:今天|明天|后天|昨天|前天|本周|下周|上周|这个月|下个月|上个月|月底|年末|明年|去年|tomorrow|yesterday|next\s+(?:week|month|year|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|last\s+(?:week|month|year)|this\s+(?:week|month|year))/i.test(`${value || ""}`);
}

function containsCredential(value = "") {
  return /(?:sk-[a-z0-9_-]{12,}|(?:api[_ -]?key|access[_ -]?token|authorization|password|密码|密钥)\s*[:=：]\s*\S+|bearer\s+[a-z0-9._-]{8,})/i.test(`${value || ""}`);
}

function validateExternalPointer(value = "") {
  if (!value || charLength(value) > MAX_REFERENCE_CHARS || /[\r\n\0]/.test(value)) {
    throw memdirError("MEMDIR_REFERENCE_INVALID", `reference 必须为 1–${MAX_REFERENCE_CHARS} 字符的单行外部指针`);
  }
  if (/^(?:[\\/]|~[\\/]|\.{1,2}[\\/]|[a-z]:[\\/])/i.test(value)) {
    throw memdirError("MEMDIR_REFERENCE_LOCAL_PATH", "reference 只能指向外部系统，不能保存本地文件路径");
  }
  if (containsCredential(value) || /https?:\/\/[^/\s]+@/i.test(value)) {
    throw memdirError("MEMDIR_SECRET_REJECTED", "外部指针不能包含凭据");
  }
  const recognizable = /^(?:https?:\/\/|[a-z][a-z0-9+.-]*:\/\/|#[a-z0-9_-]+$|[A-Z][A-Z0-9]+-\d+$)/i.test(value);
  if (!recognizable) {
    throw memdirError("MEMDIR_REFERENCE_INVALID", "reference 必须是 URL、外部系统 URI、Issue ID 或频道指针");
  }
}

function escapeBackticks(value = "") {
  return `${value || ""}`.replace(/`/g, "\\`");
}

function localDate(date = new Date()) {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

module.exports = {
  TYPE_BASIS,
  FEEDBACK_POLARITIES,
  validateMemoryWrite,
  renderMemoryEntry,
  containsRelativeDate,
  containsCredential,
  validateExternalPointer,
  localDate
};
