"use strict";

const fsp = require("node:fs/promises");
const { constants: fsConstants } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline/promises");

const INSTALL_MANIFEST_KIND = "yaoguo.install";
const INSTALL_MANIFEST_VERSION = 1;
const PROFILE_BLOCK_START = "# >>> yaoguo >>>";
const PROFILE_BLOCK_END = "# <<< yaoguo <<<";
const PROFILE_FILES = [".zprofile", ".bash_profile", ".bashrc", ".profile"];

function parseUninstallArgs(argv = []) {
  let yes = false;
  for (const argument of argv) {
    if (["--yes", "-y"].includes(argument)) yes = true;
    else throw new Error(`uninstall 不支持参数：${argument}`);
  }
  return { yes };
}

function inferInstallRoot(packageRoot = "") {
  const absolute = path.resolve(`${packageRoot || ""}`);
  const nodeModules = path.dirname(absolute);
  const lib = path.dirname(nodeModules);
  const appPrefix = path.dirname(lib);
  if (path.basename(absolute) !== "yaoguo"
    || path.basename(nodeModules) !== "node_modules"
    || path.basename(lib) !== "lib"
    || path.basename(appPrefix) !== "app") {
    throw new Error("当前不是由腰果一行安装器管理的版本，未执行卸载。");
  }
  return path.dirname(appPrefix);
}

async function readInstallManifest(installRoot) {
  const manifestPath = path.join(installRoot, "install.json");
  let manifest;
  try {
    manifest = JSON.parse(await fsp.readFile(manifestPath, "utf8"));
  } catch {
    throw new Error("找不到可验证的安装记录，为避免误删已取消卸载。");
  }
  validateInstallManifest(manifest, installRoot);
  return manifest;
}

function validateInstallManifest(manifest, installRoot) {
  const expected = {
    installRoot,
    appPrefix: path.join(installRoot, "app"),
    runtimeRoot: path.join(installRoot, "runtime"),
    artifactRoot: path.join(installRoot, "artifacts")
  };
  if (manifest?.kind !== INSTALL_MANIFEST_KIND || manifest?.version !== INSTALL_MANIFEST_VERSION) {
    throw new Error("安装记录版本无效，为避免误删已取消卸载。");
  }
  for (const [name, value] of Object.entries(expected)) {
    if (path.resolve(`${manifest[name] || ""}`) !== path.resolve(value)) {
      throw new Error(`安装记录的 ${name} 越出腰果专属目录，已取消卸载。`);
    }
  }
}

async function requireSafeInstallDirectory(installRoot) {
  const stat = await fsp.lstat(installRoot).catch(() => null);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("腰果安装目录不是可验证的普通目录，已取消卸载。");
  }
}

async function requireSafeArtifactDirectory(artifactRoot) {
  const stat = await fsp.lstat(artifactRoot).catch(() => null);
  if (stat?.isSymbolicLink() || (stat && !stat.isDirectory())) {
    throw new Error("成品归档位置不是可验证的普通目录，已取消卸载。");
  }
}

function isInternalPublishedMetadata(name = "") {
  return /^\.yaoguo-publish-(?:txn-)?/.test(name) || /^\.publish-/.test(name);
}

async function listDirectories(directory) {
  const entries = await fsp.readdir(directory, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink());
}

async function collectPublishedArtifacts(runtimeRoot) {
  const projectsRoot = path.join(runtimeRoot, "workspace", "projects");
  const artifacts = [];
  for (const project of await listDirectories(projectsRoot)) {
    const tasksRoot = path.join(projectsRoot, project.name, "tasks");
    for (const task of await listDirectories(tasksRoot)) {
      const finalRoot = path.join(tasksRoot, task.name, "final");
      const entries = await fsp.readdir(finalRoot, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (!entry.isFile() || entry.isSymbolicLink() || isInternalPublishedMetadata(entry.name)) continue;
        artifacts.push({
          source: path.join(finalRoot, entry.name),
          projectId: project.name,
          taskId: task.name,
          file: entry.name
        });
      }
    }
  }
  return artifacts;
}

function archiveLabel(clock = () => new Date()) {
  return clock().toISOString().replace(/[:.]/g, "-");
}

async function reserveArchiveDirectory(artifactRoot, label) {
  await fsp.mkdir(artifactRoot, { recursive: true });
  for (let index = 1; ; index += 1) {
    const suffix = index === 1 ? "" : `-${index}`;
    const candidate = path.join(artifactRoot, `${label}${suffix}`);
    try {
      await fsp.mkdir(candidate);
      return candidate;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
}

async function archivePublishedArtifacts(runtimeRoot, artifactRoot, clock) {
  const artifacts = await collectPublishedArtifacts(runtimeRoot);
  if (!artifacts.length) return { count: 0, bytes: 0, directory: "" };
  const archiveRoot = await reserveArchiveDirectory(artifactRoot, archiveLabel(clock));
  let bytes = 0;
  for (const artifact of artifacts) {
    const destinationDir = path.join(archiveRoot, artifact.projectId, artifact.taskId);
    const destination = path.join(destinationDir, artifact.file);
    await fsp.mkdir(destinationDir, { recursive: true });
    await fsp.copyFile(artifact.source, destination, fsConstants.COPYFILE_EXCL);
    const stat = await fsp.stat(artifact.source);
    await fsp.chmod(destination, stat.mode & 0o777);
    bytes += stat.size;
  }
  return { count: artifacts.length, bytes, directory: archiveRoot };
}

async function archiveTaskPublishedArtifacts({
  taskDir = "", artifactRoot = "", projectId = "project", taskId = "task", clock = () => new Date()
} = {}) {
  const requestedTaskDir = `${taskDir || ""}`.trim();
  const requestedArtifactRoot = `${artifactRoot || ""}`.trim();
  if (!requestedTaskDir || !requestedArtifactRoot) throw new Error("归档任务缺少受管路径。");
  const taskRoot = await fsp.realpath(path.resolve(requestedTaskDir));
  const finalRoot = path.join(taskRoot, "final");
  const finalStat = await fsp.lstat(finalRoot).catch(() => null);
  if (!finalStat?.isDirectory() || finalStat.isSymbolicLink()) {
    return { count: 0, bytes: 0, directory: "" };
  }
  const entries = (await fsp.readdir(finalRoot, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && !isInternalPublishedMetadata(entry.name));
  if (!entries.length) return { count: 0, bytes: 0, directory: "" };
  await requireSafeArtifactDirectory(requestedArtifactRoot);
  const archiveRoot = await reserveArchiveDirectory(
    path.resolve(requestedArtifactRoot),
    `deleted-${archiveLabel(clock)}`
  );
  const destinationDir = path.join(
    archiveRoot,
    safeArchiveSegment(projectId, "project"),
    safeArchiveSegment(taskId, "task")
  );
  await fsp.mkdir(destinationDir, { recursive: true });
  let bytes = 0;
  for (const entry of entries) {
    const source = path.join(finalRoot, entry.name);
    const destination = path.join(destinationDir, entry.name);
    await fsp.copyFile(source, destination, fsConstants.COPYFILE_EXCL);
    const stat = await fsp.stat(source);
    await fsp.chmod(destination, stat.mode & 0o777);
    bytes += stat.size;
  }
  return { count: entries.length, bytes, directory: archiveRoot };
}

function safeArchiveSegment(value, fallback) {
  const normalized = `${value || ""}`.trim().replace(/[^a-zA-Z0-9._-]+/g, "-");
  const segment = normalized.slice(0, 120);
  return !segment || [".", ".."].includes(segment) ? fallback : segment;
}

async function removeOwnedCommandLinks(manifest, homeDirectory) {
  const allowedDirectory = path.join(homeDirectory, ".local", "bin");
  const expectedTargets = new Set([
    path.join(manifest.appPrefix, "bin", "yaoguo"),
    path.join(manifest.appPrefix, "bin", "腰果")
  ].map((value) => path.resolve(value)));
  for (const candidate of manifest.commandLinks || []) {
    const link = path.resolve(`${candidate || ""}`);
    if (path.dirname(link) !== path.resolve(allowedDirectory)) continue;
    const stat = await fsp.lstat(link).catch(() => null);
    if (!stat?.isSymbolicLink()) continue;
    const target = path.resolve(path.dirname(link), await fsp.readlink(link));
    if (expectedTargets.has(target)) await fsp.unlink(link);
  }
}

function stripManagedProfileBlock(content = "") {
  const source = `${content}`;
  const firstStart = source.indexOf(PROFILE_BLOCK_START);
  const firstEnd = source.indexOf(PROFILE_BLOCK_END, firstStart + PROFILE_BLOCK_START.length);
  if (firstStart < 0 || firstEnd < 0) return source;
  const output = [];
  let managed = false;
  for (const line of source.split("\n")) {
    if (line.trim() === PROFILE_BLOCK_START) {
      managed = true;
      continue;
    }
    if (managed && line.trim() === PROFILE_BLOCK_END) {
      managed = false;
      continue;
    }
    if (!managed) output.push(line);
  }
  return output.join("\n").replace(/^\n+/, "").replace(/\n{3,}/g, "\n\n");
}

async function cleanManagedProfiles(homeDirectory) {
  for (const file of PROFILE_FILES) {
    const profile = path.join(homeDirectory, file);
    const stat = await fsp.lstat(profile).catch(() => null);
    if (!stat?.isFile() || stat.isSymbolicLink()) continue;
    const before = await fsp.readFile(profile, "utf8");
    if (!before.includes(PROFILE_BLOCK_START)) continue;
    const after = stripManagedProfileBlock(before);
    if (after === before) continue;
    const temporary = `${profile}.yaoguo-${process.pid}.tmp`;
    try {
      await fsp.writeFile(temporary, after, { encoding: "utf8", mode: stat.mode & 0o777 });
      await fsp.rename(temporary, profile);
    } finally {
      await fsp.rm(temporary, { force: true }).catch(() => {});
    }
  }
}

async function removeManagedInstallData(installRoot, artifactRoot) {
  const entries = await fsp.readdir(installRoot, { withFileTypes: true });
  for (const entry of entries) {
    const target = path.join(installRoot, entry.name);
    if (path.resolve(target) === path.resolve(artifactRoot)) continue;
    await fsp.rm(target, { recursive: true, force: true });
  }
  const remaining = await fsp.readdir(installRoot).catch(() => []);
  if (!remaining.length) await fsp.rmdir(installRoot);
}

async function confirmUninstall({ yes, input, output }) {
  if (yes) return true;
  if (!input?.isTTY) throw new Error("非交互终端请使用 `腰果 uninstall --yes`。");
  const rl = readline.createInterface({ input, output, terminal: true });
  try {
    const answer = (await rl.question("确认卸载？请输入 yes：")).trim().toLowerCase();
    return answer === "yes";
  } finally {
    rl.close();
  }
}

async function runUninstall(argv = [], options = {}) {
  const { yes } = parseUninstallArgs(argv);
  const packageRoot = path.resolve(options.packageRoot || path.resolve(__dirname, "../.."));
  const installRoot = inferInstallRoot(packageRoot);
  const homeDirectory = path.resolve(options.homeDirectory || os.homedir());
  const input = options.streams?.input || process.stdin;
  const output = options.streams?.output || process.stdout;
  await requireSafeInstallDirectory(installRoot);
  const manifest = await readInstallManifest(installRoot);
  await requireSafeArtifactDirectory(manifest.artifactRoot);
  if (path.resolve(packageRoot) !== path.join(manifest.appPrefix, "lib", "node_modules", "yaoguo")) {
    throw new Error("当前命令与安装记录不匹配，已取消卸载。");
  }
  output.write([
    `即将删除：${installRoot} 中的程序、会话、配置、Token 记录和记忆。`,
    `已发布成品将保留到：${manifest.artifactRoot}`,
    "用户工作目录中的文件不会被删除。\n"
  ].join("\n"));
  if (!await confirmUninstall({ yes, input, output })) {
    output.write("已取消卸载。\n");
    return 0;
  }
  const archived = await archivePublishedArtifacts(manifest.runtimeRoot, manifest.artifactRoot, options.clock);
  await removeOwnedCommandLinks(manifest, homeDirectory);
  await cleanManagedProfiles(homeDirectory);
  await removeManagedInstallData(installRoot, manifest.artifactRoot);
  output.write("腰果已完全卸载。\n");
  if (archived.count) output.write(`已保留 ${archived.count} 个成品：${archived.directory}\n`);
  else output.write("未发现需要归档的已发布成品。\n");
  return 0;
}

module.exports = {
  INSTALL_MANIFEST_KIND,
  INSTALL_MANIFEST_VERSION,
  PROFILE_BLOCK_START,
  PROFILE_BLOCK_END,
  parseUninstallArgs,
  inferInstallRoot,
  validateInstallManifest,
  collectPublishedArtifacts,
  archivePublishedArtifacts,
  archiveTaskPublishedArtifacts,
  stripManagedProfileBlock,
  runUninstall
};
