const crypto = require("node:crypto");
const { constants: fsConstants } = require("node:fs");
const fsp = require("node:fs/promises");

function sha256Text(value = "") {
  return crypto.createHash("sha256").update(`${value || ""}`, "utf8").digest("hex");
}

function messageContentDigest(row = {}) {
  const stored = `${row.contentSha256 || row.contentRef?.sha256 || ""}`;
  return /^[a-f0-9]{64}$/i.test(stored) ? stored.toLowerCase() : sha256Text(row.content || "");
}

async function readContentBody(file, expectedSha256) {
  let handle;
  try {
    handle = await fsp.open(file, fsConstants.O_RDONLY | noFollowFlag());
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1) throw corruptSessionContentError();
    const content = await handle.readFile("utf8");
    if (sha256Text(content) !== `${expectedSha256 || ""}`.toLowerCase()) {
      throw corruptSessionContentError();
    }
    return content;
  } catch (error) {
    if (error?.code === "TASK_SESSION_CORRUPT") throw error;
    throw corruptSessionContentError(error);
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function regularFileExistsNoFollow(file) {
  try {
    const info = await fsp.lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
      throw corruptSessionContentError();
    }
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    if (error?.code === "TASK_SESSION_CORRUPT") throw error;
    throw corruptSessionContentError(error);
  }
}

async function readOptionalJsonNoFollow(file) {
  let handle;
  try {
    handle = await fsp.open(file, fsConstants.O_RDONLY | noFollowFlag());
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1) throw corruptSessionContentError();
    const content = await handle.readFile("utf8");
    try {
      return JSON.parse(content);
    } catch {
      return null;
    }
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    if (error?.code === "TASK_SESSION_CORRUPT") throw error;
    throw corruptSessionContentError(error);
  } finally {
    await handle?.close().catch(() => {});
  }
}

function corruptSessionContentError(cause = null) {
  return Object.assign(new Error("任务会话正文引用缺失或已被修改，已停止本次执行。"), {
    code: "TASK_SESSION_CORRUPT",
    cause
  });
}

function noFollowFlag() {
  return Number(fsConstants.O_NOFOLLOW) || 0;
}

module.exports = {
  corruptSessionContentError,
  messageContentDigest,
  readContentBody,
  readOptionalJsonNoFollow,
  regularFileExistsNoFollow,
  sha256Text
};
