#!/usr/bin/env node
// @ts-check

// docx skill — preview.js
// 两档预览：
//   1) 装了 LibreOffice → docx 转 PDF，最高保真（原汁原味）→ { pdfPath, usedBackend:"libreoffice" }
//   2) 没装 → mammoth docx→HTML 兜底（纯 JS，零依赖，~85% 保真）→ { htmlPath, usedBackend:"mammoth" }
// 这样没装 LibreOffice 也能预览 docx，不再一律弹"请安装"。
//
// 入参：{ inputPath, outputDir, timeoutMs? }

const fs = require("node:fs");
const path = require("node:path");
const { locateSoffice, convertToPdf } = require("../../_lib/libreoffice");

main().catch((err) => fail("CONVERT_FAILED", err.message || String(err), err));

async function main() {
  const params = await readParams();
  validateParams(params);

  const soffice = locateSoffice();
  if (soffice) {
    const pdfPath = await convertToPdf(soffice, params.inputPath, params.outputDir, params.timeoutMs || 30_000);
    return emit({ ok: true, pdfPath, usedBackend: "libreoffice" });
  }

  // 兜底：mammoth docx → HTML（图片内联 base64），写到 outputDir。
  const mammoth = require("mammoth");
  const buffer = fs.readFileSync(params.inputPath);
  const result = await mammoth.convertToHtml({ buffer });
  const html = wrapHtml(result.value || "");
  fs.mkdirSync(params.outputDir, { recursive: true });
  const base = path.basename(params.inputPath, path.extname(params.inputPath));
  const htmlPath = path.join(params.outputDir, `${base}.html`);
  fs.writeFileSync(htmlPath, html, "utf8");
  emit({ ok: true, htmlPath, usedBackend: "mammoth", fidelity: "approximate" });
}

// 给 mammoth 的裸 HTML 套一层带 CJK 字体与排版样式的文档壳。
function wrapHtml(bodyHtml) {
  const font = '"PingFang SC", "Microsoft YaHei", "Hiragino Sans GB", "Noto Sans CJK SC", sans-serif';
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><style>
    body{font-family:${font};font-size:14px;line-height:1.7;color:#1a1a1a;max-width:820px;margin:24px auto;padding:0 24px;}
    h1,h2,h3,h4{font-weight:700;line-height:1.3;margin:1.1em 0 .5em;}
    table{border-collapse:collapse;width:100%;margin:.9em 0;}
    th,td{border:1px solid #ccc;padding:.4em .7em;text-align:left;}
    th{background:#eaeaea;}
    img{max-width:100%;height:auto;}
    blockquote{margin:.8em 0;padding:.4em 1em;border-left:4px solid #c8c8c8;color:#555;background:#fafafa;}
  </style></head><body>${bodyHtml}</body></html>`;
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
  if (!fs.existsSync(params.inputPath)) fail("INPUT_INVALID", `inputPath 不存在：${params.inputPath}`);
  if (!params.outputDir || typeof params.outputDir !== "string") fail("INPUT_INVALID", "outputDir 必填。");
  if (!path.isAbsolute(params.outputDir)) fail("INPUT_INVALID", "outputDir 必须是绝对路径。");
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
