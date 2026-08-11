#!/usr/bin/env node
// @ts-check

// xlsx skill — validate.js
// xlsx 是 ZIP（OOXML）。校验：存在、非空、以 PK 魔数开头。

const fs = require("node:fs");
const path = require("node:path");
const ExcelJS = require("exceljs");

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

  // PK 魔数快筛
  const fd = fs.openSync(params.inputPath, "r");
  try {
    const head = Buffer.alloc(2);
    fs.readSync(fd, head, 0, 2, 0);
    if (head.toString("latin1") !== "PK") {
      errors.push({ code: "BAD_MAGIC", message: "文件头不是 PK（ZIP/OOXML），可能不是合法 xlsx。" });
      return emitFinal(errors, warnings);
    }
  } finally {
    fs.closeSync(fd);
  }

  // 真读 workbook：能解析 + 至少 1 个工作表，才算合法（坏结构在这里被抓）。
  try {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(params.inputPath);
    if (!wb.worksheets || wb.worksheets.length === 0) {
      errors.push({ code: "BAD_WORKBOOK", message: "workbook 不含任何工作表。" });
    }
  } catch (e) {
    errors.push({ code: "BAD_WORKBOOK", message: `workbook 解析失败：${e.message || e}` });
  }

  emitFinal(errors, warnings);
}

function readParams() {
  return new Promise((resolve, reject) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => { buf += c; });
    process.stdin.on("end", () => { try { resolve(JSON.parse(buf || "{}")); } catch (e) { reject(new Error(`stdin 不是合法 JSON: ${e.message}`)); } });
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
  process.exitCode = errors.length === 0 ? 0 : 1;
}

function emit(payload) {
  process.stdout.write(JSON.stringify(payload));
  process.stdout.write("\n");
}

function fail(code, message, cause) {
  emit({ ok: false, errors: [{ code, message, cause: cause ? String(cause?.stack || cause) : undefined }], warnings: [] });
  process.exit(1);
}
