// @ts-check
// chunkIndex —— ArtifactStore 的混合检索引擎核心:切分 + BM25 + RRF + snippet。
//
// 业界对标 2025-2026:
//   - Elasticsearch / Lucene BM25 (Okapi BM25, k1=1.5, b=0.75 默认)
//   - Microsoft Bing / Vespa / Weaviate Hybrid Search:BM25 + dense vectors via RRF
//   - LangChain RecursiveCharacterTextSplitter / LlamaIndex SentenceSplitter:
//     段落硬边界优先 → 长段二切 + overlap → 短段聚合
//   - Lucene CJKAnalyzer (CJK Bigram TokenFilter):中文无词典 bigram 兜底,
//     工业级 70%+ 召回,二十年来的标配
//   - Anserini / Pyserini:BM25 默认参数实证基准
//   - Cormack et al 2009 "Reciprocal Rank Fusion outperforms Condorcet
//     and individual Rank Learning Methods" → k=60 是公认实证最优值
//
// 设计选择:
//   1. 中英双轨分词:CJK bigram + ASCII word token,覆盖中英混排文本。
//   2. BM25 经典参数 k1=1.5, b=0.75。
//   3. Hybrid 合并用 RRF (k=60):免调权重,对 BM25 (0-N) 与 cosine (-1~1) 不同量级天然鲁棒。
//   4. 切分对齐 LangChain RecursiveCharacterTextSplitter,长文本依靠段落硬边界 +
//      句末标点二级切,不需要 NLP sentence splitter (无依赖约束)。
//
// 本模块纯函数 + 一个 BM25 索引数据结构,不接触 fs;fs 部分在 artifactStore.js 调用。

const CJK_RANGE = /[一-鿿㐀-䶿豈-﫿]/;
const WORD_RANGE = /[A-Za-z0-9_]/;
const SENT_END = /[。！？；.!?;]/;

/**
 * 把一段长文本切成 chunk 数组。
 *
 * 策略(对齐 LangChain RecursiveCharacterTextSplitter):
 *   1. 按 \n\n 段落硬边界切
 *   2. 段落 ≥ maxSize → 二级切(targetSize + overlap,优先在句末标点切)
 *   3. 段落 < minSize → 与相邻段聚合(避免噪音 chunk)
 *   4. 600 字符/chunk 可覆盖一个常见语义单元，又不至于稀释 BM25 词频
 *
 * @param {string} text
 * @param {{targetSize?: number, maxSize?: number, minSize?: number, overlap?: number}} [options]
 * @returns {Array<{paragraphIndex: number, chunkIndex: number, text: string}>}
 */
function splitIntoChunks(text, options = {}) {
  const targetSize = Math.max(100, Number(options.targetSize) || 600);
  const maxSize = Math.max(targetSize, Number(options.maxSize) || 800);
  const minSize = Math.max(0, Number(options.minSize) || 100);
  const overlap = Math.max(0, Math.min(targetSize / 2, Number(options.overlap) || 50));

  const raw = `${text || ""}`.trim();
  if (!raw) return [];

  // Stage 1: 按 \n\n 切段落(允许中间含可变空白)
  const paragraphs = raw.split(/\n\s*\n+/).map((p) => p.trim()).filter(Boolean);

  // Stage 2: 段落级处理 —— 短段聚合 buffer + 长段二切。
  const chunks = [];
  let chunkIndex = 0;
  let buffer = "";
  let bufferStartPara = -1;

  const flushBuffer = () => {
    if (!buffer) return;
    chunks.push({ paragraphIndex: bufferStartPara, chunkIndex: chunkIndex++, text: buffer });
    buffer = "";
    bufferStartPara = -1;
  };

  for (let pIdx = 0; pIdx < paragraphs.length; pIdx += 1) {
    const para = paragraphs[pIdx];
    if (para.length >= maxSize) {
      // 长段:先冲掉 buffer 再二切。
      flushBuffer();
      const subChunks = splitLongParagraph(para, targetSize, overlap);
      for (const sub of subChunks) {
        chunks.push({ paragraphIndex: pIdx, chunkIndex: chunkIndex++, text: sub });
      }
      continue;
    }
    // 短/中段:与 buffer 累积,超 maxSize 前 flush。
    const candidateLen = buffer ? buffer.length + 2 + para.length : para.length;
    if (buffer && candidateLen > maxSize) flushBuffer();
    if (!buffer) {
      bufferStartPara = pIdx;
      buffer = para;
    } else {
      buffer = `${buffer}\n\n${para}`;
    }
  }
  flushBuffer();

  // Stage 3: 把过短(< minSize)的 chunk 与下一个合并,直到达 minSize 或耗尽。
  // 注意只在两个相邻 chunk 来自同一段时不影响 paragraphIndex 语义;跨段合并按首段对齐。
  if (minSize > 0 && chunks.length > 1) {
    const merged = [];
    let cur = null;
    for (const c of chunks) {
      if (!cur) { cur = { ...c }; continue; }
      if (cur.text.length < minSize) {
        cur.text = `${cur.text}\n\n${c.text}`;
      } else {
        merged.push(cur);
        cur = { ...c };
      }
    }
    if (cur) merged.push(cur);
    // 重排 chunkIndex
    return merged.map((c, idx) => ({ ...c, chunkIndex: idx }));
  }

  return chunks;
}

/**
 * 长段二切:targetSize 滑窗 + overlap,优先在 [pos + target/2, pos + target] 范围内
 * 找到句末标点切。这是 LangChain "尝试 separators by priority" 思路的简化版。
 *
 * @param {string} para
 * @param {number} targetSize
 * @param {number} overlap
 * @returns {string[]}
 */
function splitLongParagraph(para, targetSize, overlap) {
  const result = [];
  let pos = 0;
  const safety = Math.max(4, Math.floor(targetSize / 2));
  while (pos < para.length) {
    const end = Math.min(pos + targetSize, para.length);
    let cut = end;
    if (end < para.length) {
      // 在后半窗口找最靠后的句末标点
      const searchStart = pos + safety;
      let lastSent = -1;
      for (let i = searchStart; i < end; i += 1) {
        if (SENT_END.test(para[i])) lastSent = i;
      }
      if (lastSent >= 0) cut = lastSent + 1;
    }
    const piece = para.slice(pos, cut).trim();
    if (piece) result.push(piece);
    if (cut >= para.length) break;
    pos = Math.max(cut - overlap, pos + 1);
  }
  return result;
}

/**
 * 中英双轨分词。
 *   - CJK 字符:unigram + bigram 双索引(对齐 Lucene NGramTokenizer minGram=1, maxGram=2)。
 *     单字查询(如 "雨")必须能命中文档里的"雨水",所以 unigram 不能省。
 *     索引膨胀约 2x,但召回率显著提升,是 ICU/CJK 检索工业上更常见的"全召回"配置。
 *   - ASCII 字母/数字:\w+ word token
 *   - 其它(标点 / 空白 / 全角符号):忽略
 *
 * 返回小写化 term 数组。
 *
 * @param {string} text
 * @returns {string[]}
 */
function tokenize(text) {
  const clean = `${text || ""}`.toLowerCase();
  const tokens = [];
  let i = 0;
  while (i < clean.length) {
    const ch = clean[i];
    if (CJK_RANGE.test(ch)) {
      // unigram(单字查询召回必需)
      tokens.push(ch);
      // bigram(overlap,提供短语级精度)
      if (i + 1 < clean.length && CJK_RANGE.test(clean[i + 1])) {
        tokens.push(ch + clean[i + 1]);
      }
      i += 1;
    } else if (WORD_RANGE.test(ch)) {
      let j = i;
      while (j < clean.length && WORD_RANGE.test(clean[j])) j += 1;
      tokens.push(clean.slice(i, j));
      i = j;
    } else {
      i += 1;
    }
  }
  return tokens;
}

/**
 * 构建 BM25 倒排索引(in-memory)。
 *
 * @param {Array<{chunkId: string, text: string}>} chunks
 * @returns {{
 *   docs: Map<string, {tf: Map<string, number>, length: number}>,
 *   df: Map<string, number>,
 *   avgdl: number,
 *   N: number
 * }}
 */
function buildBM25Index(chunks) {
  const docs = new Map();
  const df = new Map();
  let totalLength = 0;
  for (const chunk of chunks) {
    if (!chunk?.chunkId) continue;
    const tokens = tokenize(chunk.text || "");
    const tf = new Map();
    for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
    for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1);
    docs.set(chunk.chunkId, { tf, length: tokens.length });
    totalLength += tokens.length;
  }
  return { docs, df, avgdl: docs.size > 0 ? totalLength / docs.size : 0, N: docs.size };
}

/**
 * BM25 检索。
 *
 * 公式 (Okapi BM25, Robertson & Walker 1994):
 *   score(D,Q) = Σ IDF(qi) · (f(qi,D)·(k1+1)) / (f(qi,D) + k1·(1-b+b·|D|/avgdl))
 *   IDF(qi)   = ln((N - df + 0.5) / (df + 0.5) + 1)
 *
 * k1=1.5, b=0.75 是 Elasticsearch / Lucene / Anserini 默认值。
 *
 * @param {ReturnType<typeof buildBM25Index>} index
 * @param {string} query
 * @param {{k1?: number, b?: number, topK?: number}} [options]
 * @returns {Array<{chunkId: string, score: number, matchedTerms: string[]}>}
 */
function searchBM25(index, query, options = {}) {
  const k1 = Number.isFinite(options.k1) ? Number(options.k1) : 1.5;
  const b = Number.isFinite(options.b) ? Number(options.b) : 0.75;
  const topK = Math.max(1, Number(options.topK) || 20);

  const queryTerms = Array.from(new Set(tokenize(query)));
  if (!queryTerms.length || index.N === 0) return [];

  const scores = new Map(); // chunkId → { score, matched: Set<term> }

  for (const term of queryTerms) {
    const dfTerm = index.df.get(term) || 0;
    if (dfTerm === 0) continue;
    const idf = Math.log((index.N - dfTerm + 0.5) / (dfTerm + 0.5) + 1);
    for (const [chunkId, doc] of index.docs) {
      const tf = doc.tf.get(term) || 0;
      if (tf === 0) continue;
      const norm = 1 - b + b * (doc.length / (index.avgdl || 1));
      const tfNorm = (tf * (k1 + 1)) / (tf + k1 * norm);
      const contribution = idf * tfNorm;
      const entry = scores.get(chunkId) || { score: 0, matched: new Set() };
      entry.score += contribution;
      entry.matched.add(term);
      scores.set(chunkId, entry);
    }
  }

  return Array.from(scores.entries())
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, topK)
    .map(([chunkId, v]) => ({ chunkId, score: v.score, matchedTerms: Array.from(v.matched) }));
}

/**
 * 围绕命中 term 抽取 snippet 窗口。
 *
 * 业界对标:Elasticsearch Unified Highlighter / Anthropic Citations 接口风格。
 *
 * 算法:
 *   1. 找出所有 term 在 text 中的命中位置(小写比对,保留原始大小写输出)
 *   2. 围绕首个命中聚簇开窗,合并间距 < halfLength 的相邻命中
 *   3. 截窗外补省略号 (…)
 *   4. 无命中 fallback:取文本开头一段
 *
 * @param {string} text
 * @param {string[]} queryTerms
 * @param {{length?: number}} [options]
 * @returns {string}
 */
function extractSnippet(text, queryTerms = [], options = {}) {
  const length = Math.max(60, Number(options.length) || 200);
  const halfLen = Math.floor(length / 2);
  const clean = `${text || ""}`;
  if (!clean) return "";

  const terms = Array.from(new Set((queryTerms || []).filter(Boolean).map((t) => `${t}`.toLowerCase())));
  if (!terms.length) {
    return clean.length <= length ? clean : `${clean.slice(0, length)}…`;
  }

  const lc = clean.toLowerCase();
  const hits = [];
  for (const term of terms) {
    let pos = 0;
    while (pos < lc.length) {
      const idx = lc.indexOf(term, pos);
      if (idx === -1) break;
      hits.push({ start: idx, end: idx + term.length });
      pos = idx + term.length;
    }
  }
  if (!hits.length) return clean.length <= length ? clean : `${clean.slice(0, length)}…`;

  hits.sort((a, b) => a.start - b.start);
  let winStart = Math.max(0, hits[0].start - halfLen);
  let winEnd = Math.min(clean.length, hits[0].end + halfLen);
  for (let i = 1; i < hits.length; i += 1) {
    const h = hits[i];
    if (h.start <= winEnd + halfLen) {
      winEnd = Math.min(clean.length, Math.max(winEnd, h.end + halfLen));
    } else {
      break; // 只取首个 cluster,保持 snippet 紧凑
    }
  }

  let snippet = clean.slice(winStart, winEnd);
  if (winStart > 0) snippet = `…${snippet}`;
  if (winEnd < clean.length) snippet = `${snippet}…`;
  return snippet;
}

module.exports = {
  splitIntoChunks,
  splitLongParagraph,
  tokenize,
  buildBM25Index,
  searchBM25,
  extractSnippet
};
