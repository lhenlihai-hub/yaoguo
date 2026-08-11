// @ts-check

const path = require("node:path");
const net = require("node:net");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const { isBlockedIp } = require("../../shared/urlSafety");
const { loadAgentCore } = require("./coreDependency");
const { createShellSandbox, systemCommandPath } = require("./shellSandbox");

const BASE_TOOL_NAMES = Object.freeze(["read", "write", "edit", "bash"]);
const HOST_CONTROL_DIRECTORY_NAMES = new Set([".git", ".agents", ".codex"]);

const BASE_TOOL_POLICIES = Object.freeze({
  read: basePolicy("filesystem", "read", true, "reuse", null),
  write: basePolicy("filesystem", "workspace_write", false, "rerun", null),
  edit: basePolicy("filesystem", "workspace_write", false, "rerun", null),
  bash: basePolicy("shell", "command_execute", false, "rerun", null)
});

function basePolicy(namespace, effect, parallelSafe, repeat, maxCallsPerLoop) {
  return Object.freeze({
    namespace,
    effect,
    parallelSafe,
    repeat,
    maxCallsPerLoop
  });
}

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

class ScopedNodeExecutionEnv {
  /**
   * @param {any} base
   * @param {{
   *   cwd:string,
   *   roots?:string[],
   *   readRoots?:string[],
   *   writeRoots?:string[],
   *   deniedReadRoots?:string[],
   *   protectedWriteRoots?:string[],
   *   shellSandbox?:any,
   *   openExternal?:(url:string, options?:any) => Promise<any>
   * }} options
   */
  constructor(base, options) {
    this.base = base;
    this.cwd = canonicalExistingPath(options.cwd);
    const legacyRoots = Array.isArray(options.roots) ? options.roots : [];
    this.readRoots = [...new Set(
      (Array.isArray(options.readRoots) ? options.readRoots : legacyRoots)
        .map(canonicalExistingPath)
    )];
    this.writeRoots = [...new Set(
      (Array.isArray(options.writeRoots) ? options.writeRoots : legacyRoots)
        .map(canonicalExistingPath)
    )];
    this.roots = this.readRoots;
    this.deniedReadRoots = uniqueResolvedPaths(options.deniedReadRoots || []);
    this.protectedWriteRoots = [...new Set(
      (Array.isArray(options.protectedWriteRoots) ? options.protectedWriteRoots : [])
        .map(canonicalExistingPath)
    )];
    this.shellSandbox = options.shellSandbox || null;
    this.openExternal = typeof options.openExternal === "function" ? options.openExternal : null;
  }

  async guardPath(input, allowMissing = false, access = "read") {
    const roots = access === "write" ? this.writeRoots : this.readRoots;
    const absolute = path.resolve(this.cwd, `${input || ""}`);
    if (access === "read" && this.isDeniedReadPath(absolute)) {
      throw new Error(`Agent 不可读取宿主控制目录：${input}`);
    }
    if (access === "write" && this.isProtectedWritePath(absolute)) {
      throw new Error(`Agent 不可修改宿主控制目录：${input}`);
    }
    if (access === "write") await this.assertUnlinkedWritePath(absolute, input);
    let canonical = absolute;
    try {
      canonical = await fsp.realpath(absolute);
    } catch (error) {
      if (!allowMissing || error?.code !== "ENOENT") throw error;
      const parent = await this.closestExistingParent(path.dirname(absolute));
      const canonicalParent = await fsp.realpath(parent);
      if (!roots.some((root) => isWithin(root, canonicalParent))) {
        throw new Error(`路径经符号链接越出 Agent 工作区：${input}`);
      }
      if (access === "read" && this.isDeniedReadPath(canonicalParent)) {
        throw new Error(`Agent 不可读取宿主控制目录：${input}`);
      }
      if (access === "write" && this.isProtectedWritePath(canonicalParent)) {
        throw new Error(`Agent 不可修改宿主控制目录：${input}`);
      }
      return path.resolve(canonicalParent, path.relative(parent, absolute));
    }
    if (!roots.some((root) => isWithin(root, canonical))) {
      throw new Error(`路径经符号链接越出 Agent 工作区：${input}`);
    }
    if (access === "read" && this.isDeniedReadPath(canonical)) {
      throw new Error(`Agent 不可读取宿主控制目录：${input}`);
    }
    if (access === "write" && this.isProtectedWritePath(canonical)) {
      throw new Error(`Agent 不可修改宿主控制目录：${input}`);
    }
    if (access === "write") {
      const stat = await fsp.stat(canonical);
      if (stat.isFile() && stat.nlink > 1) {
        throw new Error(`Agent 不可修改具有多个硬链接的文件：${input}`);
      }
    }
    // 后续 I/O 使用已经校验过的 canonical path，避免再次沿原始符号链接解析。
    return canonical;
  }

  async assertUnlinkedWritePath(absolute, input) {
    const root = this.writeRoots.find((candidate) => isWithin(candidate, absolute));
    if (!root) return;
    let current = root;
    for (const segment of path.relative(root, absolute).split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      let stat;
      try { stat = await fsp.lstat(current); } catch (error) {
        if (error?.code === "ENOENT") return;
        throw error;
      }
      if (stat.isSymbolicLink()) {
        throw new Error(`Agent 不可通过符号链接修改文件：${input}`);
      }
    }
  }

  isProtectedWritePath(target) {
    if (this.protectedWriteRoots.some((root) => isWithin(root, target))) return true;
    return this.writeRoots.some((root) => {
      if (!isWithin(root, target)) return false;
      const relative = path.relative(root, target);
      return relative.split(path.sep).some((segment) => HOST_CONTROL_DIRECTORY_NAMES.has(segment));
    });
  }

  isDeniedReadPath(target) {
    return this.deniedReadRoots.some((root) => isWithin(root, target));
  }

  async closestExistingParent(start) {
    let current = start;
    while (true) {
      try {
        await fsp.access(current);
        return current;
      } catch {}
      const parent = path.dirname(current);
      if (parent === current) throw new Error(`无法解析工作区路径：${start}`);
      current = parent;
    }
  }

  async absolutePath(input) {
    try {
      return { ok: true, value: await this.guardPath(input, true) };
    } catch (error) {
      return { ok: false, error };
    }
  }

  async readTextFile(input, signal) {
    return this.base.readTextFile(await this.guardPath(input), signal);
  }

  async readTextLines(input, options) {
    return this.base.readTextLines(await this.guardPath(input), options);
  }

  async readBinaryFile(input, signal) {
    return this.base.readBinaryFile(await this.guardPath(input), signal);
  }

  async writeFile(input, content, signal) {
    return this.base.writeFile(await this.guardPath(input, true, "write"), content, signal);
  }

  async appendFile(input, content) {
    return this.base.appendFile(await this.guardPath(input, true, "write"), content);
  }

  async fileInfo(input, signal) {
    return this.base.fileInfo(await this.guardPath(input), signal);
  }

  async listDir(input, signal) {
    return this.base.listDir(await this.guardPath(input), signal);
  }

  async canonicalPath(input) {
    try {
      return await this.base.canonicalPath(await this.guardPath(input, true));
    } catch (error) {
      return { ok: false, error };
    }
  }

  async exists(input, signal) {
    try {
      return await this.base.exists(await this.guardPath(input, true), signal);
    } catch (error) {
      return { ok: false, error };
    }
  }

  async createDir(input, options) {
    return this.base.createDir(await this.guardPath(input, true, "write"), options);
  }

  async remove(input, options) {
    return this.base.remove(await this.guardPath(input, false, "write"), options);
  }

  async exec(command, options = {}) {
    const externalUrl = parseExternalOpenCommand(command);
    assertScopedShellCommand(command, { allowExternalOpen: Boolean(externalUrl && this.openExternal) });
    if (externalUrl) {
      if (!this.openExternal) throw new Error("宿主未提供网页打开能力。");
      const signal = options.abortSignal || options.signal || null;
      if (signal?.aborted) throw new Error("网页打开操作已取消。");
      const result = await this.openExternal(externalUrl, { signal });
      if (result === false || result?.allow === false || result?.ok === false) {
        throw new Error(result?.error || result?.reason || "宿主拒绝打开该网页。");
      }
      return { ok: true, value: { stdout: `Opened ${externalUrl}`, stderr: "", exitCode: 0 } };
    }
    const cwd = await this.guardPath(options.cwd || this.cwd, false, "write");
    if (!this.shellSandbox) throw new Error("系统命令沙箱不可用，bash 工具已停用。");
    try {
      if (typeof this.shellSandbox.execute === "function") {
        return await this.shellSandbox.execute(this.base, command, { ...options, cwd });
      }
      const sandboxedCommand = await this.shellSandbox.wrap(
        command,
        options.abortSignal || options.signal
      );
      return await this.base.exec(sandboxedCommand, { ...options, cwd });
    } finally {
      this.shellSandbox.cleanupAfterCommand();
    }
  }

  joinPath(parts) {
    return this.base.joinPath(parts);
  }

  createTempDir(prefix) {
    return this.base.createTempDir(prefix);
  }

  createTempFile(options) {
    return this.base.createTempFile(options);
  }

  cleanup() {
    return this.base.cleanup();
  }
}

function assertScopedShellCommand(command = "", options = {}) {
  const source = `${command || ""}`.trim();
  if (!source) throw new Error("bash command 不能为空。");
  const externalUrl = parseExternalOpenCommand(source);
  if (externalUrl && options.allowExternalOpen === true) return;
  /** @type {Array<[RegExp, string]>} */
  const rules = [
    [/\0/, "命令包含空字节"],
    [commandTokenPattern("(?:sudo|su|doas)"), "不允许提权命令"],
    [commandTokenPattern("(?:mkfs|diskutil|shutdown|reboot|halt)"), "不允许宿主级系统命令"],
    [commandTokenPattern("(?:open|osascript|xdg-open)"), "不允许命令绕过宿主打开外部应用"],
    [/\bgio\s+open(?:\s|$)/i, "不允许命令绕过宿主打开外部应用"]
  ];
  const blocked = rules.find(([pattern]) => pattern.test(source));
  if (blocked) throw new Error(`bash 被工作区安全规则拒绝：${blocked[1]}。`);
}

function parseExternalOpenCommand(command = "") {
  const source = `${command || ""}`.replace(/\r\n?/g, "\n").trim();
  if (!source) return null;
  const match = source.match(/^(?:open|\/usr\/bin\/open)\s+(?:"([^"]+)"|'([^']+)'|(\S+))$/);
  const raw = `${match?.[1] || match?.[2] || match?.[3] || ""}`.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    if (url.username || url.password || isPrivateOpenHostname(url.hostname)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function commandTokenPattern(names) {
  return new RegExp(`(?:^|[\\s;&|()\\\"'\\x60])/?(?:[a-z0-9_.-]+/)*${names}(?=$|[\\s;&|()\\\"'\\x60])`, "i");
}

function isPrivateOpenHostname(hostname = "") {
  const host = `${hostname || ""}`.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (host.endsWith(".internal")) return true;
  return Boolean(net.isIP(host) && isBlockedIp(host));
}

async function createScopedTools(options = {}) {
  const requestedCwd = `${options.cwd || ""}`.trim();
  const requestedRoots = (Array.isArray(options.roots) ? options.roots : [requestedCwd]).filter(Boolean);
  const requestedReadRoots = (
    Array.isArray(options.readRoots) ? options.readRoots : requestedRoots
  ).filter(Boolean);
  const requestedWriteRoots = (
    Array.isArray(options.writeRoots) ? options.writeRoots : requestedRoots
  ).filter(Boolean);
  const requestedShellReadRoots = (
    Array.isArray(options.shellReadRoots) ? options.shellReadRoots : []
  ).filter(Boolean);
  const requestedDeniedReadRoots = (
    Array.isArray(options.deniedReadRoots) ? options.deniedReadRoots : []
  ).filter(Boolean);
  const requestedToolNames = Array.isArray(options.toolNames)
    ? options.toolNames.map((name) => `${name || ""}`).filter((name) => BASE_TOOL_NAMES.includes(name))
    : [...BASE_TOOL_NAMES];
  if (!requestedCwd || !requestedReadRoots.length || !requestedWriteRoots.length) return [];
  const cwd = await fsp.realpath(path.resolve(requestedCwd));
  const [readRoots, writeRoots, explicitShellReadRoots] = await Promise.all([
    resolveExistingRoots(requestedReadRoots),
    resolveExistingRoots(requestedWriteRoots),
    resolveExistingRoots(requestedShellReadRoots)
  ]);
  if (!readRoots.includes(cwd)) readRoots.unshift(cwd);
  if (!writeRoots.includes(cwd)) writeRoots.unshift(cwd);
  const shellReadRoots = [...new Set([
    cwd,
    ...writeRoots,
    ...explicitShellReadRoots
  ])].filter((root) => !isFileSystemRoot(root));
  const deniedReadRoots = uniqueResolvedPaths(requestedDeniedReadRoots);
  const protectedWriteRoots = uniqueResolvedPaths([
    ...writeRoots.flatMap((root) => (
      [...HOST_CONTROL_DIRECTORY_NAMES].map((name) => path.join(root, name))
    )),
    ...(Array.isArray(options.protectedWriteRoots) ? options.protectedWriteRoots : [])
  ]);
  let shellSandbox = null;
  if (requestedToolNames.includes("bash")) {
    try {
      shellSandbox = await (options.shellSandboxFactory || createShellSandbox)({
        cwd,
        // 完整磁盘开关只扩大 Pi read，永不扩大 bash 沙箱。
        readRoots: shellReadRoots,
        writeRoots,
        deniedReadRoots,
        protectedWriteRoots,
        allowAppleEvents: false
      });
    } catch (error) {
      if (typeof options.onSandboxUnavailable === "function") {
        options.onSandboxUnavailable(error);
      }
    }
  }
  const agentCore = await loadAgentCore();
  const baseEnv = new agentCore.NodeExecutionEnv({
    cwd,
    ...(shellSandbox?.shellPath ? { shellPath: shellSandbox.shellPath } : {})
  });
  const env = new ScopedNodeExecutionEnv(baseEnv, {
    cwd,
    readRoots,
    writeRoots,
    deniedReadRoots,
    protectedWriteRoots,
    shellSandbox,
    openExternal: options.openExternal
  });
  const safeEnvironment = {
    PATH: systemCommandPath(cwd) || "/usr/bin:/bin",
    LANG: process.env.LANG || "C.UTF-8",
    LC_ALL: process.env.LC_ALL || "",
    GIT_CONFIG_NOSYSTEM: "1",
    TMPDIR: shellSandbox?.tempDir || process.env.TMPDIR || ""
  };
  const rawTools = [
    agentCore.createReadTool(),
    agentCore.createWriteTool(),
    agentCore.createEditTool(),
    ...(shellSandbox ? [agentCore.createBashTool({
      prepare(execution) {
        const externalUrl = parseExternalOpenCommand(execution.command);
        assertScopedShellCommand(execution.command, {
          allowExternalOpen: Boolean(externalUrl && typeof options.openExternal === "function")
        });
        execution.inheritEnv = false;
        execution.env = safeEnvironment;
      }
    })] : [])
  ].filter((tool) => requestedToolNames.includes(tool.name));
  const tools = rawTools.map((tool) => {
    const declaredTool = withDeliverableDeclaration(tool);
    return {
      ...declaredTool,
      label: declaredTool.label || declaredTool.name,
      executionMode: BASE_TOOL_POLICIES[declaredTool.name]?.parallelSafe ? "parallel" : "sequential",
      execute: (toolCallId, args, signal, onUpdate) => (
        declaredTool.execute(toolCallId, args, signal, onUpdate, { env })
      )
    };
  });
  Object.defineProperty(tools, "cleanup", {
    enumerable: false,
    value: async () => {
      try {
        await env.cleanup();
      } finally {
        await shellSandbox?.cleanup();
      }
    }
  });
  return tools;
}

function withDeliverableDeclaration(tool) {
  if (!["write", "edit"].includes(`${tool?.name || ""}`)) return tool;
  const parameters = tool.parameters || { type: "object", properties: {}, required: [] };
  return {
    ...tool,
    description: [
      `${tool.description || ""}`,
      "Set deliverable=true only when this file itself is a final file requested by the user.",
      "Use false for source edits, build scripts, drafts, caches, and intermediate files."
    ].filter(Boolean).join(" "),
    parameters: {
      ...parameters,
      properties: {
        ...(parameters.properties || {}),
        deliverable: {
          type: "boolean",
          description: [
            "Whether this file itself must be delivered to the user as a final artifact.",
            "true starts the inspect/publish delivery state; false keeps it as a workspace file."
          ].join(" ")
        }
      },
      required: [...new Set([...(parameters.required || []), "deliverable"])]
    }
  };
}

async function resolveExistingRoots(requestedRoots) {
  const settled = await Promise.allSettled(
    requestedRoots.map((root) => fsp.realpath(path.resolve(root)))
  );
  return settled
    .filter((result) => result.status === "fulfilled")
    .map((result) => result.value);
}

function uniqueResolvedPaths(values) {
  return [...new Set(
    (Array.isArray(values) ? values : [])
      .map((value) => `${value || ""}`.trim())
      .filter(Boolean)
      .map(canonicalExistingPath)
  )];
}

function canonicalExistingPath(value) {
  const absolute = path.resolve(`${value || ""}`);
  try {
    return fs.realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

function isFileSystemRoot(value) {
  const absolute = path.resolve(`${value || ""}`);
  return absolute === path.parse(absolute).root;
}

module.exports = {
  BASE_TOOL_NAMES,
  BASE_TOOL_POLICIES,
  ScopedNodeExecutionEnv,
  assertScopedShellCommand,
  createScopedTools,
  parseExternalOpenCommand,
  withDeliverableDeclaration
};
