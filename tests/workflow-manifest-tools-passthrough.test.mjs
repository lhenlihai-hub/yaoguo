import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  canonicalTaskType,
  migrateWorkflowTaskTypes,
  normalizeWorkflowManifest
} = require("../src/platform/workflows/workflowManifest.js");

test("退役 deAI taskType 在工作流加载时迁移为 revise", () => {
  assert.equal(canonicalTaskType("deAI"), "revise");
  const migrated = migrateWorkflowTaskTypes({
    id: "legacy",
    steps: [{ id: "clean", taskType: "deAI", subAgentTaskType: "deAI" }]
  });
  assert.equal(migrated.steps[0].taskType, "revise");
  assert.equal(migrated.steps[0].subAgentTaskType, "revise");
  assert.equal(normalizeWorkflowManifest(migrated).steps[0].taskType, "revise");
});

// ============ tools 字段透传 ============

test("normalizeWorkflowManifest: 退役的 step.tools='auto' 不再进入运行清单", () => {
  const wf = {
    id: "test", kind: "workflow",
    steps: [{ id: "s1", taskType: "draft", tools: "auto" }]
  };
  const r = normalizeWorkflowManifest(wf);
  assert.equal(r.steps[0].tools, undefined);
});

test("normalizeWorkflowManifest: 通用 Agent 工具目录显式透传", () => {
  const wf = {
    id: "test", kind: "workflow",
    steps: [{ id: "s1", taskType: "agent", tools: "agent" }]
  };
  const r = normalizeWorkflowManifest(wf);
  assert.equal(r.steps[0].tools, "agent");
});

test("normalizeWorkflowManifest: step.tools 数组透传保留", () => {
  const wf = {
    id: "test", kind: "workflow",
    steps: [{ id: "s1", taskType: "draft", tools: ["recall_handoff", "search_run_artifacts"] }]
  };
  const r = normalizeWorkflowManifest(wf);
  assert.deepEqual(r.steps[0].tools, ["recall_handoff", "search_run_artifacts"]);
});

test("normalizeWorkflowManifest: step.tools 数组中空串/非字符串被过滤", () => {
  const wf = {
    id: "test", kind: "workflow",
    steps: [{ id: "s1", taskType: "draft", tools: ["recall_handoff", "", null, "search_memory", 42] }]
  };
  const r = normalizeWorkflowManifest(wf);
  assert.deepEqual(r.steps[0].tools, ["recall_handoff", "search_memory"]);
});

test("normalizeWorkflowManifest: step.tools 空数组 → 不留 tools 字段", () => {
  const wf = {
    id: "test", kind: "workflow",
    steps: [{ id: "s1", taskType: "draft", tools: [] }]
  };
  const r = normalizeWorkflowManifest(wf);
  assert.equal(r.steps[0].tools, undefined, "空数组应被过滤,step 上不留 tools 字段");
});

test("normalizeWorkflowManifest: step.tools 非法值(null/'false'/数字)不留字段", () => {
  for (const tools of [null, undefined, "false", 42, {}]) {
    const wf = {
      id: "test", kind: "workflow",
      steps: [{ id: "s1", taskType: "draft", tools }]
    };
    const r = normalizeWorkflowManifest(wf);
    assert.equal(r.steps[0].tools, undefined, `tools=${JSON.stringify(tools)} 应被过滤`);
  }
});

// ============ maxToolRounds 字段透传 ============

test("normalizeWorkflowManifest: step.maxToolRounds 正整数透传", () => {
  const wf = {
    id: "test", kind: "workflow",
    steps: [{ id: "s1", taskType: "draft", tools: "auto", maxToolRounds: 6 }]
  };
  const r = normalizeWorkflowManifest(wf);
  assert.equal(r.steps[0].maxToolRounds, 6);
});

test("normalizeWorkflowManifest: step.maxToolRounds 非正数 / 字符串 / null 不留字段", () => {
  for (const value of [0, -1, "5", null, undefined, NaN]) {
    const wf = {
      id: "test", kind: "workflow",
      steps: [{ id: "s1", taskType: "draft", maxToolRounds: value }]
    };
    const r = normalizeWorkflowManifest(wf);
    assert.equal(r.steps[0].maxToolRounds, undefined, `maxToolRounds=${value} 应被过滤`);
  }
});

test("normalizeWorkflowManifest: step.maxToolRounds 浮点数被 floor", () => {
  const wf = {
    id: "test", kind: "workflow",
    steps: [{ id: "s1", taskType: "draft", maxToolRounds: 6.8 }]
  };
  const r = normalizeWorkflowManifest(wf);
  assert.equal(r.steps[0].maxToolRounds, 6);
});

// ============ subAgentTaskType 透传 ============

test("normalizeWorkflowManifest: step.subAgentTaskType 字符串透传(trim)", () => {
  const wf = {
    id: "test", kind: "workflow",
    steps: [{ id: "s1", taskType: "draft", subAgentTaskType: "  draft  " }]
  };
  const r = normalizeWorkflowManifest(wf);
  assert.equal(r.steps[0].subAgentTaskType, "draft");
});

test("normalizeWorkflowManifest: step.subAgentTaskType 空白 / 非字符串不留", () => {
  for (const value of ["", "   ", null, 42, {}, undefined]) {
    const wf = {
      id: "test", kind: "workflow",
      steps: [{ id: "s1", taskType: "draft", subAgentTaskType: value }]
    };
    const r = normalizeWorkflowManifest(wf);
    assert.equal(r.steps[0].subAgentTaskType, undefined);
  }
});

// ============ 与原 white-list 字段共存 ============

test("normalizeWorkflowManifest: tools 字段与 policy/promptRef 等同时透传(不互相吃)", () => {
  const wf = {
    id: "test", kind: "workflow",
    steps: [{
      id: "s1", taskType: "draft", kind: "ai",
      tools: "auto", maxToolRounds: 5,
      promptRef: "block://draft.v1", policy: { retries: 2 }
    }]
  };
  const r = normalizeWorkflowManifest(wf);
  assert.equal(r.steps[0].tools, undefined);
  assert.equal(r.steps[0].maxToolRounds, 5);
  assert.equal(r.steps[0].promptRef, "block://draft.v1");
  assert.deepEqual(r.steps[0].policy, { retries: 2 });
});

// ============ workflow JSON 真实数据 round-trip ============

test("agent-default: 唯一步骤就是可对话、可执行的 Agent", async () => {
  const { readFile } = await import("node:fs/promises");
  const path = (await import("node:path")).default;
  const root = process.cwd();
  const file = path.join(root, "workspace/workflows/agent-default.json");
  const raw = JSON.parse(await readFile(file, "utf8"));
  const agent = raw.steps.find((s) => s.id === "01-agent-delivery");
  assert.equal(agent?.taskType, "agent");
  assert.equal(agent?.tools, "agent");
  assert.equal(agent?.maxToolRounds, undefined);
  assert.equal(agent?.contextNeeds, undefined);
  assert.equal(raw.steps.length, 1);
  assert.equal(raw.steps[0], agent);
  assert.equal("finalSourceStepId" in agent, false);
});
