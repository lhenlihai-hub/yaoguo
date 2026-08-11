#!/usr/bin/env node
// @ts-check

// docx skill — read.js
// 子进程入口：stdin 读 JSON params，stdout 输出 JSON 结果。
// 入参/出参契约见同目录 instructions.md §一。
//
// 默认走 mammoth（纯 JS，跨平台）。后续可叠 pandoc / LibreOffice。

const fs = require("node:fs");
const path = require("node:path");
const mammoth = require("mammoth");

main().catch((err) => fail("UNDERLYING_LIB", err.message || String(err), err));

async function main() {
  const params = await readParams();
  validateParams(params);

  if (!fs.existsSync(params.inputPath)) {
    fail("INPUT_INVALID", `inputPath 不存在：${params.inputPath}`);
  }

  const buffer = fs.readFileSync(params.inputPath);
  const warnings = [];

  const mdResult = await mammoth.convertToMarkdown({ buffer });
  const rawResult = await mammoth.extractRawText({ buffer });

  for (const msg of mdResult.messages || []) {
    if (msg.type === "warning") warnings.push(msg.message);
  }

  const markdown = mdResult.value || "";
  const rawText = rawResult.value || "";

  emit({
    ok: true,
    usedBackend: "mammoth",
    markdown,
    structure: analyzeStructure(markdown, rawText),
    warnings
  });
}

function readParams() {
  return new Promise((resolve, reject) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { buf += chunk; });
    process.stdin.on("end", () => {
      try { resolve(JSON.parse(buf || "{}")); }
      catch (err) { reject(new Error(`stdin 不是合法 JSON: ${err.message}`)); }
    });
    process.stdin.on("error", reject);
  });
}

function validateParams(params) {
  if (!params || typeof params !== "object") fail("INPUT_INVALID", "params 必须是对象。");
  if (!params.inputPath || typeof params.inputPath !== "string") {
    fail("INPUT_INVALID", "inputPath 必须是字符串。");
  }
  if (!path.isAbsolute(params.inputPath)) {
    fail("INPUT_INVALID", "inputPath 必须是绝对路径。");
  }
}

function analyzeStructure(markdown, rawText) {
  const headings = [];
  const lines = markdown.split("\n");
  for (const line of lines) {
    const match = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (match) headings.push({ level: match[1].length, text: match[2] });
  }
  const tables = (markdown.match(/^\|.+\|$/gm) || []).length > 0
    ? Math.max(0, ((markdown.match(/(^|\n)\|[^\n]+\n\|[-:\s|]+\|/g) || []).length))
    : 0;
  const images = (markdown.match(/!\[[^\]]*\]\([^)]+\)/g) || []).length;
  const wordCount = rawText.split(/\s+/).filter(Boolean).length;
  return { headings, tables, images, wordCount };
}

function emit(payload) {
  process.stdout.write(JSON.stringify(payload));
  process.stdout.write("\n");
}

function fail(code, message, cause) {
  emit({
    ok: false,
    error: { code, message, cause: cause ? String(cause?.stack || cause) : undefined }
  });
  process.exit(1);
}
