// @ts-check

const { spawn } = require("node:child_process");
const path = require("node:path");
const { buildModuleLookupRoots } = require("./moduleResolutionPaths");
/** @type {NodeJS.Process & { resourcesPath?: string }} */
const runtimeProcess = process;

// 检测 skill 声明的依赖是否就位。
//   - npm 包：在项目 node_modules/ 里 require.resolve。
//   - binary：spawn --version 看退出码。
// 结果缓存在内存里；外层（SkillsService）可以决定是否落盘。

class DependencyResolver {
  constructor({ projectRoot = "", resourcesPath = runtimeProcess.resourcesPath || "" } = {}) {
    if (!projectRoot) throw new Error("DependencyResolver 需要 projectRoot。");
    this.projectRoot = projectRoot;
    this.moduleLookupRoots = buildModuleLookupRoots({ projectRoot, resourcesPath });
    this._cache = new Map();
  }

  invalidateCache() {
    this._cache.clear();
  }

  async resolveAll(deps = []) {
    return Promise.all(deps.map((dep) => this.resolve(dep)));
  }

  async resolve(dep) {
    if (!dep || !dep.id) return { dep, installed: false, version: null, hint: "依赖缺少 id。" };
    const cacheKey = `${dep.kind}:${dep.id}:${dep.version || ""}`;
    if (this._cache.has(cacheKey)) {
      return { dep, ...this._cache.get(cacheKey) };
    }

    let status;
    if (dep.kind === "npm") status = this._resolveNpm(dep);
    else if (dep.kind === "binary") status = await this._resolveBinary(dep);
    else status = { installed: false, version: null, hint: `未知依赖类型：${dep.kind}` };

    this._cache.set(cacheKey, status);
    return { dep, ...status };
  }

  _resolveNpm(dep) {
    try {
      const resolved = require.resolve(dep.id, { paths: this.moduleLookupRoots });
      const pkgPath = this._findPackageJson(resolved);
      let version = null;
      if (pkgPath) {
        try { version = require(pkgPath).version || null; } catch { /* noop */ }
      }
      if (dep.version && version && !satisfiesVersion(version, dep.version)) {
        return {
          installed: false,
          version,
          hint: `npm 包 ${dep.id} 版本 ${version} 不满足 ${dep.version}。`
        };
      }
      return { installed: true, version, hint: null };
    } catch {
      return { installed: false, version: null, hint: dep.missingHint || `npm 包 ${dep.id} 未安装。` };
    }
  }

  _findPackageJson(resolvedFile) {
    let dir = path.dirname(resolvedFile);
    for (let i = 0; i < 6; i += 1) {
      const candidate = path.join(dir, "package.json");
      try {
        require.resolve(candidate);
        return candidate;
      } catch { /* climb up */ }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return null;
  }

  async _resolveBinary(dep) {
    const candidates = this._binaryCandidates(dep);
    for (const cmd of candidates) {
      const result = await this._spawnVersion(cmd, dep.versionFlag || "--version");
      if (result.ok) {
        return { installed: true, version: result.version, binary: cmd, hint: null };
      }
    }
    return { installed: false, version: null, hint: dep.missingHint || `未检测到 ${dep.id}。` };
  }

  _binaryCandidates(dep) {
    if (dep.id === "python") return ["python3", "python"];
    if (dep.id === "libreoffice") return ["soffice", "libreoffice", "/Applications/LibreOffice.app/Contents/MacOS/soffice"];
    if (dep.id === "pandoc") return ["pandoc"];
    return [];
  }

  _spawnVersion(cmd, flag) {
    return new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let settled = false;
      const child = spawn(cmd, [flag], { stdio: ["ignore", "pipe", "pipe"] });
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { child.kill("SIGKILL"); } catch { /* noop */ }
        resolve({ ok: false, version: null });
      }, 3000);
      child.stdout.on("data", (c) => { stdout += c.toString("utf8"); });
      child.stderr.on("data", (c) => { stderr += c.toString("utf8"); });
      child.on("error", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ ok: false, version: null });
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const text = (stdout || stderr || "").trim();
        const match = text.match(/\d+\.\d+(\.\d+)?/);
        resolve({ ok: code === 0, version: match ? match[0] : text.split("\n")[0] || null });
      });
    });
  }
}

function satisfiesVersion(version = "", range = "") {
  const actual = parseVersion(version);
  const wanted = parseVersion(`${range}`.replace(/^[~^]/, ""));
  if (!actual || !wanted) return version === range;
  if (`${range}`.startsWith("^")) {
    if (wanted[0] > 0) return actual[0] === wanted[0] && compareVersion(actual, wanted) >= 0;
    if (wanted[1] > 0) return actual[0] === 0 && actual[1] === wanted[1] && compareVersion(actual, wanted) >= 0;
    return actual[0] === 0 && actual[1] === 0 && actual[2] === wanted[2];
  }
  if (`${range}`.startsWith("~")) {
    return actual[0] === wanted[0] && actual[1] === wanted[1] && compareVersion(actual, wanted) >= 0;
  }
  return compareVersion(actual, wanted) === 0;
}

function parseVersion(value) {
  const match = `${value}`.match(/^(\d+)\.(\d+)\.(\d+)/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function compareVersion(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] > right[index] ? 1 : -1;
  }
  return 0;
}

module.exports = {
  DependencyResolver,
  satisfiesVersion
};
