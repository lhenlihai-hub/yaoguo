// @ts-check

const crypto = require("node:crypto");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const {
  DEFAULT_AGENT_TYPE,
  normalizeAgentMemoryProfile
} = require("./agentMemoryProfile");

const execFileAsync = promisify(execFile);

async function resolveCanonicalMemoryRoot(workspaceRoot = "", options = {}) {
  const workspace = await requireRealDirectory(workspaceRoot, "memory workspace");
  const commonDirectory = await resolveGitCommonDirectory(workspace, options);
  if (!commonDirectory) return workspace;
  const candidate = path.basename(commonDirectory) === ".git"
    ? path.dirname(commonDirectory)
    : "";
  if (!candidate) return workspace;
  return requireRealDirectory(candidate, "canonical git root").catch(() => workspace);
}

async function resolveGitCommonDirectory(workspace, options = {}) {
  const run = options.execFileImpl || execFileAsync;
  const absolute = await runGit(run, workspace, [
    "rev-parse", "--path-format=absolute", "--git-common-dir"
  ]).catch(() => "");
  const fallback = absolute || await runGit(run, workspace, [
    "rev-parse", "--git-common-dir"
  ]).catch(() => "");
  if (!fallback) return "";
  const resolved = path.resolve(workspace, fallback);
  return fsp.realpath(resolved).catch(() => "");
}

async function runGit(run, cwd, args) {
  const result = await run("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 3000,
    maxBuffer: 64 * 1024
  });
  return `${typeof result === "string" ? result : result?.stdout || ""}`.trim();
}

function memoryDirectoryName(canonicalRoot = "") {
  const normalized = path.resolve(canonicalRoot).normalize("NFKC");
  const slug = normalized
    .replace(/^[\\/]+/, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase()
    .slice(0, 96) || "workspace";
  const digest = crypto.createHash("sha256").update(normalized, "utf8").digest("hex").slice(0, 12);
  return `${slug}-${digest}`;
}

async function resolveMemdirLocation({
  workspaceRoot = "",
  baseDirectory = "",
  homeDirectory = "",
  execFileImpl = null,
  agentType = DEFAULT_AGENT_TYPE,
  scope = "local",
  mode = "indexed"
} = {}) {
  const canonicalRoot = await resolveCanonicalMemoryRoot(workspaceRoot, { execFileImpl });
  const profile = normalizeAgentMemoryProfile({ agentType, scope, mode });
  const localBase = path.resolve(baseDirectory || path.join(homeDirectory || os.homedir(), ".yaoguo", "projects"));
  const identity = memoryDirectoryName(canonicalRoot);
  const resolved = resolveProfileDirectories({ canonicalRoot, localBase, identity, profile });
  return {
    canonicalRoot,
    baseDirectory: resolved.baseDirectory,
    identity,
    projectDirectory: resolved.projectDirectory,
    memoryDirectory: path.join(resolved.projectDirectory, "memory"),
    agentType: profile.agentType,
    scope: profile.scope,
    storageMode: profile.mode
  };
}

function resolveProfileDirectories({ canonicalRoot, localBase, identity, profile }) {
  if (profile.scope === "project") {
    const projectDirectory = path.join(canonicalRoot, ".yaoguo", "agents", profile.agentType);
    return { baseDirectory: canonicalRoot, projectDirectory };
  }
  if (profile.scope === "agent") {
    const baseDirectory = path.join(path.dirname(localBase), "agents");
    return {
      baseDirectory,
      projectDirectory: path.join(baseDirectory, profile.agentType)
    };
  }
  const legacyDefault = profile.agentType === DEFAULT_AGENT_TYPE;
  return {
    baseDirectory: localBase,
    projectDirectory: legacyDefault
      ? path.join(localBase, identity)
      : path.join(localBase, identity, "agents", profile.agentType)
  };
}

async function requireRealDirectory(value = "", label = "directory") {
  const absolute = path.resolve(`${value || ""}`);
  const stat = await fsp.stat(absolute).catch(() => null);
  if (!stat?.isDirectory()) throw new Error(`${label} 不是有效目录`);
  return fsp.realpath(absolute);
}

module.exports = {
  resolveCanonicalMemoryRoot,
  resolveGitCommonDirectory,
  memoryDirectoryName,
  resolveMemdirLocation,
  resolveProfileDirectories
};
