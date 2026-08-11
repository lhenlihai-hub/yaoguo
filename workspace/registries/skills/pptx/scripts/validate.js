#!/usr/bin/env node
// @ts-check

// pptx skill — validate.js
// pptx 是 ZIP（OOXML）。本脚本校验容器、核心部件和幻灯片数量；跨格式内容策略由宿主统一执行。

const fs = require("node:fs");
const path = require("node:path");
const JSZip = require("jszip");

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
    const head = Buffer.alloc(2);
    fs.readSync(fd, head, 0, 2, 0);
    if (head.toString("latin1") !== "PK") {
      errors.push({ code: "BAD_MAGIC", message: "文件头不是 PK（ZIP/OOXML），可能不是合法 pptx。" });
    }
  } finally {
    fs.closeSync(fd);
  }

  if (errors.length) return emitFinal(errors, warnings);

  let zip;
  try {
    zip = await JSZip.loadAsync(fs.readFileSync(params.inputPath));
  } catch (error) {
    errors.push({ code: "BAD_ZIP", message: `无法读取 PPTX 容器：${error.message}` });
    return emitFinal(errors, warnings);
  }

  for (const required of ["[Content_Types].xml", "ppt/presentation.xml"]) {
    if (!zip.file(required)) {
      errors.push({ code: "OOXML_PART_MISSING", message: `PPTX 缺少核心部件：${required}` });
    }
  }
  const slides = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort();
  if (!slides.length) {
    errors.push({ code: "SLIDES_MISSING", message: "PPTX 中没有幻灯片页面。" });
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
