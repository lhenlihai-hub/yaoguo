// @ts-check

const {
  beginDurableTurn,
  finishDurableTurn
} = require("./taskExecutionReceipt");

const WORKFLOW_EXECUTION_INTERRUPTED_CODE = "AGENT_EXECUTION_INTERRUPTED";
const WORKFLOW_EXECUTION_INTERRUPTED_MESSAGE = [
  "检测到该工作流步骤曾进入执行，但没有同时留下可证明已完整提交的运行状态。",
  "为避免重复执行命令、文件写入或发布，系统不会自动重试；请发送一条新消息确认下一步。"
].join("");

function ensureWorkflowStepExecutionIdentity(state = {}, step = {}) {
  const prior = step.agentExecution && typeof step.agentExecution === "object"
    ? step.agentExecution
    : {};
  const attempt = Math.max(1, Math.floor(Number(prior.attempt) || 1));
  const canonical = !step.taskType || step.taskType === "agent";
  const turnId = `${prior.turnId || (canonical
    ? `run:${state.id || "run"}`
    : `workflow:${state.id || "run"}:${step.id || "step"}:${attempt}`)}`;
  step.agentExecution = { attempt, turnId };
  return { attempt, turnId };
}

function workflowStepExecutionScope(state = {}, step = {}) {
  const identity = ensureWorkflowStepExecutionIdentity(state, step);
  return {
    projectId: `${state.projectId || ""}`,
    taskId: `${state.taskId || ""}`,
    runId: `${state.id || ""}`,
    turnId: identity.turnId
  };
}

function workflowStepExecutionInput(state = {}, step = {}) {
  if (!step.taskType || step.taskType === "agent") {
    return `${state.command || state.taskBrief || state.topic || "完成当前任务。"}`;
  }
  return JSON.stringify({
    version: 1,
    kind: "workflow-agent-step",
    runId: `${state.id || ""}`,
    command: `${state.command || ""}`,
    taskBrief: `${state.taskBrief || ""}`,
    topic: `${state.topic || ""}`,
    step: {
      id: `${step.id || ""}`,
      title: `${step.title || ""}`,
      instruction: `${step.instruction || ""}`,
      tools: step.tools ?? null,
      maxToolRounds: Number(step.maxToolRounds) || null,
      attempt: Number(step.agentExecution?.attempt) || 1
    },
    fileReferences: Array.isArray(state.fileReferences) ? state.fileReferences : []
  });
}

async function beginWorkflowStepExecution(engine, state = {}, step = {}) {
  return beginDurableTurn({
    sessionStore: engine?.taskSessionStore,
    scope: workflowStepExecutionScope(state, step),
    message: workflowStepExecutionInput(state, step)
  });
}

async function finishWorkflowStepExecution(engine, state = {}, step = {}, receipt = null, status = "failed", stopCode = "") {
  return finishDurableTurn({
    sessionStore: engine?.taskSessionStore,
    scope: workflowStepExecutionScope(state, step),
    receipt,
    status,
    stopCode
  });
}

module.exports = {
  WORKFLOW_EXECUTION_INTERRUPTED_CODE,
  WORKFLOW_EXECUTION_INTERRUPTED_MESSAGE,
  ensureWorkflowStepExecutionIdentity,
  workflowStepExecutionScope,
  beginWorkflowStepExecution,
  finishWorkflowStepExecution
};
