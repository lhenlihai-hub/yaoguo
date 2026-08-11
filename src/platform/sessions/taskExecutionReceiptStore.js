// @ts-check

const crypto = require("node:crypto");

const TERMINAL_STATUSES = new Set(["completed", "cancelled", "blocked", "failed"]);

/** @param {any} store @param {any} input */
async function beginTurnExecution(store, {
  projectId = "", taskId = "", turnId = "", runId = "", executionId = "", inputDigest = ""
} = {}) {
  assertScope(projectId, taskId);
  assertIdentity(turnId, inputDigest);
  await store.ensureMigrated(projectId, taskId);
  return store.writes.run(`${projectId}::${taskId}`, async () => {
    const state = await readExecutionRows(store, projectId, taskId, turnId);
    assertMatchingInput(state.started, inputDigest);
    if (state.terminal) return { state: "terminal", ...state };
    if (state.started) return { state: "interrupted", ...state };
    const started = {
      eventId: `execution-started:${turnId}`,
      type: "turn.execution-started",
      version: 1,
      projectId,
      taskId,
      turnId,
      runId: `${runId || ""}`,
      executionId: `${executionId || crypto.randomUUID()}`,
      inputDigest,
      status: "started",
      createdAt: store.clock().toISOString()
    };
    await store.appendDurableEvent(projectId, taskId, started);
    return { state: "started", started, terminal: null };
  });
}

/** @param {any} store @param {any} input */
async function finishTurnExecution(store, {
  projectId = "", taskId = "", turnId = "", executionId = "",
  runId = "", status = "failed", stopCode = ""
} = {}) {
  assertScope(projectId, taskId);
  if (!turnId) throw new Error("Turn execution 缺少 turnId。");
  if (!TERMINAL_STATUSES.has(status)) throw new Error(`Turn execution 终态不合法：${status}`);
  await store.ensureMigrated(projectId, taskId);
  return store.writes.run(`${projectId}::${taskId}`, async () => {
    const state = await readExecutionRows(store, projectId, taskId, turnId);
    if (state.terminal) return state.terminal;
    if (!state.started) throw codedError("TASK_EXECUTION_NOT_STARTED", "Turn execution 尚未持久化 started receipt。");
    if (executionId && state.started.executionId !== executionId) {
      throw codedError("TASK_EXECUTION_CONFLICT", "Turn executionId 与 started receipt 不匹配。");
    }
    const terminal = {
      eventId: `execution-finished:${turnId}`,
      type: "turn.execution-finished",
      version: 1,
      projectId,
      taskId,
      turnId,
      runId: `${runId || state.started.runId || ""}`,
      executionId: `${state.started.executionId || executionId || ""}`,
      status,
      stopCode: `${stopCode || ""}`,
      createdAt: store.clock().toISOString()
    };
    await store.appendDurableEvent(projectId, taskId, terminal);
    return terminal;
  });
}

/** @param {any} store @param {any} input */
async function findTurnExecution(store, { projectId = "", taskId = "", turnId = "" } = {}) {
  if (!turnId) return { state: "none", started: null, terminal: null };
  assertScope(projectId, taskId);
  await store.ensureMigrated(projectId, taskId);
  const state = await readExecutionRows(store, projectId, taskId, turnId);
  return { state: state.terminal ? "terminal" : (state.started ? "interrupted" : "none"), ...state };
}

async function readExecutionRows(store, projectId, taskId, turnId) {
  if (typeof store.findTurnExecutionRows !== "function") {
    throw new TypeError("TaskSessionStore 缺少 findTurnExecutionRows。");
  }
  return store.findTurnExecutionRows(projectId, taskId, turnId);
}

function assertScope(projectId, taskId) {
  if (!projectId || !taskId) throw new Error("Turn execution 缺少 projectId 或 taskId。");
}

function assertIdentity(turnId, inputDigest) {
  if (!turnId) throw new Error("Turn execution 缺少 turnId。");
  if (!/^[a-f0-9]{64}$/i.test(`${inputDigest || ""}`)) throw new Error("Turn execution 缺少合法 inputDigest。");
}

function assertMatchingInput(started, inputDigest) {
  if (!started?.inputDigest || started.inputDigest === inputDigest) return;
  throw codedError("AGENT_TURN_CONFLICT", "同一 turnId 已对应另一条用户输入。");
}

function codedError(code, message) {
  return Object.assign(new Error(message), { code });
}

module.exports = { beginTurnExecution, finishTurnExecution, findTurnExecution };
