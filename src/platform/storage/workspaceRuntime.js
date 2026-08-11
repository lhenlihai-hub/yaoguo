const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
function createPaths(projectRoot) {
  const workspace = path.join(projectRoot, "workspace");
  return {
    projectRoot,
    workspace,
    configDir: path.join(workspace, "config"),
    settingsFile: path.join(workspace, "config", "settings.json"),
    settingsLocalFile: path.join(workspace, "config", "settings.local.json"),
    workflowsDir: path.join(workspace, "workflows"),
    projectsDir: path.join(workspace, "projects"),
    privateDir: path.join(workspace, "private"),
    registriesDir: path.join(workspace, "registries"),
    aiCallsFile: path.join(workspace, "private", "ai-calls.jsonl"),
    tokenLedgerFile: path.join(workspace, "private", "token-ledger.jsonl"),
    tokenSummaryFile: path.join(workspace, "private", "token-summary.json"),
    schedulesDir: path.join(workspace, "schedules"),
    jobsFile: path.join(workspace, "schedules", "jobs.json"),
    runsDir: path.join(workspace, "runs"),
    assetsDir: path.join(workspace, "assets"),
    chatsDir: path.join(workspace, "chats")
  };
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

async function exists(file) {
  try {
    await fsp.access(file);
    return true;
  } catch {
    return false;
  }
}

const SEED_MANIFEST_FILE = ".seed-manifest.json";
const SEED_BACKUP_DIR = ".seed-backups";

async function sha1OfFile(filepath) {
  const content = await fsp.readFile(filepath);
  return crypto.createHash("sha1").update(content).digest("hex");
}

async function readSeedManifest(workspaceRoot) {
  const file = path.join(workspaceRoot, SEED_MANIFEST_FILE);
  if (!(await exists(file))) return { v: 1, files: {} };
  try {
    const parsed = JSON.parse(await fsp.readFile(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || !parsed.files) return { v: 1, files: {} };
    return parsed;
  } catch {
    return { v: 1, files: {} };
  }
}

async function writeSeedManifest(workspaceRoot, manifest) {
  const file = path.join(workspaceRoot, SEED_MANIFEST_FILE);
  await ensureDir(path.dirname(file));
  await fsp.writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

async function backupTarget(workspaceRoot, relPath, targetFile) {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const safeRel = relPath.split(path.sep).join("__");
  const backupPath = path.join(workspaceRoot, SEED_BACKUP_DIR, `${safeRel}.${ts}.bak`);
  await ensureDir(path.dirname(backupPath));
  await fsp.copyFile(targetFile, backupPath);
  return backupPath;
}

// 单个 seed 文件应用策略（P1.2）：
//   target 不存在            -> 复制 + 记录 hash                            (created)
//   manifest 无 baseline:
//     target 内容 == seed   -> 仅写 manifest 建 baseline                    (baseline)
//     target 内容 != seed   -> 备份 target + 覆盖 + 写 manifest             (migrated) 让老用户升级落地
//   manifest 有 baseline:
//     target 未被用户改     -> seed 升级才覆盖；否则跳过                    (updated / skipped)
//     target 被用户改过     -> 跳过保留用户改动                              (userModified)
async function applySeedFile({ seedFile, targetFile, relPath, manifest, workspaceRoot }) {
  const seedHash = await sha1OfFile(seedFile);
  const now = new Date().toISOString();
  if (!(await exists(targetFile))) {
    await ensureDir(path.dirname(targetFile));
    await fsp.copyFile(seedFile, targetFile);
    manifest.files[relPath] = { hash: seedHash, appliedAt: now };
    return "created";
  }
  const targetHash = await sha1OfFile(targetFile);
  const recorded = manifest.files[relPath];
  if (!recorded) {
    if (targetHash === seedHash) {
      manifest.files[relPath] = { hash: seedHash, appliedAt: now };
      return "baseline";
    }
    await backupTarget(workspaceRoot, relPath, targetFile);
    await fsp.copyFile(seedFile, targetFile);
    manifest.files[relPath] = { hash: seedHash, appliedAt: now, migratedFromUnknown: true };
    return "migrated";
  }
  if (targetHash === recorded.hash) {
    if (seedHash === recorded.hash) return "skipped";
    await fsp.copyFile(seedFile, targetFile);
    manifest.files[relPath] = { hash: seedHash, appliedAt: now };
    return "updated";
  }
  return "userModified";
}

// skills 子树是「skill 代码」（scripts/*.js、instructions.md、_lib/*.js），不只是 .json 配置。
// 它们必须随 seed 一起落地，否则 SkillsService 按 manifest 找 scripts/create.js 会扑空。
// 其它资产（prompts/workflows/...）仍只 seed .json。
function isSkillAssetPath(relPath) {
  return `${relPath}`.split("/").includes("skills");
}

async function* walkSeedJson(seedDir, targetDir, manifestKeyPrefix) {
  if (!(await exists(seedDir))) return;
  const entries = await fsp.readdir(seedDir, { withFileTypes: true });
  for (const entry of entries) {
    const source = path.join(seedDir, entry.name);
    const target = path.join(targetDir, entry.name);
    const nextKey = manifestKeyPrefix ? `${manifestKeyPrefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      yield* walkSeedJson(source, target, nextKey);
      continue;
    }
    if (path.extname(entry.name) !== ".json" && !isSkillAssetPath(nextKey)) continue;
    yield { source, target, relPath: nextKey };
  }
}

async function copySeedDir(seedDir, targetDir, { manifest, workspaceRoot, manifestKeyPrefix } = {}) {
  if (!(await exists(seedDir))) return { stats: {}, files: [], available: false };
  await ensureDir(targetDir);
  if (!manifest) manifest = { v: 1, files: {} };
  const stats = {};
  const files = [];
  for await (const { source, target, relPath } of walkSeedJson(seedDir, targetDir, manifestKeyPrefix || "")) {
    files.push(relPath);
    const result = await applySeedFile({ seedFile: source, targetFile: target, relPath, manifest, workspaceRoot });
    stats[result] = (stats[result] || 0) + 1;
  }
  return { stats, files, available: true };
}

async function pruneRetiredSeedFiles({ workspaceRoot, manifest, activeFiles = [], managedPrefixes = [] }) {
  const active = new Set(activeFiles);
  const stats = {};
  for (const [relPath, recorded] of Object.entries(manifest.files || {})) {
    if (active.has(relPath) || !managedPrefixes.some((prefix) => relPath.startsWith(prefix))) continue;
    const normalized = path.normalize(relPath);
    if (path.isAbsolute(normalized) || normalized === ".." || normalized.startsWith(`..${path.sep}`)) continue;
    const target = path.join(workspaceRoot, normalized);
    if (!(await exists(target))) {
      delete manifest.files[relPath];
      stats.retiredMissing = (stats.retiredMissing || 0) + 1;
      continue;
    }
    const targetStat = await fsp.lstat(target);
    if (!targetStat.isFile() || targetStat.isSymbolicLink()) {
      stats.retiredUserModified = (stats.retiredUserModified || 0) + 1;
      continue;
    }
    const targetHash = await sha1OfFile(target);
    if (recorded?.hash && targetHash === recorded.hash) {
      await fsp.unlink(target);
      delete manifest.files[relPath];
      stats.retiredRemoved = (stats.retiredRemoved || 0) + 1;
    } else {
      stats.retiredUserModified = (stats.retiredUserModified || 0) + 1;
    }
  }
  return { stats };
}

async function seedBundledWorkspace(paths, { sourceRoot = "" } = {}) {
  const seedRoot = sourceRoot
    ? path.resolve(sourceRoot)
    : (process.resourcesPath ? path.join(process.resourcesPath, "seed-workspace") : "");
  if (!seedRoot) return { total: 0 };
  if (!(await exists(seedRoot))) return { total: 0 };
  const seeds = [
    { sub: "workflows", target: paths.workflowsDir },
    { sub: "registries", target: paths.registriesDir },
    { sub: "constitution", target: path.join(paths.workspace, "constitution") }
  ];
  const manifest = await readSeedManifest(paths.workspace);
  const totals = {};
  const activeFiles = [];
  const managedPrefixes = [];
  for (const { sub, target } of seeds) {
    const { stats, files, available } = await copySeedDir(path.join(seedRoot, sub), target, {
      manifest,
      workspaceRoot: paths.workspace,
      manifestKeyPrefix: sub
    });
    if (available) managedPrefixes.push(`${sub}/`);
    activeFiles.push(...files);
    for (const [k, v] of Object.entries(stats)) totals[k] = (totals[k] || 0) + v;
  }
  const { stats: retiredStats } = await pruneRetiredSeedFiles({
    workspaceRoot: paths.workspace,
    manifest,
    activeFiles,
    managedPrefixes
  });
  for (const [k, v] of Object.entries(retiredStats)) totals[k] = (totals[k] || 0) + v;
  await writeSeedManifest(paths.workspace, manifest);
  // total 保留旧字段含义"新落地文件数"，相加 created + updated + migrated。
  const total = (totals.created || 0) + (totals.updated || 0) + (totals.migrated || 0);
  return { total, stats: totals };
}

async function readJson(file, fallback) {
  if (!(await exists(file))) return structuredClone(fallback);
  const content = await fsp.readFile(file, "utf8");
  if (!content.trim()) return structuredClone(fallback);
  return JSON.parse(content);
}

async function writeJsonAtomic(file, data) {
  await ensureDir(path.dirname(file));
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  await fsp.writeFile(temp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await fsp.rename(temp, file);
}

async function writeTextAtomic(file, text) {
  await ensureDir(path.dirname(file));
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  await fsp.writeFile(temp, text, "utf8");
  await fsp.rename(temp, file);
}

async function appendText(file, text) {
  await ensureDir(path.dirname(file));
  await fsp.appendFile(file, text, "utf8");
}

module.exports = {
  createPaths,
  ensureDir,
  exists,
  seedBundledWorkspace,
  copySeedDir,
  pruneRetiredSeedFiles,
  applySeedFile,
  readSeedManifest,
  writeSeedManifest,
  readJson,
  writeJsonAtomic,
  writeTextAtomic,
  appendText
};
