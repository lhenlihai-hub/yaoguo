// @ts-check

const path = require("node:path");

const MEMORY_TYPES = Object.freeze(["user", "feedback", "project", "reference"]);
const MAX_INDEX_LINES = 200;
const MAX_INDEX_BYTES = 25 * 1024;
const MAX_INDEX_SUMMARY_CHARS = 150;
const MAX_TOPIC_BYTES = 128 * 1024;
const MEMORY_STALE_AFTER_DAYS = 1;

function parseTopicFrontMatter(content = "", file = "") {
  const parsed = parseTopicHeader(content, file);
  if (!parsed) return null;
  const { bodyStart: _bodyStart, source: _source, ...metadata } = parsed;
  return metadata;
}

function parseTopicFile(content = "", file = "") {
  const parsed = parseTopicHeader(content, file);
  if (!parsed) return null;
  const { source, bodyStart, ...metadata } = parsed;
  return {
    ...metadata,
    body: source.slice(bodyStart).trim()
  };
}

function parseTopicHeader(content = "", file = "") {
  const source = `${content || ""}`.replace(/\r\n?/g, "\n");
  if (!source.startsWith("---\n")) return null;
  const end = source.indexOf("\n---\n", 4);
  if (end < 0) return null;
  /** @type {Record<string, string>} */
  const metadata = {};
  for (const line of source.slice(4, end).split("\n")) {
    const match = line.match(/^([a-z][a-z0-9_]*)\s*:\s*(.*?)\s*$/i);
    if (!match) continue;
    metadata[match[1]] = parseScalar(match[2]);
  }
  const type = `${metadata.type || ""}`;
  const name = `${metadata.name || ""}`.trim();
  const description = oneLine(metadata.description);
  if (!MEMORY_TYPES.includes(type) || !name || !description) return null;
  if (charLength(description) > MAX_INDEX_SUMMARY_CHARS) return null;
  return {
    file: path.basename(file),
    name,
    description,
    type,
    createdAt: `${metadata.created_at || ""}`,
    updatedAt: `${metadata.updated_at || ""}`,
    source,
    bodyStart: end + 5
  };
}

function renderTopicFile(metadata = {}, body = "") {
  return [
    "---",
    `name: ${quoted(metadata.name)}`,
    `description: ${quoted(metadata.description)}`,
    `type: ${metadata.type}`,
    `created_at: ${quoted(metadata.createdAt)}`,
    `updated_at: ${quoted(metadata.updatedAt)}`,
    "---",
    "",
    `${body || ""}`.trim(),
    ""
  ].join("\n");
}

function renderMemoryIndex(topics = []) {
  const lines = [...topics]
    .sort((left, right) => `${left.file}`.localeCompare(`${right.file}`))
    .map((topic) => `[${topic.file}](./${topic.file}) — ${escapeMarkdownText(oneLine(topic.description))}`);
  const content = lines.length ? `${lines.join("\n")}\n` : "";
  assertMemoryIndexLimits(content);
  return content;
}

function assertMemoryIndexLimits(content = "") {
  const lines = `${content || ""}`.split("\n").filter(Boolean);
  if (lines.length > MAX_INDEX_LINES) {
    throw memdirError("MEMDIR_INDEX_LINE_LIMIT", `memory.md 不能超过 ${MAX_INDEX_LINES} 行`);
  }
  if (Buffer.byteLength(content, "utf8") > MAX_INDEX_BYTES) {
    throw memdirError("MEMDIR_INDEX_BYTE_LIMIT", `memory.md 不能超过 ${MAX_INDEX_BYTES} bytes`);
  }
}

function memoryIndexContext(content = "") {
  return [
    '<long-term-memory-index source="memory.md">',
    `${content || ""}`.trim() || "（当前 Memdir 为空）",
    "</long-term-memory-index>",
    "索引始终可见；主题正文只会由异步 Prefetch 旁路模型选择，或在你判断相关后调用 search_memory 进入上下文。"
  ].join("\n");
}

function memoryFreshness(topic = {}, now = new Date()) {
  const timestamp = newestTimestamp([
    topic.updatedAt,
    topic.modifiedAt,
    topic.createdAt
  ]);
  if (!timestamp) {
    return {
      timestamp: null,
      age: "时间未知",
      ageDays: null,
      stale: true,
      warning: "这条记忆的记录时间未知；它不是实时状态，引用前需要验证当前事实。"
    };
  }
  const ageDays = calendarDayDifference(timestamp, now);
  const age = ageDays === 0 ? "今天" : (ageDays === 1 ? "昨天" : `${ageDays} 天前`);
  const stale = ageDays > MEMORY_STALE_AFTER_DAYS;
  return {
    timestamp: timestamp.toISOString(),
    age,
    ageDays,
    stale,
    warning: stale
      ? `这条记忆是${age}的时间快照，不是实时状态；引用前需要验证当前事实。`
      : ""
  };
}

function newestTimestamp(values = []) {
  const dates = values
    .map((value) => value instanceof Date ? value : new Date(`${value || ""}`))
    .filter((date) => Number.isFinite(date.getTime()));
  if (!dates.length) return null;
  return dates.reduce((latest, date) => date > latest ? date : latest);
}

function calendarDayDifference(then, now) {
  const current = now instanceof Date ? now : new Date(now);
  const safeNow = Number.isFinite(current.getTime()) ? current : new Date();
  const dayNumber = (date) => Date.UTC(
    date.getFullYear(),
    date.getMonth(),
    date.getDate()
  ) / 86400000;
  return Math.max(0, Math.floor(dayNumber(safeNow) - dayNumber(then)));
}

function parseScalar(value = "") {
  const source = `${value || ""}`.trim();
  if (source.startsWith('"')) {
    try { return JSON.parse(source); } catch { return ""; }
  }
  return source;
}

function quoted(value = "") {
  return JSON.stringify(`${value || ""}`);
}

function oneLine(value = "") {
  return `${value || ""}`.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
}

function charLength(value = "") {
  return Array.from(`${value || ""}`).length;
}

function escapeMarkdownText(value = "") {
  return `${value || ""}`.replace(/([\\\[\]`])/g, "\\$1");
}

function memdirError(code, message) {
  const error = /** @type {Error & {code?: string}} */ (new Error(message));
  error.code = code;
  return error;
}

module.exports = {
  MEMORY_TYPES,
  MAX_INDEX_LINES,
  MAX_INDEX_BYTES,
  MAX_INDEX_SUMMARY_CHARS,
  MAX_TOPIC_BYTES,
  MEMORY_STALE_AFTER_DAYS,
  parseTopicFrontMatter,
  parseTopicFile,
  renderTopicFile,
  renderMemoryIndex,
  assertMemoryIndexLimits,
  memoryIndexContext,
  memoryFreshness,
  oneLine,
  charLength,
  escapeMarkdownText,
  memdirError
};
