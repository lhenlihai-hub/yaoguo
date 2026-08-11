// @ts-check

const { MEMORY_TYPES } = require("../../memory/memoryStore");

// memory.md 索引已经常驻上下文；模型判断相关性后，用本工具选择主题正文。
// ctx.memoryStore 已绑定 canonical workspace，参数不能跨项目寻址。
const SEARCH_MEMORY_TOOL_SCHEMA = {
  type: "function",
  function: {
    name: "search_memory",
    description: [
      "按需读取当前 Memdir 的主题记忆正文。先阅读常驻 memory.md 索引，再判断哪些主题与当前任务相关。",
      "可用 query 做相关性检索，也可用 files 精确读取索引中的主题文件；只返回 user、feedback、project、reference。",
      "每条结果包含自然语言 age；freshnessWarning 非空时，引用历史状态前必须验证当前事实。"
    ].join(""),
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: {
          type: "string",
          description: "相关性检索词；若不提供，必须提供 files。"
        },
        types: {
          type: "array",
          items: { type: "string", enum: MEMORY_TYPES },
          description: "可选的封闭类型过滤。"
        },
        files: {
          type: "array",
          items: {
            type: "string",
            pattern: "^(?:user|feedback|project|reference)-[a-z0-9]+(?:-[a-z0-9]+)*\\.md$"
          },
          description: "要从索引精确加载的主题文件名。"
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 12,
          description: "返回主题上限，默认 8，最大 12。"
        }
      },
      required: []
    }
  }
};

async function executeSearchMemory(args = {}, ctx = {}) {
  const { memoryStore } = ctx;
  if (!memoryStore || typeof memoryStore.search !== "function") {
    return { ok: false, error: "search_memory 缺少 ctx.memoryStore" };
  }
  const query = `${args.query || ""}`.trim();
  const files = Array.isArray(args.files) ? args.files : [];
  if (!query && !files.length) {
    return { ok: false, error: "search_memory 必须提供 query 或 files" };
  }
  try {
    const memories = await memoryStore.search({
      query,
      types: Array.isArray(args.types) ? args.types : [],
      files,
      limit: Math.max(1, Math.min(12, Number(args.limit) || 8))
    });
    return {
      ok: true,
      total: memories.length,
      memories: memories.map((memory) => ({
        id: memory.id,
        type: memory.type,
        file: memory.file,
        name: memory.name,
        description: memory.description,
        content: memory.content,
        createdAt: memory.createdAt,
        updatedAt: memory.updatedAt,
        age: memory.age,
        ageDays: memory.ageDays,
        freshnessWarning: memory.freshnessWarning
      }))
    };
  } catch (error) {
    return { ok: false, error: `${error?.message || error}`, code: error?.code || "" };
  }
}

const searchMemoryTool = {
  schema: SEARCH_MEMORY_TOOL_SCHEMA,
  execute: executeSearchMemory
};

module.exports = {
  searchMemoryTool,
  SEARCH_MEMORY_TOOL_SCHEMA,
  executeSearchMemory
};
