const crypto = require("node:crypto");
const {
  path,
  ensureDir,
  stampForId,
  sanitizeFileName
} = require("../../../platform/runtime");

const runPersistenceActions = require("./runLifecycle/runPersistenceActions");
const runBatchActions = require("./runLifecycle/runBatchActions");
const {
  completeRunWithoutPendingSteps,
  blockRunForDependencies,
  blockRunForDecision,
  markStepRunning,
  persistBlockedStepResult,
  persistCompletedStepResult,
  persistFailedStep,
  persistInterruptedStep
} = require("./runLifecycle/runStepActions");
const {
  WORKFLOW_EXECUTION_INTERRUPTED_CODE,
  WORKFLOW_EXECUTION_INTERRUPTED_MESSAGE,
  ensureWorkflowStepExecutionIdentity,
  beginWorkflowStepExecution,
  finishWorkflowStepExecution
} = require("../../agent/workflowStepExecution");
const { assertSafePathSegment } = require("../../../platform/shared/pathSafety");

const runLifecycleActions = {
async startRun(payload = {}) {
  if (!this.taskAgentCoordinator) return this._startRun(payload);
  return this.taskAgentCoordinator.runExclusive({
    projectId: payload.projectId || "",
    taskId: payload.taskId || `new:${payload.projectId || "project"}`
  }, () => this._startRun(payload));
}
,

async _startRun({
  projectId = "", taskId = "", topic, command = "", runId = ""
}) {
  const requestedRunId = runId ? assertSafePathSegment(runId, "runId") : "";
  const inputDigest = digestRunInput({ topic, command });
  if (requestedRunId) {
    let existing = null;
    try {
      existing = await this.readRun(requestedRunId);
    } catch (error) {
      if (error?.code !== "RUN_NOT_FOUND") throw error;
    }
    if (existing) {
      if ((projectId && existing.projectId !== projectId) || (taskId && existing.taskId !== taskId)) {
        throw Object.assign(new Error("幂等 runId 已属于另一项目或任务。"), {
          code: "RUN_ID_SCOPE_CONFLICT"
        });
      }
      const existingDigest = `${existing.inputDigest || digestRunInput({
        topic: existing.topic,
        command: existing.command
      })}`;
      if (existingDigest !== inputDigest) {
        throw Object.assign(new Error("同一 runId 不能提交不同的任务输入。"), {
          code: "RUN_ID_INPUT_CONFLICT"
        });
      }
      return this.getRun(requestedRunId);
    }
  }
  const agentWorkflowId = "agent-default";
  const project = this.projectService
    ? await this.projectService.getProject(projectId)
    : { id: "", name: "默认项目" };
  let task = null;
  if (this.projectService) {
    task = taskId
      ? await this.projectService.getTask(projectId, taskId)
      : await this.projectService.createTask(projectId, {
        title: topic || "新任务",
        brief: ""
      });
    // 首条消息只用于本轮输入与自动命名，不再复制进 task.brief。
    // brief 是用户显式维护的长期任务范围；把完整首条消息永久注入会造成
    // workflow/direct 重复以及超长上下文污染。
    if (task && command?.trim() && typeof this.scheduleAutoNameFromFirstMessage === "function") {
      this.scheduleAutoNameFromFirstMessage({ projectId, taskId: task.id, message: command });
    }
  }
  if (task?.id) {
    const activeRun = await this.findActiveRunForTask({ projectId, taskId: task.id }).catch(() => null);
    if (activeRun) {
      throw new Error("当前任务已有工作流正在执行中。等它完成后再启动新的运行。");
    }
  }
  const selectedWorkflowId = agentWorkflowId;
  const workflow = await this.loadAgentWorkflow();
  if (!workflow) throw new Error(`找不到工作流：${selectedWorkflowId}`);
  const workflowWithContext = this.prepareWorkflowForRun(workflow, { project, task, topic, command });
  const id = requestedRunId || (this.runStore?.createRunId
    ? this.runStore.createRunId()
    : `${stampForId()}-${sanitizeFileName(topic || "任务")}`);
  const runDir = task && this.runStore?.ensureRunDirs
    ? await this.runStore.ensureRunDirs({ projectId: project.id, taskId: task.id, runId: id })
    : task
      ? path.join(this.projectService.getTaskDir(projectId, task.id), "runs", id)
      : path.join(this.paths.runsDir, id);
  await ensureDir(path.join(runDir, "outputs"));
  await ensureDir(path.join(runDir, "sources"));
  await ensureDir(path.join(runDir, "assets"));
  await ensureDir(path.join(runDir, "final"));
  const state = {
    engineVersion: 2,
    id,
    topic: topic || "未命名主题",
    command,
    inputDigest,
    projectId: project.id,
    projectName: project.name,
    projectType: project.type || "general",
    taskId: task?.id || "",
    taskTitle: task?.title || topic || "默认任务",
    taskBrief: task?.brief || "",
    workflowId: selectedWorkflowId,
    workflowName: workflowWithContext.name,
    status: "pending",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    runDir,
    platform: {
      runStore: Boolean(this.runStore),
      stateMachine: true,
      artifactStore: Boolean(this.artifactStore)
    },
    steps: workflowWithContext.steps.map((step, index) => ({
      ...step,
      index,
      status: "pending",
      startedAt: null,
      completedAt: null,
      error: null
    }))
  };
  state.workflowManifest = this.buildPlatformWorkflowManifest(state);
  this.refreshWorkflowStateSnapshot(state);
  await this.writeRun(state);
  await Promise.all((state.steps || []).map((step) => this.savePlatformStepState(state, step)));
  await this.recordRunEvent(state, {
    type: "run.started",
    status: state.status,
    workflowId: state.workflowId,
    workflowName: state.workflowName,
    topic: state.topic
  });
  if (command?.trim() && task?.id && typeof this.appendAgentMessage === "function") {
    await this.appendAgentMessage({
      role: "user",
      content: command,
      projectId,
      taskId: task.id,
      runId: id,
      turnId: `run:${id}`,
      source: "workflow"
    });
  }
  if (task) {
    await this.projectService.updateTask(projectId, task.id, {
      lastRunId: id,
      lastRunAt: new Date().toISOString()
    });
  }
  return this.getRun(id);
}
,

async runNextStep(runId) {
  const state = await this.readRun(runId);
  if (await this.shouldPauseBeforeNextRunStep(state)) return this.getRun(runId);
  const eligible = state.steps.filter((step) => step.status === "pending" || step.status === "blocked");
  if (!eligible.length) {
    return completeRunWithoutPendingSteps(this, state, runId);
  }

  const readySteps = this.getReadySteps(state);
  if (!readySteps.length) {
    return blockRunForDependencies(this, state, eligible[0], runId);
  }

  const batch = this.pickRunnableBatch(readySteps);
  const decisionStep = batch[0];
  // 只恢复已由 Agent 结构化输出或用户操作产生的决策卡。
  // 宿主不从任务文字推断执行分叉并代替 Agent 询问。
  const decisionCard = this.pendingDecisionCards(state).find((card) => card.stepId === decisionStep.id) || null;
  if (decisionCard) {
    return blockRunForDecision(this, state, decisionStep, decisionCard, runId);
  }
  const step = batch[0];

  ensureWorkflowStepExecutionIdentity(state, step);
  await markStepRunning(this, state, step);
  const receipt = await beginWorkflowStepExecution(this, state, step);
  if (receipt && receipt.state !== "started") {
    return persistInterruptedStep(
      this,
      state,
      step,
      WORKFLOW_EXECUTION_INTERRUPTED_MESSAGE,
      runId,
      WORKFLOW_EXECUTION_INTERRUPTED_CODE
    );
  }

  const controller = this.beginRunAbortController(runId);
  let persisted;
  let terminalStatus = "failed";
  let terminalStopCode = "";
  try {
    try {
      const result = await this.executeStep(state, step, { signal: controller.signal });
      if (await this.getCancelledRunState(runId)) {
        persisted = await this.getRun(runId);
        terminalStatus = "cancelled";
        terminalStopCode = "AGENT_EXECUTION_CANCELLED";
      } else if (result.blocked) {
        persisted = await persistBlockedStepResult(this, state, step, result, runId);
        terminalStatus = "blocked";
        terminalStopCode = result.stopCode || "";
      } else {
        persisted = await persistCompletedStepResult(this, state, step, result, runId);
        terminalStatus = "completed";
        terminalStopCode = result.stopCode || "";
      }
    } catch (error) {
      if (error?.code === "AGENT_OUTCOME_PERSIST_FAILED") throw error;
      const cancelled = Boolean(await this.getCancelledRunState(runId));
      persisted = await persistFailedStep(this, state, step, error, runId);
      terminalStatus = cancelled ? "cancelled" : "failed";
      terminalStopCode = error?.code
        || (cancelled ? "AGENT_EXECUTION_CANCELLED" : "AGENT_EXECUTION_FAILED");
    }

    await finishWorkflowStepExecution(
      this,
      state,
      step,
      receipt,
      terminalStatus,
      terminalStopCode
    );
    return persisted;
  } finally {
    this.finishRunAbortController(runId, controller);
  }
}
,

};

function digestRunInput({ topic, command } = {}) {
  return crypto.createHash("sha256")
    .update(JSON.stringify([`${topic || "未命名主题"}`, `${command || ""}`]), "utf8")
    .digest("hex");
}

module.exports = Object.assign(runLifecycleActions, runPersistenceActions, runBatchActions);
