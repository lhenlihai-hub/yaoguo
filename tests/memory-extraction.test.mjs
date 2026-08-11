import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { MemoryStore, TYPE_BASIS } = require("../src/platform/memory/memoryStore.js");
const {
  MemoryExtractionService,
  MAX_MEMORY_EXTRACTION_ROUNDS,
  createMemoryExtractionToolRegistry,
  sliceThroughCurrentMessage
} = require("../src/platform/memory/extraction/index.js");
const {
  AutoDreamService,
  AutoDreamStateStore
} = require("../src/platform/memory/autodream/index.js");
const agentTurnActions = require("../src/application/workflows/mixins/agent/agentTurnActions.js");

function call(id, name, args = {}) {
  return {
    id,
    type: "function",
    function: { name, arguments: JSON.stringify(args) }
  };
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

function sessionStore(rows = []) {
  const events = [];
  return {
    events,
    async listMessages() { return rows; },
    async findEvent({ eventId }) { return events.find((row) => row.eventId === eventId) || null; },
    async findLatestEvent({ type }) { return events.filter((row) => row.type === type).at(-1) || null; },
    async appendEvent(event) {
      const existing = events.find((row) => row.eventId === event.eventId);
      if (existing) return existing;
      events.push({ ...event, createdAt: "2026-08-09T12:00:00.000Z" });
      return events.at(-1);
    }
  };
}

function promptRegistry() {
  return {
    async getPromptBlock(id, options) {
      assert.equal(id, "block://memory.extract");
      assert.equal(options.required, true);
      return { asset: { content: "先读后写；无记忆返回 NO_MEMORY。" } };
    }
  };
}

async function memoryFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "yaoguo-memory-extract-"));
  const store = new MemoryStore({ workspaceRoot: root });
  await store.append({
    type: "user",
    basis: TYPE_BASIS.user,
    topic: "collaboration",
    name: "协作偏好",
    description: "用户长期协作偏好。",
    content: "用户偏好先给结论。",
    valueBeyondCode: "这是用户本人确认的工作习惯，无法从代码推导。"
  });
  return { root, store };
}

test("Extract Memories Prompt 固化两回合、5 轮预算与禁止调查边界", async () => {
  const asset = JSON.parse(await readFile(
    path.join(process.cwd(), "workspace/registries/prompts/blocks/memory.extract.v1.json"),
    "utf8"
  ));
  assert.equal(asset.id, "block://memory.extract");
  assert.match(asset.content, /第一个工具回合并行发出/);
  assert.match(asset.content, /第二个工具回合只并行发出/);
  assert.match(asset.content, /最多 5 个模型回合/);
  assert.match(asset.content, /不得搜索代码 pattern/);
  assert.match(asset.content, /没有 bash、MCP 或触发其他 Agent/);
});

test("assistant 持久化后只调度后台提取，不等待后台 Promise", async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const scheduled = [];
  const host = {
    appendAgentMessage: async (message) => ({
      ...message,
      eventId: `assistant:${message.turnId}`,
      createdAt: "2026-08-09T12:00:00.000Z"
    }),
    memoryExtractionService: {
      scheduleTurn(input) {
        scheduled.push(input);
        return { settled: () => pending };
      }
    }
  };
  const persisted = await agentTurnActions.persistAgentTurnOutcome.call(host, {
    outcome: {
      reply: "已完成。",
      toolTrace: { memoryWritePerformed: false, roundsOutline: [] }
    },
    projectId: "p1",
    taskId: "t1",
    turnId: "turn-1"
  });
  assert.equal(persisted.eventId, "assistant:turn-1");
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].assistantEventId, "assistant:turn-1");
  assert.equal(scheduled[0].assistantCreatedAt, "2026-08-09T12:00:00.000Z");
  release();
});

test("主 Agent 已成功写记忆时后台不调用模型，只推进持久化游标", async () => {
  const sessions = sessionStore();
  const autoDreamJobs = [];
  const service = new MemoryExtractionService({
    taskSessionStore: sessions,
    autoDreamService: {
      scheduleMemoryWrite(input) {
        autoDreamJobs.push(input);
        return { settled: async () => ({ status: "skipped" }) };
      }
    }
  });
  const job = service.scheduleTurn({
    projectId: "p1",
    taskId: "t1",
    turnId: "turn-main-write",
    assistantEventId: "assistant:turn-main-write",
    memoryWritePerformed: true
  });
  assert.equal(job.status, "pending");
  const result = await job.settled();
  assert.equal(result.code, "MAIN_MEMORY_WRITE");
  assert.equal(sessions.events.length, 1);
  assert.equal(sessions.events[0].status, "skipped_main_memory_write");
  assert.equal(sessions.events[0].lastMessageEventId, "assistant:turn-main-write");
  assert.equal(autoDreamJobs.length, 1);
  assert.equal(autoDreamJobs[0].sessionId, "p1::t1");
});

test("空 Memdir 可完成首次提取，并把 writtenFiles 作为 AutoDream 信号落盘", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "yaoguo-memory-extract-empty-"));
  const store = new MemoryStore({ workspaceRoot: root });
  const rows = [
    { eventId: "user:first", turnId: "first", role: "user", content: "我长期偏好先看结论，再看解释。" },
    { eventId: "assistant:first", turnId: "first", role: "assistant", content: "明白了。" }
  ];
  const sessions = sessionStore(rows);
  const clock = () => new Date("2026-08-09T12:00:00.000Z");
  const router = detailedRouter(async (args, round) => {
    if (round === 0) {
      assert.deepEqual(JSON.parse(args.input).memory_index, []);
      return { toolCalls: [call("read-empty-index", "read", { path: "memory.md" })] };
    }
    if (round === 1) {
      assert.match(JSON.stringify(args.messages || []), /read-empty-index/);
      return {
        toolCalls: [call("write-first-memory", "write_memory", {
          type: "user",
          basis: TYPE_BASIS.user,
          topic: "answer-order",
          name: "回答顺序偏好",
          description: "用户长期偏好先看结论，再看解释。",
          content: "用户明确表示：长期偏好先看结论，再看解释。",
          valueBeyondCode: "这是用户本人确认的稳定协作习惯，无法从代码推导。"
        })]
      };
    }
    return "DONE";
  });
  const autoDream = new AutoDreamService({ clock });
  const service = new MemoryExtractionService({
    aiRouter: router,
    registryService: promptRegistry(),
    taskSessionStore: sessions,
    autoDreamService: autoDream,
    clock
  });
  try {
    const result = await service.scheduleTurn({
      projectId: "p1",
      taskId: "t1",
      turnId: "first",
      assistantEventId: "assistant:first",
      memoryStore: store
    }).settled();
    assert.equal(result.code, "MEMORIES_WRITTEN", JSON.stringify(result));
    assert.deepEqual(result.writtenFiles, ["user-answer-order.md"]);

    await autoDream.drain();
    const info = await store.info();
    const state = new AutoDreamStateStore({ memoryDirectory: info.memoryDirectory, clock });
    const eligibility = await state.evaluate();
    assert.equal(eligibility.sessionCount, 1);
    assert.deepEqual(eligibility.signals[0].writtenFiles, ["user-answer-order.md"]);
    assert.equal(sessions.events.at(-1).status, "written");
  } finally {
    await autoDream.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("后台 Agent 先并行读、再并行 write_memory，并且没有 shell、MCP 或 spawn 能力", async () => {
  const fixture = await memoryFixture();
  const rows = [
    { eventId: "user:turn-2", turnId: "turn-2", role: "user", content: "我确认先给结论再解释的方式很好，请继续这样做。" },
    { eventId: "assistant:turn-2", turnId: "turn-2", role: "assistant", content: "已按该方式完成。" }
  ];
  const sessions = sessionStore(rows);
  const autoDreamJobs = [];
  const router = detailedRouter(async (_args, round) => {
    if (round === 0) {
      return {
        toolCalls: [
          call("read-index", "read", { path: "memory.md" }),
          call("read-user", "read", { path: "user-collaboration.md" })
        ]
      };
    }
    if (round === 1) {
      assert.match(JSON.stringify(_args.messages || []), /untrusted_external_data/);
      return {
        toolCalls: [
          call("write-user", "write_memory", {
            type: "user",
            basis: TYPE_BASIS.user,
            topic: "collaboration",
            name: "协作偏好",
            description: "用户偏好回答先给结论再解释。",
            content: "用户明确确认：回答时先给结论、再解释原因。",
            valueBeyondCode: "这是用户本人确认的稳定协作习惯，无法从代码推导。"
          }),
          call("write-feedback", "write_memory", {
            type: "feedback",
            basis: TYPE_BASIS.feedback,
            topic: "answer-order",
            name: "回答顺序正向反馈",
            description: "用户确认先结论后解释的回答顺序有效。",
            content: "成功做法：先给结论，再解释原因；用户明确要求继续复用。",
            valueBeyondCode: "这是用户对 AI 行为的正向评价，代码无法表达。",
            polarity: "positive"
          })
        ]
      };
    }
    return "DONE";
  });
  const service = new MemoryExtractionService({
    aiRouter: router,
    registryService: promptRegistry(),
    taskSessionStore: sessions,
    autoDreamService: {
      scheduleMemoryWrite(input) {
        autoDreamJobs.push(input);
        return { settled: async () => ({ status: "skipped" }) };
      }
    },
    clock: () => new Date("2026-08-09T12:00:00.000Z")
  });
  try {
    const job = service.scheduleTurn({
      projectId: "p1",
      taskId: "t1",
      turnId: "turn-2",
      assistantEventId: "assistant:turn-2",
      memoryStore: fixture.store
    });
    const result = await job.settled();
    assert.equal(result.code, "MEMORIES_WRITTEN", JSON.stringify(result));
    assert.deepEqual(result.writtenFiles.sort(), ["feedback-answer-order.md", "user-collaboration.md"]);
    assert.equal(router.calls.length, 3);
    const first = router.calls[0].args;
    assert.equal(first.internalCall, true);
    assert.equal(first.thinkingOverride, "disabled");
    const input = JSON.parse(first.input);
    assert.equal(input.current_date, "2026-08-09");
    assert.deepEqual(input.memory_index.map((topic) => topic.file), ["user-collaboration.md"]);
    assert.equal("content" in input.memory_index[0], false);
    assert.doesNotMatch(first.input, /用户偏好先给结论。/);
    const toolNames = first.tools.map((tool) => tool.function.name);
    assert.ok(toolNames.includes("read"));
    assert.ok(toolNames.includes("grep"));
    assert.ok(toolNames.includes("write_memory"));
    assert.equal(toolNames.includes("bash"), false);
    assert.equal(toolNames.includes("spawn_subagent"), false);
    assert.equal(toolNames.some((name) => /mcp/i.test(name)), false);
    const stored = await fixture.store.search({ files: result.writtenFiles, limit: 5 });
    assert.equal(stored.length, 2);
    assert.match(stored.find((row) => row.file === "feedback-answer-order.md").content, /正向确认/);
    assert.equal(sessions.events.at(-1).status, "written");
    assert.equal(autoDreamJobs.length, 1);
    assert.deepEqual(autoDreamJobs[0].writtenFiles.sort(), ["feedback-answer-order.md", "user-collaboration.md"]);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("写已有主题前必须 read 同一文件，读写混合批次被宿主拒绝", async () => {
  const fixture = await memoryFixture();
  const info = await fixture.store.info();
  const extraction = createMemoryExtractionToolRegistry({
    memoryStore: fixture.store,
    memoryDirectory: info.memoryDirectory,
    existingFiles: ["user-collaboration.md"]
  });
  const args = {
    type: "user",
    basis: TYPE_BASIS.user,
    topic: "collaboration",
    name: "协作偏好",
    description: "用户长期协作偏好。",
    content: "用户偏好先给结论再解释。",
    valueBeyondCode: "这是用户本人确认的工作习惯，无法从代码推导。"
  };
  try {
    extraction.state.beginRound(0, [call("read-index", "read", { path: "memory.md" })]);
    await extraction.registry.execute("read", { path: "memory.md" });
    extraction.state.beginRound(1, [call("write", "write_memory", args)]);
    const unread = await extraction.registry.execute("write_memory", args);
    assert.equal(unread.ok, false);
    assert.equal(unread.code, "MEMORY_EXTRACTION_TARGET_NOT_READ");

    const mixed = createMemoryExtractionToolRegistry({
      memoryStore: fixture.store,
      memoryDirectory: info.memoryDirectory,
      existingFiles: ["user-collaboration.md"]
    });
    mixed.state.beginRound(0, [
      call("read", "read", { path: "user-collaboration.md" }),
      call("write", "write_memory", args)
    ]);
    const rejected = await mixed.registry.execute("write_memory", args);
    assert.equal(rejected.code, "MEMORY_EXTRACTION_PHASE_MIXED");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("后台工具允许读取与 grep 任意给定文件，但写能力只有 write_memory 且可并行发出", async () => {
  const memoryRoot = await mkdtemp(path.join(tmpdir(), "yaoguo-extract-tools-memory-"));
  const outsideRoot = await mkdtemp(path.join(tmpdir(), "yaoguo-extract-tools-read-"));
  const outside = path.join(outsideRoot, "notes.txt");
  await writeFile(outside, "alpha\nremember target\nomega\n", "utf8");
  const extraction = createMemoryExtractionToolRegistry({
    memoryStore: { append: async () => ({}) },
    memoryDirectory: memoryRoot
  });
  try {
    assert.deepEqual(extraction.registry.list().map((tool) => tool.schema.function.name), [
      "read", "grep", "write_memory"
    ]);
    assert.equal(extraction.registry.getPolicy("write_memory").parallelSafe, true);
    extraction.state.beginRound(0, [
      call("read", "read", { path: outside }),
      call("grep", "grep", { path: outside, pattern: "target" })
    ]);
    const [readResult, grepResult] = await Promise.all([
      extraction.registry.execute("read", { path: outside }),
      extraction.registry.execute("grep", { path: outside, pattern: "target" })
    ]);
    assert.equal(readResult.ok, true);
    assert.match(readResult.content, /remember target/);
    assert.equal(grepResult.ok, true);
    assert.equal(grepResult.matches[0].line, 2);
  } finally {
    await Promise.all([
      rm(memoryRoot, { recursive: true, force: true }),
      rm(outsideRoot, { recursive: true, force: true })
    ]);
  }
});

test("后台 Agent 的模型预算硬限制为 5 轮，失败时不推进游标", async () => {
  const fixture = await memoryFixture();
  const rows = [
    { eventId: "user:loop", turnId: "loop", role: "user", content: "记住一个长期偏好。" },
    { eventId: "assistant:loop", turnId: "loop", role: "assistant", content: "收到。" }
  ];
  const sessions = sessionStore(rows);
  const router = detailedRouter(async (_args, round) => ({
    toolCalls: [call(`read-${round}`, "read", { path: "memory.md", offset: round + 1 })]
  }));
  const service = new MemoryExtractionService({
    aiRouter: router,
    registryService: promptRegistry(),
    taskSessionStore: sessions
  });
  try {
    const result = await service.scheduleTurn({
      projectId: "p1",
      taskId: "t1",
      turnId: "loop",
      assistantEventId: "assistant:loop",
      memoryStore: fixture.store
    }).settled();
    assert.equal(MAX_MEMORY_EXTRACTION_ROUNDS, 5);
    assert.equal(router.calls.length, 5);
    assert.equal(result.status, "failed");
    assert.equal(result.code, "MEMORY_EXTRACTION_ROUND_LIMIT");
    assert.equal(sessions.events.some((row) => row.type === "memory.extraction.cursor"), false);
    assert.equal(sessions.events.at(-1).type, "memory.extraction.failed");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("提取窗口只包含上次持久化游标之后、当前 assistant 之前的新增消息", () => {
  const rows = [
    { eventId: "assistant:old", role: "assistant", turnId: "old" },
    { eventId: "user:new", role: "user", turnId: "new" },
    { eventId: "assistant:new", role: "assistant", turnId: "new" },
    { eventId: "user:later", role: "user", turnId: "later" }
  ];
  assert.deepEqual(
    sliceThroughCurrentMessage(rows, "assistant:old", "assistant:new", "new").map((row) => row.eventId),
    ["user:new", "assistant:new"]
  );
});

test("较旧 Job 不会把已经推进到更新消息的游标回退", async () => {
  const rows = [
    { eventId: "user:old", role: "user", turnId: "old", content: "旧消息" },
    { eventId: "assistant:old", role: "assistant", turnId: "old", content: "旧回复" },
    { eventId: "user:new", role: "user", turnId: "new", content: "新消息" },
    { eventId: "assistant:new", role: "assistant", turnId: "new", content: "新回复" }
  ];
  const sessions = sessionStore(rows);
  sessions.events.push({
    eventId: "new-cursor",
    type: "memory.extraction.cursor",
    lastMessageEventId: "assistant:new",
    lastMessageCreatedAt: "2026-08-09T12:05:00.000Z"
  });
  const service = new MemoryExtractionService({ taskSessionStore: sessions });
  const result = await service.scheduleTurn({
    projectId: "p1",
    taskId: "t1",
    turnId: "old",
    assistantEventId: "assistant:old",
    assistantCreatedAt: "2026-08-09T12:00:00.000Z"
  }).settled();
  assert.equal(result.code, "CURSOR_ALREADY_AHEAD");
  assert.equal(sessions.events.length, 1);
  assert.equal(sessions.events[0].eventId, "new-cursor");
});
