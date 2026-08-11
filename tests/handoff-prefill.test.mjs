import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { WorkflowEngine } = require("../src/application/workflows/workflowEngine");

function makeEngine({ accumulated = null, throwOnLoad = false } = {}) {
  const engine = Object.create(WorkflowEngine.prototype);
  engine.checkpointStore = {
    loadAccumulatedState: async () => {
      if (throwOnLoad) throw new Error("checkpoint corrupt");
      return accumulated;
    }
  };
  return engine;
}

test("T4: composeStepHandoffPrefill checkpointStore 缺失 → 返回空字符串", async () => {
  const engine = Object.create(WorkflowEngine.prototype);
  engine.checkpointStore = null;
  const out = await engine.composeStepHandoffPrefill({ runDir: "/tmp/x" });
  assert.equal(out, "");
});
test("T4: runDir 缺失 → 返回空字符串", async () => {
  const engine = makeEngine({ accumulated: { decisions: ["x"] } });
  const out = await engine.composeStepHandoffPrefill({});
  assert.equal(out, "");
});

test("T4: loadAccumulatedState 抛错 → 静默返回空字符串", async () => {
  const engine = makeEngine({ throwOnLoad: true });
  const out = await engine.composeStepHandoffPrefill({ runDir: "/tmp/x" });
  assert.equal(out, "");
});

test("T4: 空累积 → 返回空字符串（不污染 input）", async () => {
  const engine = makeEngine({
    accumulated: { decisions: [], rejected: [], openQuestions: [], facts: [] }
  });
  const out = await engine.composeStepHandoffPrefill({ runDir: "/tmp/x" });
  assert.equal(out, "");
});

test("T4: 含 decisions/facts → 渲染为 handoff_state XML 块", async () => {
  const engine = makeEngine({
    accumulated: {
      decisions: ["主角 POV 第一人称", "本章 8 个 beat"],
      rejected: ["不采用倒叙开场"],
      openQuestions: ["女主姓名是否第一章揭晓"],
      facts: ["故事发生在 2026 年", "城市为虚构平远"]
    }
  });
  const out = await engine.composeStepHandoffPrefill({ runDir: "/tmp/x" });
  assert.match(out, /<handoff_state>/);
  assert.match(out, /<decisions>/);
  assert.match(out, /<rejected>/);
  assert.match(out, /<open_questions>/);
  assert.match(out, /<facts>/);
  assert.match(out, /主角 POV 第一人称/);
  assert.match(out, /城市为虚构平远/);
});

test("T4: 各类条目按上限截断（decisions 12 / rejected 8）", async () => {
  const decisions = Array.from({ length: 20 }, (_, i) => `决定${i}`);
  const rejected = Array.from({ length: 15 }, (_, i) => `否决${i}`);
  const engine = makeEngine({
    accumulated: { decisions, rejected, openQuestions: [], facts: [] }
  });
  const out = await engine.composeStepHandoffPrefill({ runDir: "/tmp/x" });
  // decisions 应该最多 12 条
  assert.equal((out.match(/决定/g) || []).length, 12);
  // rejected 最多 8 条
  assert.equal((out.match(/否决/g) || []).length, 8);
});

test("T4: 条目内含 <>& 等 XML 危险字符被剥离", async () => {
  const engine = makeEngine({
    accumulated: {
      decisions: ["A < B & C > D"],
      rejected: [],
      openQuestions: [],
      facts: []
    }
  });
  const out = await engine.composeStepHandoffPrefill({ runDir: "/tmp/x" });
  assert.doesNotMatch(out, /<\s*B/, "不应留下裸 < 字符");
  assert.match(out, /A  B  C  D/);
});
