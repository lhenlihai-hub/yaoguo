import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const workspaceRuntime = require("../src/platform/storage/workspaceRuntime");

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), "yaoguo-seed-"));
  const seedRoot = join(root, "seed", "workflows");
  const targetRoot = join(root, "workspace", "workflows");
  const workspaceRoot = join(root, "workspace");
  mkdirSync(seedRoot, { recursive: true });
  mkdirSync(targetRoot, { recursive: true });
  return { root, seedRoot, targetRoot, workspaceRoot };
}

test("P1.2: 首装——target 不存在时复制 seed 并写 manifest", async () => {
  const { seedRoot, targetRoot, workspaceRoot } = makeFixture();
  writeFileSync(join(seedRoot, "agent-default.json"), JSON.stringify({ v: 1 }), "utf8");
  const manifest = { v: 1, files: {} };
  const { stats } = await workspaceRuntime.copySeedDir(seedRoot, targetRoot, {
    manifest, workspaceRoot, manifestKeyPrefix: "workflows"
  });
  assert.equal(stats.created, 1);
  assert.ok(existsSync(join(targetRoot, "agent-default.json")));
  assert.ok(manifest.files["workflows/agent-default.json"]);
  assert.ok(manifest.files["workflows/agent-default.json"].hash);
});

test("P1.2: 升级 seed + 用户未改——覆盖为新版本（updated）", async () => {
  const { seedRoot, targetRoot, workspaceRoot } = makeFixture();
  const oldContent = JSON.stringify({ v: 1, mode: "old" });
  const newContent = JSON.stringify({ v: 2, mode: "new" });
  writeFileSync(join(targetRoot, "x.json"), oldContent, "utf8");
  writeFileSync(join(seedRoot, "x.json"), newContent, "utf8");
  const crypto = await import("node:crypto");
  const oldHash = crypto.createHash("sha1").update(oldContent).digest("hex");
  const manifest = { v: 1, files: { "workflows/x.json": { hash: oldHash, appliedAt: "2026-01-01T00:00:00Z" } } };
  const { stats } = await workspaceRuntime.copySeedDir(seedRoot, targetRoot, {
    manifest, workspaceRoot, manifestKeyPrefix: "workflows"
  });
  assert.equal(stats.updated, 1);
  assert.equal(readFileSync(join(targetRoot, "x.json"), "utf8"), newContent);
});

test("P1.2: 升级 seed + 用户改过——跳过保留用户改动（userModified）", async () => {
  const { seedRoot, targetRoot, workspaceRoot } = makeFixture();
  const baselineContent = JSON.stringify({ v: 1, mode: "baseline" });
  const userEditedContent = JSON.stringify({ v: 1, mode: "user-tweak" });
  const newSeedContent = JSON.stringify({ v: 2, mode: "newer" });
  writeFileSync(join(targetRoot, "x.json"), userEditedContent, "utf8");
  writeFileSync(join(seedRoot, "x.json"), newSeedContent, "utf8");
  const crypto = await import("node:crypto");
  const baselineHash = crypto.createHash("sha1").update(baselineContent).digest("hex");
  const manifest = { v: 1, files: { "workflows/x.json": { hash: baselineHash, appliedAt: "2026-01-01T00:00:00Z" } } };
  const { stats } = await workspaceRuntime.copySeedDir(seedRoot, targetRoot, {
    manifest, workspaceRoot, manifestKeyPrefix: "workflows"
  });
  assert.equal(stats.userModified, 1);
  assert.equal(readFileSync(join(targetRoot, "x.json"), "utf8"), userEditedContent);
});

test("P1.2: 老用户首启——无 manifest + 内容相同时建 baseline 不动文件", async () => {
  const { seedRoot, targetRoot, workspaceRoot } = makeFixture();
  const content = JSON.stringify({ v: 1, same: true });
  writeFileSync(join(seedRoot, "x.json"), content, "utf8");
  writeFileSync(join(targetRoot, "x.json"), content, "utf8");
  const manifest = { v: 1, files: {} };
  const { stats } = await workspaceRuntime.copySeedDir(seedRoot, targetRoot, {
    manifest, workspaceRoot, manifestKeyPrefix: "workflows"
  });
  assert.equal(stats.baseline, 1);
  assert.ok(manifest.files["workflows/x.json"]);
});

test("P1.2: 老用户首启——无 manifest + 内容不同时备份+覆盖（migrated）", async () => {
  const { seedRoot, targetRoot, workspaceRoot } = makeFixture();
  const oldContent = JSON.stringify({ v: 1, old: true });
  const seedContent = JSON.stringify({ v: 2, new: true });
  writeFileSync(join(targetRoot, "x.json"), oldContent, "utf8");
  writeFileSync(join(seedRoot, "x.json"), seedContent, "utf8");
  const manifest = { v: 1, files: {} };
  const { stats } = await workspaceRuntime.copySeedDir(seedRoot, targetRoot, {
    manifest, workspaceRoot, manifestKeyPrefix: "workflows"
  });
  assert.equal(stats.migrated, 1);
  // target 是新版
  assert.equal(readFileSync(join(targetRoot, "x.json"), "utf8"), seedContent);
  // 备份目录里保留了旧内容
  const backupDir = join(workspaceRoot, ".seed-backups");
  const backups = readdirSync(backupDir);
  assert.ok(backups.length >= 1);
  const backupContent = readFileSync(join(backupDir, backups[0]), "utf8");
  assert.equal(backupContent, oldContent);
  // manifest 标记为 migrated
  assert.ok(manifest.files["workflows/x.json"].migratedFromUnknown);
});

test("P1.2: 同一 hash 二次启动 skip，不重复 IO", async () => {
  const { seedRoot, targetRoot, workspaceRoot } = makeFixture();
  const content = JSON.stringify({ v: 1 });
  writeFileSync(join(seedRoot, "x.json"), content, "utf8");
  writeFileSync(join(targetRoot, "x.json"), content, "utf8");
  const crypto = await import("node:crypto");
  const hash = crypto.createHash("sha1").update(content).digest("hex");
  const manifest = { v: 1, files: { "workflows/x.json": { hash, appliedAt: "2026-01-01T00:00:00Z" } } };
  const { stats } = await workspaceRuntime.copySeedDir(seedRoot, targetRoot, {
    manifest, workspaceRoot, manifestKeyPrefix: "workflows"
  });
  assert.equal(stats.skipped, 1);
});

test("P1.2: 已退出安装包的 seed 资产仅在用户未修改时删除", async () => {
  const root = mkdtempSync(join(tmpdir(), "yaoguo-seed-retired-"));
  const workspaceRoot = join(root, "workspace");
  const registries = join(workspaceRoot, "registries");
  mkdirSync(registries, { recursive: true });
  const untouched = join(registries, "untouched.json");
  const customized = join(registries, "customized.json");
  const baseline = JSON.stringify({ v: 1 });
  writeFileSync(untouched, baseline, "utf8");
  writeFileSync(customized, JSON.stringify({ v: 2, user: true }), "utf8");
  const crypto = await import("node:crypto");
  const baselineHash = crypto.createHash("sha1").update(baseline).digest("hex");
  const manifest = {
    v: 1,
    files: {
      "registries/untouched.json": { hash: baselineHash },
      "registries/customized.json": { hash: baselineHash }
    }
  };

  const { stats } = await workspaceRuntime.pruneRetiredSeedFiles({
    workspaceRoot,
    manifest,
    activeFiles: [],
    managedPrefixes: ["registries/"]
  });

  assert.equal(stats.retiredRemoved, 1);
  assert.equal(stats.retiredUserModified, 1);
  assert.equal(existsSync(untouched), false);
  assert.equal(existsSync(customized), true);
  assert.equal("registries/untouched.json" in manifest.files, false);
  assert.equal("registries/customized.json" in manifest.files, true);
});

test("P1.2: 递归处理子目录（registries/prompts/blocks）", async () => {
  const { seedRoot, targetRoot, workspaceRoot } = makeFixture();
  mkdirSync(join(seedRoot, "blocks"), { recursive: true });
  writeFileSync(join(seedRoot, "blocks", "a.json"), JSON.stringify({ id: "a" }), "utf8");
  writeFileSync(join(seedRoot, "top.json"), JSON.stringify({ id: "top" }), "utf8");
  const manifest = { v: 1, files: {} };
  await workspaceRuntime.copySeedDir(seedRoot, targetRoot, {
    manifest, workspaceRoot, manifestKeyPrefix: "registries/prompts"
  });
  assert.ok(existsSync(join(targetRoot, "top.json")));
  assert.ok(existsSync(join(targetRoot, "blocks", "a.json")));
  assert.ok(manifest.files["registries/prompts/top.json"]);
  assert.ok(manifest.files["registries/prompts/blocks/a.json"]);
});

test("P1.2: seedBundledWorkspace 端到端——通过 process.resourcesPath", async () => {
  const root = mkdtempSync(join(tmpdir(), "yaoguo-seed-e2e-"));
  const resourcesPath = join(root, "resources");
  const workspace = join(root, "workspace");
  mkdirSync(join(resourcesPath, "seed-workspace", "workflows"), { recursive: true });
  mkdirSync(join(resourcesPath, "seed-workspace", "registries", "prompts"), { recursive: true });
  mkdirSync(join(resourcesPath, "seed-workspace", "constitution"), { recursive: true });
  writeFileSync(join(resourcesPath, "seed-workspace", "workflows", "lf.json"), JSON.stringify({ v: 1 }), "utf8");
  writeFileSync(join(resourcesPath, "seed-workspace", "registries", "prompts", "p.json"), JSON.stringify({ id: "p" }), "utf8");
  writeFileSync(join(resourcesPath, "seed-workspace", "constitution", "v1.json"), JSON.stringify({ v: 1 }), "utf8");
  const paths = {
    workspace,
    workflowsDir: join(workspace, "workflows"),
    registriesDir: join(workspace, "registries")
  };
  const originalResources = process.resourcesPath;
  Object.defineProperty(process, "resourcesPath", { value: resourcesPath, configurable: true, writable: true });
  try {
    const result = await workspaceRuntime.seedBundledWorkspace(paths);
    assert.equal(result.total, 3);
    assert.ok(existsSync(join(workspace, "workflows", "lf.json")));
    assert.ok(existsSync(join(workspace, "registries", "prompts", "p.json")));
    assert.ok(existsSync(join(workspace, "constitution", "v1.json")));
    // manifest 被持久化到 workspace
    const manifest = JSON.parse(readFileSync(join(workspace, ".seed-manifest.json"), "utf8"));
    assert.ok(manifest.files["workflows/lf.json"]);
    assert.ok(manifest.files["registries/prompts/p.json"]);
    assert.ok(manifest.files["constitution/v1.json"]);
  } finally {
    if (originalResources === undefined) {
      delete process.resourcesPath;
    } else {
      Object.defineProperty(process, "resourcesPath", { value: originalResources, configurable: true, writable: true });
    }
  }
});

test("终端入口可从显式源码目录初始化稳定 workspace 资产", async () => {
  const root = mkdtempSync(join(tmpdir(), "yaoguo-seed-source-"));
  const sourceRoot = join(root, "source-workspace");
  const workspace = join(root, "runtime", "workspace");
  mkdirSync(join(sourceRoot, "workflows"), { recursive: true });
  mkdirSync(join(sourceRoot, "registries", "prompts"), { recursive: true });
  writeFileSync(join(sourceRoot, "workflows", "agent.json"), JSON.stringify({ id: "agent" }), "utf8");
  writeFileSync(join(sourceRoot, "registries", "prompts", "system.json"), JSON.stringify({ id: "system" }), "utf8");
  const paths = {
    workspace,
    workflowsDir: join(workspace, "workflows"),
    registriesDir: join(workspace, "registries")
  };
  try {
    const result = await workspaceRuntime.seedBundledWorkspace(paths, { sourceRoot });
    assert.equal(result.total, 2);
    assert.ok(existsSync(join(workspace, "workflows", "agent.json")));
    assert.ok(existsSync(join(workspace, "registries", "prompts", "system.json")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
