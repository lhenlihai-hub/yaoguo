const crypto = require("node:crypto");
const { constants: fsConstants } = require("node:fs");
const fsp = require("node:fs/promises");
const { writeJsonAtomic } = require("../shared/fs");
const { scanJsonl } = require("./sessionEventFile");
const {
  corruptSessionContentError,
  readOptionalJsonNoFollow
} = require("./taskSessionContent");

async function readStableSessionFile(file, read, attempt = 0) {
  const identity = await eventFileIdentity(file);
  const value = await read();
  const confirmed = await eventFileIdentity(file);
  if (sameEventFileIdentity(identity, confirmed)) return value;
  if (attempt >= 2) throw unstableSessionError();
  return readStableSessionFile(file, read, attempt + 1);
}

async function updateHistoryProjection({ eventsFile, file, cursorFile, hydrate }) {
  const cursor = await readOptionalJsonNoFollow(cursorFile);
  const source = await eventFileIdentity(eventsFile);
  if (historyCursorMatches(cursor, source)) {
    try {
      return await appendHistoryProjection({ eventsFile, file, cursorFile, cursor, source, hydrate });
    } catch (error) {
      if (["TASK_SESSION_CORRUPT", "TASK_SESSION_UNSTABLE"].includes(error?.code)) throw error;
    }
  }
  return rebuildHistoryProjection({ eventsFile, file, cursorFile, hydrate });
}

async function eventFileIdentity(file) {
  let handle;
  try {
    handle = await fsp.open(file, fsConstants.O_RDONLY | noFollowFlag());
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n) throw corruptSessionContentError();
    return {
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
      mtimeNs: stat.mtimeNs
    };
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    if (error?.code === "TASK_SESSION_CORRUPT") throw error;
    throw corruptSessionContentError(error);
  } finally {
    await handle?.close().catch(() => {});
  }
}

function sameEventFileIdentity(left, right) {
  if (!left || !right) return left === right;
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs;
}

async function appendHistoryProjection({ eventsFile, file, cursorFile, cursor, source, hydrate }) {
  const handle = await fsp.open(file, fsConstants.O_RDWR | fsConstants.O_APPEND | noFollowFlag());
  const projectionBytes = Number(cursor.projectionBytes);
  let messageCount = Number(cursor.messageCount);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size < projectionBytes) {
      throw new Error("history-projection-identity-mismatch");
    }
    if (before.size > projectionBytes) await handle.truncate(projectionBytes);
    await scanJsonl(eventsFile, {
      strict: true,
      start: Number(cursor.sourceBytes),
      onRow: async (row) => {
        if (!isMessageEvent(row)) return;
        const materialized = await hydrate(row);
        const separator = messageCount ? "\n---\n\n" : "";
        await handle.writeFile(`${separator}${renderHistoryRow(materialized, messageCount)}\n`, "utf8");
        messageCount += 1;
      }
    });
    const confirmed = await eventFileIdentity(eventsFile);
    if (!sameEventFileIdentity(source, confirmed)) throw unstableSessionError();
    await handle.sync();
    const stat = await handle.stat();
    await writeHistoryCursor(cursorFile, confirmed, messageCount, stat.size);
    return stat;
  } catch (error) {
    await handle.truncate(projectionBytes).catch(() => {});
    await handle.sync().catch(() => {});
    throw error;
  } finally {
    await handle.close().catch(() => {});
  }
}

async function rebuildHistoryProjection({ eventsFile, file, cursorFile, hydrate }, attempt = 0) {
  const source = await eventFileIdentity(eventsFile);
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  const handle = await fsp.open(temp, "wx", 0o600);
  let messageCount = 0;
  try {
    await handle.writeFile("# 任务完整历史\n\n", "utf8");
    await scanJsonl(eventsFile, {
      strict: true,
      onRow: async (row) => {
        if (!isMessageEvent(row)) return;
        const materialized = await hydrate(row);
        const separator = messageCount ? "\n---\n\n" : "";
        await handle.writeFile(`${separator}${renderHistoryRow(materialized, messageCount)}\n`, "utf8");
        messageCount += 1;
      }
    });
    const confirmed = await eventFileIdentity(eventsFile);
    if (!sameEventFileIdentity(source, confirmed)) throw unstableSessionError();
    await handle.sync();
    await handle.close();
    await fsp.rename(temp, file);
    const stat = await fsp.stat(file);
    await writeHistoryCursor(cursorFile, confirmed, messageCount, stat.size);
    return stat;
  } catch (error) {
    await handle.close().catch(() => {});
    await fsp.unlink(temp).catch(() => {});
    if (error?.code === "TASK_SESSION_UNSTABLE" && attempt < 2) {
      return rebuildHistoryProjection({ eventsFile, file, cursorFile, hydrate }, attempt + 1);
    }
    throw error;
  }
}

function renderHistoryRow(row, index) {
  return [
    `## ${index + 1}. ${row.role === "user" ? "用户" : (row.role === "assistant" ? "Agent" : "系统")}`,
    row.createdAt ? `时间：${row.createdAt}` : "",
    row.turnId ? `turnId：${row.turnId}` : "",
    "",
    `${row.content || ""}`
  ].filter(Boolean).join("\n");
}

function isMessageEvent(row = {}) {
  return row.type === "message" && ["user", "assistant", "system"].includes(row.role);
}

function historyCursorMatches(cursor, source) {
  return Boolean(source)
    && Number(cursor?.version) === 2
    && `${cursor.sourceDev || ""}` === `${source.dev}`
    && `${cursor.sourceIno || ""}` === `${source.ino}`
    && Number.isSafeInteger(Number(cursor.sourceBytes))
    && Number(cursor.sourceBytes) >= 0
    && Number(cursor.sourceBytes) <= Number(source.size)
    && Number.isSafeInteger(Number(cursor.projectionBytes))
    && Number(cursor.projectionBytes) >= 0
    && Number.isSafeInteger(Number(cursor.messageCount))
    && Number(cursor.messageCount) >= 0;
}

async function writeHistoryCursor(cursorFile, source, messageCount, projectionBytes) {
  await writeJsonAtomic(cursorFile, {
    version: 2,
    sourceDev: source ? `${source.dev}` : "",
    sourceIno: source ? `${source.ino}` : "",
    sourceBytes: source ? Number(source.size) : 0,
    messageCount,
    projectionBytes
  });
}

function unstableSessionError() {
  return Object.assign(new Error("任务会话事件在读取期间持续变化，已停止本次执行。"), {
    code: "TASK_SESSION_UNSTABLE"
  });
}

function noFollowFlag() {
  return Number(fsConstants.O_NOFOLLOW) || 0;
}

module.exports = { readStableSessionFile, updateHistoryProjection };
