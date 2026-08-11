// @ts-check

const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const { randomUUID } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { HostProcessTracker } = require("./hostProcessTracker");

const CONTROL_POLL_MS = 10;
const NODE_PROCESS_POLICY_OPTION = createNodeProcessPolicyOption();
const MACOS_PACKAGE_MANAGER_PREFIXES = ["/usr/local", "/opt/homebrew", "/opt/local"];
const MACOS_PACKAGE_RUNTIME_SUBDIRS = [
  "bin", "sbin", "Cellar", "opt", "lib", "libexec", "share"
];
const APPLE_DEVELOPER_RUNTIME_SUBDIRS = [
  "usr/bin",
  "usr/lib",
  "usr/libexec",
  "usr/share",
  "Library/Frameworks",
  "Library/PrivateFrameworks"
];

let sandboxRuntimePromise = null;
let activeAppleDeveloperDirCache;

async function loadSandboxRuntime() {
  if (!sandboxRuntimePromise) {
    sandboxRuntimePromise = import("@anthropic-ai/sandbox-runtime")
      .then(async (runtime) => {
        const dependencies = await runtime.SandboxManager.checkDependenciesAsync();
        if (dependencies.errors?.length) {
          throw new Error(`系统命令沙箱不可用：${dependencies.errors.join("；")}`);
        }
        await runtime.SandboxManager.initialize({
          network: {
            allowedDomains: [],
            deniedDomains: ["*"],
            strictAllowlist: true,
            allowUnixSockets: [],
            allowAllUnixSockets: false,
            allowLocalBinding: false
          },
          filesystem: {
            denyRead: [path.parse(process.cwd()).root],
            allowRead: systemRuntimeReadRoots(),
            allowWrite: [],
            denyWrite: [],
            allowGitConfig: false
          }
        });
        return runtime;
      })
      .catch((error) => {
        sandboxRuntimePromise = null;
        throw error;
      });
  }
  return sandboxRuntimePromise;
}

class ShellSandbox {
  /**
   * @param {{
   *   cwd:string,
   *   readRoots:string[],
   *   writeRoots:string[],
   *   deniedReadRoots?:string[],
   *   protectedWriteRoots?:string[],
   *   processSnapshotProvider?:(token:string) => Promise<any[]>
   * }} options
   */
  constructor(options) {
    this.cwd = path.resolve(options.cwd);
    this.readRoots = uniquePaths(options.readRoots);
    this.writeRoots = uniquePaths(options.writeRoots);
    this.deniedReadRoots = uniquePaths(options.deniedReadRoots || []);
    this.protectedWriteRoots = uniquePaths(options.protectedWriteRoots || []);
    this.tempDir = "";
    this.controlDir = "";
    this.shellPath = "";
    this.processGroupFile = "";
    this.exitStatusFile = "";
    this.trackerReadyFile = "";
    this.activeProcessGroups = new Set();
    this.activeTracker = null;
    this.processSnapshotProvider = options.processSnapshotProvider || null;
    this.commandActive = false;
    this.runtime = null;
  }

  async initialize() {
    this.runtime = await loadSandboxRuntime();
    await this.initializeProcessSupervisor();
    return this;
  }

  async initializeProcessSupervisor() {
    if (this.tempDir && this.controlDir && this.shellPath) return this;
    this.tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "yaoguo-agent-work-"));
    this.controlDir = await fsp.mkdtemp(path.join(os.tmpdir(), "yaoguo-agent-control-"));
    this.processGroupFile = path.join(this.controlDir, "process-group");
    this.exitStatusFile = path.join(this.controlDir, "exit-status");
    this.trackerReadyFile = path.join(this.controlDir, "tracker-ready");
    this.shellPath = path.join(this.controlDir, "supervised-bash");
    const processGroupFile = quoteShellLiteral(this.processGroupFile);
    const exitStatusFile = quoteShellLiteral(this.exitStatusFile);
    const trackerReadyFile = quoteShellLiteral(this.trackerReadyFile);
    const supervisor = [
      "#!/bin/bash",
      "set +e",
      `printf '%s\\n' \"$$\" > ${processGroupFile}`,
      `while [ ! -f ${trackerReadyFile} ]; do /bin/sleep 0.01; done`,
      "if [ \"${1-}\" = \"-c\" ]; then shift; fi",
      "/bin/bash -c \"${1-}\"",
      "command_status=$?",
      `status_tmp=${exitStatusFile}.\"$$\"`,
      "printf '%s\\n' \"$command_status\" > \"$status_tmp\"",
      `mv -f \"$status_tmp\" ${exitStatusFile}`,
      // The host kills this detached process group after observing the atomic
      // status receipt. Keeping the leader alive closes the PID-reuse window
      // and makes normal completion use the same hard boundary as abort.
      "while :; do /bin/sleep 3600; done"
    ].join("\n");
    await fsp.writeFile(this.shellPath, `${supervisor}\n`, { mode: 0o700 });
    return this;
  }

  async wrap(command, signal) {
    if (!this.runtime) throw new Error("系统命令沙箱尚未初始化。");
    return this.runtime.SandboxManager.wrapWithSandbox(
      command,
      "/bin/bash",
      {
        // 命令沙箱永不获得 AppleEvents。打开网页由宿主的精确 URL 能力完成。
        allowAppleEvents: false,
        network: {
          allowedDomains: [],
          deniedDomains: ["*"],
          strictAllowlist: true,
          allowUnixSockets: [],
          allowAllUnixSockets: false,
          allowLocalBinding: false
        },
        filesystem: {
          // Sandbox Runtime reads are permissive unless a parent is denied.
          // Deny the filesystem root, then carve back only runtime files,
          // the task scope and explicit references.
          denyRead: uniquePaths([
            path.parse(this.cwd).root,
            ...hostUserDataRoots(),
            ...this.deniedReadRoots,
            this.controlDir
          ]),
          allowRead: uniquePaths([
            ...systemRuntimeReadRoots(),
            ...this.readRoots,
            this.tempDir
          ]),
          allowWrite: uniquePaths([...this.writeRoots, this.tempDir]),
          denyWrite: uniquePaths([
            ...this.protectedWriteRoots,
            this.controlDir
          ]),
          allowGitConfig: false
        }
      },
      signal
    );
  }

  async execute(base, command, options = {}) {
    if (!this.shellPath) throw new Error("系统命令进程监督器尚未初始化。");
    if (this.commandActive) throw new Error("bash 命令必须串行执行。");
    this.commandActive = true;
    const monitorStop = new AbortController();
    let observedStatus = null;
    try {
      await this.prepareCommandControl();
      const signal = options.abortSignal || options.signal;
      const commandToken = randomUUID();
      const sandboxedCommand = await this.wrap(command, signal);
      const executionOptions = {
        ...options,
        env: {
          ...(options.env || {}),
          YAOGUO_COMMAND_TOKEN: commandToken,
          // Node/npm/git remain available. Only Node's attempt to detach a
          // child from this approved command is normalized back into the
          // supervised group; a command cannot intentionally daemonize work.
          NODE_OPTIONS: NODE_PROCESS_POLICY_OPTION
        }
      };
      const baseResultPromise = Promise.resolve(base.exec(sandboxedCommand, executionOptions));
      const observed = await Promise.race([
        baseResultPromise.then((result) => (
          /** @type {{kind:"base", result:any}} */ ({ kind: "base", result })
        )),
        this.waitForCommandStatus(monitorStop.signal, commandToken).then(
          (status) => (
            /** @type {{kind:"status", status:number}} */ ({ kind: "status", status })
          ),
          (error) => (
            /** @type {{kind:"monitor_error", error:any}} */ ({ kind: "monitor_error", error })
          )
        )
      ]);
      if (observed.kind === "base") {
        if (!observed.result?.ok) return observed.result;
        throw new Error("系统命令在退出回执写入前中断。");
      }
      if (observed.kind === "monitor_error") {
        await this.reapCommandProcesses().catch(() => {});
        await baseResultPromise.catch(() => {});
        throw observed.error;
      }
      observedStatus = observed.status;
      await this.reapCommandProcesses();
      const result = await baseResultPromise;
      if (result?.ok && result.value) result.value.exitCode = observedStatus;
      return result;
    } finally {
      monitorStop.abort();
      let reapError = null;
      try {
        await this.reapCommandProcesses();
      } catch (error) {
        reapError = error;
      }
      try {
        await this.clearCommandControl();
      } finally {
        this.commandActive = false;
      }
      if (reapError) throw reapError;
    }
  }

  async prepareCommandControl() {
    await this.clearCommandControl();
    this.activeProcessGroups.clear();
  }

  async clearCommandControl() {
    await Promise.all([
      this.processGroupFile && fsp.rm(this.processGroupFile, { force: true }),
      this.exitStatusFile && fsp.rm(this.exitStatusFile, { force: true }),
      this.trackerReadyFile && fsp.rm(this.trackerReadyFile, { force: true })
    ].filter(Boolean));
  }

  async waitForCommandStatus(signal, commandToken) {
    const processGroup = await readIntegerFileWhenReady(this.processGroupFile, signal);
    if (processGroup <= 1 || processGroup === process.pid) {
      throw new Error("系统命令进程组回执无效。");
    }
    this.activeProcessGroups.add(processGroup);
    if (this.shouldTrackHostDescendants()) {
      this.activeTracker = await new HostProcessTracker({
        rootPid: processGroup,
        rootPgid: processGroup,
        token: commandToken,
        ...(this.processSnapshotProvider
          ? { snapshotProvider: this.processSnapshotProvider }
          : {})
      }).start();
    }
    await fsp.writeFile(this.trackerReadyFile, "ready\n", { mode: 0o600 });
    const status = this.activeTracker
      ? await Promise.race([
        readIntegerFileWhenReady(this.exitStatusFile, signal),
        this.activeTracker.failurePromise.then((error) => { throw error; })
      ])
      : await readIntegerFileWhenReady(this.exitStatusFile, signal);
    if (status < 0 || status > 255) throw new Error("系统命令退出状态无效。");
    return status;
  }

  shouldTrackHostDescendants() {
    // Linux Sandbox Runtime owns a PID namespace, so descendants cannot outlive
    // its init process. macOS has no equivalent job/cgroup primitive: poll
    // ancestry (and an inherited marker where ps exposes it) as a best-effort
    // host fence; Node detachment is separately normalized by NODE_OPTIONS.
    return process.platform === "darwin" || typeof this.processSnapshotProvider === "function";
  }

  async reapCommandProcesses() {
    let groupError = null;
    let trackerError = null;
    try {
      await this.reapCommandProcessGroup();
    } catch (error) {
      groupError = error;
    }
    if (this.activeTracker) {
      const tracker = this.activeTracker;
      this.activeTracker = null;
      try {
        await tracker.stopAndReap();
      } catch (error) {
        trackerError = error;
      }
    }
    if (trackerError) throw trackerError;
    if (groupError) throw groupError;
  }

  async reapCommandProcessGroup() {
    if (!this.activeProcessGroups.size && this.processGroupFile) {
      const processGroup = await readIntegerFile(this.processGroupFile);
      if (processGroup > 1 && processGroup !== process.pid) {
        this.activeProcessGroups.add(processGroup);
      }
    }
    let reapError = null;
    try {
      for (const processGroup of this.activeProcessGroups) {
        try {
          process.kill(-processGroup, "SIGKILL");
        } catch (error) {
          if (error?.code !== "ESRCH") reapError ||= error;
        }
      }
    } finally {
      this.activeProcessGroups.clear();
    }
    if (reapError) throw reapError;
  }

  cleanupAfterCommand() {
    this.runtime?.SandboxManager.cleanupAfterCommand();
  }

  async cleanup() {
    let reapError = null;
    try {
      await this.reapCommandProcesses();
    } catch (error) {
      reapError = error;
    }
    const targets = [this.tempDir, this.controlDir].filter(Boolean);
    this.tempDir = "";
    this.controlDir = "";
    this.shellPath = "";
    this.processGroupFile = "";
    this.exitStatusFile = "";
    this.trackerReadyFile = "";
    await Promise.all(targets.map((target) => fsp.rm(target, { recursive: true, force: true })));
    if (reapError) throw reapError;
  }
}

function systemRuntimeReadRoots(options = {}) {
  const platform = options.platform || process.platform;
  const pathExists = options.pathExists || fs.existsSync;
  const roots = platform === "darwin"
    ? [
      // /System/Volumes/Data aliases the writable data volume, so /System
      // itself must never become an allowRead carve-out.
      "/System/Library",
      "/System/Cryptexes/App/usr/bin",
      "/System/Cryptexes/App/usr/libexec",
      "/System/Cryptexes/App/usr/share",
      "/System/Volumes/Preboot/Cryptexes/OS/System/Library",
      "/System/Volumes/Preboot/Cryptexes/OS/usr/lib",
      "/usr/bin",
      "/usr/sbin",
      "/usr/lib",
      "/usr/libexec",
      "/usr/share",
      "/bin",
      "/sbin",
      "/Library/Apple/usr/bin",
      "/Library/Apple/usr/libexec",
      "/private/var/db/timezone"
    ]
    : platform === "linux"
      ? [
        "/usr",
        "/bin",
        "/sbin",
        "/lib",
        "/lib64",
        "/etc/ld.so.cache",
        "/etc/ld.so.conf",
        "/etc/localtime"
      ]
      : [];
  roots.push(...standardDeviceReadPaths());
  for (const executable of options.executablePaths || [process.execPath, process.env.npm_node_execpath]) {
    roots.push(...executableRuntimeReadRoots(executable));
  }
  if (platform === "darwin") {
    // Package-manager prefixes mix executable code with mutable etc/var trees.
    // Grant only runtime subtrees; the root deny keeps configuration, service
    // state and caches outside the Agent's readable capability.
    for (const prefix of MACOS_PACKAGE_MANAGER_PREFIXES) {
      roots.push(...MACOS_PACKAGE_RUNTIME_SUBDIRS.map((subdir) => path.join(prefix, subdir)));
    }
    const developerDirs = uniquePaths([
      "/Library/Developer/CommandLineTools",
      options.developerDir || activeAppleDeveloperDir(pathExists)
    ]);
    for (const developerDir of developerDirs) {
      roots.push(...APPLE_DEVELOPER_RUNTIME_SUBDIRS.map(
        (subdir) => path.join(developerDir, subdir)
      ));
    }
  }
  return uniquePaths(roots.filter((root) => pathExists(root)));
}

function standardDeviceReadPaths() {
  return [
    "/dev/null",
    "/dev/zero",
    "/dev/random",
    "/dev/urandom",
    "/dev/fd",
    "/dev/stdin",
    "/dev/stdout",
    "/dev/stderr"
  ].filter((device) => fs.existsSync(device));
}

function createNodeProcessPolicyOption() {
  const source = [
    "import childProcess from'node:child_process';",
    "const keepInGroup=original=>function(...args){",
    "const options=args.at(-1);",
    "if(options&&typeof options==='object'&&!Array.isArray(options)&&options.detached===true){",
    "args[args.length-1]={...options,detached:false};",
    "}",
    "return Reflect.apply(original,this,args);",
    "};",
    "childProcess.spawn=keepInGroup(childProcess.spawn);",
    "childProcess.spawnSync=keepInGroup(childProcess.spawnSync);",
    "childProcess.fork=keepInGroup(childProcess.fork);"
  ].join("");
  return `--import=data:text/javascript,${encodeURIComponent(source)}`;
}

function systemCommandPath(cwd = process.cwd(), options = {}) {
  const pathExists = options.pathExists || fs.existsSync;
  const developerDir = options.developerDir || (
    (options.platform || process.platform) === "darwin"
      ? activeAppleDeveloperDir(pathExists)
      : ""
  );
  const candidates = [
    path.join(path.resolve(cwd), "node_modules", ".bin"),
    path.dirname(process.env.npm_node_execpath || process.execPath),
    "/opt/homebrew/bin",
    "/opt/local/bin",
    "/usr/local/bin",
    developerDir && path.join(developerDir, "usr", "bin"),
    "/Library/Developer/CommandLineTools/usr/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
    "/Library/Apple/usr/bin"
  ];
  return uniquePaths(candidates.filter((candidate) => candidate && pathExists(candidate)))
    .join(path.delimiter);
}

function executableRuntimeReadRoots(executable) {
  const source = `${executable || ""}`.trim();
  if (!source || !path.isAbsolute(source)) return [];
  try {
    const canonical = fs.realpathSync(source);
    const binDir = path.dirname(canonical);
    if (path.basename(binDir) !== "bin") return [binDir];
    const runtimeRoot = path.dirname(binDir);
    return [
      binDir,
      path.join(runtimeRoot, "lib"),
      path.join(runtimeRoot, "libexec"),
      path.join(runtimeRoot, "share")
    ];
  } catch {
    return [];
  }
}

function activeAppleDeveloperDir(pathExists = fs.existsSync) {
  if (activeAppleDeveloperDirCache !== undefined) return activeAppleDeveloperDirCache;
  try {
    const selected = execFileSync("/usr/bin/xcode-select", ["-p"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1000
    }).trim();
    activeAppleDeveloperDirCache = canonicalDirectory(selected, pathExists);
  } catch {
    activeAppleDeveloperDirCache = "";
  }
  return activeAppleDeveloperDirCache;
}

function canonicalDirectory(value, pathExists = fs.existsSync) {
  const requested = `${value || ""}`.trim();
  if (!requested || !path.isAbsolute(requested) || !pathExists(requested)) return "";
  try {
    const canonical = fs.realpathSync(requested);
    return fs.statSync(canonical).isDirectory() ? canonical : "";
  } catch {
    return "";
  }
}

async function readIntegerFileWhenReady(file, signal) {
  while (!signal.aborted) {
    const value = await readIntegerFile(file);
    if (Number.isSafeInteger(value)) return value;
    await abortableDelay(CONTROL_POLL_MS, signal);
  }
  throw signal.reason || new Error("系统命令进程监督已停止。");
}

async function readIntegerFile(file) {
  if (!file) return NaN;
  try {
    const source = (await fsp.readFile(file, "utf8")).trim();
    if (!/^-?\d+$/.test(source)) return NaN;
    const value = Number(source);
    return Number.isSafeInteger(value) ? value : NaN;
  } catch (error) {
    if (error?.code === "ENOENT") return NaN;
    throw error;
  }
}

function abortableDelay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason || new Error("系统命令进程监督已停止。"));
      return;
    }
    const timer = setTimeout(done, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason || new Error("系统命令进程监督已停止。"));
    };
    function done() {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function quoteShellLiteral(value) {
  return `'${`${value || ""}`.replace(/'/g, `'\\''`)}'`;
}

function hostUserDataRoots() {
  if (process.platform === "darwin") return ["/Users"];
  if (process.platform === "linux") return ["/home", "/root"];
  return [];
}

function uniquePaths(paths) {
  return [...new Set(
    (Array.isArray(paths) ? paths : [])
      .map((value) => `${value || ""}`.trim())
      .filter(Boolean)
      .map((value) => path.resolve(value))
  )];
}

async function createShellSandbox(options) {
  return new ShellSandbox(options).initialize();
}

module.exports = {
  ShellSandbox,
  createShellSandbox,
  hostUserDataRoots,
  systemCommandPath,
  systemRuntimeReadRoots
};
