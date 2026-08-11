#!/usr/bin/env node
// @ts-check

// pdf skill — create.js
// 把一个 .docx 渲染成 PDF。设计取舍：PDF = "docx 渲染结果"，不重写排版 ——
// 这样 PDF 自动继承 docx skill 的全部质量（中文字体分槽、表格双宽度、TOC、页眉页脚）。
//
// 入参：{ inputPath: <docx 绝对路径>, outputPath: <pdf 绝对路径>, timeoutMs? }
// 出参：{ ok, outputPath, bytes }
//
// 上层 orchestration 负责先用 docx skill 把 markdown 生成 docx，再调本 skill 转 PDF。
//
// 错误码：
//   DEP_MISSING     未检测到 LibreOffice（由 SkillsService 依赖 gate 优先拦截；这里兜底）
//   INPUT_INVALID   参数不合法
//   SCOPE_VIOLATION outputPath 越界
//   CONVERT_FAILED  LibreOffice 转换失败

const fs = require("node:fs");
const path = require("node:path");
const { locateSoffice, convertToPdf, MISSING_HINT } = require("../../_lib/libreoffice");

main().catch((err) => fail("CONVERT_FAILED", err.message || String(err), err));

async function main() {
  const params = await readParams();
  validateParams(params);
  enforceScope(params.outputPath);

  const soffice = locateSoffice();
  if (!soffice) {
    fail("DEP_MISSING", "未检测到 LibreOffice，无法生成 PDF。", null, { missingHint: MISSING_HINT });
  }

  // LibreOffice 输出文件名 = basename(input).pdf 到 outputDir；
  // 与请求的 outputPath 可能不同名，转换后改名到 outputPath。
  const outputDir = path.dirname(params.outputPath);
  const producedPdf = await convertToPdf(soffice, params.inputPath, outputDir, params.timeoutMs || 30_000);
  if (path.resolve(producedPdf) !== path.resolve(params.outputPath)) {
    fs.renameSync(producedPdf, params.outputPath);
  }

  const stat = fs.statSync(params.outputPath);
  emit({ ok: true, outputPath: params.outputPath, bytes: stat.size });
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
  if (!params.inputPath || typeof params.inputPath !== "string") fail("INPUT_INVALID", "inputPath 必填（docx 绝对路径）。");
  if (!path.isAbsolute(params.inputPath)) fail("INPUT_INVALID", "inputPath 必须是绝对路径。");
  if (!fs.existsSync(params.inputPath)) fail("INPUT_INVALID", `inputPath 不存在：${params.inputPath}`);
  if (!params.outputPath || typeof params.outputPath !== "string") fail("INPUT_INVALID", "outputPath 必填。");
  if (!path.isAbsolute(params.outputPath)) fail("INPUT_INVALID", "outputPath 必须是绝对路径。");
}

function enforceScope(outputPath) {
  const allow = process.env.YAOGUO_SCOPE_ALLOW;
  if (!allow) return;
  const allowed = allow.split(":").filter(Boolean).map((p) => path.resolve(p));
  const target = path.resolve(outputPath);
  const ok = allowed.some((root) => target === root || target.startsWith(root + path.sep));
  if (!ok) {
    fail("SCOPE_VIOLATION", `outputPath ${outputPath} 不在允许写入的范围内：${allowed.join(", ")}`);
  }
}

function emit(payload) {
  process.stdout.write(JSON.stringify(payload));
  process.stdout.write("\n");
}

function fail(code, message, cause, extra = {}) {
  emit({
    ok: false,
    error: { code, message, cause: cause ? String(cause?.stack || cause) : undefined, ...extra }
  });
  process.exit(1);
}
