import test from "node:test";
import assert from "node:assert/strict";
import {
  access,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  INSTALL_MANIFEST_KIND,
  INSTALL_MANIFEST_VERSION,
  PROFILE_BLOCK_START,
  PROFILE_BLOCK_END,
  parseUninstallArgs,
  inferInstallRoot,
  stripManagedProfileBlock,
  runUninstall
} = require("../src/cli/uninstall.js");

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function listFiles(directory, relative = "") {
  const files = [];
  for (const entry of await readdir(path.join(directory, relative), { withFileTypes: true })) {
    const next = path.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(directory, next));
    else if (entry.isFile()) files.push(next);
  }
  return files.sort();
}

test("uninstall 只接受显式的 --yes，且只识别专属安装结构", () => {
  assert.deepEqual(parseUninstallArgs([]), { yes: false });
  assert.deepEqual(parseUninstallArgs(["--yes"]), { yes: true });
  assert.throws(() => parseUninstallArgs(["--force"]), /不支持参数/);
  assert.equal(
    inferInstallRoot("/home/test/.yaoguo/app/lib/node_modules/yaoguo"),
    "/home/test/.yaoguo"
  );
  assert.throws(() => inferInstallRoot("/workspace/yaoguo"), /不是由腰果一行安装器/);
});

test("PATH 清理只删除安装器拥有的标记块", () => {
  const source = [
    "export KEEP=1",
    PROFILE_BLOCK_START,
    'export PATH="/home/test/.local/bin:$PATH"',
    PROFILE_BLOCK_END,
    "export ALSO_KEEP=1",
    ""
  ].join("\n");
  assert.equal(stripManagedProfileBlock(source), "export KEEP=1\nexport ALSO_KEEP=1\n");
  assert.equal(
    stripManagedProfileBlock(`export KEEP=1\n${PROFILE_BLOCK_START}\nexport KEEP_TOO=1\n`),
    `export KEEP=1\n${PROFILE_BLOCK_START}\nexport KEEP_TOO=1\n`
  );
});

test("完全卸载会归档已发布成品，删除程序与数据并保留用户工作区", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "yaoguo-uninstall-"));
  const installRoot = path.join(home, ".yaoguo");
  const appPrefix = path.join(installRoot, "app");
  const packageRoot = path.join(appPrefix, "lib", "node_modules", "yaoguo");
  const runtimeRoot = path.join(installRoot, "runtime");
  const artifactRoot = path.join(installRoot, "artifacts");
  const finalRoot = path.join(runtimeRoot, "workspace", "projects", "terminal", "tasks", "task-1", "final");
  const commandDir = path.join(home, ".local", "bin");
  const workspace = path.join(home, "user-workspace");
  const profile = path.join(home, ".zprofile");
  const output = [];
  try {
    await mkdir(packageRoot, { recursive: true });
    await mkdir(path.join(appPrefix, "bin"), { recursive: true });
    await mkdir(finalRoot, { recursive: true });
    await mkdir(path.join(installRoot, "projects", "memory"), { recursive: true });
    await mkdir(commandDir, { recursive: true });
    await mkdir(workspace, { recursive: true });
    await writeFile(path.join(finalRoot, "report.md"), "最终成品\n", "utf8");
    await writeFile(path.join(finalRoot, ".yaoguo-publish-report.md.json"), "{}\n", "utf8");
    await writeFile(path.join(installRoot, "projects", "memory", "memory.md"), "memory\n", "utf8");
    await writeFile(path.join(workspace, "keep.txt"), "keep\n", "utf8");
    await writeFile(profile, [
      "export KEEP=1",
      PROFILE_BLOCK_START,
      `export PATH="${commandDir}:$PATH"`,
      PROFILE_BLOCK_END,
      ""
    ].join("\n"), "utf8");
    for (const command of ["yaoguo", "腰果"]) {
      const target = path.join(appPrefix, "bin", command);
      await writeFile(target, "#!/bin/sh\n", "utf8");
      await symlink(target, path.join(commandDir, command));
    }
    const manifest = {
      kind: INSTALL_MANIFEST_KIND,
      version: INSTALL_MANIFEST_VERSION,
      installRoot,
      appPrefix,
      runtimeRoot,
      artifactRoot,
      commandLinks: [path.join(commandDir, "yaoguo"), path.join(commandDir, "腰果")]
    };
    await writeFile(path.join(installRoot, "install.json"), `${JSON.stringify(manifest)}\n`, "utf8");

    const code = await runUninstall(["--yes"], {
      packageRoot,
      homeDirectory: home,
      streams: { input: { isTTY: false }, output: { write: (value) => output.push(value) } },
      clock: () => new Date("2026-08-12T01:02:03.004Z")
    });

    assert.equal(code, 0);
    assert.equal(await exists(appPrefix), false);
    assert.equal(await exists(runtimeRoot), false);
    assert.equal(await exists(path.join(installRoot, "projects")), false);
    assert.equal(await exists(path.join(commandDir, "yaoguo")), false);
    assert.equal(await exists(path.join(commandDir, "腰果")), false);
    assert.equal(await readFile(path.join(workspace, "keep.txt"), "utf8"), "keep\n");
    assert.equal(await readFile(profile, "utf8"), "export KEEP=1\n");
    const archivedFiles = await listFiles(artifactRoot);
    assert.deepEqual(archivedFiles, [
      path.join("2026-08-12T01-02-03-004Z", "terminal", "task-1", "report.md")
    ]);
    assert.equal(
      await readFile(path.join(artifactRoot, archivedFiles[0]), "utf8"),
      "最终成品\n"
    );
    assert.match(output.join(""), /已保留 1 个成品/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
