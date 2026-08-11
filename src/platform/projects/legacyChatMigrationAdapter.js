// @ts-check

const path = require("node:path");
const fsp = require("node:fs/promises");
const {
  appendText,
  ensureDir,
  exists,
  writeTextAtomic
} = require("../shared/fs");
const { sanitizeFileName } = require("../runtime");

/**
 * 只读取和清理旧版 workspace/chats 与 projects/<id>/chats 数据。
 * 生产 Agent 只使用 TaskSessionStore；这个 adapter 不参与新消息写入。
 */
class LegacyChatMigrationAdapter {
  /** @param {any} paths @param {{ensureLegacyProject?:() => Promise<void>}} options */
  constructor(paths = {}, { ensureLegacyProject = null } = {}) {
    this.paths = paths;
    this.ensureLegacyProject = ensureLegacyProject;
  }

  projectChatDir(projectId = "") {
    const safeProjectId = sanitizeFileName(projectId || "legacy", "project");
    return path.join(this.paths.projectsDir, safeProjectId, "chats");
  }

  harnessTraceDir(projectId = "") {
    return path.join(this.projectChatDir(projectId), "harness-traces");
  }

  async listGlobalFiles() {
    if (!this.paths.chatsDir || !(await exists(this.paths.chatsDir))) return [];
    return (await fsp.readdir(this.paths.chatsDir))
      .filter((file) => file.endsWith(".jsonl"))
      .sort()
      .map((file) => path.join(this.paths.chatsDir, file));
  }

  async listProjectFiles(projectId = "") {
    const dir = this.projectChatDir(projectId);
    if (!(await exists(dir))) return [];
    return (await fsp.readdir(dir))
      .filter((file) => file.endsWith(".jsonl"))
      .sort()
      .map((file) => path.join(dir, file));
  }

  async migrateGlobalChatsToProjects() {
    if (!this.paths.chatsDir || !(await exists(this.paths.chatsDir))) {
      return { migrated: 0, skipped: true };
    }
    const marker = path.join(this.paths.chatsDir, ".project-chats-migrated");
    if (await exists(marker)) return { migrated: 0, skipped: true };
    let migrated = 0;
    let legacyNeeded = false;
    for (const file of await this.listGlobalFiles()) {
      const buckets = bucketLegacyRows(await readJsonl(file));
      for (const [projectId, rows] of buckets.entries()) {
        if (!rows.length) continue;
        if (projectId === "legacy") {
          legacyNeeded = true;
          await this.ensureLegacyProject?.();
        }
        const dir = this.projectChatDir(projectId);
        await ensureDir(dir);
        await appendText(path.join(dir, path.basename(file)), `${rows.map(JSON.stringify).join("\n")}\n`);
        migrated += rows.length;
      }
    }
    if (legacyNeeded) await this.ensureLegacyProject?.();
    await writeTextAtomic(marker, `${new Date().toISOString()}\n`);
    return { migrated, skipped: false };
  }

  async readTaskMessages(projectId = "", taskId = "") {
    if (!projectId || !taskId) return [];
    const files = [
      ...await this.listProjectFiles(projectId),
      ...await this.listGlobalFiles()
    ];
    const seen = new Set();
    const rows = [];
    for (const file of files) {
      for (const item of await readJsonl(file)) {
        if (item.projectId !== projectId || item.taskId !== taskId) continue;
        if (!["user", "assistant", "system"].includes(item.role) || !`${item.content || ""}`.trim()) continue;
        const identity = legacyRowIdentity(item);
        if (seen.has(identity)) continue;
        seen.add(identity);
        rows.push(item);
      }
    }
    return rows;
  }

  async hasTaskMessages(projectId = "", taskId = "", since = "") {
    const sinceTime = Date.parse(since || "");
    const hasSince = Number.isFinite(sinceTime);
    const rows = await this.readTaskMessages(projectId, taskId);
    return rows.some((item) => {
      if (!hasSince) return true;
      const created = Date.parse(item.createdAt || "");
      return Number.isFinite(created) && created >= sinceTime - 1000;
    });
  }

  async projectHasLegacyContent(projectId = "") {
    if (!projectId) return false;
    for (const file of await this.listProjectFiles(projectId)) {
      if ((await fsp.stat(file).catch(() => null))?.size > 0) return true;
    }
    for (const file of await this.listGlobalFiles()) {
      if ((await readJsonl(file)).some((item) => item.projectId === projectId)) return true;
    }
    return false;
  }

  async prune({ projectId = "", taskId = "" } = {}) {
    if (!projectId) return { removed: 0 };
    const files = [
      ...await this.listProjectFiles(projectId),
      ...await this.listGlobalFiles()
    ];
    return rewriteLegacyFiles(files, (item) => (
      item.projectId === projectId && (!taskId || item.taskId === taskId)
    ));
  }

  async pruneStale(cutoffs = new Map()) {
    if (!(cutoffs instanceof Map) || !cutoffs.size) return { removed: 0 };
    const projectIds = new Set([...cutoffs.keys()].map((key) => `${key}`.split("::")[0]).filter(Boolean));
    const files = [...await this.listGlobalFiles()];
    for (const projectId of projectIds) files.push(...await this.listProjectFiles(projectId));
    return rewriteLegacyFiles([...new Set(files)], (item) => {
      const key = `${item.projectId || ""}::${item.taskId || ""}`;
      const cutoff = cutoffs.get(key) || cutoffs.get(`${item.projectId || ""}::`) || 0;
      const created = Date.parse(item.createdAt || "");
      return Boolean(cutoff && (!Number.isFinite(created) || created < cutoff - 1000));
    });
  }
}

function bucketLegacyRows(rows = []) {
  const buckets = new Map();
  for (const item of rows) {
    const projectId = `${item?.projectId || "legacy"}`;
    if (!buckets.has(projectId)) buckets.set(projectId, []);
    buckets.get(projectId).push(item);
  }
  return buckets;
}

async function rewriteLegacyFiles(files, shouldRemove) {
  let removed = 0;
  for (const file of files) {
    const rows = await readJsonlWithRaw(file);
    const kept = [];
    let changed = false;
    for (const row of rows) {
      if (row.value && shouldRemove(row.value)) {
        removed += 1;
        changed = true;
      } else {
        kept.push(row.raw);
      }
    }
    if (changed) await writeTextAtomic(file, kept.length ? `${kept.join("\n")}\n` : "");
  }
  return { removed };
}

async function readJsonl(file) {
  return (await readJsonlWithRaw(file)).map((row) => row.value).filter(Boolean);
}

async function readJsonlWithRaw(file) {
  const content = await fsp.readFile(file, "utf8").catch(() => "");
  const rows = [];
  for (const line of content.split(/\n/)) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line);
      rows.push({ raw: JSON.stringify(value), value });
    } catch {
      rows.push({ raw: line, value: null });
    }
  }
  return rows;
}

function legacyRowIdentity(row = {}) {
  return [row.role, row.turnId, row.createdAt, row.content].map((value) => `${value || ""}`).join("\u0000");
}

module.exports = { LegacyChatMigrationAdapter };
