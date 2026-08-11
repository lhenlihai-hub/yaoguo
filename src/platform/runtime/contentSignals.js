const crypto = require("node:crypto");
const { compactText } = require("../shared/promptText");
const { stampForId } = require("../shared/time");

function sanitizeFileName(input, fallback = "未命名") {
  const clean = String(input || fallback)
    .replace(/[\\/:*?"<>|#%{}^~[\]\x60]/g, " ")
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return clean || fallback;
}

function primaryRequestText(message = "") {
  const text = String(message || "").trim();
  if (!text) return "";
  const patterns = [
    /\n\s*(?:可以|可)?参考(?:以下|如下|资料|内容|材料)?\s*[:：]/,
    /\n\s*以下(?:是|为)?(?:参考|资料|素材|原始输入|样本|案例)\s*[:：]/,
    /\n\s*(?:样本一|样本二|样本三|参考一|参考二|参考三)\s*[:：]/,
    /\n\s*(?:附|附上|补充)(?:参考|资料|素材|原始输入)\s*[:：]/
  ];
  let cutAt = text.length;
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match && match.index >= 20) cutAt = Math.min(cutAt, match.index);
  }
  const head = text.slice(0, cutAt).trim();
  return head || text.slice(0, 4000).trim();
}

function extractTargetWordCount(...sources) {
  const wordSuffix = "字(?!符|节|母|号|典|段|样|形|根|体|条|句|串|帖)";
  for (const src of sources) {
    const text = String(src || "");
    if (!text) continue;
    if (/\d{3,5}\s*[-~至到]\s*\d{3,5}\s*字/.test(text)) continue;
    const each = new RegExp("每[一]?\\s*(?:部分|条目|段落|页面|批次)[^\\d\\n]{0,12}(\\d{3,5})\\s*" + wordSuffix).exec(text);
    if (each) {
      const n = Number(each[1]);
      if (n >= 200 && n <= 30000) return n;
    }
    const loose = new RegExp("(\\d{3,5})\\s*" + wordSuffix + "\\s*(?:左右|上下|以内|以上|之内)?").exec(text);
    if (loose) {
      const n = Number(loose[1]);
      if (n >= 200 && n <= 30000) return n;
    }
  }
  return 0;
}

function summarizeNameFromMessage(message = "", fallback = "新任务", maxLength = 18) {
  const text = compactText(primaryRequestText(message));
  if (!text) return fallback;
  const topicMatch = text.match(/(?:目标是|目标为|目标|主题是|主题为|主题|关于|围绕|题目是|题目为|题目|对象是|对象为|对象|名称是|名称为|名称)\s*[:：]?\s*([^。！？,.，；;]+)/);
  let topic = compactText((topicMatch && topicMatch[1]) || text);
  const stripRules = [
    /^(请|麻烦|帮我|给我|我要|我想|我们要|我们想|我们现在|我们|你现在|现在|能不能|可以)+/,
    /^(开始|来|马上|准备|继续|接着)+/,
    /^(完成|处理|生成|创建|制作|实现|分析|检查|修改|整理|设计|输出|帮忙|执行|做|写|起草)+/,
    /^(一个|一份|一版|一套|一次|这个|这份|本次)+/,
    /^(任务|项目|文件|文档|页面|方案|报告|程序|工具|结果)+/,
    /^(的)+/
  ];
  let prev;
  do {
    prev = topic;
    for (const re of stripRules) topic = topic.replace(re, "");
    topic = topic.trim();
  } while (topic && topic !== prev);
  topic = topic
    .replace(/(验收标准是|限制条件是|不要有|必须包含|长度为|字数为).*$/, "")
    .replace(/[，。！？、；：,.!?;:]+/g, " ")
    .replace(/\s+/g, "")
    .trim();
  const clean = topic.slice(0, maxLength).trim();
  return clean || fallback;
}

function compactGeneratedName(value = "", fallback = "未命名", maxLength = 10) {
  const fence = String.fromCharCode(96).repeat(3);
  const sourceText = compactText(value);
  const withoutFence = sourceText
    .replace(new RegExp("^" + fence + "(?:json)?", "i"), "")
    .replace(new RegExp(fence + "$", "i"), "");
  const clean = withoutFence
    .replace(/^(对话标题|标题|项目名称|项目名|名称|name|title)\s*[:：]/i, "")
    .replace(/[《》“”"'\[\]【】{}()（）<>]+/g, "")
    .replace(/[^\u4e00-\u9fa5a-zA-Z0-9]+/g, "")
    .trim();
  const source = clean || compactText(fallback).replace(/[^\u4e00-\u9fa5a-zA-Z0-9]+/g, "");
  const chars = Array.from(source || fallback);
  return chars.slice(0, Math.max(1, maxLength)).join("") || fallback;
}

function stripGenericNameSuffix(value = "") {
  return compactText(value)
    .replace(/(任务|项目|文件|文档|页面|方案|报告|程序|工具|结果)$/g, "")
    .trim();
}

function extractDeliverableTitle(content = "") {
  const text = String(content || "").replace(/\r/g, "\n").trim();
  if (!text) return "";
  const generic = /^(标题|题目|摘要|结果摘要|最终成品|修改后成品)$/;
  const lines = text.split(/\n+/).map((line) => line.trim()).filter(Boolean).slice(0, 18);
  for (const line of lines) {
    const source = line
      .replace(/^#{1,4}\s*/, "")
      .trim();
    const titled = source.match(/^(?:\*\*标题\*\*|【?标题】?|标题)\s*[:：]\s*(.+)$/);
    const candidate = titled ? titled[1] : source.replace(/^\*\*|\*\*$/g, "");
    const clean = compactGeneratedName(candidate, "", 24);
    if (clean && !generic.test(clean) && clean.length >= 2) return clean;
  }
  return "";
}

function deriveArtifactName({ message = "", taskTitle = "", content = "", fallback = "最终成品", maxLength = 24 } = {}) {
  const titleFromContent = extractDeliverableTitle(content);
  const cleanTaskTitle = isAutoTaskTitle(taskTitle) ? "" : stripGenericNameSuffix(taskTitle);
  const fromMessage = stripGenericNameSuffix(summarizeNameFromMessage(message, fallback, maxLength));
  const candidate = titleFromContent || cleanTaskTitle || fromMessage || fallback;
  return compactGeneratedName(candidate, fallback, maxLength);
}

function summarizeProjectNameFromMessage(message = "", fallback = "新项目", maxLength = 5) {
  const base = summarizeNameFromMessage(message, fallback, 18)
    .replace(/(任务|项目|文件|文档|页面|方案|报告|程序|工具|结果)$/g, "")
    .replace(/的/g, "");
  return compactGeneratedName(base || fallback, fallback, maxLength);
}

function isAutoProjectName(name = "") {
  return /^(新项目(?:[-_\s]*\d+)?|未命名项目|project(?:[-_\s]*\d+)?)$/i.test(String(name || "").trim());
}

const PLACEHOLDER_TASK_BRIEFS = new Set([
  "这是项目的第一个对话，共享项目工作记忆和资料库。",
  "第一次对话后会自动命名。",
  "这是项目的第一个任务，共享项目工作记忆和资料库。",
  "第一次工作后会自动命名。"
]);

function isPlaceholderTaskBrief(text = "") {
  const trimmed = String(text || "").trim();
  if (!trimmed) return true;
  if (PLACEHOLDER_TASK_BRIEFS.has(trimmed)) return true;
  if (trimmed.startsWith("这是项目的第一个对话")) return true;
  if (trimmed.startsWith("第一次对话后会自动命名")) return true;
  if (trimmed.startsWith("这是项目的第一个任务")) return true;
  if (trimmed.startsWith("第一次工作后会自动命名")) return true;
  return false;
}

function isPlaceholderDerivedProjectName(name = "") {
  return /^这是项目/.test(String(name || "").trim());
}

function isAutoTaskTitle(title = "") {
  return /^(新对话(?:[-_\s]*\d+)?|初始对话|新任务|task(?:[-_\s]*\d+)?)$/i.test(String(title || "").trim());
}

function statusTextForFile(status = "") {
  return {
    active: "进行中",
    pending: "等待",
    running: "运行中",
    completed: "完成",
    blocked: "阻塞"
  }[status] || status || "未知";
}

function uniqueEntityId(prefix = "item") {
  return sanitizeFileName(prefix + "-" + stampForId() + "-" + crypto.randomUUID().slice(0, 8), prefix);
}

module.exports = {
  sanitizeFileName,
  primaryRequestText,
  extractTargetWordCount,
  summarizeNameFromMessage,
  compactGeneratedName,
  stripGenericNameSuffix,
  extractDeliverableTitle,
  deriveArtifactName,
  summarizeProjectNameFromMessage,
  isAutoProjectName,
  PLACEHOLDER_TASK_BRIEFS,
  isPlaceholderTaskBrief,
  isPlaceholderDerivedProjectName,
  isAutoTaskTitle,
  statusTextForFile,
  uniqueEntityId
};
