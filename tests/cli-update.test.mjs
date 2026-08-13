import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  UPDATE_CHANNEL,
  compareVersions,
  normalizeReleaseMetadata,
  fetchLatestRelease,
  checkForUpdate,
  installLatestUpdate
} = require("../src/cli/update.js");

const CURRENT_BUILD = "1".repeat(64);
const LATEST_BUILD = "2".repeat(64);
const LATEST_COMMIT = "a".repeat(40);

async function createManagedInstall(version = "0.1.0", build = CURRENT_BUILD) {
  const home = mkdtempSync(path.join(tmpdir(), "yaoguo-update-"));
  const installRoot = path.join(home, ".yaoguo");
  const appPrefix = path.join(installRoot, "app");
  const packageRoot = path.join(appPrefix, "lib", "node_modules", "yaoguo");
  const commandDir = path.join(home, ".local", "bin");
  await mkdir(path.join(packageRoot, "src", "cli"), { recursive: true });
  await mkdir(path.join(appPrefix, "bin"), { recursive: true });
  await mkdir(commandDir, { recursive: true });
  await writeFile(path.join(packageRoot, "package.json"), `${JSON.stringify({
    name: "yaoguo",
    version,
    bin: { yaoguo: "src/cli/cli.js", 腰果: "src/cli/cli.js" }
  })}\n`, "utf8");
  await writeFile(path.join(packageRoot, "release.json"), `${JSON.stringify({
    schema: 1,
    channel: UPDATE_CHANNEL,
    version,
    build
  })}\n`, "utf8");
  const commandLinks = [];
  for (const command of ["yaoguo", "腰果"]) {
    const target = path.join(appPrefix, "bin", command);
    const link = path.join(commandDir, command);
    await writeFile(target, "#!/bin/sh\n", "utf8");
    await symlink(target, link);
    commandLinks.push(link);
  }
  const manifest = {
    kind: "yaoguo.install",
    version: 1,
    installRoot,
    appPrefix,
    runtimeRoot: path.join(installRoot, "runtime"),
    artifactRoot: path.join(installRoot, "artifacts"),
    commandLinks,
    release: { version, build, commit: "b".repeat(40) }
  };
  await writeFile(path.join(installRoot, "install.json"), `${JSON.stringify(manifest)}\n`, "utf8");
  return { home, installRoot, appPrefix, packageRoot, commandLinks };
}

function response(value, status = 200) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return { ok: status >= 200 && status < 300, status, async text() { return text; } };
}

test("更新元数据严格限定稳定通道，并按语义版本判断新旧", () => {
  assert.deepEqual(normalizeReleaseMetadata({
    schema: 1,
    channel: UPDATE_CHANNEL,
    version: "0.2.0",
    build: LATEST_BUILD
  }), {
    schema: 1,
    channel: UPDATE_CHANNEL,
    version: "0.2.0",
    build: LATEST_BUILD,
    commit: ""
  });
  assert.throws(() => normalizeReleaseMetadata({
    schema: 1,
    channel: "nightly",
    version: "0.2.0",
    build: LATEST_BUILD
  }), /发布通道无效/);
  assert.equal(compareVersions("0.2.0", "0.1.9"), 1);
  assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
  assert.equal(compareVersions("1.0.0-beta.2", "1.0.0-beta.10"), -1);
  assert.equal(compareVersions("1.0.0", "1.0.0-beta.10"), 1);
});

test("更新检查只选择 main 上最近一次完整通过 CI 的发布", async () => {
  const calls = [];
  const latest = await fetchLatestRelease({
    async fetchImpl(url, options) {
      calls.push({ url, accept: options.headers.Accept });
      if (url.includes("/actions/workflows/check.yml/runs")) {
        return response({ workflow_runs: [{ head_sha: LATEST_COMMIT }] });
      }
      return response({
        schema: 1,
        channel: UPDATE_CHANNEL,
        version: "0.2.0",
        build: LATEST_BUILD
      });
    }
  });
  assert.equal(latest.commit, LATEST_COMMIT);
  assert.equal(latest.version, "0.2.0");
  assert.match(calls[0].url, /branch=main&event=push&status=success&per_page=1/);
  assert.match(calls[1].url, new RegExp(`release\\.json\\?ref=${LATEST_COMMIT}`));
  assert.equal(calls[1].accept, "application/vnd.github.raw+json");
});

test("自动检测限频缓存且联网失败不阻塞终端", async () => {
  const install = await createManagedInstall();
  let networkCalls = 0;
  try {
    const first = await checkForUpdate({
      packageRoot: install.packageRoot,
      now: new Date("2026-08-13T01:00:00Z"),
      async fetchImpl(url) {
        networkCalls += 1;
        if (url.includes("/actions/workflows/check.yml/runs")) {
          return response({ workflow_runs: [{ head_sha: LATEST_COMMIT }] });
        }
        return response({ schema: 1, channel: UPDATE_CHANNEL, version: "0.2.0", build: LATEST_BUILD });
      }
    });
    assert.equal(first.available, true);
    const second = await checkForUpdate({
      packageRoot: install.packageRoot,
      now: new Date("2026-08-13T02:00:00Z"),
      fetchImpl: async () => { throw new Error("不应联网"); }
    });
    assert.equal(second.cached, true);
    assert.equal(networkCalls, 2);
    await rm(path.join(install.installRoot, "update-state.json"), { force: true });
    const failed = await checkForUpdate({
      packageRoot: install.packageRoot,
      silentErrors: true,
      fetchImpl: async () => { throw new Error("offline"); }
    });
    assert.equal(failed.available, false);
    assert.match(failed.error, /无法连接 GitHub/);
  } finally {
    await rm(install.home, { recursive: true, force: true });
  }
});

test("原地更新先校验临时安装，再原子切换并保持命令链接", async () => {
  const install = await createManagedInstall();
  try {
    const result = await installLatestUpdate({
      packageRoot: install.packageRoot,
      skipCliVerification: true,
      async fetchImpl(url) {
        if (url.includes("/actions/workflows/check.yml/runs")) {
          return response({ workflow_runs: [{ head_sha: LATEST_COMMIT }] });
        }
        return response({ schema: 1, channel: UPDATE_CHANNEL, version: "0.2.0", build: LATEST_BUILD });
      },
      async installInto({ prefix }) {
        const nextPackageRoot = path.join(prefix, "lib", "node_modules", "yaoguo");
        await mkdir(path.join(nextPackageRoot, "src", "cli"), { recursive: true });
        await mkdir(path.join(prefix, "bin"), { recursive: true });
        await writeFile(path.join(nextPackageRoot, "package.json"), `${JSON.stringify({
          name: "yaoguo",
          version: "0.2.0",
          bin: { yaoguo: "src/cli/cli.js", 腰果: "src/cli/cli.js" }
        })}\n`, "utf8");
        await writeFile(path.join(nextPackageRoot, "release.json"), `${JSON.stringify({
          schema: 1,
          channel: UPDATE_CHANNEL,
          version: "0.2.0",
          build: LATEST_BUILD
        })}\n`, "utf8");
        await writeFile(path.join(prefix, "bin", "yaoguo"), "new\n", "utf8");
        await writeFile(path.join(prefix, "bin", "腰果"), "new\n", "utf8");
      }
    });
    assert.equal(result.updated, true);
    const release = JSON.parse(await readFile(path.join(install.packageRoot, "release.json"), "utf8"));
    assert.equal(release.version, "0.2.0");
    for (const link of install.commandLinks) {
      assert.equal(await readFile(link, "utf8"), "new\n");
    }
    const manifest = JSON.parse(await readFile(path.join(install.installRoot, "install.json"), "utf8"));
    assert.equal(manifest.release.commit, LATEST_COMMIT);
  } finally {
    await rm(install.home, { recursive: true, force: true });
  }
});

test("相同语义版本的新稳定构建仍会被检测为可更新", async () => {
  const install = await createManagedInstall("0.2.0", CURRENT_BUILD);
  try {
    const result = await checkForUpdate({
      packageRoot: install.packageRoot,
      async fetchImpl(url) {
        if (url.includes("/actions/workflows/check.yml/runs")) {
          return response({ workflow_runs: [{ head_sha: LATEST_COMMIT }] });
        }
        return response({ schema: 1, channel: UPDATE_CHANNEL, version: "0.2.0", build: LATEST_BUILD });
      }
    });
    assert.equal(result.available, true);
  } finally {
    await rm(install.home, { recursive: true, force: true });
  }
});

test("更新包元数据不匹配时拒绝切换，当前版本保持不变", async () => {
  const install = await createManagedInstall();
  try {
    await assert.rejects(installLatestUpdate({
      packageRoot: install.packageRoot,
      skipCliVerification: true,
      async fetchImpl(url) {
        if (url.includes("/actions/workflows/check.yml/runs")) {
          return response({ workflow_runs: [{ head_sha: LATEST_COMMIT }] });
        }
        return response({ schema: 1, channel: UPDATE_CHANNEL, version: "0.2.0", build: LATEST_BUILD });
      },
      async installInto({ prefix }) {
        const nextPackageRoot = path.join(prefix, "lib", "node_modules", "yaoguo");
        await mkdir(nextPackageRoot, { recursive: true });
        await writeFile(path.join(nextPackageRoot, "package.json"), `${JSON.stringify({
          name: "yaoguo", version: "0.2.0", bin: { yaoguo: "src/cli/cli.js" }
        })}\n`, "utf8");
        await writeFile(path.join(nextPackageRoot, "release.json"), `${JSON.stringify({
          schema: 1, channel: UPDATE_CHANNEL, version: "0.2.0", build: "3".repeat(64)
        })}\n`, "utf8");
      }
    }), /发布元数据不一致/);
    const release = JSON.parse(await readFile(path.join(install.packageRoot, "release.json"), "utf8"));
    assert.equal(release.version, "0.1.0");
    assert.equal(release.build, CURRENT_BUILD);
  } finally {
    await rm(install.home, { recursive: true, force: true });
  }
});

test("独立更新命令把网络失败转成简洁错误与非零退出码", async () => {
  const { runUpdateCommand } = require("../src/cli/update.js");
  const output = [];
  const error = [];
  const code = await runUpdateCommand([], {
    packageRoot: "/tmp/not-a-managed-yaoguo",
    streams: {
      output: { write: (value) => output.push(`${value}`) },
      error: { write: (value) => error.push(`${value}`) }
    }
  });
  assert.equal(code, 1);
  assert.match(output.join(""), /正在检查更新/);
  assert.match(error.join(""), /更新失败，当前版本未改变/);
});
