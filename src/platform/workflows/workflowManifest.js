// @ts-check

function normalizeDependsOn(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map((item) => String(item || "").trim()).filter(Boolean);
  return [String(value).trim()].filter(Boolean);
}

function normalizeStepTools(value) {
  if (Array.isArray(value)) {
    const cleaned = value.filter((s) => typeof s === "string" && s);
    return cleaned.length ? cleaned : undefined;
  }
  if (value === "agent") return "agent";
  return undefined; // null / undefined / 非法值 → 内部单次模型调用，不获得 Agent 工具。
}

const TASK_TYPE_ALIASES = Object.freeze({
  deAI: "revise"
});

function canonicalTaskType(value = "default") {
  const taskType = `${value || "default"}`.trim() || "default";
  return TASK_TYPE_ALIASES[taskType] || taskType;
}

/**
 * @param {any} workflow
 * @returns {any}
 */
function migrateWorkflowTaskTypes(workflow = {}) {
  if (!workflow || typeof workflow !== "object") return workflow;
  const steps = Array.isArray(workflow.steps)
    ? workflow.steps.map((step) => ({
      ...step,
      taskType: canonicalTaskType(step?.taskType || step?.type || "default"),
      ...(typeof step?.subAgentTaskType === "string" && step.subAgentTaskType.trim()
        ? { subAgentTaskType: canonicalTaskType(step.subAgentTaskType) }
        : {})
    }))
    : workflow.steps;
  return { ...workflow, ...(Array.isArray(steps) ? { steps } : {}) };
}

function normalizeWorkflowManifest(workflow = {}) {
  const steps = (Array.isArray(workflow.steps) ? workflow.steps : []).map((step, index) => {
    const out = {
      id: step.id || `step-${String(index + 1).padStart(2, "0")}`,
      title: step.title || step.name || `步骤 ${index + 1}`,
      kind: step.kind || "ai",
      taskType: canonicalTaskType(step.taskType || step.type || "default"),
      promptRef: step.promptRef || step.prompt || "",
      roleRef: step.roleRef || step.role || "",
      inputRefs: Array.isArray(step.inputRefs) ? step.inputRefs : [],
      output: step.output || {},
      dependsOn: normalizeDependsOn(step.dependsOn || step.dependencies),
      evalRefs: Array.isArray(step.evalRefs) ? step.evalRefs : [],
      policy: step.policy || {}
    };
    // Agent toolset 字段透传：工作流 JSON 显式声明 tools、
    // maxToolRounds 与 subAgentTaskType。
    const tools = normalizeStepTools(step.tools);
    if (tools !== undefined) out.tools = tools;
    if (Number.isFinite(step.maxToolRounds) && step.maxToolRounds > 0) {
      out.maxToolRounds = Math.floor(step.maxToolRounds);
    }
    if (typeof step.subAgentTaskType === "string" && step.subAgentTaskType.trim()) {
      out.subAgentTaskType = canonicalTaskType(step.subAgentTaskType);
    }
    return out;
  });
  return {
    id: workflow.id || "",
    kind: workflow.kind || "workflow",
    version: workflow.version || 1,
    domain: workflow.domain || "",
    title: workflow.title || workflow.name || workflow.id || "",
    description: workflow.description || "",
    steps
  };
}

function validateWorkflowManifest(workflow = {}) {
  const normalized = normalizeWorkflowManifest(workflow);
  const errors = [];
  if (!normalized.id) errors.push("workflow 缺少 id");
  const ids = new Set();
  for (const step of normalized.steps) {
    if (ids.has(step.id)) errors.push(`重复 step id：${step.id}`);
    ids.add(step.id);
  }
  for (const step of normalized.steps) {
    for (const dep of step.dependsOn) {
      if (!ids.has(dep)) errors.push(`步骤 ${step.id} 依赖不存在：${dep}`);
    }
  }
  return { ok: errors.length === 0, errors, workflow: normalized };
}

module.exports = {
  canonicalTaskType,
  migrateWorkflowTaskTypes,
  normalizeWorkflowManifest,
  validateWorkflowManifest
};
