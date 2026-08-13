import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { AiRouter } = require("../src/platform/ai/aiRouter.js");
const { estimateTokens } = require("../src/platform/tokens/tokenEstimator.js");
const {
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
  STATIC_SECTION_IDS,
  DYNAMIC_SECTION_DEFINITIONS,
  buildContextGuidanceSection,
  buildMemoryGuidanceSection,
  buildToolGuidanceSection,
  buildRuntimeContextSection,
  compileSystemPromptSections,
  getOutputStylePrompt,
  getSystemPromptSectionCache,
  getSystemPrompt
} = require("../src/platform/ai/prompts.js");

const registriesDir = path.join(process.cwd(), "workspace", "registries");

function promptRouter() {
  return new AiRouter(
    { get: async () => ({ deepseek: {} }) },
    { registriesDir }
  );
}

test("getSystemPrompt 返回静态前缀、boundary 与缓存作用域 section", async () => {
  const router = promptRouter();
  const options = {
    tools: [
      { type: "function", function: { name: "write" } },
      { type: "function", function: { name: "read" } }
    ],
    model: "deepseek-v4-pro",
    workingDirectory: "/workspace/main",
    additionalWorkingDirectories: ["/workspace/reference"],
    mcpClients: [{ name: "notion" }],
    featureGates: { compactResults: true, retiredMode: false }
  };
  const sections = await getSystemPrompt(router, options);
  const boundaryIndex = sections.indexOf(SYSTEM_PROMPT_DYNAMIC_BOUNDARY);

  assert.equal(boundaryIndex, STATIC_SECTION_IDS.length + 2);
  assert.match(sections[1], /<introduction>/);
  assert.match(sections[2], /<system>/);
  assert.match(sections[3], /<doing_tasks>/);
  assert.match(sections[4], /<actions>/);
  assert.match(sections[5], /<tools>/);
  assert.match(sections[6], /<tone_and_style>/);
  assert.match(sections[7], /<output_efficiency>/);
  assert.match(sections[8], /<aesthetic_principle>/);
  assert.match(sections[boundaryIndex + 1], /<memory_cache>/);
  assert.match(sections[boundaryIndex + 2], /<memory_behavior>/);
  assert.match(sections[boundaryIndex + 3], /<dynamic_tool_guidance>/);
  assert.match(sections[boundaryIndex + 3], /file_read_guidance|file_write_guidance/);
  assert.doesNotMatch(
    sections.slice(0, boundaryIndex).join("\n"),
    /read, write|deepseek-v4-pro|\/workspace\/main|notion|compactResults/
  );
  assert.doesNotMatch(sections.join("\n"), /deepseek-v4-pro|\/workspace\/main|notion|compactResults/);
});

test("Actions 用可逆性与影响面判断高风险动作，并服从真实授权范围", async () => {
  const sections = await getSystemPrompt(promptRouter());
  const actions = sections[4];

  assert.match(actions, /能否完整撤销/);
  assert.match(actions, /删除文件、分支或数据库，终止进程，覆盖未提交修改/);
  assert.match(actions, /执行前先只读核对目标、状态与调用参数/);
  assert.match(actions, /相同后果使用相同边界/);
  assert.match(actions, /一次批准只覆盖当时的动作、目标和场景/);
  assert.match(actions, /allow_session、allow_always、allow_effect/);
  assert.match(actions, /不自行扩权/);
});

test("Tools 与 Tone 声明专用工具路由、并行边界和隐藏工具前言", async () => {
  const sections = await getSystemPrompt(promptRouter());
  const tools = sections[5];
  const tone = sections[6];

  assert.match(tools, /本轮有专用工具时用专用工具/);
  assert.match(tools, /精确授权、审计并封装系统差异/);
  assert.match(tone, /CommonMark 链接/);
  assert.match(tone, /\[owner\/repo#number\]\(URL\)/);
  assert.match(tone, /同轮 Tool Call 前不写依赖用户看到的引导句/);
});

test("System section 声明可见输出、权限 Hook、Meta Message 与 Compact 语义", async () => {
  const sections = await getSystemPrompt(promptRouter());
  const system = sections[2];

  assert.match(system, /只有不带 Tool Call 的终止轮 assistant 文本进入最终用户回复/);
  assert.match(system, /工具执行状态由宿主 Tool Activity 展示/);
  assert.match(system, /Markdown[^<]+CommonMark/);
  assert.match(system, /Ask \/ All agree/);
  assert.match(system, /TOOL_PERMISSION_DENIED/);
  assert.match(system, /beforeToolCall、afterToolCall Hook/);
  assert.match(system, /system-reminder[^<]+宿主 Meta 信息/);
  assert.match(system, /自动 Compact/);
  assert.match(system, /重读权威来源/);
  assert.ok(estimateTokens(system) < 650);
});

test("Doing Tasks 把软件工程请求落到工作目录并限制失败重试与范围膨胀", async () => {
  const sections = await getSystemPrompt(promptRouter());
  const tasks = sections[3];

  assert.match(tasks, /working directory/);
  assert.match(tasks, /snake_case/);
  assert.match(tasks, /没读过的代码不作具体断言/);
  assert.match(tasks, /优先编辑已有文件/);
  assert.match(tasks, /分钟、小时或天数/);
  assert.match(tasks, /只有相关参数或前置条件改变后才重试同一调用/);
  assert.match(tasks, /不附带新功能、无关重构、命名清理或性能优化/);
  assert.match(tasks, /没有三个当前调用点/);
  assert.match(tasks, /\/help/);
  assert.match(tasks, /https:\/\/github\.com\/lhenlihai-hub\/yaoguo\/issues/);
  assert.ok(estimateTokens(tasks) < 850);
});

test("本轮能力与记忆形态变化不改写静态前缀，只改变 boundary 后的动态指导", async () => {
  const router = promptRouter();
  const left = await getSystemPrompt(router, {
    tools: ["read"],
    model: "deepseek-v4-pro",
    workingDirectory: "/workspace/left"
  });
  const right = await getSystemPrompt(router, {
    tools: ["read", "write"],
    memoryContext: {
      enabled: true,
      scope: "project",
      storageMode: "append-only",
      autoDream: true,
      sessionMemory: true,
      transcript: true,
      contextResults: true
    },
    contextManagement: {
      enabled: true,
      toolResultMasking: true,
      fileOffloading: true,
      sessionCompaction: true,
      deterministicCheckpoint: true,
      subagentIsolation: true
    },
    model: "deepseek-v4-flash",
    workingDirectory: "/workspace/right",
    mcpClients: ["github"]
  });
  const leftBoundary = left.indexOf(SYSTEM_PROMPT_DYNAMIC_BOUNDARY);
  const rightBoundary = right.indexOf(SYSTEM_PROMPT_DYNAMIC_BOUNDARY);
  assert.deepEqual(left.slice(0, leftBoundary), right.slice(0, rightBoundary));
  assert.equal(left[leftBoundary + 1], right[rightBoundary + 1]);
  assert.equal(left[leftBoundary + 2], right[rightBoundary + 2]);
  assert.match(right[rightBoundary + 3], /dynamic_memory_guidance/);
  assert.match(right[rightBoundary + 4], /dynamic_context_guidance/);
  assert.notEqual(left[leftBoundary + 3], right[rightBoundary + 5]);
  assert.match(left[leftBoundary + 3], /file_read_guidance/);
  assert.doesNotMatch(left[leftBoundary + 3], /file_write_guidance/);
  assert.match(right[rightBoundary + 5], /file_write_guidance/);
});

test("动态 Section 由名称、计算函数与依赖键组成，并按工具组合复用异步结果", async () => {
  const router = promptRouter();
  const originalLoad = router.loadSystemPromptAsset.bind(router);
  let toolGuidanceLoads = 0;
  router.loadSystemPromptAsset = async (blockId, options) => {
    if (blockId === "block://tool.guidance") toolGuidanceLoads += 1;
    return originalLoad(blockId, options);
  };

  assert.deepEqual(
    DYNAMIC_SECTION_DEFINITIONS.map(({ name }) => name),
    ["memory-guidance", "context-guidance", "tool-guidance"]
  );
  assert.equal(typeof DYNAMIC_SECTION_DEFINITIONS[0].compute, "function");
  assert.equal(DYNAMIC_SECTION_DEFINITIONS[2].cacheKey({ tools: ["write", "read"] }), "read,write");

  const [first, second] = await Promise.all([
    getSystemPrompt(router, { tools: ["write", "read"], cacheScope: "task:one" }),
    getSystemPrompt(router, { tools: ["read", "write"], cacheScope: "task:one" })
  ]);
  assert.deepEqual(first, second);
  assert.equal(toolGuidanceLoads, 1);
  assert.match(
    await getSystemPromptSectionCache(router, "task:one", "dynamic:tool-guidance:read,write"),
    /dynamic_tool_guidance/
  );
});

test("Context Guidance 只描述腰果实际启用的 Masking、外置与 Compact 机制", async () => {
  const section = await buildContextGuidanceSection(promptRouter(), {
    enabled: true,
    toolResultMasking: true,
    fileOffloading: true,
    sessionCompaction: true,
    deterministicCheckpoint: true,
    subagentIsolation: true
  });

  assert.match(section, /当前模型窗口只包含已注入的 System、Messages 与 Tool Result/);
  assert.match(section, /receipt[^<]+resultRef/);
  assert.match(section, /ContextResultStore/);
  assert.match(section, /session\/memory\.md/);
  assert.match(section, /独立 context window/);
  assert.doesNotMatch(section, /80%|self.?modifying|小模型咨询大模型/i);
  assert.equal(await buildContextGuidanceSection(promptRouter(), null), "");
});

test("动态 Memory 按真实 Memdir 与会话能力选择板块", async () => {
  const router = promptRouter();
  const indexed = await buildMemoryGuidanceSection(router, {
    enabled: true,
    scope: "local",
    storageMode: "indexed"
  });
  const appendProject = await buildMemoryGuidanceSection(router, {
    enabled: true,
    scope: "project",
    storageMode: "append-only",
    autoDream: true,
    sessionMemory: true,
    transcript: true,
    contextResults: true
  });

  assert.match(indexed, /<auto_memory>/);
  assert.doesNotMatch(indexed, /daily_memory_log|project_shared_memory|memory_autodream|session_continuity/);
  assert.match(appendProject, /<auto_memory>/);
  assert.match(appendProject, /<daily_memory_log>/);
  assert.match(appendProject, /<project_shared_memory>/);
  assert.match(appendProject, /<memory_autodream>/);
  assert.match(appendProject, /<session_continuity>/);
  assert.equal(await buildMemoryGuidanceSection(router, null), "");
});

test("Memory 明确文件系统模型、价值测试、理由、时效与 Memory/Todo/Plan 边界", async () => {
  const section = await buildMemoryGuidanceSection(promptRouter(), {
    enabled: true,
    scope: "local",
    storageMode: "indexed",
    autoDream: true,
    sessionMemory: true,
    transcript: true,
    contextResults: true
  });

  assert.match(section, /Markdown Memdir/);
  assert.match(section, /不是意识、隐藏大脑、知识图谱或双向链接网络/);
  assert.match(section, /memory\.md 只是一张始终可见的主题地图/);
  assert.match(section, /user 保存用户本人稳定的角色/);
  assert.match(section, /feedback 保存用户评价过的 Agent 行为[^<]+及原因/);
  assert.match(section, /相对日期转成 YYYY-MM-DD/);
  assert.match(section, /令人意外、非显而易见且有复用价值/);
  assert.match(section, /用户要求“记住”也不改变这些排除边界/);
  assert.match(section, /不能无依据扩成永远禁用所有 Mock/);
  assert.match(section, /Front Matter、文件名与 memory\.md pointer 由宿主维护/);
  assert.match(section, /Memory 是历史记录，可能过时/);
  assert.match(section, /Memory 保存跨会话稳定知识；Todo 保存有状态的在途工作项/);
  assert.match(section, /events\.jsonl/);
  assert.match(section, /resultRef[^<]+read_context_result/);
  assert.doesNotMatch(section, /\/projects\/|Session ID.*resume/);
});

test("动态工具指导只包含已启用的真实腰果工具，不虚构 Grep 或 REPL", async () => {
  const router = promptRouter();
  const fileTools = await buildToolGuidanceSection(router, ["read", "write", "edit", "bash"]);
  const taskTools = await buildToolGuidanceSection(router, ["write_todo", "list_todos"]);
  const memoryWrite = await buildToolGuidanceSection(router, ["pin_memory"]);
  const capabilityLoader = await buildToolGuidanceSection(router, ["load_capability"]);

  assert.match(fileTools, /file_read_guidance/);
  assert.match(fileTools, /file_edit_guidance/);
  assert.match(fileTools, /file_write_guidance/);
  assert.match(fileTools, /bash_routing_guidance/);
  assert.doesNotMatch(fileTools, /todo_write_guidance|Grep|REPL/);
  assert.match(taskTools, /todo_write_guidance/);
  assert.match(taskTools, /todo_list_guidance/);
  assert.doesNotMatch(taskTools, /file_read_guidance|bash_routing_guidance|Grep|REPL/);
  assert.match(memoryWrite, /pin_memory_guidance/);
  assert.match(memoryWrite, /长期价值测试/);
  assert.match(capabilityLoader, /capability_index 只提供名称、短描述与触发线索/);
  assert.match(capabilityLoader, /精确 capabilityId/);
});

test("单个工具开关不会带入未启用工具的名称", async () => {
  const router = promptRouter();
  const editOnly = await buildToolGuidanceSection(router, ["edit"]);
  const referenceOnly = await buildToolGuidanceSection(router, ["search_reference"]);
  const readOnly = await buildToolGuidanceSection(router, ["read"]);

  assert.match(editOnly, /file_edit_guidance/);
  assert.doesNotMatch(editOnly, /file_write_guidance|\bwrite\b|\bbash\b/);
  assert.match(referenceOnly, /search_reference_guidance/);
  assert.doesNotMatch(referenceOnly, /fetch_url|read_reference/);
  assert.match(readOnly, /file_read_guidance/);
  assert.doesNotMatch(readOnly, /\bbash\b|\bcat\b|\bsed\b/);
});

test("prepareTaskRequest 剔除 boundary，并把动态能力放进当前轮尾部 user message", async () => {
  const router = promptRouter();
  const request = await router.prepareTaskRequest({
    taskType: "agent",
    title: "Prompt sections",
    instruction: "完成当前请求",
    input: "检查 Prompt",
    runContext: "",
    tools: [{ type: "function", function: { name: "read" } }],
    workingDirectory: "/workspace/main",
    additionalWorkingDirectories: ["/workspace/reference"],
    mcpClients: ["notion"],
    featureGates: { compactResults: true },
    environment: {
      platform: "darwin",
      architecture: "arm64",
      shell: "/bin/zsh",
      gitRepository: true
    },
    scratchpadDirectory: "/task/.candidates",
    capabilityCatalog: [{
      id: "skill://slides@1#create",
      kind: "skill-action",
      description: "创建演示文稿",
      intentExamples: ["制作 PPT"]
    }],
    outputStyleConfig: { mode: "explanatory" },
    contextProfile: "heavy",
    provider: { id: "deepseek", knowledgeCutoff: "2025-06" },
    model: "deepseek-v4-pro",
    callMaxTokens: 1000,
    settings: {
      language: { preferred: "简体中文" },
      context: {
        tokenBudgets: { defaultModelTokens: 128000, outputReserveTokens: 6000 }
      }
    }
  });

  assert.ok(Array.isArray(request.systemPromptSections));
  assert.equal(
    request.system,
    compileSystemPromptSections(request.systemPromptSections)
  );
  const boundaryIndex = request.systemPromptSections.indexOf(SYSTEM_PROMPT_DYNAMIC_BOUNDARY);
  assert.ok(boundaryIndex > 0);
  assert.doesNotMatch(request.system, /SYSTEM_PROMPT_DYNAMIC_BOUNDARY|\/workspace\/main|deepseek-v4-pro|notion/);
  assert.ok(request.messages.every((message) => !`${message.content}`.includes(SYSTEM_PROMPT_DYNAMIC_BOUNDARY)));
  assert.match(request.messages.at(-1).content, /deepseek-v4-pro/);
  assert.match(request.messages.at(-1).content, /\/workspace\/main/);
  assert.match(request.messages.at(-1).content, /\/workspace\/reference/);
  assert.match(request.messages.at(-1).content, /notion/);
  assert.match(request.messages.at(-1).content, /compactResults/);
  assert.match(request.messages.at(-1).content, /mode="explanatory"/);
  assert.match(request.messages.at(-1).content, /<current_date>\d{4}-\d{2}-\d{2}<\/current_date>/);
  assert.match(request.messages.at(-1).content, /<knowledge_cutoff>2025-06<\/knowledge_cutoff>/);
  assert.match(request.messages.at(-1).content, /<language_preference value="简体中文">/);
  assert.match(request.messages.at(-1).content, /<platform>darwin<\/platform>/);
  assert.match(request.messages.at(-1).content, /<git_repository>true<\/git_repository>/);
  assert.match(request.messages.at(-1).content, /<scratchpad_directory[^>]+>\/task\/\.candidates/);
  assert.match(request.messages.at(-1).content, /skill:\/\/slides@1#create/);
  assert.match(request.messages.at(-1).content, /<system-reminder>/);
});

test("runtime context 与输出风格有确定顺序，standard 不注入额外风格规则", async () => {
  const router = promptRouter();
  const learning = await getOutputStylePrompt(router, "learning");
  const runtime = buildRuntimeContextSection({
    tools: ["write", "read"],
    model: "deepseek-v4-pro",
    workingDirectory: "/workspace/main",
    currentDate: "2026-08-13",
    timeZone: "Asia/Singapore",
    environment: { platform: "darwin", architecture: "arm64", shell: "/bin/zsh", gitRepository: false },
    outputStylePrompt: learning
  });
  assert.match(runtime, /<tools>read, write<\/tools>/);
  assert.match(runtime, /<current_date>2026-08-13<\/current_date>/);
  assert.match(runtime, /provider-not-declared/);
  assert.match(runtime, /<platform>darwin<\/platform>/);
  assert.match(runtime, /<git_repository>false<\/git_repository>/);
  assert.doesNotMatch(runtime, /language_preference/);
  assert.match(runtime, /mode="learning"/);
  assert.equal(await getOutputStylePrompt(router, "standard"), "");
  assert.match(await getOutputStylePrompt(router, "explanatory"), /1-3/);
  assert.match(learning, /可迁移原理/);
});
