import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const decisionActions = require("../src/application/workflows/mixins/decisionActions");

function makeEngine() {
  const emits = [];
  const engine = Object.create(decisionActions);
  engine.emitActivity = (payload) => emits.push(payload);
  engine.buildDecisionPreviewFromRun = async () => "";
  engine.buildDecisionArtifactRefFromRun = () => null;
  engine.appendDecisionToRunState = async () => {};
  engine.appendAgentMessage = async () => {};
  engine.listDecisionCards = async () => [];
  engine.runUntilBlocked = async () => ({ run: { status: "pending" } });
  engine.ensureRunArtifact = async () => null;
  engine.cleanupRunProcessFiles = async () => {};
  engine.writeRun = async () => {};
  engine.getRun = async () => ({});
  engine.buildWorkflowRunReply = () => ({ reply: "", decisionCards: [] });
  engine.projectService = {
    getTask: async () => ({ decisionCards: [] }),
    updateTask: async () => ({})
  };
  return { engine, emits };
}

function rawCard(overrides = {}) {
  return {
    type: "creative_fork",
    question: "测试问题",
    why: "测试理由",
    choices: [
      { id: "a", label: "选项A", description: "x", recommended: true },
      { id: "b", label: "选项B", description: "y" }
    ],
    ...overrides
  };
}

test("M1: normalizeDecisionCard 保留 emittedAt 字段（默认 null，序列化往返不丢）", () => {
  const { engine } = makeEngine();
  const normalized = engine.normalizeDecisionCard(rawCard());
  assert.ok(Object.prototype.hasOwnProperty.call(normalized, "emittedAt"), "schema 必须含 emittedAt 字段");
  assert.equal(normalized.emittedAt, null, "默认应为 null");
  // 既有值时不被覆盖
  const reparsed = engine.normalizeDecisionCard({ ...normalized, emittedAt: "2026-05-20T10:00:00.000Z" });
  assert.equal(reparsed.emittedAt, "2026-05-20T10:00:00.000Z");
});

test("未知 decision scope 归一为 task", () => {
  const { engine } = makeEngine();
  assert.equal(engine.normalizeDecisionCard(rawCard({ scope: "obsolete" })).scope, "task");
});

test("M1: addDecisionCardToRun emit 时给 card 写 emittedAt + emit payload 含字段", async () => {
  const { engine, emits } = makeEngine();
  const state = { id: "r1", projectId: "p1", taskId: "t1", decisionCards: [] };
  const before = Date.now();
  const card = await engine.addDecisionCardToRun(state, { id: "02-step", index: 1 }, rawCard());
  const after = Date.now();
  assert.ok(card.emittedAt, "card 必须有 emittedAt");
  const emittedMs = new Date(card.emittedAt).getTime();
  assert.ok(emittedMs >= before && emittedMs <= after, "emittedAt 应在 emit 期间");
  assert.equal(emits.length, 1);
  assert.equal(emits[0].emittedAt, card.emittedAt, "emit payload 应携带 emittedAt（trace 接 OTel/Langfuse）");
});

test("M1: addDecisionCardToTask 同样写 emittedAt", async () => {
  const { engine, emits } = makeEngine();
  const card = await engine.addDecisionCardToTask("p1", "t1", rawCard());
  assert.ok(card.emittedAt);
  assert.equal(emits[0].emittedAt, card.emittedAt);
});

test("M1: answerRunDecisionCard 用 emittedAt 当 userWaitMs 起点（不是 createdAt）", async () => {
  const { engine } = makeEngine();
  const createdAt = new Date(Date.now() - 60_000).toISOString(); // 60s 前创建
  const emittedAt = new Date(Date.now() - 30_000).toISOString(); // 30s 前 emit
  const card = engine.normalizeDecisionCard(rawCard());
  card.createdAt = createdAt;
  card.emittedAt = emittedAt;
  const state = { id: "r1", projectId: "p1", taskId: "t1", decisionCards: [card], steps: [] };
  const result = await engine.answerRunDecisionCard({ state, card, choiceId: "a" });
  assert.ok(result);
  const answeredCard = state.decisionCards[0];
  // userWaitMs ≈ 30s（emit 到 now），不是 60s（create 到 now）
  assert.ok(answeredCard.userWaitMs >= 29_000 && answeredCard.userWaitMs <= 32_000,
    `应基于 emittedAt 30s 计算，实际 ${answeredCard.userWaitMs}ms`);
});

test("M1: 老 card 没 emittedAt 字段 → fallback 到 createdAt（向后兼容）", async () => {
  const { engine } = makeEngine();
  const createdAt = new Date(Date.now() - 45_000).toISOString();
  const card = engine.normalizeDecisionCard(rawCard());
  card.createdAt = createdAt;
  card.emittedAt = null; // 模拟旧版 run 加载出来的 card
  const state = { id: "r1", projectId: "p1", taskId: "t1", decisionCards: [card], steps: [] };
  await engine.answerRunDecisionCard({ state, card, choiceId: "a" });
  const answered = state.decisionCards[0];
  assert.ok(answered.userWaitMs >= 44_000 && answered.userWaitMs <= 47_000,
    `老 card 无 emittedAt 应 fallback 到 createdAt 45s，实际 ${answered.userWaitMs}ms`);
});

test("M1: totalUserWaitMs 多张卡累加（emittedAt 各自独立）", async () => {
  const { engine } = makeEngine();
  const state = { id: "r1", projectId: "p1", taskId: "t1", decisionCards: [], steps: [], totalUserWaitMs: 0 };
  // 第一张卡：emit 20s 前
  const card1 = engine.normalizeDecisionCard(rawCard({ choices: [
    { id: "a1", label: "选A", description: "x", recommended: true },
    { id: "b1", label: "选B", description: "y" }
  ] }));
  card1.emittedAt = new Date(Date.now() - 20_000).toISOString();
  state.decisionCards.push(card1);
  await engine.answerRunDecisionCard({ state, card: card1, choiceId: "a1" });
  // 第二张卡：emit 10s 前
  const card2 = engine.normalizeDecisionCard(rawCard({ choices: [
    { id: "a2", label: "选C", description: "x", recommended: true },
    { id: "b2", label: "选D", description: "y" }
  ] }));
  card2.emittedAt = new Date(Date.now() - 10_000).toISOString();
  state.decisionCards.push(card2);
  await engine.answerRunDecisionCard({ state, card: card2, choiceId: "a2" });
  // 两张合计 ≈ 30s
  assert.ok(state.totalUserWaitMs >= 28_000 && state.totalUserWaitMs <= 32_000,
    `两张卡累加应约 30s，实际 ${state.totalUserWaitMs}ms`);
});

test("N2: 多张 blocking run 决策卡只答一张时不提前续跑", async () => {
  const { engine } = makeEngine();
  let resumeCalls = 0;
  engine.runUntilBlocked = async () => {
    resumeCalls += 1;
    return { run: { status: "pending" } };
  };
  const card1 = engine.normalizeDecisionCard(rawCard({ id: "card-1", kind: "clarification" }));
  const card2 = engine.normalizeDecisionCard(rawCard({ id: "card-2", kind: "clarification" }));
  const state = {
    id: "r1",
    projectId: "p1",
    taskId: "t1",
    status: "blocked",
    decisionCards: [card1, card2],
    steps: []
  };

  const result = await engine.answerRunDecisionCard({ state, card: card1, choiceId: "a" });

  assert.equal(resumeCalls, 0);
  assert.equal(state.status, "blocked");
  assert.equal(state.decisionCards[0].status, "answered");
  assert.equal(state.decisionCards[1].status, "pending");
  assert.equal(result.runId, "r1");
});
