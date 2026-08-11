// @ts-check
// write_todo —— agent 维护 working plan 的写入工具(对标 Claude Code TodoWrite)。
//
// 业界对标:
//   - Claude Code TodoWrite:agent 一等公民工具。长任务必须有"在途意图"状态板,
//     单靠 append-only handoff 表达不了"还要做但还没做"。
//   - Cursor Composer Tasks / Devin Plan:同语义。
//
// 与 recall_handoff 的边界:
//   - recall_handoff 读 append-only typed state(已成事实)
//   - write_todo 写 mutable working plan(在途意图)
//
// 单条粒度 + 并发安全:
//   不复刻 Claude Code 的"全量 list 覆写"语义——长 workflow 多 step / sub-agent
//   并发改 plan 时,全量覆写会互相吞掉。我们走单条 action,store 内部 in-process
//   queue 串行化,避免并发覆盖。
//
// toolCtx 必需:
//   - todoStore  (TodoStore 实例)
//   - todoDir    (定位 task session 范围的 working plan；旧调用可回退 runDir)

const WRITE_TODO_TOOL_SCHEMA = {
  type: "function",
  function: {
    name: "write_todo",
    description: [
      "维护本次 run 的 working plan(在途意图清单)。",
      "用来:开局拆解多步任务、把'还要做'的事登记下来、把'做完'的事打勾、把'卡住'的事标 blocked。",
      "三种 action(必填一个):",
      "  - create:新建一条 todo,text 必填",
      "  - update:更新已有 todo(传 id + 任意要变的字段)",
      "  - complete:把 todo 标 status=done(等价 update + status=done,但更省字段)",
      "和 typed handoff 互补:决定/事实落 handoff,在途计划落 todo。不要混用。",
      "返回更新后的完整 todo 记录。"
    ].join(""),
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["create", "update", "complete"],
          description: "必填。create=新建;update=改某条;complete=快捷标 done。"
        },
        id: {
          type: "string",
          description: "update / complete 必填,create 可选(留空自动生成)。"
        },
        text: {
          type: "string",
          description: "todo 标题。create 必填;update 时可传以改标题。"
        },
        details: {
          type: "string",
          description: "可选。详细描述(背景/约束/验收标准等)。"
        },
        status: {
          type: "string",
          enum: ["pending", "in_progress", "blocked", "done", "cancelled"],
          description: "可选。状态机:pending → in_progress → done | blocked | cancelled。"
        },
        priority: {
          type: "string",
          enum: ["high", "medium", "low"],
          description: "可选。优先级。"
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "可选。标签,便于 list_todos 过滤。"
        },
        parentId: {
          type: "string",
          description: "可选。父 todo 的 id(支持一层嵌套子任务)。"
        },
        artifactRefs: {
          type: "array",
          items: { type: "string" },
          description: "可选。关联的 artifactId 列表(用 search_run_artifacts 拿到的 id)。"
        },
        blockedReason: {
          type: "string",
          description: "可选。status=blocked 时必填理由。"
        }
      },
      required: ["action"]
    }
  }
};

async function executeWriteTodo(args = {}, ctx = {}) {
  const { todoStore } = ctx;
  const todoDir = ctx.todoDir || ctx.runDir || "";
  if (!todoStore || typeof todoStore.create !== "function") {
    return { ok: false, error: "write_todo 缺少 ctx.todoStore" };
  }
  if (!todoDir) return { ok: false, error: "write_todo 缺少 ctx.todoDir" };

  const action = `${args.action || ""}`.trim();
  if (!["create", "update", "complete"].includes(action)) {
    return { ok: false, error: "action 必须是 create / update / complete" };
  }

  try {
    if (action === "create") {
      const text = `${args.text || ""}`.trim();
      if (!text) return { ok: false, error: "create 需要 text" };
      const todo = await todoStore.create(todoDir, {
        text,
        details: args.details,
        status: args.status,
        priority: args.priority,
        tags: args.tags,
        parentId: args.parentId,
        sourceStepId: ctx.currentStepId || ctx.stepId || undefined,
        artifactRefs: args.artifactRefs,
        blockedReason: args.blockedReason
      });
      return { ok: true, action: "create", todo };
    }

    const id = `${args.id || ""}`.trim();
    if (!id) return { ok: false, error: `${action} 需要 id` };

    if (action === "complete") {
      const todo = await todoStore.update(todoDir, id, { status: "done" });
      return { ok: true, action: "complete", todo };
    }

    // update
    const patch = {};
    if (typeof args.text === "string") patch.text = args.text;
    if (typeof args.details === "string") patch.details = args.details;
    if (typeof args.status === "string") patch.status = args.status;
    if (typeof args.priority === "string") patch.priority = args.priority;
    if (Array.isArray(args.tags)) patch.tags = args.tags;
    if (typeof args.parentId === "string") patch.parentId = args.parentId;
    if (Array.isArray(args.artifactRefs)) patch.artifactRefs = args.artifactRefs;
    if (typeof args.blockedReason === "string") patch.blockedReason = args.blockedReason;
    if (Object.keys(patch).length === 0) return { ok: false, error: "update 至少要带一个可改字段" };
    const todo = await todoStore.update(todoDir, id, patch);
    return { ok: true, action: "update", todo };
  } catch (err) {
    return { ok: false, error: `${err?.message || err}` };
  }
}

const writeTodoTool = {
  schema: WRITE_TODO_TOOL_SCHEMA,
  execute: executeWriteTodo
};

module.exports = {
  writeTodoTool,
  WRITE_TODO_TOOL_SCHEMA,
  executeWriteTodo
};
