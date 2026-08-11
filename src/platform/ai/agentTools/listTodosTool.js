// @ts-check
// list_todos —— 查询本次 run 的 working plan。
//
// 与 write_todo 配套:一读一写。
// 与 recall_handoff 的差别:
//   - recall_handoff:typed state 的累积视图(已成事实)
//   - list_todos:working plan 当前快照(在途意图)

const LIST_TODOS_TOOL_SCHEMA = {
  type: "function",
  function: {
    name: "list_todos",
    description: [
      "列出本次 run 的 working plan(在途意图清单)。",
      "用来:开局先看 plan 全貌、定期检查还有哪些 pending / in_progress、找 parent todo 的 id 准备挂子任务。",
      "可按 status / priority / parentId / tag 过滤。",
      "注意:这不是 typed handoff 的视图——要查已经做出的决定/事实,用 recall_handoff。"
    ].join(""),
    parameters: {
      type: "object",
      properties: {
        status: {
          oneOf: [
            { type: "string", enum: ["pending", "in_progress", "blocked", "done", "cancelled"] },
            { type: "array", items: { type: "string", enum: ["pending", "in_progress", "blocked", "done", "cancelled"] } }
          ],
          description: "可选。单个 status 或多个组合过滤。留空 = 全部状态。"
        },
        priority: {
          type: "string",
          enum: ["high", "medium", "low"],
          description: "可选。优先级过滤。"
        },
        parentId: {
          type: "string",
          description: "可选。父 todo 的 id;传 \"@root\" 表示只看顶级(无 parent)。"
        },
        tag: {
          type: "string",
          description: "可选。tag 过滤。"
        }
      },
      required: []
    }
  }
};

async function executeListTodos(args = {}, ctx = {}) {
  const { todoStore } = ctx;
  const todoDir = ctx.todoDir || ctx.runDir || "";
  if (!todoStore || typeof todoStore.list !== "function") {
    return { ok: false, error: "list_todos 缺少 ctx.todoStore" };
  }
  if (!todoDir) return { ok: false, error: "list_todos 缺少 ctx.todoDir" };

  const filter = {};
  if (args.status) filter.status = args.status;
  if (args.priority) filter.priority = args.priority;
  if (typeof args.parentId === "string") {
    filter.parentId = args.parentId === "@root" ? null : args.parentId;
  }
  if (typeof args.tag === "string" && args.tag) filter.tag = args.tag;

  try {
    const todos = await todoStore.list(todoDir, filter);
    return { ok: true, total: todos.length, todos };
  } catch (err) {
    return { ok: false, error: `${err?.message || err}` };
  }
}

const listTodosTool = {
  schema: LIST_TODOS_TOOL_SCHEMA,
  execute: executeListTodos
};

module.exports = {
  listTodosTool,
  LIST_TODOS_TOOL_SCHEMA,
  executeListTodos
};
