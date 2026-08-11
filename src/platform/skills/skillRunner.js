// @ts-check

const path = require("node:path");
const { spawn } = require("node:child_process");
const { buildNodePathEntries } = require("./moduleResolutionPaths");

// 通用子进程跑 skill script 的工具：
//   - stdin 注入 JSON params
//   - stdout 解析 JSON 结果（取最后一行非空）
//   - stderr 整段回传（便于排查）
//   - 超时（默认 60s）强杀
//
// 不做业务判断，业务逻辑全在 SkillsService。
//
// 关键：node runtime 用 process.execPath。在 Electron 里 process.execPath 是 Electron
// 二进制，直接 spawn 会启动一个新 Electron 实例而不是 node —— 必须设 ELECTRON_RUN_AS_NODE=1
// 让它以纯 node 模式跑脚本。同时脚本（被 seed 到用户 workspace）需要能 require 到 app 的
// node_modules（docx / marked / mammoth），靠 NODE_PATH 注入解析路径。

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 300_000;
const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const SAFE_ENV_KEYS = [
  "PATH", "HOME", "USERPROFILE", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL",
  "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT"
];

class SkillRunner {
  constructor({ nodeBinary = process.execPath, pythonBinary = "python3", projectRoot = "" } = {}) {
    this.nodeBinary = nodeBinary;
    this.pythonBinary = pythonBinary;
    this.projectRoot = projectRoot;
    this.isElectron = Boolean(process.versions && process.versions.electron);
    this.nodePaths = this._resolveNodePaths();
  }

  // 计算 skill 子进程能解析到 app node_modules 的候选目录。
  //   - 打包：process.resourcesPath/app.asar.unpacked/node_modules
  //   - dev：projectRoot/node_modules
  _resolveNodePaths() {
    return buildNodePathEntries({ projectRoot: this.projectRoot });
  }

  // node runtime 在 Electron 下需要的环境变量（电子转 node + 模块解析）。
  _runtimeEnv(runtime) {
    if (runtime !== "node" || !this.isElectron) return {};
    const env = { ELECTRON_RUN_AS_NODE: "1" };
    const existing = process.env.NODE_PATH ? [process.env.NODE_PATH] : [];
    const merged = [...this.nodePaths, ...existing].filter(Boolean);
    if (merged.length) env.NODE_PATH = merged.join(path.delimiter);
    return env;
  }

  async run({ runtime = "node", scriptPath = "", params = {}, env = {}, cwd = "", timeoutMs = DEFAULT_TIMEOUT_MS, signal = null } = {}) {
    if (signal?.aborted) {
      return { ok: false, code: -1, signal: null, stdout: "", stderr: "skill 执行已取消", result: null, timedOut: false, aborted: true };
    }
    const binary = this._resolveBinary(runtime);
    const input = JSON.stringify(params);
    if (Buffer.byteLength(input, "utf8") > MAX_INPUT_BYTES) {
      return { ok: false, code: -1, signal: null, stdout: "", stderr: "skill 输入超过 8 MiB 上限", result: null, timedOut: false, inputLimitExceeded: true };
    }
    const effectiveTimeoutMs = Math.max(1000, Math.min(MAX_TIMEOUT_MS, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));
    return new Promise((resolve) => {
      const child = spawn(binary, [scriptPath], {
        cwd: cwd || undefined,
        env: this._buildChildEnv(runtime, env),
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true
      });

      const stdoutChunks = [];
      const stderrChunks = [];
      let timedOut = false;
      let outputLimitExceeded = false;
      let outputBytes = 0;
      let settled = false;
      let aborted = false;

      const onAbort = () => {
        aborted = true;
        try { child.kill("SIGKILL"); } catch { /* noop */ }
      };
      signal?.addEventListener?.("abort", onAbort, { once: true });
      const cleanup = () => signal?.removeEventListener?.("abort", onAbort);

      const timer = setTimeout(() => {
        timedOut = true;
        try { child.kill("SIGKILL"); } catch { /* noop */ }
      }, effectiveTimeoutMs);

      const capture = (chunks, chunk) => {
        if (outputLimitExceeded) return;
        outputBytes += chunk.length;
        if (outputBytes > MAX_OUTPUT_BYTES) {
          outputLimitExceeded = true;
          try { child.kill("SIGKILL"); } catch { /* noop */ }
          return;
        }
        chunks.push(chunk);
      };
      child.stdout.on("data", (chunk) => capture(stdoutChunks, chunk));
      child.stderr.on("data", (chunk) => capture(stderrChunks, chunk));

      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cleanup();
        resolve({ ok: false, code: -1, signal: null, stdout: "", stderr: String(err.message || err), result: null, timedOut: false, outputLimitExceeded: false, spawnError: err });
      });

      child.on("close", (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cleanup();
        const stdout = Buffer.concat(stdoutChunks).toString("utf8");
        const stderr = Buffer.concat(stderrChunks).toString("utf8");
        const result = this._parseResult(stdout);
        resolve({
          ok: code === 0 && result?.ok !== false && !outputLimitExceeded,
          code, signal, stdout, stderr, result, timedOut, outputLimitExceeded, aborted
        });
      });

      try {
        child.stdin.write(input);
        child.stdin.end();
      } catch (err) {
        settled = true;
        clearTimeout(timer);
        cleanup();
        try { child.kill("SIGKILL"); } catch { /* noop */ }
        resolve({ ok: false, code: -1, signal: null, stdout: "", stderr: String(err), result: null, timedOut: false, outputLimitExceeded: false, aborted });
      }
    });
  }

  _buildChildEnv(runtime, extra = {}) {
    const clean = {};
    for (const key of SAFE_ENV_KEYS) {
      if (process.env[key]) clean[key] = process.env[key];
    }
    for (const [key, value] of Object.entries(extra || {})) {
      if (/^YAOGUO_[A-Z0-9_]+$/.test(key) && value !== undefined && value !== null) clean[key] = `${value}`;
    }
    return { ...clean, ...this._runtimeEnv(runtime) };
  }

  _resolveBinary(runtime) {
    if (runtime === "node") return this.nodeBinary;
    if (runtime === "python") return this.pythonBinary;
    throw new Error(`不支持的 runtime: ${runtime}`);
  }

  _parseResult(stdout) {
    if (!stdout) return null;
    const lines = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) return null;
    const last = lines[lines.length - 1];
    try {
      return JSON.parse(last);
    } catch {
      return null;
    }
  }
}

module.exports = {
  SkillRunner
};
