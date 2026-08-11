import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  judgeContentQuality,
  parseJudgeResult,
  aggregateSamples,
  scoreToSeverity,
  DEFAULT_DIMENSIONS
} = require("../src/platform/ai/judges/contentQualityJudge.js");
const {
  createBaseToolRegistry,
  llmJudgeQualityTool,
  DEFAULT_SUBAGENT_TOOL_NAMES
} = require("../src/platform/ai/agentTools/index.js");

function makeFakeRouter(scripts = []) {
  let i = 0;
  return {
    invocations: [],
    async runTask(args) {
      this.invocations.push(args);
      const script = scripts[i] || scripts[scripts.length - 1] || "";
      i += 1;
      return script;
    }
  };
}

// ============ scoreToSeverity ============

test("scoreToSeverity:≤4=high, 5-6=medium, ≥7=null", () => {
  assert.equal(scoreToSeverity(0), "high");
  assert.equal(scoreToSeverity(3), "high");
  assert.equal(scoreToSeverity(4), "high");
  assert.equal(scoreToSeverity(5), "medium");
  assert.equal(scoreToSeverity(6), "medium");
  assert.equal(scoreToSeverity(7), null);
  assert.equal(scoreToSeverity(10), null);
  assert.equal(scoreToSeverity("not a number"), null);
});

// ============ parseJudgeResult ============

test("parseJudgeResult 正常解析多维质量 findings", () => {
  const raw = JSON.stringify({
    scores: { information_density: 3, voice_consistency: 7, contextual_plausibility: 5, progression: 8, audience_impact: 4 },
    findings: [
      { dimension: "information_density", severity: "high", note: "信息重复", evidence: "系统支持 A,系统支持 A,系统支持 A..." },
      { dimension: "contextual_plausibility", severity: "medium", note: "建议不符合约束", evidence: "直接连接公网数据库。" }
    ],
    summary: "信息重复且建议不符合约束"
  });
  const r = parseJudgeResult(raw, DEFAULT_DIMENSIONS, "系统支持 A,系统支持 A,系统支持 A...\n直接连接公网数据库。");
  assert.equal(r._parseFailed, false);
  // scores 钳到 [0, 10] 并保留
  assert.equal(r.scores.information_density, 3);
  assert.equal(r.scores.voice_consistency, 7);
  // findings ruleId 含 judge.<dimension>，severity 使用 high|medium。
  const information_densityFind = r.findings.find((f) => f.dimension === "information_density");
  assert.equal(information_densityFind.ruleId, "judge.information_density");
  assert.equal(information_densityFind.severity, "high");
  assert.equal(information_densityFind.category, "subjective");
  assert.ok(information_densityFind.evidence.length === 1);
});

test("parseJudgeResult 低分但没有逐字证据时不制造 finding", () => {
  const raw = JSON.stringify({
    scores: { information_density: 8, voice_consistency: 8, contextual_plausibility: 8, progression: 8, audience_impact: 2 },
    findings: [],
    summary: "ok"
  });
  const r = parseJudgeResult(raw, DEFAULT_DIMENSIONS, "y");
  assert.equal(r.findings.length, 0, "没有原文 evidence 时不能生成不可核验的问题");
});

test("parseJudgeResult ≥7 分维度不进 findings", () => {
  const raw = JSON.stringify({
    scores: { information_density: 8, voice_consistency: 9, contextual_plausibility: 7, progression: 10, audience_impact: 8 },
    findings: [],
    summary: "优秀"
  });
  const r = parseJudgeResult(raw, DEFAULT_DIMENSIONS, "y");
  assert.equal(r.findings.length, 0, "全 ≥7 分不应自动补 finding");
});

test("parseJudgeResult JSON 解析失败兜底", () => {
  const r = parseJudgeResult("这不是 JSON,LLM 没遵守指令", DEFAULT_DIMENSIONS);
  assert.equal(r._parseFailed, true);
  assert.deepEqual(r.findings, []);
  assert.deepEqual(r.scores, {});
});

test("parseJudgeResult 非法 severity 按 score 兜底", () => {
  const raw = JSON.stringify({
    scores: { information_density: 3 },
    findings: [{ dimension: "information_density", severity: "critical", note: "x", evidence: "y" }],
    summary: ""
  });
  const r = parseJudgeResult(raw, DEFAULT_DIMENSIONS, "y");
  // critical 不在 [high, medium];score=3 → high
  const f = r.findings.find((x) => x.dimension === "information_density");
  assert.equal(f.severity, "high");
});

// ============ aggregateSamples ============

test("aggregateSamples 多采样 scores 取平均", () => {
  const samples = [
    { scores: { information_density: 4, progression: 6 }, findings: [], summary: "" },
    { scores: { information_density: 6, progression: 8 }, findings: [], summary: "" }
  ];
  const r = aggregateSamples(samples);
  assert.equal(r.scores.information_density, 5);
  assert.equal(r.scores.progression, 7);
  assert.equal(r.samples, 2);
});

test("aggregateSamples findings 按 dimension 去重取最严", () => {
  const samples = [
    { scores: {}, findings: [{ dimension: "information_density", severity: "medium", ruleId: "judge.information_density", note: "a", evidence: [] }] },
    { scores: {}, findings: [{ dimension: "information_density", severity: "high", ruleId: "judge.information_density", note: "b", evidence: [] }] }
  ];
  const r = aggregateSamples(samples);
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].severity, "high", "同 dimension 取最严的 severity");
});

test("aggregateSamples 单样本直接返回(samples=1 优化)", () => {
  const single = { scores: { information_density: 5 }, findings: [], summary: "x" };
  const r = aggregateSamples([single]);
  assert.equal(r.scores.information_density, 5);
  assert.equal(r.samples, 1);
});

// ============ judgeContentQuality(端到端 + stub router) ============

test("judgeContentQuality 缺 aiRouter 抛错", async () => {
  await assert.rejects(() => judgeContentQuality({ text: "x" }), /aiRouter/);
});

test("judgeContentQuality 空 text 返回 modelInvocations=0", async () => {
  const router = makeFakeRouter([""]);
  const r = await judgeContentQuality({ aiRouter: router, text: "  " });
  assert.equal(r.modelInvocations, 0);
  assert.equal(router.invocations.length, 0);
});

test("judgeContentQuality 单采样默认维度", async () => {
  const router = makeFakeRouter([JSON.stringify({
    scores: { information_density: 5, voice_consistency: 7, contextual_plausibility: 6, progression: 5, audience_impact: 4 },
    findings: [
      { dimension: "audience_impact", severity: "high", note: "关键结论不突出", evidence: "片段..." }
    ],
    summary: "重点不清"
  })]);
  const r = await judgeContentQuality({ aiRouter: router, text: "一份需要评估的交付样本，片段..." });
  assert.equal(r.modelInvocations, 1);
  assert.equal(r.samples, 1);
  assert.ok(r.scores.information_density >= 0);
  assert.ok(r.findings.some((f) => f.dimension === "audience_impact"));
  // 路由配置正确
  const args = router.invocations[0];
  assert.equal(args.taskType, "review");
  assert.equal(args.jsonMode, true);
  assert.equal(args.contextProfile, "minimal");
  assert.equal(args.internalCall, true);
});

test("judgeContentQuality samples=3 调用 3 次 + 聚合", async () => {
  const router = makeFakeRouter([
    JSON.stringify({ scores: { information_density: 4 }, findings: [], summary: "" }),
    JSON.stringify({ scores: { information_density: 6 }, findings: [], summary: "" }),
    JSON.stringify({ scores: { information_density: 5 }, findings: [], summary: "" })
  ]);
  const r = await judgeContentQuality({ aiRouter: router, text: "x", dimensions: ["information_density"], samples: 3 });
  assert.equal(r.modelInvocations, 3);
  assert.equal(r.samples, 3);
  assert.equal(r.scores.information_density, 5); // (4+6+5)/3 = 5
});

test("judgeContentQuality samples 钳到 [1, 5]", async () => {
  const router = makeFakeRouter([JSON.stringify({ scores: { information_density: 5 }, findings: [], summary: "" })]);
  await judgeContentQuality({ aiRouter: router, text: "x", samples: 999 });
  assert.equal(router.invocations.length, 5, "samples=999 应被钳到 5");
});

test("judgeContentQuality 非法 dimensions 过滤，空集回退默认通用维度", async () => {
  const router = makeFakeRouter([JSON.stringify({
    scores: Object.fromEntries(DEFAULT_DIMENSIONS.map((dimension) => [dimension, 5])),
    findings: [], summary: ""
  })]);
  const r = await judgeContentQuality({ aiRouter: router, text: "x", dimensions: ["nonsense"] });
  assert.equal(Object.keys(r.scores).length, DEFAULT_DIMENSIONS.length);
});

test("judgeContentQuality 提供验收要求时自动检查 requirement_coverage", async () => {
  const router = makeFakeRouter([JSON.stringify({
    scores: { requirement_coverage: 4 },
    findings: [{
      dimension: "requirement_coverage",
      severity: "high",
      note: "未覆盖要求",
      evidence: "必须给出三个来源"
    }],
    summary: "缺少来源"
  })]);
  const result = await judgeContentQuality({
    aiRouter: router,
    text: "正文",
    dimensions: ["specificity"],
    requirements: "必须给出三个来源"
  });
  assert.equal(result.scores.requirement_coverage, 4);
  assert.equal(result.findings[0].dimension, "requirement_coverage");
  assert.match(router.invocations[0].input, /必须给出三个来源/);
});

// ============ tool 包装 ============

test("llmJudgeQualityTool 在默认 registry 里;不在子 agent 默认工具集(成本控制)", () => {
  const reg = createBaseToolRegistry();
  assert.ok(reg.has("llm_judge_quality"));
  // 子 agent 不应默认拿 judge —— 每个子 agent 跑 judge 会成本爆炸,
  // 应由主 agent 显式委派"判官子 agent"。
  assert.ok(!DEFAULT_SUBAGENT_TOOL_NAMES.includes("llm_judge_quality"));
});

test("llmJudgeQualityTool 缺 ctx.aiRouter 报错", async () => {
  const r = await llmJudgeQualityTool.execute({ text: "x" }, {});
  assert.equal(r.ok, false);
  assert.match(r.error, /aiRouter/);
});

test("llmJudgeQualityTool 空 text 报错", async () => {
  const router = makeFakeRouter([""]);
  const r = await llmJudgeQualityTool.execute({ text: "  " }, { aiRouter: router });
  assert.equal(r.ok, false);
  assert.match(r.error, /text/);
});

test("llmJudgeQualityTool 端到端:返回 scores + findings + parseFailed flag", async () => {
  const router = makeFakeRouter([JSON.stringify({
    scores: { information_density: 3 },
    findings: [{ dimension: "information_density", severity: "high", note: "堆字", evidence: "片段" }],
    summary: "无聊"
  })]);
  const r = await llmJudgeQualityTool.execute(
    { text: "样本包含片段", dimensions: ["information_density"] },
    { aiRouter: router }
  );
  assert.equal(r.ok, true);
  assert.equal(r.scores.information_density, 3);
  assert.equal(r.findings[0].ruleId, "judge.information_density");
  assert.equal(r.parseFailed, false);
});

test("llmJudgeQualityTool JSON 解析失败时 parseFailed=true", async () => {
  const router = makeFakeRouter(["不是 JSON"]);
  const r = await llmJudgeQualityTool.execute(
    { text: "样本", dimensions: ["information_density"] },
    { aiRouter: router }
  );
  assert.equal(r.ok, true, "解析失败不应让工具 ok=false,而是 parseFailed=true 让 LLM 决定怎么用");
  assert.equal(r.parseFailed, true);
});
