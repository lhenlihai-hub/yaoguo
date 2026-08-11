#!/usr/bin/env node
// @ts-check

// pdf skill — validate.js
// 校验一个 PDF 是否合法：文件存在、非空、以 %PDF- 魔数开头。

const fs = require("node:fs");
const path = require("node:path");

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

  const fd = fs.openSync(params.inputPath, "r");
  try {
    const head = Buffer.alloc(5);
    fs.readSync(fd, head, 0, 5, 0);
    if (head.toString("latin1") !== "%PDF-") {
      errors.push({ code: "BAD_MAGIC", message: "文件头不是 %PDF-，可能不是合法 PDF。" });
    }
  } finally {
    fs.closeSync(fd);
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
  if (!params.inputPath || typeof params.inputPath !== "string") fail("INPUT_INVALID", "inputPath 必填。");
  if (!path.isAbsolute(params.inputPath)) fail("INPUT_INVALID", "inputPath 必须是绝对路径。");
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
  emit({ ok: false, errors: [{ code, message, cause: cause ? String(cause?.stack || cause) : undefined }], warnings: [] });
  process.exit(1);
}
