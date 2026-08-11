#!/usr/bin/env node
// @ts-check

// docx skill — validate.js
// 验证一个 .docx 文件结构是否合法：
//   1. 文件存在且非空。
//   2. mammoth 能成功打开（说明 zip 合法、word/document.xml 存在、XML 可解析）。
//   3. mammoth 提取到的文本非空（说明文档不是空壳）。
//
// 更严格的 OOXML schema 校验在 v1 之后叠加（依赖 Python lxml + schema 文件）。

const fs = require("node:fs");
const path = require("node:path");
const mammoth = require("mammoth");

main().catch((err) => fail("UNDERLYING_LIB", err.message || String(err), err));

async function main() {
  const params = await readParams();
  validateParams(params);

  const errors = [];
  const warnings = [];

  if (!fs.existsSync(params.inputPath)) {
    errors.push({ code: "FILE_MISSING", message: `文件不存在：${params.inputPath}` });
    return emitFinal(errors, warnings);
  }

  const stat = fs.statSync(params.inputPath);
  if (stat.size === 0) {
    errors.push({ code: "FILE_EMPTY", message: "文件大小为 0。" });
    return emitFinal(errors, warnings);
  }

  try {
    const buffer = fs.readFileSync(params.inputPath);
    const result = await mammoth.extractRawText({ buffer });
    if (!result.value || result.value.trim().length === 0) {
      warnings.push("文档可被解析，但提取不到正文文本（可能只有图片或空段落）。");
    }
    for (const msg of result.messages || []) {
      if (msg.type === "warning") warnings.push(msg.message);
      else if (msg.type === "error") errors.push({ code: "PARSE_ERROR", message: msg.message });
    }
  } catch (err) {
    errors.push({ code: "OPEN_FAILED", message: err.message || String(err) });
  }

  emitFinal(errors, warnings);
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

function emitFinal(errors, warnings) {
  emit({ ok: errors.length === 0, errors, warnings });
  process.exit(errors.length === 0 ? 0 : 1);
}

function emit(payload) {
  process.stdout.write(JSON.stringify(payload));
  process.stdout.write("\n");
}

function fail(code, message, cause) {
  emit({
    ok: false,
    errors: [{ code, message, cause: cause ? String(cause?.stack || cause) : undefined }],
    warnings: []
  });
  process.exit(1);
}
