// @ts-check

const os = require("node:os");
const path = require("node:path");
const { isPathInside } = require("../../shared/pathSafety");

function resolveManagedInstructionRoot(platform = process.platform, options = {}) {
  if (platform === "darwin") {
    return "/Library/Application Support/Yaoguo/instructions";
  }
  if (platform === "win32") {
    const programData = `${options.programData || process.env.ProgramData || process.env.PROGRAMDATA || "C:\\ProgramData"}`;
    return path.join(programData, "Yaoguo", "instructions");
  }
  return "/etc/yaoguo/instructions";
}

function resolveUserInstructionRoot(homeDirectory = os.homedir()) {
  return path.join(path.resolve(homeDirectory), ".yaoguo");
}

function directoryChain(scopeRoot = "", cwd = "") {
  const root = path.resolve(scopeRoot);
  let cursor = path.resolve(cwd);
  if (!isPathInside(root, cursor)) {
    throw new Error("指令记忆 cwd 超出 scopeRoot");
  }
  const collected = [];
  while (true) {
    collected.push(cursor);
    if (cursor === root) break;
    const parent = path.dirname(cursor);
    if (parent === cursor) throw new Error("指令记忆目录链未到达 scopeRoot");
    cursor = parent;
  }
  return collected.reverse();
}

function relativeDepth(scopeRoot = "", owner = "") {
  const relative = path.relative(path.resolve(scopeRoot), path.resolve(owner));
  return relative ? relative.split(path.sep).filter(Boolean).length : 0;
}

function toPosixPath(value = "") {
  return `${value || ""}`.split(path.sep).join("/");
}

module.exports = {
  resolveManagedInstructionRoot,
  resolveUserInstructionRoot,
  directoryChain,
  relativeDepth,
  toPosixPath
};
