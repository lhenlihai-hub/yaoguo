// @ts-check

// 本地 capability search：只让模型看到搜索入口，完整工具 schema / Skill 指令命中后再揭示。
// 这是 provider-neutral 的 client-executed tool search，不依赖某一家模型的 hosted tool_search。

const DEFAULT_LIMIT = 3;
const MIN_MATCH_SCORE = 32;

const INTENT_MODE_RULES = Object.freeze({
  memory_write: intentRule(
    /(?:记住|保存|记下|沉淀(?:这个|这条|为|到|进)|以后都|今后保持|长期保持|\b(?:remember|memorize|save|keep using)\b|\b(?:from now on|going forward)\b)/,
    /(?:偏好|习惯|要求|规则|风格|语气|格式|句子|这个|这条|以后|今后|长期|\b(?:preferences?|habits?|requirements?|rules?|styles?|tones?|formats?|sentences?|wording|this|that)\b)/
  ),
  delegate: intentRule(
    /(?:委派|分派|交给|找(?:个|一个)?人|让(?:另一个)?(?:智能体|代理)|分头处理|并行处理|\b(?:delegate|assign|hand off|ask)\b)/,
    /(?:智能体|代理|子代理|人|子任务|任务|工作|\b(?:agent|assistant|subagent|someone|task|work|this)\b)/,
    72
  ),
  judge: intentRule(
    /(?:评审|审一下|评估|评价|打分|检查|好不好|怎么样|是否合格|是否达标|\b(?:review|evaluate|assess|score|critique|check)\b)/,
    /(?:交付物|结果|报告|文档|内容|质量|成品|\b(?:deliverable|output|result|report|document|content|quality|text|this|it)\b)/
  ),
  search: intentRule(
    /(?:搜索|查资料|查证|核实|找|\b(?:search|research|look up|verify|find)\b)/,
    /(?:资料|来源|依据|新闻|事实|网页|信息|\b(?:source|sources|reference|references|news|fact|facts|web|information|evidence)\b|\b(?:search|research|look up)\s+(?:for\s+)?[a-z0-9\u3400-\u9fff])/
  ),
  image_search: intentRule(
    /(?:搜索|检索|查找|寻找|找(?:一|几|张|幅|个)?|\b(?:search|find|look for)\b)/,
    /(?:图片|配图|照片|插图|图像|摄影|\b(?:image|images|photo|photos|picture|pictures|illustration|illustrations)\b)/
  ),
  artifact_search: intentRule(
    /(?:检索|搜索|查找|找找|看看|查看|读取|\b(?:search|find|look for|list|show|view|read)\b)/,
    /(?:历史|以前|旧稿|产物|成品|前文|\b(?:history|historical|previous|prior|old|artifact|artifacts|output|outputs|draft|drafts)\b)/
  ),
  artifact_read: intentRule(
    /(?:读取|精读|打开|查看|\b(?:read|open|show|view|inspect)\b)/,
    /(?:产物|成品|正文|旧稿|\bartifacts?\b|\b(?:output|draft|content)\b)/
  ),
  citation_manage: intentRule(
    /(?:添加|加上|加|补充|保存|记录|管理|插入|生成|更新|删除|整理|核对|标注|\b(?:add|save|manage|insert|generate|update|delete|organize|verify|annotate)\b)/,
    /(?:引用|来源|出处|参考文献|\b(?:citation|citations|reference|references|source|sources|bibliography)\b)/
  )
});

const MUTATION_INTENT = /(?:修改|更新|改一下|调整|新增|删除|保存|记下|设置|写入|沉淀(?:这个|这条|为|到|进)|\b(?:update|edit|modify|change|add|delete|save|remember|set|write)\b)/;
const READ_INTENT = /(?:查看|看看|读取|列出|有哪些|回顾|\b(?:read|show|view|list|open|inspect)\b)/;
const DELEGATION_INTENT = /(?:找(?:个|一个)?人|另一个智能体|子代理|分派代理|分头处理|\b(?:delegate|assign|hand off|another (?:agent|assistant)|subagent)\b)/;
const CLAUSE_BOUNDARY = /[，。！？；,.!?;]/;
const NEGATED_PREFIX = /(?:(?:不应该|不能|不想|不希望|不需要|不要|不用|别|无需|不必|禁止|取消|停止)(?:再|继续)?[^，。！？；,.!?;]{0,28}|(?:(?:do\s+not|don't|dont)\s+want\s+to|should\s+not|shouldn't|must\s+not|mustn't|would\s+rather\s+not|rather\s+not|cannot|can't|cant|do\s+not|don't|dont|no\s+need\s+to|never|stop|avoid|without)\b[^，。！？；,.!?;]{0,48})$/;
const META_INTENT_PREFIX = /(?:制作|创建|讨论|解释|介绍|分析|评估).{0,28}(?:关于|如何|为什么|是否|目标|任务|方案|报告|文档|代码|内容)|\b(?:create|draft|explain|discuss(?:es|ed|ing)?|describe|analy[sz]e|compare|mention|evaluate)\b.{0,48}\b(?:task|plan|report|document|code|content|topic|whether|how|why)\b|\b(?:a|an|the)\s+(?:document|report|guide|task|plan)\s+(?:about|on|where|that)\b/;
const COMMAND_PIVOT = /(?:然后|并且|同时|再|，|,|；|;|\b(?:then|and then|and)\b)\s*(?:please\s*)?$/;

function searchCapabilityCatalog(query = "", catalog = [], options = {}) {
  const normalizedQuery = normalize(query);
  const limit = Math.max(1, Math.min(5, Math.floor(Number(options.limit) || DEFAULT_LIMIT)));
  if (!normalizedQuery) return { matches: [], suggestions: [] };
  const ranked = (Array.isArray(catalog) ? catalog : [])
    .map((entry) => ({ entry, score: scoreCapability(normalizedQuery, entry) }))
    .sort((a, b) => b.score - a.score || `${a.entry?.id || a.entry?.name || ""}`.localeCompare(`${b.entry?.id || b.entry?.name || ""}`));
  return {
    matches: ranked.filter((item) => item.score >= MIN_MATCH_SCORE).slice(0, limit),
    suggestions: ranked.filter((item) => item.score > 0).slice(0, limit)
  };
}

function scoreCapability(query, entry = {}) {
  const id = normalize(entry.id || "");
  const name = normalize(entry.name || "");
  const title = normalize(entry.title || "");
  if ([id, name, title].some((value) => value && value === query)) return 1000;
  const excludedPhrases = (Array.isArray(entry.excludedPhrases) ? entry.excludedPhrases : [])
    .map(normalize)
    .filter(Boolean);
  if (excludedPhrases.some((phrase) => query.includes(phrase))) return 0;
  const intentMatch = entry.intentMode
    ? matchIntentMode(query, entry.intentMode)
    : { matched: true, evidence: 0 };
  if (!intentMatch.matched) return 0;

  let score = intentMatch.evidence;
  const actionTerms = (Array.isArray(entry.actions) ? entry.actions : []).flatMap((action) => (
    typeof action === "string"
      ? [action]
      : [action?.name, action?.description, action?.sideEffects]
  )).filter(Boolean);
  const intentExamples = Array.isArray(entry.intentExamples) ? entry.intentExamples : [];
  const probes = unique([
    name,
    title,
    ...(Array.isArray(entry.keywords) ? entry.keywords : []),
    ...actionTerms,
    ...intentExamples
  ].map(normalize).filter((value) => value.length >= 2));
  if (hasNegatedIntent(query, probes)) return 0;
  for (const probe of probes) {
    if (query.includes(probe)) score += 35 + Math.min(20, probe.length);
    else if (query.length >= 3 && probe.includes(query)) score += 25;
  }

  const queryTokens = lexicalTokens(query);
  const documentTokens = new Set(lexicalTokens(normalize([
    entry.description,
    entry.namespace,
    entry.kind,
    ...actionTerms,
    ...intentExamples
  ].filter(Boolean).join(" "))));
  for (const token of queryTokens) {
    if (token.length >= 2 && documentTokens.has(token)) score += 8;
  }
  const entryEvidence = score - intentMatch.evidence;
  const mutationIntent = MUTATION_INTENT.test(query);
  const readIntent = READ_INTENT.test(query);
  const delegationIntent = DELEGATION_INTENT.test(query);
  const effect = `${entry.effect || ""}`;
  if (entryEvidence >= 20 && mutationIntent) score += effect === "workspace_write" ? 24 : (effect === "read" ? -36 : 0);
  if (entryEvidence >= 20 && readIntent) score += effect === "read" ? 16 : (effect === "workspace_write" ? -12 : 0);
  if (entryEvidence >= 20 && delegationIntent) score += entry.namespace === "delegation" ? 40 : (entry.namespace === "research" ? -20 : 0);
  return score;
}

function hasNegatedIntent(query, probes) {
  return probes.some((probe) => {
    const index = query.indexOf(probe);
    if (index < 0) return false;
    return isNegatedAt(query, index);
  });
}

function intentRule(action, object = null, baseEvidence = 24) {
  return Object.freeze({ action, object, baseEvidence });
}

function matchIntentMode(query, mode) {
  const rule = INTENT_MODE_RULES[mode];
  if (!rule) return { matched: false, evidence: 0 };
  const actionMatch = query.match(rule.action);
  if (!actionMatch || actionMatch.index === undefined) return { matched: false, evidence: 0 };
  if (isNegatedAt(query, actionMatch.index) || isMetaMentionAt(query, actionMatch.index)) {
    return { matched: false, evidence: 0 };
  }
  const hasObject = !rule.object || rule.object.test(query);
  if (rule.object && !hasObject) return { matched: false, evidence: 0 };
  return {
    matched: true,
    evidence: rule.baseEvidence + (rule.object ? 12 : 0)
  };
}

function isNegatedAt(query, index) {
  const clause = clausePrefix(query, index);
  return NEGATED_PREFIX.test(clause);
}

function isMetaMentionAt(query, index) {
  const clause = clausePrefix(query, index);
  if (!META_INTENT_PREFIX.test(clause)) return false;
  return !COMMAND_PIVOT.test(clause);
}

function clausePrefix(query, index) {
  const prefix = query.slice(0, index);
  let boundary = -1;
  for (let cursor = prefix.length - 1; cursor >= 0; cursor -= 1) {
    if (CLAUSE_BOUNDARY.test(prefix[cursor])) {
      boundary = cursor;
      break;
    }
  }
  return prefix.slice(boundary + 1);
}

function lexicalTokens(text = "") {
  const value = normalize(text);
  const latin = value.match(/[a-z0-9_]+/g) || [];
  const cjkRuns = value.match(/[\u3400-\u9fff]+/g) || [];
  const cjk = [];
  for (const run of cjkRuns) {
    if (run.length <= 4) cjk.push(run);
    for (let index = 0; index < run.length - 1; index += 1) cjk.push(run.slice(index, index + 2));
  }
  return unique([...latin, ...cjk]);
}

function normalize(value) {
  return `${value || ""}`.trim().toLowerCase().replace(/\s+/g, " ");
}

function unique(values) {
  return [...new Set(values)];
}

module.exports = {
  searchCapabilityCatalog,
  scoreCapability
};
