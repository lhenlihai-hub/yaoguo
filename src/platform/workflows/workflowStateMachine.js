// @ts-check

const { normalizeWorkflowManifest, validateWorkflowManifest } = require("./workflowManifest");

const STEP_STATUS = {
  PENDING: "pending",
  READY: "ready",
  RUNNING: "running",
  COMPLETED: "completed",
  BLOCKED: "blocked",
  FAILED: "failed",
  SKIPPED: "skipped"
};

const TERMINAL_STEP_STATUSES = new Set([
  STEP_STATUS.COMPLETED,
  STEP_STATUS.FAILED,
  STEP_STATUS.SKIPPED,
  STEP_STATUS.BLOCKED
]);

class WorkflowStateMachine {
  constructor(workflow = {}, initialState = {}) {
    const validation = validateWorkflowManifest(workflow);
    if (!validation.ok) throw new Error(`Workflow manifest 不合法：${validation.errors.join("；")}`);
    this.workflow = validation.workflow;
    this.state = this.createInitialState(initialState);
  }

  createInitialState(initialState = {}) {
    const existingSteps = new Map((initialState.steps || []).map((step) => [step.id, step]));
    return {
      version: 1,
      workflowId: this.workflow.id,
      workflowVersion: this.workflow.version,
      status: initialState.status || "created",
      cursor: initialState.cursor || "",
      events: Array.isArray(initialState.events) ? initialState.events : [],
      steps: this.workflow.steps.map((step, index) => ({
        id: step.id,
        title: step.title,
        index,
        status: existingSteps.get(step.id)?.status || STEP_STATUS.PENDING,
        dependsOn: step.dependsOn || [],
        startedAt: existingSteps.get(step.id)?.startedAt || null,
        completedAt: existingSteps.get(step.id)?.completedAt || null,
        error: existingSteps.get(step.id)?.error || null,
        output: existingSteps.get(step.id)?.output || null
      }))
    };
  }

  stepDef(stepId = "") {
    return this.workflow.steps.find((step) => step.id === stepId) || null;
  }

  stepState(stepId = "") {
    return this.state.steps.find((step) => step.id === stepId) || null;
  }

  completedStepIds() {
    return new Set(this.state.steps
      .filter((step) => step.status === STEP_STATUS.COMPLETED || step.status === STEP_STATUS.SKIPPED)
      .map((step) => step.id));
  }

  failedDependencies(step = {}) {
    const states = new Map(this.state.steps.map((item) => [item.id, item]));
    return (step.dependsOn || []).filter((id) => states.get(id)?.status === STEP_STATUS.FAILED);
  }

  isReady(step = {}) {
    if (!step || step.status !== STEP_STATUS.PENDING && step.status !== STEP_STATUS.READY) return false;
    if (this.failedDependencies(step).length) return false;
    const completed = this.completedStepIds();
    return (step.dependsOn || []).every((dep) => completed.has(dep));
  }

  readySteps() {
    return this.state.steps
      .filter((step) => this.isReady(step))
      .sort((a, b) => a.index - b.index);
  }

  nextStep() {
    return this.readySteps()[0] || null;
  }

  isComplete() {
    return this.state.steps.every((step) => step.status === STEP_STATUS.COMPLETED || step.status === STEP_STATUS.SKIPPED);
  }

  isTerminal() {
    return this.isComplete() || this.state.steps.some((step) => step.status === STEP_STATUS.FAILED || step.status === STEP_STATUS.BLOCKED);
  }

  appendEvent(type = "", payload = {}) {
    const event = {
      type,
      createdAt: new Date().toISOString(),
      ...payload
    };
    this.state.events.push(event);
    return event;
  }

  transition(stepId = "", status = STEP_STATUS.PENDING, patch = {}) {
    const step = this.stepState(stepId);
    if (!step) throw new Error(`找不到步骤：${stepId}`);
    const now = new Date().toISOString();
    step.status = status;
    if (status === STEP_STATUS.RUNNING && !step.startedAt) step.startedAt = now;
    if (TERMINAL_STEP_STATUSES.has(status)) step.completedAt = now;
    Object.assign(step, patch);
    this.state.cursor = stepId;
    this.state.status = this.isComplete()
      ? "completed"
      : status === STEP_STATUS.FAILED
        ? "failed"
        : status === STEP_STATUS.BLOCKED
          ? "blocked"
          : "running";
    this.appendEvent(`step.${status}`, { stepId, patch });
    return step;
  }

  markReady() {
    for (const step of this.state.steps) {
      if (step.status === STEP_STATUS.PENDING && this.isReady(step)) {
        step.status = STEP_STATUS.READY;
        this.appendEvent("step.ready", { stepId: step.id });
      }
    }
    if (this.state.status === "created") this.state.status = "ready";
    return this.readySteps();
  }

  snapshot() {
    return JSON.parse(JSON.stringify(this.state));
  }

  static create(workflow = {}, initialState = {}) {
    return new WorkflowStateMachine(normalizeWorkflowManifest(workflow), initialState);
  }
}

module.exports = {
  STEP_STATUS,
  WorkflowStateMachine
};
