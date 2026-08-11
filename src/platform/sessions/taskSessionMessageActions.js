const crypto = require("node:crypto");
const fsp = require("node:fs/promises");
const { writeTextAtomic } = require("../shared/fs");
const { appendJsonlDurable } = require("./sessionEventFile");
const {
  messageContentDigest,
  readContentBody,
  regularFileExistsNoFollow,
  sha256Text,
  corruptSessionContentError
} = require("./taskSessionContent");
const {
  SESSION_VERSION,
  SESSION_INLINE_CONTENT_CHARS,
  assertSessionScope
} = require("./taskSessionPolicy");

async function externalizeInput(store, {
  projectId = "", taskId = "", turnId = "", content = ""
} = {}) {
  assertSessionScope(projectId, taskId);
  void turnId;
  const stored = await persistContentBody(store, projectId, taskId, `${content || ""}`);
  return { absolute: stored.absolute, bytes: stored.bytes, sha256: stored.sha256 };
}

async function appendMessage(store, {
  projectId = "", taskId = "", role = "user", content = "", turnId = "",
  runId = "", source = "desktop", status = "accepted", ...metadata
} = {}) {
  assertSessionScope(projectId, taskId);
  if (!["user", "assistant", "system"].includes(role)) throw new Error("任务消息 role 不合法。");
  const text = `${content || ""}`;
  if (!text.trim()) return null;
  await store.ensureMigrated(projectId, taskId);
  const storedContent = text.length > SESSION_INLINE_CONTENT_CHARS
    ? await persistContentBody(store, projectId, taskId, text)
    : null;
  const contentSha256 = sha256Text(text);
  const eventId = `${metadata.eventId || (turnId ? `${role}:${turnId}` : crypto.randomUUID())}`;
  return appendEvent(store, {
    ...metadata,
    eventId,
    type: "message",
    version: SESSION_VERSION,
    projectId,
    taskId,
    turnId: `${turnId || ""}`,
    runId: `${runId || ""}`,
    source: `${source || "desktop"}`,
    status: `${status || "accepted"}`,
    role,
    contentSha256,
    contentChars: text.length,
    contentBytes: Buffer.byteLength(text),
    ...(storedContent
      ? { contentRef: { version: 1, sha256: storedContent.sha256 } }
      : { content: text })
  }, { deduplicate: true, skipMigration: true });
}

async function appendEvent(store, event = {}, { deduplicate = false, skipMigration = false } = {}) {
  const projectId = `${event.projectId || ""}`;
  const taskId = `${event.taskId || ""}`;
  assertSessionScope(projectId, taskId);
  if (!skipMigration) await store.ensureMigrated(projectId, taskId);
  const file = await store.resolveEventsFile(projectId, taskId);
  const key = `${projectId}::${taskId}`;
  return store.writes.run(key, async () => {
    if (deduplicate && event.eventId) {
      const existing = await store.scanEventById(projectId, taskId, event.eventId);
      if (existing) {
        if (event.type === "message" && (
          existing.type !== "message"
          || existing.role !== event.role
          || messageContentDigest(existing) !== messageContentDigest(event)
        )) {
          throw Object.assign(new Error("同一任务事件 ID 对应了不同消息。"), {
            code: "TASK_EVENT_CONFLICT"
          });
        }
        return existing;
      }
    }
    const row = {
      ...event,
      eventId: `${event.eventId || crypto.randomUUID()}`,
      createdAt: `${event.createdAt || store.clock().toISOString()}`
    };
    await appendJsonlDurable(file, row);
    return row;
  });
}

async function appendDurableEvent(store, projectId, taskId, row) {
  await appendJsonlDurable(await store.resolveEventsFile(projectId, taskId), row);
}

async function persistContentBody(store, projectId, taskId, content) {
  const text = `${content || ""}`;
  const sha256 = sha256Text(text);
  const absolute = await store.resolveContentBodyFile(projectId, taskId, sha256);
  return store.writes.run(`${projectId}::${taskId}::content:${sha256}`, async () => {
    if (await regularFileExistsNoFollow(absolute)) {
      const existing = await readContentBody(absolute, sha256);
      return { absolute, sha256, bytes: Buffer.byteLength(existing) };
    }
    await writeTextAtomic(absolute, text);
    await fsp.chmod(absolute, 0o600);
    const confirmed = await readContentBody(absolute, sha256);
    return { absolute, sha256, bytes: Buffer.byteLength(confirmed) };
  });
}

async function hydrateEvent(store, projectId, taskId, row = {}) {
  if (row.type !== "message" || typeof row.content === "string" || !row.contentRef?.sha256) return row;
  const sha256 = `${row.contentRef.sha256 || ""}`;
  if (!/^[a-f0-9]{64}$/i.test(sha256)) throw corruptSessionContentError();
  const content = await readContentBody(
    await store.resolveContentBodyFile(projectId, taskId, sha256),
    sha256
  );
  if (Number.isSafeInteger(Number(row.contentBytes)) && Number(row.contentBytes) !== Buffer.byteLength(content)) {
    throw corruptSessionContentError();
  }
  return { ...row, content };
}

async function readContentBodyRef(store, { projectId = "", taskId = "", sha256 = "" } = {}) {
  assertSessionScope(projectId, taskId);
  if (!/^[a-f0-9]{64}$/i.test(`${sha256 || ""}`)) throw corruptSessionContentError();
  return readContentBody(
    await store.resolveContentBodyFile(projectId, taskId, `${sha256}`),
    `${sha256}`
  );
}

module.exports = {
  appendDurableEvent,
  appendEvent,
  appendMessage,
  externalizeInput,
  hydrateEvent,
  persistContentBody,
  readContentBodyRef
};
