import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  calculateMessagesToKeepIndex
} = require("../src/platform/context/sessionCompactionBoundary.js");
const {
  SessionMemoryService,
  SessionMemoryTurn
} = require("../src/platform/memory/session/sessionMemoryService.js");
const {
  editAgentLoopContext
} = require("../src/platform/context/agentContextLifecycle.js");
const { AgentToolRuntime } = require("../src/platform/ai/agentLoop/toolRuntime.js");

const NOTE = [
  "# Session Memory",
  "",
  "## 会话标题",
  "压缩边界实现",
  "",
  "## 当前工作状态",
  "边界算法已完成。",
  "",
  "## 任务规格",
  "工具调用对不可切开。",
  "",
  "## 涉及的关键文件和函数",
  "sessionCompactionBoundary.js",
  "",
  "## 工作流步骤",
  "实现后运行测试。",
  "",
  "## 遇到的错误与修正",
  "无"
].join("\n");

test("calculateMessagesToKeepIndex 不切开 tool use/result", () => {
  const messages = [
    { role: "user", content: "before", tokens: 10 },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }],
      tokens: 10
    },
    { role: "toolResult", toolCallId: "call-1", content: [{ type: "text", text: "ok" }], tokens: 10 },
    { role: "user", content: "after", tokens: 10 }
  ];
  const result = calculateMessagesToKeepIndex(messages, {
    minKeepTokens: 10,
    maxKeepTokens: 30,
    estimate: (rows) => rows.reduce((sum, row) => sum + row.tokens, 0)
  });

  assert.equal(result.keepIndex, 1);
  assert.equal(result.keepTokens, 30);
  assert.deepEqual(result.atomicGroups.map((group) => [group.start, group.end]), [
    [0, 1],
    [1, 3],
    [3, 4]
  ]);
});

test("calculateMessagesToKeepIndex 将流式片段与 thinking 父消息视为原子组", () => {
  const fragments = [
    { role: "assistant", content: "A", streamId: "stream-1", tokens: 8 },
    { role: "assistant", content: "B", streamId: "stream-1", tokens: 8 },
    { role: "user", content: "tail", tokens: 10 }
  ];
  const fragmentBoundary = calculateMessagesToKeepIndex(fragments, {
    minKeepTokens: 8,
    maxKeepTokens: 18,
    estimate: (rows) => rows.reduce((sum, row) => sum + row.tokens, 0)
  });
  assert.equal(fragmentBoundary.keepIndex, 2);

  const thinking = [
    { role: "assistant", messageId: "m1", content: [{ type: "thinking", thinking: "reason" }], tokens: 8 },
    { role: "assistant", parentMessageId: "m1", content: [{ type: "text", text: "answer" }], tokens: 8 },
    { role: "user", content: "tail", tokens: 10 }
  ];
  const thinkingBoundary = calculateMessagesToKeepIndex(thinking, {
    minKeepTokens: 8,
    maxKeepTokens: 18,
    estimate: (rows) => rows.reduce((sum, row) => sum + row.tokens, 0)
  });
  assert.equal(thinkingBoundary.keepIndex, 2);
});

test("calculateMessagesToKeepIndex 扩展近期消息时不越过上次压缩边界", () => {
  const messages = Array.from({ length: 6 }, (_item, index) => ({
    role: index % 2 ? "assistant" : "user",
    content: `${index}`,
    tokens: 5
  }));
  const result = calculateMessagesToKeepIndex(messages, {
    lastSummaryIndex: 5,
    priorCompactionBoundary: 3,
    minKeepTokens: 15,
    maxKeepTokens: 20,
    estimate: (rows) => rows.reduce((sum, row) => sum + row.tokens, 0)
  });
  assert.equal(result.keepIndex, 3);
  assert.equal(result.keepTokens, 15);
});

test("SessionMemoryTurn 仅在总量门槛与增量 Token 或工具门槛同时满足时更新", async () => {
  const snapshots = [];
  const service = {
    schedule: async (_turn, snapshot) => {
      snapshots.push(snapshot);
      return { note: NOTE, coveredIndex: snapshot.throughIndex };
    },
    reportError: () => {}
  };
  const turn = new SessionMemoryTurn(service, {
    projectId: "p1",
    taskId: "t1",
    runId: "r1",
    turnId: "turn-1",
    note: "",
    state: null,
    policy: {
      minContextTokens: 20000,
      updateDeltaTokens: 12000,
      updateToolCalls: 6
    }
  });
  const messages = [{ role: "user", content: "task" }];

  assert.equal(turn.observe({ messages, contextTokens: 19999, toolCallCount: 20 }), false);
  assert.equal(turn.observe({ messages, contextTokens: 20000, toolCallCount: 0 }), true);
  await turn.pending;
  assert.equal(turn.observe({ messages, contextTokens: 25000, toolCallCount: 5 }), false);
  assert.equal(turn.observe({ messages, contextTokens: 25000, toolCallCount: 6 }), true);
  await turn.pending;
  assert.equal(snapshots.length, 2);
});

test("最终自然回复只旁路登记 Session Memory，不等待或执行无后续用途的 Compact", async () => {
  let observed = 0;
  let prepared = 0;
  const runtime = new AgentToolRuntime({
    registry: {},
    toolCtx: {
      sessionMemoryTurn: {
        observe: () => { observed += 1; },
        prepareForCompaction: async () => { prepared += 1; return { note: NOTE, coveredIndex: 1 }; }
      }
    },
    runTaskArgs: {}
  }, null);
  runtime.contextPolicy = {
    enabled: true,
    triggerTokens: 1,
    clearStartTokens: 1,
    hardInputTokens: 100000,
    minKeepTokens: 1,
    maxKeepTokens: 10
  };

  const context = { messages: [{ role: "user", content: "task" }], tools: [] };
  const result = await runtime.prepareNextTurn(context, { allowContextEdit: false });

  assert.equal(observed, 1);
  assert.equal(prepared, 0);
  assert.equal(result.messages[0].content, "task");
});

test("Session Memory Compact 在确定边界后清除当前会话三层记忆缓存", async () => {
  const operations = [];
  const runtime = new AgentToolRuntime({
    registry: {},
    toolCtx: {
      sessionMemoryTurn: {
        observe() {},
        prepareForCompaction: async () => ({ note: NOTE, coveredIndex: 2 }),
        markCompacted() {}
      },
      memoryCacheController: {
        invalidate: (operation) => operations.push(operation)
      }
    },
    runTaskArgs: {}
  }, null);
  runtime.contextPolicy = {
    enabled: true,
    triggerTokens: 50,
    clearStartTokens: 20,
    hardInputTokens: 100000,
    inlineToolResultTokens: 10000,
    toolResultPreviewTokens: 1800,
    keepRecentToolGroups: 2,
    checkpointMaxEvents: 24,
    checkpointArgumentChars: 600,
    checkpointPreviewChars: 320,
    minKeepTokens: 10,
    maxKeepTokens: 40
  };
  const result = await runtime.prepareNextTurn({
    messages: [
      { role: "user", content: "root" },
      { role: "assistant", content: "early-context ".repeat(15000) },
      { role: "user", content: "近期消息" }
    ],
    tools: []
  });

  assert.match(result.messages.map((message) => `${message.content || ""}`).join("\n"), /SESSION_MEMORY_COMPACT/);
  assert.deepEqual(operations, ["compact"]);
});

test("SessionMemoryService 把模型维护的固定六章节原子写入任务 session", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "yaoguo-session-memory-"));
  const sessionDir = path.join(root, "session");
  const store = {
    resolveSessionMemoryFile: async () => path.join(sessionDir, "memory.md"),
    resolveSessionMemoryStateFile: async () => path.join(sessionDir, ".memory.state.json")
  };
  const calls = [];
  const service = new SessionMemoryService({
    aiRouter: {
      runTaskDetailed: async (args) => {
        calls.push(args);
        return { content: NOTE };
      }
    },
    registryService: {
      getPromptBlock: async () => ({ asset: { content: "维护固定六章节。" } })
    },
    taskSessionStore: store,
    settingsService: { get: async () => ({ context: { sessionMemory: {} } }) }
  });
  try {
    const turn = await service.beginTurn({
      projectId: "p1",
      taskId: "t1",
      runId: "r1",
      turnId: "turn-1",
      taskSeed: { title: "测试" }
    });
    assert.equal(turn.observe({
      messages: [{ role: "assistant", content: [{ type: "text", text: "已完成边界算法" }] }],
      contextTokens: 20000,
      toolCallCount: 0
    }), true);
    await turn.pending;

    assert.equal(await readFile(path.join(sessionDir, "memory.md"), "utf8"), `${NOTE}\n`);
    const state = JSON.parse(await readFile(path.join(sessionDir, ".memory.state.json"), "utf8"));
    assert.equal(state.version, 1);
    assert.equal(state.revision, 1);
    assert.equal(calls[0].internalCall, true);
    assert.equal(calls[0].instructionPlacement, "after-input");
    assert.equal("skipAutoCompaction" in calls[0], false);
  } finally {
    await service.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("editAgentLoopContext 超限时用 Session Memory + 完整近期消息替代临时摘要", () => {
  const rootMessages = [{ role: "user", content: "完成任务" }];
  const messages = [
    ...rootMessages,
    { role: "assistant", content: "旧过程".repeat(10000) },
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: "{}" } }]
    },
    { role: "tool", tool_call_id: "c1", content: "读取完成" },
    { role: "user", content: "继续" }
  ];
  const boundary = calculateMessagesToKeepIndex(messages.slice(1), {
    lastSummaryIndex: 1,
    minKeepTokens: 1,
    maxKeepTokens: 100
  });
  const edited = editAgentLoopContext({
    messages,
    tools: [],
    rootMessages,
    records: [],
    currentRound: 2,
    episode: 0,
    policy: {
      enabled: true,
      triggerTokens: 1000,
      clearStartTokens: 800,
      hardInputTokens: 20000,
      minKeepTokens: 1,
      maxKeepTokens: 100,
      keepRecentToolGroups: 1
    },
    sessionMemory: { note: NOTE, coveredIndex: 1, boundary }
  });

  assert.equal(edited.checkpointed, true);
  assert.equal(edited.strategy, "session-memory");
  assert.match(edited.messages[1].content, /SESSION_MEMORY_COMPACT/);
  assert.match(edited.messages[1].content, /## 当前工作状态/);
  const roles = edited.messages.map((message) => message.role);
  const toolIndex = roles.indexOf("tool");
  if (toolIndex >= 0) {
    assert.equal(roles[toolIndex - 1], "assistant");
    assert.equal(edited.messages[toolIndex - 1].tool_calls[0].id, "c1");
  }
});
