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
  const counter = createTokenCounter();
  for (const char of value) counter.pushChar(char);
  return counter.tokens();
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

/**
 * 与 estimateTokens 公式严格一致的增量计数器：O(1) 每字符，
 * 供截断函数边追加边校验，避免“按字符预算截断”与“按 estimateTokens 验收”
 * 两套口径漂移（ASCII 文本曾因此超预算约 2 倍）。
 */
function createTokenCounter() {
  const state = {
    cjk: 0,
    latinWords: 0,
    nonCjkChars: 0,
    punctuation: 0,
    lineBreaks: 0,
    inWord: false
  };
  const mutate = (char) => {
    if (/[\u3400-\u9fff]/.test(char)) {
      state.cjk += 1;
      if (state.inWord) {
        state.latinWords += 1;
        state.inWord = false;
      }
      return;
    }
    if (/[a-zA-Z0-9_+-]/.test(char)) {
      state.nonCjkChars += 1;
      // 与 estimateTokens 的双计口径一致：\w 不含 +-，它们同时计入
      // 词字符与标点两个聚合项。
      if (/[+\-]/.test(char)) state.punctuation += 1;
      state.inWord = true;
      return;
    }
    const codeUnits = char.length;
    state.nonCjkChars += codeUnits;
    if (/\s/.test(char)) {
      if (char === "\n") state.lineBreaks += 1;
    } else {
      state.punctuation += codeUnits;
    }
    if (state.inWord) {
      state.latinWords += 1;
      state.inWord = false;
    }
  };
  const total = () => Math.max(1, Math.ceil(
    (state.cjk / 1.65)
    // estimateTokens 把末尾未闭合的词片段也计为一个词运行。
    + ((state.latinWords + (state.inWord ? 1 : 0)) * 1.15)
    + (state.nonCjkChars / 4.2)
    + (state.punctuation * 0.25)
    + (state.lineBreaks * 0.35)
  ));
  return {
    /** 追加一个字符并返回追加后的 token 估算。 */
    pushChar(char) {
      mutate(char);
      return total();
    },
    /** 假设追加一个字符后的 token 估算，不改变状态。 */
    peekChar(char) {
      const snapshot = { ...state };
      mutate(char);
      const value = total();
      Object.assign(state, snapshot);
      return value;
    },
    tokens: total
  };
}

module.exports = {
  estimateCharTokenCost,
  estimateTokens,
  estimateMessageTokens,
  estimateToolSchemasTokens,
  estimateRequestTokens,
  createTokenCounter
};
