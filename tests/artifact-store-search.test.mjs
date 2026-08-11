import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { ArtifactStore } = require("../src/platform/artifacts/artifactStore.js");
const {
  createBaseToolRegistry,
  searchRunArtifactsTool,
  readArtifactTool
} = require("../src/platform/ai/agentTools/index.js");

function makeTempPaths() {
  const workspace = mkdtempSync(path.join(tmpdir(), "artifact-search-"));
  return {
    workspace,
    projectsDir: path.join(workspace, "projects"),
    privateDir: path.join(workspace, "private"),
    registriesDir: path.join(workspace, "registries")
  };
}

async function seedArtifact(store, overrides = {}) {
  return store.saveTextArtifact({
    projectId: "proj1",
    taskId: "task1",
    runId: overrides.runId || "run1",
    stepId: overrides.stepId || "step1",
    artifactType: overrides.artifactType || "step-output",
    title: overrides.title || "测试部分",
    content: overrides.content || "这是默认内容。",
    fileName: overrides.fileName || "output.md"
  });
}

// ============ ArtifactStore 索引建立 ============

test("ArtifactStore: saveTextArtifact 后能 loadProjectChunks", async () => {
  const paths = makeTempPaths();
  const store = new ArtifactStore(paths);
  await seedArtifact(store, {
    content: "第一段:主角站在窗前。\n\n第二段:他打开了威士忌瓶。\n\n第三段:夜色深沉。"
  });
  const chunks = await store.loadProjectChunks("proj1");
  assert.ok(chunks.length >= 1, "应该至少建一个 chunk");
  assert.ok(chunks.every((c) => c.artifactId), "每个 chunk 必须有 artifactId");
  assert.ok(chunks.every((c) => c.contentHash), "每个 chunk 必须有 contentHash");
  await rm(paths.workspace, { recursive: true, force: true });
});

test("ArtifactStore 可索引当前 run 的既有正文而不复制，并拒绝范围逃逸", async () => {
  const paths = makeTempPaths();
  const outside = await mkdtemp(path.join(tmpdir(), "artifact-source-outside-"));
  try {
    const store = new ArtifactStore(paths);
    const runDir = store.layout.runDir("proj1", "task1", "run-ref");
    const source = path.join(runDir, "outputs", "01.md");
    const content = "唯一运行正文。\n\n这份内容只保存一次。";
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(source, content, "utf8");
    const manifest = await store.saveTextArtifact({
      projectId: "proj1",
      taskId: "task1",
      runId: "run-ref",
      stepId: "agent",
      artifactType: "agent",
      title: "Agent 输出",
      content,
      existingContentPath: source
    });
    assert.equal(await realpath(manifest.paths.content), await realpath(source));
    assert.equal(await readFile(manifest.paths.content, "utf8"), content);
    assert.equal(existsSync(path.join(runDir, "steps", "agent", "output.md")), false);
    assert.ok(existsSync(path.join(runDir, "steps", "agent", "agent.artifact.json")));

    const outsideFile = path.join(outside, "outside.md");
    await writeFile(outsideFile, content, "utf8");
    await assert.rejects(store.saveTextArtifact({
      projectId: "proj1", taskId: "task1", runId: "run-ref", stepId: "outside",
      artifactType: "agent", content, existingContentPath: outsideFile
    }), /超出当前运行范围/);

    const linked = path.join(runDir, "outputs", "linked.md");
    await symlink(outsideFile, linked);
    await assert.rejects(store.saveTextArtifact({
      projectId: "proj1", taskId: "task1", runId: "run-ref", stepId: "linked",
      artifactType: "agent", content, existingContentPath: linked
    }), /普通文件/);
  } finally {
    await rm(paths.workspace, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("ArtifactStore: 重跑同 step 同 type(不传 id)stable id 让旧版本被淘汰", async () => {
  // workflow 自然保存路径 —— 上层不显式传 id,靠 (project,task,run,step,type) 算 stable id。
  // 这是 review 抓到的真问题:之前 id 含 content sha,重跑会留两份;
  // 现在 stable id 之下,同逻辑位置二次 save 自然覆盖。
  const paths = makeTempPaths();
  const store = new ArtifactStore(paths);
  const m1 = await seedArtifact(store, { content: "旧版本内容。威士忌出现在第一版。" });
  const m2 = await seedArtifact(store, { content: "新版本内容。咖啡取代了威士忌。" });
  assert.equal(m1.id, m2.id, "stable id 之下同逻辑位置两次 save 应返回同一 id");
  assert.notEqual(m1.contentHash, m2.contentHash, "contentHash 必须随内容变化");

  const chunks = await store.loadProjectChunks("proj1");
  const distinctHashes = new Set(chunks.map((c) => c.contentHash));
  assert.equal(distinctHashes.size, 1, "loadProjectChunks 应只返回最新 contentHash 的 chunks");
  const combinedText = chunks.map((c) => c.text).join("\n");
  assert.ok(combinedText.includes("咖啡"), "应该看到新版本内容");
  assert.ok(!combinedText.includes("旧版本"), "不应该看到旧版本内容");

  // search 也只命中最新版本 —— 这是 LLM 实际看到的,不能被旧稿污染。
  // 验证两件事:(a) 旧版独有 token "咖啡" 不可能命中旧稿(旧稿无此词);
  //          (b) 任何 hit 的 snippet 都不应含旧版独有字符串 "旧版本内容"。
  // 注意:不能直接搜 "旧版本" 断言 hits=0——bigram+unigram 双索引下,
  //      "版"/"版本"/"本" 等 token 在新版"新版本内容"里也出现,BM25 仍会给低分命中,
  //      这是 tokenize 设计的预期行为,与"旧版本是否被淘汰"无关。
  const r = await store.searchArtifacts({ query: "咖啡", projectId: "proj1", mode: "keyword" });
  assert.ok(r.hits.length >= 1, "新版独有词应能命中");
  for (const hit of r.hits) {
    assert.ok(!hit.snippet.includes("旧版本内容"), `snippet 不应含旧版本文本:${hit.snippet}`);
  }
  // 直接对所有 chunks 物理校验:不存在任何 chunk text 是来自旧版本
  const allChunkText = chunks.map((c) => c.text).join("\n");
  assert.ok(!allChunkText.includes("旧版本内容"), "旧版本 chunks 在物理层就应该被淘汰,不只是 search 层过滤");
  await rm(paths.workspace, { recursive: true, force: true });
});

test("ArtifactStore: chunkId 含 contentHash,不同版本永不冲突", async () => {
  const paths = makeTempPaths();
  const store = new ArtifactStore(paths);
  const m1 = await seedArtifact(store, { content: "第一段内容".repeat(30) });
  const m2 = await seedArtifact(store, { content: "完全不同的新内容".repeat(30) });
  // chunkId 形如 <artifactId>:<contentHash>:c<n>;两次 save 应产出不同 chunkId 前缀
  // 因为 contentHash 不同，索引记录不会错配版本。
  assert.equal(m1.id, m2.id);
  assert.notEqual(m1.contentHash, m2.contentHash);
  const all = await store.loadProjectChunks("proj1");
  for (const c of all) {
    assert.ok(c.chunkId.includes(c.contentHash), `chunkId 必须含 contentHash:${c.chunkId}`);
  }
  await rm(paths.workspace, { recursive: true, force: true });
});

test("ArtifactStore.loadProjectChunks 忽略半套未完成的 chunks,仍用上一齐全版本(crash-safety)", async () => {
  // review P3:模拟进程在写新版本 chunks 中途崩溃 —— 文件留下半套 row,
  // loader 应识别为不齐全(chunks < totalChunks),不激活该 contentHash,
  // 仍用上一个齐全版本。
  const paths = makeTempPaths();
  const store = new ArtifactStore(paths);
  // 先写一个完整版本(几段够分多个 chunk)
  const longText = Array.from({ length: 10 }, (_, i) => `第 ${i} 段。${"内容".repeat(60)}`).join("\n\n");
  const m1 = await seedArtifact(store, { content: longText });
  const completeBefore = await store.loadProjectChunks("proj1");
  const oldHash = m1.contentHash;
  assert.ok(completeBefore.length >= 2, `至少两 chunk 才有意义,实际 ${completeBefore.length}`);

  // 手工往 chunks.jsonl 追加"半套" —— 声称 totalChunks=5 但只写 2 个
  const chunksPath = store.chunksFile("proj1");
  const fakeHash = "deadbeef_fake_hash";
  const halfRows = [
    { chunkId: `${m1.id}:${fakeHash}:c0`, artifactId: m1.id, projectId: "proj1",
      taskId: "task1", runId: "run1", stepId: "step1", artifactType: "step-output",
      title: "测试部分", paragraphIndex: 0, chunkIndex: 0, totalChunks: 5,
      text: "半套写入的新版本第一段", contentHash: fakeHash,
      createdAt: new Date().toISOString() },
    { chunkId: `${m1.id}:${fakeHash}:c1`, artifactId: m1.id, projectId: "proj1",
      taskId: "task1", runId: "run1", stepId: "step1", artifactType: "step-output",
      title: "测试部分", paragraphIndex: 1, chunkIndex: 1, totalChunks: 5,
      text: "半套写入的新版本第二段", contentHash: fakeHash,
      createdAt: new Date().toISOString() }
  ];
  const fs = await import("node:fs/promises");
  for (const row of halfRows) {
    await fs.appendFile(chunksPath, JSON.stringify(row) + "\n", "utf8");
  }

  // loader 应忽略半套(fakeHash 只有 2/5),仍返回旧 contentHash 的 chunks
  const afterCrash = await store.loadProjectChunks("proj1");
  const seenHashes = new Set(afterCrash.map((c) => c.contentHash));
  assert.ok(!seenHashes.has(fakeHash), "半套 chunks 不应激活(应被 totalChunks 闸门拦下)");
  assert.ok(seenHashes.has(oldHash), "应保留上一齐全版本");

  // 现在写完剩下 3 个 row,fakeHash 凑齐 → loader 应切换到 fakeHash
  for (let i = 2; i < 5; i += 1) {
    const row = {
      chunkId: `${m1.id}:${fakeHash}:c${i}`, artifactId: m1.id, projectId: "proj1",
      taskId: "task1", runId: "run1", stepId: "step1", artifactType: "step-output",
      title: "测试部分", paragraphIndex: i, chunkIndex: i, totalChunks: 5,
      text: `半套写入的新版本第 ${i + 1} 段`, contentHash: fakeHash,
      createdAt: new Date().toISOString()
    };
    await fs.appendFile(chunksPath, JSON.stringify(row) + "\n", "utf8");
  }
  const afterComplete = await store.loadProjectChunks("proj1");
  const seenAfter = new Set(afterComplete.map((c) => c.contentHash));
  assert.ok(seenAfter.has(fakeHash), "齐全后应激活新 contentHash");
  assert.ok(!seenAfter.has(oldHash), "新版本齐全后,旧 contentHash 应被顶替");
  await rm(paths.workspace, { recursive: true, force: true });
});

test("ArtifactStore: 每个 chunk row 带 totalChunks 字段", async () => {
  const paths = makeTempPaths();
  const store = new ArtifactStore(paths);
  const content = Array.from({ length: 6 }, (_, i) => `第 ${i + 1} 段。${"内容".repeat(50)}`).join("\n\n");
  await seedArtifact(store, { content });
  const chunks = await store.loadProjectChunks("proj1");
  const totals = new Set(chunks.map((c) => c.totalChunks));
  assert.equal(totals.size, 1, "同批所有 chunk 必须共享一个 totalChunks 值");
  const total = chunks[0].totalChunks;
  assert.equal(total, chunks.length, "totalChunks 应等于本批实际 chunk 数");
  await rm(paths.workspace, { recursive: true, force: true });
});

// ============ searchArtifacts ============

test("ArtifactStore.searchArtifacts keyword 模式命中", async () => {
  const paths = makeTempPaths();
  const store = new ArtifactStore(paths);
  await seedArtifact(store, { stepId: "s1", content: "主角喝了威士忌。" });
  await seedArtifact(store, { stepId: "s2", content: "桌上是咖啡和面包。" });
  const r = await store.searchArtifacts({
    query: "威士忌",
    projectId: "proj1",
    mode: "keyword",
    topK: 5
  });
  assert.equal(r.modeUsed, "keyword");
  assert.ok(r.hits.length >= 1, "应该命中至少一条");
  assert.ok(r.hits[0].snippet.includes("威士忌"), "snippet 应该包含查询词");
  assert.equal(r.hits[0].stepId, "s1", "命中应该来自 s1");
  await rm(paths.workspace, { recursive: true, force: true });
});

test("ArtifactStore.searchArtifacts scope 过滤 runId / stepId / artifactType", async () => {
  const paths = makeTempPaths();
  const store = new ArtifactStore(paths);
  await seedArtifact(store, { runId: "runA", stepId: "s1", content: "主角喝威士忌。" });
  await seedArtifact(store, { runId: "runB", stepId: "s1", content: "主角也喝威士忌。" });
  await seedArtifact(store, { runId: "runA", stepId: "s2", artifactType: "outline", content: "大纲提到威士忌。" });
  // 限定 runId
  const r1 = await store.searchArtifacts({ query: "威士忌", projectId: "proj1", runId: "runA", mode: "keyword" });
  assert.ok(r1.hits.every((h) => h.runId === "runA"));
  // 限定 stepId
  const r2 = await store.searchArtifacts({ query: "威士忌", projectId: "proj1", stepId: "s2", mode: "keyword" });
  assert.ok(r2.hits.every((h) => h.stepId === "s2"));
  // 限定 artifactType
  const r3 = await store.searchArtifacts({ query: "威士忌", projectId: "proj1", artifactType: "outline", mode: "keyword" });
  assert.ok(r3.hits.every((h) => h.artifactType === "outline"));
  await rm(paths.workspace, { recursive: true, force: true });
});

test("ArtifactStore.searchArtifacts 对退役模式参数仍统一使用 BM25", async () => {
  const paths = makeTempPaths();
  const store = new ArtifactStore(paths);
  await seedArtifact(store, { content: "主角喝威士忌。" });
  const r = await store.searchArtifacts({ query: "威士忌", projectId: "proj1", mode: "hybrid" });
  assert.equal(r.modeUsed, "keyword");
  assert.ok(r.hits.length >= 1);
  await rm(paths.workspace, { recursive: true, force: true });
});

test("ArtifactStore.searchArtifacts 空 query / 缺 projectId 安全返回", async () => {
  const paths = makeTempPaths();
  const store = new ArtifactStore(paths);
  const r1 = await store.searchArtifacts({ query: "", projectId: "proj1" });
  assert.equal(r1.hits.length, 0);
  assert.equal(r1.modeUsed, "empty");
  const r2 = await store.searchArtifacts({ query: "x", projectId: "" });
  assert.equal(r2.hits.length, 0);
  await rm(paths.workspace, { recursive: true, force: true });
});

// ============ readArtifact ============

test("ArtifactStore.readArtifact by artifactId 段落分页", async () => {
  const paths = makeTempPaths();
  const store = new ArtifactStore(paths);
  const longContent = Array.from({ length: 50 }, (_, i) => `这是第 ${i + 1} 段内容。`).join("\n\n");
  const m = await seedArtifact(store, { content: longContent });
  // 读前 10 段
  const r1 = await store.readArtifact({ artifactId: m.id, projectId: "proj1", offset: 0, limit: 10 });
  assert.equal(r1.ok, true);
  assert.equal(r1.paragraphsRead.paragraphs.length, 10);
  assert.equal(r1.totalParagraphs, 50);
  assert.equal(r1.truncated, true);
  // 读后半
  const r2 = await store.readArtifact({ artifactId: m.id, projectId: "proj1", offset: 40, limit: 20 });
  assert.equal(r2.paragraphsRead.paragraphs.length, 10);
  assert.equal(r2.truncated, false);
  await rm(paths.workspace, { recursive: true, force: true });
});

test("ArtifactStore.readArtifact by (runId, stepId, artifactType) 联合定位", async () => {
  const paths = makeTempPaths();
  const store = new ArtifactStore(paths);
  await seedArtifact(store, { runId: "run1", stepId: "step9", artifactType: "draft", content: "草稿第一段。\n\n草稿第二段。" });
  const r = await store.readArtifact({
    projectId: "proj1", taskId: "task1", runId: "run1", stepId: "step9", artifactType: "draft"
  });
  assert.equal(r.ok, true);
  assert.equal(r.totalParagraphs, 2);
  assert.equal(r.meta.stepId, "step9");
  await rm(paths.workspace, { recursive: true, force: true });
});

test("ArtifactStore.readArtifact 不存在的 artifactId 返回 ok=false", async () => {
  const paths = makeTempPaths();
  const store = new ArtifactStore(paths);
  const r = await store.readArtifact({ artifactId: "nonexistent", projectId: "proj1" });
  assert.equal(r.ok, false);
  assert.ok(r.reason);
  await rm(paths.workspace, { recursive: true, force: true });
});

test("ArtifactStore.readArtifact 缺定位字段返回 ok=false", async () => {
  const paths = makeTempPaths();
  const store = new ArtifactStore(paths);
  const r = await store.readArtifact({ projectId: "proj1" }); // 既无 artifactId 也无 location 组合
  assert.equal(r.ok, false);
  await rm(paths.workspace, { recursive: true, force: true });
});

test("ArtifactStore.readArtifact maxChars 累计字符截断,truncationReason=maxChars", async () => {
  const paths = makeTempPaths();
  const store = new ArtifactStore(paths);
  // 多段、每段中等长度,累计起来超过 maxChars
  const para = "这是一段大约一百字的中等长度内容,用来测试 maxChars 累计截断行为。".repeat(2); // ~120 字
  const content = Array.from({ length: 20 }, () => para).join("\n\n");
  const m = await seedArtifact(store, { content });
  const r = await store.readArtifact({
    artifactId: m.id, projectId: "proj1",
    offset: 0, limit: 200, maxChars: 500
  });
  assert.equal(r.ok, true);
  assert.ok(r.paragraphsRead.charCount <= 500, "字符数不应超过 maxChars");
  assert.ok(r.paragraphsRead.paragraphs.length < 20, "limit=200 但 maxChars=500 应该提前截断");
  assert.equal(r.truncated, true);
  assert.equal(r.truncationReason, "maxChars");
  await rm(paths.workspace, { recursive: true, force: true });
});

test("ArtifactStore.readArtifact 首段就超 maxChars 时截断并标 firstParagraphTooLong", async () => {
  const paths = makeTempPaths();
  const store = new ArtifactStore(paths);
  // 单一长段,无 \n\n,超过 maxChars
  const content = "无空行长段".repeat(500); // 2500 字符,远超 500
  const m = await seedArtifact(store, { content });
  const r = await store.readArtifact({
    artifactId: m.id, projectId: "proj1",
    limit: 1, maxChars: 500
  });
  assert.equal(r.ok, true);
  assert.equal(r.totalParagraphs, 1);
  assert.equal(r.paragraphsRead.paragraphs.length, 1);
  assert.ok(r.paragraphsRead.paragraphs[0].includes("[truncated]"), "首段超长必须标 [truncated] 让 LLM 知情");
  assert.equal(r.truncated, true);
  assert.equal(r.truncationReason, "firstParagraphTooLong");
  // review P3:总输出严格 ≤ maxChars(charCount 必须如实反映实际输出字符数)
  assert.ok(r.paragraphsRead.charCount <= 500, `charCount(${r.paragraphsRead.charCount}) 必须 ≤ maxChars(500)`);
  assert.equal(r.paragraphsRead.charCount, r.paragraphsRead.paragraphs[0].length, "charCount 必须是实际输出字符数");
  await rm(paths.workspace, { recursive: true, force: true });
});

test("ArtifactStore.readArtifact 段落用完时 truncationReason=null", async () => {
  const paths = makeTempPaths();
  const store = new ArtifactStore(paths);
  const m = await seedArtifact(store, { content: "段1。\n\n段2。\n\n段3。" });
  const r = await store.readArtifact({ artifactId: m.id, projectId: "proj1", limit: 10 });
  assert.equal(r.ok, true);
  assert.equal(r.totalParagraphs, 3);
  assert.equal(r.truncated, false);
  assert.equal(r.truncationReason, null);
  await rm(paths.workspace, { recursive: true, force: true });
});

// ============ Agent tool registry & execute ============

test("createBaseToolRegistry 包含 search_run_artifacts / read_artifact", () => {
  const reg = createBaseToolRegistry();
  assert.ok(reg.has("search_run_artifacts"));
  assert.ok(reg.has("read_artifact"));
  assert.ok(reg.has("recall_handoff"));
  assert.ok(reg.has("search_reference"));
});

test("searchRunArtifactsTool 缺 ctx 报错", async () => {
  const r1 = await searchRunArtifactsTool.execute({ query: "x" }, {});
  assert.equal(r1.ok, false);
  assert.match(r1.error, /artifactStore/);
  const r2 = await searchRunArtifactsTool.execute({ query: "x" }, { artifactStore: { searchArtifacts: () => {} } });
  assert.equal(r2.ok, false);
  assert.match(r2.error, /projectId/);
});

test("searchRunArtifactsTool 默认使用 task scope，不因 ctx.runId 产生入口分叉", async () => {
  const paths = makeTempPaths();
  const store = new ArtifactStore(paths);
  await seedArtifact(store, { runId: "current-run", content: "当前 run 的威士忌。" });
  await seedArtifact(store, { runId: "old-run", content: "旧 run 的威士忌。" });
  const r = await searchRunArtifactsTool.execute(
    { query: "威士忌", mode: "keyword" },
    { artifactStore: store, projectId: "proj1", taskId: "task1", runId: "current-run" }
  );
  assert.equal(r.ok, true);
  assert.ok(r.hits.length >= 2);
  assert.deepEqual(new Set(r.hits.map((hit) => hit.runId)), new Set(["current-run", "old-run"]));
  await rm(paths.workspace, { recursive: true, force: true });
});

test("searchRunArtifactsTool runId=\"*\" 跨 run 检索(仍限当前 task)", async () => {
  const paths = makeTempPaths();
  const store = new ArtifactStore(paths);
  await seedArtifact(store, { runId: "run-a", content: "A run 威士忌。" });
  await seedArtifact(store, { runId: "run-b", content: "B run 威士忌。" });
  const r = await searchRunArtifactsTool.execute(
    { query: "威士忌", runId: "*", mode: "keyword" },
    { artifactStore: store, projectId: "proj1", taskId: "task1", runId: "run-a" }
  );
  assert.equal(r.ok, true);
  const runIds = new Set(r.hits.map((h) => h.runId));
  assert.ok(runIds.size >= 2, "跨 run 应该看到两个 run 的命中");
  assert.equal(r.scope.taskId, "task1", "runId=\"*\" 应仍限定当前 task");
  await rm(paths.workspace, { recursive: true, force: true });
});

async function seedArtifactWithTask(store, taskId, runId, content) {
  return store.saveTextArtifact({
    projectId: "proj1", taskId, runId,
    stepId: "s1", artifactType: "step-output",
    title: "x", content, fileName: "output.md"
  });
}

test("searchRunArtifactsTool taskId=\"*\" 跨 task 检索(项目级)", async () => {
  const paths = makeTempPaths();
  const store = new ArtifactStore(paths);
  await seedArtifactWithTask(store, "taskA", "runA1", "task A 的威士忌。");
  await seedArtifactWithTask(store, "taskB", "runB1", "task B 的威士忌。");
  // ctx 当前在 taskA / runA1;默认应只看 taskA;taskId="*" 应跨 task
  const limited = await searchRunArtifactsTool.execute(
    { query: "威士忌", runId: "*", mode: "keyword" }, // 只跨 run,不跨 task
    { artifactStore: store, projectId: "proj1", taskId: "taskA", runId: "runA1" }
  );
  const limitedTasks = new Set(limited.hits.map((h) => h.title)); // 用 title 区分不行;改用 stepId 或别的;先看 modeUsed/total
  // 更直接:看 hits 中 taskId(我们没暴露 taskId,但 stepId 一样,只能间接验证 — total 应该 = 1)
  assert.equal(limited.total, 1, "默认 + runId=\"*\" 仍限定 task,只能看到 taskA 的 1 条");

  const cross = await searchRunArtifactsTool.execute(
    { query: "威士忌", runId: "*", taskId: "*", mode: "keyword" }, // 完全跨 task + 跨 run
    { artifactStore: store, projectId: "proj1", taskId: "taskA", runId: "runA1" }
  );
  assert.ok(cross.total >= 2, `taskId="*" 项目级检索应看到两个 task 的命中,实际 ${cross.total}`);
  assert.equal(cross.scope.taskId, "(any)");
  await rm(paths.workspace, { recursive: true, force: true });
});

test("readArtifactTool 两种定位方式都能用", async () => {
  const paths = makeTempPaths();
  const store = new ArtifactStore(paths);
  const m = await seedArtifact(store, {
    runId: "run-r", stepId: "step-s", artifactType: "draft",
    content: "段1。\n\n段2。\n\n段3。"
  });
  // 方式 A:artifactId
  const r1 = await readArtifactTool.execute(
    { artifactId: m.id },
    { artifactStore: store, projectId: "proj1", taskId: "task1", runId: "run-r" }
  );
  assert.equal(r1.ok, true);
  assert.equal(r1.totalParagraphs, 3);
  // 方式 B:stepId + artifactType
  const r2 = await readArtifactTool.execute(
    { runId: "run-r", stepId: "step-s", artifactType: "draft" },
    { artifactStore: store, projectId: "proj1", taskId: "task1", runId: "run-r" }
  );
  assert.equal(r2.ok, true);
  assert.equal(r2.totalParagraphs, 3);
  await rm(paths.workspace, { recursive: true, force: true });
});

test("readArtifactTool 缺定位字段错误返回", async () => {
  const paths = makeTempPaths();
  const store = new ArtifactStore(paths);
  const r = await readArtifactTool.execute(
    {},
    { artifactStore: store, projectId: "proj1", taskId: "task1", runId: "run-x" }
  );
  assert.equal(r.ok, false);
  await rm(paths.workspace, { recursive: true, force: true });
});
