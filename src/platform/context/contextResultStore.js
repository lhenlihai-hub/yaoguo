// @ts-check

const crypto = require("node:crypto");
const { constants: fsConstants } = require("node:fs");
const path = require("node:path");
const {
  mkdir,
  open,
  rename,
  rm,
  unlink,
  writeFile
} = require("node:fs/promises");
const { estimateTokens } = require("../tokens/tokenEstimator");

const RESULT_REF_PATTERN = /^ctxr_([a-f0-9]{64})$/;
const DEFAULT_INLINE_CHARS = 8000;
const DEFAULT_PREVIEW_CHARS = 2000;
const DEFAULT_READ_CHARS = 24000;
const MAX_READ_CHARS = 128000;

/**
 * @param {unknown} value
 * @param {Set<object>} [stack]
 * @returns {string|undefined}
 */
function stableJsonValue(value, stack = new Set()) {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return Number.isFinite(value) ? `${value}` : "null";
  if (["undefined", "function", "symbol"].includes(typeof value)) return undefined;
  if (typeof value === "bigint") throw new TypeError("工具结果不能包含 BigInt");
  if (typeof value !== "object") return JSON.stringify(value);

  if (stack.has(value)) throw new TypeError("工具结果不能包含循环引用");
  stack.add(value);
  try {
    const objectValue = /** @type {Record<string, unknown> & { toJSON?: () => unknown }} */ (value);
    if (typeof objectValue.toJSON === "function") {
      return stableJsonValue(objectValue.toJSON(), stack);
    }
    if (Array.isArray(value)) {
      return `[${value.map((item) => stableJsonValue(item, stack) ?? "null").join(",")}]`;
    }
    const fields = [];
    for (const key of Object.keys(objectValue).sort()) {
      const encoded = stableJsonValue(objectValue[key], stack);
      if (encoded !== undefined) fields.push(`${JSON.stringify(key)}:${encoded}`);
    }
    return `{${fields.join(",")}}`;
  } finally {
    stack.delete(value);
  }
}

/**
 * @param {unknown} value
 * @returns {{ contentType: "text"|"json", content: string }}
 */
function serializeContextResult(value) {
  if (typeof value === "string") return { contentType: "text", content: value };
  const content = stableJsonValue(value);
  if (content === undefined) throw new TypeError("工具结果必须是字符串或可序列化的 JSON 值");
  return { contentType: "json", content };
}

/**
 * @param {{ version?: number, trust?: string, contentType: string, content: string }} entry
 */
function createResultRef(entry) {
  const hash = crypto.createHash("sha256");
  if (entry.version !== 1) hash.update(entry.trust === "untrusted_external_data" ? "untrusted_external_data" : "trusted").update("\0");
  const digest = hash.update(entry.contentType)
    .update("\0")
    .update(entry.content)
    .digest("hex");
  return `ctxr_${digest}`;
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 */
function boundedInteger(value, fallback, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(numeric)));
}

/**
 * @typedef {object} StoredContextResult
 * @property {1|2} version
 * @property {string} resultRef
 * @property {string} toolName
 * @property {string} callId
 * @property {"text"|"json"} contentType
 * @property {string} content
 * @property {number} totalChars
 * @property {number} totalTokens
 * @property {"trusted"|"untrusted_external_data"} [trust]
 */

class ContextResultStore {
  /**
   * @param {{
   *   directory?: string,
   *   inlineChars?: number,
   *   previewChars?: number,
   *   defaultReadChars?: number,
   *   maxReadChars?: number
   * }} [options]
   */
  constructor(options = {}) {
    this.directory = options.directory ? path.resolve(options.directory) : "";
    this.inlineChars = boundedInteger(options.inlineChars, DEFAULT_INLINE_CHARS, 1, MAX_READ_CHARS);
    this.previewChars = boundedInteger(
      options.previewChars,
      DEFAULT_PREVIEW_CHARS,
      1,
      this.inlineChars
    );
    this.maxReadChars = boundedInteger(options.maxReadChars, MAX_READ_CHARS, 1, MAX_READ_CHARS);
    this.defaultReadChars = boundedInteger(
      options.defaultReadChars,
      DEFAULT_READ_CHARS,
      1,
      this.maxReadChars
    );
    /** @type {Map<string, StoredContextResult>} */
    this.entries = new Map();
  }

  /**
   * Store the complete tool value and return a bounded, model-safe descriptor.
   * @param {{ toolName?: string, callId?: string, value: unknown, trust?: "trusted"|"untrusted_external_data" }} input
   */
  async save(input) {
    const toolName = `${input?.toolName || ""}`;
    const callId = `${input?.callId || ""}`;
    /** @type {"trusted"|"untrusted_external_data"} */
    const trust = input?.trust === "untrusted_external_data" ? "untrusted_external_data" : "trusted";
    const serialized = serializeContextResult(input?.value);
    const base = { version: /** @type {2} */ (2), trust, toolName, callId, ...serialized };
    const resultRef = createResultRef(base);
    const existing = this.entries.get(resultRef)
      || (this.directory ? await this.load(resultRef) : null);
    /** @type {StoredContextResult} */
    const entry = existing || {
      resultRef,
      ...base,
      totalChars: serialized.content.length,
      totalTokens: estimateTokens(serialized.content)
    };
    if (!existing) {
      this.entries.set(resultRef, entry);
      if (this.directory) await this.persist(entry);
    }

    const inline = entry.totalChars <= this.inlineChars;
    const previewLimit = inline ? entry.totalChars : this.previewChars;
    const preview = entry.content.slice(0, previewLimit);
    const truncated = preview.length < entry.totalChars;
    const nextOffset = truncated ? preview.length : null;
    return {
      resultRef,
      toolName,
      callId,
      trust: entry.trust || "trusted",
      contentType: entry.contentType,
      totalChars: entry.totalChars,
      totalTokens: entry.totalTokens,
      deduplicated: Boolean(existing),
      inline,
      preview,
      truncated,
      nextOffset,
      compact: {
        resultRef,
        contentType: entry.contentType,
        totalChars: entry.totalChars,
        totalTokens: entry.totalTokens,
        preview,
        offsetChars: 0,
        truncated,
        nextOffset
      }
    };
  }

  /**
   * @param {{ resultRef?: string, offsetChars?: number, maxChars?: number }} input
   */
  async read(input = {}) {
    const resultRef = `${input.resultRef || ""}`.trim();
    if (!RESULT_REF_PATTERN.test(resultRef)) {
      return { ok: false, error: "resultRef 格式无效" };
    }
    const entry = await this.load(resultRef);
    if (!entry) return { ok: false, error: "resultRef 不存在或不可读取" };

    const offsetChars = boundedInteger(input.offsetChars, 0, 0, Number.MAX_SAFE_INTEGER);
    const maxChars = boundedInteger(
      input.maxChars,
      this.defaultReadChars,
      1,
      this.maxReadChars
    );
    const content = entry.content.slice(offsetChars, offsetChars + maxChars);
    const nextOffset = offsetChars + content.length < entry.totalChars
      ? offsetChars + content.length
      : null;
    return {
      ok: true,
      resultRef,
      toolName: entry.toolName,
      callId: entry.callId,
      contentType: entry.contentType,
      content,
      offsetChars,
      maxChars,
      totalChars: entry.totalChars,
      totalTokens: entry.totalTokens,
      trust: entry.trust || "trusted",
      truncated: nextOffset !== null,
      nextOffset
    };
  }

  /** @param {StoredContextResult} entry */
  async persist(entry) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const target = this.entryPath(entry.resultRef);
    const nonce = crypto.randomBytes(8).toString("hex");
    const temporary = path.join(this.directory, `.${entry.resultRef}.${nonce}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify(entry), { encoding: "utf8", flag: "wx", mode: 0o600 });
      await rename(temporary, target);
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }

  /** @param {string} resultRef */
  async load(resultRef) {
    const cached = this.entries.get(resultRef);
    if (cached) return cached;
    if (!this.directory) return null;
    const file = this.entryPath(resultRef);
    let handle = null;
    try {
      const noFollow = Number(fsConstants.O_NOFOLLOW) || 0;
      handle = await open(file, fsConstants.O_RDONLY | noFollow);
      const stats = await handle.stat();
      if (!stats.isFile()) return null;
      const parsed = JSON.parse(await handle.readFile({ encoding: "utf8" }));
      if (!this.isValidEntry(parsed, resultRef)) return null;
      this.entries.set(resultRef, parsed);
      return parsed;
    } catch {
      return null;
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  /**
   * @param {unknown} candidate
   * @param {string} expectedRef
   * @returns {candidate is StoredContextResult}
   */
  isValidEntry(candidate, expectedRef) {
    if (!candidate || typeof candidate !== "object") return false;
    const entry = /** @type {Record<string, any>} */ (candidate);
    if (![1, 2].includes(entry.version) || entry.resultRef !== expectedRef) return false;
    if (!["text", "json"].includes(entry.contentType)) return false;
    if (typeof entry.toolName !== "string" || typeof entry.callId !== "string") return false;
    if (typeof entry.content !== "string") return false;
    if (entry.totalChars !== entry.content.length) return false;
    if (entry.totalTokens !== estimateTokens(entry.content)) return false;
    if (entry.version === 2 && !["trusted", "untrusted_external_data"].includes(entry.trust)) return false;
    return createResultRef({
      version: entry.version,
      trust: entry.trust,
      contentType: entry.contentType,
      content: entry.content
    }) === expectedRef;
  }

  /** @param {string} resultRef */
  entryPath(resultRef) {
    if (!RESULT_REF_PATTERN.test(resultRef)) throw new Error("resultRef 格式无效");
    const file = path.resolve(this.directory, `${resultRef}.json`);
    if (!this.directory || path.dirname(file) !== this.directory) {
      throw new Error("resultRef 越出存储目录");
    }
    return file;
  }

  async cleanup() {
    this.entries.clear();
    if (this.directory) await rm(this.directory, { recursive: true, force: true });
  }
}

module.exports = {
  ContextResultStore,
  RESULT_REF_PATTERN,
  serializeContextResult
};
