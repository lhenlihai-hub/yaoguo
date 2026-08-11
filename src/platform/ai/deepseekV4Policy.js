// @ts-check

const DEEPSEEK_V4_PATTERN = /deepseek-v4-(?:pro|flash)/i;
const DEEPSEEK_V4_CONTEXT_WINDOW_TOKENS = 1_000_000;
const DEEPSEEK_V4_MAX_OUTPUT_TOKENS = 384_000;

const DEFAULT_THINKING_LEVEL = "max";

function isDeepSeekV4(provider = {}, model = "") {
  const marker = `${provider.id || ""} ${provider.name || ""} ${provider.baseUrl || ""} ${model || ""}`;
  return /deepseek/i.test(marker) && DEEPSEEK_V4_PATTERN.test(`${model || ""}`);
}

function normalizeThinkingLevel(value, fallback = "disabled") {
  if (value === true) return "high";
  if (value === false) return "disabled";
  const level = `${value || ""}`.trim().toLowerCase();
  if (level === "max" || level === "high" || level === "disabled") return level;
  return fallback;
}

function resolveDeepSeekV4Policy({
  provider = {},
  model = "",
  taskType = "default",
  hasTools = false,
  agentStage = "",
  settings = {},
  thinkingOverride = null,
  reasoningEffortOverride = ""
} = {}) {
  if (!isDeepSeekV4(provider, model)) {
    return { applicable: false, enabled: false, thinking: null, reasoningEffort: null };
  }

  const settingsConfig = /** @type {any} */ (settings);
  const configured = settingsConfig.deepseek?.thinking;
  // 模型与思考能力是全局选择。任务类型、是否有工具和连续工具轮不再改变强度。
  void taskType;
  void hasTools;
  void agentStage;
  let level = normalizeThinkingLevel(configured, DEFAULT_THINKING_LEVEL);
  if (thinkingOverride !== null && thinkingOverride !== undefined) {
    if (thinkingOverride === true) {
      if (level === "disabled") level = "high";
    } else {
      level = normalizeThinkingLevel(thinkingOverride, level);
    }
  }
  const enabled = level !== "disabled";
  const effortOverride = normalizeThinkingLevel(reasoningEffortOverride, "disabled");
  const reasoningEffort = enabled
    ? (effortOverride === "max" || effortOverride === "high" ? effortOverride : level)
    : null;

  return {
    applicable: true,
    enabled,
    thinking: enabled ? "enabled" : "disabled",
    reasoningEffort: reasoningEffort === "max" ? "max" : (enabled ? "high" : null)
  };
}

module.exports = {
  DEEPSEEK_V4_CONTEXT_WINDOW_TOKENS,
  DEEPSEEK_V4_MAX_OUTPUT_TOKENS,
  DEFAULT_THINKING_LEVEL,
  isDeepSeekV4,
  resolveDeepSeekV4Policy
};
