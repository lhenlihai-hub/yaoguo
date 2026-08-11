export async function runPlatformRegression(ctx) {
  const {
    root, require, assert, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, join
  } = ctx;
  const { createPaths, WorkflowEngine } = require(join(root, "src/application/appServices.js"));
  const { RegistryService } = require(join(root, "src/platform/registries/registryService.js"));
  const { validateWorkflowManifest } = require(join(root, "src/platform/workflows/workflowManifest.js"));
  const { ArtifactStore } = require(join(root, "src/platform/artifacts/artifactStore.js"));
  const { RunStore } = require(join(root, "src/platform/runs/runStore.js"));
  const { WorkflowStateMachine, STEP_STATUS } = require(join(root, "src/platform/workflows/workflowStateMachine.js"));
  const { SkillsRegistry } = require(join(root, "src/platform/skills/skillsRegistry.js"));
  const { createAgentToolRegistry } = require(join(root, "src/platform/ai/agentTools/index.js"));
  const platformPaths = createPaths(root);
  const registryService = new RegistryService(platformPaths);
  const skills = await new SkillsRegistry({ registryService }).list({ refresh: true });
  assert(skills.length > 0, "生产环境至少应注册一个 Skill");
  for (const skill of skills) {
    assert(skill.valid, `Skill ${skill.id} 契约无效：${skill.issues.join("；")}`);
    assert(skill.instructionsPath.endsWith("SKILL.md"), `Skill ${skill.id} 必须使用 SKILL.md 渐进披露入口`);
    assert(!existsSync(join(skill.dir, "instructions.md")), `Skill ${skill.id} 不应保留重复 instructions.md`);
  }
  const agentTools = createAgentToolRegistry();
  for (const tool of agentTools.list()) {
    const name = tool.schema.function.name;
    assert(tool.policy.namespace !== "uncatalogued", `Agent 工具 ${name} 未登记 capability policy`);
    const parameters = tool.schema.function.parameters;
    if (parameters?.type === "object") {
      assert(parameters.additionalProperties === false, `Agent 工具 ${name} 必须拒绝未声明参数`);
    }
  }
  const agentWorkflow = JSON.parse(readFileSync(join(root, "workspace/workflows/agent-default.json"), "utf8"));
  const workflowValidation = validateWorkflowManifest(agentWorkflow);
  assert(workflowValidation.ok, `通用 Agent manifest 不合法：${workflowValidation.errors.join("；")}`);
  const machine = new WorkflowStateMachine(agentWorkflow);
  let ready = machine.markReady();
  assert(ready.length === 1 && ready[0].id === "01-agent-delivery", "WorkflowStateMachine 应先放行 Agent 交付步骤");
  machine.transition("01-agent-delivery", STEP_STATUS.COMPLETED, { output: { summary: "完成" } });
  ready = machine.markReady();
  assert(ready.length === 0, "Agent 交付后不应再追加第二条成品处理链");

  const platformTmpRoot = mkdtempSync(join(root, ".tmp-platform-check-"));
  try {
    const platformTmpPaths = createPaths(platformTmpRoot);
    const runStore = new RunStore(platformTmpPaths);
    const run = await runStore.createRun({
      projectId: "p",
      taskId: "t",
      workflowRef: "agent-default",
      title: "平台运行结构测试"
    });
    assert(/^\d{8}-\d{6}-[a-f0-9-]{8}$/.test(run.id), "RunStore 应生成短 runId");
    await runStore.saveStepManifest(run, { id: "draft", title: "初稿", status: "running" });
    const artifactStore = new ArtifactStore(platformTmpPaths);
    const artifact = await artifactStore.saveTextArtifact({
      projectId: "p",
      taskId: "t",
      runId: run.id,
      stepId: "draft",
      artifactType: "draft",
      title: "初稿产物",
      content: "这是一段测试正文。",
      summary: "测试摘要。"
    });
    assert(existsSync(artifact.paths.content) && existsSync(artifact.paths.summary), "ArtifactStore 应保存正文与摘要");
    assert(existsSync(join(platformTmpPaths.projectsDir, "p", "artifacts", "index.json")), "ArtifactStore 应维护项目资产索引");
    const migrationEngine = Object.create(WorkflowEngine.prototype);
    migrationEngine.runStore = runStore;
    migrationEngine.artifactStore = artifactStore;
    const migrationState = {
      engineVersion: 2,
      id: run.id,
      runDir: run.runDir,
      projectId: "p",
      taskId: "t",
      workflowId: "migration-workflow",
      workflowName: "迁移工作流",
      status: "pending",
      steps: [
        { id: "brief", index: 0, title: "简报", taskType: "memory", status: "completed", outputFile: "outputs/01.md" },
        { id: "draft", index: 1, title: "初稿", taskType: "draft", status: "blocked", contextNeeds: { prev: ["brief"] }, outputFile: "outputs/02.md" },
        { id: "review", index: 2, title: "审核", taskType: "review", status: "pending", dependsOn: ["draft"], outputFile: "outputs/03.md" }
      ]
    };
    const migrationReady = migrationEngine.getReadySteps(migrationState);
    assert(migrationReady.length === 1 && migrationReady[0].id === "draft", "WorkflowEngine 应通过平台状态机放行 blocked 重试步骤");
    migrationEngine.refreshWorkflowStateSnapshot(migrationState);
    assert(migrationState.workflowState?.steps?.some((step) => step.id === "draft" && step.status === "ready"), "WorkflowEngine 应保存平台 workflowState 快照");
    const migratedArtifact = await migrationEngine.savePlatformStepArtifact(
      migrationState,
      migrationState.steps[1],
      "平台双写正文。",
      "平台双写摘要。",
      { artifactType: "draft" }
    );
    assert(migrationState.steps[1].platformArtifact?.id === migratedArtifact.id, "WorkflowEngine 应把 step 产物回写到 step.platformArtifact");
    assert(
      existsSync(join(run.runDir, "steps", "draft", "output.md"))
        && existsSync(join(run.runDir, "steps", "draft", "draft.artifact.json")),
      "WorkflowEngine 应把步骤正文与 artifact manifest 双写到平台目录"
    );
    await migrationEngine.recordRunEvent(migrationState, { type: "step.completed", stepId: "draft" });
    assert(
      readFileSync(join(run.runDir, "timeline.jsonl"), "utf8").includes("\"step.completed\""),
      "WorkflowEngine 应向平台 timeline 写入运行事件"
    );
    const startProjectService = {
      getProject: async () => ({ id: "p-start", name: "启动项目", type: "general", defaultWorkflowId: "wf-start" }),
      createTask: async () => ({ id: "t-start", title: "启动任务", brief: "启动指令", workflowId: "agent-default" }),
      getTaskDir: () => join(platformTmpPaths.projectsDir, "p-start", "tasks", "t-start"),
      updateTask: async () => ({}),
      updateProject: async () => ({}),
      listProjects: async () => [{ id: "p-start", name: "启动项目", type: "general" }],
      listTasks: async () => [{ id: "t-start", title: "启动任务" }]
    };
    const startEngine = new WorkflowEngine({
      paths: platformTmpPaths,
      settingsService: {},
      projectService: startProjectService,
      aiRouter: {},
      webSearchService: {}
    });
    let loadedAgentWorkflow = false;
    startEngine.loadAgentWorkflow = async () => {
      loadedAgentWorkflow = true;
      return {
      id: "agent-default",
      name: "通用 Agent",
      steps: [
        { id: "agent-delivery", title: "Agent 交付", kind: "ai", taskType: "agent", instruction: "完成交付" }
      ]
    };
    };
    startEngine.seedRunState = async () => {};
    startEngine.buildFinalPreview = async () => null;
    const started = await startEngine.startRun({ projectId: "p-start", topic: "启动主题", command: "启动指令", workflowId: "wf-start" });
    assert(/^\d{8}-\d{6}-[a-f0-9-]{8}$/.test(started.run.id), "WorkflowEngine.startRun 应使用短 runId");
    assert(loadedAgentWorkflow, "WorkflowEngine.startRun 必须从唯一 Agent 清单启动");
    assert(started.run.engineVersion === 2 && started.run.workflowManifest?.id === "agent-default", "WorkflowEngine.startRun 应保存通用 Agent manifest");
    assert(
      existsSync(join(started.run.runDir, "steps", "agent-delivery", "step.json"))
        && readFileSync(join(started.run.runDir, "timeline.jsonl"), "utf8").includes("\"run.started\""),
      "WorkflowEngine.startRun 应初始化平台 step manifest 与 timeline"
    );
  } finally {
    rmSync(platformTmpRoot, { recursive: true, force: true });
  }
}
