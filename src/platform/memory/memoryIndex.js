const path = require("node:path");

function truncateForPrompt(text, max = 12000) {
  const value = String(text || "");
  if (value.length <= max) return value;
  return value.slice(0, max) + "\n\n[内容过长，已截断 " + (value.length - max) + " 字]";
}

function countOccurrences(text, term) {
  if (!term) return 0;
  return (String(text || "").match(new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi")) || []).length;
}

function tokenizeForVector(text = "") {
  const raw = `${text || ""}`.toLowerCase();
  const tokens = [];
  for (const match of raw.matchAll(/[a-z0-9_+-]{2,}|[\u4e00-\u9fff]{2,}/g)) {
    const value = match[0];
    if (/^[\u4e00-\u9fff]+$/.test(value)) {
      if (value.length <= 8) tokens.push(value);
      for (let size = 2; size <= 3; size += 1) {
        for (let index = 0; index <= value.length - size; index += 1) {
          tokens.push(value.slice(index, index + size));
        }
      }
    } else {
      tokens.push(value);
    }
  }
  const stop = new Set(["这个", "那个", "我们", "你们", "他们", "以及", "如果", "需要", "不能", "不要", "进行", "当前", "本次"]);
  return tokens.filter((token) => token.length >= 2 && !stop.has(token)).slice(0, 900);
}

function hashToken(token, buckets = 384) {
  let hash = 2166136261;
  for (let index = 0; index < token.length; index += 1) {
    hash ^= token.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash) % buckets;
}

function vectorizeText(text = "") {
  const values = {};
  for (const token of tokenizeForVector(text)) {
    const key = `${hashToken(token)}`;
    values[key] = (values[key] || 0) + 1;
  }
  let norm = 0;
  for (const value of Object.values(values)) norm += value * value;
  return { values, norm: Math.sqrt(norm) || 0 };
}

function cosineScore(left, right) {
  if (!left?.norm || !right?.norm) return 0;
  const leftValues = left.values || {};
  const rightValues = right.values || {};
  const [small, large] = Object.keys(leftValues).length < Object.keys(rightValues).length
    ? [leftValues, rightValues]
    : [rightValues, leftValues];
  let dot = 0;
  for (const key of Object.keys(small)) {
    if (large[key]) dot += small[key] * large[key];
  }
  return dot / (left.norm * right.norm);
}

function splitMemorySegments(content = "", meta = {}, maxChars = 1100) {
  const text = `${content || ""}`.replace(/\r/g, "\n").trim();
  if (!text) return [];
  const blocks = text
    .split(/(?=^#{1,6}\s+)/m)
    .map((block) => block.trim())
    .filter(Boolean);
  const sourceTitle = meta.file || meta.key || "记忆";
  const segments = [];

  const pushChunk = (heading, chunk) => {
    const clean = chunk.replace(/\n{3,}/g, "\n\n").trim();
    if (!clean) return;
    segments.push({
      id: `${meta.key || sourceTitle}#${segments.length + 1}`,
      scope: meta.scope || "memory",
      file: meta.file || "",
      key: meta.key || "",
      title: heading || sourceTitle,
      content: truncateForPrompt(clean, maxChars + 300)
    });
  };

  for (const block of blocks.length ? blocks : [text]) {
    const heading = block.match(/^#{1,6}\s*(.+)$/m)?.[1]?.trim() || sourceTitle;
    const paragraphs = block.split(/\n{2,}/).map((item) => item.trim()).filter(Boolean);
    let current = "";
    for (const paragraph of paragraphs) {
      const next = current ? `${current}\n\n${paragraph}` : paragraph;
      if (next.length > maxChars && current) {
        pushChunk(heading, current);
        current = paragraph;
      } else {
        current = next;
      }
    }
    if (current) pushChunk(heading, current);
  }
  return segments;
}

function indexMetadataFromDocs(docs = []) {
  return docs.map((doc) => ({
    key: doc.key,
    file: doc.file,
    scope: doc.scope,
    size: doc.size || 0,
    updatedAt: doc.updatedAt || ""
  }));
}

function isMemoryIndexFresh(index, docs = []) {
  const previous = JSON.stringify(index?.files || []);
  const next = JSON.stringify(indexMetadataFromDocs(docs));
  return previous === next && Array.isArray(index?.segments);
}

function buildMemoryIndex(docs = []) {
  const segments = [];
  for (const doc of docs) {
    for (const segment of splitMemorySegments(doc.content, doc)) {
      segments.push({
        ...segment,
        vector: vectorizeText(`${segment.title}\n${segment.content}`)
      });
    }
  }
  return {
    version: 1,
    builtAt: new Date().toISOString(),
    files: indexMetadataFromDocs(docs),
    segments
  };
}

function filterMemorySegments(index, query = "", options = {}) {
  const requestedTopK = options.topK ?? 8;
  if (Number(requestedTopK) <= 0) return [];
  const topK = Math.max(1, Number(requestedTopK) || 8);
  const files = new Set((options.files || []).map((item) => path.basename(`${item}`)));
  const queryVector = vectorizeText(query);
  const queryTerms = tokenizeForVector(query).slice(0, 30);
  const scored = (index?.segments || [])
    .filter((segment) => !files.size || files.has(segment.file) || files.has(segment.key))
    .map((segment) => {
      const searchable = `${segment.title}\n${segment.file}\n${segment.content}`.toLowerCase();
      const exact = queryTerms.reduce((sum, term) => sum + Math.min(countOccurrences(searchable, term), 4), 0);
      const score = cosineScore(queryVector, segment.vector) * 10 + exact * 0.16;
      return { ...segment, score };
    })
    .sort((a, b) => b.score - a.score);
  const positive = scored.filter((item) => item.score > 0);
  return (positive.length ? positive : scored).slice(0, topK);
}

function formatMemoryRecall(title, segments = [], maxChars = 3000) {
  if (!segments.length || maxChars <= 0) return "";
  const parts = [`# ${title}`];
  let remaining = maxChars;
  for (const segment of segments) {
    if (remaining <= 0) break;
    const block = [
      `\n\n## ${segment.scope}:${segment.file} / ${segment.title}`,
      `相关度：${Number(segment.score || 0).toFixed(2)}`,
      "",
      segment.content
    ].join("\n");
    parts.push(truncateForPrompt(block, remaining));
    remaining -= block.length;
  }
  return truncateForPrompt(parts.join("\n"), maxChars);
}

module.exports = {
  tokenizeForVector,
  hashToken,
  vectorizeText,
  cosineScore,
  splitMemorySegments,
  indexMetadataFromDocs,
  isMemoryIndexFresh,
  buildMemoryIndex,
  filterMemorySegments,
  formatMemoryRecall
};
