import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  ContextResultStore,
  serializeContextResult
} = require("../src/platform/context/contextResultStore.js");
const {
  executeReadContextResult,
  READ_CONTEXT_RESULT_TOOL_SCHEMA
} = require("../src/platform/ai/agentTools/readContextResultTool.js");

test("ContextResultStore 小结果内联完整内容并生成稳定引用", async () => {
  const store = new ContextResultStore({ inlineChars: 100, previewChars: 20 });
  const first = await store.save({
    toolName: "lookup",
    callId: "call-1",
    value: { z: 2, a: "已验证" }
  });
  const second = await store.save({
    toolName: "another-tool",
    callId: "call-2",
    value: { a: "已验证", z: 2 }
  });

  assert.equal(first.resultRef, second.resultRef, "内容引用不应受 JSON 键顺序、工具名或调用 id 影响");
  assert.equal(first.deduplicated, false);
  assert.equal(second.deduplicated, true);
  assert.equal(first.inline, true);
  assert.equal(first.truncated, false);
  assert.equal(first.nextOffset, null);
  assert.deepEqual(JSON.parse(first.preview), { a: "已验证", z: 2 });

  const page = await store.read({ resultRef: first.resultRef });
  assert.equal(page.ok, true);
  assert.equal(page.content, first.preview);
  assert.equal(page.totalChars, first.preview.length);
  assert.equal(page.truncated, false);
});

test("ContextResultStore 大结果只返回显式标记的预览，分页可无损重组原文", async () => {
  const source = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const store = new ContextResultStore({
    inlineChars: 12,
    previewChars: 8,
    defaultReadChars: 7,
    maxReadChars: 10
  });
  const saved = await store.save({ toolName: "fetch", callId: "call-large", value: source });

  assert.equal(saved.inline, false);
  assert.equal(saved.preview, source.slice(0, 8));
  assert.equal(saved.truncated, true);
  assert.equal(saved.nextOffset, 8);
  assert.deepEqual(saved.compact, {
    resultRef: saved.resultRef,
    contentType: "text",
    totalChars: source.length,
    totalTokens: saved.totalTokens,
    preview: source.slice(0, 8),
    offsetChars: 0,
    truncated: true,
    nextOffset: 8
  });

  const parts = [];
  let offsetChars = 0;
  do {
    const page = await store.read({ resultRef: saved.resultRef, offsetChars, maxChars: 7 });
    assert.equal(page.ok, true);
    parts.push(page.content);
    if (!page.truncated) break;
    assert.equal(page.nextOffset, offsetChars + page.content.length);
    offsetChars = page.nextOffset;
  } while (offsetChars < source.length);
  assert.equal(parts.join(""), source, "分页必须无损恢复完整结果");
});

test("ContextResultStore 持久化后可由新实例读回完整结果", async () => {
  const directory = mkdtempSync(join(tmpdir(), "yaoguo-context-results-"));
  try {
    const writer = new ContextResultStore({ directory, inlineChars: 10, previewChars: 5 });
    const source = "持久化正文".repeat(50);
    const saved = await writer.save({ toolName: "archive", callId: "call-persist", value: source });
    const reader = new ContextResultStore({ directory, defaultReadChars: 1000 });
    const restored = await reader.read({ resultRef: saved.resultRef });

    assert.equal(restored.ok, true);
    assert.equal(restored.content, source);
    assert.equal(restored.totalChars, source.length);
    assert.equal(restored.truncated, false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("ContextResultStore cleanup 清除 turn 临时原文与内存索引", async () => {
  const parent = mkdtempSync(join(tmpdir(), "yaoguo-context-cleanup-"));
  const directory = join(parent, "turn-1");
  try {
    const store = new ContextResultStore({ directory });
    const saved = await store.save({ toolName: "fetch", callId: "secret", value: "sensitive result" });
    assert.equal((await store.read({ resultRef: saved.resultRef })).ok, true);
    assert.equal(existsSync(directory), true);

    await store.cleanup();

    assert.equal(existsSync(directory), false);
    assert.equal((await store.read({ resultRef: saved.resultRef })).ok, false);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("ContextResultStore 拒绝路径穿越与符号链接引用", async () => {
  const root = mkdtempSync(join(tmpdir(), "yaoguo-context-safe-"));
  const outside = join(tmpdir(), `yaoguo-sensitive-${process.pid}.txt`);
  writeFileSync(outside, "TOP-SECRET", "utf8");
  try {
    const store = new ContextResultStore({ directory: root });
    for (const resultRef of ["../../etc/passwd", "/etc/passwd", "ctxr_../settings.json", "file:///etc/passwd"]) {
      const result = await store.read({ resultRef });
      assert.equal(result.ok, false);
      assert.ok(!JSON.stringify(result).includes("TOP-SECRET"));
    }

    const forgedRef = `ctxr_${"a".repeat(64)}`;
    symlinkSync(outside, join(root, `${forgedRef}.json`));
    const linked = await store.read({ resultRef: forgedRef });
    assert.equal(linked.ok, false, "符号链接不能被当作结果文件读取");
    assert.ok(!JSON.stringify(linked).includes("TOP-SECRET"));
    assert.equal(readFileSync(outside, "utf8"), "TOP-SECRET");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { force: true });
  }
});

test("read_context_result 工具只通过 ctx store 分页回读", async () => {
  assert.deepEqual(READ_CONTEXT_RESULT_TOOL_SCHEMA.function.parameters.required, ["resultRef"]);
  assert.equal("path" in READ_CONTEXT_RESULT_TOOL_SCHEMA.function.parameters.properties, false);

  const missing = await executeReadContextResult({ resultRef: "ctxr_x" }, {});
  assert.equal(missing.ok, false);
  assert.match(missing.error, /contextResultStore/);

  const store = new ContextResultStore({ inlineChars: 4, previewChars: 2 });
  const saved = await store.save({ toolName: "search", callId: "c1", value: "abcdefghij" });
  const page = await executeReadContextResult(
    { resultRef: saved.resultRef, offsetChars: 3, maxChars: 4 },
    { contextResultStore: store }
  );
  assert.equal(page.ok, true);
  assert.equal(page.content, "defg");
  assert.equal(page.totalChars, 10);
  assert.equal(page.truncated, true);
  assert.equal(page.nextOffset, 7);
});

test("serializeContextResult 保留字符串原文并拒绝循环 JSON", () => {
  assert.deepEqual(serializeContextResult(" a\n b "), {
    contentType: "text",
    content: " a\n b "
  });
  const circular = {};
  circular.self = circular;
  assert.throws(() => serializeContextResult(circular), /循环引用/);
});
