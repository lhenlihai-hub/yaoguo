import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { TodoStore } = require("../src/platform/runs/todoStore.js");
const {
  createBaseToolRegistry,
  writeTodoTool,
  listTodosTool
} = require("../src/platform/ai/agentTools/index.js");

function makeRunDir() {
  return mkdtempSync(path.join(tmpdir(), "todo-store-"));
}

// ============ TodoStore 单元 ============

test("TodoStore.create 写入并自动补默认字段", async () => {
  const runDir = makeRunDir();
  const store = new TodoStore();
  const t = await store.create(runDir, { text: "第一项" });
  assert.ok(t.id.startsWith("todo_"));
  assert.equal(t.text, "第一项");
  assert.equal(t.status, "pending");
  assert.ok(t.createdAt);
  assert.equal(t.updatedAt, t.createdAt);
  await rm(runDir, { recursive: true, force: true });
});

test("TodoStore.create 缺 text 抛错", async () => {
  const runDir = makeRunDir();
  const store = new TodoStore();
  await assert.rejects(() => store.create(runDir, {}), /text/);
  await rm(runDir, { recursive: true, force: true });
});

test("TodoStore.update 状态机:pending → in_progress → done 自动填 completedAt", async () => {
  const runDir = makeRunDir();
  const store = new TodoStore();
  const t = await store.create(runDir, { text: "走流程" });
  const t1 = await store.update(runDir, t.id, { status: "in_progress" });
  assert.equal(t1.status, "in_progress");
  assert.equal(t1.completedAt, undefined);
  const t2 = await store.update(runDir, t.id, { status: "done" });
  assert.equal(t2.status, "done");
  assert.ok(t2.completedAt, "done 时应自动填 completedAt");
  await rm(runDir, { recursive: true, force: true });
});

test("TodoStore.update blocked 必须带 blockedReason,切回非 blocked 自动清空", async () => {
  const runDir = makeRunDir();
  const store = new TodoStore();
  const t = await store.create(runDir, { text: "被卡" });
  const t1 = await store.update(runDir, t.id, { status: "blocked", blockedReason: "等输入" });
  assert.equal(t1.status, "blocked");
  assert.equal(t1.blockedReason, "等输入");
  const t2 = await store.update(runDir, t.id, { status: "in_progress" });
  assert.equal(t2.blockedReason, undefined, "切回非 blocked 时应该清空 blockedReason");
  await rm(runDir, { recursive: true, force: true });
});

test("TodoStore.create 直接给 status=blocked 不带 reason 抛错", async () => {
  const runDir = makeRunDir();
  const store = new TodoStore();
  await assert.rejects(
    () => store.create(runDir, { text: "卡住", status: "blocked" }),
    /blockedReason/
  );
  // 带了 reason 就 OK
  const ok = await store.create(runDir, { text: "卡住", status: "blocked", blockedReason: "等外部" });
  assert.equal(ok.status, "blocked");
  assert.equal(ok.blockedReason, "等外部");
  await rm(runDir, { recursive: true, force: true });
});

test("TodoStore.update 切到 blocked 不带 reason 抛错(current 也无 reason)", async () => {
  const runDir = makeRunDir();
  const store = new TodoStore();
  const t = await store.create(runDir, { text: "x" });
  await assert.rejects(
    () => store.update(runDir, t.id, { status: "blocked" }),
    /blockedReason/
  );
  // 带 reason 就成
  const ok = await store.update(runDir, t.id, { status: "blocked", blockedReason: "等下游" });
  assert.equal(ok.blockedReason, "等下游");
  await rm(runDir, { recursive: true, force: true });
});

test("TodoStore.update parentId 不存在抛错", async () => {
  const runDir = makeRunDir();
  const store = new TodoStore();
  const t = await store.create(runDir, { text: "x" });
  await assert.rejects(
    () => store.update(runDir, t.id, { parentId: "todo_ghost" }),
    /parentId not found/
  );
  await rm(runDir, { recursive: true, force: true });
});

test("TodoStore.update parentId 自引用抛错", async () => {
  const runDir = makeRunDir();
  const store = new TodoStore();
  const t = await store.create(runDir, { text: "x" });
  await assert.rejects(
    () => store.update(runDir, t.id, { parentId: t.id }),
    /自引用/
  );
  await rm(runDir, { recursive: true, force: true });
});

test("TodoStore.update parentId 间接成环 A→B→A 抛错(ancestor walk)", async () => {
  // review P2:直接自引用已挡,但 A 是 B 的父、再 update(A, parentId=B) 之前能通过
  const runDir = makeRunDir();
  const store = new TodoStore();
  const a = await store.create(runDir, { text: "A" });
  const b = await store.create(runDir, { text: "B", parentId: a.id });
  // 此时:A 是 root,B.parentId = A
  // 若 update(A, parentId=B):A→B→A 闭环,必须拒绝
  await assert.rejects(
    () => store.update(runDir, a.id, { parentId: b.id }),
    /循环/
  );
  // 加一层 C 让 chain 更长:C 在 B 下,update(A, parentId=C) 也是 A→C→B→A 间接环
  const c = await store.create(runDir, { text: "C", parentId: b.id });
  await assert.rejects(
    () => store.update(runDir, a.id, { parentId: c.id }),
    /循环/
  );
  // 正常方向 (D 是新孤立节点 → 给 A 当 parent) 应成功
  const d = await store.create(runDir, { text: "D" });
  const updated = await store.update(runDir, a.id, { parentId: d.id });
  assert.equal(updated.parentId, d.id);
  await rm(runDir, { recursive: true, force: true });
});

test("TodoStore.create 显式传 id + 同 id 作 parentId(自引用)抛错", async () => {
  const runDir = makeRunDir();
  const store = new TodoStore();
  await assert.rejects(
    () => store.create(runDir, { id: "todo_self", text: "x", parentId: "todo_self" }),
    /自引用/
  );
  await rm(runDir, { recursive: true, force: true });
});

test("TodoStore.create parentId 必须指向存在的 todo", async () => {
  const runDir = makeRunDir();
  const store = new TodoStore();
  await assert.rejects(
    () => store.create(runDir, { text: "子任务", parentId: "todo_nonexistent" }),
    /parentId not found/
  );
  const parent = await store.create(runDir, { text: "父" });
  const child = await store.create(runDir, { text: "子", parentId: parent.id });
  assert.equal(child.parentId, parent.id);
  await rm(runDir, { recursive: true, force: true });
});

test("TodoStore.list 按 status / parentId / tag 过滤", async () => {
  const runDir = makeRunDir();
  const store = new TodoStore();
  const parent = await store.create(runDir, { text: "父任务", tags: ["epic"] });
  await store.create(runDir, { text: "子1", parentId: parent.id, status: "in_progress" });
  await store.create(runDir, { text: "子2", parentId: parent.id, tags: ["bug"] });
  await store.create(runDir, { text: "顶级 done", status: "done" });

  const allPending = await store.list(runDir, { status: "pending" });
  assert.equal(allPending.length, 2, "应该有 2 条 pending(父 + 子2)");

  const inProg = await store.list(runDir, { status: "in_progress" });
  assert.equal(inProg.length, 1);
  assert.equal(inProg[0].text, "子1");

  const children = await store.list(runDir, { parentId: parent.id });
  assert.equal(children.length, 2);

  const rootOnly = await store.list(runDir, { parentId: null });
  assert.equal(rootOnly.length, 2, "顶级应该有 2 条(父 + done)");

  const taggedBug = await store.list(runDir, { tag: "bug" });
  assert.equal(taggedBug.length, 1);
  assert.equal(taggedBug[0].text, "子2");

  await rm(runDir, { recursive: true, force: true });
});

test("TodoStore.update 多个并发 patch 不互相覆盖(in-process queue)", async () => {
  const runDir = makeRunDir();
  const store = new TodoStore();
  const a = await store.create(runDir, { text: "A" });
  const b = await store.create(runDir, { text: "B" });
  // 并发触发 5 个 update,如果 read-modify-write 不串行,后写覆盖前写,有可能丢
  await Promise.all([
    store.update(runDir, a.id, { priority: "high" }),
    store.update(runDir, b.id, { priority: "low" }),
    store.update(runDir, a.id, { status: "in_progress" }),
    store.update(runDir, b.id, { tags: ["x"] }),
    store.update(runDir, a.id, { text: "A 改名" })
  ]);
  const all = await store.list(runDir);
  const finalA = all.find((t) => t.id === a.id);
  const finalB = all.find((t) => t.id === b.id);
  // A 三次更新都应该反映在最终状态
  assert.equal(finalA.priority, "high");
  assert.equal(finalA.status, "in_progress");
  assert.equal(finalA.text, "A 改名");
  // B 两次更新都应该反映
  assert.equal(finalB.priority, "low");
  assert.deepEqual(finalB.tags, ["x"]);
  await rm(runDir, { recursive: true, force: true });
});

test("TodoStore.get 不存在返回 null", async () => {
  const runDir = makeRunDir();
  const store = new TodoStore();
  const r = await store.get(runDir, "todo_nope");
  assert.equal(r, null);
  await rm(runDir, { recursive: true, force: true });
});

test("TodoStore.update 不存在的 id 抛错", async () => {
  const runDir = makeRunDir();
  const store = new TodoStore();
  await assert.rejects(() => store.update(runDir, "todo_nope", { status: "done" }), /not found/);
  await rm(runDir, { recursive: true, force: true });
});

// ============ writeTodoTool / listTodosTool ============

test("createBaseToolRegistry 包含 write_todo / list_todos", () => {
  const reg = createBaseToolRegistry();
  assert.ok(reg.has("write_todo"));
  assert.ok(reg.has("list_todos"));
});

test("writeTodoTool 缺 ctx 报错", async () => {
  const r1 = await writeTodoTool.execute({ action: "create", text: "x" }, {});
  assert.equal(r1.ok, false);
  assert.match(r1.error, /todoStore/);
  const r2 = await writeTodoTool.execute({ action: "create", text: "x" }, { todoStore: new TodoStore() });
  assert.equal(r2.ok, false);
  assert.match(r2.error, /todoDir/);
});

test("writeTodoTool create + complete 闭环", async () => {
  const runDir = makeRunDir();
  const store = new TodoStore();
  const r1 = await writeTodoTool.execute(
    { action: "create", text: "做完它" },
    { todoStore: store, runDir }
  );
  assert.equal(r1.ok, true);
  const id = r1.todo.id;
  const r2 = await writeTodoTool.execute(
    { action: "complete", id },
    { todoStore: store, runDir }
  );
  assert.equal(r2.ok, true);
  assert.equal(r2.todo.status, "done");
  assert.ok(r2.todo.completedAt);
  await rm(runDir, { recursive: true, force: true });
});

test("writeTodoTool update 至少要带一个可改字段", async () => {
  const runDir = makeRunDir();
  const store = new TodoStore();
  const created = await writeTodoTool.execute(
    { action: "create", text: "x" },
    { todoStore: store, runDir }
  );
  const r = await writeTodoTool.execute(
    { action: "update", id: created.todo.id },
    { todoStore: store, runDir }
  );
  assert.equal(r.ok, false);
  assert.match(r.error, /可改字段/);
  await rm(runDir, { recursive: true, force: true });
});

test("writeTodoTool 注入 sourceStepId 自动来自 ctx.currentStepId", async () => {
  const runDir = makeRunDir();
  const store = new TodoStore();
  const r = await writeTodoTool.execute(
    { action: "create", text: "x" },
    { todoStore: store, runDir, currentStepId: "step-abc" }
  );
  assert.equal(r.ok, true);
  assert.equal(r.todo.sourceStepId, "step-abc");
  await rm(runDir, { recursive: true, force: true });
});

test("listTodosTool 默认列全部 + parentId='@root' 过滤", async () => {
  const runDir = makeRunDir();
  const store = new TodoStore();
  const parent = await store.create(runDir, { text: "父" });
  await store.create(runDir, { text: "子", parentId: parent.id });
  const all = await listTodosTool.execute({}, { todoStore: store, runDir });
  assert.equal(all.ok, true);
  assert.equal(all.total, 2);
  const rootOnly = await listTodosTool.execute({ parentId: "@root" }, { todoStore: store, runDir });
  assert.equal(rootOnly.total, 1);
  assert.equal(rootOnly.todos[0].id, parent.id);
  await rm(runDir, { recursive: true, force: true });
});

test("listTodosTool status 多值过滤", async () => {
  const runDir = makeRunDir();
  const store = new TodoStore();
  await store.create(runDir, { text: "a", status: "pending" });
  await store.create(runDir, { text: "b", status: "in_progress" });
  await store.create(runDir, { text: "c", status: "done" });
  const r = await listTodosTool.execute(
    { status: ["pending", "in_progress"] },
    { todoStore: store, runDir }
  );
  assert.equal(r.ok, true);
  assert.equal(r.total, 2);
  await rm(runDir, { recursive: true, force: true });
});
