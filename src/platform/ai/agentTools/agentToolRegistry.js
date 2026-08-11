// @ts-check
// AgentToolRegistry —— 通用 OpenAI 风格 tool 注册中心。
//
// 设计原则：
// 1. 工具 = { schema: OpenAITool, execute(args, ctx): Promise<unknown> }
// 2. schema 严格遵循 OpenAI function tool 格式（type=function, function.{name,description,parameters}）
//    —— 让 ModelGateway 透明转发，provider 无关。
// 3. 工具执行结果是 plain JSON / string —— 由 toolLoop 序列化后塞回 messages。
// 4. 参数校验、异常归一化与结果后处理由唯一 Agent loop 负责，注册中心只注册和分发。
//
// 这里只做注册和分发，工具实现散在同目录其它文件（recallHandoffTool.js 等）。

const { hardenFunctionToolSchema } = require("../../shared/jsonSchemaValidation");
const { getToolCapabilityPolicy } = require("./toolCapabilityPolicy");

class AgentToolRegistry {
  constructor() {
    this.tools = new Map();
  }

  register(tool) {
    const name = tool?.schema?.function?.name;
    if (!name) throw new Error("agentTool 缺少 schema.function.name");
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(name)) throw new Error(`agentTool 名称不合法: ${name}`);
    if (typeof tool.execute !== "function") throw new Error(`agentTool ${name} 缺少 execute`);
    if (this.tools.has(name)) throw new Error(`agentTool 重复注册: ${name}`);
    const schema = hardenFunctionToolSchema(tool.schema);
    if (schema.type !== "function") throw new Error(`agentTool ${name} schema.type 必须是 function`);
    if (!`${schema.function.description || ""}`.trim()) throw new Error(`agentTool ${name} 缺少 description`);
    this.tools.set(name, { ...tool, schema, policy: tool.policy || getToolCapabilityPolicy(name) });
    return this;
  }

  has(name) {
    return this.tools.has(name);
  }

  get(name) {
    return this.tools.get(name) || null;
  }

  getPolicy(name) {
    return this.tools.get(name)?.policy || getToolCapabilityPolicy(name);
  }

  list(names = null) {
    if (!names) return Array.from(this.tools.values());
    const filtered = [];
    for (const name of names) {
      const tool = this.tools.get(name);
      if (!tool) throw new Error(`agentTool 未注册却被请求: ${name}`);
      filtered.push(tool);
    }
    return filtered;
  }

  /**
   * 把已注册工具的 schema 提取出来，可直接传给 LLM 的 tools 参数。
   */
  toSchemas(names = null) {
    return this.list(names).map((tool) => tool.schema);
  }

  async execute(name, args, ctx = {}) {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`unknown tool: ${name}`);
    return tool.execute(args || {}, ctx);
  }
}

module.exports = { AgentToolRegistry };
