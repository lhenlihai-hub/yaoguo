// @ts-check

const path = require("node:path");
const fsp = require("node:fs/promises");

/**
 * 判断 candidate 是否位于 root 内（root 本身也视为命中）。
 * 只做词法边界判断；涉及符号链接时，调用方仍需先解析 realpath。
 *
 * @param {string} root
 * @param {string} candidate
 */
function isPathInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (
    relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function assertSafePathSegment(value, label = "标识符") {
  const segment = `${value || ""}`.trim();
  if (!segment || segment.length > 160 || segment === "." || segment === ".." || /[\\/\0]/.test(segment)) {
    const error = /** @type {Error & {code?: string}} */ (new Error(`${label} 不合法。`));
    error.code = "PATH_SEGMENT_INVALID";
    throw error;
  }
  return segment;
}

function resolvePathInside(root, relativePath, label = "路径") {
  const relative = `${relativePath || ""}`;
  if (!relative || path.isAbsolute(relative)) {
    const error = /** @type {Error & {code?: string}} */ (new Error(`${label} 必须是作用域内的相对路径。`));
    error.code = "PATH_OUTSIDE_SCOPE";
    throw error;
  }
  const candidate = path.resolve(root, relative);
  if (!isPathInside(root, candidate) || candidate === path.resolve(root)) {
    const error = /** @type {Error & {code?: string}} */ (new Error(`${label} 超出允许的作用域。`));
    error.code = "PATH_OUTSIDE_SCOPE";
    throw error;
  }
  return candidate;
}

async function resolveExistingPathInside(root, candidate, label = "路径") {
  let realRoot;
  let realCandidate;
  try {
    [realRoot, realCandidate] = await Promise.all([fsp.realpath(root), fsp.realpath(candidate)]);
  } catch (cause) {
    const error = /** @type {Error & {code?: string, cause?: unknown}} */ (new Error(`${label} 无法解析真实路径。`));
    error.code = "PATH_REALPATH_FAILED";
    error.cause = cause;
    throw error;
  }
  if (!isPathInside(realRoot, realCandidate) || realCandidate === realRoot) {
    const error = /** @type {Error & {code?: string}} */ (new Error(`${label} 通过符号链接超出允许的作用域。`));
    error.code = "PATH_OUTSIDE_SCOPE";
    throw error;
  }
  return realCandidate;
}

module.exports = { isPathInside, assertSafePathSegment, resolvePathInside, resolveExistingPathInside };
