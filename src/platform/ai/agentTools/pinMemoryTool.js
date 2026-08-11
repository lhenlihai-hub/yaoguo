// @ts-check

const { MEMORY_TYPES, TYPE_BASIS, FEEDBACK_POLARITIES } = require("../../memory/memoryStore");

// 模型负责判断一条信息是否值得跨会话保存，以及它属于哪个封闭类型。
// 工具只把模型的决定提交给当前 canonical workspace 的 Memdir，并校验结构边界。
const PIN_MEMORY_TOOL_SCHEMA = {
  type: "function",
  function: {
    name: "pin_memory",
    description: [
      "把代码之外、跨会话仍有价值的信息写入宿主已绑定的当前 Agent Markdown Memdir。",
      "只能选择 user、feedback、project、reference 四种类型；先由你判断是否值得保存，再调用。",
      "user 仅保存用户画像；feedback 同时保存用户确认的成功做法与纠正；",
      "project 仅保存无法从仓库推导的项目上下文，日期必须绝对化；",
      "reference 只保存外部事实源的指针。",
      "不要保存代码模式、架构分析、文件路径、Git 历史、调试方案、会话转录、临时状态、推测或秘密。"
    ].join(""),
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        type: {
          type: "string",
          enum: MEMORY_TYPES,
          description: "封闭记忆类型。"
        },
        basis: {
          type: "string",
          enum: Object.values(TYPE_BASIS),
          description: "信息来源依据，必须与 type 匹配。"
        },
        topic: {
          type: "string",
          pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$",
          maxLength: 60,
          description: "主题文件名片段，小写 ASCII kebab-case；系统会生成 <type>-<topic>.md。"
        },
        name: {
          type: "string",
          maxLength: 80,
          description: "主题名称。"
        },
        description: {
          type: "string",
          maxLength: 150,
          description: "写入 memory.md 的单行摘要，不超过 150 字符。"
        },
        content: {
          type: "string",
          maxLength: 8000,
          description: "要保存的具体事实、偏好、反馈或上下文。"
        },
        valueBeyondCode: {
          type: "string",
          maxLength: 300,
          description: "说明为什么它不能从代码重新推导，并且跨会话仍有价值。"
        },
        polarity: {
          type: "string",
          enum: FEEDBACK_POLARITIES,
          description: "feedback 必填：positive 表示应继续复用，negative 表示应避免或修正。"
        },
        reference: {
          type: "string",
          maxLength: 2048,
          description: "reference 必填：外部 URL、外部系统 URI、Issue ID 或频道指针；不要复制外部正文。"
        }
      },
      required: ["type", "basis", "topic", "name", "description", "content", "valueBeyondCode"]
    }
  }
};

async function executePinMemory(args = {}, ctx = {}) {
  const { memoryStore } = ctx;
  if (!memoryStore || typeof memoryStore.append !== "function") {
    return { ok: false, error: "pin_memory 缺少 ctx.memoryStore" };
  }
  try {
    const record = await memoryStore.append({
      type: args.type,
      basis: args.basis,
      topic: args.topic,
      name: args.name,
      description: args.description,
      content: args.content,
      valueBeyondCode: args.valueBeyondCode,
      polarity: args.polarity,
      reference: args.reference
    });
    return {
      ok: true,
      memory: {
        id: record.id,
        type: record.type,
        file: record.file,
        name: record.name,
        description: record.description,
        polarity: record.polarity,
        reference: record.reference,
        createdAt: record.createdAt,
        deduplicated: record.deduplicated,
        pendingIndex: record.pendingIndex === true,
        logPathPattern: `${record.logPathPattern || ""}`
      }
    };
  } catch (error) {
    return { ok: false, error: `${error?.message || error}`, code: error?.code || "" };
  }
}

const pinMemoryTool = {
  schema: PIN_MEMORY_TOOL_SCHEMA,
  execute: executePinMemory
};

module.exports = {
  pinMemoryTool,
  PIN_MEMORY_TOOL_SCHEMA,
  executePinMemory
};
