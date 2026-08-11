import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { MemoryStore, TYPE_BASIS } = require("../src/platform/memory/memoryStore.js");
const {
  createBaseToolRegistry,
  searchMemoryTool,
  pinMemoryTool,
  DEFAULT_SUBAGENT_TOOL_NAMES
} = require("../src/platform/ai/agentTools/index.js");

function makeStore() {
  const workspaceRoot = mkdtempSync(path.join(tmpdir(), "memory-tools-"));
  return new MemoryStore({ workspaceRoot });
}

function payload(overrides = {}) {
  const type = overrides.type || "user";
  return {
    type,
    basis: TYPE_BASIS[type],
    topic: "collaboration-style",
    name: "协作方式",
    description: "用户偏好先给结论，再按需解释。",
    content: "用户偏好先给结论，再按需解释。",
    valueBeyondCode: "这是用户画像信息，代码无法推导。",
    ...overrides
  };
}

test("主 Agent 拥有 search_memory 与 pin_memory，子 Agent 只读", () => {
  const registry = createBaseToolRegistry();
  assert.ok(registry.has("search_memory"));
  assert.ok(registry.has("pin_memory"));
  assert.ok(DEFAULT_SUBAGENT_TOOL_NAMES.includes("search_memory"));
  assert.ok(!DEFAULT_SUBAGENT_TOOL_NAMES.includes("pin_memory"));
});

test("记忆工具 schema 只暴露四种类型，不暴露 scope 或 projectId", () => {
  const pinProperties = pinMemoryTool.schema.function.parameters.properties;
  const searchProperties = searchMemoryTool.schema.function.parameters.properties;
  assert.deepEqual(pinProperties.type.enum, ["user", "feedback", "project", "reference"]);
  assert.equal(pinProperties.scope, undefined);
  assert.equal(pinProperties.projectId, undefined);
  assert.equal(searchProperties.scope, undefined);
  assert.equal(searchProperties.projectId, undefined);
  assert.equal(searchProperties.tags, undefined);
  assert.match(pinMemoryTool.schema.function.description, /代码模式、架构分析、文件路径、Git 历史、调试方案/);
  assert.match(pinProperties.polarity.description, /positive/);
});

test("memory 工具缺少当前 scoped store 时明确失败", async () => {
  const search = await searchMemoryTool.execute({ query: "x" }, {});
  const pin = await pinMemoryTool.execute(payload(), {});
  assert.equal(search.ok, false);
  assert.match(search.error, /memoryStore/);
  assert.equal(pin.ok, false);
  assert.match(pin.error, /memoryStore/);
});

test("search_memory 必须由模型提供 query 或索引文件名", async () => {
  const result = await searchMemoryTool.execute({}, { memoryStore: makeStore() });
  assert.equal(result.ok, false);
  assert.match(result.error, /query 或 files/);
});

test("pin_memory 把模型的类型与主题决定写入 Markdown Memdir", async () => {
  const store = makeStore();
  const result = await pinMemoryTool.execute(payload(), {
    memoryStore: store,
    projectId: "宿主字段不会进入写入协议"
  });
  assert.equal(result.ok, true);
  assert.equal(result.memory.type, "user");
  assert.equal(result.memory.file, "user-collaboration-style.md");
  assert.equal(result.memory.description, "用户偏好先给结论，再按需解释。");
  assert.equal(pinMemoryTool.schema.function.parameters.properties.projectId, undefined);
});

test("pin_memory 同时支持正向与负向 feedback", async () => {
  const store = makeStore();
  const positive = await pinMemoryTool.execute(payload({
    type: "feedback", basis: TYPE_BASIS.feedback, topic: "review-method",
    name: "评审方法反馈", description: "用户确认有效与需要修正的 AI 评审方式。",
    content: "先给证据再给建议的方式很好。",
    valueBeyondCode: "用户确认了 AI 的成功行为。", polarity: "positive"
  }), { memoryStore: store });
  const negative = await pinMemoryTool.execute(payload({
    type: "feedback", basis: TYPE_BASIS.feedback, topic: "review-method",
    name: "评审方法反馈", description: "用户确认有效与需要修正的 AI 评审方式。",
    content: "不要在证据不足时推断根因。",
    valueBeyondCode: "用户纠正了 AI 行为。", polarity: "negative"
  }), { memoryStore: store });
  assert.equal(positive.ok, true);
  assert.equal(positive.memory.polarity, "positive");
  assert.equal(negative.ok, true);
  assert.equal(negative.memory.polarity, "negative");
});

test("pin_memory 将 basis、相对日期和 reference 边界错误返回给模型", async () => {
  const store = makeStore();
  const mismatch = await pinMemoryTool.execute(payload({ basis: TYPE_BASIS.project }), { memoryStore: store });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.code, "MEMDIR_BASIS_INVALID");

  const relative = await pinMemoryTool.execute(payload({
    type: "project", basis: TYPE_BASIS.project, topic: "deadline",
    content: "截止日期是下周五。"
  }), { memoryStore: store });
  assert.equal(relative.ok, false);
  assert.equal(relative.code, "MEMDIR_RELATIVE_DATE_REJECTED");

  const localReference = await pinMemoryTool.execute(payload({
    type: "reference", basis: TYPE_BASIS.reference, topic: "dashboard",
    reference: "/tmp/dashboard", content: "数据入口"
  }), { memoryStore: store });
  assert.equal(localReference.ok, false);
  assert.equal(localReference.code, "MEMDIR_REFERENCE_LOCAL_PATH");
});

test("search_memory 可按 query 相关性读取主题正文", async () => {
  const store = makeStore();
  await pinMemoryTool.execute(payload({
    type: "project", basis: TYPE_BASIS.project, topic: "board-report",
    name: "董事会报告约定", description: "董事会报告中的数字必须附来源。",
    content: "董事会报告中的数字必须附来源。",
    valueBeyondCode: "这是团队评审约定。"
  }), { memoryStore: store });
  await pinMemoryTool.execute(payload(), { memoryStore: store });

  const result = await searchMemoryTool.execute({ query: "董事会 数字来源" }, { memoryStore: store });
  assert.equal(result.ok, true);
  assert.ok(result.total >= 1);
  assert.equal(result.memories[0].file, "project-board-report.md");
  assert.match(result.memories[0].content, /数字必须附来源/);
  assert.match(result.memories[0].age, /^(?:今天|昨天|\d+ 天前|时间未知)$/);
  assert.equal(typeof result.memories[0].freshnessWarning, "string");
  assert.equal("scope" in result.memories[0], false);
});

test("search_memory 可按 memory.md 中的文件名精确加载，并将 limit 钳到 12", async () => {
  let received = null;
  const memoryStore = {
    async search(options) {
      received = options;
      return [{
        id: "topic_1", type: "user", file: "user-profile.md", name: "用户画像",
        description: "摘要", content: "正文", createdAt: null, updatedAt: null
      }];
    }
  };
  const result = await searchMemoryTool.execute({
    files: ["user-profile.md"], types: ["user"], limit: 999,
    projectId: "模型不能选择另一个项目"
  }, { memoryStore, projectId: "current" });
  assert.equal(result.ok, true);
  assert.deepEqual(received, {
    query: "",
    types: ["user"],
    files: ["user-profile.md"],
    limit: 12
  });
});

test("pin_memory 不把模型伪造的 projectId、scope 或 tags 传给 scoped store", async () => {
  let received = null;
  const memoryStore = {
    async append(options) {
      received = options;
      return {
        id: "mem_1", type: options.type, file: "user-collaboration-style.md",
        name: options.name, description: options.description, polarity: null,
        reference: null, createdAt: "2026-08-09T00:00:00.000Z", deduplicated: false
      };
    }
  };
  const result = await pinMemoryTool.execute({
    ...payload(), projectId: "other", scope: "global", tags: ["pinned"]
  }, { memoryStore, projectId: "current" });
  assert.equal(result.ok, true);
  assert.equal(received.projectId, undefined);
  assert.equal(received.scope, undefined);
  assert.equal(received.tags, undefined);
});
