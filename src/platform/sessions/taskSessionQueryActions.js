const path = require("node:path");
const { scanJsonl } = require("./sessionEventFile");
const { MAX_MESSAGE_WINDOW, assertSessionScope } = require("./taskSessionPolicy");
const {
  readStableSessionFile,
  updateHistoryProjection
} = require("./taskSessionProjection");

async function externalizeHistory(store, { projectId = "", taskId = "" } = {}) {
  assertSessionScope(projectId, taskId);
  await store.ensureMigrated(projectId, taskId);
  const directory = await store.ensureStorageDirectory(projectId, taskId, "agent-inputs");
  const file = path.join(directory, "task-history.md");
  const cursorFile = path.join(directory, ".task-history.cursor.json");
  const eventsFile = await store.resolveEventsFile(projectId, taskId);
  const stat = await store.writes.run(`${projectId}::${taskId}`, () => (
    updateHistoryProjection({
      eventsFile,
      file,
      cursorFile,
      hydrate: (row) => store.hydrateEvent(projectId, taskId, row)
    })
  ));
  return { absolute: file, bytes: stat.size };
}

async function listMessages(store, { projectId = "", taskId = "", limit = 160 } = {}) {
  return (await listMessageWindow(store, { projectId, taskId, limit })).rows;
}

async function listMessageWindow(store, { projectId = "", taskId = "", limit = 160 } = {}) {
  assertSessionScope(projectId, taskId);
  await store.ensureMigrated(projectId, taskId);
  const windowSize = normalizeMessageWindowLimit(limit);
  const file = await store.resolveEventsFile(projectId, taskId);
  return readStableSessionFile(file, async () => {
    const ring = new Array(windowSize);
    let total = 0;
    await scanJsonl(file, {
      strict: true,
      onRow: (row) => {
        if (row.type !== "message" || !["user", "assistant", "system"].includes(row.role)) return;
        total += 1;
        ring[(total - 1) % windowSize] = row;
      }
    });
    const count = Math.min(total, windowSize);
    const start = total > windowSize ? total % windowSize : 0;
    const rows = Array.from({ length: count }, (_, index) => ring[(start + index) % windowSize]);
    return {
      rows: await hydrateRows(rows, (row) => store.hydrateEvent(projectId, taskId, row)),
      total
    };
  });
}

async function findMessage(store, { projectId = "", taskId = "", turnId = "", role = "" } = {}) {
  if (!turnId) return null;
  assertSessionScope(projectId, taskId);
  await store.ensureMigrated(projectId, taskId);
  const file = await store.resolveEventsFile(projectId, taskId);
  return readStableSessionFile(file, async () => {
    let found = null;
    await scanJsonl(file, {
      strict: true,
      onRow: (row) => {
        if (row.type === "message" && row.turnId === turnId && (!role || row.role === role)) found = row;
      }
    });
    return found ? store.hydrateEvent(projectId, taskId, found) : null;
  });
}

async function findEvent(store, { projectId = "", taskId = "", eventId = "" } = {}) {
  if (!eventId) return null;
  assertSessionScope(projectId, taskId);
  await store.ensureMigrated(projectId, taskId);
  return scanEventById(store, projectId, taskId, eventId);
}

async function findLatestEvent(store, {
  projectId = "", taskId = "", type = ""
} = {}) {
  if (!type) return null;
  assertSessionScope(projectId, taskId);
  await store.ensureMigrated(projectId, taskId);
  const file = await store.resolveEventsFile(projectId, taskId);
  return readStableSessionFile(file, async () => {
    let found = null;
    await scanJsonl(file, {
      strict: true,
      onRow: (row) => {
        if (row.type === type) found = row;
      }
    });
    return found ? store.hydrateEvent(projectId, taskId, found) : null;
  });
}

async function scanEventById(store, projectId, taskId, eventId) {
  const file = await store.resolveEventsFile(projectId, taskId);
  return readStableSessionFile(file, async () => {
    let found = null;
    await scanJsonl(file, {
      strict: true,
      onRow: (row) => {
        if (row.eventId === eventId) found = row;
      }
    });
    return found ? store.hydrateEvent(projectId, taskId, found) : null;
  });
}

async function findTurnExecutionRows(store, projectId, taskId, turnId) {
  assertSessionScope(projectId, taskId);
  const file = await store.resolveEventsFile(projectId, taskId);
  return readStableSessionFile(file, async () => {
    let started = null;
    let terminal = null;
    await scanJsonl(file, {
      strict: true,
      onRow: (row) => {
        if (row.turnId !== turnId) return;
        if (row.type === "turn.execution-started") started = row;
        if (row.type === "turn.execution-finished") terminal = row;
      }
    });
    return { started, terminal };
  });
}

function normalizeMessageWindowLimit(value) {
  const requested = Math.max(1, Math.floor(Number(value) || 160));
  return Math.min(requested, MAX_MESSAGE_WINDOW);
}

async function hydrateRows(rows, hydrate) {
  const hydrated = [];
  for (const row of rows) hydrated.push(await hydrate(row));
  return hydrated;
}

module.exports = {
  externalizeHistory,
  findEvent,
  findLatestEvent,
  findMessage,
  findTurnExecutionRows,
  listMessageWindow,
  listMessages,
  scanEventById
};
