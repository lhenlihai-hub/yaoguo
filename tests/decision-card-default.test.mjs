import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { WorkflowEngine } = require("../src/application/workflows/workflowEngine.js");

test("宿主不根据题材或关键词自动生成执行决策卡", () => {
  const engine = Object.create(WorkflowEngine.prototype);
  assert.equal(engine.maybeCreateStepDecisionCard, undefined);
  assert.equal(engine.shouldConsiderStepDecision, undefined);
  assert.equal(engine.buildStepDecisionCardHeuristic, undefined);

  const lifecycle = readFileSync(new URL("../src/application/workflows/mixins/runLifecycleActions.js", import.meta.url), "utf8");
  assert.doesNotMatch(lifecycle, /maybeCreateStepDecisionCard/);
  assert.match(lifecycle, /pendingDecisionCards/);
});

test("决策卡基础设施仍支持 Agent 明确提出的结构化澄清", () => {
  const engine = Object.create(WorkflowEngine.prototype);
  const card = engine.normalizeDecisionCard({
    type: "clarify",
    question: "主色用哪一种？",
    why: "这会改变最终视觉结果。",
    choices: [
      { id: "red", label: "红色", description: "使用红色主色。", recommended: true },
      { id: "blue", label: "蓝色", description: "使用蓝色主色。" }
    ]
  });

  assert.equal(card.type, "clarify");
  assert.equal(card.choices.length, 2);
  assert.equal(card.choices.filter((choice) => choice.recommended).length, 1);
});
