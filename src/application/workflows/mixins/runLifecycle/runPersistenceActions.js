const {
  fsp,
  path,
  migrateWorkflowTaskTypes,
  normalizeWorkflowManifest,
  STEP_STATUS,
  WorkflowStateMachine,
  exists,
  readJson,
  writeJsonAtomic,
  truncate
} = require("../../../../platform/runtime");
const {
  WORKFLOW_EXECUTION_INTERRUPTED_CODE,
  WORKFLOW_EXECUTION_INTERRUPTED_MESSAGE
} = require("../../../agent/workflowStepExecution");
const { assertSafePathSegment } = require("../../../../platform/shared/pathSafety");
const { SESSION_INLINE_CONTENT_CHARS } = require("../../../../platform/sessions/taskSessionStore");

module.exports = {
emitActivity(activity = {}) {
  if (!this.onActivity) return;
  this.onActivity({
    createdAt: new Date().toISOString(),
    ...activity
  });
}
,

canUsePlatformRun(state = {}) {
  return Boolean(this.runStore && state.projectId && state.taskId && state.id);
}
,

buildPlatformWorkflowManifest(state = {}) {
  const base = state.workflowManifest || {
    id: state.workflowId || `workflow-${state.id || "run"}`,
    title: state.workflowName || state.workflowId || "运行工作流",
    version: 1,
    domain: state.projectType || "",
    steps: []
  };
  return normalizeWorkflowManifest({
    ...base,
    id: base.id || state.workflowId || `workflow-${state.id || "run"}`,
    title: base.title || base.name || state.workflowName || state.workflowId || "运行工作流",
    domain: base.domain || state.projectType || "",
    steps: (state.steps || []).map((step, index) => ({
      ...step,
      id: step.id || `step-${index + 1}`,
      title: step.title || step.name || `步骤 ${index + 1}`,
      kind: step.kind || "ai",
      taskType: step.taskType || step.type || "default",
      dependsOn: this.stepDependencies(state, step)
    }))
  });
}
,

createWorkflowStateMachine(state = {}) {
  const manifest = this.buildPlatformWorkflowManifest(state);
  const steps = (state.steps || []).map((step) => ({
    ...step,
    status: step.status === "blocked" ? STEP_STATUS.PENDING : (step.status || STEP_STATUS.PENDING),
    dependsOn: this.stepDependencies(state, step)
  }));
  return WorkflowStateMachine.create(manifest, {
    status: state.status || "created",
    cursor: state.workflowState?.cursor || "",
    events: [],
    steps
  });
}
,

refreshWorkflowStateSnapshot(state = {}) {
  try {
    const machine = this.createWorkflowStateMachine(state);
    machine.markReady();
    state.workflowState = machine.snapshot();
    return state.workflowState;
  } catch (error) {
    state.workflowStateError = error.message;
    return null;
  }
}
,

async recordRunEvent(state = {}, event = {}) {
  if (!this.canUsePlatformRun(state)) return null;
  return this.runStore.appendEvent(state, event).catch(() => null);
}
,

async savePlatformStepState(state = {}, step = {}, extra = {}) {
  if (!this.canUsePlatformRun(state) || !step?.id) return null;
  return this.runStore.saveStepManifest(state, {
    ...step,
    output: {
      ...(step.output || {}),
      legacyOutputFile: step.outputFile || "",
      artifactId: step.platformArtifact?.id || "",
      ...extra.output
    }
  }).catch(() => null);
}
,

async savePlatformStepArtifact(state = {}, step = {}, content = "", summary = "", metadata = {}) {
  if (!this.canUsePlatformRun(state) || !step?.id || !this.artifactStore) return null;
  const { existingContentPath = "", ...artifactMetadata } = metadata;
  const artifact = await this.artifactStore.saveTextArtifact({
    projectId: state.projectId,
    taskId: state.taskId,
    runId: state.id,
    stepId: step.id,
    artifactType: metadata.artifactType || "step-output",
    title: step.title || step.id,
    content,
    summary,
    fileName: metadata.fileName || "output.md",
    existingContentPath,
    metadata: {
      workflowId: state.workflowId || "",
      workflowName: state.workflowName || "",
      stepIndex: step.index,
      taskType: step.taskType || "",
      kind: step.kind || "",
      status: step.status || "",
      legacyOutputFile: step.outputFile || "",
      ...artifactMetadata
    }
  }).catch(() => null);
  if (artifact) {
    step.platformArtifact = {
      id: artifact.id,
      artifactType: artifact.artifactType,
      content: artifact.paths?.content || "",
      summary: artifact.paths?.summary || null,
      contentHash: artifact.contentHash,
      estimatedTokens: artifact.estimatedTokens
    };
    await this.savePlatformStepState(state, step, {
      output: {
        artifactId: artifact.id,
        contentPath: artifact.paths?.content || "",
        summaryPath: artifact.paths?.summary || ""
      }
    });
  }
  return artifact;
}
,

async listRuns(projectId = "", taskId = "") {
  const merged = new Map();
  if (this.runStore?.listRuns) {
    const indexed = await this.runStore.listRuns({ projectId, taskId });
    for (const run of indexed) {
      if (run?.id) merged.set(run.id, migrateWorkflowTaskTypes(run));
    }
  }
  if (this.projectService) {
    const projects = projectId
      ? [await this.projectService.getProject(projectId)]
      : await this.projectService.listProjects();
    for (const project of projects.filter(Boolean)) {
      const tasks = taskId
        ? [await this.projectService.getTask(project.id, taskId)]
        : await this.projectService.listTasks(project.id);
      for (const task of tasks.filter(Boolean)) {
        const runsDir = path.join(this.projectService.getTaskDir(project.id, task.id), "runs");
        if (!(await exists(runsDir))) continue;
        const runEntries = await fsp.readdir(runsDir);
        for (const entry of runEntries) {
          const runFile = path.join(runsDir, entry, "run.json");
          if (await exists(runFile)) {
            const run = migrateWorkflowTaskTypes(await readJson(runFile, {}));
            if (run?.id) merged.set(run.id, run);
            if (this.runStore?.registerRun) await this.runStore.registerRun(run).catch(() => null);
          }
        }
      }
    }
    return [...merged.values()].sort((a, b) => `${b.createdAt}`.localeCompare(`${a.createdAt}`));
  }

  if (!(await exists(this.paths.runsDir))) {
    return [...merged.values()].sort((a, b) => `${b.createdAt}`.localeCompare(`${a.createdAt}`));
  }
  const files = await fsp.readdir(this.paths.runsDir);
  for (const file of files) {
    const runFile = path.join(this.paths.runsDir, file, "run.json");
    if (await exists(runFile)) {
      const run = migrateWorkflowTaskTypes(await readJson(runFile, {}));
      if (run?.id) merged.set(run.id, run);
    }
  }
  return [...merged.values()].sort((a, b) => `${b.createdAt}`.localeCompare(`${a.createdAt}`));
}
,

async findActiveRunForTask({ projectId = "", taskId = "" } = {}) {
  if (!projectId || !taskId) return null;
  const runs = await this.listRuns(projectId, taskId).catch(() => []);
  return runs.find((run) => run && (run.status === "running" || run.status === "pending")) || null;
}
,

// 开机自愈：启动时仍为 running/pending 的 run 属于上次会话残留。
// pending step 尚未开始，可由用户显式恢复；running step 的副作用终态无法证明，
// 必须 fail closed，不能复位成 pending 后自动重放。
async reconcileInterruptedRuns() {
  if (!this.projectService || typeof this.projectService.listProjects !== "function") return { reconciled: 0 };
  const projects = await this.projectService.listProjects().catch(() => []);
  let reconciled = 0;
  for (const project of projects) {
    const runs = await this.listRuns(project.id).catch(() => []);
    for (const summary of runs) {
      if (summary.status !== "running" && summary.status !== "pending") continue;
      const state = await this.readRun(summary.id).catch(() => null);
      if (!state || (state.status !== "running" && state.status !== "pending")) continue;
      for (const step of (state.steps || [])) {
        if (step.status !== "running") continue;
        step.status = "failed";
        step.error = WORKFLOW_EXECUTION_INTERRUPTED_MESSAGE;
        step.stopCode = WORKFLOW_EXECUTION_INTERRUPTED_CODE;
        step.executionInterruptedAt = new Date().toISOString();
      }
      state.status = "interrupted";
      state.interruptedAt = new Date().toISOString();
      await this.writeRun(state).catch(() => {});
      await Promise.all((state.steps || [])
        .filter((step) => step.executionInterruptedAt)
        .map((step) => this.savePlatformStepState(state, step, {
          output: {
            stopCode: step.stopCode,
            executionInterruptedAt: step.executionInterruptedAt
          }
        })));
      reconciled += 1;
    }
  }
  return { reconciled };
}
,

// 显式恢复只继续尚未开始的 pending/blocked step。曾处于 running 的 Agent step
// 已被标成执行终态不确定，必须由新消息开启新的执行，不能原地重放。
async resumeRun(runId = "") {
  if (!runId) throw new Error("缺少 runId。");
  const state = await this.readRun(runId);
  if (!state) throw new Error("找不到该运行。");
  const uncertain = (state.steps || []).filter((step) => (
    step.status === "running"
    || step.executionInterruptedAt
    || step.stopCode === WORKFLOW_EXECUTION_INTERRUPTED_CODE
  ));
  if (uncertain.length) {
    const now = new Date().toISOString();
    for (const step of uncertain) {
      step.status = "failed";
      step.error = WORKFLOW_EXECUTION_INTERRUPTED_MESSAGE;
      step.stopCode = WORKFLOW_EXECUTION_INTERRUPTED_CODE;
      step.executionInterruptedAt = step.executionInterruptedAt || now;
    }
    state.status = "interrupted";
    state.interruptedAt = state.interruptedAt || now;
    await this.writeRun(state);
    return this.getRun(runId);
  }
  const hasMore = (state.steps || []).some((s) => s.status === "pending" || s.status === "blocked");
  if (!hasMore) {
    state.status = "completed";
    await this.writeRun(state);
    return this.getRun(runId);
  }
  state.status = "pending";
  await this.writeRun(state);
  return this.runUntilBlocked(runId);
}
,

async getRun(runId) {
  const persisted = await this.readRun(runId);
  const state = this.runCancellationStates?.get?.(runId) || persisted;
  const outputDir = path.join(state.runDir, "outputs");
  const outputs = [];
  if (await exists(outputDir)) {
    const files = await fsp.readdir(outputDir);
    for (const file of files.sort()) {
      const absolute = path.join(outputDir, file);
      const stat = await fsp.stat(absolute);
      outputs.push({ file, absolute, size: stat.size, updatedAt: stat.mtime.toISOString() });
    }
  }
  const publishedArtifact = this.findExplicitPublishedArtifact(state);
  const finalArtifact = publishedArtifact?.absolute
    ? [{
      file: publishedArtifact.file || path.basename(publishedArtifact.absolute),
      absolute: publishedArtifact.absolute,
      relative: publishedArtifact.relative || "",
      size: Number(publishedArtifact.size || publishedArtifact.bytes) || 0,
      updatedAt: publishedArtifact.updatedAt || state.updatedAt,
      source: "agent-publish",
      previewRole: "final"
    }]
    : [];
  const finalCandidates = finalArtifact.length
    ? finalArtifact
    : outputs.map((item) => ({ ...item, previewRole: "output" }));
  return {
    run: state.commandRef ? { ...state, command: "", commandExternalized: true } : state,
    outputs,
    finalPreview: await this.buildFinalPreview(finalCandidates)
  };
}
,

async buildFinalPreview(outputs) {
  if (!outputs.length) return null;
  const candidates = [];
  for (const output of outputs) {
    if (!this.isTextDeliverablePath(output.absolute)) continue;
    const content = await fsp.readFile(output.absolute, "utf8").catch(() => "");
    const candidateContent = this.extractDeliverableContent(content);
    if (!candidateContent) continue;
    candidates.push({
      ...output,
      _content: candidateContent
    });
  }
  if (!candidates.length) return null;
  const sorted = candidates.sort((a, b) => {
    const roleDelta = Number(b.previewRole === "final") - Number(a.previewRole === "final");
    return roleDelta || `${b.updatedAt}`.localeCompare(`${a.updatedAt}`);
  });
  const selected = sorted[0];
  return {
    ...selected,
    _content: undefined,
    content: truncate(selected._content, 26000)
  };
}

,

async findLegacyProjectRunById(runId = "") {
  const safeRunId = assertSafePathSegment(runId, "runId");
  const projectsDir = this.paths.projectsDir
    || this.projectService?.paths?.projectsDir
    || (this.paths.workspace ? path.join(this.paths.workspace, "projects") : "");
  if (!projectsDir || !(await exists(projectsDir))) return null;
  const projects = await fsp.readdir(projectsDir, { withFileTypes: true });
  for (const project of projects.filter((entry) => entry.isDirectory())) {
    const tasksDir = path.join(projectsDir, project.name, "tasks");
    if (!(await exists(tasksDir))) continue;
    const tasks = await fsp.readdir(tasksDir, { withFileTypes: true });
    for (const task of tasks.filter((entry) => entry.isDirectory())) {
      const runFile = path.join(tasksDir, task.name, "runs", safeRunId, "run.json");
      if (!(await exists(runFile))) continue;
      const run = migrateWorkflowTaskTypes(await readJson(runFile, null));
      if (!run || `${run.id || ""}` !== safeRunId) continue;
      run.runDir = path.dirname(runFile);
      if (run?.workflowManifest) run.workflowManifest = migrateWorkflowTaskTypes(run.workflowManifest);
      if (run && this.runStore?.registerRun) await this.runStore.registerRun(run).catch(() => null);
      return run;
    }
  }
  return null;
}
,

isExplicitPublishedArtifact(record = null) {
  if (!record || typeof record !== "object") return false;
  const artifact = record.artifact && typeof record.artifact === "object"
    ? record.artifact
    : record;
  return `${artifact.source || record.source || ""}` === "agent-publish"
    && Boolean(`${artifact.absolute || record.absolute || ""}`.trim());
}
,

findExplicitPublishedArtifact(state = {}) {
  const steps = Array.isArray(state?.steps) ? state.steps : [];
  for (let stepIndex = steps.length - 1; stepIndex >= 0; stepIndex -= 1) {
    const files = Array.isArray(steps[stepIndex]?.files) ? steps[stepIndex].files : [];
    for (let fileIndex = files.length - 1; fileIndex >= 0; fileIndex -= 1) {
      const candidate = files[fileIndex];
      if (this.isExplicitPublishedArtifact(candidate)) {
        return candidate.artifact || candidate;
      }
    }
  }
  return this.isExplicitPublishedArtifact(state?.finalArtifact)
    ? (state.finalArtifact.artifact || state.finalArtifact)
    : null;
}
,

async readRun(runId) {
  const safeRunId = assertSafePathSegment(runId, "runId");
  if (this.runStore?.loadRunById) {
    const indexed = await this.runStore.loadRunById(safeRunId);
    if (indexed) {
      const migrated = migrateWorkflowTaskTypes(indexed);
      if (migrated.workflowManifest) {
        migrated.workflowManifest = migrateWorkflowTaskTypes(migrated.workflowManifest);
      }
      return this.hydrateRunCommand(migrated);
    }
  }
  const runFile = path.join(this.paths.runsDir, safeRunId, "run.json");
  if (await exists(runFile)) {
    const migrated = migrateWorkflowTaskTypes(await readJson(runFile, null));
    if (!migrated || `${migrated.id || ""}` !== safeRunId) {
      throw Object.assign(new Error(`运行记录身份不匹配：${safeRunId}`), { code: "RUN_ID_MISMATCH" });
    }
    migrated.runDir = path.dirname(runFile);
    if (migrated?.workflowManifest) {
      migrated.workflowManifest = migrateWorkflowTaskTypes(migrated.workflowManifest);
    }
    return this.hydrateRunCommand(migrated);
  }
  const discovered = await this.findLegacyProjectRunById(safeRunId);
  if (!discovered) {
    throw Object.assign(new Error(`找不到运行记录：${safeRunId}`), { code: "RUN_NOT_FOUND" });
  }
  return this.hydrateRunCommand(discovered);
}
,

async prepareRunStateForPersistence(state = {}) {
  if (
    !state.commandRef
    && `${state.command || ""}`.length > SESSION_INLINE_CONTENT_CHARS
    && state.projectId
    && state.taskId
  ) {
    if (typeof this.taskSessionStore?.persistContentBody !== "function") {
      throw Object.assign(new Error("超长运行输入无法外置到任务会话。"), {
        code: "RUN_COMMAND_STORE_UNAVAILABLE"
      });
    }
    const stored = await this.taskSessionStore.persistContentBody(
      state.projectId,
      state.taskId,
      `${state.command || ""}`
    );
    state.commandRef = {
      version: 1,
      storage: "task-session-content",
      sha256: stored.sha256,
      bytes: stored.bytes,
      chars: `${state.command || ""}`.length
    };
  }
  const persisted = { ...state };
  if (state.commandRef) delete persisted.command;
  return persisted;
}
,

async hydrateRunCommand(state = {}) {
  if (typeof state.command === "string" || !state.commandRef) return state;
  const ref = state.commandRef || {};
  if (ref.storage !== "task-session-content" || !/^[a-f0-9]{64}$/i.test(`${ref.sha256 || ""}`)) {
    throw Object.assign(new Error("运行输入引用不合法。"), { code: "RUN_COMMAND_REF_INVALID" });
  }
  if (typeof this.taskSessionStore?.readContentBodyRef !== "function") {
    throw Object.assign(new Error("运行输入正文存储不可用。"), { code: "RUN_COMMAND_STORE_UNAVAILABLE" });
  }
  const command = await this.taskSessionStore.readContentBodyRef({
    projectId: state.projectId,
    taskId: state.taskId,
    sha256: ref.sha256
  });
  if (Number.isSafeInteger(Number(ref.bytes)) && Number(ref.bytes) !== Buffer.byteLength(command)) {
    throw Object.assign(new Error("运行输入正文大小与引用不一致。"), { code: "RUN_COMMAND_REF_INVALID" });
  }
  return { ...state, command };
}
,

async writeRun(state) {
  state.updatedAt = new Date().toISOString();
  this.refreshWorkflowStateSnapshot(state);
  const persisted = await this.prepareRunStateForPersistence(state);
  if (this.runStore?.saveRun) {
    await this.runStore.saveRun(persisted);
    return;
  }
  await writeJsonAtomic(path.join(state.runDir, "run.json"), persisted);
}
,

async artifactFromPublishedRecord(record = null, title = "最终成品") {
  if (!this.isExplicitPublishedArtifact(record)) return null;
  const source = record.artifact || record;
  const absolute = `${source.absolute || record.absolute || ""}`.trim();
  if (!absolute || !(await exists(absolute))) return null;
  const stat = await fsp.stat(absolute);
  if (!stat.isFile()) return null;
  const content = this.isTextDeliverablePath(absolute)
    ? await fsp.readFile(absolute, "utf8").catch(() => "")
    : "";
  return {
    ...source,
    title: `${source.title || title}`,
    file: source.file || path.basename(absolute),
    absolute,
    relative: source.relative || path.relative(this.paths.workspace, absolute),
    size: stat.size,
    bytes: stat.size,
    updatedAt: stat.mtime.toISOString(),
    content,
    source: "agent-publish"
  };
}
,

// T9：run-level 时间统计，对标 LangSmith / Langfuse "latency net of human feedback"。
// 总耗时 = run.completedAt(或 updatedAt) − run.createdAt
// 用户等待 = totalUserWaitMs（M1 起点为 emit decision_required 时刻）
// 净生产 = max(0, 总 − 等待)
computeRunDurationMeta(run = {}) {
  const startedAt = run?.createdAt ? new Date(run.createdAt).getTime() : NaN;
  const endedAt = run?.completedAt
    ? new Date(run.completedAt).getTime()
    : run?.updatedAt
      ? new Date(run.updatedAt).getTime()
      : NaN;
  const totalDurationMs = Number.isFinite(startedAt) && Number.isFinite(endedAt)
    ? Math.max(0, endedAt - startedAt)
    : 0;
  const userWaitMs = Math.max(0, Number(run?.totalUserWaitMs) || 0);
  const netProductionMs = Math.max(0, totalDurationMs - userWaitMs);
  return { totalDurationMs, userWaitMs, netProductionMs };
}
,

async ensureRunArtifact(state = {}) {
  if (!this.projectService || !state.projectId || !state.taskId || !state.id) return null;
  const published = this.findExplicitPublishedArtifact(state);
  const artifact = await this.artifactFromPublishedRecord(
    published,
    state.taskTitle || "最终成品"
  );
  if (!artifact) return null;
  const persistedMeta = {
    totalDurationMs: Number(state.finalArtifact?.totalDurationMs),
    userWaitMs: Number(state.finalArtifact?.userWaitMs),
    netProductionMs: Number(state.finalArtifact?.netProductionMs)
  };
  const meta = Number.isFinite(persistedMeta.totalDurationMs) && persistedMeta.totalDurationMs > 0
    ? persistedMeta
    : this.computeRunDurationMeta(state);
  state.finalArtifact = {
    title: artifact.title,
    file: artifact.file,
    absolute: artifact.absolute,
    relative: artifact.relative,
    source: "agent-publish",
    storage: artifact.storage || "",
    managed: Boolean(artifact.managed),
    size: artifact.size,
    updatedAt: artifact.updatedAt,
    totalDurationMs: meta.totalDurationMs,
    userWaitMs: meta.userWaitMs,
    netProductionMs: meta.netProductionMs
  };
  await this.writeRun(state);
  await this.projectService.updateTask(state.projectId, state.taskId, {
    status: "active",
    lastArtifact: artifact.absolute
  });
  return { ...artifact, ...meta };
}
,

// L2.1：把本步的 typed handoff 追加到 runs/<runId>/checkpoints.jsonl。
// 与 state.md（人类可读）并行：state.md 注入 LLM prompt，
// checkpoints.jsonl 给程序读 typed state（fork/time-travel/L2.2 tool calling）。
// parentStepId 串成链表（最近一个 completed step）；durationMs 从 step 时间戳推；
// userWaitMs 来自 L1.4 的人工决策等待时长，让生产时间统计能减去人工等待。
async appendStepCheckpoint(state = {}, step = {}, handoff = null) {
  if (!this.checkpointStore || !state.runDir) return;
  const completedSteps = (state.steps || []).filter((item) => item.status === "completed" && item.id !== step.id);
  const parent = completedSteps.length ? completedSteps[completedSteps.length - 1] : null;
  const durationMs = step.startedAt && step.completedAt
    ? Math.max(0, new Date(step.completedAt).getTime() - new Date(step.startedAt).getTime())
    : 0;
  await this.checkpointStore.append(state.runDir, {
    runId: state.id,
    stepId: step.id,
    stepIndex: step.index,
    parentStepId: parent?.id || null,
    status: step.status || "completed",
    title: step.title || "",
    taskType: step.taskType || "",
    summary: step.summary || "",
    handoff,
    outputFile: step.outputFile || "",
    artifactId: step.platformArtifact?.id || null,
    durationMs,
    userWaitMs: Number(step.userWaitMs) || 0,
    ts: step.completedAt || new Date().toISOString()
  }).catch(() => {});
}

};
