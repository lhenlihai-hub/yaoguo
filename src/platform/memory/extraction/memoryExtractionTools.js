// @ts-check

const fsp = require("node:fs/promises");
const fs = require("node:fs");
const path = require("node:path");
const picomatch = require("picomatch");
const { AgentToolRegistry } = require("../../ai/agentTools/agentToolRegistry");
const { PIN_MEMORY_TOOL_SCHEMA } = require("../../ai/agentTools/pinMemoryTool");
const { validateMemoryWrite } = require("../memdir/memdirPolicy");

const MEMORY_FILE_PATTERN = /^(?:user|feedback|project|reference)-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;
const READ_TOOL_NAMES = new Set(["read", "grep", "read_context_result"]);
const WRITE_TOOL_NAMES = new Set(["write_memory"]);
const MAX_READ_FILE_BYTES = 1024 * 1024;
const MAX_READ_LINES = 400;
const MAX_READ_CHARS = 32000;
const MAX_GREP_FILES = 200;
const MAX_GREP_FILE_BYTES = 512 * 1024;
const MAX_GREP_MATCHES = 100;
const MAX_GREP_DIRECTORIES = 400;

const READ_TOOL_SCHEMA = {
  type: "function",
  function: {
    name: "read",
    description: "读取一个文件或列出一个目录。相对路径以当前 Memdir 为基准；可读取其他绝对路径，但不得借此调查源码、Git 历史或验证代码 pattern。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: { type: "string", minLength: 1, maxLength: 4096 },
        offset: { type: "integer", minimum: 1, maximum: 1000000 },
        limit: { type: "integer", minimum: 1, maximum: MAX_READ_LINES }
      },
      required: ["path"]
    }
  }
};

const GREP_TOOL_SCHEMA = {
  type: "function",
  function: {
    name: "grep",
    description: "在指定文件或目录中执行只读正则搜索。只用于定位可能已存在的记忆，不用于调查源码、Git 历史或验证某个代码 pattern。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        pattern: { type: "string", minLength: 1, maxLength: 200 },
        path: { type: "string", minLength: 1, maxLength: 4096 },
        include: { type: "string", maxLength: 200 },
        caseInsensitive: { type: "boolean" }
      },
      required: ["pattern", "path"]
    }
  }
};

const WRITE_MEMORY_TOOL_SCHEMA = cloneMemoryWriteSchema();
const READ_ONLY_POLICY = Object.freeze({
  namespace: "filesystem",
  effect: "read",
  parallelSafe: true,
  repeat: "reuse",
  maxCallsPerLoop: null,
  keywords: Object.freeze([]),
  tier: "hidden"
});
const MEMORY_WRITE_POLICY = Object.freeze({
  namespace: "memory",
  effect: "memory_write",
  parallelSafe: true,
  repeat: "rerun",
  maxCallsPerLoop: null,
  keywords: Object.freeze([]),
  tier: "hidden"
});

class MemoryExtractionToolState {
  constructor(options = {}) {
    const {
      memoryStore,
      memoryDirectory = "",
      storageMode = "indexed",
      existingFiles = []
    } = /** @type {any} */ (options);
    this.memoryStore = memoryStore || null;
    this.memoryDirectory = canonicalExistingPath(`${memoryDirectory || process.cwd()}`);
    this.storageMode = storageMode === "append-only" ? "append-only" : "indexed";
    this.existingFiles = new Set(normalizeMemoryFiles(existingFiles));
    this.readMemoryFiles = new Set();
    this.writtenFiles = new Set();
    this.successfulReadCalls = 0;
    this.indexRead = false;
    this.phase = "read";
    this.round = -1;
    this.batchError = null;
    this.violations = [];
  }

  beginRound(round, calls = []) {
    this.round = Number.isFinite(Number(round)) ? Number(round) : this.round + 1;
    this.batchError = null;
    const names = calls.map((call) => `${call?.function?.name || ""}`);
    const hasRead = names.some((name) => READ_TOOL_NAMES.has(name));
    const hasWrite = names.some((name) => WRITE_TOOL_NAMES.has(name));
    if (hasRead && hasWrite) {
      this.rejectBatch("MEMORY_EXTRACTION_PHASE_MIXED", "读取与记忆写入必须分属两个模型回合。");
      return;
    }
    if (hasRead && this.phase === "write") {
      this.rejectBatch("MEMORY_EXTRACTION_READ_AFTER_WRITE", "进入写入阶段后不能重新调查或读取文件。");
      return;
    }
    if (hasWrite && this.successfulReadCalls === 0) {
      this.rejectBatch("MEMORY_EXTRACTION_READ_REQUIRED", "写入前必须先完成一个并行读取回合。");
      return;
    }
    if (hasWrite) this.phase = "write";
  }

  rejectBatch(code, error) {
    this.batchError = { code, error };
    this.violations.push({ round: this.round, code });
  }

  readRejection() {
    if (this.batchError) return this.batchError;
    if (this.phase === "write") {
      return {
        code: "MEMORY_EXTRACTION_READ_AFTER_WRITE",
        error: "进入写入阶段后不能重新调查或读取文件。"
      };
    }
    return null;
  }

  writeRejection(file = "") {
    if (this.batchError) return this.batchError;
    if (this.successfulReadCalls === 0) {
      return {
        code: "MEMORY_EXTRACTION_READ_REQUIRED",
        error: "写入前必须先完成一个并行读取回合。"
      };
    }
    if (!this.indexRead) {
      return {
        code: "MEMORY_EXTRACTION_INDEX_NOT_READ",
        error: "写入前必须在读取阶段读过 memory.md。"
      };
    }
    if (this.storageMode === "indexed" && this.existingFiles.has(file) && !this.readMemoryFiles.has(file)) {
      return {
        code: "MEMORY_EXTRACTION_TARGET_NOT_READ",
        error: `更新 ${file} 前必须在读取阶段读过同一文件。`
      };
    }
    return null;
  }

  recordRead(absolute = "") {
    this.successfulReadCalls += 1;
    if (!isInside(this.memoryDirectory, absolute)) return;
    const file = path.basename(absolute);
    if (file === "memory.md") this.indexRead = true;
    if (MEMORY_FILE_PATTERN.test(file)) this.readMemoryFiles.add(file);
  }

  recordWrite(file = "", options = {}) {
    if (!MEMORY_FILE_PATTERN.test(file)) return;
    if (options.deduplicated === true) return;
    this.writtenFiles.add(file);
    this.existingFiles.add(file);
  }

  summary() {
    return {
      phase: this.phase,
      successfulReadCalls: this.successfulReadCalls,
      indexRead: this.indexRead,
      readFiles: [...this.readMemoryFiles],
      writtenFiles: [...this.writtenFiles],
      violations: [...this.violations]
    };
  }
}

function createMemoryExtractionToolRegistry(options = {}) {
  const state = new MemoryExtractionToolState(options);
  const registry = new AgentToolRegistry();
  registry.register({
    schema: READ_TOOL_SCHEMA,
    policy: READ_ONLY_POLICY,
    execute: (args) => executeRead(args, state)
  });
  registry.register({
    schema: GREP_TOOL_SCHEMA,
    policy: READ_ONLY_POLICY,
    execute: (args) => executeGrep(args, state)
  });
  registry.register({
    schema: WRITE_MEMORY_TOOL_SCHEMA,
    policy: MEMORY_WRITE_POLICY,
    execute: (args) => executeWriteMemory(args, state)
  });
  return { registry, state };
}

async function executeRead(args = {}, state) {
  const rejection = state.readRejection();
  if (rejection) return { ok: false, ...rejection };
  try {
    const absolute = await resolveReadablePath(args.path, state.memoryDirectory);
    const stat = await fsp.stat(absolute);
    if (stat.isDirectory()) {
      const entries = (await fsp.readdir(absolute, { withFileTypes: true }))
        .slice(0, 200)
        .map((entry) => `${entry.isDirectory() ? "directory" : "file"}\t${entry.name}`);
      state.recordRead(absolute);
      return { ok: true, path: absolute, kind: "directory", entries };
    }
    if (!stat.isFile()) return { ok: false, code: "READ_NOT_FILE", error: "目标不是普通文件或目录。" };
    if (stat.size > MAX_READ_FILE_BYTES) {
      return { ok: false, code: "READ_FILE_TOO_LARGE", error: `单次 read 只接受不超过 ${MAX_READ_FILE_BYTES} bytes 的文件。` };
    }
    const source = await fsp.readFile(absolute, "utf8");
    if (source.includes("\0")) return { ok: false, code: "READ_BINARY_REJECTED", error: "read 不返回二进制文件。" };
    const lines = source.replace(/\r\n?/g, "\n").split("\n");
    const offset = Math.max(1, Math.floor(Number(args.offset) || 1));
    const limit = Math.max(1, Math.min(MAX_READ_LINES, Math.floor(Number(args.limit) || 200)));
    const selected = lines.slice(offset - 1, offset - 1 + limit).join("\n").slice(0, MAX_READ_CHARS);
    state.recordRead(absolute);
    return {
      ok: true,
      path: absolute,
      kind: "file",
      offset,
      lines: selected ? selected.split("\n").length : 0,
      totalLines: lines.length,
      content: selected
    };
  } catch (error) {
    return { ok: false, code: "READ_FAILED", error: `${error?.message || error}` };
  }
}

async function executeGrep(args = {}, state) {
  const rejection = state.readRejection();
  if (rejection) return { ok: false, ...rejection };
  let expression;
  try {
    if (unsafeRegexPattern(`${args.pattern || ""}`)) {
      return { ok: false, code: "GREP_PATTERN_UNSAFE", error: "grep pattern 含嵌套重复量词。" };
    }
    expression = new RegExp(`${args.pattern || ""}`, args.caseInsensitive === false ? "" : "i");
  } catch (error) {
    return { ok: false, code: "GREP_PATTERN_INVALID", error: `${error?.message || error}` };
  }
  try {
    const root = await resolveReadablePath(args.path, state.memoryDirectory);
    const matcher = `${args.include || ""}`.trim()
      ? picomatch(`${args.include}`, { dot: true })
      : null;
    const files = await collectSearchFiles(root, matcher);
    const matches = [];
    for (const file of files) {
      const source = await fsp.readFile(file, "utf8").catch(() => "");
      if (!source || source.includes("\0")) continue;
      const lines = source.replace(/\r\n?/g, "\n").split("\n");
      for (let index = 0; index < lines.length; index += 1) {
        expression.lastIndex = 0;
        if (!expression.test(lines[index])) continue;
        matches.push({ path: file, line: index + 1, text: lines[index].slice(0, 500) });
        if (matches.length >= MAX_GREP_MATCHES) break;
      }
      if (matches.length >= MAX_GREP_MATCHES) break;
    }
    state.recordRead(root);
    return { ok: true, searchedFiles: files.length, matches, truncated: matches.length >= MAX_GREP_MATCHES };
  } catch (error) {
    return { ok: false, code: "GREP_FAILED", error: `${error?.message || error}` };
  }
}

async function executeWriteMemory(args = {}, state) {
  let memory;
  try {
    memory = validateMemoryWrite(args);
  } catch (error) {
    return { ok: false, code: `${error?.code || "MEMDIR_INPUT_INVALID"}`, error: `${error?.message || error}` };
  }
  const rejection = state.writeRejection(memory.file);
  if (rejection) return { ok: false, ...rejection };
  if (!state.memoryStore?.append) {
    return { ok: false, code: "MEMORY_STORE_UNAVAILABLE", error: "当前 Memdir 不可写。" };
  }
  try {
    const record = await state.memoryStore.append(args);
    state.recordWrite(record.file, { deduplicated: record.deduplicated === true });
    return {
      ok: true,
      memory: {
        id: record.id,
        type: record.type,
        file: record.file,
        name: record.name,
        description: record.description,
        polarity: record.polarity,
        reference: record.reference,
        deduplicated: record.deduplicated
      }
    };
  } catch (error) {
    return { ok: false, code: `${error?.code || "MEMORY_WRITE_FAILED"}`, error: `${error?.message || error}` };
  }
}

async function resolveReadablePath(value = "", cwd = "") {
  const requested = `${value || ""}`.trim();
  if (!requested || requested.includes("\0")) throw new Error("读取路径不合法。");
  return fsp.realpath(path.resolve(cwd, requested));
}

async function collectSearchFiles(root, matcher = null) {
  const stat = await fsp.stat(root);
  if (stat.isFile()) return stat.size <= MAX_GREP_FILE_BYTES ? [root] : [];
  if (!stat.isDirectory()) return [];
  const files = [];
  const queue = [root];
  let directories = 0;
  while (queue.length && files.length < MAX_GREP_FILES && directories < MAX_GREP_DIRECTORIES) {
    const directory = queue.shift();
    directories += 1;
    const entries = await fsp.readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        queue.push(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      const relative = path.relative(root, absolute) || entry.name;
      if (matcher && !matcher(relative)) continue;
      const info = await fsp.stat(absolute).catch(() => null);
      if (info?.size <= MAX_GREP_FILE_BYTES) files.push(absolute);
      if (files.length >= MAX_GREP_FILES) break;
    }
  }
  return files;
}

function unsafeRegexPattern(pattern = "") {
  return /(?:\([^)]*[+*][^)]*\)|\[[^\]]+\][+*]|\\[dDsSwW][+*])[+*{]/.test(pattern);
}

function cloneMemoryWriteSchema() {
  const schema = JSON.parse(JSON.stringify(PIN_MEMORY_TOOL_SCHEMA));
  schema.function.name = "write_memory";
  schema.function.description = [
    "把 Extract Memories 模型确认值得跨会话保留的信息写入当前 Memdir。",
    "只能在独立读取回合之后调用；更新已有主题前必须 read 同一文件。",
    "同一写入回合可并行发出多条调用，宿主会逐条校验四种封闭类型与信息边界。"
  ].join("");
  return schema;
}

function normalizeMemoryFiles(values = []) {
  return [...new Set((Array.isArray(values) ? values : [values])
    .map((value) => `${value || ""}`.trim())
    .filter((value) => MEMORY_FILE_PATTERN.test(value)))];
}

function isInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function canonicalExistingPath(value = "") {
  const absolute = path.resolve(`${value || ""}`);
  try {
    return fs.realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

module.exports = {
  READ_TOOL_SCHEMA,
  GREP_TOOL_SCHEMA,
  WRITE_MEMORY_TOOL_SCHEMA,
  READ_ONLY_POLICY,
  MEMORY_WRITE_POLICY,
  MemoryExtractionToolState,
  createMemoryExtractionToolRegistry,
  executeRead,
  executeGrep,
  executeWriteMemory
};
