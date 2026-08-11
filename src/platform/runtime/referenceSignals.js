const { uniqueValues, splitSentences } = require("../shared/promptText");

function toSearchTerms(query) {
  const raw = String(query || "").trim().toLowerCase();
  if (!raw) return [];
  const parts = raw.split(/[\s,，。;；、｜|/]+/).filter((item) => item.length >= 2);
  return uniqueValues([raw, ...parts]);
}

function isProcessLocalReference(item = {}) {
  const text = String((item.title || "") + " " + (item.relative || "") + " " + (item.absolute || ""));
  return /(执行前必读|受保护|任务日志|工作流|workflow|全局执行偏好|经验管理规则|待确认经验|记忆冲突|项目要求|项目说明|参考样本|决策与进展|长期上下文|实体与关系|run\.json|state\.md|project\.json|task\.json|settings\.json|jobs\.json|runs[\\/]|outputs[\\/]|sources[\\/]|detectors[\\/]|final[\\/])/i.test(text);
}

function buildSnippet(content, terms, max = 260) {
  const text = String(content || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  const lower = text.toLowerCase();
  const indexes = terms.map((term) => lower.indexOf(term)).filter((index) => index >= 0);
  const start = indexes.length ? Math.max(Math.min(...indexes) - 80, 0) : 0;
  const snippet = text.slice(start, start + max);
  return (start > 0 ? "..." : "") + snippet + (start + max < text.length ? "..." : "");
}

function extractFactClaims(text = "", maxClaims = 12) {
  const candidates = splitSentences(text)
    .filter((line) => {
      if (/^(标题|摘要|正文|交付物|参考|来源|说明)[:：]/.test(line)) return false;
      return /(\d{2,4}年|\d+月|\d+日|\d+(?:\.\d+)?%|\d+(?:\.\d+)?万|第[一二三四五六七八九十\d]+|据|显示|发布|宣布|规定|实施|政策|机构|公司|医院|学校|专家|事故|事件|研究|数据|报告|调查|排名|增长|下降)/.test(line);
    })
    .map((line) => line.replace(/^[-*#>\s]+/, "").replace(/^\d+[.)、]\s*/, "").replace(/[“”]/g, "").trim())
    .filter((line) => line.length >= 10 && line.length <= 180);
  return uniqueValues(candidates).slice(0, maxClaims);
}

module.exports = {
  toSearchTerms,
  isProcessLocalReference,
  buildSnippet,
  extractFactClaims
};
