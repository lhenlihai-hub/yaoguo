// @ts-check

const crypto = require("node:crypto");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { KeyedSerialExecutor } = require("../../shared/keyedSerialExecutor");
const { isPathInside } = require("../../shared/pathSafety");
const { buildMemoryIndex, filterMemorySegments } = require("../memoryIndex");
const { resolveMemdirLocation } = require("./memdirPaths");
const {
  MEMORY_TYPES,
  MAX_INDEX_LINES,
  MAX_INDEX_BYTES,
  MAX_INDEX_SUMMARY_CHARS,
  MAX_TOPIC_BYTES,
  parseTopicFrontMatter,
  parseTopicFile,
  renderTopicFile,
  renderMemoryIndex,
  memoryIndexContext,
  memoryFreshness,
  memdirError
} = require("./memdirFormat");
const { validateMemoryWrite, renderMemoryEntry } = require("./memdirPolicy");
const {
  DEFAULT_AGENT_TYPE,
  normalizeAgentMemoryProfile
} = require("./agentMemoryProfile");
const {
  MEMORY_LOG_PATH_PATTERN,
  MAX_MEMORY_LOG_BYTES,
  appendMemoryLog,
  listPendingMemoryLogs,
  listAllMemoryLogs,
  parseMemoryLog,
  archivePendingMemoryLogs,
  restoreArchivedMemoryLogs,
  ensureMemoryLogDirectories,
  markAppendOnly,
  hasAppendOnlyMarker
} = require("./memdirJournal");

const INDEX_FILE = "memory.md";
const PREFETCH_FRONT_MATTER_LINES = 30;
const MAX_FRONT_MATTER_HEAD_BYTES = 32 * 1024;
const MAX_SEARCH_CONTENT_CHARS = 16000;
const MAX_SEARCH_TOTAL_CHARS = 64000;

class MemdirStore {
  constructor({
    workspaceRoot = "",
    baseDirectory = "",
    homeDirectory = "",
    execFileImpl = null,
    writes = null,
    clock = () => new Date(),
    agentType = DEFAULT_AGENT_TYPE,
    scope = "local",
    mode = "indexed"
  } = {}) {
    this.workspaceRoot = `${workspaceRoot || ""}`;
    this.baseDirectory = `${baseDirectory || ""}`;
    this.homeDirectory = `${homeDirectory || os.homedir()}`;
    this.execFileImpl = execFileImpl;
    this.writes = writes || new KeyedSerialExecutor();
    this.clock = clock;
    this.profile = normalizeAgentMemoryProfile({ agentType, scope, mode });
    this.locationPromise = null;
  }

  async location() {
    if (!this.locationPromise) {
      this.locationPromise = resolveMemdirLocation({
        workspaceRoot: this.workspaceRoot,
        baseDirectory: this.baseDirectory,
        homeDirectory: this.homeDirectory,
        execFileImpl: this.execFileImpl,
        agentType: this.profile.agentType,
        scope: this.profile.scope,
        mode: this.profile.mode
      });
    }
    const location = await this.locationPromise;
    if (location.storageMode !== "append-only" && await hasAppendOnlyMarker(location.memoryDirectory)) {
      location.storageMode = "append-only";
      this.profile.mode = "append-only";
    }
    return location;
  }

  async activateAppendOnly() {
    const location = await this.location();
    return this.writes.run(location.memoryDirectory, async () => {
      await ensureSecureMemoryDirectory(location);
      await markAppendOnly(location.memoryDirectory);
      location.storageMode = "append-only";
      this.profile.mode = "append-only";
      await ensureMemoryLogDirectories(location.memoryDirectory);
      await ensureReadOnlyIndex(location);
      return location;
    });
  }

  async ensure() {
    const location = await this.location();
    return this.writes.run(location.memoryDirectory, async () => {
      await ensureSecureMemoryDirectory(location);
      if (location.storageMode === "append-only") {
        await markAppendOnly(location.memoryDirectory);
        await ensureMemoryLogDirectories(location.memoryDirectory);
        return ensureReadOnlyIndex(location);
      }
      return this.rebuildIndex(location);
    });
  }

  async readIndex() {
    const location = await this.location();
    await this.ensure();
    return await readSafeFile(
      path.join(location.memoryDirectory, INDEX_FILE),
      location.memoryDirectory
    ) || "";
  }

  async indexContext() {
    return memoryIndexContext(await this.readIndex());
  }

  async scanPrefetchMetadata() {
    const location = await this.location();
    await ensureSecureMemoryDirectory(location);
    return listTopicHeaders(location, PREFETCH_FRONT_MATTER_LINES);
  }

  async createReshapeSnapshot() {
    const location = await this.location();
    return this.writes.run(location.memoryDirectory, async () => {
      await ensureSecureMemoryDirectory(location);
      if (location.storageMode === "indexed") await this.rebuildIndex(location);
      return buildReshapeSnapshot(location);
    });
  }

  async applyReshape(plan = {}, options = {}) {
    const location = await this.location();
    return this.writes.run(location.memoryDirectory, async () => {
      await ensureSecureMemoryDirectory(location);
      return applyReshapePlan(location, plan, options);
    });
  }

  async append(input = {}) {
    if (Object.hasOwn(input, "scope")) {
      throw memdirError("MEMDIR_SCOPE_RETIRED", "Memdir 不接受 global/project 等开放 scope；必须使用四种封闭 type");
    }
    const memory = validateMemoryWrite(input);
    const location = await this.location();
    return this.writes.run(location.memoryDirectory, async () => {
      await ensureSecureMemoryDirectory(location);
      if (location.storageMode === "append-only") {
        await markAppendOnly(location.memoryDirectory);
        await ensureReadOnlyIndex(location);
        return appendMemoryLog(location, memory, this.clock());
      }
      const topics = await listTopicFiles(location);
      const file = path.join(location.memoryDirectory, memory.file);
      const existing = topics.find((topic) => topic.file === memory.file) || null;
      const targetStat = await fsp.lstat(file).catch((error) => {
        if (error?.code === "ENOENT") return null;
        throw error;
      });
      if (targetStat) {
        await readSafeFile(file, location.memoryDirectory);
        if (!existing) {
          throw memdirError("MEMDIR_TOPIC_INVALID", `${memory.file} 已存在但不是有效的 Memdir 主题，已保留原文件`);
        }
      }
      if (!existing && topics.length >= MAX_INDEX_LINES) {
        throw memdirError("MEMDIR_INDEX_LINE_LIMIT", `Memdir 最多包含 ${MAX_INDEX_LINES} 个主题文件`);
      }
      if (existing && existing.type !== memory.type) {
        throw memdirError("MEMDIR_TOPIC_TYPE_CONFLICT", `${memory.file} 已属于 ${existing.type}`);
      }
      const now = new Date().toISOString();
      const marker = `<!-- yaoguo:memory:${memory.entryDigest} -->`;
      const deduplicated = Boolean(existing?.body.includes(marker));
      if (deduplicated) {
        await syncIndexFile(location, renderMemoryIndex(topics));
        return {
          id: `mem_${memory.entryDigest.slice(0, 16)}`,
          type: memory.type,
          file: memory.file,
          name: existing.name,
          description: existing.description,
          content: memory.content,
          polarity: memory.polarity || null,
          reference: memory.reference || null,
          createdAt: existing.createdAt || null,
          deduplicated: true
        };
      }
      const body = [existing?.body || "", renderMemoryEntry(memory, now)].filter(Boolean).join("\n\n");
      const rendered = renderTopicFile({
        name: memory.name,
        description: memory.description,
        type: memory.type,
        createdAt: existing?.createdAt || now,
        updatedAt: now
      }, body);
      if (Buffer.byteLength(rendered, "utf8") > MAX_TOPIC_BYTES) {
        throw memdirError("MEMDIR_TOPIC_BYTE_LIMIT", `${memory.file} 不能超过 ${MAX_TOPIC_BYTES} bytes`);
      }
      const nextTopic = {
        file: memory.file,
        name: memory.name,
        description: memory.description,
        type: memory.type,
        createdAt: existing?.createdAt || now,
        updatedAt: now,
        body
      };
      const nextTopics = existing
        ? topics.map((topic) => topic.file === memory.file ? nextTopic : topic)
        : [...topics, nextTopic];
      const nextIndex = renderMemoryIndex(nextTopics);
      await writeSafeAtomic(file, rendered, location.memoryDirectory);
      await syncIndexFile(location, nextIndex);
      return {
        id: `mem_${memory.entryDigest.slice(0, 16)}`,
        type: memory.type,
        file: memory.file,
        name: memory.name,
        description: memory.description,
        content: memory.content,
        polarity: memory.polarity || null,
        reference: memory.reference || null,
        createdAt: existing?.createdAt || now,
        deduplicated: false
      };
    });
  }

  async search(options = {}) {
    const location = await this.location();
    await this.ensure();
    const types = normalizeTypes(options.types ?? options.type);
    const files = normalizeFiles(options.files);
    const topics = files.length
      ? await readTopicFilesByName(location, files)
      : await listTopicFiles(location);
    const candidates = topics.filter((topic) => (
      (!types.length || types.includes(topic.type))
      && (!files.length || files.includes(topic.file))
    ));
    const limit = Math.max(1, Math.min(12, Number(options.limit) || 8));
    const query = `${options.query || ""}`.trim();
    const selected = query
      ? rankTopics(candidates, query, limit)
      : candidates.slice(0, limit);
    let remaining = MAX_SEARCH_TOTAL_CHARS;
    return selected.map((topic) => {
      if (remaining <= 0) return null;
      const content = truncate(topic.body, Math.min(MAX_SEARCH_CONTENT_CHARS, remaining));
      remaining = Math.max(0, remaining - content.length);
      const freshness = memoryFreshness(topic, options.now || new Date());
      return {
        id: topicId(topic.file),
        type: topic.type,
        file: topic.file,
        name: topic.name,
        description: topic.description,
        content,
        createdAt: topic.createdAt || null,
        updatedAt: topic.updatedAt || null,
        age: freshness.age,
        ageDays: freshness.ageDays,
        freshnessWarning: freshness.warning
      };
    }).filter((topic) => topic?.content);
  }

  async list() {
    const location = await this.location();
    await this.ensure();
    return (await listTopicFiles(location)).map((topic) => ({
      id: topicId(topic.file),
      type: topic.type,
      file: topic.file,
      name: topic.name,
      description: topic.description,
      updatedAt: topic.updatedAt || null
    }));
  }

  async count(options = {}) {
    const topics = await this.list();
    const types = normalizeTypes(options.types ?? options.type);
    return types.length ? topics.filter((topic) => types.includes(topic.type)).length : topics.length;
  }

  async info() {
    const location = await this.location();
    return {
      identity: location.identity,
      canonicalRoot: location.canonicalRoot,
      baseDirectory: location.baseDirectory,
      projectDirectory: location.projectDirectory,
      memoryDirectory: location.memoryDirectory,
      agentType: location.agentType,
      scope: location.scope,
      storageMode: location.storageMode,
      logPathPattern: location.storageMode === "append-only" ? MEMORY_LOG_PATH_PATTERN : ""
    };
  }

  async exportSnapshot(options = {}) {
    const location = await this.location();
    return this.writes.run(location.memoryDirectory, async () => {
      await ensureSecureMemoryDirectory(location);
      if (location.storageMode === "append-only") {
        await markAppendOnly(location.memoryDirectory);
        await ensureReadOnlyIndex(location);
      } else {
        await this.rebuildIndex(location);
      }
      return exportMemorySnapshot(location, this.clock(), options);
    });
  }

  async exportSnapshotJson(options = {}) {
    const snapshot = await this.exportSnapshot(options);
    return JSON.stringify(snapshot, null, options.pretty === false ? 0 : 2);
  }

  async importSnapshot(snapshot = {}, options = {}) {
    const location = await this.location();
    return this.writes.run(location.memoryDirectory, async () => {
      await ensureSecureMemoryDirectory(location);
      if (location.storageMode === "append-only") await markAppendOnly(location.memoryDirectory);
      return importMemorySnapshot(location, snapshot, options);
    });
  }

  async rebuildIndex(location) {
    if (location.storageMode === "append-only") return ensureReadOnlyIndex(location);
    const topics = await listTopicHeaders(location, PREFETCH_FRONT_MATTER_LINES);
    const content = renderMemoryIndex(topics);
    await syncIndexFile(location, content);
    return content;
  }
}

async function buildReshapeSnapshot(location) {
  const topics = await listTopicFiles(location);
  const rows = [];
  for (const topic of topics) {
    const content = await readSafeFile(
      path.join(location.memoryDirectory, topic.file),
      location.memoryDirectory,
      MAX_TOPIC_BYTES
    );
    rows.push({
      ...topic,
      content,
      bytes: Buffer.byteLength(content, "utf8"),
      sha256: sha256(content)
    });
  }
  const index = await readSafeFile(
    path.join(location.memoryDirectory, INDEX_FILE),
    location.memoryDirectory,
    MAX_INDEX_BYTES
  );
  const logs = location.storageMode === "append-only"
    ? (await listPendingMemoryLogs(location)).map((log) => ({
      ...log,
      sha256: sha256(log.content)
    }))
    : [];
  return {
    digest: reshapeDigest(rows, index, logs),
    index,
    topics: rows,
    logs
  };
}

async function exportMemorySnapshot(location, now = new Date(), options = {}) {
  const reshape = await buildReshapeSnapshot(location);
  const allLogs = options.includeProcessedLogs === false
    ? reshape.logs.map((log) => ({ file: log.file, content: log.content }))
    : await listAllMemoryLogs(location);
  const snapshot = {
    version: 1,
    kind: "yaoguo-agent-memory-snapshot",
    exportedAt: safeDate(now).toISOString(),
    source: {
      agentType: location.agentType,
      scope: location.scope,
      storageMode: location.storageMode,
      canonicalIdentity: location.identity
    },
    index: reshape.index,
    topics: reshape.topics.map((topic) => ({
      file: topic.file,
      content: topic.content,
      sha256: topic.sha256
    })),
    logs: allLogs.map((log) => ({
      file: log.file,
      content: log.content,
      sha256: sha256(log.content)
    }))
  };
  return {
    ...snapshot,
    digest: sha256(JSON.stringify(snapshot))
  };
}

async function importMemorySnapshot(location, value = {}, options = {}) {
  const snapshot = normalizeMemorySnapshot(value);
  const mode = `${options.mode || "merge"}`;
  if (!["merge", "replace"].includes(mode)) {
    throw memdirError("MEMDIR_SNAPSHOT_MODE_INVALID", "快照导入 mode 只允许 merge/replace");
  }
  const incomingTopics = normalizeSnapshotTopics(snapshot.topics);
  const incomingLogs = normalizeSnapshotLogs(snapshot.logs);
  const expectedIndex = renderMemoryIndex(incomingTopics);
  if (`${snapshot.index || ""}` !== expectedIndex) {
    throw memdirError("MEMDIR_SNAPSHOT_INDEX_INVALID", "快照 memory.md 与主题 Front Matter 不一致");
  }
  const current = await captureManagedState(location);
  const target = mergeSnapshotState(current, incomingTopics, incomingLogs, mode);
  try {
    await writeManagedState(location, current, target);
  } catch (error) {
    await restoreManagedState(location, current, target).catch(() => {});
    throw error;
  }
  return {
    imported: true,
    mode,
    topics: target.topics.length,
    logs: target.logs.length,
    sourceAgentType: `${snapshot.source?.agentType || ""}`,
    targetAgentType: location.agentType
  };
}

function normalizeMemorySnapshot(value) {
  let snapshot = value;
  if (typeof value === "string") {
    try { snapshot = JSON.parse(value); } catch { snapshot = null; }
  }
  if (!snapshot || snapshot.version !== 1 || snapshot.kind !== "yaoguo-agent-memory-snapshot") {
    throw memdirError("MEMDIR_SNAPSHOT_INVALID", "只接受 version=1 的 Agent 记忆快照");
  }
  if (snapshot.digest) {
    const { digest: _digest, ...unsigned } = snapshot;
    if (snapshot.digest !== sha256(JSON.stringify(unsigned))) {
      throw memdirError("MEMDIR_SNAPSHOT_DIGEST_INVALID", "Agent 记忆快照摘要校验失败");
    }
  }
  return snapshot;
}

function normalizeSnapshotTopics(values = []) {
  const rows = Array.isArray(values) ? values : [];
  if (rows.length > MAX_INDEX_LINES) {
    throw memdirError("MEMDIR_INDEX_LINE_LIMIT", `快照主题不能超过 ${MAX_INDEX_LINES} 个`);
  }
  const seen = new Set();
  return rows.map((row) => {
    const file = normalizeFiles([row?.file])[0];
    const content = `${row?.content || ""}`;
    const parsed = parseTopicFile(content, file);
    if (!parsed || Buffer.byteLength(content, "utf8") > MAX_TOPIC_BYTES) {
      throw memdirError("MEMDIR_SNAPSHOT_TOPIC_INVALID", `${file} 不是有效主题文件`);
    }
    if (seen.has(file) || (row?.sha256 && row.sha256 !== sha256(content))) {
      throw memdirError("MEMDIR_SNAPSHOT_DIGEST_INVALID", `${file} 重复或摘要校验失败`);
    }
    seen.add(file);
    return { ...parsed, file, content, sha256: sha256(content) };
  });
}

function normalizeSnapshotLogs(values = []) {
  const rows = Array.isArray(values) ? values : [];
  const seen = new Set();
  return rows.map((row) => {
    const file = `${row?.file || ""}`;
    const content = `${row?.content || ""}`;
    if (!/^logs\/(?:processed\/)?\d{4}-\d{2}-\d{2}(?:-[a-z0-9-]+)?\.md$/.test(file)) {
      throw memdirError("MEMDIR_SNAPSHOT_LOG_INVALID", "快照日志路径无效");
    }
    if (Buffer.byteLength(content, "utf8") > MAX_MEMORY_LOG_BYTES) {
      throw memdirError("MEMDIR_LOG_BYTE_LIMIT", `快照日志不能超过 ${MAX_MEMORY_LOG_BYTES} bytes`);
    }
    parseMemoryLog(content, file);
    if (seen.has(file) || (row?.sha256 && row.sha256 !== sha256(content))) {
      throw memdirError("MEMDIR_SNAPSHOT_DIGEST_INVALID", `${file} 重复或摘要校验失败`);
    }
    seen.add(file);
    return { file, content, sha256: sha256(content) };
  });
}

async function captureManagedState(location) {
  const topics = await listTopicFiles(location);
  const topicRows = [];
  for (const topic of topics) {
    const content = await readSafeFile(path.join(location.memoryDirectory, topic.file), location.memoryDirectory);
    topicRows.push({ ...topic, content, sha256: sha256(content) });
  }
  const logs = (await listAllMemoryLogs(location)).map((row) => ({
    ...row,
    sha256: sha256(row.content)
  }));
  return { topics: topicRows, logs };
}

function mergeSnapshotState(current, topics, logs, mode) {
  if (mode === "replace") return { topics, logs };
  return {
    topics: mergeSnapshotRows(current.topics, topics, "主题"),
    logs: mergeSnapshotRows(current.logs, logs, "日志")
  };
}

function mergeSnapshotRows(current, incoming, label) {
  const byFile = new Map(current.map((row) => [row.file, row]));
  for (const row of incoming) {
    const existing = byFile.get(row.file);
    if (existing && existing.sha256 !== row.sha256) {
      throw memdirError("MEMDIR_SNAPSHOT_CONFLICT", `${label} ${row.file} 与目标状态冲突`);
    }
    byFile.set(row.file, existing || row);
  }
  return [...byFile.values()].sort((left, right) => left.file.localeCompare(right.file));
}

async function writeManagedState(location, current, target) {
  const currentFiles = new Set([
    ...current.topics.map((row) => row.file),
    ...current.logs.map((row) => row.file)
  ]);
  const targetFiles = new Set([
    ...target.topics.map((row) => row.file),
    ...target.logs.map((row) => row.file)
  ]);
  await ensureMemoryLogDirectories(location.memoryDirectory);
  for (const row of [...target.topics, ...target.logs]) {
    await writeSafeAtomic(
      path.join(location.memoryDirectory, row.file),
      row.content,
      location.memoryDirectory,
      row.file.startsWith("logs/") ? MAX_MEMORY_LOG_BYTES : MAX_TOPIC_BYTES
    );
  }
  for (const file of currentFiles) {
    if (!targetFiles.has(file)) {
      await unlinkSafeFile(path.join(location.memoryDirectory, file), location.memoryDirectory, MAX_MEMORY_LOG_BYTES);
    }
  }
  const index = renderMemoryIndex(target.topics);
  await writeSafeAtomic(path.join(location.memoryDirectory, INDEX_FILE), index, location.memoryDirectory, MAX_INDEX_BYTES);
  if (location.storageMode === "append-only") {
    await fsp.chmod(path.join(location.memoryDirectory, INDEX_FILE), 0o400);
  }
}

async function restoreManagedState(location, current, target) {
  const originals = new Map([
    ...current.topics.map((row) => [row.file, row.content]),
    ...current.logs.map((row) => [row.file, row.content])
  ]);
  for (const row of [...current.topics, ...current.logs]) {
    await writeSafeAtomic(
      path.join(location.memoryDirectory, row.file),
      row.content,
      location.memoryDirectory,
      row.file.startsWith("logs/") ? MAX_MEMORY_LOG_BYTES : MAX_TOPIC_BYTES
    );
  }
  for (const row of [...target.topics, ...target.logs]) {
    if (!originals.has(row.file)) {
      await unlinkSafeFile(path.join(location.memoryDirectory, row.file), location.memoryDirectory, MAX_MEMORY_LOG_BYTES);
    }
  }
  await writeSafeAtomic(
    path.join(location.memoryDirectory, INDEX_FILE),
    renderMemoryIndex(current.topics),
    location.memoryDirectory,
    MAX_INDEX_BYTES
  );
}

async function applyReshapePlan(location, plan = {}, options = {}) {
  const current = await buildReshapeSnapshot(location);
  if (!plan.snapshotDigest || plan.snapshotDigest !== current.digest) {
    throw memdirError("MEMDIR_RESHAPE_CONFLICT", "AutoDream 期间 Memdir 已变化，本次整合不得覆盖新记忆");
  }
  const byFile = new Map(current.topics.map((topic) => [topic.file, topic]));
  const deletions = normalizeReshapeFiles(plan.deletions);
  const missingDeletion = deletions.find((file) => !byFile.has(file));
  if (missingDeletion) {
    throw memdirError("MEMDIR_RESHAPE_TARGET_MISSING", `AutoDream 只能删除已有主题：${missingDeletion}`);
  }
  const deletionSet = new Set(deletions);
  const now = safeDate(options.now).toISOString();
  const replacements = normalizeReshapeReplacements(plan.replacements, byFile, deletionSet, now);
  const creations = normalizeReshapeCreations(plan.creations, byFile, deletionSet, current.logs, now);
  const replacementMap = new Map(replacements.map((topic) => [topic.file, topic]));
  const nextTopics = current.topics
    .filter((topic) => !deletionSet.has(topic.file))
    .map((topic) => replacementMap.get(topic.file) || topic)
    .concat(creations);
  const nextIndex = renderMemoryIndex(nextTopics);
  const originalByFile = new Map(current.topics.map((topic) => [topic.file, topic.content]));
  let archivedLogs = [];
  try {
    for (const topic of [...replacements, ...creations]) {
      await assertReshapeGuard(options.guard);
      await writeSafeAtomic(
        path.join(location.memoryDirectory, topic.file),
        topic.content,
        location.memoryDirectory
      );
    }
    for (const file of deletions) {
      await assertReshapeGuard(options.guard);
      await unlinkSafeFile(path.join(location.memoryDirectory, file), location.memoryDirectory);
    }
    await assertReshapeGuard(options.guard);
    await writeSafeAtomic(
      path.join(location.memoryDirectory, INDEX_FILE),
      nextIndex,
      location.memoryDirectory
    );
    if (location.storageMode === "append-only") {
      await fsp.chmod(path.join(location.memoryDirectory, INDEX_FILE), 0o400);
      archivedLogs = await archivePendingMemoryLogs(location, current.logs, current.digest);
    }
  } catch (error) {
    await restoreArchivedMemoryLogs(archivedLogs);
    await rollbackReshape(location, originalByFile, current.index, [...replacements, ...creations], deletions);
    throw error;
  }
  return {
    replacedFiles: replacements.map((topic) => topic.file),
    createdFiles: creations.map((topic) => topic.file),
    deletedFiles: deletions,
    archivedLogs: archivedLogs.map((row) => row.file),
    indexLines: nextIndex.split("\n").filter(Boolean).length,
    indexBytes: Buffer.byteLength(nextIndex, "utf8")
  };
}

function normalizeReshapeCreations(values, byFile, deletionSet, logs, now) {
  const rows = Array.isArray(values) ? values : [];
  if (rows.length && !(Array.isArray(logs) && logs.length)) {
    throw memdirError("MEMDIR_RESHAPE_CREATE_FORBIDDEN", "AutoDream 只能从 append-only 待整理日志创建新主题");
  }
  const seen = new Set();
  return rows.map((value) => {
    const file = normalizeFiles([value?.file])[0];
    if (byFile.has(file) || deletionSet.has(file) || seen.has(file)) {
      throw memdirError("MEMDIR_RESHAPE_PLAN_INVALID", `AutoDream 对 ${file} 提交了冲突创建操作`);
    }
    seen.add(file);
    const type = `${value?.type || ""}`;
    const name = `${value?.name || ""}`.trim();
    const description = `${value?.description || ""}`.replace(/[\r\n\t]+/g, " ").trim();
    const body = `${value?.body || ""}`.trim();
    if (!file.startsWith(`${type}-`) || !MEMORY_TYPES.includes(type)) {
      throw memdirError("MEMDIR_TOPIC_TYPE_CONFLICT", `${file} 与封闭类型不一致`);
    }
    if (!name || !description || Array.from(description).length > MAX_INDEX_SUMMARY_CHARS || !body) {
      throw memdirError("MEMDIR_RESHAPE_CONTENT_INVALID", "AutoDream 新主题必须有名称、≤150 字符单行摘要与非空正文");
    }
    if (type === "project" && containsRelativeDate(`${description}\n${body}`)) {
      throw memdirError("MEMDIR_RELATIVE_DATE_REJECTED", "project 记忆中的相对日期必须转换为绝对日期");
    }
    const content = renderTopicFile({ name, description, type, createdAt: now, updatedAt: now }, body);
    if (!parseTopicFile(content, file) || Buffer.byteLength(content, "utf8") > MAX_TOPIC_BYTES) {
      throw memdirError("MEMDIR_TOPIC_BYTE_LIMIT", `${file} 的整合结果无效或超过 ${MAX_TOPIC_BYTES} bytes`);
    }
    return { file, type, name, description, body, createdAt: now, updatedAt: now, content };
  });
}

function normalizeReshapeReplacements(values, byFile, deletionSet, now) {
  const rows = Array.isArray(values) ? values : [];
  const seen = new Set();
  return rows.map((value) => {
    const file = normalizeFiles([value?.file])[0];
    const existing = byFile.get(file);
    if (!existing) throw memdirError("MEMDIR_RESHAPE_TARGET_MISSING", `AutoDream 只能重写已有主题：${file}`);
    if (seen.has(file) || deletionSet.has(file)) {
      throw memdirError("MEMDIR_RESHAPE_PLAN_INVALID", `AutoDream 对 ${file} 提交了冲突操作`);
    }
    seen.add(file);
    const type = `${value?.type || ""}`;
    const name = `${value?.name || ""}`.trim();
    const description = `${value?.description || ""}`.replace(/[\r\n\t]+/g, " ").trim();
    const body = `${value?.body || ""}`.trim();
    if (type !== existing.type || !file.startsWith(`${type}-`)) {
      throw memdirError("MEMDIR_TOPIC_TYPE_CONFLICT", `${file} 的封闭类型不能被 AutoDream 改写`);
    }
    if (!name || !description || Array.from(description).length > MAX_INDEX_SUMMARY_CHARS || !body) {
      throw memdirError("MEMDIR_RESHAPE_CONTENT_INVALID", "AutoDream 主题必须有名称、≤150 字符单行摘要与非空正文");
    }
    if (type === "project" && containsRelativeDate(`${description}\n${body}`)) {
      throw memdirError("MEMDIR_RELATIVE_DATE_REJECTED", "project 记忆中的相对日期必须转换为绝对日期");
    }
    const content = renderTopicFile({
      name,
      description,
      type,
      createdAt: existing.createdAt || now,
      updatedAt: now
    }, body);
    if (!parseTopicFile(content, file) || Buffer.byteLength(content, "utf8") > MAX_TOPIC_BYTES) {
      throw memdirError("MEMDIR_TOPIC_BYTE_LIMIT", `${file} 的整合结果无效或超过 ${MAX_TOPIC_BYTES} bytes`);
    }
    return {
      ...existing,
      name,
      description,
      body,
      updatedAt: now,
      content
    };
  });
}

function normalizeReshapeFiles(values = []) {
  const files = normalizeFiles(values);
  if (files.length !== (Array.isArray(values) ? values.length : 0)) {
    throw memdirError("MEMDIR_RESHAPE_PLAN_INVALID", "AutoDream 删除列表不能包含重复主题");
  }
  return files;
}

async function rollbackReshape(location, originals, index, replacements, deletions) {
  const files = [...new Set([
    ...replacements.map((topic) => topic.file),
    ...deletions
  ])];
  for (const file of files) {
    const content = originals.get(file);
    if (typeof content !== "string") {
      await unlinkSafeFile(path.join(location.memoryDirectory, file), location.memoryDirectory).catch(() => {});
      continue;
    }
    await writeSafeAtomic(
      path.join(location.memoryDirectory, file),
      content,
      location.memoryDirectory
    ).catch(() => {});
  }
  await writeSafeAtomic(
    path.join(location.memoryDirectory, INDEX_FILE),
    index,
    location.memoryDirectory
  ).catch(() => {});
  if (location.storageMode === "append-only") {
    await fsp.chmod(path.join(location.memoryDirectory, INDEX_FILE), 0o400).catch(() => {});
  }
}

async function assertReshapeGuard(guard) {
  if (typeof guard !== "function") return;
  if (await guard()) return;
  throw memdirError("AUTODREAM_LOCK_LOST", "AutoDream 已失去多实例锁，禁止提交整合结果");
}

async function unlinkSafeFile(file, root, maxBytes = MAX_TOPIC_BYTES) {
  const stat = await safeFileStat(file, root, maxBytes);
  if (stat) await fsp.unlink(path.resolve(file));
}

function reshapeDigest(topics = [], index = "", logs = []) {
  const rows = topics
    .map((topic) => `${topic.file}:${topic.sha256 || sha256(topic.content || "")}`)
    .sort();
  const journal = (Array.isArray(logs) ? logs : [])
    .map((log) => `${log.file}:${log.sha256 || sha256(log.content || "")}`)
    .sort();
  return sha256(`${rows.join("\n")}\nindex:${sha256(index)}\nlogs:${journal.join("\n")}`);
}

function sha256(value = "") {
  return crypto.createHash("sha256").update(`${value || ""}`, "utf8").digest("hex");
}

function safeDate(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : new Date();
}

function containsRelativeDate(value = "") {
  return /(?:今天|明天|后天|昨天|前天|本周|这周|下周|上周|本月|下个月|上个月|今年|明年|去年|\btoday\b|\btomorrow\b|\byesterday\b|\b(?:next|last)\s+(?:week|month|year)\b)/i.test(`${value || ""}`);
}

async function readTopicFilesByName(location, files = []) {
  const topics = [];
  for (const file of files) {
    const type = `${file}`.split("-", 1)[0];
    const absolute = path.join(location.memoryDirectory, file);
    const stat = await safeFileStat(absolute, location.memoryDirectory, MAX_TOPIC_BYTES);
    if (!stat) continue;
    const content = await fsp.readFile(absolute, "utf8");
    const parsed = parseTopicFile(content, file);
    if (parsed?.type === type) {
      topics.push({ ...parsed, modifiedAt: stat.mtime.toISOString() });
    }
  }
  return topics;
}

async function listTopicFiles(location) {
  const entries = await fsp.readdir(location.memoryDirectory, { withFileTypes: true }).catch(() => []);
  const topics = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() || entry.isSymbolicLink() || entry.name === INDEX_FILE || !entry.name.endsWith(".md")) continue;
    const fileMatch = entry.name.match(/^(user|feedback|project|reference)-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/);
    if (!fileMatch) continue;
    const absolute = path.join(location.memoryDirectory, entry.name);
    const stat = await safeFileStat(absolute, location.memoryDirectory, MAX_TOPIC_BYTES);
    const content = await readSafeFile(absolute, location.memoryDirectory, MAX_TOPIC_BYTES);
    const parsed = parseTopicFile(content, entry.name);
    if (parsed?.type === fileMatch[1]) {
      topics.push({ ...parsed, modifiedAt: stat?.mtime?.toISOString?.() || "" });
    }
  }
  if (topics.length > MAX_INDEX_LINES) {
    throw memdirError("MEMDIR_INDEX_LINE_LIMIT", `Memdir 主题文件不能超过 ${MAX_INDEX_LINES} 个`);
  }
  return topics;
}

async function listTopicHeaders(location, maxLines = PREFETCH_FRONT_MATTER_LINES) {
  const entries = await fsp.readdir(location.memoryDirectory, { withFileTypes: true }).catch(() => []);
  const topics = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() || entry.isSymbolicLink() || entry.name === INDEX_FILE || !entry.name.endsWith(".md")) continue;
    const fileMatch = entry.name.match(/^(user|feedback|project|reference)-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/);
    if (!fileMatch) continue;
    const absolute = path.join(location.memoryDirectory, entry.name);
    const head = await readSafeFileHead(
      absolute,
      location.memoryDirectory,
      maxLines,
      MAX_TOPIC_BYTES
    );
    const parsed = parseTopicFrontMatter(head.content, entry.name);
    if (parsed?.type === fileMatch[1]) {
      topics.push({ ...parsed, modifiedAt: head.modifiedAt });
    }
  }
  if (topics.length > MAX_INDEX_LINES) {
    throw memdirError("MEMDIR_INDEX_LINE_LIMIT", `Memdir 主题文件不能超过 ${MAX_INDEX_LINES} 个`);
  }
  return topics;
}

function rankTopics(topics, query, limit) {
  const docs = topics.map((topic) => ({
    key: `memdir:${topic.file}`,
    file: topic.file,
    scope: topic.type,
    content: `${topic.name}\n${topic.description}\n${topic.body}`
  }));
  const index = buildMemoryIndex(docs);
  const segments = filterMemorySegments(index, query, { topK: Math.max(limit * 6, 12) })
    .filter((segment) => Number(segment.score) > 0);
  const strongest = Number(segments[0]?.score) || 0;
  const relevanceFloor = Math.max(0.5, strongest * 0.2);
  const ordered = [];
  const seen = new Set();
  for (const segment of segments) {
    if (Number(segment.score) < relevanceFloor) continue;
    if (seen.has(segment.file)) continue;
    const topic = topics.find((item) => item.file === segment.file);
    if (!topic) continue;
    seen.add(segment.file);
    ordered.push(topic);
    if (ordered.length >= limit) break;
  }
  return ordered;
}

async function ensureSecureMemoryDirectory(location) {
  await fsp.mkdir(location.baseDirectory, { recursive: true, mode: 0o700 });
  await assertDirectoryNotSymlink(location.baseDirectory);
  await ensurePlainDirectoryTree(location.baseDirectory, location.projectDirectory);
  await ensurePlainDirectoryTree(location.baseDirectory, location.memoryDirectory);
  const [realBase, realMemory] = await Promise.all([
    fsp.realpath(location.baseDirectory),
    fsp.realpath(location.memoryDirectory)
  ]);
  if (!isPathInside(realBase, realMemory)) {
    throw memdirError("MEMDIR_PATH_UNSAFE", "Memdir 路径通过符号链接逃逸基础目录");
  }
}

async function ensurePlainDirectoryTree(base, target) {
  const root = path.resolve(base);
  const absolute = path.resolve(target);
  if (!isPathInside(root, absolute)) {
    throw memdirError("MEMDIR_PATH_UNSAFE", "Memdir 目录超出基础目录");
  }
  const relative = path.relative(root, absolute);
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    await fsp.mkdir(current, { mode: 0o700 }).catch((error) => {
      if (error?.code !== "EEXIST") throw error;
    });
    await assertDirectoryNotSymlink(current);
  }
}

async function assertDirectoryNotSymlink(directory) {
  const stat = await fsp.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw memdirError("MEMDIR_PATH_UNSAFE", "Memdir 基础目录必须是普通目录");
  }
}

async function readSafeFile(file, root, maxBytes = MAX_TOPIC_BYTES) {
  const stat = await safeFileStat(file, root, maxBytes);
  if (!stat) return "";
  return fsp.readFile(path.resolve(file), "utf8");
}

async function readSafeFileHead(
  file,
  root,
  maxLines = PREFETCH_FRONT_MATTER_LINES,
  maxBytes = MAX_TOPIC_BYTES
) {
  const absolute = path.resolve(file);
  const stat = await safeFileStat(absolute, root, maxBytes);
  if (!stat) return { content: "", modifiedAt: "" };
  const readLimit = Math.min(stat.size, MAX_FRONT_MATTER_HEAD_BYTES);
  const handle = await fsp.open(absolute, "r");
  const chunks = [];
  let position = 0;
  let newlineCount = 0;
  try {
    while (position < readLimit && newlineCount < maxLines) {
      const length = Math.min(1024, readLimit - position);
      const buffer = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      if (!bytesRead) break;
      const chunk = buffer.subarray(0, bytesRead);
      chunks.push(chunk);
      newlineCount += countByte(chunk, 10);
      position += bytesRead;
    }
  } finally {
    await handle.close();
  }
  return {
    content: firstLines(Buffer.concat(chunks).toString("utf8"), maxLines),
    modifiedAt: stat.mtime.toISOString()
  };
}

async function safeFileStat(file, root, maxBytes = MAX_TOPIC_BYTES) {
  const absolute = path.resolve(file);
  if (!isPathInside(path.resolve(root), absolute)) {
    throw memdirError("MEMDIR_PATH_UNSAFE", "记忆文件超出 Memdir");
  }
  const stat = await fsp.lstat(absolute).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!stat) return null;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw memdirError("MEMDIR_FILE_UNSAFE", "记忆文件必须是 nlink=1 的普通文件");
  }
  if (stat.size > maxBytes) throw memdirError("MEMDIR_TOPIC_BYTE_LIMIT", `记忆文件超过 ${maxBytes} bytes`);
  return stat;
}

function countByte(buffer, byte) {
  let count = 0;
  for (const value of buffer) if (value === byte) count += 1;
  return count;
}

function firstLines(content = "", maxLines = PREFETCH_FRONT_MATTER_LINES) {
  const source = `${content || ""}`.replace(/\r\n?/g, "\n");
  const limit = Math.max(1, maxLines);
  let offset = 0;
  for (let line = 0; line < limit; line += 1) {
    const newline = source.indexOf("\n", offset);
    if (newline < 0) return source;
    offset = newline + 1;
  }
  return source.slice(0, offset);
}

async function writeSafeAtomic(file, content, root, maxBytes = MAX_TOPIC_BYTES) {
  const absolute = path.resolve(file);
  if (!isPathInside(path.resolve(root), absolute)) {
    throw memdirError("MEMDIR_PATH_UNSAFE", "记忆写入超出 Memdir");
  }
  await readSafeFile(absolute, root, maxBytes).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
  const temp = path.join(root, `.${path.basename(file)}.${crypto.randomUUID()}.tmp`);
  try {
    await fsp.writeFile(temp, `${content || ""}`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await fsp.rename(temp, absolute);
  } catch (error) {
    await fsp.unlink(temp).catch(() => {});
    throw error;
  }
}

async function syncIndexFile(location, content) {
  const indexFile = path.join(location.memoryDirectory, INDEX_FILE);
  const stat = await safeFileStat(indexFile, location.memoryDirectory, MAX_INDEX_BYTES);
  const current = stat ? await fsp.readFile(indexFile, "utf8") : "";
  if (!stat || current !== content) {
    await writeSafeAtomic(indexFile, content, location.memoryDirectory, MAX_INDEX_BYTES);
  }
}

async function ensureReadOnlyIndex(location) {
  const indexFile = path.join(location.memoryDirectory, INDEX_FILE);
  const current = await readSafeFile(indexFile, location.memoryDirectory, MAX_INDEX_BYTES);
  if (!current && !(await safeFileStat(indexFile, location.memoryDirectory, MAX_INDEX_BYTES))) {
    await writeSafeAtomic(indexFile, "", location.memoryDirectory, MAX_INDEX_BYTES);
  }
  await fsp.chmod(indexFile, 0o400);
  return current;
}

function normalizeTypes(value) {
  const rows = Array.isArray(value) ? value : (value ? [value] : []);
  const normalized = rows.map((item) => `${item || ""}`.trim()).filter(Boolean);
  const invalid = normalized.find((item) => !MEMORY_TYPES.includes(item));
  if (invalid) throw memdirError("MEMDIR_TYPE_INVALID", `检索 type 只允许 ${MEMORY_TYPES.join("/")}`);
  return [...new Set(normalized)];
}

function normalizeFiles(value) {
  const rows = Array.isArray(value) ? value : (value ? [value] : []);
  const normalized = rows.map((item) => `${item || ""}`.trim()).filter(Boolean);
  const invalid = normalized.find((item) => (
    path.basename(item) !== item
    || !/^(?:user|feedback|project|reference)-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/.test(item)
  ));
  if (invalid) throw memdirError("MEMDIR_FILE_INVALID", "主题文件必须是 memory.md 索引中的安全文件名");
  return [...new Set(normalized)];
}

function topicId(file = "") {
  return `topic_${crypto.createHash("sha256").update(`${file || ""}`).digest("hex").slice(0, 16)}`;
}

function truncate(value = "", maxChars = MAX_SEARCH_CONTENT_CHARS) {
  const source = `${value || ""}`;
  if (maxChars <= 0) return "";
  if (source.length <= maxChars) return source;
  return `${source.slice(0, maxChars)}\n\n[主题记忆已按工具返回上限截断]`;
}

module.exports = {
  MemdirStore,
  INDEX_FILE,
  PREFETCH_FRONT_MATTER_LINES,
  MAX_SEARCH_CONTENT_CHARS,
  MAX_SEARCH_TOTAL_CHARS,
  listTopicHeaders,
  listTopicFiles,
  readTopicFilesByName,
  rankTopics,
  readSafeFile,
  readSafeFileHead,
  writeSafeAtomic
};
