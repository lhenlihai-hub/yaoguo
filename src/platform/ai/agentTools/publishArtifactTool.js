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
      "发布是候选文件成为用户可见成品的唯一出口；生成工具成功只代表候选文件存在。",
      "用户明确指定输出目录或文件时，使用 destination；宿主只允许写入本轮从用户原话确认的目标。",
      "源码、构建脚本、草稿、缓存和临时预览不要发布，除非它们就是用户要求的交付物。"
    ].join(""),
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          minLength: 1,
          description: "最终文件路径。相对路径优先按宿主管理的内部制作区解析，也可使用当前任务或工作空间内的绝对路径。"
        },
        inspectionId: {
          type: "string",
          pattern: "^inspection_[a-f0-9]{24}$",
          description: "最近一次 inspect_artifact 返回的 inspectionId。文件修改后必须重新检查。"
        },
        title: {
          type: "string",
          maxLength: 120,
          description: "可选。用户可见的成品标题；不填使用文件名。"
        },
        destination: {
          type: "string",
          minLength: 1,
          description: "可选。用户明确指定的绝对输出目录或完整文件路径。只有本轮已确认的目标可用。"
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
    const internalCandidate = await isInternalCandidate(canonical, ctx.taskDir);
    const defaultDestination = internalCandidate
      ? ctx.defaultArtifactDestination
      : "";
    const deliveryPlan = await resolveExplicitDelivery(
      args.destination,
      ctx.explicitOutputTargets,
      defaultDestination
    );
    await assertExplicitDeliveryAllowed(deliveryPlan, ctx.explicitOutputDenyRoots);
    const title = `${args.title || ""}`.trim() || path.basename(canonical);
    const { absolute: managedAbsolute, sha256 } = await snapshotInspectedArtifact({
      source: canonical,
      taskDir: ctx.taskDir,
      expectedSha256: inspection.sha256,
      inspectionId,
      inspectedAt: inspection.inspectedAt,
      title,
      removeSource: !deliveryPlan
    });
    const absolute = deliveryPlan
      ? await copyPublishedArtifact(managedAbsolute, deliveryPlan, path.basename(canonical))
      : managedAbsolute;
    if (deliveryPlan) await removeInternalCandidate(canonical, await fsp.realpath(ctx.taskDir));
    if (inspection.snapshot) await fsp.unlink(inspection.snapshot).catch(() => {});
    markCandidatePublished(ctx, canonical, managedAbsolute, inspectionId);
    const publishedStat = await fsp.stat(absolute);
    return {
      absolute,
      managedAbsolute,
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

async function resolveExplicitDelivery(
  requestedDestination = "",
  rawTargets = [],
  defaultDestination = ""
) {
  const targets = [];
  for (const item of Array.isArray(rawTargets) ? rawTargets : []) {
    const raw = `${item?.path || ""}`.trim();
    if (!raw || !path.isAbsolute(raw) || path.resolve(raw) === path.parse(path.resolve(raw)).root) continue;
    if (item?.kind === "file") {
      const parent = await fsp.realpath(path.dirname(path.resolve(raw))).catch(() => "");
      if (parent) targets.push({ kind: "file", path: path.join(parent, path.basename(raw)) });
      continue;
    }
    const directory = await fsp.realpath(path.resolve(raw)).catch(() => "");
    const stat = directory ? await fsp.stat(directory).catch(() => null) : null;
    if (stat?.isDirectory()) targets.push({ kind: "directory", path: directory });
  }
  if (!targets.length) {
    if (`${requestedDestination || ""}`.trim()) {
      throw new Error("destination 不是用户在本轮明确指定的输出位置。");
    }
    const requestedDefault = `${defaultDestination || ""}`.trim();
    const directory = requestedDefault
      ? await fsp.realpath(path.resolve(requestedDefault)).catch(() => "")
      : "";
    const stat = directory ? await fsp.stat(directory).catch(() => null) : null;
    if (stat?.isDirectory()) return { kind: "directory", path: directory };
    return null;
  }
  const requested = `${requestedDestination || ""}`.trim();
  if (!requested) {
    if (targets.length === 1) return targets[0];
    throw new Error("用户指定了多个输出位置，请通过 destination 明确选择一个。");
  }
  if (!path.isAbsolute(requested)) throw new Error("destination 必须是绝对路径。");
  const resolved = path.resolve(requested);
  for (const target of targets) {
    if (target.kind === "file" && resolved === target.path) return target;
    if (target.kind !== "directory") continue;
    if (resolved === target.path) return target;
    const parent = await fsp.realpath(path.dirname(resolved)).catch(() => "");
    if (parent && (parent === target.path || isPathInside(target.path, parent))) {
      return { kind: "file", path: path.join(parent, path.basename(resolved)) };
    }
  }
  throw new Error("destination 超出用户在本轮明确指定的输出位置。");
}

async function isInternalCandidate(absolute, taskDir = "") {
  const requestedTaskDir = `${taskDir || ""}`.trim();
  if (!requestedTaskDir) return false;
  const taskRoot = await fsp.realpath(requestedTaskDir).catch(() => "");
  const candidateRoot = taskRoot
    ? await fsp.realpath(path.join(taskRoot, ".candidates")).catch(() => "")
    : "";
  return Boolean(candidateRoot && isPathInside(candidateRoot, absolute));
}

async function copyPublishedArtifact(source, plan, originalFileName = path.basename(source)) {
  const requested = plan.kind === "directory"
    ? path.join(plan.path, originalFileName)
    : plan.path;
  const extension = path.extname(requested);
  const base = path.basename(requested, extension);
  const directory = path.dirname(requested);
  for (let version = 1; ; version += 1) {
    const fileName = version === 1 ? path.basename(requested) : `${base}-v${version}${extension}`;
    const destination = path.join(directory, fileName);
    try {
      await fsp.copyFile(source, destination, fsConstants.COPYFILE_EXCL);
      return await fsp.realpath(destination);
    } catch (error) {
      if (error?.code === "EEXIST") continue;
      throw new Error(`无法把成品写入用户指定位置：${destination}`, { cause: error });
    }
  }
}

async function assertExplicitDeliveryAllowed(plan, rawDenyRoots = []) {
  if (!plan) return;
  const destination = path.resolve(plan.path);
  const segments = destination.split(path.sep).filter(Boolean);
  if (segments.some((segment) => [".git", ".agents", ".codex"].includes(segment))) {
    throw new Error("用户指定的输出位置属于宿主控制目录，不能写入。");
  }
  for (const rawRoot of Array.isArray(rawDenyRoots) ? rawDenyRoots : []) {
    const root = await fsp.realpath(path.resolve(`${rawRoot || ""}`)).catch(() => "");
    if (root && (destination === root || isPathInside(root, destination))) {
      throw new Error("用户指定的输出位置属于腰果运行数据，不能写入。");
    }
  }
}

async function snapshotInspectedArtifact({
  source, taskDir, expectedSha256, inspectionId, inspectedAt, title, removeSource = true
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
    if (removeSource) await removeInternalCandidate(source, taskRoot);
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
