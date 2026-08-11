// @ts-check
// llm_judge_quality —— 有证据约束的交付物质量评审。

const { judgeContentQuality, SUPPORTED_DIMENSIONS } = require("../judges/contentQualityJudge");

const LLM_JUDGE_QUALITY_TOOL_SCHEMA = {
  type: "function",
  function: {
    name: "llm_judge_quality",
    description: [
      "用独立 LLM 评审交付物的要求覆盖、证据、内部一致性、具体性和可用性。",
      "finding 必须引用输入中的逐字证据；无证据的问题会被丢弃。",
      "返回 findings(severity=high|medium)，适合复杂交付前检查或 revise 后复审。",
      "成本提醒:这工具会发起一次额外 LLM 调用;samples > 1 会调多次取平均,谨慎。",
      "默认 samples=1。文本建议 ≤ 3000 字一次评。"
    ].join(""),
    parameters: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "必填。要评估的文本片段,建议 ≤ 3000 字。"
        },
        dimensions: {
          type: "array",
          items: {
            type: "string",
            enum: SUPPORTED_DIMENSIONS
          },
          description: "可选。要评估的维度子集；留空使用通用质量维度。"
        },
        samples: {
          type: "integer",
          description: "可选。采样次数,默认 1,最大 5。> 1 时多次评估取平均(成本翻倍但降方差)。"
        },
        styleAnchor: {
          type: "string",
          description: "可选。风格锚定参考(给 judge 一个对照标准)。"
        },
        requirements: {
          type: "string",
          description: "可选。用户明确要求或验收条件；提供后自动检查 requirement_coverage。"
        }
      },
      required: ["text"]
    }
  }
};

async function executeLlmJudgeQuality(args = {}, ctx = {}) {
  const { aiRouter } = ctx;
  if (!aiRouter || typeof aiRouter.runTask !== "function") {
    return { ok: false, error: "llm_judge_quality 缺少 ctx.aiRouter" };
  }
  const text = `${args.text || ""}`.trim();
  if (!text) return { ok: false, error: "text 不能为空" };
  try {
    const result = await judgeContentQuality({
      aiRouter,
      text,
      dimensions: Array.isArray(args.dimensions) && args.dimensions.length ? args.dimensions : undefined,
      samples: Number.isFinite(args.samples) ? args.samples : 1,
      styleAnchor: `${args.styleAnchor || ""}`.trim(),
      requirements: `${args.requirements || ""}`.trim(),
      executionBudget: ctx.executionBudget || null,
      parentModelReserve: ctx.parentModelReserve,
      signal: ctx.executionBudget?.signal || ctx.signal || null
    });
    return {
      ok: true,
      scores: result.scores,
      findings: result.findings,
      summary: result.summary,
      samples: result.samples,
      modelInvocations: result.modelInvocations,
      budgetExhausted: Boolean(result.budgetExhausted),
      stopCode: result.stopCode || "",
      parseFailed: Boolean(result._parseFailed)
    };
  } catch (err) {
    return { ok: false, error: `${err?.message || err}` };
  }
}

const llmJudgeQualityTool = {
  schema: LLM_JUDGE_QUALITY_TOOL_SCHEMA,
  execute: executeLlmJudgeQuality
};

module.exports = {
  llmJudgeQualityTool,
  LLM_JUDGE_QUALITY_TOOL_SCHEMA,
  executeLlmJudgeQuality
};
