"use strict";

const crypto = require("node:crypto");
const { stripTerminalControlSequences } = require("../platform/shared/text");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");
const {
  inferInstallRoot,
  validateInstallManifest
} = require("./uninstall");

const UPDATE_REPOSITORY = "lhenlihai-hub/yaoguo";
const UPDATE_CHANNEL = "terminal-main";
const UPDATE_STATE_VERSION = 1;
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const UPDATE_RETRY_INTERVAL_MS = 30 * 60 * 1000;
const UPDATE_REQUEST_TIMEOUT_MS = 8000;
const RELEASE_FILE = "release.json";
const UPDATE_STATE_FILE = "update-state.json";

function parseUpdateArgs(argv = []) {
  if (argv.length) throw new Error(`update 不支持参数：${argv[0]}`);
  return {};
}

function normalizeReleaseMetadata(value = {}, options = {}) {
  const version = `${value?.version || ""}`.trim();
  const build = `${value?.build || ""}`.trim().toLowerCase();
  const channel = `${value?.channel || ""}`.trim();
  const commit = `${options.commit || value?.commit || ""}`.trim().toLowerCase();
  if (Number(value?.schema) !== 1 || channel !== UPDATE_CHANNEL) {
    throw new Error("更新元数据的格式或发布通道无效。");
  }
  if (!/^\d+\.\d+\.\d+(?:-[0-9a-z.-]+)?$/i.test(version)) {
    throw new Error("更新元数据中的版本号无效。");
  }
  if (!/^[a-f0-9]{16,64}$/.test(build)) {
    throw new Error("更新元数据中的构建标识无效。");
  }
  if (commit && !/^[a-f0-9]{40}$/.test(commit)) {
    throw new Error("更新元数据中的提交标识无效。");
  }
  return { schema: 1, channel, version, build, commit };
}

function releaseLabel(release = {}) {
  const version = `${release?.version || ""}`.trim();
  const build = `${release?.build || ""}`.slice(0, 8);
  if (version && build) return `v${version}（${build}）`;
  if (version) return `v${version}`;
  return build ? `构建 ${build}` : "最新版";
}

async function readJson(file) {
  try {
    return JSON.parse(await fsp.readFile(file, "utf8"));
  } catch {
    return null;
  }
}

async function readLocalRelease(packageRoot) {
  const value = await readJson(path.join(packageRoot, RELEASE_FILE));
  if (!value) {
    const pkg = await readJson(path.join(packageRoot, "package.json"));
    const version = `${pkg?.version || ""}`.trim();
    return /^\d+\.\d+\.\d+(?:-[0-9a-z.-]+)?$/i.test(version)
      ? { schema: 1, channel: UPDATE_CHANNEL, version, build: "", commit: "" }
      : null;
  }
  return normalizeReleaseMetadata(value);
}

async function resolveManagedInstallation(packageRoot) {
  const absolutePackageRoot = path.resolve(`${packageRoot || ""}`);
  const installRoot = inferInstallRoot(absolutePackageRoot);
  const stat = await fsp.lstat(installRoot).catch(() => null);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("腰果安装目录不是可验证的普通目录。");
  }
  const manifestPath = path.join(installRoot, "install.json");
  const manifest = await readJson(manifestPath);
  if (!manifest) throw new Error("找不到可验证的腰果安装记录。");
  validateInstallManifest(manifest, installRoot);
  const expectedPackageRoot = path.join(manifest.appPrefix, "lib", "node_modules", "yaoguo");
  if (absolutePackageRoot !== path.resolve(expectedPackageRoot)) {
    throw new Error("当前腰果命令与安装记录不匹配。");
  }
  return { installRoot, manifestPath, manifest, packageRoot: absolutePackageRoot };
}

async function fetchLatestRelease(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("当前 Node.js 不支持联网检测更新。");
  const apiRoot = `https://api.github.com/repos/${UPDATE_REPOSITORY}`;
  const runsResponse = await requestText(
    `${apiRoot}/actions/workflows/check.yml/runs?branch=main&event=push&status=success&per_page=1`,
    {
      fetchImpl,
      signal: options.signal,
      timeoutMs: options.timeoutMs
    }
  );
  const commit = `${JSON.parse(runsResponse)?.workflow_runs?.[0]?.head_sha || ""}`
    .trim()
    .toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(commit)) {
    throw new Error("尚未发现通过完整测试的腰果版本。");
  }
  const releaseResponse = await requestText(
    `${apiRoot}/contents/${RELEASE_FILE}?ref=${commit}`,
    {
      fetchImpl,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      accept: "application/vnd.github.raw+json"
    }
  );
  const release = parseReleaseResponse(releaseResponse);
  return normalizeReleaseMetadata(release, { commit });
}

function parseReleaseResponse(text) {
  const parsed = JSON.parse(`${text || ""}`);
  if (parsed?.encoding === "base64" && parsed?.content) {
    return JSON.parse(Buffer.from(`${parsed.content}`.replace(/\s/g, ""), "base64").toString("utf8"));
  }
  return parsed;
}

async function requestText(url, options = {}) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error("更新检查超时。")),
      Math.max(1000, Number(options.timeoutMs) || UPDATE_REQUEST_TIMEOUT_MS)
    );
    timeout.unref?.();
    const onAbort = () => controller.abort(options.signal?.reason || new Error("更新检查已取消。"));
    options.signal?.addEventListener?.("abort", onAbort, { once: true });
    try {
      if (options.signal?.aborted) onAbort();
      const response = await options.fetchImpl(url, {
        headers: {
          Accept: options.accept || "application/vnd.github+json",
          "User-Agent": "yaoguo-update"
        },
        signal: controller.signal
      });
      if (!response?.ok) {
        throw new Error(`GitHub 更新服务返回 HTTP ${Number(response?.status) || 0}。`);
      }
      return await response.text();
    } catch (error) {
      lastError = error;
      if (options.signal?.aborted) throw options.signal.reason || error;
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener?.("abort", onAbort);
    }
  }
  throw new Error(`无法连接 GitHub 更新服务：${lastError?.message || lastError}`);
}

async function checkForUpdate(options = {}) {
  let installation;
  try {
    installation = await resolveManagedInstallation(options.packageRoot);
  } catch (error) {
    if (options.silentUnsupported) {
      return { supported: false, available: false, error: error?.message || `${error}` };
    }
    throw new Error("当前版本不是由腰果一行安装器管理；源码版本请通过 Git 更新。");
  }
  const current = await readLocalRelease(installation.packageRoot);
  const statePath = path.join(installation.installRoot, UPDATE_STATE_FILE);
  const state = await readJson(statePath);
  const now = options.now instanceof Date ? options.now : new Date();
  if (!options.force && recentFailedAttempt(state, now)) {
    return {
      supported: true,
      available: false,
      current,
      error: `${state?.error || ""}`,
      rateLimited: true
    };
  }
  const cached = !options.force && usableCachedRelease(state, now);
  if (cached) {
    const latest = normalizeReleaseMetadata(state.latest);
    return updateCheckResult({ installation, current, latest, cached: true });
  }
  try {
    const latest = await fetchLatestRelease(options);
    await writeUpdateState(statePath, {
      lastAttemptAt: now.toISOString(),
      lastCheckedAt: now.toISOString(),
      latest
    });
    return updateCheckResult({ installation, current, latest, cached: false });
  } catch (error) {
    await writeUpdateState(statePath, {
      lastAttemptAt: now.toISOString(),
      lastCheckedAt: state?.lastCheckedAt || "",
      latest: state?.latest || null,
      error: `${error?.message || error}`.slice(0, 300)
    }).catch(() => {});
    if (options.silentErrors) {
      return {
        supported: true,
        available: false,
        current,
        error: error?.message || `${error}`
      };
    }
    throw error;
  }
}

function usableCachedRelease(state, now) {
  if (Number(state?.version) !== UPDATE_STATE_VERSION || !state?.latest) return false;
  const checkedAt = Date.parse(`${state.lastCheckedAt || ""}`);
  const age = now.getTime() - checkedAt;
  return Number.isFinite(checkedAt) && age >= 0 && age < UPDATE_CHECK_INTERVAL_MS;
}

function recentFailedAttempt(state, now) {
  if (Number(state?.version) !== UPDATE_STATE_VERSION || !state?.error) return false;
  const attemptedAt = Date.parse(`${state.lastAttemptAt || ""}`);
  const age = now.getTime() - attemptedAt;
  return Number.isFinite(attemptedAt) && age >= 0 && age < UPDATE_RETRY_INTERVAL_MS;
}

function updateCheckResult({ installation, current, latest, cached }) {
  const installedCommit = `${installation?.manifest?.release?.commit || ""}`.trim().toLowerCase();
  const hasInstalledCommit = /^[a-f0-9]{40}$/.test(installedCommit);
  return {
    supported: true,
    available: hasInstalledCommit
      ? installedCommit !== latest.commit
      : (current?.build
        ? current.build !== latest.build
        : (!current || compareVersions(latest.version, current.version) > 0)),
    current,
    latest,
    cached,
    installation
  };
}

function compareVersions(left = "", right = "") {
  const [leftCore, leftPre = ""] = `${left}`.split("-", 2);
  const [rightCore, rightPre = ""] = `${right}`.split("-", 2);
  const a = leftCore.split(".").map(Number);
  const b = rightCore.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  if (leftPre === rightPre) return 0;
  if (!leftPre) return 1;
  if (!rightPre) return -1;
  return leftPre.localeCompare(rightPre, "en", { numeric: true });
}

async function writeUpdateState(file, value = {}) {
  await writePrivateJson(file, {
    version: UPDATE_STATE_VERSION,
    lastAttemptAt: `${value.lastAttemptAt || ""}`,
    lastCheckedAt: `${value.lastCheckedAt || ""}`,
    latest: value.latest || null,
    error: `${value.error || ""}`
  });
}

async function installLatestUpdate(options = {}) {
  parseUpdateArgs(options.argv || []);
  options.onStatus?.("正在检查更新…");
  const checked = await checkForUpdate({ ...options, force: true, silentErrors: false });
  if (!checked.available) return { ...checked, updated: false };
  const { installation, latest } = checked;
  const stageRoot = await fsp.mkdtemp(path.join(installation.installRoot, ".update-"));
  const stagePrefix = path.join(stageRoot, "app");
  const packageUrl = `https://github.com/${UPDATE_REPOSITORY}/archive/${latest.commit}.tar.gz`;
  try {
    options.onStatus?.(`正在下载 ${releaseLabel(latest)}…`);
    const installInto = options.installInto || installPackageInto;
    await installInto({
      prefix: stagePrefix,
      packageUrl,
      spawnProcess: options.spawnProcess,
      env: options.env,
      signal: options.signal
    });
    options.onStatus?.("正在校验更新…");
    await verifyStagedInstall(stagePrefix, latest, options);
    options.onStatus?.("正在应用更新…");
    await activateStagedInstall(stagePrefix, installation, latest, options);
    const statePath = path.join(installation.installRoot, UPDATE_STATE_FILE);
    const now = options.now instanceof Date ? options.now : new Date();
    await writeUpdateState(statePath, {
      lastAttemptAt: now.toISOString(),
      lastCheckedAt: now.toISOString(),
      latest
    }).catch(() => {});
    return { ...checked, current: latest, available: false, updated: true };
  } finally {
    await fsp.rm(stageRoot, { recursive: true, force: true }).catch(() => {});
  }
}

async function installPackageInto({ prefix, packageUrl, spawnProcess, env, signal } = {}) {
  await fsp.mkdir(prefix, { recursive: true });
  await runProcess("npm", [
    "install",
    "--global",
    "--prefix", prefix,
    "--omit=dev",
    "--no-audit",
    "--no-fund",
    "--loglevel=error",
    "--fetch-retries=3",
    "--fetch-retry-mintimeout=1000",
    "--fetch-retry-maxtimeout=10000",
    "--fetch-timeout=60000",
    packageUrl
  ], { spawnProcess, env, signal });
}

async function verifyStagedInstall(prefix, latest, options = {}) {
  const packageRoot = path.join(prefix, "lib", "node_modules", "yaoguo");
  const release = await readLocalRelease(packageRoot);
  if (!release || release.build !== latest.build || release.version !== latest.version) {
    throw new Error("下载的更新与 GitHub 发布元数据不一致，当前版本未改变。");
  }
  const pkg = await readJson(path.join(packageRoot, "package.json"));
  if (pkg?.name !== "yaoguo" || !pkg?.bin?.yaoguo) {
    throw new Error("下载的更新不是有效的腰果终端包，当前版本未改变。");
  }
  if (options.skipCliVerification) return;
  const output = await runProcess(process.execPath, [
    path.join(packageRoot, "src", "cli", "cli.js"),
    "--version"
  ], { spawnProcess: options.spawnProcess, env: options.env });
  if (`${output}`.trim() !== latest.version) {
    throw new Error("更新包启动校验失败，当前版本未改变。");
  }
}

async function activateStagedInstall(stagePrefix, installation, latest, options = {}) {
  const appPrefix = path.resolve(installation.manifest.appPrefix);
  const appStat = await fsp.lstat(appPrefix).catch(() => null);
  if (!appStat?.isDirectory() || appStat.isSymbolicLink()) {
    throw new Error("当前程序目录不是可验证的普通目录，未应用更新。");
  }
  const suffix = `${process.pid}-${crypto.randomBytes(5).toString("hex")}`;
  const backup = path.join(installation.installRoot, `.app-backup-${suffix}`);
  const nextManifestPath = path.join(installation.installRoot, `.install-${suffix}.json`);
  const nextManifest = {
    ...installation.manifest,
    release: {
      version: latest.version,
      build: latest.build,
      commit: latest.commit
    },
    updatedAt: new Date().toISOString()
  };
  await fsp.writeFile(nextManifestPath, `${JSON.stringify(nextManifest, null, 2)}\n`, { mode: 0o600 });
  let oldMoved = false;
  let nextMoved = false;
  try {
    await fsp.rename(appPrefix, backup);
    oldMoved = true;
    await fsp.rename(stagePrefix, appPrefix);
    nextMoved = true;
    await fsp.rename(nextManifestPath, installation.manifestPath);
  } catch (error) {
    const rollbackErrors = [];
    if (nextMoved) {
      await fsp.rename(appPrefix, stagePrefix).catch((rollbackError) => rollbackErrors.push(rollbackError));
    }
    if (oldMoved) {
      await fsp.rename(backup, appPrefix).catch((rollbackError) => rollbackErrors.push(rollbackError));
    }
    if (rollbackErrors.length) {
      throw new Error(`更新切换与自动恢复均失败，请重新运行安装命令：${error?.message || error}`);
    }
    throw new Error(`更新切换失败，已恢复原版本：${error?.message || error}`);
  } finally {
    await fsp.rm(nextManifestPath, { force: true }).catch(() => {});
  }
  const remove = options.removeBackup || ((target) => fsp.rm(target, { recursive: true, force: true }));
  await Promise.resolve(remove(backup)).catch(() => {});
}

function runProcess(command, args, options = {}) {
  const spawnProcess = options.spawnProcess || spawn;
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(options.signal.reason || new Error("更新已取消。"));
      return;
    }
    const child = spawnProcess(command, args, {
      env: { ...process.env, ...options.env, npm_config_update_notifier: "false" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error, value = "") => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener?.("abort", onAbort);
      if (error) reject(error);
      else resolve(value);
    };
    const onAbort = () => {
      child.kill?.("SIGTERM");
      finish(options.signal.reason || new Error("更新已取消。"));
    };
    child.stdout?.on?.("data", (chunk) => { stdout = appendLimited(stdout, chunk); });
    child.stderr?.on?.("data", (chunk) => { stderr = appendLimited(stderr, chunk); });
    child.once?.("error", (error) => finish(error));
    child.once?.("close", (code, signal) => {
      if (code === 0) finish(null, stdout);
      else finish(new Error(
        stderr.trim() || `更新进程异常结束（${signal || `exit ${code}`}）。`
      ));
    });
    options.signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

function appendLimited(current, chunk) {
  const next = `${current}${Buffer.from(chunk).toString("utf8")}`;
  return next.length > 256000 ? next.slice(-256000) : next;
}

async function writePrivateJson(file, value) {
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  await fsp.mkdir(path.dirname(file), { recursive: true });
  try {
    await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await fsp.rename(temporary, file);
  } finally {
    await fsp.rm(temporary, { force: true }).catch(() => {});
  }
}

async function runUpdateCommand(argv = [], options = {}) {
  parseUpdateArgs(argv);
  const output = options.streams?.output || process.stdout;
  const errorOutput = options.streams?.error || process.stderr;
  output.write("正在检查更新…\n");
  try {
    const result = await installLatestUpdate({
      ...options,
      argv: [],
      onStatus(label) {
        if (label !== "正在检查更新…") output.write(`${stripTerminalControlSequences(label)}\n`);
      }
    });
    if (!result.updated) {
      output.write(`当前已是最新版本 ${releaseLabel(result.current || result.latest)}。\n`);
    } else {
      output.write(`已更新到 ${releaseLabel(result.current)}。重新运行 \`腰果\` 后生效。\n`);
    }
    return 0;
  } catch (error) {
    errorOutput.write(`更新失败，当前版本未改变：${stripTerminalControlSequences(error?.message || error)}\n`);
    return 1;
  }
}

module.exports = {
  UPDATE_CHANNEL,
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_RETRY_INTERVAL_MS,
  parseUpdateArgs,
  normalizeReleaseMetadata,
  compareVersions,
  releaseLabel,
  readLocalRelease,
  resolveManagedInstallation,
  fetchLatestRelease,
  checkForUpdate,
  installLatestUpdate,
  installPackageInto,
  verifyStagedInstall,
  activateStagedInstall,
  runUpdateCommand
};
