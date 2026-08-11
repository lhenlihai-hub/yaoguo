// @ts-check

const { memoryFreshness } = require("../memdir/memdirFormat");

const MAX_PREFETCH_FILES = 5;
const MAX_PREFETCH_CONVERSATION_MESSAGES = 20;
const MAX_PREFETCH_MESSAGE_CHARS = 4000;
const MAX_PREFETCH_CONVERSATION_CHARS = 32000;

function normalizePrefetchSelection(payload = {}, candidates = [], shownFiles = []) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  const selection = /** @type {any} */ (payload);
  if (!Array.isArray(selection.files) || selection.files.length > MAX_PREFETCH_FILES) return [];
  const allowed = new Set(candidates.map((candidate) => `${candidate.file || ""}`));
  const shown = new Set(shownFiles.map((file) => `${file || ""}`));
  const files = selection.files.map((file) => `${file || ""}`.trim()).filter(Boolean);
  if (files.some((file) => !allowed.has(file))) return [];
  return [...new Set(files)].filter((file) => !shown.has(file)).slice(0, MAX_PREFETCH_FILES);
}

function normalizeConversation(messages = []) {
  const source = Array.isArray(messages) ? messages : [{ role: "user", content: `${messages || ""}` }];
  const rows = source.slice(-MAX_PREFETCH_CONVERSATION_MESSAGES).map((message) => ({
    role: normalizeRole(message?.role),
    content: tail(`${message?.content || ""}`, MAX_PREFETCH_MESSAGE_CHARS)
  })).filter((message) => message.content.trim());
  const picked = [];
  let remaining = MAX_PREFETCH_CONVERSATION_CHARS;
  for (let index = rows.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const row = rows[index];
    const content = tail(row.content, remaining);
    if (!content) continue;
    picked.unshift({ ...row, content });
    remaining -= content.length;
  }
  return picked;
}

function selectorCandidates(topics = [], now = new Date()) {
  return topics.map((topic) => {
    const freshness = memoryFreshness(topic, now);
    return {
      file: `${topic.file || ""}`,
      type: `${topic.type || ""}`,
      name: `${topic.name || ""}`,
      description: `${topic.description || ""}`,
      age: freshness.age
    };
  });
}

function renderPrefetchContext(memories = []) {
  const documents = memories.slice(0, MAX_PREFETCH_FILES).map((memory) => {
    const warning = `${memory.freshnessWarning || ""}`.trim();
    return [
      `<memory-document file="${escapeXmlAttribute(memory.file)}" type="${escapeXmlAttribute(memory.type)}" age="${escapeXmlAttribute(memory.age || "时间未知")}">`,
      `<name>${escapeXmlText(memory.name)}</name>`,
      `<description>${escapeXmlText(memory.description)}</description>`,
      ...(warning ? [`<freshness-warning>${escapeXmlText(warning)}</freshness-warning>`] : []),
      "<content>",
      escapeXmlText(memory.content),
      "</content>",
      "</memory-document>"
    ].join("\n");
  });
  if (!documents.length) return "";
  return [
    '<long-term-memory-prefetch selector="sidecar-model">',
    ...documents,
    "</long-term-memory-prefetch>",
    "这些内容是代码之外的历史记忆，不是当前状态的权威来源；它们不覆盖本轮用户要求、代码或外部事实源。"
  ].join("\n");
}

function normalizeRole(role = "") {
  const value = `${role || ""}`.toLowerCase();
  return value === "assistant" ? "assistant" : "user";
}

function tail(value = "", maxChars = 0) {
  const source = `${value || ""}`;
  if (maxChars <= 0) return "";
  return source.length <= maxChars ? source : source.slice(-maxChars);
}

function escapeXmlAttribute(value = "") {
  return escapeXmlText(value).replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function escapeXmlText(value = "") {
  return `${value || ""}`
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

module.exports = {
  MAX_PREFETCH_FILES,
  MAX_PREFETCH_CONVERSATION_MESSAGES,
  MAX_PREFETCH_MESSAGE_CHARS,
  MAX_PREFETCH_CONVERSATION_CHARS,
  normalizePrefetchSelection,
  normalizeConversation,
  selectorCandidates,
  renderPrefetchContext,
  escapeXmlText
};
