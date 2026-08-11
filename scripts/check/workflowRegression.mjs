export async function runWorkflowRegression(ctx) {
  const {
    root, require, assert, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, join
  } = ctx;
  const {
    createPaths,
    WorkflowEngine
  } = require("../src/application/appServices");
  const {
    normalizeYaoguoMarkerText,
    stripYaoguoMarkers,
    extractInlineStepSummary
  } = require("../src/platform/workflows/yaoguoMarkers");
  const { isProcessLocalReference } = require("../src/platform/runtime/referenceSignals");
  const markerSamples = [
    "正文\n---YAOGUO_STEP_SUMMARY---\n摘要",
    "正文\r\n---YAOGUO_STEP_SUMMARY---\r\n摘要",
    "正文\n——YAOGUO_STEP_SUMMARY——\n摘要",
    "正文\n**---YAOGUO_STEP_SUMMARY---**\n摘要",
    "正文\n*——YAOGUO_STEP_SUMMARY——*\n摘要",
    "正文\n<<<YAOGUO_STEP_SUMMARY>>>\n摘要",
    "正文\n＜＜＜YAOGUO_STEP_SUMMARY＞＞＞\n摘要",
    "正文\n```\n---YAOGUO_STEP_SUMMARY---\n摘要\n```",
    "正文\n> **---YAOGUO_STEP_SUMMARY---**\n摘要",
    "正文\n*---YAOGUO_HANDOFF---*\n{\"decisions\":[]}",
    "正文\n[YAOGUO_STEP_SUMMARY]\n摘要"
  ];

  for (const [index, sample] of markerSamples.entries()) {
    const stripped = stripYaoguoMarkers(sample);
    assert(stripped === "正文", `YAOGUO marker 清理样本 ${index + 1} 失败：${JSON.stringify(stripped)}`);
  }

  assert(
    normalizeYaoguoMarkerText("正文——保留破折号") === "正文——保留破折号",
    "非 YAOGUO 行不应归一化正文破折号"
  );

  const parsed = extractInlineStepSummary([
    "正文",
    "**---YAOGUO_STEP_SUMMARY---**",
    "本步摘要",
    "*---YAOGUO_HANDOFF---*",
    "{\"decisions\":[\"a\"],\"rejected\":[],\"open_questions\":[],\"facts\":[]}"
  ].join("\n"));
  assert(parsed.content === "正文", "extractInlineStepSummary 未正确提取正文");
  assert(parsed.summary === "本步摘要", "extractInlineStepSummary 未正确提取摘要");
  assert(parsed.handoff?.decisions?.[0] === "a", "extractInlineStepSummary 未正确解析 HANDOFF JSON");
  assert(isProcessLocalReference({ title: "run.json", relative: "runs/20260428-demo/run.json" }), "事实核查本地检索必须排除 run.json");
  assert(isProcessLocalReference({ title: "05-深度修改.md", relative: "runs/20260428-demo/outputs/05-深度修改.md" }), "事实核查本地检索必须排除本次运行产物");
  assert(!isProcessLocalReference({ title: "市场监管总局通报.md", relative: "references/市场监管总局通报.md" }), "用户保存的参考资料不应被误判为过程文件");

  const engine = Object.create(WorkflowEngine.prototype);
  engine.emitActivity = () => {};

  const agentInputSource = readFileSync(join(root, "src/application/workflows/mixins/agent/agentInputActions.js"), "utf8");
  assert(!/heuristic|inferWorkflowType|inferContentForm|fakeCall/.test(agentInputSource), "Agent 不应在工具调用前后再运行一套意图启发式");
  assert(!existsSync(join(root, "src/application/workflows/mixins/workflowRoutingActions.js")), "单一 Agent 不应保留工作流分发层");
  assert(typeof engine.shouldConsiderPreflightDecision === "undefined", "宿主不应自动创建内容策略决策卡");
  assert(typeof engine.shouldConsiderStepDecision === "undefined", "执行分叉应由 Agent 明确提出，不由宿主关键词触发");

  const sourceDraft = "# 迁移报告\n\n## 风险项\n\n缓存键缺少稳定前缀。";
  const cleanedDraft = engine.cleanStepResultText({
    id: "draft",
    title: "报告初稿",
    taskType: "draft"
  }, sourceDraft);
  assert(cleanedDraft === sourceDraft, "引擎不应再用场景启发式规则改写或删除模型产物");

  const workflowWithoutPacing = {
    id: "general-test",
    name: "通用工作流",
    steps: [
      { id: "01-memory", title: "任务理解", kind: "ai", taskType: "memory", instruction: "读取约束" },
      { id: "02-outline", title: "执行计划", kind: "ai", taskType: "outline", instruction: "制定计划" },
      { id: "03-draft", title: "交付初稿", kind: "ai", taskType: "draft", instruction: "完成交付" }
    ]
  };
  const workflowWithPacing = engine.prepareWorkflowForRun(workflowWithoutPacing);
  assert(
    workflowWithPacing.steps.map((step) => step.id).join("|") === workflowWithoutPacing.steps.map((step) => step.id).join("|"),
    "运行前不应自动插入步骤、删除计划或重写用户工作流"
  );

}
