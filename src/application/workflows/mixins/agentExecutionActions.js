// @ts-check
// 唯一 Agent 执行适配器。
// 消息、自动触发和历史运行恢复只提供不同的输入与持久化作用域，
// 不再选择不同的工具、权限、上下文预算或产物协议。

const path = require("node:path");
const crypto = require("node:crypto");
const fsp = require("node:fs/promises");
const { ensureDir, appendJsonl } = require("../../../platform/shared/fs");
const {
  createAgentToolRegistry,
  runToolLoop,
  BASE_TOOL_NAMES
} = require("../../../platform/ai/agentTools");
const {
  listAgentToolNames,
  buildToolCapabilityCatalog,
  isToolAvailable
} = require("../../../platform/ai/agentTools/toolCapabilityPolicy");
const {
  hasWorkspaceIdentity,
  verifyWorkspaceIdentity
} = require("../../../platform/projects/workspaceIdentity");
const { validateGrantedLocalItem } = require("../../../platform/shared/localPathGrant");
const { assertSafePathSegment } = require("../../../platform/shared/pathSafety");
const { agentMemoryContext } = require("../../../platform/memory/memdir/agentMemoryProfile");
const { GENERATE_DOCUMENT_TOOL } = require("./agent/generateDocumentTool");
const { GENERATE_VISUAL_TOOL } = require("./agent/generateVisualTool");

const AGENT_CONTEXT_BUDGET = Object.freeze({
  runContextTokens: 180000,
  inputTokens: 64000
});

const AGENT_RESIDENT_TOOLS = Object.freeze(listAgentToolNames("resident"));
const AGENT_LOADABLE_TOOLS = Object.freeze(listAgentToolNames("loadable"));

const agentExecutionActions = {
  _buildAgentRequest({
    input = "",
    runContext = "",
    instruction = "",
    title = "腰果 Agent",
    projectId = "",
    taskId = "",
    runId = "",
    stepId = "",
    onToken = null,
    onReasoning = null,
    signal = null
  } = {}) {
    return {
      taskType: "agent",
      title,
      instruction,
      input,
      runContext,
      contextProfile: "heavy",
      contextBudget: { ...AGENT_CONTEXT_BUDGET },
      pinnedSections: [],
      projectId,
      taskId,
      runId,
      stepId,
      onToken,
      onReasoning,
      signal
    };
  },

  _resolveAgentTools(tools = "agent") {
    if (Array.isArray(tools)) {
      const names = tools.filter((name) => typeof name === "string" && name);
      return names.length ? [...new Set(names)] : null;
    }
    return tools === "agent" ? [...AGENT_RESIDENT_TOOLS] : null;
  },

  async _executeAgent({
    runTaskArgs = {},
    projectId = "",
    taskId = "",
    runId = "",
    runDir = "",
    handoffDir = "",
    stepId = "",
    turnId = "",
    fileReferences = [],
    explicitOutputTargets = [],
    requestedToolNames = null,
    maxRounds = null,
    message = "",
    onToolEvent = null
  } = {}) {
    const request = /** @type {any} */ (runTaskArgs);
    const registry = createAgentToolRegistry();
    const toolCtx = /** @type {any} */ (await this._buildAgentToolContext({
      projectId, taskId, runId, runDir, handoffDir, stepId, turnId,
      fileReferences, explicitOutputTargets, registry
    }));
    const memoryCacheScope = this.memoryCacheService?.taskScope?.(projectId, taskId) || "";
    if (memoryCacheScope) {
      request.memoryCacheScope = memoryCacheScope;
      toolCtx.memoryCacheScope = memoryCacheScope;
      toolCtx.memoryCacheController = {
        invalidate: (operation = "clear") => (
          this.memoryCacheService.invalidate(memoryCacheScope, operation)
        )
      };
    }
    const sessionMemoryTurn = await this._beginSessionMemoryTurn({
      toolCtx,
      request,
      projectId,
      taskId,
      runId,
      turnId: turnId || stepId
    });
    if (sessionMemoryTurn) toolCtx.sessionMemoryTurn = sessionMemoryTurn;
    const sessionHistory = projectId && taskId && typeof this.listAgentMessages === "function"
      ? await this.listAgentMessages({ projectId, taskId, limit: 160 })
      : [];
    const memoryPrefetchTurn = this._beginMemoryPrefetchTurn({
      toolCtx,
      request,
      sessionHistory,
      projectId,
      taskId,
      runId,
      turnId: turnId || stepId
    });
    if (memoryPrefetchTurn) toolCtx.memoryPrefetchTurn = memoryPrefetchTurn;
    const instructionMemoryTurn = await this._beginInstructionMemoryTurn(toolCtx);
    if (instructionMemoryTurn) {
      toolCtx.instructionMemoryTurn = instructionMemoryTurn;
      request.instructionReminder = instructionMemoryTurn.initialReminder();
      request.instructionMemorySummary = instructionMemoryTurn.summary();
    }
    const memoryIndex = await toolCtx.memoryStore?.indexContext?.();
    const prefetchedMemory = memoryPrefetchTurn?.takeReadyContext?.() || "";
    request.pinnedSections = [
      ...(memoryIndex ? [memoryIndex] : []),
      ...(prefetchedMemory ? [prefetchedMemory] : []),
      ...(Array.isArray(request.pinnedSections) ? request.pinnedSections : [])
    ];
    const desiredNames = Array.isArray(requestedToolNames)
      ? requestedToolNames
      : AGENT_RESIDENT_TOOLS;
    const loadableCatalog = await this._buildAgentCapabilityCatalog(registry, toolCtx);
    toolCtx.loadableCatalog = loadableCatalog;
    const toolNames = [...new Set(desiredNames)].filter((name) => (
      registry.has(name)
      && isToolAvailable(name, toolCtx)
      && (name !== "load_capability" || loadableCatalog.length > 0)
    ));
    const deliveryTools = this._availableAgentDeliveryTools({ projectId, taskId });
    const traceRows = [];
    let unregisterActive = /** @type {null | ((result?: any) => void)} */ (null);
    const effectiveMaxRounds = Number.isFinite(maxRounds) && Number(maxRounds) > 0
      ? Math.max(1, Math.floor(Number(maxRounds)))
      : null;
    const result = await runToolLoop({
      aiRouter: this.aiRouter,
      registry,
      toolNames,
      extraToolSchemas: deliveryTools,
      deliveryToolNames: deliveryTools.map((tool) => tool.function.name),
      executeDeliveryToolCall: typeof this._executeAgentDeliveryTool === "function"
        ? (payload) => this._executeAgentDeliveryTool({
          ...payload,
          call: this._attachSelectedImageAssets(payload.call, toolCtx.imageAssets),
          message: message || request.input || "",
          history: sessionHistory,
          projectId,
          taskId,
          runId,
          turnId: turnId || stepId,
          signal: request.signal || null
        })
        : null,
      toolCtx,
      runTaskArgs,
      shellSandboxFactory: this.shellSandboxFactory,
      requireToolAuthorization: true,
      requireResolvedArtifacts: true,
      ...(effectiveMaxRounds ? { maxRounds: effectiveMaxRounds } : {}),
      onAgentReady: (control) => {
        unregisterActive = this.taskAgentCoordinator?.registerActive?.({
          projectId,
          taskId,
          runId,
          turnId: turnId || stepId,
          executionId: runId || turnId || stepId
        }, control) || null;
      },
      onAgentClosed: (_control, finalResult) => {
        unregisterActive?.(finalResult);
        unregisterActive = null;
      },
      onToolEvent: typeof onToolEvent === "function" ? onToolEvent : null,
      onRound: (round, calls) => {
        traceRows.push({
          round,
          toolCalls: (calls || []).map((call) => ({
            name: call?.function?.name || "",
            argsDigest: crypto.createHash("sha256")
              .update(`${call?.function?.arguments || ""}`, "utf8")
              .digest("hex")
          }))
        });
      }
    });
    if (typeof unregisterActive === "function") unregisterActive();
    const artifacts = await collectAgentFileArtifacts(result.toolCalls, toolCtx);
    await this.projectService?.recordTaskArtifacts?.(projectId, taskId, artifacts).catch(() => null);
    const publishedHead = artifacts.filter((artifact) => artifact?.source === "agent-publish").at(-1);
    if (publishedHead?.absolute && projectId && taskId) {
      await this.projectService?.updateTask?.(projectId, taskId, {
        status: "active",
        lastArtifact: publishedHead.absolute
      }).catch(() => null);
    }
    const toolTrace = buildAgentToolTrace(result, traceRows, effectiveMaxRounds, toolNames);
    await this._persistAgentTrace({
      projectId, taskId, runId, runDir, stepId, turnId,
      result, traceRows, toolNames: [...toolNames, ...deliveryTools.map((tool) => tool.function.name)]
    }).catch(() => null);
    return {
      text: `${result.text || ""}`,
      cancelled: Boolean(result.aborted),
      blocked: Boolean(result.exhausted && !result.aborted),
      stopCode: normalizeTraceCode(result.stopCode),
      usage: result.usage || null,
      contextStats: toPersistedContextStats(result.contextStats),
      artifact: artifacts.at(-1) || null,
      artifacts,
      toolTrace
    };
  },

  async _buildAgentCapabilityCatalog(registry, toolCtx) {
    const tools = buildToolCapabilityCatalog(
      registry,
      AGENT_LOADABLE_TOOLS.filter((name) => name !== "run_skill"),
      toolCtx
    );
    const skills = this.skillsService?.capabilityCatalog
      ? await this.skillsService.capabilityCatalog({ directOnly: true })
      : [];
    return [...tools, ...skills];
  },

  async _beginInstructionMemoryTurn(toolCtx = {}) {
    if (!this.instructionMemoryService?.beginTurn) return null;
    const scopeRoot = `${toolCtx.workspacePath || toolCtx.agentWorkDir || ""}`;
    const cwd = `${toolCtx.agentWorkDir || scopeRoot}`;
    if (!scopeRoot || !cwd) return null;
    return this.instructionMemoryService.beginTurn({
      scopeRoot,
      cwd,
      explicitTargets: toolCtx.authorizedReferencePaths || [],
      cacheScope: toolCtx.memoryCacheScope || ""
    });
  },

  async _beginSessionMemoryTurn({
    toolCtx = {}, request = {}, projectId = "", taskId = "", runId = "", turnId = ""
  } = {}) {
    const context = /** @type {any} */ (toolCtx);
    const agentRequest = /** @type {any} */ (request);
    if (!this.sessionMemoryService?.beginTurn || !projectId || !taskId) return null;
    try {
      return await this.sessionMemoryService.beginTurn({
        projectId,
        taskId,
        runId,
        turnId,
        taskSeed: {
          title: agentRequest.title,
          instruction: agentRequest.instruction,
          input: agentRequest.input,
          runContext: agentRequest.runContext
        },
        workspacePath: context.workspacePath || context.agentWorkDir || ""
      });
    } catch {
      return null;
    }
  },

  _beginMemoryPrefetchTurn({
    toolCtx = {},
    request = {},
    sessionHistory = [],
    projectId = "",
    taskId = "",
    runId = "",
    turnId = ""
  } = {}) {
    const context = /** @type {any} */ (toolCtx);
    const agentRequest = /** @type {any} */ (request);
    if (!this.memoryPrefetchService?.beginTurn || !context.memoryStore) return null;
    const history = memoryPrefetchHistory(sessionHistory);
    try {
      return this.memoryPrefetchService.beginTurn({
        memoryStore: context.memoryStore,
        conversation: memoryPrefetchConversation(sessionHistory, agentRequest),
        shownFiles: history.shownFiles,
        recentTools: history.recentTools,
        projectId,
        taskId,
        runId,
        turnId,
        signal: agentRequest.signal || null
      });
    } catch {
      return null;
    }
  },

  _availableAgentDeliveryTools({ projectId = "", taskId = "" } = {}) {
    if (!projectId || !taskId || typeof this._executeAgentDeliveryTool !== "function") return [];
    const tools = [];
    if (this.skillsService) tools.push(GENERATE_DOCUMENT_TOOL);
    if (this.projectService) tools.push(GENERATE_VISUAL_TOOL);
    return tools;
  },

  async _buildAgentToolContext({
    projectId = "",
    taskId = "",
    runId = "",
    runDir = "",
    handoffDir = "",
    stepId = "",
    turnId = "",
    fileReferences = [],
    explicitOutputTargets = [],
    registry = null
  } = {}) {
    const taskDir = projectId && taskId && this.projectService?.getTaskDir
      ? this.projectService.getTaskDir(projectId, taskId)
      : runDir;
    const task = projectId && taskId && this.projectService?.getTask
      ? await this.projectService.getTask(projectId, taskId, false).catch(() => null)
      : null;
    const workspacePath = await resolveAgentWorkspace(
      this.projectService,
      projectId,
      taskId,
      task
    );
    const candidateDir = taskDir ? path.join(taskDir, ".candidates") : "";
    const todoDir = taskDir ? path.join(taskDir, "agent-state") : runDir;
    const agentWorkDir = workspacePath || candidateDir || runDir;
    if (agentWorkDir && !workspacePath) await ensureDir(agentWorkDir);
    const memoryContextRoot = workspacePath
      || (projectId && this.projectService?.getProjectDir
        ? this.projectService.getProjectDir(projectId)
        : agentWorkDir);
    const memoryStore = memoryContextRoot && this.projectService?.memoryStore?.forContext
      ? await this.projectService.memoryStore.forContext({
        workspaceRoot: memoryContextRoot,
        ...agentMemoryContext(task?.agentMemory || {})
      })
      : null;
    await this.projectService?.ensureAgentFileIndex?.(
      projectId,
      taskId,
      workspacePath || taskDir
    ).catch(() => null);
    const settings = await this.settingsService?.get?.().catch(() => ({})) || {};
    const fullFileSystemAccess = settings.permissions?.fileSystem?.fullAccess === true;
    const fileSystemRoot = fullFileSystemAccess && agentWorkDir
      ? path.parse(path.resolve(agentWorkDir)).root
      : "";
    const requestedReferencePaths = (Array.isArray(fileReferences) ? fileReferences : [])
      .map((file) => `${file || ""}`.trim())
      .filter(Boolean);
    const authorizedReferencePaths = await Promise.all(
      requestedReferencePaths.map(async (file) => (await validateGrantedLocalItem(file)).path)
    );
    const readScope = [...new Set(
      [taskDir, workspacePath, runDir, fileSystemRoot, ...authorizedReferencePaths].filter(Boolean)
    )];
    // bash 只看到其 cwd/write root 与用户明确交给本轮的参考文件。
    // taskDir/runDir 含 session、trace 与 ContextResultStore 等宿主控制面，
    // 由 Pi read 或专用工具按各自信任协议读取，不能把父目录交给 shell。
    const shellReadScope = [...new Set(authorizedReferencePaths)];
    const hostReadDeny = [
      this.paths?.configDir,
      this.paths?.privateDir,
      taskDir ? path.join(taskDir, "session") : "",
      taskDir ? path.join(taskDir, "context-results") : ""
    ].filter(Boolean);
    const hostWriteDeny = [
      ...hostReadDeny,
      this.paths?.workflowsDir,
      this.paths?.registriesDir,
      this.paths?.schedulesDir
    ].filter(Boolean);
    const installationRoot = this.paths?.projectRoot
      && path.basename(path.resolve(this.paths.projectRoot)) === "runtime"
      ? path.dirname(path.resolve(this.paths.projectRoot))
      : "";
    return {
      artifactStore: this.artifactStore || null,
      todoStore: this.todoStore || null,
      checkpointStore: this.checkpointStore || null,
      memoryStore,
      referenceService: this.referenceService || null,
      webSearchService: this.webSearchService || null,
      projectService: this.projectService || null,
      skillsService: this.skillsService || null,
      aiRouter: this.aiRouter || null,
      registry,
      onTrace: (trace) => this._persistSpawnTrace({
        runDir, stepId, taskType: "agent"
      }, trace),
      subAgentTaskType: "agent",
      runDir,
      handoffDir,
      todoDir,
      taskDir,
      projectId,
      taskId,
      runId,
      artifactRunId: handoffDir ? runId : "",
      currentStepId: stepId,
      turnId,
      skillWorkDir: agentWorkDir,
      skillScopeAllow: agentWorkDir ? [agentWorkDir] : [],
      agentWorkDir,
      workspacePath,
      agentScopeAllow: readScope,
      agentReadScopeAllow: readScope,
      agentShellReadScopeAllow: shellReadScope,
      agentWriteScopeAllow: agentWorkDir ? [agentWorkDir] : [],
      agentReadScopeDeny: hostReadDeny,
      agentWriteScopeDeny: hostWriteDeny,
      authorizedReferencePaths,
      explicitOutputTargets: normalizeExplicitOutputTargets(explicitOutputTargets),
      explicitOutputDenyRoots: [this.paths?.workspace, installationRoot].filter(Boolean),
      contextResultDir: taskDir
        ? path.join(
          taskDir,
          "context-results",
          assertSafePathSegment(turnId || stepId || runId || "agent", "Agent context id")
        )
        : "",
      fullFileSystemAccess,
      ...(typeof this.openExternal === "function" ? {
        openExternal: (url, options) => this.openExternal(url, options)
      } : {}),
      ...(this.toolPermissionService?.authorize ? {
        authorizeToolCall: (input) => this.toolPermissionService.authorize(input)
      } : {}),
      imageAssets: new Map(),
      artifactCandidates: new Map(),
      artifactInspections: new Map(),
      loadableCatalog: []
    };
  },

  async _persistAgentTrace({
    projectId = "",
    taskId = "",
    runId = "",
    runDir = "",
    stepId = "",
    turnId = "",
    result = null,
    traceRows = [],
    toolNames = []
  } = {}) {
    const taskDir = projectId && taskId && this.projectService?.getTaskDir
      ? this.projectService.getTaskDir(projectId, taskId)
      : "";
    const safeStepId = stepId ? assertSafePathSegment(stepId, "stepId") : "";
    const dir = runDir && safeStepId
      ? path.join(runDir, "steps", safeStepId)
      : (taskDir ? path.join(taskDir, "agent-traces") : "");
    if (!dir) return;
    await ensureDir(dir);
    const file = runDir && safeStepId
      ? path.join(dir, "tool-trace.jsonl")
      : path.join(dir, `${new Date().toISOString().slice(0, 10)}.jsonl`);
    await appendJsonl(file, {
      persistedAt: new Date().toISOString(),
      artifactProtocolVersion: 3,
      projectId: safeIdentifier(projectId, "project"),
      taskId: safeIdentifier(taskId, "task"),
      runId: safeIdentifier(runId, "run"),
      stepId: safeIdentifier(stepId, "step"),
      turnId: safeIdentifier(turnId, "turn"),
      rounds: Number(result?.rounds) || 0,
      exhausted: Boolean(result?.exhausted),
      aborted: Boolean(result?.aborted),
      stopCode: normalizeTraceCode(result?.stopCode),
      toolCallsCount: (result?.toolCalls || []).length,
      allowedTools: safeToolNames(toolNames),
      context: toPersistedContextStats(result?.contextStats),
      roundsOutline: toPersistedRoundsOutline(traceRows),
      toolCalls: (result?.toolCalls || []).map(toPersistedToolCall)
    });
  },

  async _persistSpawnTrace(scope = {}, trace = {}) {
    if (!scope.runDir) return;
    const spawnId = `spawn_${crypto.randomBytes(8).toString("hex")}`;
    const dir = path.join(scope.runDir, "spawns", spawnId);
    try {
      await ensureDir(dir);
      const prompt = `${trace?.prompt || ""}`;
      const finalText = `${trace?.finalText || ""}`;
      const deniedToolDigests = uniqueTraceDigests([
        ...validTraceDigests(trace?.deniedToolDigests),
        ...digestTraceValues(trace?.deniedTools)
      ]);
      await appendJsonl(path.join(dir, "trace.jsonl"), {
        spawnId,
        spawnedByStepId: safeIdentifier(scope.stepId, "step"),
        spawnedByTaskType: safeIdentifier(scope.taskType || "agent", "task_type"),
        purposeDigest: traceDigest(`${trace?.purpose || ""}`),
        promptDigest: traceDigest(prompt),
        promptChars: prompt.length,
        resultDigest: traceDigest(finalText),
        resultChars: finalText.length,
        allowedTools: safeToolNames(trace?.allowedTools),
        deniedToolCount: Array.isArray(trace?.deniedTools)
          ? trace.deniedTools.length
          : nonNegativeInteger(trace?.deniedToolCount),
        deniedToolDigests,
        maxRounds: nonNegativeInteger(trace?.maxRounds),
        rounds: nonNegativeInteger(trace?.rounds),
        exhausted: Boolean(trace?.exhausted),
        context: toPersistedContextStats(trace?.contextStats),
        roundsOutline: toPersistedRoundsOutline(trace?.rounds_outline),
        toolCalls: (trace?.toolCallsTrace || []).map(toPersistedToolCall),
        completedAt: new Date().toISOString()
      });
    } catch {
      // Trace 持久化失败不破坏 Agent 主流程。
    }
  },

  _attachSelectedImageAssets(call, imageAssets = null) {
    if (!(imageAssets instanceof Map) || !call?.function) return call;
    let args = {};
    try { args = JSON.parse(call.function.arguments || "{}"); } catch { return call; }
    const ids = Array.isArray(args.imageAssetIds) ? args.imageAssetIds : [];
    const selected = ids.map((id) => imageAssets.get(`${id}`)).filter(Boolean);
    return selected.length ? { ...call, resolvedImageAssets: selected } : call;
  },

  _describeAgentStop(stopCode = "", maxRounds = 0) {
    return describeAgentStop(stopCode, maxRounds);
  }
};

function buildAgentToolTrace(result, traceRows, maxRounds, toolNames) {
  return {
    toolNames: safeToolNames(result.contextStats?.availableTools || [...BASE_TOOL_NAMES, ...toolNames]),
    maxRounds,
    rounds: result.rounds,
    exhausted: Boolean(result.exhausted),
    toolCallsCount: result.toolCalls.length,
    memoryWritePerformed: result.toolCalls.some((call) => (
      call?.name === "pin_memory"
      && call?.ok === true
      && call?.result?.value?.memory?.deduplicated !== true
    )),
    roundsOutline: toPersistedRoundsOutline(traceRows),
    context: toPersistedContextStats(result.contextStats)
  };
}

function describeAgentStop(stopCode = "", maxRounds = 0) {
  const code = `${stopCode || ""}`;
  if (code === "AGENT_ROUND_LIMIT") {
    return `Agent 达到${maxRounds ? ` ${maxRounds} ` : " "}轮执行上限，尚未交付最终结果。`;
  }
  if (code === "AGENT_STALLED") return "Agent 连续重复相同工具操作，已停止以避免无进展循环。";
  if (code === "AGENT_TOOL_PROTOCOL_LEAK") return "Agent 返回了无法安全执行的工具指令，未生成可交付结果。";
  if (code === "MODEL_OUTPUT_TRUNCATION_STALLED") return "模型连续达到输出上限且没有形成可继续的正文。";
  if (code === "AGENT_EMPTY_RESULT") return "Agent 没有返回可交付结果。";
  if (code === "AGENT_ARTIFACTS_UNRESOLVED") return "Agent 没有完成候选文件的检查、发布或废弃。";
  return `Agent 未生成可交付结果${code ? `（${code}）` : ""}。`;
}

function memoryPrefetchHistory(rows = []) {
  const shownFiles = new Set();
  const recentTools = [];
  const source = Array.isArray(rows) ? rows : [];
  for (const row of source) {
    const memory = row?.memoryPrefetch || row?.contextStats?.memoryPrefetch || {};
    for (const file of [
      ...(Array.isArray(memory.shownFiles) ? memory.shownFiles : []),
      ...(Array.isArray(memory.deliveredFiles) ? memory.deliveredFiles : [])
    ]) {
      if (/^(?:user|feedback|project|reference)-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/.test(`${file || ""}`)) {
        shownFiles.add(`${file}`);
      }
    }
  }
  for (const row of source.slice(-6)) {
    for (const name of Array.isArray(row?.toolNamesUsed) ? row.toolNamesUsed : []) {
      if (/^[a-z][a-z0-9_]{0,63}$/.test(`${name || ""}`)) recentTools.push(`${name}`);
    }
  }
  return {
    shownFiles: [...shownFiles],
    recentTools: [...new Set(recentTools)].slice(-24)
  };
}

function memoryPrefetchConversation(rows = [], request = {}) {
  const conversation = (Array.isArray(rows) ? rows : [])
    .filter((row) => ["user", "assistant"].includes(row?.role))
    .map((row) => ({ role: row.role, content: `${row.content || ""}` }));
  const currentInput = `${request.input || ""}`.trim();
  const last = conversation.at(-1);
  if (currentInput && !(last?.role === "user" && `${last.content || ""}`.trim() === currentInput)) {
    conversation.push({ role: "user", content: currentInput });
  }
  if (!conversation.length && `${request.runContext || ""}`.trim()) {
    conversation.push({ role: "user", content: `${request.runContext}` });
  }
  return conversation;
}

async function resolveAgentWorkspace(projectService, projectId, taskId, task) {
  const requestedPath = `${task?.workspacePath || ""}`.trim();
  if (!requestedPath) return "";
  if (typeof projectService?.resolveTaskWorkspace === "function") {
    const resolved = await projectService.resolveTaskWorkspace(projectId, taskId);
    return `${resolved?.workspacePath || ""}`.trim();
  }
  const hadIdentity = hasWorkspaceIdentity(task?.workspaceIdentity);
  const workspaceIdentity = await verifyWorkspaceIdentity(
    requestedPath,
    hadIdentity ? task.workspaceIdentity : undefined
  );
  if (!hadIdentity && typeof projectService?.updateTask === "function") {
    await projectService.updateTask(projectId, taskId, {
      workspacePath: workspaceIdentity.canonicalPath,
      workspaceIdentity
    });
  }
  return workspaceIdentity.canonicalPath;
}

function normalizeExplicitOutputTargets(values = []) {
  const normalized = (Array.isArray(values) ? values : [])
    .filter((target) => `${target?.path || ""}`.trim())
    .map((target) => ({
      path: path.resolve(`${target?.path || ""}`),
      kind: target?.kind === "file" ? "file" : "directory"
    }))
    .filter((target) => path.isAbsolute(target.path) && target.path !== path.parse(target.path).root);
  return [...new Map(normalized.map((target) => [target.path, target])).values()].slice(0, 4);
}

async function collectAgentFileArtifacts(toolCalls = [], toolCtx = {}) {
  const files = new Map();
  const publishedRoot = await canonicalDir(
    toolCtx.taskDir ? path.join(toolCtx.taskDir, "final") : ""
  );
  if (!publishedRoot) return [];
  for (const call of Array.isArray(toolCalls) ? toolCalls : []) {
    if (call?.name !== "publish_artifact" || call?.result?.ok !== true) continue;
    const deliveredPath = `${call?.result?.value?.absolute || call?.args?.path || ""}`.trim();
    const managedPath = `${call?.result?.value?.managedAbsolute || deliveredPath}`.trim();
    if (!deliveredPath || !managedPath) continue;
    const managedAbsolute = path.resolve(
      path.isAbsolute(managedPath)
        ? managedPath
        : path.join(toolCtx.agentWorkDir || toolCtx.taskDir || process.cwd(), managedPath)
    );
    const managedCanonical = await fsp.realpath(managedAbsolute).catch(() => "");
    if (!managedCanonical || managedCanonical === publishedRoot || !pathIsInside(publishedRoot, managedCanonical)) continue;
    const deliveredAbsolute = path.resolve(
      path.isAbsolute(deliveredPath)
        ? deliveredPath
        : path.join(toolCtx.agentWorkDir || toolCtx.taskDir || process.cwd(), deliveredPath)
    );
    const artifact = await describeAgentFileArtifact(deliveredAbsolute, toolCtx, {
      title: `${call?.args?.title || ""}`.trim(),
      source: "agent-publish",
      sha256: `${call?.result?.value?.sha256 || ""}`,
      inspectionId: `${call?.result?.value?.inspectionId || ""}`
    }).catch(() => null);
    if (!artifact) continue;
    files.set(artifact.absolute, artifact);
  }
  return [...files.values()];
}

async function describeAgentFileArtifact(absolute, toolCtx, metadata = {}) {
  const canonical = await fsp.realpath(absolute);
  const stat = await fsp.stat(canonical);
  if (!stat.isFile()) return null;
  const ext = path.extname(canonical).toLowerCase();
  const taskDir = await canonicalDir(toolCtx.taskDir);
  const workspaceDir = await canonicalDir(toolCtx.workspacePath);
  const managed = Boolean(taskDir && pathIsInside(taskDir, canonical));
  const base = managed ? taskDir : workspaceDir;
  let content = "";
  if (AGENT_TEXT_ARTIFACT_EXTENSIONS.has(ext) && ![".html", ".htm"].includes(ext)) {
    content = `${await fsp.readFile(canonical, "utf8").catch(() => "")}`.slice(0, 64000);
  }
  return {
    title: metadata.title || path.basename(canonical),
    file: path.basename(canonical),
    absolute: canonical,
    relative: base && pathIsInside(base, canonical)
      ? (path.relative(base, canonical) || path.basename(canonical))
      : canonical,
    format: ext.slice(1),
    bytes: stat.size,
    size: stat.size,
    updatedAt: stat.mtime.toISOString(),
    content,
    source: metadata.source || "agent-publish",
    sha256: metadata.sha256 || "",
    inspectionId: metadata.inspectionId || "",
    storage: managed ? "task" : "workspace",
    managed
  };
}

async function canonicalDir(value = "") {
  const raw = `${value || ""}`.trim();
  return raw ? fsp.realpath(raw).catch(() => path.resolve(raw)) : "";
}

function pathIsInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function toPersistedToolCall(call = {}) {
  const rawResult = call.result;
  const target = traceTargetDescriptor(call);
  const argsDigest = validDigest(call.argsDigest) || traceDigest(call.args || {});
  const successful = call.ok === true || (
    call.ok === undefined
    && rawResult?.ok === true
    && rawResult?.value?.ok !== false
  );
  return {
    round: nonNegativeInteger(call.round),
    name: safeToolName(call.name),
    argsDigest,
    targetKind: target.kind,
    targetDigest: target.digest,
    effect: safeEffect(call.effect),
    effects: safeEffects(call.effects),
    ok: successful,
    code: normalizeTraceCode(
      call.code || rawResult?.code || rawResult?.value?.code || rawResult?.value?.error?.code
    ),
    resultRef: safeResultRef(call.resultRef),
    resultDigest: validDigest(call.resultDigest)
      || (rawResult === undefined ? "" : traceDigest(rawResult)),
    resultTokens: nonNegativeInteger(call.resultTokens),
    reusedExecution: Boolean(call.reusedExecution),
    reusedResult: Boolean(call.reusedResult),
    modelReceipt: Boolean(call.modelReceipt)
  };
}

function toPersistedRoundsOutline(rows = []) {
  return (Array.isArray(rows) ? rows : []).map((row) => {
    const calls = Array.isArray(row?.toolCalls)
      ? row.toolCalls
      : (Array.isArray(row?.tool_calls) ? row.tool_calls : []);
    return {
      round: nonNegativeInteger(row?.round),
      toolCalls: calls.map((call) => ({
        name: safeToolName(call?.name || call?.function?.name),
        argsDigest: validDigest(call?.argsDigest)
          || traceDigest(call?.arguments ?? call?.function?.arguments ?? call?.args ?? {})
      }))
    };
  });
}

function toPersistedContextStats(source = null) {
  if (!source || typeof source !== "object") return null;
  const execution = source.executionBudget && typeof source.executionBudget === "object"
    ? {
      modelCalls: nonNegativeInteger(source.executionBudget.modelCalls),
      maxModelCalls: nullableNonNegativeInteger(source.executionBudget.maxModelCalls),
      remainingModelCalls: nullableNonNegativeInteger(source.executionBudget.remainingModelCalls),
      toolCalls: nonNegativeInteger(source.executionBudget.toolCalls),
      maxToolCalls: nullableNonNegativeInteger(source.executionBudget.maxToolCalls),
      remainingToolCalls: nullableNonNegativeInteger(source.executionBudget.remainingToolCalls),
      wallClockMs: nullableNonNegativeInteger(source.executionBudget.wallClockMs),
      elapsedMs: nonNegativeInteger(source.executionBudget.elapsedMs),
      deadlineAt: safeIsoTimestamp(source.executionBudget.deadlineAt),
      ok: source.executionBudget.ok === true,
      stopCode: normalizeTraceCode(source.executionBudget.stopCode)
    }
    : null;
  const instructionMemory = toPersistedInstructionMemory(source.instructionMemory);
  const memoryPrefetch = toPersistedMemoryPrefetch(source.memoryPrefetch);
  const sessionMemory = toPersistedSessionMemory(source.sessionMemory);
  return {
    episodes: nonNegativeInteger(source.episodes),
    peakActiveTokens: nonNegativeInteger(source.peakActiveTokens),
    rootRequestTokens: nonNegativeInteger(source.rootRequestTokens),
    activeTokenLimit: nonNegativeInteger(source.activeTokenLimit),
    hardInputTokens: nonNegativeInteger(source.hardInputTokens),
    storedResults: nonNegativeInteger(source.storedResults),
    uniqueResults: nonNegativeInteger(source.uniqueResults),
    deduplicatedResults: nonNegativeInteger(source.deduplicatedResults),
    reusedResults: nonNegativeInteger(source.reusedResults),
    reusedExecutions: nonNegativeInteger(source.reusedExecutions),
    externalizedResults: nonNegativeInteger(source.externalizedResults),
    clearedResults: nonNegativeInteger(source.clearedResults),
    checkpointCount: nonNegativeInteger(source.checkpointCount),
    rejectedCalls: nonNegativeInteger(source.rejectedCalls),
    availableTools: safeToolNames(source.availableTools),
    budgetExhausted: Boolean(source.budgetExhausted),
    executionBudget: execution,
    ...(instructionMemory ? { instructionMemory } : {}),
    ...(memoryPrefetch ? { memoryPrefetch } : {}),
    ...(sessionMemory ? { sessionMemory } : {}),
    edits: (Array.isArray(source.edits) ? source.edits : []).map((edit) => ({
      round: nonNegativeInteger(edit?.round),
      beforeTokens: nonNegativeInteger(edit?.beforeTokens),
      afterTokens: nonNegativeInteger(edit?.afterTokens),
      clearedResults: nonNegativeInteger(edit?.clearedResults),
      checkpointed: Boolean(edit?.checkpointed),
      episode: nonNegativeInteger(edit?.episode),
      strategy: ["tool-result-clearing", "session-memory", "deterministic-checkpoint"]
        .includes(`${edit?.strategy || ""}`)
        ? `${edit.strategy}`
        : "tool-result-clearing",
      keepIndex: nonNegativeInteger(edit?.keepIndex)
    }))
  };
}

function toPersistedSessionMemory(source = null) {
  if (!source || typeof source !== "object") return null;
  return {
    status: ["ready", "empty", "failed"].includes(`${source.status || ""}`)
      ? `${source.status}`
      : "failed",
    updates: nonNegativeInteger(source.updates),
    failedUpdates: nonNegativeInteger(source.failedUpdates),
    compactions: nonNegativeInteger(source.compactions),
    noteTokens: nonNegativeInteger(source.noteTokens),
    file: source.file === "session/memory.md" ? source.file : ""
  };
}

function toPersistedMemoryPrefetch(source = null) {
  if (!source || typeof source !== "object") return null;
  const safeFiles = (value) => [...new Set((Array.isArray(value) ? value : [])
    .map((file) => `${file || ""}`)
    .filter((file) => /^(?:user|feedback|project|reference)-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/.test(file)))]
    .slice(0, 200);
  return {
    status: ["pending", "ready", "empty", "failed", "delivered"].includes(source.status)
      ? source.status
      : "failed",
    code: normalizeTraceCode(source.code),
    candidateCount: nonNegativeInteger(source.candidateCount),
    selectedFiles: safeFiles(source.selectedFiles).slice(0, 5),
    deliveredFiles: safeFiles(source.deliveredFiles).slice(0, 5),
    shownFiles: safeFiles(source.shownFiles),
    recentTools: safeToolNames(source.recentTools).slice(0, 24)
  };
}

function toPersistedInstructionMemory(source = null) {
  if (!source || typeof source !== "object") return null;
  const sources = Array.isArray(source.sources) ? source.sources : [];
  const diagnostics = Array.isArray(source.diagnostics) ? source.diagnostics : [];
  return {
    digest: validDigest(source.digest),
    tokens: nonNegativeInteger(source.tokens),
    sourceCount: sources.length,
    sourceDigests: uniqueTraceDigests(sources.map((item) => traceDigest(`${item || ""}`))),
    diagnosticCount: diagnostics.length,
    diagnosticCodes: [...new Set(diagnostics
      .map((item) => normalizeTraceCode(item?.code))
      .filter(Boolean))]
  };
}

function traceTargetDescriptor(call = {}) {
  const existingKind = safeTargetKind(call.targetKind);
  const existingDigest = validDigest(call.targetDigest);
  if (existingKind && existingDigest) return { kind: existingKind, digest: existingDigest };
  const name = `${call.name || ""}`;
  const args = call.args || {};
  let kind = "tool";
  let value = name;
  if (name === "bash") {
    kind = "shell_command";
    value = `${args.command || call.target || ""}`;
  } else if (`${args.path || args.target || call.target || ""}`.trim()) {
    kind = "path";
    value = `${args.path || args.target || call.target || ""}`;
  } else if (`${args.url || ""}`.trim()) {
    kind = "external_url";
    value = `${args.url}`;
  } else if (args.skillId || args.action) {
    kind = "skill_action";
    value = [args.skillId, args.action].filter(Boolean).join("#");
  }
  return { kind, digest: traceDigest(value) };
}

function traceDigest(value) {
  let serialized = "";
  if (typeof value === "string") serialized = value;
  else {
    try { serialized = JSON.stringify(value) ?? ""; } catch { serialized = Object.prototype.toString.call(value); }
  }
  return crypto.createHash("sha256").update(serialized, "utf8").digest("hex");
}

function validDigest(value) {
  const digest = `${value || ""}`;
  return /^[a-f0-9]{64}$/.test(digest) ? digest : "";
}

function validTraceDigests(values = []) {
  return (Array.isArray(values) ? values : []).map(validDigest).filter(Boolean);
}

function digestTraceValues(values = []) {
  return (Array.isArray(values) ? values : []).map((value) => traceDigest(`${value || ""}`));
}

function uniqueTraceDigests(values = []) {
  return [...new Set((Array.isArray(values) ? values : []).filter(Boolean))];
}

function safeIdentifier(value, prefix) {
  const source = `${value || ""}`.trim();
  if (!source) return "";
  return /^[A-Za-z0-9._:-]{1,128}$/.test(source)
    ? source
    : `${prefix}_${traceDigest(source).slice(0, 20)}`;
}

function safeToolName(value) {
  const source = `${value || ""}`.trim();
  if (!source) return "unknown_tool";
  return /^[a-z][a-z0-9_]{0,63}$/.test(source)
    ? source
    : `tool_${traceDigest(source).slice(0, 20)}`;
}

function safeToolNames(values = []) {
  return [...new Set((Array.isArray(values) ? values : []).map(safeToolName))];
}

function safeEffect(value) {
  const effect = `${value || ""}`;
  return /^[a-z][a-z0-9_]{0,63}$/.test(effect) ? effect : "";
}

function safeEffects(values = []) {
  return [...new Set((Array.isArray(values) ? values : []).map(safeEffect).filter(Boolean))];
}

function safeTargetKind(value) {
  const kind = `${value || ""}`;
  return ["tool", "path", "external_url", "shell_command", "skill_action"].includes(kind)
    ? kind
    : "";
}

function safeResultRef(value) {
  const resultRef = `${value || ""}`;
  return /^ctxr_[a-f0-9]{64}$/.test(resultRef) ? resultRef : null;
}

function normalizeTraceCode(value, fallback = "") {
  const code = `${value || ""}`.trim();
  return /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : fallback;
}

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function nullableNonNegativeInteger(value) {
  return value === null || value === undefined ? null : nonNegativeInteger(value);
}

function safeIsoTimestamp(value) {
  const source = `${value || ""}`;
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(source) ? source : null;
}

const AGENT_TEXT_ARTIFACT_EXTENSIONS = new Set([
  ".md", ".markdown", ".txt", ".html", ".htm", ".json", ".css",
  ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".csv", ".tsv",
  ".xml", ".svg", ".yaml", ".yml"
]);

module.exports = agentExecutionActions;
