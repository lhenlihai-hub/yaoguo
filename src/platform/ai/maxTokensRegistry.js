// @ts-check
// max_tokens 注册中心 —— 只登记模型物理上限并尊重显式配置。
//
// 业界对标：
//  - LiteLLM model_cost.json: 每个 model 注册 max_output_tokens
//  - Vercel AI SDK: 按 model 配置 maxOutputTokens
//  - Anthropic SDK docs: max_tokens 必须显式
//
// 设计原则：
//  1. 物理上限来自 provider 文档，是绝对天花板。
//  2. 调用方显式配置可以降低上限，但不能超过模型物理上限。
//  3. taskType 是遥测与模型策略元数据，不在这里替模型决定输出长度。

const { DEEPSEEK_V4_MAX_OUTPUT_TOKENS } = require("./deepseekV4Policy");

// model id substring → 物理 max output tokens
// 注：用 substring 匹配，因为某些 provider 模型有版本后缀（如 gpt-4o-2024-11-20）。
const MODEL_MAX_OUTPUT_TOKENS = [
  { match: /deepseek-v4-pro|deepseek-v4-flash/i, max: DEEPSEEK_V4_MAX_OUTPUT_TOKENS }
];

// 兜底：未注册 model 用 4096——保守值，覆盖大多数主流 model 的"安全档"。
const DEFAULT_MODEL_MAX = 4096;

function resolveModelMax(model = "") {
  const key = `${model || ""}`.trim();
  if (!key) return DEFAULT_MODEL_MAX;
  for (const entry of MODEL_MAX_OUTPUT_TOKENS) {
    if (entry.match.test(key)) return entry.max;
  }
  return DEFAULT_MODEL_MAX;
}

/**
 * 两方取小：DeepSeek 显式配置 / model 物理上限。
 * 两个来源的语义：
 *  - providerOverride：用户在 settings 显式配置，最高优先级（但仍不能超过 model 物理上限）
 *  - modelMax：物理天花板
 */
function resolveMaxTokens({ model = "", providerOverride = null } = {}) {
  const modelMax = resolveModelMax(model);
  const override = Number.isFinite(providerOverride) && providerOverride > 0 ? providerOverride : null;
  return Math.min(override ?? Number.POSITIVE_INFINITY, modelMax);
}

module.exports = {
  MODEL_MAX_OUTPUT_TOKENS,
  DEFAULT_MODEL_MAX,
  resolveModelMax,
  resolveMaxTokens
};
