// @ts-check
// contentQualityJudge —— 主观维度的 LLM-as-judge。
//
// 业界对标 2025-2026:
//   - G-Eval(NLP eval 经典框架):chain-of-thought + form-filling 多维度评分
//   - DeepEval:每个 metric 独立 judge,产 score + reasoning + evidence
//   - Anthropic constitutional AI / Claude code review:"你是评估者，不是执行者"系统 prompt;
//     XML 结构化输入 + JSON 结构化输出
//   - OpenAI evals:few-shot CoT + 自校准(同 judge 对同文本应得一致分)
//
// 设计选择:
//   1. 主观维度覆盖任意交付物的信息密度、表达一致性、合理性、推进和受众效果
//   2. score 0-10 → severity 映射:≤4=high, 5-6=medium, ≥7 不进 findings(没问题不报噪)
//   3. 严格 JSON 输出 + 解析失败兜底(返回空 findings 而非崩),对齐 Claude judge 鲁棒性
//   4. 评审调用使用 taskType="review" + jsonMode + contextProfile="minimal"
//   5. samples 支持(默认 1)—— 多采样取平均降方差,但默认关闭避免成本

const { claimExecutionBudget } = require("../agentTools/executionBudget");

const DEFAULT_DIMENSIONS = [
  "evidence_support",
  "internal_consistency",
  "specificity",
  "information_density",
  "voice_consistency",
  "contextual_plausibility",
  "progression",
  "audience_impact"
];
const SUPPORTED_DIMENSIONS = ["requirement_coverage", ...DEFAULT_DIMENSIONS];
const CONTRACT_DIMENSIONS = new Set(["requirement_coverage", "evidence_support", "internal_consistency", "specificity"]);

const DIMENSION_DESC = {
  requirement_coverage: "交付物是否逐项满足给定要求；只检查明确写出的要求，不扩张任务范围",
  evidence_support: "可核验的事实、数字、引用和因果判断是否由文本内证据或已给来源支持，是否把未知内容写成确定事实",
  internal_consistency: "人名、时间、数字、术语、立场和前后结论是否一致，是否出现互相冲突的陈述",
  specificity: "关键结论是否有对象、条件、动作或可观察细节支撑，是否大量停留在无法执行的抽象评价",
  information_density: "各部分是否增加事实、动作、推导或决策价值，是否存在同义结论和无效信息重复",
  voice_consistency: "术语、人称、语气和信息密度是否适合用户指定的受众与媒介，并在无任务原因时发生切换",
  contextual_plausibility: "结论、建议、行为和因果关系是否符合输入给出的条件、角色、资源与限制",
  progression: "步骤、论证或信息是否按可理解的依赖关系推进，过渡部分是否占用篇幅却不推动任务",
  audience_impact: "关键结论、风险和下一步动作是否被目标受众清楚识别，重点是否被次要信息淹没"
};

// score → severity 映射。
function scoreToSeverity(score) {
  const s = Number(score);
  if (!Number.isFinite(s)) return null;
  if (s <= 4) return "high";
  if (s <= 6) return "medium";
  return null; // ≥7 = 没问题,不报
}

function buildJudgePrompt(text, dimensions, styleAnchor = "", requirements = "") {
  const dimList = dimensions.map((d) => `- ${d}:${DIMENSION_DESC[d] || ""}`).join("\n");
  const schemaExample = {
    scores: Object.fromEntries(dimensions.map((d) => [d, 0])),
    findings: [
      { dimension: dimensions[0], severity: "high", note: "具体问题一句话", evidence: "交付物片段(原文摘抄)" }
    ],
    summary: "总评一句话"
  };
  const instruction = [
    "<task>按下列可观察维度检查一份交付物，只报告能够用原文定位的问题。</task>",
    "<scoring>0-3：问题贯穿多数相关段落；4-6：问题重复出现并影响理解或推进；7-8：只有孤立问题；9-10：未找到该维度的问题。</scoring>",
    "<rules>",
    "不改写交付物，不输出重写示例。",
    "evidence 必须是待评文本的逐字片段；没有 evidence 时不得创建 finding。",
    "findings 只列 score≤6 的维度；score≤4 标 high，score 为 5-6 标 medium。",
    "note 写明 evidence 中哪个词、字段、步骤或信息顺序触发问题，以及造成的后果。",
    "</rules>",
    "",
    "<dimensions>",
    dimList,
    "</dimensions>",
    "",
    requirements ? `<requirements>${requirements}</requirements>\n` : "",
    styleAnchor ? `<comparison_reference>${styleAnchor}</comparison_reference>\n` : "",
    "<output_format>只输出合法 JSON：",
    JSON.stringify(schemaExample, null, 2),
    "</output_format>"
  ].filter(Boolean).join("\n");
  return instruction;
}

/**
 * 解析 LLM 输出的 JSON judge 结果。失败兜底返回空 findings + 空 scores。
 *
 * @param {string} rawText
 * @param {string[]} dimensions
 */
function parseJudgeResult(rawText, dimensions, evidenceSource = "") {
  const { parseJsonObjectFromText } = require("../../shared/promptText");
  const parsed = parseJsonObjectFromText(rawText || "");
  const empty = { scores: {}, findings: [], summary: "", _parseFailed: true };
  if (!parsed || typeof parsed !== "object") return empty;
  const scores = {};
  for (const d of dimensions) {
    const v = Number(parsed.scores?.[d]);
    if (Number.isFinite(v)) scores[d] = Math.max(0, Math.min(10, v));
  }
  const findings = Array.isArray(parsed.findings) ? parsed.findings.map((f) => ({
    ruleId: `judge.${f?.dimension || "unknown"}`,
    category: CONTRACT_DIMENSIONS.has(f?.dimension) ? "quality-contract" : "subjective",
    severity: ["high", "medium"].includes(f?.severity) ? f.severity : (scoreToSeverity(scores[f?.dimension]) || "medium"),
    note: `${f?.note || ""}`.trim(),
    evidence: f?.evidence ? [`${f.evidence}`.trim()] : [],
    dimension: f?.dimension || ""
  })).filter((f) => f.note
    && dimensions.includes(f.dimension)
    && f.evidence.length > 0
    && f.evidence.every((evidence) => evidenceSource.includes(evidence))) : [];
  return { scores, findings, summary: `${parsed.summary || ""}`.trim(), _parseFailed: false };
}

/**
 * 多采样聚合:平均 scores,findings 按 dimension 去重(取 severity 最重一份)。
 */
function aggregateSamples(samples) {
  if (samples.length === 0) return { scores: {}, findings: [], summary: "", samples: 0 };
  if (samples.length === 1) return { ...samples[0], samples: 1 };
  const dims = new Set();
  for (const s of samples) for (const d of Object.keys(s.scores || {})) dims.add(d);
  const scores = {};
  for (const d of dims) {
    const vals = samples.map((s) => Number(s.scores?.[d])).filter((v) => Number.isFinite(v));
    if (vals.length) scores[d] = Number((vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(2));
  }
  // findings 按 (dimension, severity) 去重,severity 取最严
  const sevWeight = { high: 2, medium: 1 };
  const byDim = new Map();
  for (const s of samples) {
    for (const f of s.findings || []) {
      const key = f.dimension || f.ruleId;
      const cur = byDim.get(key);
      if (!cur || sevWeight[f.severity] > sevWeight[cur.severity]) byDim.set(key, f);
    }
  }
  return {
    scores,
    findings: Array.from(byDim.values()),
    summary: samples[0].summary,
    samples: samples.length
  };
}

/**
 * judgeContentQuality —— 公开入口。
 *
 * @param {{
 *   aiRouter: { runTask(args: any): Promise<string> },
 *   text: string,
 *   dimensions?: string[],
 *   samples?: number,
 *   styleAnchor?: string,
 *   requirements?: string,
 *   executionBudget?: any,
 *   parentModelReserve?: number,
 *   signal?: AbortSignal | null
 * }} options
 * @returns {Promise<{
 *   scores: Record<string, number>,
 *   findings: Array<any>,
 *   summary: string,
 *   samples: number,
 *   modelInvocations: number,
 *   budgetExhausted?: boolean,
 *   stopCode?: string,
 *   _parseFailed?: boolean
 * }>}
 */
async function judgeContentQuality(options = /** @type {any} */ ({})) {
  const {
    aiRouter, text, dimensions = DEFAULT_DIMENSIONS, samples = 1, styleAnchor = "", requirements = "",
    executionBudget = null, parentModelReserve = 1, signal = null
  } = options;
  if (!aiRouter || typeof aiRouter.runTask !== "function") {
    throw new Error("judgeContentQuality 缺少 aiRouter.runTask");
  }
  const clean = `${text || ""}`.trim();
  if (!clean) return { scores: {}, findings: [], summary: "", samples: 0, modelInvocations: 0 };

  const dims = (Array.isArray(dimensions) && dimensions.length ? dimensions : DEFAULT_DIMENSIONS)
    .filter((d) => SUPPORTED_DIMENSIONS.includes(d));
  if (!dims.length) dims.push(...DEFAULT_DIMENSIONS);
  const cleanRequirements = `${requirements || ""}`.trim();
  if (cleanRequirements && !dims.includes("requirement_coverage")) dims.unshift("requirement_coverage");
  const n = Math.max(1, Math.min(5, Math.floor(samples)));

  const instruction = buildJudgePrompt(clean, dims, styleAnchor, cleanRequirements);
  const input = [
    cleanRequirements ? `【明确要求】\n${cleanRequirements}` : "",
    `【待评文本】\n${clean}`
  ].filter(Boolean).join("\n\n");
  const samplesOut = [];
  let modelInvocations = 0;
  let budgetFailure = null;
  const reservedCalls = Number.isInteger(parentModelReserve) && parentModelReserve > 0
    ? parentModelReserve
    : 1;
  for (let i = 0; i < n; i += 1) {
    if (executionBudget && typeof executionBudget.remaining === "function"
      && executionBudget.remaining("model") <= reservedCalls) {
      budgetFailure = {
        ok: false,
        code: "AGENT_MODEL_BUDGET_RESERVED_FOR_PARENT",
        error: `已为父 Agent 保留 ${reservedCalls} 次后续模型调用。`
      };
      break;
    }
    const modelClaim = claimExecutionBudget(executionBudget, "model");
    if (!modelClaim.ok) {
      budgetFailure = modelClaim;
      break;
    }
    const raw = await aiRouter.runTask({
      taskType: "review",
      title: "contentQualityJudge 主观维度评分",
      instruction,
      input,
      runContext: "",
      contextProfile: "minimal",
      contextBudget: { runContextTokens: 0, inputTokens: 3000 },
      jsonMode: true,
      internalCall: true,
      signal: executionBudget?.signal || signal || null,
      executionBudget,
      providerAttemptPreclaimed: true
    }).catch(() => "");
    modelInvocations += 1;
    samplesOut.push(parseJudgeResult(raw, dims, input));
  }
  if (!samplesOut.length && budgetFailure) {
    const error = new Error(budgetFailure.error || "LLM judge 模型预算不足。");
    /** @type {any} */ (error).code = budgetFailure.code;
    throw error;
  }
  const aggregated = aggregateSamples(samplesOut);
  return {
    ...aggregated,
    modelInvocations,
    budgetExhausted: Boolean(budgetFailure),
    stopCode: budgetFailure?.code || ""
  };
}

module.exports = {
  judgeContentQuality,
  DEFAULT_DIMENSIONS,
  SUPPORTED_DIMENSIONS,
  DIMENSION_DESC,
  // 导出内部纯函数便于单测
  buildJudgePrompt,
  parseJudgeResult,
  aggregateSamples,
  scoreToSeverity
};
