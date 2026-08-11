// @ts-check
// TodoStore —— agent 在 run 期内可写的 working plan(mutable)。
//
// 业界对标 2025-2026:
//   - Claude Code TodoWrite:agent 一等公民工具,长任务必须的"在途意图"状态板
//   - Cursor Composer Tasks / Devin Plan:类似 mutable plan 概念
//   - OpenAI Assistants v2 (deprecated):server-side thread 内可改的 step list
//
// 与 CheckpointStore(typed handoff)的语义边界:
//   - CheckpointStore:append-only,记"已成事实"——已做决定/已否决/已确认事实
//   - TodoStore:mutable,记"在途意图"——还要做什么、做到哪了、被什么 block 住了
//   两者互补:决定一旦确立写入 handoff;计划本身的演化在 todos 里反映。
//
// 文件布局:
//   workspace/projects/<projectId>/tasks/<taskId>/runs/<runId>/todos.json
//   —— run-scoped。同 run 的所有 step / sub-agent 共享同一份 plan。
//
// schema (完整版,LLM 暴露的工具签名会简化):
//   {
//     id, text, details?, status, priority?, tags?, parentId?,
//     sourceStepId?, artifactRefs?, blockedReason?,
//     createdAt, updatedAt, completedAt?
//   }
//
// 并发:in-process Promise queue(按 runDir 串行写),避免并发覆盖。
// Electron 单进程主路径调用,这个粒度足够安全。

const path = require("node:path");
const crypto = require("node:crypto");
const { readJson, writeJsonAtomic } = require("../shared/fs");
const { KeyedSerialExecutor } = require("../shared/keyedSerialExecutor");

const VALID_STATUS = ["pending", "in_progress", "blocked", "done", "cancelled"];
const VALID_PRIORITY = ["high", "medium", "low"];

function generateId() {
  return `todo_${crypto.randomBytes(6).toString("hex")}`;
}

function nowIso() {
  return new Date().toISOString();
}

function asStringArray(value) {
  if (Array.isArray(value)) return value.map((v) => `${v}`).filter(Boolean);
  if (value === null || value === undefined || value === "") return [];
  return [`${value}`];
}

class TodoStore {
  constructor() {
    this._writes = new KeyedSerialExecutor();
  }

  todosFile(runDir = "") {
    return path.join(runDir, "todos.json");
  }

  /**
   * 把写操作排队到指定 runDir 的串行队列里,避免并发写互相覆盖。
   *
   * @template T
   * @param {string} runDir
   * @param {() => Promise<T>} op
   * @returns {Promise<T>}
   */
  _enqueue(runDir, op) {
    return this._writes.run(runDir, op);
  }

  /** 加载 todos.json(读路径,不走队列)。 */
  async _load(runDir) {
    if (!runDir) return [];
    const file = this.todosFile(runDir);
    const data = await readJson(file, { version: 1, todos: [] });
    const todos = Array.isArray(data?.todos) ? data.todos : [];
    return todos;
  }

  async _save(runDir, todos) {
    const file = this.todosFile(runDir);
    await writeJsonAtomic(file, {
      version: 1,
      updatedAt: nowIso(),
      todos
    });
  }

  /**
   * 规范化新建 todo 入参,补齐默认字段。
   */
  _normalizeNew(input = {}) {
    const now = nowIso();
    const status = VALID_STATUS.includes(input.status) ? input.status : "pending";
    const priority = VALID_PRIORITY.includes(input.priority) ? input.priority : undefined;
    // blocked 必须带 reason —— 否则 todo 处于"卡住但说不清原因"的失语状态,
    // agent / 人类 review 都没法决定怎么 unblock。
    if (status === "blocked" && !`${input.blockedReason || ""}`.trim()) {
      throw new Error("status=blocked 必须提供 blockedReason");
    }
    return {
      id: input.id || generateId(),
      text: `${input.text || ""}`.trim(),
      details: input.details ? `${input.details}` : undefined,
      status,
      priority,
      tags: asStringArray(input.tags),
      parentId: input.parentId ? `${input.parentId}` : undefined,
      sourceStepId: input.sourceStepId ? `${input.sourceStepId}` : undefined,
      artifactRefs: asStringArray(input.artifactRefs),
      blockedReason: status === "blocked" ? `${input.blockedReason}`.trim() : undefined,
      createdAt: now,
      updatedAt: now,
      completedAt: status === "done" ? now : undefined
    };
  }

  /**
   * 把 patch 合并到现有 todo,做状态机校验。
   */
  _applyPatch(current, patch = {}) {
    const next = { ...current };
    let touched = false;
    if (typeof patch.text === "string" && patch.text.trim()) { next.text = patch.text.trim(); touched = true; }
    if (typeof patch.details === "string") { next.details = patch.details || undefined; touched = true; }
    if (patch.status && VALID_STATUS.includes(patch.status)) {
      next.status = patch.status;
      touched = true;
      if (patch.status === "done") next.completedAt = nowIso();
      else if (patch.status !== "done") next.completedAt = undefined;
      if (patch.status !== "blocked") next.blockedReason = undefined;
    }
    if (patch.priority && VALID_PRIORITY.includes(patch.priority)) { next.priority = patch.priority; touched = true; }
    if (patch.priority === null) { next.priority = undefined; touched = true; }
    if (Array.isArray(patch.tags)) { next.tags = asStringArray(patch.tags); touched = true; }
    if (Array.isArray(patch.artifactRefs)) { next.artifactRefs = asStringArray(patch.artifactRefs); touched = true; }
    if (typeof patch.parentId === "string") { next.parentId = patch.parentId || undefined; touched = true; }
    if (typeof patch.blockedReason === "string") {
      next.blockedReason = next.status === "blocked" ? (patch.blockedReason.trim() || undefined) : undefined;
      touched = true;
    }
    // 切到 blocked 必须有 reason(patch 中或 current 中至少一处)
    if (next.status === "blocked" && !next.blockedReason) {
      throw new Error("切换到 status=blocked 必须提供 blockedReason");
    }
    if (touched) next.updatedAt = nowIso();
    return next;
  }

  // ---- 公开 API ----

  /**
   * 创建一条新 todo。
   * @param {string} runDir
   * @param {Partial<{
   *   id: string, text: string, details: string, status: string, priority: string,
   *   tags: string[], parentId: string, sourceStepId: string,
   *   artifactRefs: string[], blockedReason: string
   * }>} input
   */
  async create(runDir, input = {}) {
    if (!runDir) throw new Error("TodoStore.create 缺少 runDir");
    const record = this._normalizeNew(input);
    if (!record.text) throw new Error("TodoStore.create 缺少 text");
    return this._enqueue(runDir, async () => {
      const todos = await this._load(runDir);
      // parentId 必须指向存在的 todo,不能自引用(防止悬空引用与自循环)。
      if (record.parentId) {
        if (record.parentId === record.id) throw new Error("parentId 不能自引用");
        if (!todos.some((t) => t.id === record.parentId)) {
          throw new Error(`parentId not found: ${record.parentId}`);
        }
      }
      todos.push(record);
      await this._save(runDir, todos);
      return record;
    });
  }

  /**
   * 用 patch 更新某条 todo。
   * @param {string} runDir
   * @param {string} id
   * @param {object} patch
   */
  async update(runDir, id, patch = {}) {
    if (!runDir) throw new Error("TodoStore.update 缺少 runDir");
    if (!id) throw new Error("TodoStore.update 缺少 id");
    return this._enqueue(runDir, async () => {
      const todos = await this._load(runDir);
      const idx = todos.findIndex((t) => t.id === id);
      if (idx < 0) throw new Error(`todo not found: ${id}`);
      // parentId 校验:patch 中传 parentId 时(非空)必须存在 + 不能自引用 + 不能形成间接环。
      // 后者通过 ancestor walk 防止 A→B→A 这种循环树,review P2 抓到的隐患。
      if (typeof patch.parentId === "string" && patch.parentId) {
        if (patch.parentId === id) throw new Error("parentId 不能自引用");
        if (!todos.some((t) => t.id === patch.parentId)) {
          throw new Error(`parentId not found: ${patch.parentId}`);
        }
        if (this._wouldFormCycle(todos, id, patch.parentId)) {
          throw new Error(`parentId 会形成循环引用: ${id} → ${patch.parentId} → ... → ${id}`);
        }
      }
      const merged = this._applyPatch(todos[idx], patch);
      todos[idx] = merged;
      await this._save(runDir, todos);
      return merged;
    });
  }

  /**
   * 检测把 `id` 的 parentId 设为 `newParentId` 是否会形成循环。
   * 通过 ancestor walk:从 newParentId 出发顺着 parentId 向上走,
   * 若途中走到 id,说明 id 是 newParentId 的祖先,设置后形成 id → newParentId → ... → id 闭环。
   *
   * 注意:也防御 todos 列表中已有的非法循环(理论上不会有,但 safety net 不抛栈而是 break)。
   *
   * @param {Array<any>} todos
   * @param {string} id              要被 update 的 todo id
   * @param {string} newParentId     拟设置的新 parent
   * @returns {boolean}
   */
  _wouldFormCycle(todos, id, newParentId) {
    if (!newParentId) return false;
    if (newParentId === id) return true;
    const byId = new Map(todos.map((t) => [t.id, t]));
    const visited = new Set();
    let cursor = byId.get(newParentId);
    while (cursor) {
      if (cursor.id === id) return true;
      if (visited.has(cursor.id)) return false; // 列表本来就有非法环,不要陷入死循环
      visited.add(cursor.id);
      cursor = cursor.parentId ? byId.get(cursor.parentId) : null;
    }
    return false;
  }

  /**
   * 列出 todos,可选 filter:status / priority / parentId / tag。
   * @param {string} runDir
   * @param {{status?: string|string[], priority?: string, parentId?: string|null, tag?: string}} [filter]
   */
  async list(runDir, filter = {}) {
    const todos = await this._load(runDir);
    const statusFilter = filter.status
      ? (Array.isArray(filter.status) ? filter.status : [filter.status])
      : null;
    return todos.filter((t) => {
      if (statusFilter && !statusFilter.includes(t.status)) return false;
      if (filter.priority && t.priority !== filter.priority) return false;
      if (filter.parentId === null && t.parentId) return false;
      if (typeof filter.parentId === "string" && filter.parentId && t.parentId !== filter.parentId) return false;
      if (filter.tag && !(t.tags || []).includes(filter.tag)) return false;
      return true;
    });
  }

  async get(runDir, id) {
    if (!runDir || !id) return null;
    const todos = await this._load(runDir);
    return todos.find((t) => t.id === id) || null;
  }
}

module.exports = {
  TodoStore,
  VALID_STATUS,
  VALID_PRIORITY
};
