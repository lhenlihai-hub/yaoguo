import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  rm,
  stat,
  utimes,
  writeFile
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { MemoryStore, TYPE_BASIS } = require("../src/platform/memory/memoryStore.js");
const {
  AutoDreamService,
  AutoDreamStateStore,
  AUTO_DREAM_LOCK_FILE,
  AUTO_DREAM_MIN_INTERVAL_MS,
  AUTO_DREAM_MIN_SESSIONS,
  MAX_AUTO_DREAM_ROUNDS,
  createAutoDreamToolRegistry
} = require("../src/platform/memory/autodream/index.js");

function toolCall(id, name, args = {}) {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

function detailedRouter(responder) {
  const calls = [];
  const invoke = async (args, continuation) => {
    const value = await responder(args, calls.length, continuation);
    calls.push({ args, continuation });
    const content = typeof value === "string" ? value : `${value?.content || ""}`;
    const toolCalls = Array.isArray(value?.toolCalls) ? value.toolCalls : [];
    return {
      content,
      toolCalls,
      finishReason: toolCalls.length ? "tool_calls" : "stop",
      requestMessages: continuation ? (args.messages || []) : [{ role: "user", content: args.input || "" }],
      assistantMessage: {
        role: "assistant",
        content: content || null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {})
      }
    };
  };
  return {
    calls,
    runTaskDetailed: (args) => invoke(args, false),
    continueTaskDetailed: (args) => invoke(args, true)
  };
}

async function memoryFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "yaoguo-autodream-"));
  const store = new MemoryStore({ workspaceRoot: root });
  await store.append({
    type: "project",
    basis: TYPE_BASIS.project,
    topic: "release",
    name: "发布约定",
    description: "项目发布期限与目标。",
    content: "项目发布截止日期为 2026-08-20。",
    valueBeyondCode: "这是用户确认的代码外期限。"
  });
  return { root, store };
}

test("AutoDream Prompt 固化双门控、四阶段、旧事实删除与 12 轮预算", async () => {
  const asset = JSON.parse(await readFile(
    path.join(process.cwd(), "workspace/registries/prompts/blocks/memory.autodream.v1.json"),
    "utf8"
  ));
  assert.equal(asset.id, "block://memory.autodream");
  assert.match(asset.content, /indexed 模式同时满足.*24 小时与至少 5 个不同会话/);
  assert.match(asset.content, /append-only 模式同时满足 24 小时与至少 1 个新记忆会话/);
  assert.match(asset.content, /logs\/\{date\}\.md/);
  assert.match(asset.content, /name=\"orient\"/);
  assert.match(asset.content, /name=\"gather\"/);
  assert.match(asset.content, /name=\"consolidate\"/);
  assert.match(asset.content, /name=\"prune-and-index\"/);
  assert.match(asset.content, /直接移除旧事实/);
  assert.match(asset.content, /最多 12 个模型回合/);
  assert.equal(MAX_AUTO_DREAM_ROUNDS, 12);
});

test("时间与不同会话双门控必须同时满足，同一会话重复写只计一次", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "yaoguo-autodream-gate-"));
  let now = new Date("2026-08-01T00:00:00.000Z");
  const state = new AutoDreamStateStore({ memoryDirectory: root, clock: () => now });
  try {
    for (const session of ["s1", "s1", "s2", "s3", "s4"]) {
      await state.recordSession({ sessionId: session });
    }
    assert.equal((await state.evaluate()).code, "TIME_AND_SESSION_GATE");
    now = new Date(now.getTime() + AUTO_DREAM_MIN_INTERVAL_MS + 1000);
    const onlyFour = await state.evaluate();
    assert.equal(onlyFour.sessionCount, 4);
    assert.equal(onlyFour.code, "SESSION_GATE");
    await state.recordSession({ sessionId: "s5" });
    const eligible = await state.evaluate();
    assert.equal(AUTO_DREAM_MIN_SESSIONS, 5);
    assert.equal(eligible.sessionCount, 5);
    assert.equal(eligible.code, "ELIGIBLE");
    assert.equal(eligible.eligible, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("PID + 令牌复读竞争让后写实例获锁，先写实例退让", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "yaoguo-autodream-lock-"));
  const now = new Date("2026-08-10T00:00:00.000Z");
  let releaseFirst;
  let firstWrote;
  const firstWriteSeen = new Promise((resolve) => { firstWrote = resolve; });
  const firstRelease = new Promise((resolve) => { releaseFirst = resolve; });
  let settles = 0;
  const first = new AutoDreamStateStore({
    memoryDirectory: root,
    clock: () => now,
    pid: 111,
    tokenFactory: () => "first",
    settle: async () => {
      settles += 1;
      if (settles === 1) {
        firstWrote();
        await firstRelease;
      }
    }
  });
  const second = new AutoDreamStateStore({
    memoryDirectory: root,
    clock: () => now,
    pid: 222,
    tokenFactory: () => "second",
    settle: async () => {}
  });
  try {
    for (let index = 1; index <= 5; index += 1) {
      await first.recordSession({ sessionId: `session-${index}` });
    }
    const lock = path.join(root, AUTO_DREAM_LOCK_FILE);
    const old = new Date(now.getTime() - AUTO_DREAM_MIN_INTERVAL_MS - 1000);
    await utimes(lock, old, old);
    const firstAttempt = first.acquire();
    await firstWriteSeen;
    const secondLease = await second.acquire();
    assert.equal(secondLease.acquired, true);
    releaseFirst();
    const firstLease = await firstAttempt;
    assert.equal(firstLease.acquired, false);
    assert.equal(firstLease.code, "LOCK_CONTENDED");
    assert.equal(await second.owns(secondLease), true);
    const owner = JSON.parse(await readFile(lock, "utf8"));
    assert.equal(owner.pid, 222);
    assert.match(owner.token, /^222:second$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("整合失败恢复锁 mtime，使下一次仍可触发", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "yaoguo-autodream-rollback-"));
  const now = new Date("2026-08-10T00:00:00.000Z");
  const state = new AutoDreamStateStore({ memoryDirectory: root, clock: () => now, settle: async () => {} });
  try {
    for (let index = 1; index <= 5; index += 1) await state.recordSession({ sessionId: `s${index}` });
    const lock = path.join(root, AUTO_DREAM_LOCK_FILE);
    const old = new Date(now.getTime() - AUTO_DREAM_MIN_INTERVAL_MS - 1000);
    await utimes(lock, old, old);
    const before = await stat(lock);
    const lease = await state.acquire();
    assert.equal(lease.acquired, true);
    const restored = await state.rollback(lease);
    assert.equal(restored.restored, true);
    const after = await stat(lock);
    assert.equal(Math.floor(after.mtimeMs), Math.floor(before.mtimeMs));
    assert.equal((await state.evaluate()).eligible, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("四阶段工具把近似主题合并，旧事实直接消失并重建纯索引", async () => {
  const fixture = await memoryFixture();
  await fixture.store.append({
    type: "project",
    basis: TYPE_BASIS.project,
    topic: "release-copy",
    name: "发布期限副本",
    description: "与发布约定重复的旧期限。",
    content: "旧说法：项目发布截止日期为 2026-08-15。",
    valueBeyondCode: "这是用户曾提供的代码外期限。"
  });
  const snapshot = await fixture.store.createReshapeSnapshot();
  const tools = createAutoDreamToolRegistry({
    memoryStore: fixture.store,
    snapshot,
    canonicalRoot: fixture.root,
    guard: async () => true,
    completeLease: async () => ({ completedAt: "2026-08-10T00:00:00.000Z" }),
    clock: () => new Date("2026-08-10T00:00:00.000Z")
  });
  try {
    assert.equal((await tools.registry.execute("orient", {})).phase, "gather");
    await tools.registry.execute("read_memory", { file: "project-release.md" });
    await tools.registry.execute("read_memory", { file: "project-release-copy.md" });
    assert.equal((await tools.registry.execute("begin_consolidate", { findings: "两个主题重复且期限冲突。" })).phase, "consolidate");
    assert.equal((await tools.registry.execute("rewrite_memory", {
      file: "project-release.md",
      type: "project",
      name: "发布约定",
      description: "项目发布期限与目标。",
      body: "项目发布截止日期为 2026-08-30。",
      reason: "用户的新期限推翻两个旧期限。"
    })).ok, true);
    assert.equal((await tools.registry.execute("delete_memory", {
      file: "project-release-copy.md",
      reason: "内容已合并到 project-release.md。"
    })).ok, true);
    assert.equal((await tools.registry.execute("begin_prune", { summary: "删除重复主题并压缩索引。" })).phase, "prune");
    const finished = await tools.registry.execute("finish_autodream", {});
    assert.equal(finished.ok, true, JSON.stringify(finished));
    const stored = await fixture.store.search({ files: ["project-release.md"], limit: 1 });
    assert.match(stored[0].content, /2026-08-30/);
    assert.doesNotMatch(stored[0].content, /2026-08-20|2026-08-15|已过时/);
    assert.equal((await fixture.store.search({ files: ["project-release-copy.md"], limit: 1 })).length, 0);
    const index = await fixture.store.readIndex();
    assert.match(index, /project-release\.md/);
    assert.doesNotMatch(index, /project-release-copy\.md/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("AutoDream 提交拒绝相对日期与整合期间的新记忆覆盖", async () => {
  const fixture = await memoryFixture();
  try {
    const relativeSnapshot = await fixture.store.createReshapeSnapshot();
    await assert.rejects(
      fixture.store.applyReshape({
        snapshotDigest: relativeSnapshot.digest,
        replacements: [{
          file: "project-release.md",
          type: "project",
          name: "发布约定",
          description: "项目下周发布。",
          body: "项目计划下周五发布。"
        }],
        deletions: []
      }),
      (error) => error?.code === "MEMDIR_RELATIVE_DATE_REJECTED"
    );
    const staleSnapshot = await fixture.store.createReshapeSnapshot();
    await fixture.store.append({
      type: "feedback",
      basis: TYPE_BASIS.feedback,
      topic: "concise",
      name: "简洁反馈",
      description: "用户确认简洁回答有效。",
      content: "用户确认简洁回答有效并要求复用。",
      valueBeyondCode: "这是用户对 AI 行为的正向反馈。",
      polarity: "positive"
    });
    await assert.rejects(
      fixture.store.applyReshape({ snapshotDigest: staleSnapshot.digest, replacements: [], deletions: [] }),
      (error) => error?.code === "MEMDIR_RESHAPE_CONFLICT"
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("第五个会话满足双门控后才运行模型驱动四阶段，前四次不调用模型", async () => {
  const fixture = await memoryFixture();
  const transcript = path.join(fixture.root, "recent-transcript.md");
  await writeFile(transcript, "用户：发布日期改为 2026-08-30。\n助手：已确认。\n", "utf8");
  let now = new Date("2026-08-01T00:00:00.000Z");
  const router = detailedRouter(async (_args, round) => {
    if (round === 0) return { toolCalls: [toolCall("orient", "orient")] };
    if (round === 1) {
      return {
        toolCalls: [
          ...Array.from({ length: 5 }, (_, index) => toolCall(`log-${index + 1}`, "read_transcript", { session: `session-${index + 1}` })),
          toolCall("read-release", "read_memory", { file: "project-release.md" })
        ]
      };
    }
    if (round === 2) return { toolCalls: [toolCall("consolidate", "begin_consolidate", { findings: "用户提供了新的绝对发布日期。" })] };
    if (round === 3) {
      return { toolCalls: [toolCall("rewrite", "rewrite_memory", {
        file: "project-release.md",
        type: "project",
        name: "发布约定",
        description: "项目发布期限与目标。",
        body: "项目发布截止日期为 2026-08-30。",
        reason: "最近会话中的新事实推翻旧期限。"
      })] };
    }
    if (round === 4) return { toolCalls: [toolCall("prune", "begin_prune", { summary: "旧期限已直接移除。" })] };
    if (round === 5) return { toolCalls: [toolCall("finish", "finish_autodream")] };
    return "DONE";
  });
  const audits = [];
  const service = new AutoDreamService({
    aiRouter: router,
    registryService: {
      async getPromptBlock(id, options) {
        assert.equal(id, "block://memory.autodream");
        assert.equal(options.required, true);
        return { asset: { content: "按四阶段调用工具并完成整合。" } };
      }
    },
    taskSessionStore: {
      async externalizeHistory() { return { absolute: transcript, bytes: 50 }; },
      async appendEvent(row) { audits.push(row); return row; }
    },
    clock: () => now
  });
  try {
    const first = await service.scheduleMemoryWrite({
      projectId: "p1", taskId: "t1", turnId: "turn-1", memoryStore: fixture.store
    }).settled();
    assert.equal(first.code, "TIME_AND_SESSION_GATE");
    now = new Date(now.getTime() + AUTO_DREAM_MIN_INTERVAL_MS + 1000);
    for (let index = 2; index <= 4; index += 1) {
      const skipped = await service.scheduleMemoryWrite({
        projectId: `p${index}`, taskId: `t${index}`, turnId: `turn-${index}`, memoryStore: fixture.store
      }).settled();
      assert.equal(skipped.code, "SESSION_GATE");
    }
    assert.equal(router.calls.length, 0);
    const completed = await service.scheduleMemoryWrite({
      projectId: "p5", taskId: "t5", turnId: "turn-5", memoryStore: fixture.store
    }).settled();
    assert.equal(completed.code, "AUTODREAM_COMPLETED", JSON.stringify(completed));
    assert.equal(completed.sessionCount, 5);
    assert.equal(router.calls.length, 7);
    assert.equal(router.calls[0].args.title, "AutoDream 离线整合 Agent");
    assert.equal(router.calls[0].args.internalCall, true);
    assert.equal(router.calls[0].args.thinkingOverride, "high");
    assert.equal(router.calls[0].args.maxOutputTokens, 8192);
    assert.equal(audits.at(-1).type, "memory.autodream.completed");
    const stored = await fixture.store.search({ files: ["project-release.md"], limit: 1 });
    assert.match(stored[0].content, /2026-08-30/);
    const lock = path.join((await fixture.store.info()).memoryDirectory, AUTO_DREAM_LOCK_FILE);
    assert.equal(JSON.parse(await readFile(lock, "utf8")).state, "idle");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
