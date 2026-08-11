const { uniqueValues } = require("../../../../platform/runtime");

module.exports = {
runBlockingDecisionCards(state = {}) {
  return typeof this.blockingDecisionCards === "function"
    ? this.blockingDecisionCards(state)
    : this.pendingDecisionCards(state).filter((card) => card?.blocking !== false);
}
,

async shouldPauseBeforeNextRunStep(state = {}) {
  if (["cancelled", "interrupted", "failed"].includes(state.status)) return true;
  // A second resume may arrive while an earlier resume is still executing a
  // step. Do not let it reinterpret dependent pending steps as a deadlock.
  if ((state.steps || []).some((step) => step?.status === "running")) return true;
  if (!this.runBlockingDecisionCards(state).length) return false;
  if (state.status !== "blocked") {
    state.status = "blocked";
    await this.writeRun(state);
  }
  return true;
}
,

stepDependencies(state = {}, step = {}) {
  const validIds = new Set((state.steps || []).map((item) => item.id));
  return uniqueValues([
    ...((Array.isArray(step.dependsOn) ? step.dependsOn : []) || []),
    ...((Array.isArray(step.contextNeeds?.prev) ? step.contextNeeds.prev : []) || [])
  ]
    .map((item) => this.normalizeStepRef(item))
    .filter((item) => item && item !== step.id && validIds.has(item)));
}
,

isStepReady(state = {}, step = {}) {
  const completedIds = new Set((state.steps || [])
    .filter((item) => item.status === "completed")
    .map((item) => item.id));
  return this.stepDependencies(state, step).every((id) => completedIds.has(id));
}
,

getReadySteps(state = {}) {
  try {
    const machine = this.createWorkflowStateMachine(state);
    const ready = machine.markReady();
    const readyIds = new Set(ready.map((step) => step.id));
    return (state.steps || [])
      .filter((step) => readyIds.has(step.id) && (step.status === "pending" || step.status === "blocked" || step.status === "ready"))
      .sort((a, b) => a.index - b.index);
  } catch {
    return (state.steps || [])
      .filter((step) => (step.status === "pending" || step.status === "blocked") && this.isStepReady(state, step))
      .sort((a, b) => a.index - b.index);
  }
}
,

pickRunnableBatch(readySteps = []) {
  return readySteps.length ? [readySteps[0]] : [];
}
,

async getCancelledRunState(runId) {
  const pending = this.runCancellationStates?.get?.(runId);
  if (pending?.status === "cancelled") return pending;
  const latest = await this.readRun(runId).catch(() => null);
  return latest?.status === "cancelled" ? latest : null;
}
,

beginRunAbortController(runId) {
  if (!(this.runAbortControllers instanceof Map)) this.runAbortControllers = new Map();
  const current = this.runAbortControllers.get(runId);
  if (current && !current.signal.aborted) return current;
  const controller = new AbortController();
  this.runAbortControllers.set(runId, controller);
  return controller;
}
,

finishRunAbortController(runId, controller) {
  if (this.runAbortControllers?.get?.(runId) === controller) this.runAbortControllers.delete(runId);
}
,

abortRunExecution(runId, reason = "用户停止任务") {
  const controller = this.runAbortControllers?.get?.(runId);
  if (!controller) return false;
  try { controller.abort(new Error(reason)); } catch { controller.abort(); }
  this.runAbortControllers.delete(runId);
  return true;
}
,

async runUntilBlocked(runId, maxSteps = 30) {
  const state = await this.readRun(runId);
  if (this.taskAgentCoordinator) {
    return this.taskAgentCoordinator.runExclusive({
      projectId: state.projectId,
      taskId: state.taskId,
      runId
    }, () => this._runUntilBlocked(runId, maxSteps));
  }
  return this._runUntilBlocked(runId, maxSteps);
}
,

async _runUntilBlocked(runId, maxSteps = 30) {
  let result = await this.getRun(runId);
  for (let index = 0; index < maxSteps; index += 1) {
    if (!["pending", "running"].includes(result.run.status)) break;
    // 每个 step 之间重新读取磁盘，让 cancelRun 写入的 cancelled 状态能被感知。
    const latest = await this.readRun(runId).catch(() => null);
    if (latest && latest.status === "cancelled") {
      return this.getRun(runId);
    }
    if ((latest?.steps || []).some((step) => step?.status === "running")) {
      return this.getRun(runId);
    }
    result = await this.runNextStep(runId);
    if (["blocked", "completed", "cancelled"].includes(result.run.status)) break;
  }
  return result;
}
,

// 用户停止任务：先中止当前模型/工具调用，再持久化 cancelled；写入侧仍有
// cancelled 二次检查，避免中止竞态留下半成品。
async cancelRun(runId, { reason = "用户停止任务" } = {}) {
  const state = await this.readRun(runId).catch(() => null);
  if (!state) return null;
  if (["completed", "cancelled"].includes(state.status)) return this.getRun(runId);
  state.status = "cancelled";
  state.cancelledAt = new Date().toISOString();
  state.cancelReason = reason;
  if (!(this.runCancellationStates instanceof Map)) this.runCancellationStates = new Map();
  this.runCancellationStates.set(runId, state);
  this.abortRunExecution(runId, reason);
  await this.writeRun(state);
  this.runCancellationStates.delete(runId);
  await this.recordRunEvent(state, {
    type: "run.cancelled",
    status: "cancelled",
    reason
  });
  if (state.projectId && state.taskId) {
    if (typeof this.persistAgentTurnOutcome !== "function") {
      throw Object.assign(new Error("Agent turn outcome 持久化能力不可用。"), {
        code: "AGENT_OUTCOME_STORE_UNAVAILABLE"
      });
    }
    await this.persistAgentTurnOutcome({
      outcome: {
        reply: "已停止当前任务。",
        cancelled: true,
        blocked: false,
        stopCode: "AGENT_EXECUTION_CANCELLED"
      },
      projectId: state.projectId,
      taskId: state.taskId,
      runId: state.id,
      turnId: `run:${state.id}`,
      source: "workflow"
    });
  }
  this.emitActivity({
    projectId: state.projectId,
    taskId: state.taskId,
    runId: state.id,
    status: "run_cancelled",
    label: "已停止任务",
    message: reason
  });
  return this.getRun(runId);
}
};
