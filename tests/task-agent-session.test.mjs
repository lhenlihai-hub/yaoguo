import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  unlink,
  writeFile
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const require = createRequire(import.meta.url);
const { TaskSessionStore, MAX_MESSAGE_WINDOW } = require("../src/platform/sessions/taskSessionStore.js");
const { TaskAgentCoordinator } = require("../src/application/agent/taskAgentCoordinator.js");
const { createAgentTurnControl } = require("../src/platform/ai/agentLoop/agentLoop.js");
const agentInputActions = require("../src/application/workflows/mixins/agent/agentInputActions.js");
const agentHistoryActions = require("../src/application/workflows/mixins/agent/agentHistoryActions.js");

function createProjectService(root) {
  return {
    getTaskDir: (projectId, taskId) => join(root, "projects", projectId, "tasks", taskId)
  };
}

function createDurableAgentInputEngine(store, coordinator, runTurn) {
  return {
    taskSessionStore: store,
    taskAgentCoordinator: coordinator,
    projectService: {
      ...store.projectService,
      getTask: async (projectId, taskId) => ({ id: taskId, projectId })
    },
    scheduleAutoNameFromFirstMessage: () => {},
    appendAgentMessage: (entry) => store.appendMessage(entry),
    findAgentMessage: (scope) => store.findMessage(scope),
    _runAgentInputTurn: runTurn,
    submitAgentInput: agentInputActions.submitAgentInput
  };
}

async function readSessionEvents(store, projectId, taskId) {
  const content = await readFile(store.getEventsFile(projectId, taskId), "utf8");
  return content.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

async function waitUntil(predicate, attempts = 250) {
  for (let index = 0; index < attempts; index += 1) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  return false;
}

test("TaskSessionStore 以 task append 顺序持久化消息并按 turn 幂等", async () => {
  const root = await mkdtemp(join(tmpdir(), "yaoguo-task-session-"));
  try {
    const store = new TaskSessionStore({
      projectService: createProjectService(root),
      clock: () => new Date("2026-07-31T00:00:00.000Z")
    });
    await store.appendMessage({ projectId: "p1", taskId: "t1", turnId: "a", role: "user", content: "开始" });
    await store.appendMessage({ projectId: "p1", taskId: "t1", turnId: "a", role: "assistant", content: "完成" });
    await store.appendMessage({ projectId: "p1", taskId: "t1", turnId: "a", role: "assistant", content: "完成" });
    await assert.rejects(
      store.appendMessage({ projectId: "p1", taskId: "t1", turnId: "a", role: "assistant", content: "冲突内容" }),
      (error) => error.code === "TASK_EVENT_CONFLICT"
    );

    const rows = await store.listMessages({ projectId: "p1", taskId: "t1" });
    assert.deepEqual(rows.map((row) => [row.role, row.content]), [
      ["user", "开始"],
      ["assistant", "完成"]
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("TaskSessionStore 可读取指定类型的最新追加事件作为后台游标", async () => {
  const root = await mkdtemp(join(tmpdir(), "yaoguo-task-session-cursor-"));
  try {
    const store = new TaskSessionStore({ projectService: createProjectService(root) });
    await store.appendEvent({
      eventId: "cursor-1", type: "memory.extraction.cursor",
      projectId: "p1", taskId: "t1", lastMessageEventId: "assistant:a"
    });
    await store.appendEvent({
      eventId: "other", type: "unrelated",
      projectId: "p1", taskId: "t1"
    });
    await store.appendEvent({
      eventId: "cursor-2", type: "memory.extraction.cursor",
      projectId: "p1", taskId: "t1", lastMessageEventId: "assistant:b"
    });
    const latest = await store.findLatestEvent({
      projectId: "p1", taskId: "t1", type: "memory.extraction.cursor"
    });
    assert.equal(latest.eventId, "cursor-2");
    assert.equal(latest.lastMessageEventId, "assistant:b");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("超长输入无损外置到 Agent 可读资料区，不暴露 session 控制日志", async () => {
  const root = await mkdtemp(join(tmpdir(), "yaoguo-agent-input-"));
  try {
    const store = new TaskSessionStore({ projectService: createProjectService(root) });
    const content = `完整输入\n${"甲乙丙丁".repeat(20000)}\n尾部校验`;
    await store.appendMessage({
      projectId: "p1", taskId: "t1", turnId: "turn/unsafe", role: "user", content
    });
    const file = await store.externalizeInput({
      projectId: "p1", taskId: "t1", turnId: "turn/unsafe", content
    });

    assert.equal(await readFile(file.absolute, "utf8"), content);
    assert.match(file.absolute, /\/agent-inputs\/content\/[a-f0-9]{64}\.md$/);
    assert.doesNotMatch(file.absolute, /\/session\//);
    assert.equal(file.bytes, Buffer.byteLength(content));
    const rawEvent = JSON.parse((await readFile(store.getEventsFile("p1", "t1"), "utf8")).trim());
    assert.equal(rawEvent.content, undefined, "巨型正文不能再次写进 events.jsonl");
    assert.equal(rawEvent.contentRef.sha256, file.sha256);
    assert.ok((await stat(store.getEventsFile("p1", "t1"))).size < 2000);
    assert.equal((await store.findMessage({
      projectId: "p1", taskId: "t1", turnId: "turn/unsafe", role: "user"
    })).content, content, "读取接口应透明还原内容寻址正文");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("内容寻址的任务正文被篡改后严格失败关闭", async () => {
  const root = await mkdtemp(join(tmpdir(), "yaoguo-agent-input-integrity-"));
  try {
    const store = new TaskSessionStore({ projectService: createProjectService(root) });
    const content = "原始正文".repeat(20000);
    await store.appendMessage({
      projectId: "p1", taskId: "t1", turnId: "integrity", role: "user", content
    });
    const file = await store.externalizeInput({
      projectId: "p1", taskId: "t1", turnId: "integrity", content
    });
    await writeFile(file.absolute, "被篡改", "utf8");
    await assert.rejects(
      store.findMessage({ projectId: "p1", taskId: "t1", turnId: "integrity", role: "user" }),
      (error) => error.code === "TASK_SESSION_CORRUPT"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("任务正文目录不得通过符号链接写出任务边界", async () => {
  const root = await mkdtemp(join(tmpdir(), "yaoguo-agent-input-boundary-"));
  try {
    const projectService = createProjectService(root);
    const store = new TaskSessionStore({ projectService });
    const taskDir = projectService.getTaskDir("p1", "t1");
    const outside = join(root, "outside-inputs");
    await mkdir(taskDir, { recursive: true });
    await mkdir(outside);
    await symlink(outside, join(taskDir, "agent-inputs"));

    await assert.rejects(
      store.externalizeInput({ projectId: "p1", taskId: "t1", content: "不得越界" }),
      (error) => error.code === "TASK_SESSION_CORRUPT"
    );
    assert.deepEqual(await readdir(outside), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("事件日志与历史 cursor 拒绝最终符号链接", async () => {
  const root = await mkdtemp(join(tmpdir(), "yaoguo-session-final-link-"));
  try {
    const projectService = createProjectService(root);
    const taskDir = projectService.getTaskDir("p1", "t1");
    const sessionDir = join(taskDir, "session");
    const outsideEvent = join(root, "outside-events.jsonl");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(outsideEvent, "sentinel\n", "utf8");
    await symlink(outsideEvent, join(sessionDir, "events.jsonl"));
    const linkedStore = new TaskSessionStore({ projectService });
    await assert.rejects(
      linkedStore.appendEvent({ projectId: "p1", taskId: "t1", type: "audit" }),
      (error) => error.code === "TASK_SESSION_CORRUPT"
    );
    assert.equal(await readFile(outsideEvent, "utf8"), "sentinel\n");

    await unlink(join(sessionDir, "events.jsonl"));
    const store = new TaskSessionStore({ projectService });
    await store.appendMessage({
      projectId: "p1", taskId: "t1", turnId: "one", role: "user", content: "原始消息"
    });
    const history = await store.externalizeHistory({ projectId: "p1", taskId: "t1" });
    const cursor = join(taskDir, "agent-inputs", ".task-history.cursor.json");
    const outsideCursor = join(root, "outside-cursor.json");
    await writeFile(outsideCursor, '{"sentinel":true}\n', "utf8");
    await unlink(cursor);
    await symlink(outsideCursor, cursor);
    await assert.rejects(
      store.externalizeHistory({ projectId: "p1", taskId: "t1" }),
      (error) => error.code === "TASK_SESSION_CORRUPT"
    );
    assert.equal(await readFile(outsideCursor, "utf8"), '{"sentinel":true}\n');
    assert.match(await readFile(history.absolute, "utf8"), /原始消息/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("历史超出内联预算时保留首尾并提供完整可回读快照", async () => {
  const root = await mkdtemp(join(tmpdir(), "yaoguo-agent-history-"));
  try {
    const store = new TaskSessionStore({ projectService: createProjectService(root) });
    const messages = [
      { projectId: "p1", taskId: "t1", turnId: "old", role: "user", content: `开头约束-${"中间".repeat(3000)}-尾部约束` },
      { projectId: "p1", taskId: "t1", turnId: "answer", role: "assistant", content: "此前答复" },
      { projectId: "p1", taskId: "t1", turnId: "current", role: "user", content: "当前消息" }
    ];
    for (const row of messages) await store.appendMessage(row);
    const host = {
      ...agentHistoryActions,
      taskSessionStore: store,
      settingsService: {
        get: async () => ({ context: { agentHistory: { readLimit: 2, tokens: 900 } } })
      }
    };

    const context = await host.buildAgentHistoryContext({
      projectId: "p1", taskId: "t1", currentTurnId: "current", currentMessage: "当前消息"
    });
    assert.match(context, /历史未静默丢失/);
    assert.match(context, /开头约束/);
    assert.match(context, /尾部约束/);
    const snapshotPath = context.match(/路径：(.+task-history\.md)/)?.[1];
    assert.ok(snapshotPath);
    const snapshot = await readFile(snapshotPath, "utf8");
    assert.match(snapshot, /开头约束/);
    assert.match(snapshot, /尾部约束/);
    assert.match(snapshot, /当前消息/, "完整任务投影包含当前输入，内联上下文仍会去重");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("完整历史投影增量追加，并回滚崩溃留下的未提交尾部", async () => {
  const root = await mkdtemp(join(tmpdir(), "yaoguo-agent-history-projection-"));
  try {
    const store = new TaskSessionStore({ projectService: createProjectService(root) });
    const firstRows = [
      { eventId: "user:one", role: "user", turnId: "one", content: "第一条" },
      { eventId: "assistant:one", role: "assistant", turnId: "one", content: "第一答" }
    ];
    for (const row of firstRows) {
      await store.appendMessage({ projectId: "p1", taskId: "t1", ...row });
    }
    const first = await store.externalizeHistory({
      projectId: "p1", taskId: "t1"
    });
    const firstStat = await stat(first.absolute);
    const secondRows = [
      ...firstRows,
      { eventId: "user:two", role: "user", turnId: "two", content: "第二条" }
    ];
    await store.appendMessage({ projectId: "p1", taskId: "t1", ...secondRows.at(-1) });
    const second = await store.externalizeHistory({
      projectId: "p1", taskId: "t1"
    });
    const secondStat = await stat(second.absolute);
    assert.equal(second.absolute, first.absolute);
    assert.equal(secondStat.ino, firstStat.ino, "新消息应原位追加，不重写完整历史文件");
    const committed = await readFile(second.absolute, "utf8");
    assert.equal((committed.match(/第一条/g) || []).length, 1);
    assert.equal((committed.match(/第二条/g) || []).length, 1);

    await appendFile(second.absolute, "CRASHED_UNCOMMITTED_TAIL", "utf8");
    await store.externalizeHistory({
      projectId: "p1", taskId: "t1"
    });
    assert.equal(await readFile(second.absolute, "utf8"), committed);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("消息窗口流式统计完整历史，只保留有界尾部且不缓存任务全集", async () => {
  const root = await mkdtemp(join(tmpdir(), "yaoguo-session-window-"));
  try {
    const store = new TaskSessionStore({ projectService: createProjectService(root) });
    const eventsFile = store.getEventsFile("p1", "t1");
    await store.ensureMigrated("p1", "t1");
    await appendFile(eventsFile, Array.from({ length: MAX_MESSAGE_WINDOW + 37 }, (_, index) => JSON.stringify({
      eventId: `message:${index}`,
      type: "message",
      projectId: "p1",
      taskId: "t1",
      turnId: `turn-${index}`,
      role: index % 2 ? "assistant" : "user",
      content: `消息 ${index}`,
      createdAt: "2026-07-31T00:00:00.000Z"
    })).join("\n") + "\n", { encoding: "utf8", flush: true });
    const window = await store.listMessageWindow({
      projectId: "p1",
      taskId: "t1",
      limit: Number.MAX_SAFE_INTEGER
    });
    assert.equal(window.total, MAX_MESSAGE_WINDOW + 37);
    assert.equal(window.rows.length, MAX_MESSAGE_WINDOW);
    assert.equal(window.rows.at(-1).content, `消息 ${MAX_MESSAGE_WINDOW + 36}`);
    assert.equal(store.eventSnapshots, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("同一任务的普通 turn 串行执行，不同任务互不占用同一队列", async () => {
  const coordinator = new TaskAgentCoordinator();
  const order = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const first = coordinator.submitMessage({ projectId: "p", taskId: "a" }, "一", async () => {
    order.push("a:start");
    await firstGate;
    order.push("a:end");
    return "a";
  });
  const second = coordinator.submitMessage({ projectId: "p", taskId: "a" }, "二", async () => {
    order.push("a:second");
    return "b";
  });
  const other = coordinator.submitMessage({ projectId: "p", taskId: "b" }, "三", async () => {
    order.push("b:parallel");
    return "c";
  });
  await other;
  assert.deepEqual(order, ["a:start", "b:parallel"]);
  releaseFirst();
  assert.deepEqual(await Promise.all([first, second]), ["a", "b"]);
  assert.deepEqual(order, ["a:start", "b:parallel", "a:end", "a:second"]);
});

test("KeyedSerialExecutor 的失败不会污染后续队列或产生未处理派生 rejection", async () => {
  const { KeyedSerialExecutor } = require("../src/platform/shared/keyedSerialExecutor.js");
  const executor = new KeyedSerialExecutor();
  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on("unhandledRejection", onUnhandled);
  try {
    await executor.run("task", async () => { throw new Error("expected failure"); })
      .catch((error) => assert.match(error.message, /expected failure/));
    assert.equal(await executor.run("task", async () => "recovered"), "recovered");
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
  }
});

test("崩溃留下 started receipt 时 fail-closed，工具副作用不会重复", async () => {
  const root = await mkdtemp(join(tmpdir(), "yaoguo-crash-receipt-"));
  try {
    const store = new TaskSessionStore({ projectService: createProjectService(root) });
    const scope = { projectId: "p", taskId: "t", turnId: "crashed-turn", runId: "run-1" };
    const message = "崩溃前执行一次不可重复写入";
    await store.appendMessage({ ...scope, role: "user", content: message });
    await store.beginTurnExecution({
      ...scope,
      inputDigest: createHash("sha256").update(message, "utf8").digest("hex")
    });
    let sideEffects = 1; // started 已落盘后工具执行，随后进程崩溃。
    const coordinator = new TaskAgentCoordinator({ sessionStore: store });
    const engine = createDurableAgentInputEngine(store, coordinator, async () => {
      sideEffects += 1;
      return { reply: "不应执行", cancelled: false, blocked: false };
    });

    const replay = await engine.submitAgentInput({ ...scope, message });
    assert.equal(replay.disposition, "execution_interrupted");
    assert.equal(replay.blocked, true);
    assert.equal(replay.stopCode, "AGENT_EXECUTION_INTERRUPTED");
    assert.equal(sideEffects, 1);

    const receipts = (await readSessionEvents(store, "p", "t"))
      .filter((row) => row.type.startsWith("turn.execution-"));
    assert.deepEqual(receipts.map((row) => row.type), ["turn.execution-started"]);
    assert.match(receipts[0].inputDigest, /^[a-f0-9]{64}$/);
    assert.equal(receipts[0].content, undefined);
    assert.equal(receipts[0].message, undefined);
    assert.equal(receipts[0].args, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("崩溃留下半行 JSONL 时重启严格失败关闭", async () => {
  const root = await mkdtemp(join(tmpdir(), "yaoguo-torn-session-"));
  try {
    const projectService = createProjectService(root);
    const scope = { projectId: "p", taskId: "t", turnId: "torn-turn", runId: "run-1" };
    const message = "只允许执行一次";
    const digest = createHash("sha256").update(message, "utf8").digest("hex");
    const first = new TaskSessionStore({ projectService });
    await first.beginTurnExecution({ ...scope, inputDigest: digest });
    await appendFile(first.getEventsFile("p", "t"), '{"type":"turn.execution-finished"', "utf8");

    const restarted = new TaskSessionStore({ projectService });
    await assert.rejects(
      () => restarted.beginTurnExecution({ ...scope, inputDigest: digest }),
      (error) => error.code === "TASK_SESSION_CORRUPT"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("会话损坏不得被 replay 查询吞掉后继续执行 Agent", async () => {
  const root = await mkdtemp(join(tmpdir(), "yaoguo-corrupt-replay-"));
  try {
    const projectService = createProjectService(root);
    const store = new TaskSessionStore({ projectService });
    await store.appendMessage({
      projectId: "p", taskId: "t", turnId: "old", role: "user", content: "旧消息"
    });
    await appendFile(store.getEventsFile("p", "t"), '{"type":"message"', "utf8");
    let executions = 0;
    const engine = createDurableAgentInputEngine(
      store,
      new TaskAgentCoordinator({ sessionStore: store }),
      async () => { executions += 1; return { reply: "不应执行" }; }
    );
    await assert.rejects(
      engine.submitAgentInput({ projectId: "p", taskId: "t", turnId: "new", message: "新任务" }),
      (error) => error.code === "TASK_SESSION_CORRUPT"
    );
    assert.equal(executions, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("steering 在 Pi 可消费前已 durable 标记，crash gap 不会重放为新 turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "yaoguo-steering-crash-receipt-"));
  try {
    const store = new TaskSessionStore({ projectService: createProjectService(root) });
    const coordinator = new TaskAgentCoordinator({ sessionStore: store });
    const activeScope = { projectId: "p", taskId: "t", turnId: "active-turn", runId: "active-run" };
    const control = createAgentTurnControl(new AbortController());
    const unregister = coordinator.registerActive(activeScope, control);
    const steeringScope = { projectId: "p", taskId: "t", turnId: "steering-turn" };
    const message = "执行中改为蓝色并写入文件";
    await store.appendMessage({ ...steeringScope, role: "user", content: message });
    let operationRuns = 0;
    const pending = coordinator.submitMessage(steeringScope, message, async () => {
      operationRuns += 1;
      return { reply: "must-not-replay", blocked: false, cancelled: false };
    });
    assert.equal(await waitUntil(() => control.hasSteering()), true);
    const beforeTake = await store.findTurnExecution(steeringScope);
    assert.equal(beforeTake.state, "interrupted", "Pi 取得 steering 前 started receipt 必须已 sync");
    assert.deepEqual(control.takeSteering().map((row) => row.content), [message]);
    let sideEffects = 1; // Pi 已消费并产生副作用，终态之前模拟崩溃。

    const replayEngine = createDurableAgentInputEngine(
      store,
      new TaskAgentCoordinator({ sessionStore: store }),
      async () => {
        sideEffects += 1;
        operationRuns += 1;
        return { reply: "duplicate", blocked: false, cancelled: false };
      }
    );
    const replay = await replayEngine.submitAgentInput({ ...steeringScope, message });
    assert.equal(replay.disposition, "execution_interrupted");
    assert.equal(replay.blocked, true);
    assert.equal(sideEffects, 1);
    assert.equal(operationRuns, 0);

    unregister({ text: "steering 已完成", aborted: false, exhausted: false });
    control.close();
    assert.equal((await pending).disposition, "steered");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("正常与失败终态 receipt 可稳定 replay，operation 开始前 started 已落盘", async () => {
  const root = await mkdtemp(join(tmpdir(), "yaoguo-terminal-receipt-"));
  try {
    const store = new TaskSessionStore({ projectService: createProjectService(root) });
    let runs = 0;
    const coordinator = new TaskAgentCoordinator({ sessionStore: store });
    const engine = createDurableAgentInputEngine(store, coordinator, async (payload, options) => {
      const duringRun = await store.findTurnExecution(payload);
      assert.equal(duringRun.state, "interrupted", "operation 前必须已写入并 sync started receipt");
      runs += 1;
      const reply = "正常执行结果";
      if (!options.skipAssistantLog) {
        await store.appendMessage({ ...payload, role: "assistant", content: reply, status: "completed" });
      }
      return { reply, cancelled: false, blocked: false, taskId: payload.taskId, turnId: payload.turnId };
    });
    const payload = { projectId: "p", taskId: "t", turnId: "completed-turn", message: "执行正常任务" };
    assert.equal((await engine.submitAgentInput(payload)).reply, "正常执行结果");
    const replayEngine = createDurableAgentInputEngine(
      store,
      new TaskAgentCoordinator({ sessionStore: store }),
      async () => { runs += 1; throw new Error("不应重放"); }
    );
    const replay = await replayEngine.submitAgentInput(payload);
    assert.equal(replay.disposition, "replayed");
    assert.equal(replay.reply, "正常执行结果");
    assert.equal(runs, 1);
    assert.equal((await store.findTurnExecution(payload)).terminal.status, "completed");

    let failedRuns = 0;
    const failedScope = { projectId: "p", taskId: "t", turnId: "failed-turn", runId: "run-failed" };
    const failedCoordinator = new TaskAgentCoordinator({ sessionStore: store });
    await assert.rejects(failedCoordinator.submitMessage(failedScope, "执行失败任务", async () => {
      failedRuns += 1;
      throw Object.assign(new Error("expected"), { code: "EXPECTED_FAILURE" });
    }), /expected/);
    const failedReplay = await new TaskAgentCoordinator({ sessionStore: store }).submitMessage(
      failedScope,
      "执行失败任务",
      async () => { failedRuns += 1; }
    );
    assert.equal(failedReplay.disposition, "execution_failed");
    assert.equal(failedReplay.blocked, true);
    assert.equal(failedReplay.stopCode, "EXPECTED_FAILURE");
    assert.equal(failedRuns, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("skipAssistantLog 不持久化正文，仍可依赖最小终态 receipt 稳定 replay", async () => {
  const root = await mkdtemp(join(tmpdir(), "yaoguo-skip-log-receipt-"));
  try {
    const store = new TaskSessionStore({ projectService: createProjectService(root) });
    let runs = 0;
    const runTurn = async (_payload, options) => {
      assert.equal(options.skipAssistantLog, true);
      runs += 1;
      return { reply: "不得写入 receipt 的模型正文", cancelled: false, blocked: false };
    };
    const payload = { projectId: "p", taskId: "t", turnId: "skip-log-turn", message: "内部续跑" };
    const firstEngine = createDurableAgentInputEngine(
      store,
      new TaskAgentCoordinator({ sessionStore: store }),
      runTurn
    );
    const first = await firstEngine.submitAgentInput(payload, { skipAssistantLog: true });
    assert.equal(first.reply, "不得写入 receipt 的模型正文");

    const replayEngine = createDurableAgentInputEngine(
      store,
      new TaskAgentCoordinator({ sessionStore: store }),
      runTurn
    );
    const replay = await replayEngine.submitAgentInput(payload, { skipAssistantLog: true });
    assert.equal(replay.disposition, "execution_completed");
    assert.equal(replay.blocked, false);
    assert.equal(runs, 1);
    assert.deepEqual((await store.listMessages(payload)).map((row) => row.role), ["user"]);
    assert.equal((await readFile(store.getEventsFile("p", "t"), "utf8"))
      .includes("不得写入 receipt 的模型正文"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Pi 已消费后不重放副作用；只有未消费消息回退到 task 队列", async () => {
  const events = [];
  const coordinator = new TaskAgentCoordinator({
    sessionStore: { appendEvent: async (event) => { events.push(event); } }
  });
  const scope = { projectId: "p", taskId: "t", turnId: "turn-2" };

  const firstControl = createAgentTurnControl(new AbortController());
  const unregisterFirst = coordinator.registerActive(scope, firstControl);
  let duplicateRuns = 0;
  const steered = coordinator.submitMessage(scope, "改成蓝色", async () => {
    duplicateRuns += 1;
    return "duplicate";
  });
  assert.equal(await waitUntil(() => firstControl.hasSteering()), true);
  assert.deepEqual(firstControl.takeSteering().map((row) => row.content), ["改成蓝色"]);
  unregisterFirst({ text: "已经按 steering 完成", aborted: false, exhausted: false });
  firstControl.close();
  assert.equal((await steered).disposition, "steered");
  assert.equal(duplicateRuns, 0);
  assert.equal(events[0].type, "turn.steered");

  const abortedControl = createAgentTurnControl(new AbortController());
  const unregisterAborted = coordinator.registerActive(scope, abortedControl);
  let operationRuns = 0;
  let sideEffects = 1;
  const afterAbort = coordinator.submitMessage(
    { ...scope, turnId: "turn-aborted-steering" },
    "必须保留的补充",
    async () => {
      operationRuns += 1;
      sideEffects += 1;
      return "must-not-replay";
    }
  );
  assert.equal(await waitUntil(() => abortedControl.hasSteering()), true);
  assert.deepEqual(abortedControl.takeSteering().map((row) => row.content), ["必须保留的补充"]);
  unregisterAborted({ text: "", aborted: true, exhausted: true });
  abortedControl.close();
  const aborted = await afterAbort;
  assert.equal(aborted.disposition, "steering_cancelled");
  assert.equal(aborted.cancelled, true);
  assert.equal(operationRuns, 0);
  assert.equal(sideEffects, 1, "steering 已触发的副作用不得被自动重放");

  const failedControl = createAgentTurnControl(new AbortController());
  const unregisterFailed = coordinator.registerActive(scope, failedControl);
  const afterFailure = coordinator.submitMessage(
    { ...scope, turnId: "turn-failed-steering" },
    "失败前已消费的补充",
    async () => { operationRuns += 1; return "must-not-replay"; }
  );
  assert.equal(await waitUntil(() => failedControl.hasSteering()), true);
  failedControl.takeSteering();
  unregisterFailed({ text: "", aborted: false, exhausted: true, stopCode: "AGENT_EMPTY_RESULT" });
  failedControl.close();
  const failed = await afterFailure;
  assert.equal(failed.disposition, "steering_failed");
  assert.equal(failed.blocked, true);
  assert.equal(failed.stopCode, "AGENT_EMPTY_RESULT");
  assert.equal(operationRuns, 0);

  const closingControl = createAgentTurnControl(new AbortController());
  const unregisterClosing = coordinator.registerActive(scope, closingControl);
  const recovered = coordinator.submitMessage(scope, "补充结论", async () => "recovered");
  closingControl.close();
  unregisterClosing();
  assert.equal(await recovered, "recovered");
});

test("abortAll 撤销所有活动 turn，不因单个异常 control 遗留旧权限快照", () => {
  const coordinator = new TaskAgentCoordinator();
  const reasons = [];
  coordinator.registerActive({ projectId: "p", taskId: "a" }, {
    abort: (reason) => { reasons.push(["a", reason]); return true; }
  });
  coordinator.registerActive({ projectId: "p", taskId: "b" }, {
    abort: () => { throw new Error("broken control"); }
  });
  coordinator.registerActive({ projectId: "p", taskId: "c" }, {
    abort: (reason) => { reasons.push(["c", reason]); return true; }
  });

  assert.equal(coordinator.abortAll("权限设置已变更"), 2);
  assert.deepEqual(reasons, [
    ["a", "权限设置已变更"],
    ["c", "权限设置已变更"]
  ]);
});

test("删除任务先停止活动 Agent、排空队列，并拒绝该任务的新执行", async () => {
  const coordinator = new TaskAgentCoordinator();
  const scope = { projectId: "p-delete", taskId: "t-delete" };
  let unregister = null;
  let aborts = 0;
  unregister = coordinator.registerActive(scope, {
    abort: () => {
      aborts += 1;
      queueMicrotask(() => unregister({ aborted: true }));
      return true;
    }
  });

  const result = await coordinator.abortScope(scope, "测试删除");
  assert.equal(result.aborted, true);
  assert.equal(aborts, 1);
  await assert.rejects(
    () => coordinator.runExclusive(scope, async () => "不应执行"),
    (error) => error.code === "AGENT_SCOPE_DELETED"
  );
  coordinator.releaseScope(scope);
  assert.equal(await coordinator.runExclusive(scope, async () => "恢复"), "恢复");
});

test("删除项目阻止该项目所有任务，但不影响其他项目", async () => {
  const coordinator = new TaskAgentCoordinator();
  await coordinator.abortProject("p-delete");
  await assert.rejects(
    () => coordinator.runExclusive({ projectId: "p-delete", taskId: "a" }, async () => "no"),
    (error) => error.code === "AGENT_SCOPE_DELETED"
  );
  assert.equal(
    await coordinator.runExclusive({ projectId: "p-keep", taskId: "a" }, async () => "ok"),
    "ok"
  );
});

test("同一 turnId 并发重试复用同一执行，不同正文则明确冲突", async () => {
  const coordinator = new TaskAgentCoordinator();
  let release;
  let runs = 0;
  const gate = new Promise((resolve) => { release = resolve; });
  const scope = { projectId: "p", taskId: "t", turnId: "stable-turn" };
  const first = coordinator.submitMessage(scope, "相同输入", async () => {
    runs += 1;
    await gate;
    return "done";
  });
  const duplicate = coordinator.submitMessage(scope, "相同输入", async () => {
    runs += 1;
    return "duplicate";
  });
  await assert.rejects(
    coordinator.submitMessage(scope, "不同输入", async () => "invalid"),
    (error) => error.code === "AGENT_TURN_CONFLICT"
  );
  release();
  assert.deepEqual(await Promise.all([first, duplicate]), ["done", "done"]);
  assert.equal(runs, 1);
});
