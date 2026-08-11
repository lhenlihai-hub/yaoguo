import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  resolveCanonicalMemoryRoot,
  memoryDirectoryName,
  resolveMemdirLocation
} = require("../src/platform/memory/memdir/memdirPaths.js");

test("Git worktree 通过 git-common-dir 共享 canonical root 与同一个 Memdir", async () => {
  const root = mkdtempSync(join(tmpdir(), "yaoguo-worktrees-"));
  const main = join(root, "main");
  const left = join(root, "feature-left");
  const right = join(root, "feature-right");
  const gitCommon = join(main, ".git");
  await Promise.all([
    mkdir(gitCommon, { recursive: true }),
    mkdir(left, { recursive: true }),
    mkdir(right, { recursive: true })
  ]);
  const execFileImpl = async () => ({ stdout: `${gitCommon}\n` });
  const baseDirectory = join(root, "memdir-home");

  assert.equal(await resolveCanonicalMemoryRoot(left, { execFileImpl }), await realpath(main));
  const leftLocation = await resolveMemdirLocation({ workspaceRoot: left, baseDirectory, execFileImpl });
  const rightLocation = await resolveMemdirLocation({ workspaceRoot: right, baseDirectory, execFileImpl });
  assert.equal(leftLocation.canonicalRoot, rightLocation.canonicalRoot);
  assert.equal(leftLocation.memoryDirectory, rightLocation.memoryDirectory);
});

test("非 Git 目录回退到自身真实路径", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "yaoguo-nongit-"));
  const execFileImpl = async () => { throw new Error("not a git repository"); };
  assert.equal(
    await resolveCanonicalMemoryRoot(workspace, { execFileImpl }),
    await realpath(workspace)
  );
});

test("目录名使用规范化路径与摘要防碰撞", () => {
  const first = memoryDirectoryName("/teams/a-b/c");
  const second = memoryDirectoryName("/teams/a/b-c");
  assert.notEqual(first, second);
  assert.match(first, /-[a-f0-9]{12}$/);
});

test("默认基目录位于用户 home 的 .yaoguo/projects", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "yaoguo-home-workspace-"));
  const homeDirectory = mkdtempSync(join(tmpdir(), "yaoguo-home-"));
  const execFileImpl = async () => { throw new Error("not git"); };
  const location = await resolveMemdirLocation({ workspaceRoot: workspace, homeDirectory, execFileImpl });
  assert.equal(location.baseDirectory, join(homeDirectory, ".yaoguo", "projects"));
  assert.match(location.memoryDirectory, /\/\.yaoguo\/projects\/.+\/memory$/);
});
