// @ts-check
// P4 集成测试 —— 真 stores + stub aiRouter,验证多工具组合行为。
//
// 对齐 Anthropic Tau-bench / SWE-bench 范式:process-level 验证
// (关键 checkpoint 命中、工具间 handoff、文件落盘),不做 LLM ground-truth 比对。

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const agentExecutionActions = require("../src/application/workflows/mixins/agentExecutionActions.js");
const { ArtifactStore } = require("../src/platform/artifacts/artifactStore.js");
const { TodoStore } = require("../src/platform/runs/todoStore.js");
const { CheckpointStore } = require("../src/platform/runs/checkpointStore.js");
const { MemoryStore } = require("../src/platform/memory/memoryStore.js");

/**
 * 构造一个最小可运行的 WorkflowEngine-like host，挂唯一 Agent 执行器。
 * 真 stores + stub 网络 / LLM 边界。
 */
async function makeIntegrationHost({ aiRouterScripts = [] } = {}) {
  const workspace = mkdtempSync(path.join(tmpdir(), "p4-integration-"));
  const paths = {
    workspace,
    projectsDir: path.join(workspace, "projects"),
    privateDir: path.join(workspace, "private"),
    registriesDir: path.join(workspace, "registries")
  };

  class StubEngine {}
  Object.assign(StubEngine.prototype, agentExecutionActions);
  const host = new StubEngine();

  host.aiRouter = makeFakeRouter(aiRouterScripts);
  host.artifactStore = new ArtifactStore(paths);
  host.todoStore = new TodoStore();
  host.checkpointStore = new CheckpointStore();
  // projectService.memoryStore 包装(整合点)
  host.projectService = {
    getProjectDir: (projectId) => path.join(paths.projectsDir, projectId),
    getTaskDir: (projectId, taskId) => path.join(paths.projectsDir, projectId, "tasks", taskId),
    memoryStore: new MemoryStore({ workspaceRoot: workspace })
  };
  host.referenceService = null; // 默认不开网,scenario 需要再注入
  host.webSearchService = null;
  host.toolPermissionService = { authorize: async () => ({ allow: true }) };

  return { host, paths, workspace };
}

/**
 * Stub AiRouter —— 按 scripts 顺序同时提供字符串与原生 detailed 契约。
 * 每个 script:{ text, toolCalls? }
 */
function makeFakeRouter(scripts = []) {
  let i = 0;
  const router = {
    invocations: [],
    next(args, continuation = false) {
      router.invocations.push(args);
      const script = scripts[i] || scripts[scripts.length - 1] || { text: "" };
      i += 1;
      script.before?.(args);
      const toolCalls = Array.isArray(script.toolCalls) ? script.toolCalls : [];
      const content = script.text || "";
      return {
        content,
        toolCalls,
        requestMessages: continuation
          ? (args.messages || [])
          : [{ role: "user", content: args.input || "" }],
        assistantMessage: {
          role: "assistant",
          content: content || null,
          ...(toolCalls.length ? { tool_calls: toolCalls } : {})
        }
      };
    },
    async runTask(args) {
      return router.next(args, false).content;
    },
    async runTaskDetailed(args) {
      return router.next(args, false);
    },
    async continueTaskDetailed(args) {
      return router.next(args, true);
    }
  };
  return router;
}

async function executeAgent(host, state, step, runTaskArgs, requestedToolNames) {
  const turn = await host._executeAgent({
    runTaskArgs: { taskType: "agent", ...runTaskArgs },
    projectId: state.projectId || "",
    taskId: state.taskId || "",
    runId: state.id || "",
    runDir: state.runDir || "",
    stepId: step.id || "",
    requestedToolNames,
    maxRounds: step.maxToolRounds
  });
  step.toolTrace = turn.toolTrace;
  if (turn.blocked) throw new Error(host._describeAgentStop(turn.stopCode, turn.toolTrace?.maxRounds));
  return turn.text;
}

let callSequence = 0;
function call(name, args) {
  callSequence += 1;
  return {
    id: `call_${callSequence}`,
    type: "function",
    function: { name, arguments: JSON.stringify(args) }
  };
}

// ============================================================================
// Scenario 1:通用交付 step 的多轮 ReAct loop
// ============================================================================

test("[scenario 1] agent step 多轮 ReAct:search → read → write_todo", async () => {
  // 预热：先 seed 一份历史 artifact。canonical Agent 不依赖 run handoff。
  const { host, workspace } = await makeIntegrationHost({});
  const state = {
    runDir: path.join(workspace, "projects", "p1", "tasks", "t1", "runs", "r1"),
    projectId: "p1", taskId: "t1", id: "r1"
  };
  // 1. 预先保存一份历史分析 artifact
  await host.artifactStore.saveTextArtifact({
    projectId: "p1", taskId: "t1", runId: "r1", stepId: "step-analysis",
    artifactType: "analysis", title: "接口延迟分析",
    content: "主要延迟来自串行网络请求。\n\n缓存层尚未覆盖重复查询。"
  });
  // 重置 router 用真实脚本:模拟主 LLM 多轮调用
  host.aiRouter = makeFakeRouter([
    // 第 1 轮:search_run_artifacts 找历史分析
    { text: "找历史分析", toolCalls: [call("search_run_artifacts", { query: "缓存" })] },
    // 第 2 轮:read_artifact 精读
    {
      text: "精读",
      toolCalls: [call("read_artifact", {
        runId: "r1", stepId: "step-analysis", artifactType: "analysis", limit: 8
      })]
    },
    // 第 3 轮:write_todo 跟踪 TODO
    {
      text: "记 todo",
      toolCalls: [call("write_todo", { action: "create", text: "验证缓存键归一化" })]
    },
    // 第 4 轮：模型自然回复并结束
    { text: "结论：缓存键必须在拼接动态上下文前完成规范化。" }
  ]);

  const step = {
    id: "step-delivery", taskType: "agent",
    maxToolRounds: 8,
    tools: [
      "search_run_artifacts", "read_artifact",
      "write_todo"
    ]
  };
  const text = await executeAgent(host, state, step, {}, step.tools);

  // ============ 验证 ============
  // 1. 3 轮 tool_calls 后自然回复并结束。
  assert.equal(host.aiRouter.invocations.length, 4);
  // 2. step.toolTrace 完整
  assert.equal(step.toolTrace.toolCallsCount, 3);
  assert.equal(step.toolTrace.rounds, 4);
  // 3. 最终输出
  assert.match(text, /缓存键/);
  // 4. todo 落盘
  const todoDir = path.join(host.projectService.getTaskDir("p1", "t1"), "agent-state");
  const todos = await host.todoStore.list(todoDir);
  assert.equal(todos.length, 1);
  assert.match(todos[0].text, /缓存键/);
  assert.equal(todos[0].sourceStepId, "step-delivery", "ctx.currentStepId 应注入 sourceStepId");
  // 5. step tool-trace 落盘(P1 路径)
  const traceFile = path.join(state.runDir, "steps", "step-delivery", "tool-trace.jsonl");
  assert.ok(existsSync(traceFile), "step tool-trace.jsonl 应落盘");
  const traceRow = JSON.parse((await readFile(traceFile, "utf8")).trim());
  assert.equal(traceRow.toolCallsCount, 3);
  // 6. 工具调用链 artifact 验证:
  //    search_run_artifacts 命中后,read_artifact 用同样的 stepId 能读到内容 ——
  //    通过 read_artifact 这一轮的 LLM 输出反查没法,我们看 tc.result.ok 即可。
  const readArtifactCall = traceRow.toolCalls.find((c) => c.name === "read_artifact");
  assert.ok(readArtifactCall && readArtifactCall.ok, "read_artifact 应成功命中预 seed 的 artifact");

  await rm(workspace, { recursive: true, force: true });
});

test("[memory context] 首轮只常驻 memory.md 索引，主题正文由模型调用 search_memory 后进入", async () => {
  const { host, workspace } = await makeIntegrationHost({});
  const state = {
    runDir: path.join(workspace, "projects", "p1", "tasks", "t1", "runs", "r-memory"),
    projectId: "p1", taskId: "t1", id: "r-memory"
  };
  const projectDir = host.projectService.getProjectDir("p1");
  await mkdir(projectDir, { recursive: true });
  const scopedMemory = await host.projectService.memoryStore.forContext({ workspaceRoot: projectDir });
  await scopedMemory.append({
    type: "user",
    basis: "user-stated-profile",
    topic: "review-preference",
    name: "评审偏好",
    description: "用户偏好先展示可验证证据。",
    content: "主题正文哨兵：用户偏好先展示可验证证据，再给结论。",
    valueBeyondCode: "这是用户协作偏好，无法从代码推导。"
  });
  const shownByRuntime = [];
  host.memoryPrefetchService = {
    beginTurn() {
      return {
        takeReadyContext: () => "",
        dynamicReminder: () => "",
        markShown(files) { shownByRuntime.push(...files); },
        close() {},
        summary: () => ({
          status: "empty", code: "NO_SELECTION", candidateCount: 0,
          selectedFiles: [], deliveredFiles: [], shownFiles: shownByRuntime, recentTools: []
        })
      };
    }
  };
  host.aiRouter = makeFakeRouter([
    {
      text: "读取相关主题",
      toolCalls: [call("search_memory", { files: ["user-review-preference.md"] })]
    },
    { text: "已依据用户偏好完成评审。" }
  ]);

  await executeAgent(host, state, { id: "memory-turn", maxToolRounds: 3 }, {}, ["search_memory"]);

  const first = host.aiRouter.invocations[0];
  assert.equal("memoryTopK" in first, false);
  assert.equal("memoryFiles" in first, false);
  assert.match(first.pinnedSections[0], /<long-term-memory-index source="memory\.md">/);
  assert.match(first.pinnedSections[0], /user-review-preference\.md/);
  assert.doesNotMatch(first.pinnedSections[0], /主题正文哨兵/);
  const continuation = JSON.stringify(host.aiRouter.invocations[1].messages);
  assert.match(continuation, /主题正文哨兵/);
  assert.deepEqual(shownByRuntime, ["user-review-preference.md"]);

  await rm(workspace, { recursive: true, force: true });
});

test("[memory prefetch] 旁路结果不阻塞首轮，并在就绪后的工具续轮成为受保护上下文", async () => {
  const { host, workspace } = await makeIntegrationHost({});
  const state = {
    runDir: path.join(workspace, "projects", "p1", "tasks", "t1", "runs", "r-prefetch"),
    projectId: "p1", taskId: "t1", id: "r-prefetch"
  };
  let ready = false;
  let delivered = false;
  const prefetchTurn = {
    takeReadyContext() {
      if (!ready || delivered) return "";
      delivered = true;
      return "<long-term-memory-prefetch>动态召回正文哨兵</long-term-memory-prefetch>";
    },
    dynamicReminder() {
      return this.takeReadyContext();
    },
    markShown() {},
    close() {},
    summary() {
      return {
        status: delivered ? "delivered" : "pending",
        code: delivered ? "DELIVERED" : "PENDING",
        candidateCount: 1,
        selectedFiles: ["user-prefetch.md"],
        deliveredFiles: delivered ? ["user-prefetch.md"] : [],
        shownFiles: delivered ? ["user-prefetch.md"] : [],
        recentTools: []
      };
    }
  };
  host.memoryPrefetchService = {
    beginTurn() {
      return prefetchTurn;
    }
  };
  host.aiRouter = makeFakeRouter([
    {
      before() { ready = true; },
      text: "先读取 todo",
      toolCalls: [call("list_todos", {})]
    },
    { text: "已使用动态召回正文。" }
  ]);

  await executeAgent(host, state, { id: "memory-prefetch", maxToolRounds: 3 }, {
    input: "继续当前任务"
  }, ["list_todos"]);

  const first = JSON.stringify(host.aiRouter.invocations[0].pinnedSections || []);
  assert.doesNotMatch(first, /动态召回正文哨兵/);
  const continuation = JSON.stringify(host.aiRouter.invocations[1].messages || []);
  assert.match(continuation, /动态召回正文哨兵/);
  assert.equal(delivered, true);
  await rm(workspace, { recursive: true, force: true });
});

test("[memory prefetch] 后续 turn 从会话元数据过滤已展示文件并恢复最近工具", async () => {
  const { host, workspace } = await makeIntegrationHost({});
  const state = {
    runDir: path.join(workspace, "projects", "p1", "tasks", "t1", "runs", "r-prefetch-history"),
    projectId: "p1", taskId: "t1", id: "r-prefetch-history"
  };
  host.listAgentMessages = async () => [{
    role: "assistant",
    content: "上一轮结果",
    memoryPrefetch: {
      shownFiles: ["user-already-shown.md"],
      deliveredFiles: ["feedback-review.md"]
    },
    toolNamesUsed: ["fetch_url", "read", "fetch_url"]
  }];
  let received = null;
  host.memoryPrefetchService = {
    beginTurn(options) {
      received = options;
      return {
        takeReadyContext: () => "",
        dynamicReminder: () => "",
        close() {},
        summary: () => ({
          status: "empty", code: "NO_SELECTION", candidateCount: 0,
          selectedFiles: [], deliveredFiles: [], shownFiles: [], recentTools: options.recentTools
        })
      };
    }
  };
  host.aiRouter = makeFakeRouter([{ text: "完成" }]);

  await executeAgent(host, state, { id: "memory-prefetch-history", maxToolRounds: 2 }, {
    input: "新一轮请求"
  }, []);

  assert.deepEqual(received.shownFiles.sort(), ["feedback-review.md", "user-already-shown.md"]);
  assert.deepEqual(received.recentTools, ["fetch_url", "read"]);
  assert.equal(received.conversation.at(-1).content, "新一轮请求");
  await rm(workspace, { recursive: true, force: true });
});

test("[memory write] 结构边界在权限确认前拒绝无效写入", async () => {
  const { host, workspace } = await makeIntegrationHost({});
  const state = {
    runDir: path.join(workspace, "projects", "p1", "tasks", "t1", "runs", "r-invalid-memory"),
    projectId: "p1", taskId: "t1", id: "r-invalid-memory"
  };
  let approvalCalls = 0;
  host.toolPermissionService.authorize = async () => {
    approvalCalls += 1;
    return { allow: true };
  };
  host.aiRouter = makeFakeRouter([
    {
      text: "保存截止日期",
      toolCalls: [call("pin_memory", {
        type: "project",
        basis: "user-stated-noncode-context",
        topic: "deadline",
        name: "评审截止日期",
        description: "评审截止日期是下周五。",
        content: "评审截止日期是下周五。",
        valueBeyondCode: "来自团队安排。"
      })]
    },
    { text: "日期尚未绝对化，因此没有写入长期记忆。" }
  ]);

  await executeAgent(host, state, { id: "invalid-memory", maxToolRounds: 3 }, {}, ["pin_memory"]);

  assert.equal(approvalCalls, 0);
  assert.match(JSON.stringify(host.aiRouter.invocations[1].messages), /MEMDIR_RELATIVE_DATE_REJECTED/);
  const scopedMemory = await host.projectService.memoryStore.forContext({
    workspaceRoot: host.projectService.getProjectDir("p1")
  });
  assert.deepEqual(await scopedMemory.list(), []);
  await rm(workspace, { recursive: true, force: true });
});

// ============================================================================
// Scenario 2: plan 规划 step
// ============================================================================

test("[scenario 2] plan step:search_reference + pin_memory + write_todo", async () => {
  const { host, workspace } = await makeIntegrationHost({});
  const state = {
    runDir: path.join(workspace, "projects", "p1", "tasks", "t1", "runs", "r1"),
    projectId: "p1", taskId: "t1", id: "r1"
  };
  await mkdir(state.runDir, { recursive: true });
  host.aiRouter = makeFakeRouter([
    { text: "查资料", toolCalls: [call("search_reference", { query: "Node.js 缓存键最佳实践" })] },
    {
      text: "记关键设定",
      toolCalls: [call("pin_memory", {
        type: "project",
        basis: "user-stated-noncode-context",
        topic: "performance-review",
        name: "性能评审目标",
        description: "性能优化验收目标是 P95 低于 200ms，评审日期为 2026-08-21。",
        content: "性能优化验收目标是 P95 低于 200ms，评审日期为 2026-08-21。",
        valueBeyondCode: "验收目标与评审日期来自团队约定，无法从代码推导。"
      })]
    },
    {
      text: "登记 todo",
      toolCalls: [call("write_todo", { action: "create", text: "补充缓存键回归测试", priority: "high" })]
    },
    { text: "实施计划完成" }
  ]);

  const step = {
    id: "implementation-plan",
    taskType: "plan",
    tools: ["search_reference", "pin_memory", "write_todo"],
    maxToolRounds: 5
  };
  const toolNames = host._resolveAgentTools(step.tools);
  assert.ok(toolNames.includes("search_reference"));
  assert.ok(toolNames.includes("pin_memory"));
  assert.ok(toolNames.includes("write_todo"));

  await executeAgent(host, state, step, {}, toolNames);
  assert.equal(step.toolTrace.memoryWritePerformed, true);

  // 验证 pin_memory 只在当前项目的 canonical Memdir 落一个主题。
  const scopedMemory = await host.projectService.memoryStore.forContext({
    workspaceRoot: host.projectService.getProjectDir("p1")
  });
  const memories = await scopedMemory.search({ files: ["project-performance-review.md"] });
  assert.equal(memories.length, 1);
  assert.match(memories[0].content, /P95 低于 200ms/);

  // 验证 todo 落
  const todoDir = path.join(host.projectService.getTaskDir("p1", "t1"), "agent-state");
  const todos = await host.todoStore.list(todoDir);
  assert.equal(todos.length, 1);
  assert.equal(todos[0].priority, "high");

  await rm(workspace, { recursive: true, force: true });
});

// ============================================================================
// Scenario 3: review 评估 step
// ============================================================================

test("[scenario 3] review step:read_artifact + llm_judge_quality", async () => {
  const { host, workspace } = await makeIntegrationHost({});
  const state = {
    runDir: path.join(workspace, "projects", "p1", "tasks", "t1", "runs", "r1"),
    projectId: "p1", taskId: "t1", id: "r1"
  };
  // seed 一份待评 artifact
  await host.artifactStore.saveTextArtifact({
    projectId: "p1", taskId: "t1", runId: "r1", stepId: "step-draft-3",
    artifactType: "draft", title: "第三章待评",
    content: "主角喝威士忌。\n\n窗外的雨像鼓点。\n\n他想起了童年。"
  });
  host.aiRouter = makeFakeRouter([
    {
      text: "读 artifact",
      toolCalls: [call("read_artifact", { runId: "r1", stepId: "step-draft-3", artifactType: "draft" })]
    },
    {
      text: "判官评估",
      toolCalls: [call("llm_judge_quality", {
        text: "主角喝威士忌。窗外的雨像鼓点。他想起了童年。",
        dimensions: ["information_density", "contextual_plausibility"]
      })]
    },
    // judge 工具内部调用 aiRouter.runTask。
    {
      text: JSON.stringify({
        scores: { information_density: 4, contextual_plausibility: 5 },
        findings: [
          { dimension: "information_density", severity: "high", note: "信息密度低", evidence: "他想起了童年。" }
        ],
        summary: "节奏拖,需要具体感官"
      })
    },
    // Agent 收到 judge 结果后自然结束
    { text: "评审完成:judge findings 已记录,建议重写第 3 段。" }
  ]);

  const step = { id: "review-step", taskType: "review", tools: [
    "read_artifact", "llm_judge_quality"
  ] };
  const text = await executeAgent(host, state, step, {}, step.tools);

  assert.match(text, /评审完成/);

  // trace 只保留安全引用与摘要，不落盘 judge 正文。
  const traceFile = path.join(state.runDir, "steps", "review-step", "tool-trace.jsonl");
  const traceRow = JSON.parse((await readFile(traceFile, "utf8")).trim());
  const judgeCall = traceRow.toolCalls.find((c) => c.name === "llm_judge_quality");
  assert.ok(judgeCall && judgeCall.ok);
  assert.match(judgeCall.resultRef, /^ctxr_[a-f0-9]{64}$/);
  assert.match(judgeCall.resultDigest, /^[a-f0-9]{64}$/);
  assert.equal("valuePreview" in judgeCall, false);
  assert.equal("error" in judgeCall, false);

  await rm(workspace, { recursive: true, force: true });
});

// ============================================================================
// Scenario 4: spawn 委派 + 子 agent 内部工具序列
// ============================================================================

test("[scenario 4] spawn 委派:主 agent → 子 agent 内部调 search/read → 返回 finalText", async () => {
  const { host, workspace } = await makeIntegrationHost({});
  const state = {
    runDir: path.join(workspace, "projects", "p1", "tasks", "t1", "runs", "r1"),
    projectId: "p1", taskId: "t1", id: "r1"
  };
  // seed 一份 artifact 给子 agent 用
  await host.artifactStore.saveTextArtifact({
    projectId: "p1", taskId: "t1", runId: "r1", stepId: "step-1",
    artifactType: "step-output", title: "缓存观测",
    content: "重复请求的 prompt 前缀不稳定，缓存命中率为零。"
  });
  host.aiRouter = makeFakeRouter([
    // 主 agent 发起 spawn
    {
      text: "委派给子 agent",
      toolCalls: [call("spawn_subagent", {
        purpose: "独立核验缓存诊断",
        prompt: "读取已有观测，判断零缓存命中的最可能原因，并给出一条可验证结论。",
        maxRounds: 3
      })]
    },
    // 子 agent 第一轮:search 历史产物
    {
      text: "搜缓存观测",
      toolCalls: [call("search_run_artifacts", { query: "缓存" })]
    },
    // 子 agent 第二轮:read 精读
    {
      text: "读取观测",
      toolCalls: [call("read_artifact", { runId: "r1", stepId: "step-1", artifactType: "step-output" })]
    },
    // 子任务自然结束并把结果返回父任务
    { text: "核验结论：缓存键应在拼接动态上下文前生成。" },
    // 父任务在原循环中自然结束
    { text: "委派核验完成：缓存键应在拼接动态上下文前生成。" }
  ]);

  const step = { id: "step-main-orchestrator", taskType: "agent", tools: ["spawn_subagent"] };
  const text = await executeAgent(host, state, step, {}, step.tools);

  assert.match(text, /委派核验完成/);

  // 验证 spawn trace 落到 runs/<runId>/spawns/<spawnId>/
  const spawnsDir = path.join(state.runDir, "spawns");
  const spawnIds = await readdir(spawnsDir);
  assert.equal(spawnIds.length, 1);
  const spawnId = spawnIds[0];
  assert.match(spawnId, /^spawn_[a-f0-9]+$/);

  assert.equal(existsSync(path.join(spawnsDir, spawnId, "output.md")), false);

  // 验证 trace.jsonl
  const traceContent = await readFile(path.join(spawnsDir, spawnId, "trace.jsonl"), "utf8");
  const trace = JSON.parse(traceContent.trim());
  assert.equal(trace.spawnedByStepId, "step-main-orchestrator");
  assert.match(trace.purposeDigest, /^[a-f0-9]{64}$/);
  assert.match(trace.promptDigest, /^[a-f0-9]{64}$/);
  assert.match(trace.resultDigest, /^[a-f0-9]{64}$/);
  assert.equal("purpose" in trace, false);
  assert.equal("prompt" in trace, false);
  // canonical Agent 没有 historical handoffDir，子 Agent 不应看到 recall_handoff。
  assert.ok(!trace.allowedTools.includes("spawn_subagent"), "子 agent allowedTools 不能含 spawn(防递归)");
  assert.ok(!trace.allowedTools.includes("recall_handoff"));
  assert.ok(trace.allowedTools.includes("search_run_artifacts"));
  assert.ok(trace.allowedTools.includes("read_artifact"));
  // 子 agent 调了 2 个工具
  const subToolNames = trace.toolCalls.map((tc) => tc.name);
  assert.deepEqual(subToolNames, ["search_run_artifacts", "read_artifact"]);
  assert.ok(trace.toolCalls.every((tc) => tc.ok), "子 agent 内部工具调用都应成功");

  await rm(workspace, { recursive: true, force: true });
});
