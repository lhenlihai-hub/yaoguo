import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { WorkflowEngine } = require("../src/application/workflows/workflowEngine.js");

function stripExecutionIdentity(text = "") {
  return text.replace(
    /\n\n【当前执行状态】\n[\s\S]*?(?=\n\n【当前已发布成品】|\n\n【任务引用资料】|\n\n【已固定长期记忆】|\n\n【项目记忆与参考锚】|\n\n【任务历史】|$)/,
    ""
  );
}

test("直接输入与 agent-default 使用同一套任务上下文，只允许运行身份不同", async () => {
  const calls = { references: 0 };
  const engine = Object.create(WorkflowEngine.prototype);
  engine.projectService = {
    getProject: async () => ({ id: "p1", name: "季度经营" }),
    getTask: async () => ({ id: "t1", title: "董事会报告", brief: "保留三组对比数据" }),
    getTaskDir: () => "/tmp/yaoguo-agent-context-parity",
    listReferences: async () => {
      calls.references += 1;
      return [{ title: "财报", url: "https://example.com/report", snippet: "经过核验的季度数据" }];
    },
    bundleReferences: async () => {
      throw new Error("canonical Agent 不应调用旧 bundleReferences");
    }
  };
  engine.loadLatestDeliverable = async () => null;
  engine.buildAgentHistoryContext = async () => "上一轮用户要求保留三组对比数据。";

  const common = {
    projectId: "p1",
    taskId: "t1",
    turnId: "turn-current",
    message: "本轮唯一消息"
  };
  const direct = await engine.buildAgentContext(common);
  const workflow = await engine.buildAgentContext({
    ...common,
    runId: "r1",
    state: {
      id: "r1",
      projectId: "p1",
      taskId: "t1",
      workflowId: "agent-default",
      workflowName: "通用 Agent"
    },
    step: { id: "01-agent-delivery", taskType: "agent" }
  });

  assert.equal(stripExecutionIdentity(workflow), direct);
  assert.doesNotMatch(direct, /【项目记忆与参考锚】|【已固定长期记忆】/);
  assert.doesNotMatch(workflow, /【项目记忆与参考锚】|【已固定长期记忆】/);
  assert.match(direct, /【任务引用资料】/);
  assert.doesNotMatch(direct, /【任务历史】/);
  assert.match(direct, /宿主不预设发布数量或上限/);
  assert.doesNotMatch(direct, /只发布 1 个|最多 4 个/);
  assert.doesNotMatch(direct, /本轮唯一消息/);
  assert.doesNotMatch(workflow, /本轮唯一消息/);
  assert.equal(calls.references, 2);
});

test("旧 taskType 只进入显式历史兼容上下文，canonical Agent 不进入", async () => {
  const engine = Object.create(WorkflowEngine.prototype);
  let historicalCalls = 0;
  engine.buildHistoricalRunContext = async () => {
    historicalCalls += 1;
    return "历史多步骤上下文";
  };

  const canonical = await engine.buildRunContext(
    { id: "r-agent", workflowName: "通用 Agent" },
    { taskType: "agent" }
  );
  const historical = await engine.buildRunContext(
    { id: "r-old", workflowName: "旧工作流" },
    { taskType: "revise" }
  );

  assert.match(canonical, /运行 ID：r-agent/);
  assert.doesNotMatch(canonical, /历史多步骤上下文/);
  assert.equal(historical, "历史多步骤上下文");
  assert.equal(historicalCalls, 1);
});

test("任务历史保留原生 user/assistant 顺序，并排除当前输入", async () => {
  const engine = Object.create(WorkflowEngine.prototype);
  engine.settingsService = { get: async () => ({ context: { agentHistory: { tokens: 4000 } } }) };
  engine.listAgentMessageWindow = async () => ({
    total: 3,
    rows: [
      { role: "user", turnId: "old", content: "历史问题" },
      { role: "assistant", turnId: "old", content: "历史回答" },
      { role: "user", turnId: "current", content: "当前输入" }
    ]
  });
  assert.deepEqual(await engine.buildAgentConversationMessages({
    projectId: "p1", taskId: "t1", currentTurnId: "current", currentMessage: "当前输入"
  }), [
    { role: "user", content: "历史问题" },
    { role: "assistant", content: "历史回答" }
  ]);
});

test("任务历史优先回放上一轮真实模型输入，保持跨轮缓存前缀", async () => {
  const engine = Object.create(WorkflowEngine.prototype);
  engine.settingsService = { get: async () => ({ context: { agentHistory: { tokens: 4000 } } }) };
  engine.listAgentMessageWindow = async () => ({
    total: 3,
    rows: [
      { role: "user", turnId: "old", content: "历史问题" },
      {
        role: "assistant", turnId: "old", content: "历史回答",
        modelInputRef: { sha256: "a".repeat(64) }
      },
      { role: "user", turnId: "current", content: "当前输入" }
    ]
  });
  engine.taskSessionStore = {
    readContentBodyRef: async () => "【本轮上下文】\n旧上下文\n\n【当前步骤】腰果 Agent（agent）\n\n【输入】\n历史问题"
  };
  assert.deepEqual(await engine.buildAgentConversationMessages({
    projectId: "p1", taskId: "t1", currentTurnId: "current", currentMessage: "当前输入"
  }), [
    {
      role: "user",
      content: "【本轮上下文】\n旧上下文\n\n【当前步骤】腰果 Agent（agent）\n\n【输入】\n历史问题",
      modelReady: true
    },
    { role: "assistant", content: "历史回答" }
  ]);
});
