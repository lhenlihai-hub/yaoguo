// @ts-check

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const COPY_BUFFER_BYTES = 64 * 1024;
const noFollow = Number(fs.constants.O_NOFOLLOW) || 0;

async function main() {
  const payload = parsePayload(process.argv[2]);
  await assertDirectoryIdentity(payload);
  const temporary = `.${payload.requestedFileName}.publish-${process.pid}-${crypto.randomBytes(12).toString("hex")}.tmp`;
  let sourceHandle = null;
  let temporaryHandle = null;
  let committedFile = "";
  let committedIdentity = null;
  let completed = false;
  try {
    sourceHandle = await fsp.open(payload.source, fs.constants.O_RDONLY | noFollow);
    const sourceStat = await sourceHandle.stat();
    if (!sourceStat.isFile()) throw workerError("PUBLISH_SOURCE_UNSAFE", "交付来源不是普通文件。");
    temporaryHandle = await fsp.open(
      temporary,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow,
      0o644
    );
    const copied = await copyAndHash(sourceHandle, temporaryHandle);
    if (payload.expectedSha256 && copied.sha256 !== payload.expectedSha256) {
      throw workerError("PUBLISH_SOURCE_CHANGED", "成品内容在交付复制时发生变化，请重新调用 inspect_artifact。");
    }
    await temporaryHandle.sync();
    const temporaryStat = await temporaryHandle.stat({ bigint: true });
    await temporaryHandle.close();
    temporaryHandle = null;
    await assertDirectoryIdentity(payload);
    const file = await commitExclusive(temporary, payload.requestedFileName, payload);
    committedFile = file;
    committedIdentity = fileIdentity(temporaryStat);
    await fsp.unlink(temporary);
    await syncCurrentDirectory();
    await assertDirectoryIdentity(payload);
    const committedStat = await fsp.lstat(file, { bigint: true });
    if (!sameIdentity(fileIdentity(committedStat), fileIdentity(temporaryStat))) {
      throw workerError("PUBLISH_TARGET_CHANGED", "交付目标在提交期间被替换。");
    }
    process.stdout.write(JSON.stringify({
      ok: true,
      file,
      bytes: copied.bytes,
      sha256: copied.sha256,
      updatedAt: new Date(Number(committedStat.mtimeMs)).toISOString(),
      identity: fileIdentity(committedStat)
    }));
    completed = true;
  } finally {
    await sourceHandle?.close().catch(() => {});
    await temporaryHandle?.close().catch(() => {});
    if (!completed && committedFile && committedIdentity) {
      await unlinkIfIdentity(committedFile, committedIdentity).catch(() => false);
    }
    await unlinkOwnedTemporary(temporary).catch(() => {});
  }
}

function parsePayload(raw = "") {
  let payload = null;
  try { payload = JSON.parse(`${raw || ""}`); } catch {}
  const requestedFileName = `${payload?.requestedFileName || ""}`;
  if (
    !path.isAbsolute(`${payload?.source || ""}`)
    || !path.isAbsolute(`${payload?.approvedDirectory || ""}`)
    || !requestedFileName
    || path.basename(requestedFileName) !== requestedFileName
    || !`${payload?.directoryIdentity?.dev || ""}`
    || !`${payload?.directoryIdentity?.ino || ""}`
  ) {
    throw workerError("PUBLISH_INPUT_INVALID", "交付复制进程收到无效参数。");
  }
  return { ...payload, requestedFileName };
}

async function assertDirectoryIdentity(payload) {
  const [cwdStat, pathStat] = await Promise.all([
    fsp.stat(".", { bigint: true }),
    fsp.lstat(payload.approvedDirectory, { bigint: true })
  ]).catch(() => []);
  const expected = payload.directoryIdentity;
  if (
    !cwdStat?.isDirectory()
    || !pathStat?.isDirectory()
    || pathStat.isSymbolicLink()
    || !sameIdentity(fileIdentity(cwdStat), expected)
    || !sameIdentity(fileIdentity(pathStat), expected)
  ) {
    throw workerError("PUBLISH_DIRECTORY_CHANGED", "用户指定的输出目录在交付期间发生变化。");
  }
}

async function commitExclusive(temporary, requestedFileName, payload) {
  const extension = path.extname(requestedFileName);
  const base = path.basename(requestedFileName, extension);
  for (let version = 1; ; version += 1) {
    await assertDirectoryIdentity(payload);
    const file = version === 1 ? requestedFileName : `${base}-v${version}${extension}`;
    try {
      await fsp.link(temporary, file);
      return file;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const existing = await fsp.lstat(file).catch(() => null);
      if (existing?.isSymbolicLink()) {
        throw workerError("PUBLISH_TARGET_SYMLINK", `用户指定位置存在符号链接，不能写入：${path.join(payload.approvedDirectory, file)}`);
      }
    }
  }
}

async function copyAndHash(sourceHandle, destinationHandle) {
  const hash = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
  let position = 0;
  while (true) {
    const { bytesRead } = await sourceHandle.read(buffer, 0, buffer.length, position);
    if (!bytesRead) break;
    hash.update(buffer.subarray(0, bytesRead));
    let written = 0;
    while (written < bytesRead) {
      const result = await destinationHandle.write(buffer, written, bytesRead - written, position + written);
      if (!result.bytesWritten) throw workerError("PUBLISH_WRITE_STALLED", "成品交付写入没有取得进展。");
      written += result.bytesWritten;
    }
    position += bytesRead;
  }
  return { bytes: position, sha256: hash.digest("hex") };
}

async function unlinkOwnedTemporary(file) {
  const stat = await fsp.lstat(file).catch(() => null);
  if (stat?.isFile() && !stat.isSymbolicLink() && stat.nlink === 1) await fsp.unlink(file);
}

async function unlinkIfIdentity(file, expected) {
  const stat = await fsp.lstat(file, { bigint: true }).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink() || !sameIdentity(fileIdentity(stat), expected)) return false;
  await fsp.unlink(file);
  return true;
}

async function syncCurrentDirectory() {
  const handle = await fsp.open(".", fs.constants.O_RDONLY);
  try { await handle.sync().catch(() => {}); } finally { await handle.close(); }
}

function fileIdentity(stat) {
  return { dev: `${stat?.dev || ""}`, ino: `${stat?.ino || ""}` };
}

function sameIdentity(left = {}, right = {}) {
  return `${left?.dev || ""}` === `${right?.dev || ""}`
    && `${left?.ino || ""}` === `${right?.ino || ""}`;
}

function workerError(code, message) {
  const error = /** @type {Error & {code?:string}} */ (new Error(message));
  error.code = code;
  return error;
}

main().catch((error) => {
  process.stderr.write(JSON.stringify({ code: `${error?.code || "PUBLISH_COPY_FAILED"}`, message: `${error?.message || error}` }));
  process.exitCode = 1;
});
