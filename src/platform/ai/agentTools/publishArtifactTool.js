// @ts-check

const path = require("node:path");
const fsp = require("node:fs/promises");
const crypto = require("node:crypto");
const { constants: fsConstants } = require("node:fs");
const { isPathInside } = require("../../shared/pathSafety");
const {
  resolveScopedArtifactPath,
  inspectionRegistry,
  candidateRegistry
} = require("./artifactInspectionTool");
const {
  PUBLISHED_ARTIFACT_TRANSACTION_VERSION,
  PUBLISHED_ARTIFACT_TRANSACTION_KIND,
  PUBLISHED_ARTIFACT_TRANSACTION_OWNER_ID,
  publishedArtifactManifestName,
  publishedArtifactTransactionName,
  isPublishedArtifactManifest,
  isPublishedArtifactTransaction,
  publishedArtifactManifestFromTransaction
} = require("../../artifacts/publishedArtifactManifest");

const SNAPSHOT_BUFFER_BYTES = 64 * 1024;

const PUBLISH_ARTIFACT_TOOL_SCHEMA = {
  type: "function",
  function: {
    name: "publish_artifact",
    description: [
      "发布一个已经 inspect_artifact 检查、且由你确认满足用户要求的最终文件。",
      "发布是所有文件进入成品区的唯一出口；生成工具成功只代表候选文件存在。",
      "源码、构建脚本、草稿、缓存和临时预览不要发布，除非它们就是用户要求的交付物。"
    ].join(""),
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          minLength: 1,
          description: "最终文件路径。相对路径按当前 Agent 工作空间解析，也可使用当前任务或工作空间内的绝对路径。"
        },
        inspectionId: {
          type: "string",
          pattern: "^inspection_[a-f0-9]{24}$",
          description: "最近一次 inspect_artifact 返回的 inspectionId。文件修改后必须重新检查。"
        },
        title: {
          type: "string",
          maxLength: 120,
          description: "可选。右侧成品区显示的标题；不填使用文件名。"
        }
      },
      required: ["path", "inspectionId"],
      additionalProperties: false
    }
  }
};

const publishArtifactTool = {
  schema: PUBLISH_ARTIFACT_TOOL_SCHEMA,
  async execute(args = {}, ctx = {}) {
    const canonical = await resolveScopedArtifactPath(args.path, ctx);
    const stat = await fsp.stat(canonical);
    if (!stat.isFile()) throw new Error("publish_artifact 只能登记文件。");
    const inspectionId = `${args.inspectionId || ""}`.trim();
    const inspection = inspectionRegistry(ctx).get(inspectionId);
    if (!inspection || inspection.absolute !== canonical) {
      throw new Error("inspectionId 不属于该文件，请先调用 inspect_artifact。");
    }
    if (!inspection.valid) throw new Error("候选文件的真实检查未通过，不能发布。");
    const title = `${args.title || ""}`.trim() || path.basename(canonical);
    const { absolute, sha256 } = await snapshotInspectedArtifact({
      source: canonical,
      taskDir: ctx.taskDir,
      expectedSha256: inspection.sha256,
      inspectionId,
      inspectedAt: inspection.inspectedAt,
      title
    });
    if (inspection.snapshot) await fsp.unlink(inspection.snapshot).catch(() => {});
    markCandidatePublished(ctx, canonical, absolute, inspectionId);
    const publishedStat = await fsp.stat(absolute);
    return {
      absolute,
      file: path.basename(absolute),
      title,
      bytes: publishedStat.size,
      sha256,
      inspectionId,
      inspectedAt: inspection.inspectedAt,
      updatedAt: publishedStat.mtime.toISOString(),
      published: true
    };
  }
};

async function snapshotInspectedArtifact({
  source, taskDir, expectedSha256, inspectionId, inspectedAt, title
}) {
  const requestedTaskRoot = `${taskDir || ""}`.trim();
  if (!requestedTaskRoot) throw new Error("publish_artifact 缺少当前任务目录。");
  const taskRoot = await fsp.realpath(requestedTaskRoot);
  const finalPath = path.join(taskRoot, "final");
  await fsp.mkdir(finalPath, { recursive: true });
  const finalDir = await fsp.realpath(finalPath);
  if (finalDir === taskRoot || !isPathInside(taskRoot, finalDir)) {
    throw new Error("成品目录经符号链接越出当前任务。");
  }

  const temporary = path.join(
    finalDir,
    `.publish-${process.pid}-${crypto.randomBytes(12).toString("hex")}.tmp`
  );
  let sourceHandle = null;
  let snapshotHandle = null;
  try {
    const noFollow = Number(fsConstants.O_NOFOLLOW) || 0;
    sourceHandle = await fsp.open(source, fsConstants.O_RDONLY | noFollow);
    const sourceStat = await sourceHandle.stat();
    if (!sourceStat.isFile()) throw new Error("publish_artifact 只能登记文件。");
    snapshotHandle = await fsp.open(
      temporary,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
      0o600
    );
    const copied = await copyAndHash(sourceHandle, snapshotHandle);
    await snapshotHandle.sync();
    await snapshotHandle.close();
    snapshotHandle = null;
    if (copied.sha256 !== expectedSha256) {
      throw new Error("文件在检查后发生变化，请重新调用 inspect_artifact。");
    }

    const committed = await commitUniqueSnapshot({
      temporary,
      dir: finalDir,
      fileName: path.basename(source),
      metadata: {
        title,
        bytes: copied.bytes,
        sha256: copied.sha256,
        inspectionId,
        inspectedAt
      }
    });
    await removeInternalCandidate(source, taskRoot);
    return { absolute: committed.absolute, sha256: copied.sha256 };
  } finally {
    await sourceHandle?.close().catch(() => {});
    await snapshotHandle?.close().catch(() => {});
    await fsp.unlink(temporary).catch(() => {});
  }
}

async function copyAndHash(sourceHandle, snapshotHandle) {
  const hash = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(SNAPSHOT_BUFFER_BYTES);
  let totalBytes = 0;
  while (true) {
    const { bytesRead } = await sourceHandle.read(buffer, 0, buffer.length, null);
    if (!bytesRead) break;
    totalBytes += bytesRead;
    hash.update(buffer.subarray(0, bytesRead));
    let offset = 0;
    while (offset < bytesRead) {
      const { bytesWritten } = await snapshotHandle.write(
        buffer,
        offset,
        bytesRead - offset,
        null
      );
      if (!bytesWritten) throw new Error("写入成品快照失败。");
      offset += bytesWritten;
    }
  }
  return { sha256: hash.digest("hex"), bytes: totalBytes };
}

async function commitUniqueSnapshot({ temporary, dir, fileName, metadata }) {
  const extension = path.extname(fileName);
  const base = path.basename(fileName, extension);
  const stageStat = await fsp.lstat(temporary, { bigint: true });
  if (!stageStat.isFile() || stageStat.isSymbolicLink()) {
    throw new Error("成品暂存文件不是普通文件。");
  }
  const stageIdentity = fileIdentity(stageStat);
  for (let version = 1; ; version += 1) {
    const committedFileName = version === 1 ? fileName : `${base}-v${version}${extension}`;
    const candidate = path.join(dir, committedFileName);
    const manifestPath = path.join(dir, publishedArtifactManifestName(committedFileName));
    const transactionId = `publish_${crypto.randomBytes(12).toString("hex")}`;
    const transactionPath = path.join(dir, publishedArtifactTransactionName(transactionId));
    const publishedAt = new Date().toISOString();
    const transaction = {
      version: PUBLISHED_ARTIFACT_TRANSACTION_VERSION,
      kind: PUBLISHED_ARTIFACT_TRANSACTION_KIND,
      state: "pending",
      source: "agent-publish",
      transactionId,
      ownerId: PUBLISHED_ARTIFACT_TRANSACTION_OWNER_ID,
      file: committedFileName,
      stageFile: path.basename(temporary),
      stageIdentity,
      title: `${metadata.title || ""}` || committedFileName,
      bytes: Number(metadata.bytes) || 0,
      sha256: `${metadata.sha256 || ""}`,
      inspectionId: `${metadata.inspectionId || ""}`,
      inspectedAt: `${metadata.inspectedAt || ""}`,
      publishedAt
    };
    let transactionReserved = false;
    let candidateLinked = false;
    let manifestReserved = false;
    try {
      if (await removeStaleManifestReservation(manifestPath, candidate, committedFileName)) {
        await syncDirectory(dir);
      }
      await writeJsonExclusive(transactionPath, transaction);
      transactionReserved = true;
      await syncDirectory(dir);
      await fsp.link(temporary, candidate);
      candidateLinked = true;
      await syncDirectory(dir);
      await writeJsonExclusive(
        manifestPath,
        publishedArtifactManifestFromTransaction(transaction)
      );
      manifestReserved = true;
      await syncDirectory(dir);
      await unlinkIfIdentity(temporary, stageIdentity).catch(() => false);
      await syncDirectory(dir);
      await removeOwnedTransaction(transactionPath, transactionId).catch(() => false);
      await syncDirectory(dir);
      return { absolute: candidate, manifestPath, publishedAt };
    } catch (error) {
      if (manifestReserved) return { absolute: candidate, manifestPath, publishedAt };
      if (candidateLinked) {
        const rolledBack = await unlinkIfIdentity(candidate, stageIdentity).catch(() => false);
        if (!rolledBack) {
          throw new Error("发布事务回滚失败，已保留事务记录供下次启动恢复。", { cause: error });
        }
      }
      if (transactionReserved) {
        const transactionRemoved = await removeOwnedTransaction(transactionPath, transactionId)
          .catch(() => false);
        await syncDirectory(dir);
        if (!transactionRemoved) {
          throw new Error("发布事务清理失败，已保留记录供下次启动恢复。", { cause: error });
        }
      }
      if (error?.code === "EEXIST") continue;
      throw error;
    }
  }
}

async function removeStaleManifestReservation(manifestPath, candidate, fileName) {
  if (await fsp.lstat(candidate).catch(() => null)) return false;
  const noFollow = Number(fsConstants.O_NOFOLLOW) || 0;
  let handle = null;
  try {
    handle = await fsp.open(manifestPath, fsConstants.O_RDONLY | noFollow);
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile() || Number(stat.size) <= 0 || Number(stat.size) > 65536) return false;
    const manifest = JSON.parse(await handle.readFile({ encoding: "utf8" }));
    if (
      !isPublishedArtifactManifest(manifest)
      || manifest.file !== fileName
      || publishedArtifactManifestName(fileName) !== path.basename(manifestPath)
      || await fsp.lstat(candidate).catch(() => null)
    ) return false;
    const identity = fileIdentity(stat);
    await handle.close();
    handle = null;
    return unlinkIfIdentity(manifestPath, identity);
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function writeJsonExclusive(destination, value) {
  const temporary = path.join(
    path.dirname(destination),
    `.manifest-${process.pid}-${crypto.randomBytes(12).toString("hex")}.tmp`
  );
  let handle = null;
  try {
    handle = await fsp.open(
      temporary,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
      0o600
    );
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fsp.link(temporary, destination);
  } finally {
    await handle?.close().catch(() => {});
    await fsp.unlink(temporary).catch(() => {});
  }
}

function fileIdentity(stat) {
  return {
    dev: `${stat.dev}`,
    ino: `${stat.ino}`,
    bytes: Number(stat.size)
  };
}

function matchesFileIdentity(stat, expected) {
  return Boolean(
    stat?.isFile?.()
    && !stat.isSymbolicLink?.()
    && `${stat.dev}` === `${expected?.dev || ""}`
    && `${stat.ino}` === `${expected?.ino || ""}`
    && Number(stat.size) === Number(expected?.bytes)
  );
}

async function unlinkIfIdentity(file, expected) {
  const stat = await fsp.lstat(file, { bigint: true }).catch(() => null);
  if (!matchesFileIdentity(stat, expected)) return false;
  await fsp.unlink(file);
  return true;
}

async function removeOwnedTransaction(transactionPath, transactionId) {
  const noFollow = Number(fsConstants.O_NOFOLLOW) || 0;
  let handle = null;
  try {
    handle = await fsp.open(transactionPath, fsConstants.O_RDONLY | noFollow);
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile() || Number(stat.size) <= 0 || Number(stat.size) > 65536) return false;
    const transaction = JSON.parse(await handle.readFile({ encoding: "utf8" }));
    if (
      !isPublishedArtifactTransaction(transaction)
      || transaction.transactionId !== transactionId
      || transaction.ownerId !== PUBLISHED_ARTIFACT_TRANSACTION_OWNER_ID
      || publishedArtifactTransactionName(transactionId) !== path.basename(transactionPath)
    ) return false;
    const identity = fileIdentity(stat);
    await handle.close();
    handle = null;
    return unlinkIfIdentity(transactionPath, identity);
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function syncDirectory(directory) {
  const handle = await fsp.open(directory, fsConstants.O_RDONLY).catch(() => null);
  if (!handle) return;
  try {
    await handle.sync().catch(() => {});
  } finally {
    await handle.close().catch(() => {});
  }
}

async function removeInternalCandidate(source, taskRoot) {
  const candidateRoot = await fsp.realpath(path.join(taskRoot, ".candidates")).catch(() => "");
  if (!candidateRoot || !isPathInside(candidateRoot, source)) return;
  await fsp.unlink(source).catch(() => {});
}

function markCandidatePublished(ctx, previousPath, absolute, inspectionId) {
  const candidates = candidateRegistry(ctx);
  const current = candidates.get(previousPath) || {};
  candidates.delete(previousPath);
  candidates.set(absolute, {
    ...current,
    absolute,
    status: "published",
    inspectionId,
    publishedAt: new Date().toISOString()
  });
}

module.exports = {
  publishArtifactTool,
  PUBLISH_ARTIFACT_TOOL_SCHEMA
};
