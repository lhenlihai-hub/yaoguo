// @ts-check

function estimateCharTokenCost(char = "") {
  if (/[\u3400-\u9fff]/.test(char)) return 0.62;
  if (/\s/.test(char)) return 0.1;
  if (/[a-zA-Z0-9_+-]/.test(char)) return 0.25;
  return 0.45;
}

function estimateTokens(text = "") {
  const value = `${text || ""}`;
  if (!value) return 0;
  const cjk = (value.match(/[\u3400-\u9fff]/g) || []).length;
  const latinWords = (value.match(/[a-zA-Z0-9_+-]+/g) || []).length;
  const nonCjkChars = value.replace(/[\u3400-\u9fff]/g, "").length;
  const punctuation = (value.match(/[^\s\w\u3400-\u9fff]/g) || []).length;
  const lineBreaks = (value.match(/\n/g) || []).length;
  return Math.max(1, Math.ceil((cjk / 1.65) + (latinWords * 1.15) + (nonCjkChars / 4.2) + (punctuation * 0.25) + (lineBreaks * 0.35)));
}

function serializeForTokenEstimate(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? `${value}` : serialized;
  } catch {
    return `${value}`;
  }
}

function estimateStructuredTokens(value) {
  return estimateTokens(serializeForTokenEstimate(value));
}

function estimateMessageTokens(messages = []) {
  const rows = Array.isArray(messages) ? messages : [];
  return rows.reduce((sum, item) => {
    if (!item || typeof item !== "object") {
      return sum + estimateStructuredTokens(item) + 4;
    }
    return sum
      + estimateStructuredTokens(item.content)
      + estimateStructuredTokens(item.reasoning_content)
      + estimateStructuredTokens(item.tool_calls)
      + estimateStructuredTokens(item.function_call)
      + estimateStructuredTokens(item.tool_call_id)
      + estimateStructuredTokens(item.name)
      + 4;
  }, 2);
}

function estimateToolSchemasTokens(tools = []) {
  const rows = Array.isArray(tools) ? tools : [];
  return rows.length ? estimateStructuredTokens(rows) : 0;
}

/**
 * @param {{ messages?: any[], tools?: any[] }} [request]
 */
function estimateRequestTokens(request = {}) {
  return estimateMessageTokens(request.messages) + estimateToolSchemasTokens(request.tools);
}

module.exports = {
  estimateCharTokenCost,
  estimateTokens,
  estimateMessageTokens,
  estimateToolSchemasTokens,
  estimateRequestTokens
};
