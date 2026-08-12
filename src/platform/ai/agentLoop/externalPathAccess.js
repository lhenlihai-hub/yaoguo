// @ts-check

const path = require("node:path");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const { isPathInside } = require("../../shared/pathSafety");

const HOST_CONTROL_DIRECTORY_NAMES = new Set([".git", ".agents", ".codex"]);

/**
 * Resolve path-bearing tool input before host authorization. Paths already inside
 * the task scopes keep their existing policy. A path outside those scopes becomes
 * one exact, canonical capability that the runtime may mount only after approval.
 *
 * @param {string} name
 * @param {any} args
 * @param {any} ctx
 */
async function resolveRequestedPathAccess(name, args = {}, ctx = {}) {
  if (["read", "write", "edit"].includes(name)) {
    return resolveFileToolAccess(name, args, ctx);
  }
  if (name === "bash") return resolveBashAccess(args, ctx);
  if (name === "open_local_path") return resolveOpenAccess(args, ctx);
  return { args, grant: null };
}

async function resolveFileToolAccess(name, args, ctx) {
  const workDir = toolWorkDir(args, ctx);
  const requested = `${args?.path || ""}`.trim();
  if (!requested || !workDir) return { args, grant: null };
  const target = path.resolve(workDir, requested);
  const write = name !== "read";
  const roots = scopeRoots(ctx, write ? "write" : "read");
  if (isInsideAny(roots, target)) {
    assertScopedPathAllowed(target, ctx, write ? "write" : "read");
    return { args: { ...args, path: target }, grant: null };
  }

  const inspected = await inspectTarget(target, { allowMissing: name === "write" });
  if (isInsideAny(roots, inspected.path)) {
    assertScopedPathAllowed(inspected.path, ctx, write ? "write" : "read");
    return { args: { ...args, path: inspected.path }, grant: null };
  }
  assertExternalPathAllowed(inspected.path, ctx, write ? "write" : "read");
  if (write && inspected.kind !== "file") {
    throw new Error(`${name} 的工作空间外目标必须是普通文件。`);
  }
  return {
    args: { ...args, path: inspected.path },
    grant: {
      path: inspected.path,
      anchor: inspected.anchor,
      kind: inspected.kind,
      read: !write,
      write,
      shell: false,
      external: true
    }
  };
}

async function resolveBashAccess(args, ctx) {
  const requested = `${args?.cwd || ""}`.trim();
  if (!requested) return { args, grant: null };
  const workDir = toolWorkDir(args, ctx);
  if (!workDir) return { args, grant: null };
  const target = path.resolve(workDir, requested);
  const inspected = await inspectTarget(target);
  if (inspected.kind !== "directory") {
    throw new Error("bash cwd 必须是已存在的普通文件夹。");
  }
  const normalizedArgs = { ...args, cwd: inspected.path };
  if (isInsideAny(scopeRoots(ctx, "write"), inspected.path)) {
    return { args: normalizedArgs, grant: null };
  }
  assertExternalPathAllowed(inspected.path, ctx, "read");
  assertExternalPathAllowed(inspected.path, ctx, "write");
  return {
    args: normalizedArgs,
    grant: {
      path: inspected.path,
      kind: "directory",
      read: true,
      write: true,
      shell: true,
      external: true
    }
  };
}

async function resolveOpenAccess(args, ctx) {
  const workDir = `${ctx.agentWorkDir || ctx.workspacePath || ""}`.trim();
  const requested = `${args?.path || ""}`.trim();
  if (!requested || !workDir) return { args, grant: null };
  const inspected = await inspectTarget(path.resolve(workDir, requested));
  const normalizedArgs = { ...args, path: inspected.path };
  const roots = Array.isArray(ctx.agentOpenScopeAllow) ? ctx.agentOpenScopeAllow : [workDir];
  const exact = Array.isArray(ctx.agentOpenExactAllow) ? ctx.agentOpenExactAllow : [];
  if (isInsideAny(roots, inspected.path) || exact.some((item) => samePath(item, inspected.path))) {
    return { args: normalizedArgs, grant: null };
  }
  assertExternalPathAllowed(inspected.path, ctx, "open");
  return {
    args: normalizedArgs,
    grant: {
      path: inspected.path,
      kind: inspected.kind,
      read: false,
      write: false,
      shell: false,
      open: true,
      external: true
    }
  };
}

function toolWorkDir(args, ctx) {
  if (`${args?.workspace || "project"}` === "artifact") {
    return `${ctx.artifactWorkDir || ""}`.trim();
  }
  return `${ctx.agentWorkDir || ctx.workspacePath || ctx.taskDir || process.cwd()}`.trim();
}

function scopeRoots(ctx, access) {
  if (access === "write") {
    return Array.isArray(ctx.agentWriteScopeAllow)
      ? ctx.agentWriteScopeAllow
      : (ctx.agentScopeAllow || []);
  }
  return Array.isArray(ctx.agentReadScopeAllow)
    ? ctx.agentReadScopeAllow
    : (ctx.agentScopeAllow || []);
}

async function inspectTarget(target, { allowMissing = false } = {}) {
  const absolute = path.resolve(target);
  let canonical;
  try {
    canonical = await fsp.realpath(absolute);
  } catch (error) {
    if (!allowMissing || error?.code !== "ENOENT") {
      throw new Error(`工作空间外路径不存在或无法访问：${absolute}`);
    }
    const parent = await closestExistingParent(path.dirname(absolute));
    const canonicalParent = await fsp.realpath(parent);
    canonical = path.resolve(canonicalParent, path.relative(parent, absolute));
    return { path: canonical, kind: "file", exists: false, anchor: canonicalParent };
  }
  const stat = await fsp.stat(canonical);
  const kind = stat.isDirectory() ? "directory" : (stat.isFile() ? "file" : "");
  if (!kind) throw new Error(`只能授权普通文件或文件夹：${canonical}`);
  return {
    path: canonical,
    kind,
    exists: true,
    anchor: kind === "file" ? path.dirname(canonical) : canonical
  };
}

async function closestExistingParent(start) {
  let current = path.resolve(start);
  while (true) {
    try {
      const stat = await fsp.stat(current);
      if (!stat.isDirectory()) throw new Error(`路径父级不是文件夹：${current}`);
      return current;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) throw new Error(`无法解析路径父级：${start}`);
    current = parent;
  }
}

function assertExternalPathAllowed(target, ctx, access) {
  if (isFileSystemRoot(target)) throw new Error("不能把整个文件系统根目录授权给 Agent。");
  assertScopedPathAllowed(target, ctx, access);
}

function assertScopedPathAllowed(target, ctx, access) {
  const denied = access === "write"
    ? (ctx.agentWriteScopeDeny || [])
    : (access === "open" ? (ctx.agentOpenScopeDeny || []) : (ctx.agentReadScopeDeny || []));
  if (isInsideAny(denied, target)) {
    throw new Error(`Agent 不可${access === "write" ? "修改" : "访问"}宿主控制目录：${target}`);
  }
  if (access === "write" && hasHostControlSegment(target)) {
    throw new Error(`Agent 不可修改宿主控制目录：${target}`);
  }
}

function policyWithPathGrant(policy, name, grant) {
  if (!grant?.external) return policy;
  if (name === "read") {
    return {
      ...policy,
      namespace: "filesystem_external_read",
      effect: "filesystem_read_external",
      effects: ["filesystem_read_external"],
      repeat: "reuse",
      requiresUserConfirm: true
    };
  }
  if (["write", "edit"].includes(name)) {
    return {
      ...policy,
      effect: "filesystem_write_external",
      effects: ["filesystem_write_external"],
      requiresUserConfirm: true
    };
  }
  return { ...policy, requiresUserConfirm: true };
}

function isInsideAny(roots, target) {
  return (Array.isArray(roots) ? roots : [])
    .map((root) => `${root || ""}`.trim())
    .filter(Boolean)
    .some((root) => {
      const canonical = canonicalExistingPath(root);
      return canonical ? isPathInside(canonical, target) : false;
    });
}

function samePath(left, right) {
  return path.resolve(`${left || ""}`) === path.resolve(`${right || ""}`);
}

function hasHostControlSegment(target) {
  return path.resolve(target).split(path.sep)
    .some((segment) => HOST_CONTROL_DIRECTORY_NAMES.has(segment));
}

function isFileSystemRoot(target) {
  const absolute = path.resolve(target);
  return absolute === path.parse(absolute).root;
}

function canonicalExistingPath(value) {
  const resolved = path.resolve(`${value || ""}`);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

module.exports = {
  policyWithPathGrant,
  resolveRequestedPathAccess
};
