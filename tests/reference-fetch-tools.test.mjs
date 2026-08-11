import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const {
  createBaseToolRegistry,
  searchReferenceTool,
  fetchUrlTool,
  DEFAULT_SUBAGENT_TOOL_NAMES
} = require("../src/platform/ai/agentTools/index.js");
const { ReferenceService } = require("../src/platform/research/referenceServices.js");

/**
 * stub referenceService.search —— 返回预设的 internet + local + notices。
 */
function makeStubReferenceService(payload) {
  return {
    invocations: [],
    async search(args) {
      this.invocations.push(args);
      return payload;
    }
  };
}

/**
 * stub webSearchService.fetchReadablePage —— 返回固定文本或抛错。
 */
function makeStubWebSearchService({ text = "", throws = null } = {}) {
  return {
    invocations: [],
    async fetchReadablePage(url, config) {
      this.invocations.push({ url, config });
      if (throws) throw new Error(throws);
      return text;
    }
  };
}

// ============ Registry & subagent default ============

test("createBaseToolRegistry 包含 search_reference / fetch_url", () => {
  const reg = createBaseToolRegistry();
  assert.ok(reg.has("search_reference"));
  assert.ok(reg.has("fetch_url"));
});

test("DEFAULT_SUBAGENT_TOOL_NAMES 含 search_reference + fetch_url(对齐 Claude Code 子 agent 也带 WebSearch/Fetch)", () => {
  assert.ok(DEFAULT_SUBAGENT_TOOL_NAMES.includes("search_reference"));
  assert.ok(DEFAULT_SUBAGENT_TOOL_NAMES.includes("fetch_url"));
});

// ============ search_reference ============

test("searchReferenceTool 缺 ctx.referenceService 报错", async () => {
  const r = await searchReferenceTool.execute({ query: "x" }, {});
  assert.equal(r.ok, false);
  assert.match(r.error, /referenceService/);
});

test("searchReferenceTool 空 query 报错", async () => {
  const stub = makeStubReferenceService({ internet: [], local: [], notices: [] });
  const r = await searchReferenceTool.execute({ query: "  " }, { referenceService: stub });
  assert.equal(r.ok, false);
  assert.match(r.error, /query/);
});

test("searchReferenceTool 透传 query/scope/projectId 到底层 + 精简返回字段", async () => {
  const stub = makeStubReferenceService({
    internet: [
      { title: "T1", url: "https://a", snippet: "s1", datePublished: "2026-01-01", searchProvider: "bing" },
      { title: "T2", url: "https://b", snippet: "s2" }
    ],
    local: [{ name: "L1", path: "/x", snippet: "ls1" }],
    notices: ["fyi"]
  });
  const r = await searchReferenceTool.execute(
    { query: "威士忌", scope: "internet", topInternet: 1 },
    { referenceService: stub, projectId: "p1", taskId: "t1" }
  );
  assert.equal(r.ok, true);
  assert.equal(stub.invocations[0].query, "威士忌");
  assert.equal(stub.invocations[0].scope, "internet");
  assert.equal(stub.invocations[0].projectId, "p1");
  assert.equal(stub.invocations[0].taskId, "t1");
  assert.equal(r.internet.length, 1, "topInternet=1 应该只返回 1 条");
  assert.equal(r.internet[0].source, "bing", "source 应该来自 searchProvider");
  assert.equal(r.internet[0].date, "2026-01-01");
  // 精简字段:没有多余的 raw HTTP 字段
  assert.ok(!("rawHtml" in r.internet[0]));
});

test("ReferenceService 联网检索只执行模型给出的一条原始 query", async () => {
  const invocations = [];
  const webSearchService = {
    async searchConfiguredOrPublic(query, config) {
      invocations.push({ query, config });
      return [
        { title: "第一条", url: "https://example.com/1", snippet: "A", searchProvider: "stub" },
        { title: "第二条", url: "https://example.com/2", snippet: "B", searchProvider: "stub" }
      ];
    }
  };
  const service = new ReferenceService(
    {},
    { get: async () => ({}) },
    webSearchService,
    null
  );
  const result = await service.searchInternet("模型指定的精确检索词", {}, { maxInternetResults: 10 });

  assert.equal(invocations.length, 1);
  assert.equal(invocations[0].query, "模型指定的精确检索词");
  assert.deepEqual(result.results.map((item) => item.title), ["第一条", "第二条"]);
});

test("searchReferenceTool 默认 scope=all,topInternet/topLocal 钳到上限", async () => {
  const stub = makeStubReferenceService({
    internet: Array.from({ length: 20 }, (_, i) => ({ title: `T${i}`, url: `https://u${i}`, snippet: `s${i}` })),
    local: Array.from({ length: 12 }, (_, i) => ({ name: `L${i}`, snippet: "ls" })),
    notices: []
  });
  const r = await searchReferenceTool.execute(
    { query: "x", topInternet: 999, topLocal: 999 },
    { referenceService: stub }
  );
  assert.equal(r.ok, true);
  assert.equal(r.scope, "all", "默认 scope 应该是 all");
  assert.ok(r.internet.length <= 12, `topInternet 应被钳到 12,实际 ${r.internet.length}`);
  assert.ok(r.local.length <= 8, `topLocal 应被钳到 8,实际 ${r.local.length}`);
});

test("searchReferenceTool 底层抛错 → tool 返回 ok:false", async () => {
  const stub = {
    async search() { throw new Error("upstream 502"); }
  };
  const r = await searchReferenceTool.execute({ query: "x" }, { referenceService: stub });
  assert.equal(r.ok, false);
  assert.match(r.error, /502/);
});

test("searchReferenceTool 无效 scope 回退到 all(不抛错)", async () => {
  const stub = makeStubReferenceService({ internet: [], local: [], notices: [] });
  const r = await searchReferenceTool.execute(
    { query: "x", scope: "garbage" },
    { referenceService: stub }
  );
  assert.equal(r.ok, true);
  assert.equal(stub.invocations[0].scope, "all", "非法 scope 应被规范为 all");
});

test("searchReferenceTool 透传预取消 ctx.signal 并返回取消结果", async () => {
  const controller = new AbortController();
  const reason = new Error("search cancelled by host");
  controller.abort(reason);
  let observedSignal = null;
  const stub = {
    async search(args) {
      observedSignal = args.signal;
      if (args.signal?.aborted) throw args.signal.reason;
      return { internet: [], local: [], notices: [] };
    }
  };

  const result = await searchReferenceTool.execute(
    { query: "取消中的检索" },
    { referenceService: stub, signal: controller.signal }
  );
  assert.equal(observedSignal, controller.signal);
  assert.equal(result.ok, false);
  assert.match(result.error, /search cancelled by host/);
});

test("本地资料检索与预览都拒绝符号链接越界", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "yaoguo-reference-root-"));
  const outside = mkdtempSync(join(tmpdir(), "yaoguo-reference-outside-"));
  try {
    mkdirSync(join(workspace, "memory"), { recursive: true });
    const secret = join(outside, "secret.md");
    const linked = join(workspace, "memory", "linked-secret.md");
    writeFileSync(secret, "UNIQUE-SYMLINK-SECRET", "utf8");
    symlinkSync(secret, linked);
    const service = new ReferenceService({
      projectRoot: workspace,
      workspace,
      memoryDir: join(workspace, "memory"),
      workflowsDir: join(workspace, "workflows"),
      assetsDir: join(workspace, "assets")
    }, { get: async () => ({ referenceSearch: {} }) }, null, null);
    const rows = [];
    await service.collectSearchableFiles(join(workspace, "memory"), rows, join(workspace, "memory"), {});
    assert.deepEqual(rows, []);
    await assert.rejects(() => service.preview({ sourceType: "local", absolute: linked }), /符号链接|realpath/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("本地资料检索只跳过旧项目 memory 位置，不误伤普通同名资料目录", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "yaoguo-reference-memory-dir-"));
  try {
    const projectsDir = join(workspace, "projects");
    const projectDir = join(projectsDir, "p1");
    for (const directory of [
      join(projectDir, "memory"),
      join(projectDir, "tasks", "t1", "memory"),
      join(projectDir, "assets", "memory"),
      join(projectDir, "tasks", "t1", "sources", "memory")
    ]) mkdirSync(directory, { recursive: true });
    writeFileSync(join(projectDir, "memory", "legacy-project.md"), "旧项目记忆", "utf8");
    writeFileSync(join(projectDir, "tasks", "t1", "memory", "legacy-task.md"), "旧任务记忆", "utf8");
    writeFileSync(join(projectDir, "assets", "memory", "reference.md"), "正常资料", "utf8");
    writeFileSync(join(projectDir, "tasks", "t1", "sources", "memory", "source.md"), "正常源码资料", "utf8");
    const service = new ReferenceService({
      projectRoot: workspace,
      workspace,
      projectsDir,
      assetsDir: join(workspace, "assets")
    }, { get: async () => ({ referenceSearch: {} }) }, null, null);
    const rows = [];

    await service.collectSearchableFiles(projectDir, rows, projectDir, {});

    assert.deepEqual(rows.map((row) => row.relative).sort(), [
      join("assets", "memory", "reference.md"),
      join("tasks", "t1", "sources", "memory", "source.md")
    ]);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

// ============ fetch_url ============

test("fetchUrlTool 缺 ctx.webSearchService 报错", async () => {
  const r = await fetchUrlTool.execute({ url: "https://x" }, {});
  assert.equal(r.ok, false);
  assert.match(r.error, /webSearchService/);
});

test("fetchUrlTool 空 url 报错", async () => {
  const stub = makeStubWebSearchService({ text: "" });
  const r = await fetchUrlTool.execute({ url: "  " }, { webSearchService: stub });
  assert.equal(r.ok, false);
  assert.match(r.error, /url/i);
});

test("fetchUrlTool 无效 URL 格式报错", async () => {
  const stub = makeStubWebSearchService({ text: "" });
  const r = await fetchUrlTool.execute({ url: "not a url" }, { webSearchService: stub });
  assert.equal(r.ok, false);
  assert.match(r.error, /url/i);
});

test("fetchUrlTool 拒绝非 http(s) 协议(防越权)", async () => {
  const stub = makeStubWebSearchService({ text: "" });
  for (const url of ["file:///etc/passwd", "ftp://x.com/y", "data:text/html,abc"]) {
    const r = await fetchUrlTool.execute({ url }, { webSearchService: stub });
    assert.equal(r.ok, false, `${url} 必须被拒绝`);
    assert.match(r.error, /http/);
  }
});

test("fetchUrlTool 正常抓取返回 content + contentLength", async () => {
  const stub = makeStubWebSearchService({ text: "网页的可读正文" });
  const r = await fetchUrlTool.execute(
    { url: "https://8.8.8.8/article" },
    { webSearchService: stub }
  );
  assert.equal(r.ok, true);
  assert.equal(r.content, "网页的可读正文");
  assert.equal(r.contentLength, "网页的可读正文".length);
  assert.equal(r.url, "https://8.8.8.8/article");
  assert.equal(r.truncated, false);
  assert.equal(r.maxCharsApplied, 8000, "默认 maxChars=8000");
  assert.equal(stub.invocations[0].config.readerFallback, false, "不得把已授权 URL 隐式转发给第三方 Reader");
});

test("fetchUrlTool 透传预取消 ctx.signal 并返回取消结果", async () => {
  const controller = new AbortController();
  const reason = new Error("fetch cancelled by host");
  controller.abort(reason);
  let observedSignal = null;
  const stub = {
    async fetchReadablePage(_url, config) {
      observedSignal = config.signal;
      if (config.signal?.aborted) throw config.signal.reason;
      return "不应返回正文";
    }
  };

  const result = await fetchUrlTool.execute(
    { url: "https://8.8.8.8/cancelled" },
    { webSearchService: stub, signal: controller.signal }
  );
  assert.equal(observedSignal, controller.signal);
  assert.equal(result.ok, false);
  assert.match(result.error, /fetch cancelled by host/);
});

test("fetchUrlTool maxChars 钳到边界 [1000, 30000] 并透传给 fetchReadablePage", async () => {
  const stub = makeStubWebSearchService({ text: "x".repeat(100) });
  // 小于下限 → 钳到 1000
  await fetchUrlTool.execute({ url: "https://8.8.8.8/a", maxChars: 100 }, { webSearchService: stub });
  assert.equal(stub.invocations.at(-1).config.maxPreviewChars, 1000);
  // 大于上限 → 钳到 30000
  await fetchUrlTool.execute({ url: "https://8.8.8.8/b", maxChars: 999999 }, { webSearchService: stub });
  assert.equal(stub.invocations.at(-1).config.maxPreviewChars, 30000);
});

test("fetchUrlTool 输出长度 ≥ maxChars 时 truncated=true", async () => {
  const stub = makeStubWebSearchService({ text: "x".repeat(8000) }); // 正好等于默认 maxChars
  const r = await fetchUrlTool.execute({ url: "https://8.8.8.8/x" }, { webSearchService: stub });
  assert.equal(r.ok, true);
  assert.equal(r.truncated, true, "长度 = maxChars 视为可能被截过");
});

test("fetchUrlTool 底层抓取失败 → tool 返回 ok:false 不崩", async () => {
  const stub = makeStubWebSearchService({ throws: "网页抓取失败 404" });
  const r = await fetchUrlTool.execute({ url: "https://8.8.8.8/dead" }, { webSearchService: stub });
  assert.equal(r.ok, false);
  assert.match(r.error, /404/);
});
