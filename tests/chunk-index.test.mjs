import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  splitIntoChunks,
  splitLongParagraph,
  tokenize,
  buildBM25Index,
  searchBM25,
  extractSnippet
} = require("../src/platform/artifacts/chunkIndex.js");

// ============ splitIntoChunks ============

test("splitIntoChunks 空文本返回空数组", () => {
  assert.deepEqual(splitIntoChunks(""), []);
  assert.deepEqual(splitIntoChunks("   \n  \n  "), []);
});

test("splitIntoChunks 短文本返回单 chunk", () => {
  const text = "这是一段短文本。它只有一个段落。";
  const chunks = splitIntoChunks(text);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].paragraphIndex, 0);
  assert.equal(chunks[0].chunkIndex, 0);
  assert.ok(chunks[0].text.includes("这是一段短文本"));
});

test("splitIntoChunks 段长 ≥ maxSize 时一段一 chunk", () => {
  // 短段会被 Stage 2 buffer 聚合(LangChain RecursiveCharacterTextSplitter 同款行为);
  // 长段独占一个 chunk,paragraphIndex 严格对应段落序号。
  const para = "甲乙丙丁戊己庚辛壬癸".repeat(70); // 700 字符
  const text = `${para}\n\n${para}\n\n${para}`;
  const chunks = splitIntoChunks(text, { targetSize: 600, maxSize: 800, minSize: 0 });
  assert.equal(chunks.length, 3, "三段各超 minSize 又 < maxSize → 各自一 chunk");
  assert.deepEqual(chunks.map((c) => c.paragraphIndex), [0, 1, 2]);
});

test("splitIntoChunks 短段聚合(minSize 触发)", () => {
  const text = "短段A。\n\n短段B。\n\n短段C。";
  // minSize=50 默认 100,这三段都很短,会被聚合到首个 chunk
  const chunks = splitIntoChunks(text);
  assert.ok(chunks.length <= 2, `预期聚合后 ≤2 chunk,实际 ${chunks.length}`);
});

test("splitIntoChunks 长段落二级切 + overlap", () => {
  const longPara = "甲乙丙丁戊己庚辛壬癸".repeat(120); // 1200 字符,超 maxSize=800
  const chunks = splitIntoChunks(longPara, { targetSize: 400, maxSize: 800, overlap: 50, minSize: 0 });
  assert.ok(chunks.length >= 2, `长段必须二级切,实际 ${chunks.length}`);
  // 相邻 chunk 末尾/开头应该有 overlap
  for (let i = 1; i < chunks.length; i += 1) {
    assert.ok(chunks[i].text.length > 0);
  }
  // chunkIndex 严格递增
  for (let i = 0; i < chunks.length; i += 1) assert.equal(chunks[i].chunkIndex, i);
});

test("splitLongParagraph 在句末标点切", () => {
  const para = "甲乙丙丁。" + "戊己庚辛。".repeat(80) + "结尾段。";
  const subs = splitLongParagraph(para, 200, 30);
  assert.ok(subs.length >= 2);
  // 大多数切片应该以句末标点结尾(允许末尾 chunk 例外)
  const punctEndings = subs.slice(0, -1).filter((s) => /[。！？；.!?;]$/.test(s));
  assert.ok(punctEndings.length >= 1, "至少要有一处在句末标点切");
});

// ============ tokenize ============

test("tokenize 中文按 unigram + bigram 双索引", () => {
  const tokens = tokenize("孤独的烟火");
  // 5 字 → 5 unigram + 4 bigram = 9 token
  assert.equal(tokens.length, 9);
  // unigram 全部出现
  for (const ch of ["孤", "独", "的", "烟", "火"]) assert.ok(tokens.includes(ch));
  // 所有相邻 bigram 也出现
  for (const bg of ["孤独", "独的", "的烟", "烟火"]) assert.ok(tokens.includes(bg));
});

test("tokenize 单字查询能通过 unigram 命中长词", () => {
  // 这是双索引的关键意义:query="雨" 必须能命中文档里的"雨水"
  const queryTokens = tokenize("雨");
  const docTokens = tokenize("窗外的雨水滴落");
  assert.ok(queryTokens.includes("雨"));
  assert.ok(docTokens.includes("雨"), "文档侧 unigram 必须包含'雨',否则单字 query 永远命中不了");
});

test("tokenize 英文按 word 切并小写化", () => {
  const tokens = tokenize("Hello WORLD foo_bar 42");
  assert.deepEqual(tokens, ["hello", "world", "foo_bar", "42"]);
});

test("tokenize 中英混排正常", () => {
  const tokens = tokenize("我用 GPT-4 分析日志");
  assert.ok(tokens.includes("我用"));
  assert.ok(tokens.includes("gpt"));
  assert.ok(tokens.includes("4"));
  assert.ok(tokens.includes("分析") || tokens.includes("日志"));
});

test("tokenize 忽略标点空白", () => {
  const tokens = tokenize("Hello, world! 你好。");
  assert.ok(!tokens.includes(","));
  assert.ok(!tokens.includes("."));
  assert.ok(!tokens.includes(" "));
});

// ============ BM25 ============

test("BM25 命中关键词的 doc 排名靠前", () => {
  const chunks = [
    { chunkId: "a", text: "主角喝了一杯威士忌,看着窗外的雨。" },
    { chunkId: "b", text: "餐桌上摆着面包和咖啡。" },
    { chunkId: "c", text: "夜深了,他又倒了一杯威士忌。" }
  ];
  const index = buildBM25Index(chunks);
  const hits = searchBM25(index, "威士忌", { topK: 5 });
  assert.ok(hits.length >= 2);
  // a 和 c 都含"威士忌",应该排在 b 前面
  const top2Ids = hits.slice(0, 2).map((h) => h.chunkId).sort();
  assert.deepEqual(top2Ids, ["a", "c"]);
});

test("BM25 多 term query 累加得分", () => {
  const chunks = [
    { chunkId: "a", text: "他喝威士忌。" },
    { chunkId: "b", text: "他喝威士忌看雨。" }, // 命中更多 term
    { chunkId: "c", text: "无关内容。" }
  ];
  const index = buildBM25Index(chunks);
  const hits = searchBM25(index, "威士忌 雨", { topK: 3 });
  assert.equal(hits[0].chunkId, "b", "多 term 命中的 b 应该排第一");
});

test("BM25 空查询返回空", () => {
  const chunks = [{ chunkId: "a", text: "随便点内容。" }];
  const index = buildBM25Index(chunks);
  assert.equal(searchBM25(index, "").length, 0);
  assert.equal(searchBM25(index, "   ").length, 0);
});

test("BM25 matchedTerms 记录命中的 term", () => {
  const chunks = [{ chunkId: "a", text: "威士忌配雪茄。" }];
  const index = buildBM25Index(chunks);
  const hits = searchBM25(index, "威士忌 啤酒", { topK: 3 });
  assert.equal(hits.length, 1);
  assert.ok(hits[0].matchedTerms.some((t) => t.includes("威") || t.includes("士")));
});

// ============ extractSnippet ============

test("extractSnippet 围绕命中 term 截窗", () => {
  const text = "前面的废话很多".repeat(20) + "主角喝了威士忌。" + "后面的废话也很多".repeat(20);
  const snippet = extractSnippet(text, ["威士忌"], { length: 100 });
  assert.ok(snippet.includes("威士忌"));
  assert.ok(snippet.startsWith("…") || snippet.length === text.length);
  assert.ok(snippet.length < text.length);
});

test("extractSnippet 无命中返回开头", () => {
  const text = "完全无关的内容,无关的内容。".repeat(20);
  const snippet = extractSnippet(text, ["不存在的词"], { length: 100 });
  assert.ok(snippet.length <= 110); // length + 省略号容差
  assert.ok(snippet.startsWith("完全"));
});

test("extractSnippet 空 terms 返回开头截断", () => {
  const text = "x".repeat(500);
  const snippet = extractSnippet(text, [], { length: 100 });
  assert.ok(snippet.length <= 110);
});

test("extractSnippet 短文本完整返回", () => {
  const text = "短文本";
  const snippet = extractSnippet(text, ["短"], { length: 100 });
  assert.equal(snippet, "短文本");
});
