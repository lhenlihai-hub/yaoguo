// @ts-check

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { isPathInside } = require("../../shared/pathSafety");
const { memdirError } = require("./memdirFormat");
const { validateMemoryWrite } = require("./memdirPolicy");

const MEMORY_LOG_DIRECTORY = "logs";
const MEMORY_LOG_ARCHIVE_DIRECTORY = "processed";
const MEMORY_LOG_PATH_PATTERN = "logs/{date}.md";
const APPEND_ONLY_MARKER = ".append-only";
const MAX_MEMORY_LOG_BYTES = 2 * 1024 * 1024;
const MEMORY_LOG_FILE_PATTERN = /^\d{4}-\d{2}-\d{2}\.md$/;
const MEMORY_LOG_MARKER_PATTERN = /^<!-- yaoguo:memory:([a-f0-9]{64}) -->$/;
const MEMORY_LOG_LOCK_FILE = ".journal.lock";
const MEMORY_LOG_LOCK_RETRY_MS = 15;
const MEMORY_LOG_LOCK_TIMEOUT_MS = 5000;
const MEMORY_LOG_INCOMPLETE_LOCK_STALE_MS = 15000;

async function ensureMemoryLogDirectories(memoryDirectory = "") {
  const root = path.resolve(memoryDirectory);
  const logDirectory = path.join(root, MEMORY_LOG_DIRECTORY);
  const archiveDirectory = path.join(logDirectory, MEMORY_LOG_ARCHIVE_DIRECTORY);
  await ensurePlainDirectory(logDirectory, root);
  await ensurePlainDirectory(archiveDirectory, root);
  return { logDirectory, archiveDirectory };
}

async function markAppendOnly(memoryDirectory = "") {
  const root = path.resolve(memoryDirectory);
  const file = path.join(root, APPEND_ONLY_MARKER);
  await fsp.writeFile(file, "append-only\n", {
    encoding: "utf8",
    mode: 0o400,
    flag: "wx"
  }).catch((error) => {
    if (error?.code !== "EEXIST") throw error;
  });
  const stat = await fsp.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw memdirError("MEMDIR_FILE_UNSAFE", "append-only 标记必须是 nlink=1 的普通文件");
  }
  return true;
}

async function hasAppendOnlyMarker(memoryDirectory = "") {
  const file = path.join(path.resolve(memoryDirectory), APPEND_ONLY_MARKER);
  const stat = await fsp.lstat(file).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!stat) return false;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw memdirError("MEMDIR_FILE_UNSAFE", "append-only 标记必须是 nlink=1 的普通文件");
  }
  return true;
}

async function appendMemoryLog(location, memory, now = new Date()) {
  const timestamp = safeDate(now);
  const { logDirectory } = await ensureMemoryLogDirectories(location.memoryDirectory);
  return withMemoryLogLock(logDirectory, async () => {
    const fileName = `${localDate(timestamp)}.md`;
    const file = path.join(logDirectory, fileName);
    const marker = `<!-- yaoguo:memory:${memory.entryDigest} -->`;
    const existing = await readLogFile(file, logDirectory);
    if (existing.includes(marker)) {
      return logResult(memory, timestamp, fileName, true);
    }
    const record = {
      version: 1,
      recordedAt: timestamp.toISOString(),
      type: memory.type,
      basis: memory.basis,
      topic: memory.topic,
      file: memory.file,
      name: memory.name,
      description: memory.description,
      content: memory.content,
      valueBeyondCode: memory.rationale,
      polarity: memory.polarity || null,
      reference: memory.reference || null,
      digest: memory.entryDigest
    };
    const header = existing ? "" : `# Memdir append log — ${localDate(timestamp)}\n\n`;
    const entry = `${header}${marker}\n\`\`\`json\n${JSON.stringify(record)}\n\`\`\`\n\n`;
    if (Buffer.byteLength(existing, "utf8") + Buffer.byteLength(entry, "utf8") > MAX_MEMORY_LOG_BYTES) {
      throw memdirError("MEMDIR_LOG_BYTE_LIMIT", `单日日志不能超过 ${MAX_MEMORY_LOG_BYTES} bytes`);
    }
    await appendSafeFile(file, entry, logDirectory);
    return logResult(memory, timestamp, fileName, false);
  });
}

async function listPendingMemoryLogs(location) {
  const { logDirectory } = await ensureMemoryLogDirectories(location.memoryDirectory);
  const entries = await fsp.readdir(logDirectory, { withFileTypes: true }).catch(() => []);
  const logs = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() || entry.isSymbolicLink() || !MEMORY_LOG_FILE_PATTERN.test(entry.name)) continue;
    const file = path.join(logDirectory, entry.name);
    const content = await readLogFile(file, logDirectory);
    const records = parseMemoryLog(content, entry.name);
    logs.push({
      file: `${MEMORY_LOG_DIRECTORY}/${entry.name}`,
      name: entry.name,
      content,
      bytes: Buffer.byteLength(content, "utf8"),
      entries: records.length,
      records
    });
  }
  return logs;
}

function parseMemoryLog(content = "", file = "") {
  const lines = `${content || ""}`.replace(/\r\n?/g, "\n").split("\n");
  const records = [];
  for (let index = 0; index < lines.length; index += 1) {
    const marker = lines[index].match(MEMORY_LOG_MARKER_PATTERN);
    if (!marker || lines[index + 1] !== "```json") continue;
    let row = null;
    try { row = JSON.parse(lines[index + 2] || ""); } catch { row = null; }
    if (lines[index + 3] !== "```" || !validLogRecord(row, marker[1])) {
      throw memdirError("MEMDIR_LOG_INVALID", `${file || "记忆日志"} 含无效追加记录`);
    }
    records.push(row);
    index += 3;
  }
  if (`${content || ""}`.trim() && !records.length) {
    throw memdirError("MEMDIR_LOG_INVALID", `${file || "记忆日志"} 不含有效追加记录`);
  }
  return records;
}

async function archivePendingMemoryLogs(location, logs = [], digest = "") {
  const { logDirectory, archiveDirectory } = await ensureMemoryLogDirectories(location.memoryDirectory);
  return withMemoryLogLock(logDirectory, async () => {
    const archived = [];
    try {
      for (const log of Array.isArray(logs) ? logs : []) {
        const name = `${log?.name || ""}`;
        if (!MEMORY_LOG_FILE_PATTERN.test(name)) continue;
        const source = path.join(logDirectory, name);
        const suffix = `${digest || ""}`.slice(0, 12) || "dreamed";
        const target = path.join(archiveDirectory, name.replace(/\.md$/, `-${suffix}.md`));
        const stat = await safeLogStat(source, logDirectory);
        if (!stat) continue;
        const content = await readLogFile(source, logDirectory);
        if (log.sha256 && sha256(content) !== log.sha256) {
          throw memdirError(
            "MEMDIR_RESHAPE_CONFLICT",
            `归档窗口内 ${name} 出现新追加记录，本轮整合已放弃归档`
          );
        }
        await fsp.rename(source, target);
        archived.push({ source, target, file: `${MEMORY_LOG_DIRECTORY}/${name}` });
      }
    } catch (error) {
      await restoreArchivedMemoryLogs(archived);
      throw error;
    }
    return archived;
  });
}

async function withMemoryLogLock(logDirectory, action) {
  const lockFile = path.join(logDirectory, MEMORY_LOG_LOCK_FILE);
  const startedAt = Date.now();
  let handle = null;
  while (!handle) {
    try {
      handle = await fsp.open(
        lockFile,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0),
        0o600
      );
      await handle.writeFile(JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }));
      await handle.sync();
    } catch (error) {
      await handle?.close().catch(() => {});
      handle = null;
      if (error?.code !== "EEXIST") throw error;
      if (await removeAbandonedMemoryLogLock(lockFile)) continue;
      if (Date.now() - startedAt >= MEMORY_LOG_LOCK_TIMEOUT_MS) {
        throw memdirError("MEMDIR_LOG_LOCK_TIMEOUT", "记忆日志正在被另一进程修改，请稍后重试");
      }
      await new Promise((resolve) => setTimeout(resolve, MEMORY_LOG_LOCK_RETRY_MS));
    }
  }
  const identity = fileIdentity(await handle.stat({ bigint: true }));
  try {
    return await action();
  } finally {
    await handle.close().catch(() => {});
    await unlinkIfIdentity(lockFile, identity).catch(() => false);
  }
}

async function removeAbandonedMemoryLogLock(lockFile) {
  const stat = await fsp.lstat(lockFile, { bigint: true }).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink()) return false;
  let owner = null;
  try { owner = JSON.parse(await fsp.readFile(lockFile, "utf8")); } catch {}
  const pid = Number(owner?.pid);
  if (!Number.isSafeInteger(pid) || pid <= 1) {
    const ageMs = Date.now() - Number(stat.mtimeMs || 0);
    if (ageMs < MEMORY_LOG_INCOMPLETE_LOCK_STALE_MS) return false;
  } else if (processIsAlive(pid)) {
    return false;
  }
  return unlinkIfIdentity(lockFile, fileIdentity(stat));
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function unlinkIfIdentity(file, expected) {
  const stat = await fsp.lstat(file, { bigint: true }).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink() || !sameIdentity(fileIdentity(stat), expected)) return false;
  await fsp.unlink(file);
  return true;
}

function fileIdentity(stat) {
  return { dev: `${stat?.dev || ""}`, ino: `${stat?.ino || ""}` };
}

function sameIdentity(left = {}, right = {}) {
  return `${left?.dev || ""}` === `${right?.dev || ""}`
    && `${left?.ino || ""}` === `${right?.ino || ""}`;
}

async function restoreArchivedMemoryLogs(rows = []) {
  for (const row of [...(Array.isArray(rows) ? rows : [])].reverse()) {
    await fsp.rename(row.target, row.source).catch(() => {});
  }
}

async function listAllMemoryLogs(location) {
  const pending = await listPendingMemoryLogs(location);
  const { archiveDirectory } = await ensureMemoryLogDirectories(location.memoryDirectory);
  const entries = await fsp.readdir(archiveDirectory, { withFileTypes: true }).catch(() => []);
  const processed = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() || entry.isSymbolicLink() || !/^\d{4}-\d{2}-\d{2}-.+\.md$/.test(entry.name)) continue;
    const content = await readLogFile(path.join(archiveDirectory, entry.name), archiveDirectory);
    processed.push({ file: `${MEMORY_LOG_DIRECTORY}/${MEMORY_LOG_ARCHIVE_DIRECTORY}/${entry.name}`, content });
  }
  return [
    ...pending.map((row) => ({ file: row.file, content: row.content })),
    ...processed
  ];
}

async function appendSafeFile(file, content, root) {
  const absolute = path.resolve(file);
  if (!isPathInside(path.resolve(root), absolute)) {
    throw memdirError("MEMDIR_PATH_UNSAFE", "记忆日志写入超出日志目录");
  }
  const flags = fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_WRONLY
    | (fs.constants.O_NOFOLLOW || 0);
  const handle = await fsp.open(absolute, flags, 0o600);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1) {
      throw memdirError("MEMDIR_FILE_UNSAFE", "记忆日志必须是 nlink=1 的普通文件");
    }
    await handle.write(`${content || ""}`, null, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readLogFile(file, root) {
  const stat = await safeLogStat(file, root);
  if (!stat) return "";
  return fsp.readFile(path.resolve(file), "utf8");
}

async function safeLogStat(file, root) {
  const absolute = path.resolve(file);
  if (!isPathInside(path.resolve(root), absolute)) {
    throw memdirError("MEMDIR_PATH_UNSAFE", "记忆日志超出日志目录");
  }
  const stat = await fsp.lstat(absolute).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!stat) return null;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw memdirError("MEMDIR_FILE_UNSAFE", "记忆日志必须是 nlink=1 的普通文件");
  }
  if (stat.size > MAX_MEMORY_LOG_BYTES) {
    throw memdirError("MEMDIR_LOG_BYTE_LIMIT", `单日日志不能超过 ${MAX_MEMORY_LOG_BYTES} bytes`);
  }
  return stat;
}

async function ensurePlainDirectory(directory, root) {
  if (!isPathInside(path.resolve(root), path.resolve(directory))) {
    throw memdirError("MEMDIR_PATH_UNSAFE", "记忆日志目录超出 Memdir");
  }
  await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fsp.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw memdirError("MEMDIR_PATH_UNSAFE", "记忆日志目录必须是普通目录");
  }
}

function validLogRecord(row, digest) {
  if (row?.version !== 1 || row?.digest !== digest || !Number.isFinite(Date.parse(`${row?.recordedAt || ""}`))) {
    return false;
  }
  try {
    const memory = validateMemoryWrite(row);
    return memory.file === row.file && memory.entryDigest === row.digest;
  } catch {
    return false;
  }
}

function logResult(memory, timestamp, logFile, deduplicated) {
  return {
    id: `mem_${memory.entryDigest.slice(0, 16)}`,
    type: memory.type,
    file: memory.file,
    name: memory.name,
    description: memory.description,
    content: memory.content,
    polarity: memory.polarity || null,
    reference: memory.reference || null,
    createdAt: timestamp.toISOString(),
    deduplicated,
    pendingIndex: true,
    logFile: `${MEMORY_LOG_DIRECTORY}/${logFile}`,
    logPathPattern: MEMORY_LOG_PATH_PATTERN
  };
}

function localDate(value = new Date()) {
  const date = safeDate(value);
  return [
    date.getFullYear(),
    `${date.getMonth() + 1}`.padStart(2, "0"),
    `${date.getDate()}`.padStart(2, "0")
  ].join("-");
}

function safeDate(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : new Date();
}

module.exports = {
  MEMORY_LOG_DIRECTORY,
  MEMORY_LOG_ARCHIVE_DIRECTORY,
  MEMORY_LOG_PATH_PATTERN,
  APPEND_ONLY_MARKER,
  MAX_MEMORY_LOG_BYTES,
  appendMemoryLog,
  listPendingMemoryLogs,
  listAllMemoryLogs,
  parseMemoryLog,
  archivePendingMemoryLogs,
  restoreArchivedMemoryLogs,
  ensureMemoryLogDirectories,
  markAppendOnly,
  hasAppendOnlyMarker,
  localDate
};

function sha256(value = "") {
  return crypto.createHash("sha256").update(`${value || ""}`, "utf8").digest("hex");
}
