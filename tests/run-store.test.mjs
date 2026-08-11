import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createPaths } = require("../src/platform/storage/workspaceRuntime.js");
const { RunStore } = require("../src/platform/runs/runStore.js");

test("RunStore 用索引按 runId 直接读取运行记录", async () => {
  const root = mkdtempSync(join(tmpdir(), "yaoguo-run-store-"));
  const paths = createPaths(root);
  const store = new RunStore(paths);
  const run = await store.createRun({
    projectId: "p1",
    taskId: "t1",
    title: "索引测试"
  });

  const indexRaw = JSON.parse(await readFile(store.indexFile, "utf8"));
  assert.equal(indexRaw.runs[0].id, run.id);

  const loaded = await store.loadRunById(run.id);
  assert.equal(loaded.title, "索引测试");

  const listed = await store.listRuns({ projectId: "p1", taskId: "t1" });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, run.id);
  await rm(root, { recursive: true, force: true });
});

test("RunStore 拒绝 runId 路径穿越且不信任索引中的 runDir", async () => {
  const root = mkdtempSync(join(tmpdir(), "yaoguo-run-store-scope-"));
  const outside = mkdtempSync(join(tmpdir(), "yaoguo-run-store-outside-"));
  const paths = createPaths(root);
  const store = new RunStore(paths);
  try {
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "run.json"), JSON.stringify({ id: "secret", title: "不应读取" }), "utf8");
    await assert.rejects(
      () => store.loadRunById("../../secret"),
      (error) => error.code === "PATH_SEGMENT_INVALID"
    );

    await store.saveIndex({ runs: [{
      id: "safe-run",
      projectId: "p1",
      taskId: "t1",
      runDir: outside
    }] });
    assert.equal(await store.loadRunById("safe-run"), null);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("RunStore 读取时用真实受控目录覆盖 run.json 伪造的 runDir", async () => {
  const root = mkdtempSync(join(tmpdir(), "yaoguo-run-store-rebind-"));
  const paths = createPaths(root);
  const store = new RunStore(paths);
  try {
    const run = await store.createRun({ projectId: "p1", taskId: "t1", runId: "safe-run" });
    await writeFile(join(run.runDir, "run.json"), JSON.stringify({
      ...run,
      runDir: "/tmp/attacker-controlled"
    }), "utf8");

    const loaded = await store.loadRunById("safe-run");
    assert.equal(loaded.runDir, run.runDir);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
