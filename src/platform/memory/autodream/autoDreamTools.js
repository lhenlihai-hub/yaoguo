// @ts-check

const fsp = require("node:fs/promises");
const path = require("node:path");
const picomatch = require("picomatch");
const { AgentToolRegistry } = require("../../ai/agentTools/agentToolRegistry");

const MEMORY_FILE_PATTERN = /^(?:user|feedback|project|reference)-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;
const MAX_READ_LINES = 500;
const MAX_READ_CHARS = 48000;
const MAX_SEARCH_FILES = 80;
const MAX_SEARCH_MATCHES = 80;
const MAX_SEARCH_FILE_BYTES = 512 * 1024;
const SKIP_DIRECTORIES = new Set([".git", "node_modules", "dist", "coverage", ".cache"]);

const TOOL_SCHEMAS = [
  schema("orient", "阶段 1 / Orient：浏览 memory.md、主题元数据和可用日志入口；必须作为唯一的首个工具调用。", {}),
  schema("read_memory", "阶段 2 / Gather：读取一个已有主题文件。重写或删除前必须先读取同一文件。", {
    file: { type: "string", pattern: "^(?:user|feedback|project|reference)-[a-z0-9]+(?:-[a-z0-9]+)*\\.md$" },
    offset: { type: "integer", minimum: 1, maximum: 1000000 },
    limit: { type: "integer", minimum: 1, maximum: MAX_READ_LINES }
  }, ["file"]),
  schema("read_log", "阶段 2 / Gather：读取 Orient 返回的一个 append-only 待整理日期日志。进入 Consolidate 前必须读完全部待整理日志。", {
    file: { type: "string", pattern: "^logs/\\d{4}-\\d{2}-\\d{2}\\.md$" },
    offset: { type: "integer", minimum: 1, maximum: 1000000 },
    limit: { type: "integer", minimum: 1, maximum: MAX_READ_LINES }
  }, ["file"]),
  schema("read_repository", "阶段 2 / Gather：必要时读取 canonical repository 内一个明确文件或列出一个明确目录，用于核对旧记忆与当前事实源。", {
    path: { type: "string", minLength: 1, maxLength: 4096 },
    offset: { type: "integer", minimum: 1, maximum: 1000000 },
    limit: { type: "integer", minimum: 1, maximum: MAX_READ_LINES }
  }, ["path"]),
  schema("read_transcript", "阶段 2 / Gather：读取 Orient 返回的一个近期会话日志。", {
    session: { type: "string", pattern: "^session-[1-9][0-9]{0,2}$" },
    offset: { type: "integer", minimum: 1, maximum: 1000000 },
    limit: { type: "integer", minimum: 1, maximum: MAX_READ_LINES }
  }, ["session"]),
  schema("exact_search", "阶段 2 / Gather：在指定会话日志或仓库路径中搜索一个原样字面词组；不接受正则表达式。目录搜索必须给 include glob。", {
    source: { type: "string", enum: ["transcript", "repository"] },
    target: { type: "string", minLength: 1, maxLength: 4096 },
    phrase: { type: "string", minLength: 2, maxLength: 120 },
    include: { type: "string", maxLength: 160 },
    caseSensitive: { type: "boolean" }
  }, ["source", "target", "phrase"]),
  schema("begin_consolidate", "结束 Gather 并进入阶段 3 / Consolidate；必须单独调用。", {
    findings: { type: "string", minLength: 1, maxLength: 2000 }
  }, ["findings"]),
  schema("rewrite_memory", "阶段 3 或 4：用完整的新正文替换一个已读取主题；被推翻的旧事实不得留在 body 中。不能创建新文件。", {
    file: { type: "string", pattern: "^(?:user|feedback|project|reference)-[a-z0-9]+(?:-[a-z0-9]+)*\\.md$" },
    type: { type: "string", enum: ["user", "feedback", "project", "reference"] },
    name: { type: "string", minLength: 1, maxLength: 80 },
    description: { type: "string", minLength: 1, maxLength: 150 },
    body: { type: "string", minLength: 1, maxLength: 120000 },
    reason: { type: "string", minLength: 1, maxLength: 1000 }
  }, ["file", "type", "name", "description", "body", "reason"]),
  schema("create_memory", "阶段 3 或 4：仅从已读取的 append-only 日志创建一个没有对应已有主题的新主题；相近信号必须合并，不能创建近似副本。", {
    file: { type: "string", pattern: "^(?:user|feedback|project|reference)-[a-z0-9]+(?:-[a-z0-9]+)*\\.md$" },
    type: { type: "string", enum: ["user", "feedback", "project", "reference"] },
    name: { type: "string", minLength: 1, maxLength: 80 },
    description: { type: "string", minLength: 1, maxLength: 150 },
    body: { type: "string", minLength: 1, maxLength: 120000 },
    reason: { type: "string", minLength: 1, maxLength: 1000 }
  }, ["file", "type", "name", "description", "body", "reason"]),
  schema("delete_memory", "阶段 3 或 4：删除一个已读取且已被合并、已失效或只含陈旧指针的主题文件。", {
    file: { type: "string", pattern: "^(?:user|feedback|project|reference)-[a-z0-9]+(?:-[a-z0-9]+)*\\.md$" },
    reason: { type: "string", minLength: 1, maxLength: 1000 }
  }, ["file", "reason"]),
  schema("begin_prune", "结束 Consolidate 并进入阶段 4 / Prune and Index；必须单独调用。", {
    summary: { type: "string", minLength: 1, maxLength: 2000 }
  }, ["summary"]),
  schema("finish_autodream", "完成阶段 4：校验锁和 Memdir 快照，原子提交重写/删除计划并重建 memory.md。必须单独调用。", {})
];

const READ_POLICY = Object.freeze({
  namespace: "memory", effect: "read", parallelSafe: true,
  repeat: "reuse", maxCallsPerLoop: null, keywords: Object.freeze([]), tier: "hidden"
});
const WRITE_POLICY = Object.freeze({
  namespace: "memory", effect: "memory_write", parallelSafe: false,
  repeat: "rerun", maxCallsPerLoop: null, keywords: Object.freeze([]), tier: "hidden"
});

class AutoDreamToolState {
  constructor({
    memoryStore = null,
    snapshot = null,
    canonicalRoot = "",
    transcripts = [],
    guard = null,
    completeLease = null,
    clock = () => new Date()
  } = {}) {
    this.memoryStore = memoryStore;
    this.snapshot = snapshot || { digest: "", index: "", topics: [] };
    this.topics = new Map((this.snapshot.topics || []).map((topic) => [topic.file, topic]));
    this.logs = new Map((this.snapshot.logs || []).map((log) => [log.file, log]));
    this.canonicalRoot = path.resolve(`${canonicalRoot || "."}`);
    this.transcripts = new Map((transcripts || []).map((row) => [row.id, row]));
    this.guard = guard;
    this.completeLease = completeLease;
    this.clock = clock;
    this.phase = "orient";
    this.round = -1;
    this.batchError = null;
    this.readFiles = new Set();
    this.readLogs = new Set();
    this.readTranscripts = new Set();
    this.replacements = new Map();
    this.creations = new Map();
    this.deletions = new Set();
    this.finished = false;
    this.commit = null;
  }

  beginRound(round, calls = []) {
    this.round = Number.isFinite(Number(round)) ? Number(round) : this.round + 1;
    this.batchError = null;
    const names = calls.map((call) => `${call?.function?.name || ""}`);
    const transitions = names.filter((name) => [
      "orient", "begin_consolidate", "begin_prune", "finish_autodream"
    ].includes(name));
    if (transitions.length && names.length !== 1) {
      this.batchError = rejection("AUTODREAM_PHASE_MIXED", "阶段转换工具必须在独立模型回合调用。");
    }
  }

  async authorize(phases) {
    if (this.batchError) return this.batchError;
    if (typeof this.guard === "function" && !(await this.guard())) {
      return rejection("AUTODREAM_LOCK_LOST", "当前实例已失去 AutoDream 锁。");
    }
    if (!phases.includes(this.phase)) {
      return rejection("AUTODREAM_PHASE_INVALID", `当前阶段是 ${this.phase}，不能执行该工具。`);
    }
    return null;
  }

  summary() {
    return {
      phase: this.phase,
      readFiles: [...this.readFiles],
      readLogs: [...this.readLogs],
      readTranscripts: [...this.readTranscripts],
      replacedFiles: [...this.replacements.keys()],
      createdFiles: [...this.creations.keys()],
      deletedFiles: [...this.deletions],
      finished: this.finished,
      commit: this.commit
    };
  }
}

function createAutoDreamToolRegistry(options = {}) {
  const state = new AutoDreamToolState(options);
  const registry = new AgentToolRegistry();
  for (const toolSchema of TOOL_SCHEMAS) {
    const name = toolSchema.function.name;
    registry.register({
      schema: toolSchema,
      policy: ["rewrite_memory", "create_memory", "delete_memory", "finish_autodream"].includes(name)
        ? WRITE_POLICY
        : READ_POLICY,
      execute: (args) => executeTool(name, args, state)
    });
  }
  return { registry, state };
}

async function executeTool(name, args, state) {
  if (name === "orient") return executeOrient(state);
  if (name === "read_memory") return executeReadMemory(args, state);
  if (name === "read_log") return executeReadLog(args, state);
  if (name === "read_repository") return executeReadRepository(args, state);
  if (name === "read_transcript") return executeReadTranscript(args, state);
  if (name === "exact_search") return executeExactSearch(args, state);
  if (name === "begin_consolidate") return transition(state, "gather", "consolidate");
  if (name === "rewrite_memory") return executeRewrite(args, state);
  if (name === "create_memory") return executeCreate(args, state);
  if (name === "delete_memory") return executeDelete(args, state);
  if (name === "begin_prune") return transition(state, "consolidate", "prune");
  if (name === "finish_autodream") return executeFinish(state);
  return rejection("AUTODREAM_TOOL_UNKNOWN", "未知 AutoDream 工具。");
}

async function executeOrient(state) {
  const denied = await state.authorize(["orient"]);
  if (denied) return denied;
  state.phase = "gather";
  return {
    ok: true,
    phase: state.phase,
    memoryIndex: `${state.snapshot.index || ""}`,
    topics: [...state.topics.values()].map((topic) => ({
      file: topic.file,
      type: topic.type,
      name: topic.name,
      description: topic.description,
      updatedAt: topic.updatedAt,
      bytes: topic.bytes
    })),
    pendingLogs: [...state.logs.values()].map((log) => ({
      file: log.file,
      entries: log.entries,
      bytes: log.bytes
    })),
    transcripts: [...state.transcripts.values()].map((row) => ({ id: row.id, recordedAt: row.recordedAt })),
    repository: "repository://canonical-root"
  };
}

async function executeReadLog(args, state) {
  const denied = await state.authorize(["gather"]);
  if (denied) return denied;
  const file = `${args.file || ""}`;
  const log = state.logs.get(file);
  if (!log) return rejection("AUTODREAM_LOG_MISSING", "待整理日期日志不存在于本次快照。");
  state.readLogs.add(file);
  return textWindow(log.content, args, { ok: true, file, phase: state.phase });
}

async function executeReadMemory(args, state) {
  const denied = await state.authorize(["gather"]);
  if (denied) return denied;
  const file = `${args.file || ""}`;
  const topic = state.topics.get(file);
  if (!MEMORY_FILE_PATTERN.test(file) || !topic) return rejection("AUTODREAM_MEMORY_MISSING", "主题文件不存在于本次快照。");
  state.readFiles.add(file);
  return textWindow(topic.content, args, { ok: true, file, phase: state.phase });
}

async function executeReadRepository(args, state) {
  const denied = await state.authorize(["gather"]);
  if (denied) return denied;
  try {
    const absolute = await resolveInside(state.canonicalRoot, `${args.path || ""}`);
    const stat = await fsp.stat(absolute);
    if (stat.isDirectory()) {
      const entries = (await fsp.readdir(absolute, { withFileTypes: true })).slice(0, 200)
        .filter((entry) => !entry.isSymbolicLink() && !SKIP_DIRECTORIES.has(entry.name))
        .map((entry) => `${entry.isDirectory() ? "directory" : "file"}\t${entry.name}`);
      return { ok: true, kind: "directory", path: path.relative(state.canonicalRoot, absolute) || ".", entries };
    }
    const content = await readTextFile(absolute, 1024 * 1024);
    return textWindow(content, args, { ok: true, kind: "file", path: path.relative(state.canonicalRoot, absolute) });
  } catch (error) {
    return rejection(error?.code || "AUTODREAM_REPOSITORY_READ_FAILED", `${error?.message || error}`);
  }
}

async function executeReadTranscript(args, state) {
  const denied = await state.authorize(["gather"]);
  if (denied) return denied;
  const source = state.transcripts.get(`${args.session || ""}`);
  if (!source) return rejection("AUTODREAM_TRANSCRIPT_UNKNOWN", "会话日志别名不存在。");
  try {
    const content = await readTextFile(source.file, 2 * 1024 * 1024);
    state.readTranscripts.add(source.id);
    return textWindow(content, args, {
      ok: true, session: source.id, recordedAt: source.recordedAt
    });
  } catch (error) {
    return rejection("AUTODREAM_TRANSCRIPT_READ_FAILED", `${error?.message || error}`);
  }
}

async function executeExactSearch(args, state) {
  const denied = await state.authorize(["gather"]);
  if (denied) return denied;
  const phrase = `${args.phrase || ""}`;
  if (phrase.trim().length < 2 || /[\r\n\0]/.test(phrase)) {
    return rejection("AUTODREAM_SEARCH_PHRASE_INVALID", "exact_search 只接受 2-120 字符的单行字面词组。");
  }
  try {
    const files = args.source === "transcript"
      ? transcriptSearchFiles(state, `${args.target || ""}`)
      : await repositorySearchFiles(state, args);
    const matches = await searchLiteral(files, phrase, args.caseSensitive === true, state);
    return { ok: true, source: args.source, phrase, searchedFiles: files.length, matches };
  } catch (error) {
    return rejection(error?.code || "AUTODREAM_EXACT_SEARCH_FAILED", `${error?.message || error}`);
  }
}

async function transition(state, from, to) {
  const denied = await state.authorize([from]);
  if (denied) return denied;
  if (from === "gather") {
    const required = Math.min(5, state.transcripts.size);
    if (state.readTranscripts.size < required) {
      return rejection("AUTODREAM_TRANSCRIPTS_REQUIRED", `进入 Consolidate 前必须读取最近 ${required} 个可用会话日志。`);
    }
    if (state.readLogs.size < state.logs.size) {
      return rejection("AUTODREAM_LOGS_REQUIRED", `进入 Consolidate 前必须读取全部 ${state.logs.size} 个 append-only 日期日志。`);
    }
  }
  state.phase = to;
  return { ok: true, phase: to };
}

async function executeCreate(args, state) {
  const denied = await state.authorize(["consolidate", "prune"]);
  if (denied) return denied;
  const file = `${args.file || ""}`;
  if (!state.logs.size || state.readLogs.size !== state.logs.size) {
    return rejection("AUTODREAM_CREATE_SOURCE_REQUIRED", "创建主题前必须读取全部 append-only 待整理日志。");
  }
  if (state.topics.has(file)) return rejection("AUTODREAM_MEMORY_EXISTS", "已有主题必须用 rewrite_memory 合并。");
  state.creations.set(file, {
    file,
    type: `${args.type || ""}`,
    name: `${args.name || ""}`,
    description: `${args.description || ""}`,
    body: `${args.body || ""}`
  });
  return { ok: true, phase: state.phase, planned: "create", file };
}

async function executeRewrite(args, state) {
  const denied = await state.authorize(["consolidate", "prune"]);
  if (denied) return denied;
  const file = `${args.file || ""}`;
  if (!state.topics.has(file)) return rejection("AUTODREAM_MEMORY_MISSING", "只能整合已有主题，不能创建近似副本。");
  if (!state.readFiles.has(file)) return rejection("AUTODREAM_TARGET_NOT_READ", `重写 ${file} 前必须在 Gather 阶段读取它。`);
  state.deletions.delete(file);
  state.replacements.set(file, {
    file,
    type: `${args.type || ""}`,
    name: `${args.name || ""}`,
    description: `${args.description || ""}`,
    body: `${args.body || ""}`
  });
  return { ok: true, phase: state.phase, planned: "rewrite", file };
}

async function executeDelete(args, state) {
  const denied = await state.authorize(["consolidate", "prune"]);
  if (denied) return denied;
  const file = `${args.file || ""}`;
  if (!state.topics.has(file)) return rejection("AUTODREAM_MEMORY_MISSING", "只能删除本次快照中的已有主题。");
  if (!state.readFiles.has(file)) return rejection("AUTODREAM_TARGET_NOT_READ", `删除 ${file} 前必须在 Gather 阶段读取它。`);
  state.replacements.delete(file);
  state.deletions.add(file);
  return { ok: true, phase: state.phase, planned: "delete", file };
}

async function executeFinish(state) {
  const denied = await state.authorize(["prune"]);
  if (denied) return denied;
  try {
    state.commit = await state.memoryStore.applyReshape({
      snapshotDigest: state.snapshot.digest,
      replacements: [...state.replacements.values()],
      creations: [...state.creations.values()],
      deletions: [...state.deletions]
    }, {
      now: state.clock(),
      guard: state.guard
    });
    const lock = typeof state.completeLease === "function"
      ? await state.completeLease()
      : null;
    state.phase = "finished";
    state.finished = true;
    state.commit = { ...state.commit, ...(lock || {}) };
    return { ok: true, phase: state.phase, ...state.commit };
  } catch (error) {
    return rejection(error?.code || "AUTODREAM_COMMIT_FAILED", `${error?.message || error}`);
  }
}

function schema(name, description, properties, required = []) {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: {
        type: "object",
        additionalProperties: false,
        properties,
        ...(required.length ? { required } : {})
      }
    }
  };
}

function textWindow(content, args, metadata = {}) {
  const lines = `${content || ""}`.replace(/\r\n?/g, "\n").split("\n");
  const offset = Math.max(1, Math.floor(Number(args.offset) || 1));
  const limit = Math.max(1, Math.min(MAX_READ_LINES, Math.floor(Number(args.limit) || 240)));
  const selected = lines.slice(offset - 1, offset - 1 + limit).join("\n").slice(0, MAX_READ_CHARS);
  return {
    ...metadata,
    offset,
    lines: selected ? selected.split("\n").length : 0,
    totalLines: lines.length,
    truncated: offset - 1 + limit < lines.length || selected.length >= MAX_READ_CHARS,
    content: selected
  };
}

async function resolveInside(root, requested) {
  const absolute = await fsp.realpath(path.resolve(root, requested));
  const relative = path.relative(root, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative) || relative.split(path.sep).includes(".git")) {
    throw Object.assign(new Error("读取目标超出 canonical repository 或进入 .git。"), { code: "AUTODREAM_PATH_UNSAFE" });
  }
  return absolute;
}

async function readTextFile(file, maxBytes) {
  const stat = await fsp.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > maxBytes) {
    throw new Error(`只读取不超过 ${maxBytes} bytes 的普通文本文件。`);
  }
  const content = await fsp.readFile(file, "utf8");
  if (content.includes("\0")) throw new Error("不读取二进制文件。");
  return content;
}

function transcriptSearchFiles(state, target) {
  const source = state.transcripts.get(target);
  if (!source) throw Object.assign(new Error("会话日志别名不存在。"), { code: "AUTODREAM_TRANSCRIPT_UNKNOWN" });
  return [{ file: source.file, label: source.id }];
}

async function repositorySearchFiles(state, args) {
  const root = await resolveInside(state.canonicalRoot, `${args.target || ""}`);
  const stat = await fsp.stat(root);
  if (stat.isFile()) return [{ file: root, label: path.relative(state.canonicalRoot, root) }];
  const include = `${args.include || ""}`.trim();
  if (!include) throw Object.assign(new Error("仓库目录搜索必须提供精确 include glob。"), { code: "AUTODREAM_SEARCH_INCLUDE_REQUIRED" });
  const matcher = picomatch(include, { dot: false });
  const files = [];
  const queue = [root];
  while (queue.length && files.length < MAX_SEARCH_FILES) {
    const directory = queue.shift();
    const entries = await fsp.readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isSymbolicLink() || SKIP_DIRECTORIES.has(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) queue.push(absolute);
      if (!entry.isFile()) continue;
      const relative = path.relative(root, absolute);
      const statRow = matcher(relative) ? await fsp.stat(absolute).catch(() => null) : null;
      if (statRow?.size <= MAX_SEARCH_FILE_BYTES) files.push({ file: absolute, label: path.relative(state.canonicalRoot, absolute) });
      if (files.length >= MAX_SEARCH_FILES) break;
    }
  }
  return files;
}

async function searchLiteral(files, phrase, caseSensitive, state) {
  const needle = caseSensitive ? phrase : phrase.toLocaleLowerCase();
  const matches = [];
  for (const source of files) {
    const content = await readTextFile(source.file, MAX_SEARCH_FILE_BYTES).catch(() => "");
    const lines = content.replace(/\r\n?/g, "\n").split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const haystack = caseSensitive ? lines[index] : lines[index].toLocaleLowerCase();
      if (!haystack.includes(needle)) continue;
      matches.push({ path: source.label, line: index + 1, text: lines[index].slice(0, 500) });
      if (matches.length >= MAX_SEARCH_MATCHES) return matches;
    }
  }
  void state;
  return matches;
}

function rejection(code, error) {
  return { ok: false, code, error };
}

module.exports = {
  TOOL_SCHEMAS,
  READ_POLICY,
  WRITE_POLICY,
  AutoDreamToolState,
  createAutoDreamToolRegistry,
  executeTool
};
