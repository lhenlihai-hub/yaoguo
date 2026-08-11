#!/usr/bin/env node
// @ts-check

// pptx skill — preview.js
// LibreOffice headless 把 pptx 转 PDF 供 iframe 预览。转换逻辑共享自 _lib/libreoffice.js。

const fs = require("node:fs");
const path = require("node:path");
const { locateSoffice, convertToPdf, MISSING_HINT } = require("../../_lib/libreoffice");

main().catch((err) => fail("CONVERT_FAILED", err.message || String(err), err));

async function main() {
  const params = await readParams();
  validateParams(params);

  const soffice = locateSoffice();
  if (!soffice) {
    fail("DEP_MISSING", "未检测到 LibreOffice，无法预览幻灯片。", null, { missingHint: MISSING_HINT });
  }

  const pdfPath = await convertToPdf(soffice, params.inputPath, params.outputDir, params.timeoutMs || 30_000);
  emit({ ok: true, pdfPath, usedBackend: "libreoffice" });
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
  if (!fs.existsSync(params.inputPath)) fail("INPUT_INVALID", `inputPath 不存在：${params.inputPath}`);
  if (!params.outputDir || typeof params.outputDir !== "string") fail("INPUT_INVALID", "outputDir 必填。");
  if (!path.isAbsolute(params.outputDir)) fail("INPUT_INVALID", "outputDir 必须是绝对路径。");
}

function emit(payload) {
  process.stdout.write(JSON.stringify(payload));
  process.stdout.write("\n");
}

function fail(code, message, cause, extra = {}) {
  emit({ ok: false, error: { code, message, cause: cause ? String(cause?.stack || cause) : undefined, ...extra } });
  process.exit(1);
}
