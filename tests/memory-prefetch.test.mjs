import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, utimes } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  MemoryStore,
  TYPE_BASIS,
  PREFETCH_FRONT_MATTER_LINES
} = require("../src/platform/memory/memoryStore.js");
const {
  MemoryPrefetchService,
  MAX_PREFETCH_FILES,
  normalizePrefetchSelection,
  renderPrefetchContext
} = require("../src/platform/memory/prefetch/index.js");
const { memoryFreshness } = require("../src/platform/memory/memdir/memdirFormat.js");

async function makeStore() {
  const root = await mkdtemp(path.join(tmpdir(), "yaoguo-prefetch-"));
  return { root, store: new MemoryStore({ workspaceRoot: root }) };
}

function memory(topic, overrides = {}) {
  return {
    type: "user",
    basis: TYPE_BASIS.user,
    topic,
    name: `主题 ${topic}`,
    description: `关于 ${topic} 的用户协作偏好。`,
    content: `正文哨兵 ${topic}：这是只能在选中后读取的主题正文。`,
    valueBeyondCode: "这是用户本人确认的跨会话偏好，无法从代码推导。",
    ...overrides
  };
}

function registry() {
  return {
    async getPromptBlock(id, options) {
      assert.equal(id, "block://memory.prefetch");
      assert.equal(options.required, true);
      return { asset: { content: "从 candidates 中选择 0-5 个 file，只输出 JSON。" } };
    }
  };
}

test("Prefetch 选择任务是注册 Prompt，并明确保守选择与工具文档降权", async () => {
  const asset = JSON.parse(await readFile(
    path.join(process.cwd(), "workspace/registries/prompts/blocks/memory.prefetch.v1.json"),
    "utf8"
  ));
  assert.equal(asset.id, "block://memory.prefetch");
  assert.match(asset.content, /0-5 个/);
  assert.match(asset.content, /证据不足或相关性不明确时返回空数组/);
  assert.match(asset.content, /recent_tools/);
  assert.match(asset.content, /不得使用关键词计数、向量分数/);
});

test("Prefetch 扫描只解析每个主题前 30 行 front matter，不读取正文作为候选", async () => {
  const { store } = await makeStore();
  await store.append(memory("visible"));
  const info = await store.info();
  const lateHeader = [
    "---",
    'name: "第 31 行才闭合"',
    'description: "该文件不应成为 Prefetch 候选。"',
    "type: user",
    'created_at: "2026-08-09T00:00:00.000Z"',
    'updated_at: "2026-08-09T00:00:00.000Z"',
    ...Array.from({ length: 24 }, (_, index) => `extra_${index}: value`),
    "---",
    "第 31 行之后的正文。",
    ""
  ].join("\n");
  await writeFile(path.join(info.memoryDirectory, "user-late-header.md"), lateHeader, "utf8");

  const candidates = await store.scanPrefetchMetadata();
  assert.equal(PREFETCH_FRONT_MATTER_LINES, 30);
  assert.deepEqual(candidates.map((candidate) => candidate.file), ["user-visible.md"]);
  assert.equal("body" in candidates[0], false);
  assert.doesNotMatch(JSON.stringify(candidates), /正文哨兵/);
  const index = await readFile(path.join(info.memoryDirectory, "memory.md"), "utf8");
  assert.doesNotMatch(index, /user-late-header\.md/);
});

test("旁路模型只接收未展示的 front matter 元数据，并用轻量独立调用返回最多 5 篇", async () => {
  const { store } = await makeStore();
  await store.append(memory("shown"));
  await store.append(memory("selected"));
  const calls = [];
  const aiRouter = {
    async runTaskDetailed(args) {
      calls.push(args);
      return { content: '{"files":["user-selected.md"]}' };
    }
  };
  const service = new MemoryPrefetchService({
    aiRouter,
    registryService: registry(),
    clock: () => new Date("2026-08-09T12:00:00.000Z")
  });
  const turn = service.beginTurn({
    memoryStore: store,
    conversation: [
      { role: "user", content: "按我的长期评审偏好处理。" },
      { role: "assistant", content: "我会先核对相关上下文。" }
    ],
    shownFiles: ["user-shown.md"],
    recentTools: ["fetch_url", "read"],
    projectId: "p1",
    taskId: "t1",
    turnId: "turn-1"
  });
  await turn.settled();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].internalCall, true);
  assert.equal(calls[0].jsonMode, true);
  assert.equal(calls[0].thinkingOverride, "disabled");
  assert.equal(calls[0].maxOutputTokens, 512);
  assert.equal("memoryTopK" in calls[0], false);
  const input = JSON.parse(calls[0].input);
  assert.deepEqual(input.recent_tools, ["fetch_url", "read"]);
  assert.deepEqual(input.candidates.map((candidate) => candidate.file), ["user-selected.md"]);
  assert.doesNotMatch(calls[0].input, /正文哨兵/);

  const context = turn.takeReadyContext();
  assert.match(context, /<long-term-memory-prefetch selector="sidecar-model">/);
  assert.match(context, /user-selected\.md/);
  assert.match(context, /正文哨兵 selected/);
  assert.equal(turn.takeReadyContext(), "", "同一篇 Prefetch 正文不能在同一 turn 重复注入");
  assert.deepEqual(turn.summary().shownFiles, ["user-selected.md"]);
  assert.equal(MAX_PREFETCH_FILES, 5);
});

test("Prefetch 真正异步启动，旁路未完成时主链可继续且不等待", async () => {
  const { store } = await makeStore();
  await store.append(memory("async"));
  let releaseSelector;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const aiRouter = {
    async runTaskDetailed() {
      markStarted();
      return new Promise((resolve) => {
        releaseSelector = () => resolve({ content: '{"files":["user-async.md"]}' });
      });
    }
  };
  const service = new MemoryPrefetchService({ aiRouter, registryService: registry() });
  const turn = service.beginTurn({
    memoryStore: store,
    conversation: [{ role: "user", content: "当前请求" }]
  });

  assert.equal(turn.status, "pending");
  assert.equal(turn.takeReadyContext(), "");
  await started;
  assert.equal(turn.status, "pending");
  assert.equal(turn.takeReadyContext(), "");
  releaseSelector();
  await turn.settled();
  assert.match(turn.takeReadyContext(), /user-async\.md/);
});

test("筛选输出超过 5 篇或包含候选外文件时保守返回空选择", () => {
  const candidates = Array.from({ length: 6 }, (_, index) => ({ file: `user-topic-${index}.md` }));
  assert.deepEqual(
    normalizePrefetchSelection({ files: candidates.map((candidate) => candidate.file) }, candidates),
    []
  );
  assert.deepEqual(
    normalizePrefetchSelection({ files: ["user-not-present.md"] }, candidates),
    []
  );
  assert.deepEqual(
    normalizePrefetchSelection({ files: [] }, candidates),
    []
  );
});

test("召回记忆使用自然语言年龄，超过 1 天附带时间快照警告", async () => {
  const now = new Date("2026-08-09T12:00:00.000Z");
  assert.deepEqual(memoryFreshness({ updatedAt: "2026-08-09T01:00:00.000Z" }, now), {
    timestamp: "2026-08-09T01:00:00.000Z",
    age: "今天",
    ageDays: 0,
    stale: false,
    warning: ""
  });
  assert.equal(memoryFreshness({ updatedAt: "2026-08-08T01:00:00.000Z" }, now).age, "昨天");
  const stale = memoryFreshness({ updatedAt: "2026-06-23T01:00:00.000Z" }, now);
  assert.equal(stale.age, "47 天前");
  assert.match(stale.warning, /时间快照.*不是实时状态.*验证当前事实/);

  const rendered = renderPrefetchContext([{
    file: "project-deadline.md",
    type: "project",
    name: "截止日期",
    description: "历史评审截止日期。",
    content: "评审日期曾设为 2026-06-23。",
    age: stale.age,
    freshnessWarning: stale.warning
  }]);
  assert.match(rendered, /age="47 天前"/);
  assert.match(rendered, /<freshness-warning>/);

  const { store } = await makeStore();
  const saved = await store.append(memory("old"));
  const info = await store.info();
  const file = path.join(info.memoryDirectory, saved.file);
  const oldTime = "2026-06-23T01:00:00.000Z";
  const source = (await readFile(file, "utf8"))
    .replace(/created_at: ".*?"/, `created_at: "${oldTime}"`)
    .replace(/updated_at: ".*?"/, `updated_at: "${oldTime}"`);
  await writeFile(file, source, "utf8");
  await utimes(file, new Date(oldTime), new Date(oldTime));
  const [recalled] = await store.search({ files: [saved.file], now });
  assert.equal(recalled.age, "47 天前");
  assert.match(recalled.freshnessWarning, /引用前需要验证当前事实/);
});
