const {
  createPaths,
  ensureDir,
  seedBundledWorkspace,
  exists
} = require("../platform/runtime");
const { DEFAULT_SETTINGS, SettingsService, mergeSettings } = require("../platform/config/settingsService");
const { BridgeService } = require("../app/shell/bridgeService");
const { SchedulerService } = require("./scheduler/schedulerService");
const { InstructionMemoryService } = require("../platform/memory/instructions");
const { MemoryStore } = require("../platform/memory/memoryStore");
const { MemoryPrefetchService } = require("../platform/memory/prefetch");
const { MemoryExtractionService } = require("../platform/memory/extraction");
const { AutoDreamService } = require("../platform/memory/autodream");
const { SessionMemoryService } = require("../platform/memory/session");
const { MemoryCacheService } = require("../platform/memory/cache");
const { ProjectService } = require("../platform/projects/projectService");
const { TaskSessionStore } = require("../platform/sessions/taskSessionStore");
const { AiRouter } = require("../platform/ai/aiRouter");
const { WebSearchService, ReferenceService } = require("../platform/research/referenceServices");
const { ToolPermissionService } = require("../platform/permissions/toolPermissionService");
const { WorkflowEngine } = require("./workflows/workflowEngine");
const { TaskAgentCoordinator } = require("./agent/taskAgentCoordinator");
const { PlatformKernel } = require("../platform/platformKernel");

async function createApplicationServices({
  projectRoot,
  paths = null,
  aiRouter: providedAiRouter = null,
  pdfRenderer = null,
  onActivity = null,
  shellSandboxFactory = null,
  openExternal = null,
  openLocalPath = null,
  requestToolApproval = null,
  seedWorkspaceRoot = "",
  memdirBaseDirectory = "",
  memoryPrefetchService: providedMemoryPrefetchService = undefined,
  memoryExtractionService: providedMemoryExtractionService = undefined,
  autoDreamService: providedAutoDreamService = undefined,
  sessionMemoryService: providedSessionMemoryService = undefined,
  startBackgroundServices = true
} = {}) {
  if (!projectRoot && !paths?.projectRoot) {
    throw new Error("应用服务初始化失败：缺少 projectRoot。");
  }
  paths = paths || createPaths(projectRoot);
  await Promise.all([
    ensureDir(paths.workspace),
    ensureDir(paths.projectsDir),
    ensureDir(paths.runsDir),
    ensureDir(paths.assetsDir),
    ensureDir(paths.schedulesDir),
    ensureDir(paths.workflowsDir),
    ensureDir(paths.registriesDir)
  ]);
  await seedBundledWorkspace(paths, { sourceRoot: seedWorkspaceRoot });

  const platformKernel = new PlatformKernel({ paths });
  await platformKernel.ensure();
  const settingsService = new SettingsService(paths);
  await settingsService.ensure();
  const memoryCacheService = new MemoryCacheService();
  const instructionMemoryService = new InstructionMemoryService({
    settingsService,
    memoryCacheService
  });
  const longTermMemoryStore = new MemoryStore({ baseDirectory: memdirBaseDirectory });
  const projectService = new ProjectService(paths, settingsService, {
    memoryStore: longTermMemoryStore
  });
  await projectService.ensure();
  await projectService.legacyChatMigration.migrateGlobalChatsToProjects().catch(() => null);
  const taskSessionStore = new TaskSessionStore({
    projectService,
    legacyMigration: projectService.legacyChatMigration
  });
  const taskAgentCoordinator = new TaskAgentCoordinator({ sessionStore: taskSessionStore });

  const aiRouter = providedAiRouter || new AiRouter(settingsService, paths, {
    tokenLedger: platformKernel.tokenLedger,
    registryService: platformKernel.registries,
    memoryCacheService
  });
  if (!aiRouter.memoryCacheService) aiRouter.memoryCacheService = memoryCacheService;
  const memoryPrefetchService = providedMemoryPrefetchService === undefined
    ? new MemoryPrefetchService({
      aiRouter,
      registryService: platformKernel.registries
    })
    : providedMemoryPrefetchService;
  const autoDreamService = providedAutoDreamService === undefined
    ? new AutoDreamService({
      aiRouter,
      registryService: platformKernel.registries,
      memoryStore: longTermMemoryStore,
      projectService,
      taskSessionStore
    })
    : providedAutoDreamService;
  const sessionMemoryService = providedSessionMemoryService === undefined
    ? new SessionMemoryService({
      aiRouter,
      registryService: platformKernel.registries,
      taskSessionStore,
      settingsService
    })
    : providedSessionMemoryService;
  const memoryExtractionService = providedMemoryExtractionService === undefined
    ? new MemoryExtractionService({
      aiRouter,
      registryService: platformKernel.registries,
      memoryStore: longTermMemoryStore,
      projectService,
      taskSessionStore,
      autoDreamService
    })
    : providedMemoryExtractionService;
  const webSearchService = new WebSearchService(paths, settingsService);
  const referenceService = new ReferenceService(paths, settingsService, webSearchService, projectService);
  const toolPermissionService = new ToolPermissionService({
    settingsService,
    paths,
    requestApproval: requestToolApproval
  });
  const workflowEngine = new WorkflowEngine({
    paths,
    settingsService,
    memoryCacheService,
    longTermMemoryStore,
    instructionMemoryService,
    memoryPrefetchService,
    memoryExtractionService,
    autoDreamService,
    sessionMemoryService,
    projectService,
    aiRouter,
    webSearchService,
    referenceService,
    runStore: platformKernel.runs,
    artifactStore: platformKernel.artifacts,
    registryService: platformKernel.registries,
    skillsService: platformKernel.skills,
    pdfRenderer,
    onActivity,
    shellSandboxFactory,
    openExternal,
    openLocalPath,
    toolPermissionService,
    taskSessionStore,
    taskAgentCoordinator
  });
  const schedulerService = new SchedulerService(paths, workflowEngine);
  const bridgeService = new BridgeService(settingsService, workflowEngine, schedulerService);
  // 先将上次进程留下的不确定执行收口，再对外接单。
  // 否则 scheduler / bridge 可能在对账窗口内启动同一任务。
  await workflowEngine.reconcileInterruptedRuns().catch(() => {});
  if (startBackgroundServices) {
    autoDreamService?.startNightly?.();
    await schedulerService.start();
    await bridgeService.start();
  }
  return {
    paths,
    settingsService,
    memoryCacheService,
    instructionMemoryService,
    memoryPrefetchService,
    memoryExtractionService,
    autoDreamService,
    sessionMemoryService,
    projectService,
    aiRouter,
    workflowEngine,
    schedulerService,
    bridgeService,
    referenceService,
    toolPermissionService,
    taskSessionStore,
    taskAgentCoordinator,
    platformKernel
  };
}

module.exports = {
  createApplicationServices,
  createPaths,
  DEFAULT_SETTINGS,
  SettingsService,
  mergeSettings,
  MemoryCacheService,
  MemoryStore,
  MemoryPrefetchService,
  MemoryExtractionService,
  AutoDreamService,
  SessionMemoryService,
  ProjectService,
  AiRouter,
  WebSearchService,
  ReferenceService,
  ToolPermissionService,
  TaskSessionStore,
  TaskAgentCoordinator,
  WorkflowEngine,
  SchedulerService,
  BridgeService,
  ensureDir,
  seedBundledWorkspace,
  exists
};
