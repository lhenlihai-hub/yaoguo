// @ts-check

const path = require("node:path");
const fsp = require("node:fs/promises");

const WORKSPACE_IDENTITY_VERSION = 1;

/**
 * @param {string} message
 * @param {string} code
 * @param {unknown} [cause]
 */
function workspaceIdentityError(message, code, cause) {
  const error = /** @type {Error & {code?: string, cause?: unknown}} */ (new Error(message));
  error.code = code;
  if (cause !== undefined) error.cause = cause;
  return error;
}

/** @param {unknown} value */
function hasWorkspaceIdentity(value) {
  return value !== undefined && value !== null;
}

/**
 * Capture the stable identity of a user-selected workspace root.
 * The selected directory itself may not be a symlink. Ancestor aliases are
 * canonicalized once and only the canonical path is persisted.
 *
 * @param {string} input
 */
async function captureWorkspaceIdentity(input) {
  const raw = `${input || ""}`.trim();
  if (!raw) {
    throw workspaceIdentityError("工作空间路径不能为空。", "WORKSPACE_PATH_REQUIRED");
  }
  const requestedPath = path.resolve(raw);
  let firstStat;
  try {
    firstStat = await fsp.lstat(requestedPath);
  } catch (cause) {
    throw workspaceIdentityError(
      `无法访问工作空间：${requestedPath}`,
      "WORKSPACE_UNAVAILABLE",
      cause
    );
  }
  if (firstStat.isSymbolicLink()) {
    throw workspaceIdentityError(
      "工作空间根目录不能是符号链接，请直接选择真实目录。",
      "WORKSPACE_ROOT_SYMLINK"
    );
  }
  if (!firstStat.isDirectory()) {
    throw workspaceIdentityError("工作空间必须是文件夹。", "WORKSPACE_NOT_DIRECTORY");
  }

  let canonicalPath;
  try {
    canonicalPath = await fsp.realpath(requestedPath);
    const confirmedStat = await fsp.lstat(requestedPath);
    const confirmedPath = await fsp.realpath(requestedPath);
    if (confirmedStat.isSymbolicLink()) {
      throw workspaceIdentityError(
        "工作空间根目录不能是符号链接，请直接选择真实目录。",
        "WORKSPACE_ROOT_SYMLINK"
      );
    }
    if (!confirmedStat.isDirectory() || confirmedPath !== canonicalPath) {
      throw workspaceIdentityError(
        "工作空间在绑定期间发生了变化，请重新选择。",
        "WORKSPACE_CHANGED_DURING_BIND"
      );
    }
    const identityStat = await fsp.stat(canonicalPath, { bigint: true });
    if (!identityStat.isDirectory()) {
      throw workspaceIdentityError("工作空间必须是文件夹。", "WORKSPACE_NOT_DIRECTORY");
    }
    return Object.freeze({
      version: WORKSPACE_IDENTITY_VERSION,
      canonicalPath,
      dev: `${identityStat.dev}`,
      ino: `${identityStat.ino}`
    });
  } catch (error) {
    if (error?.code?.startsWith?.("WORKSPACE_")) throw error;
    throw workspaceIdentityError(
      `无法确认工作空间身份：${canonicalPath || requestedPath}`,
      "WORKSPACE_IDENTITY_UNAVAILABLE",
      error
    );
  }
}

/**
 * @param {unknown} value
 */
function normalizeWorkspaceIdentity(value) {
  if (!hasWorkspaceIdentity(value) || typeof value !== "object" || Array.isArray(value)) {
    throw workspaceIdentityError(
      "工作空间身份记录已损坏，请清除后重新选择。",
      "WORKSPACE_IDENTITY_INVALID"
    );
  }
  const record = /** @type {Record<string, unknown>} */ (value);
  const canonicalPath = `${record.canonicalPath || ""}`.trim();
  const dev = `${record.dev ?? ""}`.trim();
  const ino = `${record.ino ?? ""}`.trim();
  if (!canonicalPath || !path.isAbsolute(canonicalPath) || !dev || !ino) {
    throw workspaceIdentityError(
      "工作空间身份记录已损坏，请清除后重新选择。",
      "WORKSPACE_IDENTITY_INVALID"
    );
  }
  return {
    version: WORKSPACE_IDENTITY_VERSION,
    canonicalPath: path.resolve(canonicalPath),
    dev,
    ino
  };
}

/**
 * Verify that a persisted capability still names the same directory object.
 * Passing no expected identity is the one-time legacy migration path.
 *
 * @param {string} workspacePath
 * @param {unknown} expected
 */
async function verifyWorkspaceIdentity(workspacePath, expected) {
  const observed = await captureWorkspaceIdentity(workspacePath);
  if (!hasWorkspaceIdentity(expected)) return observed;
  const persisted = normalizeWorkspaceIdentity(expected);
  if (
    persisted.canonicalPath !== observed.canonicalPath
    || persisted.dev !== observed.dev
    || persisted.ino !== observed.ino
  ) {
    throw workspaceIdentityError(
      "工作空间身份已变化，请清除后重新选择；Agent 未获得新目录权限。",
      "WORKSPACE_IDENTITY_MISMATCH"
    );
  }
  return observed;
}

module.exports = {
  WORKSPACE_IDENTITY_VERSION,
  captureWorkspaceIdentity,
  hasWorkspaceIdentity,
  normalizeWorkspaceIdentity,
  verifyWorkspaceIdentity
};
