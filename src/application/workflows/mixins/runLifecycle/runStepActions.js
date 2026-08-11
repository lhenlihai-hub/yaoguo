const {
  fsp,
  path,
  writeTextAtomic,
  localNow,
  localStepSummary
} = require("../../../../platform/runtime");
const { captureOptionalError } = require("../../../../platform/observability/errorReporter");

function reportOptionalLifecycleError(engine, error, scope, context = {}) {
  return captureOptionalError(engine?.errorReporter, error, {
    scope,
    severity: "warning",
    context
  });
}

async function completeRunWithoutPendingSteps(engine, state, runId) {
  state.status = "completed";
  await engine.writeRun(state);
  const artifact = await engine.ensureRunArtifact(state).catch(() => null);
  await engine.recordRunEvent(state, {
    type: "run.completed",
    status: state.status,
    artifactId: artifact?.id || "",
    artifactPath: artifact?.absolute || artifact?.relative || ""
  });
  engine.emitActivity({
    projectId: state.projectId,
    taskId: state.taskId,
    runId: state.id,
    status: "run_completed",
    label: "本轮任务已完成",
    artifact
  });
  return engine.getRun(runId);
}

async function blockRunForDependencies(engine, state, waiting, runId) {
  waiting.status = "blocked";
  waiting.error = "没有可执行步骤：依赖步骤尚未完成，或工作流依赖关系存在循环。";
  state.status = "blocked";
  await engine.writeRun(state);
  await engine.savePlatformStepState(state, waiting);
  await engine.recordRunEvent(state, {
    type: "run.blocked",
    status: state.status,
    stepId: waiting.id,
    stepIndex: waiting.index,
    message: waiting.error
  });
  engine.emitActivity({
    projectId: state.projectId,
    taskId: state.taskId,
    runId: state.id,
    status: "blocked",
    stepIndex: waiting.index,
    label: waiting.title,
    message: waiting.error
  });
  return engine.getRun(runId);
}

async function blockRunForDecision(engine, state, step, card, runId) {
  step.status = "blocked";
  step.error = `等待用户决策：${card.question}`;
  state.status = "blocked";
  await engine.writeRun(state);
  await engine.savePlatformStepState(state, step);
  await engine.recordRunEvent(state, {
    type: "step.decision_required",
    status: state.status,
    stepId: step.id,
    stepIndex: step.index,
    question: card.question,
    decisionCardId: card.id || ""
  });
  engine.emitActivity({
    projectId: state.projectId,
    taskId: state.taskId,
    runId: state.id,
    status: "decision_required",
    stepIndex: step.index,
    label: card.question,
    message: card.why,
    decisionCards: [card]
  });
  return engine.getRun(runId);
}

async function markStepRunning(engine, state, step) {
  state.status = "running";
  step.status = "running";
  step.startedAt = new Date().toISOString();
  step.error = null;
  await engine.writeRun(state);
  await engine.savePlatformStepState(state, step);
  await engine.recordRunEvent(state, {
    type: "step.running",
    status: state.status,
    stepId: step.id,
    stepIndex: step.index,
    title: step.title
  });
  engine.emitActivity({
    projectId: state.projectId,
    taskId: state.taskId,
    runId: state.id,
    status: "running",
    stepIndex: step.index,
    label: step.title
  });
}

async function persistBlockedStepResult(engine, state, step, result, runId) {
  let outputFile = "";
  if (result.text) {
    outputFile = path.join(state.runDir, step.outputFile);
    await writeTextAtomic(outputFile, result.text);
    step.files = [outputFile, ...(result.files || [])];
  }
  step.status = "blocked";
  step.error = result.message || "步骤被阻塞。";
  state.status = "blocked";
  await engine.writeRun(state);
  await engine.savePlatformStepArtifact(state, step, result.text || "", result.summary || "", {
    artifactType: "blocked-output",
    fileName: "blocked.md",
    existingContentPath: outputFile,
    blocked: true,
    message: step.error
  });
  await engine.writeRun(state);
  await engine.recordRunEvent(state, {
    type: "step.blocked",
    status: state.status,
    stepId: step.id,
    stepIndex: step.index,
    message: step.error
  });
  await persistWorkflowOutcome(engine, state, step, {
    reply: result.text || result.message || step.error,
    blocked: true,
    stopCode: result.stopCode || "AGENT_EXECUTION_BLOCKED"
  });
  engine.emitActivity({
    projectId: state.projectId,
    taskId: state.taskId,
    runId: state.id,
    status: "blocked",
    stepIndex: step.index,
    label: step.title,
    message: step.error
  });
  return engine.getRun(runId);
}

async function persistCompletedStepResult(engine, state, step, result, runId) {
  const outputText = engine.cleanStepResultText(step, result.text || "");
  const outputFile = path.join(state.runDir, step.outputFile);
  await writeTextAtomic(outputFile, outputText);
  step.status = "completed";
  step.completedAt = new Date().toISOString();
  step.error = null;
  step.files = [outputFile, ...(result.files || [])];
  step.summary = result.summary || localStepSummary(outputText);
  const historicalStep = step.taskType && step.taskType !== "agent";
  const effectiveHandoff = historicalStep
    ? (result.handoff || engine.buildFallbackHandoff(step, outputText, step.summary))
    : null;
  if (historicalStep) {
    await engine.applyHandoffToState(state, step, effectiveHandoff, step.summary).catch(() => {});
  }
  await engine.savePlatformStepArtifact(state, step, outputText, step.summary || "", {
    artifactType: step.taskType || "step-output",
    existingContentPath: outputFile
  });
  if (historicalStep) {
    await engine.appendStepCheckpoint(state, step, effectiveHandoff).catch(() => {});
  }
  const hasMore = state.steps.some((item) => item.status === "pending" || item.status === "blocked");
  const hasBlockingDecisions = engine.runBlockingDecisionCards(state).length > 0;
  if (await engine.getCancelledRunState(runId)) return engine.getRun(runId);
  state.status = hasBlockingDecisions ? "blocked" : (hasMore ? "pending" : "completed");
  await engine.writeRun(state);
  const completesRun = !hasMore && !hasBlockingDecisions;
  const artifact = completesRun ? await engine.ensureRunArtifact(state).catch(() => null) : null;
  await engine.recordRunEvent(state, {
    type: "step.completed",
    status: step.status,
    stepId: step.id,
    stepIndex: step.index,
    outputFile: step.outputFile,
    artifactId: step.platformArtifact?.id || ""
  });
  engine.emitActivity({
    projectId: state.projectId,
    taskId: state.taskId,
    runId: state.id,
    status: "completed",
    stepIndex: step.index,
    label: step.title,
    outputFile: step.outputFile
  });
  if (completesRun) await recordCompletedRun(engine, state, step, artifact, outputText);
  return engine.getRun(runId);
}

async function recordCompletedRun(engine, state, step, artifact, reply = "") {
  await engine.recordRunEvent(state, {
    type: "run.completed",
    status: state.status,
    artifactId: artifact?.id || "",
    artifactPath: artifact?.absolute || artifact?.relative || ""
  });
  // 与 direct Agent 保持同一 durable turn 顺序：运行投影完成后先提交用户可见
  // outcome，最后才由 runNextStep 写 terminal receipt。session 写入失败会把
  // run 标成 interrupted，不能静默对外宣告一个无法稳定 replay 的完成态。
  await persistWorkflowOutcome(engine, state, step, {
    reply: engine.stripInternalDisclosure(reply),
    artifact: artifact || null
  });
  engine.emitActivity({
    projectId: state.projectId,
    taskId: state.taskId,
    runId: state.id,
    status: "run_completed",
    label: "本轮任务已完成",
    artifact
  });
}

async function persistWorkflowOutcome(engine, state, step, outcome = {}) {
  try {
    if (typeof engine.persistAgentTurnOutcome !== "function") {
      throw Object.assign(new Error("Agent turn outcome 持久化能力不可用。"), {
        code: "AGENT_OUTCOME_STORE_UNAVAILABLE"
      });
    }
    return await engine.persistAgentTurnOutcome({
      outcome: {
        ...outcome,
        toolTrace: outcome.toolTrace || step?.toolTrace || null
      },
      projectId: state.projectId,
      taskId: state.taskId,
      runId: state.id,
      turnId: `${step?.agentExecution?.turnId || `run:${state.id}`}`,
      source: "workflow"
    });
  } catch (cause) {
    const error = Object.assign(
      new Error(`Agent 终态无法持久化：${cause?.message || cause}`),
      { code: "AGENT_OUTCOME_PERSIST_FAILED", cause }
    );
    try {
      await persistInterruptedStep(
        engine,
        state,
        step,
        "Agent 已结束，但用户可见结果未能可靠写入任务会话。为避免重复副作用，系统不会自动重试。",
        state.id,
        error.code,
        { persistOutcome: false }
      );
    } catch (interruptError) {
      if (interruptError && typeof interruptError === "object" && !("cause" in interruptError)) {
        interruptError.cause = error;
      }
      throw interruptError;
    }
    throw error;
  }
}

async function persistFailedStep(engine, state, step, error, runId) {
  if (await engine.getCancelledRunState(runId)) return engine.getRun(runId);
  const outputFile = path.join(state.runDir, step.outputFile);
  await writeTextAtomic(outputFile, [
    `# ${step.title} 阻塞`,
    "",
    `时间：${localNow()}`,
    "",
    `原因：${error.message}`
  ].join("\n"));
  step.files = [outputFile];
  step.status = "blocked";
  step.error = error.message;
  state.status = "blocked";
  const blockedText = await fsp.readFile(outputFile, "utf8").catch(() => "");
  try {
    await engine.savePlatformStepArtifact(state, step, blockedText, "", {
      artifactType: "blocked-output",
      fileName: "blocked.md",
      existingContentPath: outputFile,
      blocked: true,
      message: step.error
    });
  } catch (artifactError) {
    reportOptionalLifecycleError(engine, artifactError, "workflow.runNextStep.saveBlockedArtifact", {
      runId,
      stepId: step.id,
      outputFile
    });
  }
  await engine.writeRun(state);
  await engine.recordRunEvent(state, {
    type: "step.blocked",
    status: state.status,
    stepId: step.id,
    stepIndex: step.index,
    message: step.error
  });
  await persistWorkflowOutcome(engine, state, step, {
    reply: ["当前任务未能完成。", "", error.message].join("\n"),
    blocked: true,
    stopCode: error?.code || "AGENT_EXECUTION_FAILED"
  });
  engine.emitActivity({
    projectId: state.projectId,
    taskId: state.taskId,
    runId: state.id,
    status: "blocked",
    stepIndex: step.index,
    label: step.title,
    message: error.message
  });
  return engine.getRun(runId);
}

async function persistInterruptedStep(
  engine,
  state,
  step,
  message,
  runId,
  stopCode = "AGENT_EXECUTION_INTERRUPTED",
  { persistOutcome = true } = {}
) {
  const now = new Date().toISOString();
  step.status = "failed";
  step.error = `${message || "工作流步骤的执行终态不确定，已阻止自动重试。"}`;
  step.stopCode = `${stopCode || "AGENT_EXECUTION_INTERRUPTED"}`;
  step.executionInterruptedAt = now;
  state.status = "interrupted";
  state.interruptedAt = state.interruptedAt || now;
  await engine.writeRun(state);
  await engine.savePlatformStepState(state, step, {
    output: { stopCode: step.stopCode, executionInterruptedAt: now }
  });
  await engine.recordRunEvent(state, {
    type: "step.interrupted",
    status: state.status,
    stepId: step.id,
    stepIndex: step.index,
    stopCode: step.stopCode,
    message: step.error
  });
  if (persistOutcome) {
    await persistWorkflowOutcome(engine, state, step, {
      reply: step.error,
      blocked: true,
      stopCode: step.stopCode
    });
  }
  engine.emitActivity({
    projectId: state.projectId,
    taskId: state.taskId,
    runId: state.id,
    status: "interrupted",
    stepIndex: step.index,
    label: step.title,
    message: step.error
  });
  return engine.getRun(runId);
}

module.exports = {
  completeRunWithoutPendingSteps,
  blockRunForDependencies,
  blockRunForDecision,
  markStepRunning,
  persistBlockedStepResult,
  persistCompletedStepResult,
  persistFailedStep,
  persistInterruptedStep
};
