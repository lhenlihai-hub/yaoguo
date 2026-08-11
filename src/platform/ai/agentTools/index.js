// @ts-check
const { AgentToolRegistry } = require("./agentToolRegistry");
const { recallHandoffTool } = require("./recallHandoffTool");
const { searchRunArtifactsTool } = require("./searchRunArtifactsTool");
const { readArtifactTool } = require("./readArtifactTool");
const { writeTodoTool } = require("./writeTodoTool");
const { listTodosTool } = require("./listTodosTool");
const { searchMemoryTool } = require("./searchMemoryTool");
const { pinMemoryTool } = require("./pinMemoryTool");
const { searchReferenceTool } = require("./searchReferenceTool");
const { fetchUrlTool } = require("./fetchUrlTool");
const { searchImagesTool } = require("./searchImagesTool");
const { readReferenceTool } = require("./readReferenceTool");
const { llmJudgeQualityTool } = require("./llmJudgeQualityTool");
const { spawnSubagentTool, DEFAULT_SUBAGENT_TOOL_NAMES } = require("./subAgentTool");
const { loadCapabilityTool } = require("./loadCapabilityTool");
const { manageCitationsTool } = require("./manageCitationsTool");
const { runSkillTool } = require("./runSkillTool");
const { inspectArtifactTool } = require("./artifactInspectionTool");
const { publishArtifactTool } = require("./publishArtifactTool");
const { discardArtifactCandidateTool } = require("./discardArtifactCandidateTool");
const { runToolLoop } = require("../agentLoop/agentLoop");
const { AgentExecutionBudget } = require("./executionBudget");
const { BASE_TOOL_NAMES } = require("../agentLoop/scopedTools");

const BASE_AGENT_TOOLS = Object.freeze([
  recallHandoffTool,
  searchRunArtifactsTool,
  readArtifactTool,
  writeTodoTool,
  listTodosTool,
  searchMemoryTool,
  pinMemoryTool,
  searchReferenceTool,
  fetchUrlTool,
  searchImagesTool,
  readReferenceTool,
  llmJudgeQualityTool,
  inspectArtifactTool,
  publishArtifactTool,
  discardArtifactCandidateTool
]);

const ALL_AGENT_TOOLS = Object.freeze([
  ...BASE_AGENT_TOOLS,
  spawnSubagentTool,
  loadCapabilityTool,
  manageCitationsTool,
  runSkillTool
]);

function createRegistry(tools) {
  const registry = new AgentToolRegistry();
  for (const tool of tools) registry.register(tool);
  return registry;
}

/**
 * 创建一份预装基础工具的注册中心。
 *   - recall_handoff         查 typed handoff(本 run 累积的 decisions/rejected/facts)
 *   - search_run_artifacts   混合检索前 step 写的 artifact 原文(对标 Claude Code Grep)
 *   - read_artifact          按 artifactId/(stepId,type) 精读 artifact 段落(对标 Claude Code Read)
 *   - write_todo             维护 working plan(对标 Claude Code TodoWrite,单条粒度+并发安全)
 *   - list_todos             查询 working plan
 *   - search_memory          检索跨 run 长期记忆
 *   - pin_memory             沉淀关键事实/偏好到长期记忆(对标 ChatGPT memory "remember this")
 *   - search_reference       检索外部参考(联网 + 本地素材,snippet 列表;对标 Claude Code WebSearch)
 *   - fetch_url              抓 URL readable 全文(对标 Claude Code WebFetch)
 *   - read_reference         分页读取本地参考资料，不做静默截断
 *   - llm_judge_quality      LLM-as-judge 单稿主观维度评分
 *
 * spawn_subagent 不挂在这里——它是高级工具,应由 workflow / aiRouter 显式启用。
 */
function createBaseToolRegistry() {
  return createRegistry(BASE_AGENT_TOOLS);
}

/**
 * 创建通用 Agent 的完整能力注册中心：基础能力 + 按需能力 + 委派能力。
 * 子任务只能使用宿主从该目录裁出的安全子集，不能再次委派。
 */
function createAgentToolRegistry() {
  return createRegistry(ALL_AGENT_TOOLS);
}

module.exports = {
  AgentToolRegistry,
  createBaseToolRegistry,
  createAgentToolRegistry,
  runToolLoop,
  BASE_TOOL_NAMES,
  AgentExecutionBudget,
  recallHandoffTool,
  searchRunArtifactsTool,
  readArtifactTool,
  writeTodoTool,
  listTodosTool,
  searchMemoryTool,
  pinMemoryTool,
  searchReferenceTool,
  fetchUrlTool,
  searchImagesTool,
  readReferenceTool,
  llmJudgeQualityTool,
  spawnSubagentTool,
  loadCapabilityTool,
  manageCitationsTool,
  runSkillTool,
  inspectArtifactTool,
  publishArtifactTool,
  discardArtifactCandidateTool,
  DEFAULT_SUBAGENT_TOOL_NAMES
};
