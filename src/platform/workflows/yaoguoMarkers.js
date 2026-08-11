// @ts-check

const { truncateForPrompt, compactText } = require("../shared/promptText");

function normalizeYaoguoMarkerText(text = "") {
  let raw = `${text || ""}`;
  if (!raw) return "";
  // CRLF / CR → LF
  raw = raw.replace(/\r\n?/g, "\n");
  // 全角破折号 / em-dash / en-dash / 横线变体 → 普通连字符（仅在 YAOGUO 上下文行）
  // 为避免误伤正文里的破折号，只在含 YAOGUO 关键字的行上做替换。
  raw = raw.replace(/^[^\n]*YAOGUO[^\n]*$/gm, (line) =>
    line
      .replace(/[—–―‒－﹣−]/g, "-")
      .replace(/[＜《]/g, "<")
      .replace(/[＞》]/g, ">")
      .replace(/[　\t]+/g, " ")
  );
  return raw;
}

function yaoguoMarkerRegex(kindPattern = "(?:STEP_SUMMARY|HANDOFF)") {
  const prefix = "[ \\t>*_`~]*";
  const suffix = "[ \\t>*_`~]*";
  const dashMarker = `-{2,}\\s*YAOGUO_${kindPattern}\\s*-{2,}`;
  const angleMarker = `<{2,}\\s*YAOGUO_${kindPattern}\\s*>{2,}`;
  return new RegExp(`(?:^|\\n)${prefix}(?:${dashMarker}|${angleMarker})${suffix}(?=\\n|$)`, "i");
}

function findYaoguoMarker(text = "", kindPattern = "(?:STEP_SUMMARY|HANDOFF)") {
  const match = `${text || ""}`.match(yaoguoMarkerRegex(kindPattern));
  if (!match) return null;
  return {
    index: match.index || 0,
    end: (match.index || 0) + match[0].length,
    raw: match[0]
  };
}

// L7 末端兜底剥离器：在写盘前无条件删除任何形态的 YAOGUO marker 块。
// 即使 extractInlineStepSummary 因格式异常未能识别，这里也能保证落盘文件干净。
// Defense-in-depth：与 extractInlineStepSummary 互不依赖，互为冗余。

function stripYaoguoMarkers(text = "") {
  if (!text) return "";
  let out = normalizeYaoguoMarkerText(text);
  // 1) 优先：从第一个系统 marker 起，到文末，全部裁掉。
  //    容错：CRLF、dash 数量 ≥2、全角破折号、<<< >>>、粗体/斜体包裹、
  //    markdown fence、行首引用前缀。
  const marker = findYaoguoMarker(out);
  if (marker) {
    out = out.slice(0, marker.index);
    // 如果切点正好把 ``` 开 fence 留在了尾巴上（fence 包裹的 marker 块场景），
    // 再清掉孤立的 fence 行。
    out = out.replace(/\n[ \t]*`{3,}[a-zA-Z]*[ \t]*\n?\s*$/, "");
  }
  // 2) 兜底：被 ``` fence 包裹但未被第一步截断的孤立 marker 块。
  const markerLine = "[ \\t>*_`~]*(?:-{2,}\\s*YAOGUO_(?:STEP_SUMMARY|HANDOFF)\\s*-{2,}|<{2,}\\s*YAOGUO_(?:STEP_SUMMARY|HANDOFF)\\s*>{2,})[ \\t>*_`~]*";
  out = out.replace(new RegExp("```[a-zA-Z]*\\s*\\n?" + markerLine + "[\\s\\S]*?```", "gi"), "");
  // 3) 兜底：任何遗漏的 marker 单行。
  out = out.replace(new RegExp("^" + markerLine + "$", "gmi"), "");
  // 4) 终极兜底：只要系统 marker 字样仍残留，就从所在行开始截断。
  // 这比继续枚举模型可能发明的新包装更可靠。
  const residue = out.search(/YAOGUO_(?:STEP_SUMMARY|HANDOFF)/i);
  if (residue >= 0) {
    const lineStart = out.lastIndexOf("\n", residue);
    out = out.slice(0, lineStart >= 0 ? lineStart : 0);
  }
  return out.trim();
}

function extractInlineStepSummary(text = "") {
  const normalized = normalizeYaoguoMarkerText(text).trim();
  if (!normalized) return { content: "", summary: "", handoff: null };
  const summaryMarker = findYaoguoMarker(normalized, "STEP_SUMMARY");
  if (!summaryMarker) return { content: normalized, summary: "", handoff: null };
  const content = normalized.slice(0, summaryMarker.index).trim();
  const tail = normalized.slice(summaryMarker.end).trim();
  const handoffMarker = findYaoguoMarker(tail, "HANDOFF");
  let summary = tail;
  let handoff = null;
  if (handoffMarker) {
    summary = tail.slice(0, handoffMarker.index).trim();
    handoff = parseHandoffBlock(tail.slice(handoffMarker.end));
  }
  return {
    content,
    summary: truncateForPrompt(summary, 600),
    handoff
  };
}

function parseHandoffBlock(raw = "") {
  const text = `${raw || ""}`.trim();
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] || text.match(/\{[\s\S]*\}/)?.[0] || text;
  let parsed = null;
  try {
    parsed = JSON.parse(fenced);
  } catch {
    parsed = null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const take = (value) => {
    if (!value) return [];
    const rows = Array.isArray(value) ? value : [value];
    return rows
      .map((item) => `${item || ""}`.replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .map((item) => truncateForPrompt(item, 200))
      .slice(0, 8);
  };
  const decisions = take(parsed.decisions || parsed.decision);
  const rejected = take(parsed.rejected || parsed.rejected_directions || parsed.avoid);
  const openQuestions = take(parsed.open_questions || parsed.openQuestions || parsed.questions || parsed.unknowns);
  const facts = take(parsed.facts || parsed.fact_anchors || parsed.constraints);
  if (!decisions.length && !rejected.length && !openQuestions.length && !facts.length) return null;
  return { decisions, rejected, openQuestions, facts };
}

function localStepSummary(text = "", maxChars = 500) {
  const clean = `${text || ""}`
    .replace(/\[内容过长，已截断\s*\d+\s*字\]/g, "")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line && !/^#{1,6}\s+/.test(line))
    .filter((line) => !/^(来源|检索时间|查证时间|时间)[:：]/.test(line))
    .slice(0, 10)
    .join("\n");
  return truncateForPrompt(clean || compactText(text), maxChars);
}

module.exports = {
  normalizeYaoguoMarkerText,
  yaoguoMarkerRegex,
  findYaoguoMarker,
  stripYaoguoMarkers,
  extractInlineStepSummary,
  parseHandoffBlock,
  localStepSummary
};
