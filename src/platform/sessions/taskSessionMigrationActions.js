const crypto = require("node:crypto");
const path = require("node:path");
const { writeTextAtomic } = require("../shared/fs");
const { appendJsonlDurable, scanJsonl } = require("./sessionEventFile");
const { regularFileExistsNoFollow } = require("./taskSessionContent");
const { SESSION_VERSION, assertSessionScope } = require("./taskSessionPolicy");

async function ensureMigrated(store, projectId, taskId) {
  assertSessionScope(projectId, taskId);
  const key = `${projectId}::${taskId}`;
  if (store.migrations.has(key)) return store.migrations.get(key);
  const migration = store.writes.run(key, async () => {
    const dir = await store.ensureStorageDirectory(projectId, taskId, "session");
    const marker = path.join(dir, ".legacy-events-imported");
    if (await regularFileExistsNoFollow(marker)) return { imported: 0, skipped: true };
    const legacy = await readLegacyMessages(store, projectId, taskId);
    const pending = new Map(legacy.sort(compareEvents).map((item) => [eventIdentity(item), item]));
    const eventsFile = path.join(dir, "events.jsonl");
    await scanJsonl(eventsFile, {
      strict: true,
      onRow: (row) => pending.delete(eventIdentity(row))
    });
    let imported = 0;
    for (const item of pending.values()) {
      const row = {
        ...item,
        eventId: `${item.eventId || `legacy:${crypto.createHash("sha256").update(eventIdentity(item)).digest("hex").slice(0, 24)}`}`,
        type: "message",
        version: SESSION_VERSION,
        projectId,
        taskId,
        source: "legacy-import"
      };
      await appendJsonlDurable(eventsFile, row);
      imported += 1;
    }
    await writeTextAtomic(marker, `${store.clock().toISOString()}\n`);
    return { imported, skipped: false };
  });
  store.migrations.set(key, migration);
  try {
    return await migration;
  } finally {
    if (store.migrations.get(key) === migration) store.migrations.delete(key);
  }
}

async function readLegacyMessages(store, projectId, taskId) {
  if (typeof store.legacyMigration?.readTaskMessages !== "function") return [];
  return store.legacyMigration.readTaskMessages(projectId, taskId);
}

function eventIdentity(row = {}) {
  return [row.role, row.turnId, row.createdAt, row.content].map((value) => `${value || ""}`).join("\u0000");
}

function compareEvents(left = {}, right = {}) {
  return `${left.createdAt || ""}`.localeCompare(`${right.createdAt || ""}`)
    || `${left.eventId || ""}`.localeCompare(`${right.eventId || ""}`);
}

module.exports = { ensureMigrated, readLegacyMessages };
