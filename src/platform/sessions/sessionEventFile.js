// @ts-check

const path = require("node:path");
const { constants: fsConstants } = require("node:fs");
const fsp = require("node:fs/promises");
const readline = require("node:readline");
const { isPathInside } = require("../shared/pathSafety");

function sessionCorruptError(cause) {
  return Object.assign(new Error("任务会话事件文件已损坏，已阻止可能重复副作用的自动执行。"), {
    code: "TASK_SESSION_CORRUPT",
    cause
  });
}

async function scanJsonl(file, { strict = false, start = 0, onRow = null } = {}) {
  let handle;
  try {
    handle = await fsp.open(file, fsConstants.O_RDONLY | noFollowFlag());
    await assertSessionFileHandle(handle);
  } catch (error) {
    if (error?.code === "ENOENT") return { rows: 0 };
    if (error?.code === "TASK_SESSION_CORRUPT") throw error;
    throw sessionCorruptError(error);
  }
  let rows = 0;
  const input = handle.createReadStream({
    encoding: "utf8",
    start: Math.max(0, Number(start) || 0),
    autoClose: false
  });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch (error) {
        if (strict) throw sessionCorruptError(error);
        continue;
      }
      rows += 1;
      if (typeof onRow === "function") await onRow(row);
    }
    return { rows };
  } finally {
    lines.close();
    input.destroy();
    await handle.close().catch(() => {});
  }
}

async function readJsonl(file, { strict = false } = {}) {
  const rows = [];
  await scanJsonl(file, { strict, onRow: (row) => rows.push(row) });
  return rows;
}

async function appendJsonlDurable(file, row = {}) {
  let handle;
  try {
    handle = await fsp.open(
      file,
      fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | noFollowFlag(),
      0o600
    );
    await assertSessionFileHandle(handle);
    await handle.writeFile(`${JSON.stringify(row)}\n`, "utf8");
    await handle.sync();
  } catch (error) {
    if (error?.code === "TASK_SESSION_CORRUPT") throw error;
    throw sessionCorruptError(error);
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function ensureDirectoryInside(root, directory) {
  const absoluteRoot = path.resolve(root);
  const absoluteDirectory = path.resolve(directory);
  if (!isPathInside(absoluteRoot, absoluteDirectory)) throw sessionCorruptError();
  await fsp.mkdir(absoluteRoot, { recursive: true, mode: 0o700 });
  let current = await fsp.realpath(absoluteRoot);
  const rootInfo = await fsp.lstat(absoluteRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw sessionCorruptError();
  const realRoot = current;
  const relative = path.relative(absoluteRoot, absoluteDirectory);
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    const candidate = path.join(current, segment);
    let info;
    try {
      info = await fsp.lstat(candidate);
    } catch (error) {
      if (error?.code !== "ENOENT") throw sessionCorruptError(error);
      await fsp.mkdir(candidate, { mode: 0o700 }).catch((cause) => {
        if (cause?.code !== "EEXIST") throw cause;
      });
      info = await fsp.lstat(candidate);
    }
    if (!info.isDirectory() || info.isSymbolicLink()) throw sessionCorruptError();
    current = await fsp.realpath(candidate);
    if (!isPathInside(realRoot, current)) throw sessionCorruptError();
  }
  return current;
}

async function assertSessionFileHandle(handle) {
  const info = await handle.stat();
  if (!info.isFile() || info.nlink !== 1) throw sessionCorruptError();
}

function noFollowFlag() {
  return Number(fsConstants.O_NOFOLLOW) || 0;
}

module.exports = { appendJsonlDurable, ensureDirectoryInside, readJsonl, scanJsonl };
