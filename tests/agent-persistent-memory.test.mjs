import test from "node:test";
import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat
} from "node:fs/promises";
import { constants } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const {
  MemoryStore,
  TYPE_BASIS,
  AGENT_MEMORY_SCOPES,
  MEMORY_LOG_PATH_PATTERN
} = require("../src/platform/memory/memoryStore.js");
const {
  AutoDreamService,
  AutoDreamStateStore,
  AUTO_DREAM_APPEND_ONLY_MIN_SESSIONS,
  AUTO_DREAM_MIN_INTERVAL_MS,
  createAutoDreamToolRegistry,
  nextNightlyDelay
} = require("../src/platform/memory/autodream/index.js");

function memory(overrides = {}) {
  const type = overrides.type || "feedback";
  return {
    type,
    basis: TYPE_BASIS[type],
    topic: "review-style",
    name: "评审方式",
    description: "用户确认先给证据再给建议的评审方式有效。",
    content: "用户确认先给证据再给建议的评审方式有效，应继续复用。",
    valueBeyondCode: "这是用户对 Agent 行为的明确反馈。",
    polarity: type === "feedback" ? "positive" : undefined,
    ...overrides
  };
}

test("Agent 记忆使用 agent/project/local 三个宿主作用域并按 Agent 类型隔离", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "yaoguo-agent-memory-scopes-"));
  const left = path.join(root, "left");
  const right = path.join(root, "right");
  const baseDirectory = path.join(root, "home", "projects");
  await Promise.all([
    mkdir(left, { recursive: true }),
    mkdir(right, { recursive: true })
  ]);
  const execFileImpl = async () => { throw new Error("not git"); };
  const store = new MemoryStore({ baseDirectory, execFileImpl });
  try {
    const sharedLeft = await store.forContext({
      workspaceRoot: left, agentType: "code-review", memoryScope: "agent"
    });
    const sharedRight = await store.forContext({
      workspaceRoot: right, agentType: "code-review", memoryScope: "agent"
    });
    const testing = await store.forContext({
      workspaceRoot: left, agentType: "testing", memoryScope: "agent"
    });
    const localLeft = await store.forContext({
      workspaceRoot: left, agentType: "code-review", memoryScope: "local"
    });
    const localRight = await store.forContext({
      workspaceRoot: right, agentType: "code-review", memoryScope: "local"
    });
    const project = await store.forContext({
      workspaceRoot: left, agentType: "code-review", memoryScope: "project"
    });
    assert.deepEqual(AGENT_MEMORY_SCOPES, ["agent", "project", "local"]);
    assert.equal((await sharedLeft.info()).memoryDirectory, (await sharedRight.info()).memoryDirectory);
    assert.notEqual((await sharedLeft.info()).memoryDirectory, (await testing.info()).memoryDirectory);
    assert.notEqual((await localLeft.info()).memoryDirectory, (await localRight.info()).memoryDirectory);
    assert.equal(
      (await project.info()).memoryDirectory,
      path.join(await realpath(left), ".yaoguo", "agents", "code-review", "memory")
    );
    await sharedLeft.append(memory());
    assert.equal((await sharedRight.list()).length, 1);
    assert.equal((await testing.list()).length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Agent 记忆快照可序列化为 JSON，并安全迁移到另一个 Agent 命名空间", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "yaoguo-agent-memory-snapshot-"));
  const sourceRoot = path.join(root, "source");
  const targetRoot = path.join(root, "target");
  await Promise.all([mkdir(sourceRoot), mkdir(targetRoot)]);
  const service = new MemoryStore({
    baseDirectory: path.join(root, "home", "projects"),
    execFileImpl: async () => { throw new Error("not git"); }
  });
  try {
    const source = await service.forContext({
      workspaceRoot: sourceRoot, agentType: "code-review", memoryScope: "local"
    });
    const target = await service.forContext({
      workspaceRoot: targetRoot, agentType: "testing", memoryScope: "local"
    });
    await source.append(memory());
    const json = await source.exportSnapshotJson();
    const parsed = JSON.parse(json);
    assert.equal(parsed.kind, "yaoguo-agent-memory-snapshot");
    assert.equal(parsed.source.agentType, "code-review");
    const imported = await target.importSnapshot(json, { mode: "merge" });
    assert.equal(imported.sourceAgentType, "code-review");
    assert.equal(imported.targetAgentType, "testing");
    assert.match((await target.search({ files: ["feedback-review-style.md"] }))[0].content, /继续复用/);
    const tampered = JSON.parse(json);
    tampered.topics[0].content += "tampered";
    await assert.rejects(
      target.importSnapshot(tampered),
      (error) => error?.code === "MEMDIR_SNAPSHOT_DIGEST_INVALID"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("append-only 模式只追加日期日志，memory.md 在前台保持只读", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "yaoguo-agent-memory-journal-"));
  let now = new Date(2026, 7, 9, 23, 59, 0);
  const service = new MemoryStore({
    workspaceRoot: root,
    clock: () => now,
    execFileImpl: async () => { throw new Error("not git"); }
  });
  const store = await service.forContext({
    workspaceRoot: root,
    agentType: "always-on",
    memoryScope: "local",
    memoryMode: "append-only"
  });
  try {
    await store.ensure();
    const info = await store.info();
    const first = await store.append(memory());
    const duplicate = await store.append(memory());
    assert.equal(first.logPathPattern, "logs/{date}.md");
    assert.equal(MEMORY_LOG_PATH_PATTERN, "logs/{date}.md");
    assert.equal(first.logFile, "logs/2026-08-09.md");
    assert.equal(first.pendingIndex, true);
    assert.equal(duplicate.deduplicated, true);
    assert.equal(await readFile(path.join(info.memoryDirectory, "memory.md"), "utf8"), "");
    await assert.rejects(access(path.join(info.memoryDirectory, "feedback-review-style.md"), constants.F_OK));
    assert.equal((await stat(path.join(info.memoryDirectory, "memory.md"))).mode & 0o222, 0);
    const log = await readFile(path.join(info.memoryDirectory, "logs", "2026-08-09.md"), "utf8");
    assert.match(log, /yaoguo:memory:[a-f0-9]{64}/);
    assert.match(log, /用户确认先给证据/);
    now = new Date(2026, 7, 10, 0, 1, 0);
    const next = await store.append(memory({
      topic: "concise-review",
      name: "简洁评审",
      description: "用户确认简洁评审方式有效。",
      content: "用户确认简洁评审方式有效，应继续复用。"
    }));
    assert.equal(next.logFile, "logs/2026-08-10.md");
    const restartedService = new MemoryStore({
      workspaceRoot: root,
      clock: () => now,
      execFileImpl: async () => { throw new Error("not git"); }
    });
    const restarted = await restartedService.forContext({
      workspaceRoot: root,
      agentType: "always-on",
      memoryScope: "local",
      memoryMode: "indexed"
    });
    assert.equal((await restarted.info()).storageMode, "append-only");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Dream 由模型读取待整理日志、创建主题、重建只读索引并归档原日志", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "yaoguo-agent-memory-dream-"));
  const service = new MemoryStore({
    workspaceRoot: root,
    clock: () => new Date("2026-08-09T20:00:00+08:00"),
    execFileImpl: async () => { throw new Error("not git"); }
  });
  const store = await service.forContext({
    workspaceRoot: root,
    agentType: "always-on",
    memoryMode: "append-only"
  });
  try {
    await store.append(memory());
    const snapshot = await store.createReshapeSnapshot();
    assert.equal(snapshot.logs.length, 1);
    const tools = createAutoDreamToolRegistry({
      memoryStore: store,
      snapshot,
      canonicalRoot: root,
      guard: async () => true,
      completeLease: async () => ({ completedAt: "2026-08-10T00:00:00.000Z" }),
      clock: () => new Date("2026-08-10T00:00:00.000Z")
    });
    await tools.registry.execute("orient", {});
    await tools.registry.execute("read_log", { file: "logs/2026-08-09.md" });
    assert.equal((await tools.registry.execute("begin_consolidate", { findings: "存在一条正向反馈。" })).ok, true);
    assert.equal((await tools.registry.execute("create_memory", {
      file: "feedback-review-style.md",
      type: "feedback",
      name: "评审方式",
      description: "用户确认先给证据再给建议的评审方式有效。",
      body: "用户确认先给证据再给建议的评审方式有效，应继续复用。",
      reason: "日志中没有可合并的已有主题。"
    })).ok, true);
    await tools.registry.execute("begin_prune", { summary: "创建唯一主题并维护索引。" });
    const finished = await tools.registry.execute("finish_autodream", {});
    assert.equal(finished.ok, true, JSON.stringify(finished));
    assert.deepEqual(finished.createdFiles, ["feedback-review-style.md"]);
    assert.match(await store.readIndex(), /feedback-review-style\.md/);
    assert.match((await store.search({ files: ["feedback-review-style.md"] }))[0].content, /继续复用/);
    const info = await store.info();
    assert.deepEqual(
      (await readdir(path.join(info.memoryDirectory, "logs"))).filter((file) => file.endsWith(".md")),
      []
    );
    assert.equal((await readdir(path.join(info.memoryDirectory, "logs", "processed"))).length, 1);
    assert.equal((await stat(path.join(info.memoryDirectory, "memory.md"))).mode & 0o222, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("append-only Dream 使用 24 小时与 1 个新会话门槛", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "yaoguo-agent-memory-nightly-"));
  let now = new Date("2026-08-09T00:00:00.000Z");
  const state = new AutoDreamStateStore({
    memoryDirectory: root,
    clock: () => now,
    minSessions: AUTO_DREAM_APPEND_ONLY_MIN_SESSIONS
  });
  try {
    await state.recordSession({ sessionId: "long-lived-session" });
    assert.equal((await state.evaluate()).eligible, false);
    now = new Date(now.getTime() + AUTO_DREAM_MIN_INTERVAL_MS + 1);
    const eligible = await state.evaluate();
    assert.equal(eligible.minSessions, 1);
    assert.equal(eligible.sessionCount, 1);
    assert.equal(eligible.eligible, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("前台 append-only 写入只记录信号，模型整合留给夜间入口", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "yaoguo-agent-memory-foreground-"));
  const service = new MemoryStore({
    workspaceRoot: root,
    execFileImpl: async () => { throw new Error("not git"); }
  });
  const store = await service.forContext({
    workspaceRoot: root,
    agentType: "always-on",
    memoryMode: "append-only"
  });
  let modelCalls = 0;
  const dream = new AutoDreamService({
    aiRouter: {
      async runTaskDetailed() { modelCalls += 1; return {}; },
      async continueTaskDetailed() { modelCalls += 1; return {}; }
    }
  });
  try {
    await store.append(memory());
    const result = await dream.scheduleMemoryWrite({
      projectId: "p1",
      taskId: "t1",
      turnId: "turn-1",
      memoryStore: store
    }).settled();
    assert.equal(result.code, "NIGHTLY_DREAM_PENDING");
    assert.equal(modelCalls, 0);
  } finally {
    await dream.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("夜间入口按本地 02:00 计算稳定唤醒边界", () => {
  assert.equal(nextNightlyDelay(new Date(2026, 7, 9, 1, 0, 0), 2), 60 * 60 * 1000);
  assert.equal(nextNightlyDelay(new Date(2026, 7, 9, 3, 0, 0), 2), 23 * 60 * 60 * 1000);
});
