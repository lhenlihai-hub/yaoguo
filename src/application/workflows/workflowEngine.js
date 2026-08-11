const {
  path,
  ArtifactStore,
  RunStore,
  CheckpointStore,
  readJson,
  sanitizeFileName,
  uniqueValues,
  stripYaoguoMarkers,
  localStepSummary
} = require("../../platform/runtime");
const { TodoStore } = require("../../platform/runs/todoStore");
const { TaskSessionStore } = require("../../platform/sessions/taskSessionStore");
const { TaskAgentCoordinator } = require("../agent/taskAgentCoordinator");

class WorkflowEngine {
  constructor({
    paths,
    settingsService,
    memoryCacheService = null,
    instructionMemoryService = null,
    memoryPrefetchService = null,
    memoryExtractionService = null,
    autoDreamService = null,
    sessionMemoryService = null,
    projectService,
    aiRouter,
    webSearchService,
    referenceService = null,
    onActivity = null,
    runStore = null,
    artifactStore = null,
    checkpointStore = null,
    todoStore = null,
    registryService = null,
    skillsService = null,
    pdfRenderer = null,
    shellSandboxFactory = null,
    openExternal = null,
    toolPermissionService = null,
    taskSessionStore = null,
    taskAgentCoordinator = null,
    errorReporter = null,
    clock = () => new Date()
  } = {}) {
    if (!paths) {
      throw new Error("WorkflowEngine 初始化失败：缺少 paths 依赖。");
    }
    this.paths = paths;
    this.settingsService = settingsService;
    this.memoryCacheService = memoryCacheService;
    this.instructionMemoryService = instructionMemoryService;
    this.memoryPrefetchService = memoryPrefetchService;
    this.memoryExtractionService = memoryExtractionService;
    this.autoDreamService = autoDreamService;
    this.sessionMemoryService = sessionMemoryService;
    this.projectService = projectService;
    this.aiRouter = aiRouter;
    this.webSearchService = webSearchService;
    this.referenceService = referenceService;
    this.onActivity = onActivity;
    this.errorReporter = errorReporter;
    this.clock = clock;
    this.autoNameJobs = new Set();
    this.runAbortControllers = new Map();
    // 取消写盘完成前的短暂 tombstone，消除“Abort 先触发、旧 step catch 先落盘”的竞态。
    this.runCancellationStates = new Map();
    this.runStore = runStore || new RunStore(paths, { errorReporter });
    this.artifactStore = artifactStore || new ArtifactStore(paths);
    // CheckpointStore：Claude Code 风格的 JSONL append-only typed state 持久化。
    // 与 state.md（人类可读）并存，统一从 step handoff 派生，给程序读取 typed state 用。
    // TodoStore：mutable working plan，与 CheckpointStore 互补（handoff=fact, todos=intent）。
    this.checkpointStore = checkpointStore || new CheckpointStore();
    this.todoStore = todoStore || new TodoStore();
    // RegistryService 用于加载注册过的 prompt block；允许在轻量测试中缺省。
    this.registryService = registryService;
    // SkillsService：Agent 的 generate_document tool 路由到 docx/pdf/pptx/xlsx skill。
    // 允许 null：未注入时模型 tool call 会被拒绝并返回 "skills not available"。
    this.skillsService = skillsService;
    // PdfRenderer：Chromium printToPDF（Electron 主进程能力，零外部依赖）。
    // 允许 null：测试 / 非 Electron 环境下 PDF 回落到 docx→LibreOffice 兜底。
    this.pdfRenderer = pdfRenderer;
    this.shellSandboxFactory = shellSandboxFactory;
    this.openExternal = openExternal;
    this.toolPermissionService = toolPermissionService;
    this.taskSessionStore = taskSessionStore || (projectService
      ? new TaskSessionStore({
        projectService,
        legacyMigration: projectService.legacyChatMigration || null
      })
      : null);
    this.taskAgentCoordinator = taskAgentCoordinator || new TaskAgentCoordinator({
      sessionStore: this.taskSessionStore
    });
    // 缓存 prompt block content，避免每步重复读盘。
    this.promptBlockCache = new Map();
  }

  async loadAgentWorkflow() {
    // 唯一 Agent 清单只从 bundled/global 真相源读取。项目目录中
    // 的旧 workflow 文件保留为用户数据，但不再形成可选执行引擎。
    const file = path.join(this.paths.workflowsDir, "agent-default.json");
    return readJson(file, null);
  }

  prepareWorkflowForRun(workflow = {}) {
    return this.withExecutionDefaults(workflow);
  }

  normalizeStepRef(value = "") {
    return sanitizeFileName(`${value || ""}`.trim(), "").toLowerCase();
  }

  withExecutionDefaults(workflow = {}) {
    const sourceSteps = Array.isArray(workflow.steps) ? workflow.steps : [];
    const steps = sourceSteps.map((step, index) => {
      const { parallelGroup: _retiredParallelGroup, ...serialStep } = step;
      return {
        ...serialStep,
        id: this.normalizeStepRef(step.id || `${String(index + 1).padStart(2, "0")}-${step.title || "step"}`)
      };
    });
    const validIds = new Set(steps.map((step) => step.id));
    const nextSteps = steps.map((step, index) => {
      const explicitDepends = Array.isArray(step.dependsOn) || Array.isArray(step.dependencies);
      const rawDepends = explicitDepends
        ? (step.dependsOn || step.dependencies || [])
        : (index > 0 ? [steps[index - 1].id] : []);
      const contextDepends = Array.isArray(step.contextNeeds?.prev) ? step.contextNeeds.prev : [];
      const dependsOn = uniqueValues([...rawDepends, ...contextDepends]
        .map((item) => this.normalizeStepRef(item))
        .filter((item) => item && item !== step.id && validIds.has(item)));
      return {
        ...step,
        ...(dependsOn.length ? { dependsOn } : {})
      };
    });
    return { ...workflow, steps: nextSteps };
  }

  // 通用 prompt-block 加载器：按 id 从 registries/prompts/blocks 读 asset.content，缓存 in-memory。
  // 任何加载失败（registry 未注入 / 找不到 block / content 为空）都返回 ""，
  // 确保上游 prompt 拼接逻辑安全降级，不阻塞步骤执行。
  async loadPromptBlock(blockId = "") {
    if (!blockId || !this.registryService) return "";
    if (this.promptBlockCache.has(blockId)) return this.promptBlockCache.get(blockId);
    try {
      const row = await this.registryService.getById("prompts/blocks", blockId);
      const content = row?.asset?.content || "";
      this.promptBlockCache.set(blockId, content);
      return content;
    } catch {
      this.promptBlockCache.set(blockId, "");
      return "";
    }
  }

  async executeStep(state, step, { signal = null } = {}) {
    const historicalStep = step.taskType && step.taskType !== "agent";
    const handoffPrefill = historicalStep
      ? await this.composeStepHandoffPrefill(state).catch(() => "")
      : "";
    const outcome = await this.executeAgentTurn({
      message: state.command || state.taskBrief || state.topic || "完成当前任务。",
      projectId: state.projectId || "",
      taskId: state.taskId || "",
      runId: state.id || "",
      runDir: state.runDir || "",
      handoffDir: historicalStep ? (state.runDir || "") : "",
      stepId: step.id || "",
      turnId: `${step.agentExecution?.turnId || `run:${state.id || "run"}`}`,
      fileReferences: state.fileReferences || [],
      state,
      step,
      instruction: step.instruction || "完成当前用户请求。",
      title: step.title || "Agent",
      additionalRunContext: handoffPrefill,
      requestedToolNames: this._resolveAgentTools(step.tools) || this._resolveAgentTools("agent"),
      maxRounds: step.maxToolRounds,
      signal
    });
    step.toolTrace = outcome.toolTrace;
    if (outcome.blocked || outcome.cancelled) {
      return {
        text: outcome.reply,
        summary: outcome.reply,
        handoff: null,
        files: outcome.artifacts.map(compactAgentArtifact),
        blocked: true,
        stopCode: outcome.stopCode,
        message: outcome.reply
      };
    }
    const finalText = `${outcome.reply || ""}`.trim();
    if (!finalText) throw new Error("Agent 没有返回可交付结果。");
    return {
      text: finalText,
      summary: localStepSummary(finalText),
      handoff: null,
      files: outcome.artifacts
        .map(compactAgentArtifact)
        .filter((artifact) => artifact.absolute)
    };
  }

  extractDeliverableContent(content = "") {
    return stripYaoguoMarkers(`${content || ""}`).trim();
  }

  stripProcessSections(content = "") {
    return stripYaoguoMarkers(`${content || ""}`).trim();
  }

  cleanStepResultText(step = {}, content = "") {
    const text = `${content || ""}`.trim();
    if (!text) return "";
    return stripYaoguoMarkers(text);
  }

}

function compactAgentArtifact(artifact = {}) {
  return {
    artifactId: `${artifact.artifactId || ""}`,
    title: `${artifact.title || ""}`,
    file: `${artifact.file || ""}`,
    absolute: `${artifact.absolute || ""}`,
    relative: `${artifact.relative || ""}`,
    format: `${artifact.format || ""}`,
    bytes: Number(artifact.bytes || artifact.size) || 0,
    size: Number(artifact.size || artifact.bytes) || 0,
    pages: Number(artifact.pages) || 0,
    updatedAt: `${artifact.updatedAt || ""}`,
    source: `${artifact.source || ""}`,
    storage: `${artifact.storage || ""}`,
    managed: Boolean(artifact.managed),
    sha256: `${artifact.sha256 || ""}`,
    inspectionId: `${artifact.inspectionId || ""}`
  };
}

const agentSessionActions = require("./mixins/agentSessionActions");
const runLifecycleActions = require("./mixins/runLifecycleActions");
const decisionActions = require("./mixins/decisionActions");
const legacyRunContextActions = require("./mixins/legacyRunContextActions");
const runContextActions = require("./mixins/runContextActions");
const sessionContextActions = require("./mixins/sessionContextActions");
const agentExecutionActions = require("./mixins/agentExecutionActions");
const agentDeliveryActions = require("./mixins/agent/agentDeliveryActions");

Object.assign(
  WorkflowEngine.prototype,
  agentSessionActions,
  runLifecycleActions,
  decisionActions,
  legacyRunContextActions,
  runContextActions,
  sessionContextActions,
  agentExecutionActions,
  agentDeliveryActions
);

module.exports = {
  WorkflowEngine
};
