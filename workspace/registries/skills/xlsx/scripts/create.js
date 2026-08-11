#!/usr/bin/env node
// @ts-check

// xlsx skill — create.js
// markdown → xlsx 工作簿（exceljs，纯 JS，零外部依赖）。
//
// 映射约定：
//   - markdown 里每个表格 → 一个工作表（表头加粗、冻结首行、列宽按内容自适应）
//   - 多个表格 → 多个 sheet（Sheet1/Sheet2…，或就近的标题作 sheet 名）
//   - 没有表格 → 把正文按行落到一个 "正文" 表（每行一格），保证总有可用输出
//
// xlsx 适合"内容里有表格/数据"的场景；纯散文导 xlsx 价值有限，但仍给出可用结果。
//
// 入参：{ source:{markdown}, outputPath, options:{title?} }
// 出参：{ ok, outputPath, bytes, sheets, warnings }

const fs = require("node:fs");
const path = require("node:path");
const ExcelJS = require("exceljs");
const { marked } = require("marked");

main().catch((err) => fail("UNDERLYING_LIB", err.message || String(err), err));

async function main() {
  const params = await readParams();
  validateParams(params);
  enforceScope(params.outputPath);

  const markdown = params.source?.markdown;
  if (typeof markdown !== "string") fail("INPUT_INVALID", "source.markdown 必须是字符串。");

  const warnings = [];
  const tokens = marked.lexer(markdown);
  const tables = collectTables(tokens);

  const wb = new ExcelJS.Workbook();
  wb.creator = "腰果";
  wb.created = new Date();

  if (tables.length > 0) {
    tables.forEach((tbl, i) => addTableSheet(wb, tbl, i, warnings));
  } else {
    warnings.push("内容里没有表格，已把正文按行落到「正文」表。");
    addPlainTextSheet(wb, markdown);
  }

  fs.mkdirSync(path.dirname(params.outputPath), { recursive: true });
  await wb.xlsx.writeFile(params.outputPath);
  const bytes = fs.statSync(params.outputPath).size;

  emit({ ok: true, outputPath: params.outputPath, bytes, sheets: wb.worksheets.length, warnings });
}

// 收集 markdown 里所有表格，并记住每个表格前最近的标题作 sheet 名。
function collectTables(tokens) {
  const tables = [];
  let lastHeading = "";
  for (const token of tokens) {
    if (token.type === "heading") lastHeading = plainText(token);
    else if (token.type === "table") {
      tables.push({
        name: lastHeading,
        header: token.header.map(plainText),
        rows: token.rows.map((r) => r.map(plainText))
      });
    }
  }
  return tables;
}

function addTableSheet(wb, tbl, index, warnings) {
  const sheetName = safeSheetName(tbl.name || `表 ${index + 1}`, index, wb);
  const ws = wb.addWorksheet(sheetName);
  ws.addRow(tbl.header);
  const headerRow = ws.getRow(1);
  headerRow.font = { bold: true };
  headerRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEAEAEA" } };
  // 单元格类型推断：数字/百分比/日期写成可计算/可筛选的真值，而不是一律字符串。
  for (const row of tbl.rows) {
    const wsRow = ws.addRow(row.map(() => null));
    row.forEach((raw, i) => applyTypedCell(wsRow.getCell(i + 1), raw));
  }
  ws.views = [{ state: "frozen", ySplit: 1 }];
  // autoFilter 让用户在 Excel 里直接筛选 / 排序（"可用 Excel"而不仅是"能打开"）。
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: tbl.header.length } };
  autoFitColumns(ws, tbl.header.length);
  if (tbl.rows.some((r) => r.length !== tbl.header.length)) {
    warnings.push(`表「${sheetName}」存在列数不齐的行。`);
  }
}

// 把字符串单元格按内容推断成 Number(含百分比格式) / Date / 文本。
function applyTypedCell(cell, raw) {
  const s = `${raw == null ? "" : raw}`.trim();
  if (s === "") { cell.value = null; return; }

  // 百分比："12%" / "3.5%" → 0.12 + 百分比显示格式
  const pct = s.match(/^([+-]?\d+(?:\.\d+)?)\s*%$/);
  if (pct) {
    cell.value = Number(pct[1]) / 100;
    cell.numFmt = "0.0%";
    return;
  }
  // 纯数字（可带千分位逗号 / 货币符号）
  const numStr = s.replace(/[,，]/g, "");
  if (/^[+-]?\d+(?:\.\d+)?$/.test(numStr)) {
    cell.value = Number(numStr);
    return;
  }
  // 日期：YYYY-MM-DD / YYYY/MM/DD
  const dm = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (dm) {
    const d = new Date(Number(dm[1]), Number(dm[2]) - 1, Number(dm[3]));
    if (!Number.isNaN(d.getTime())) { cell.value = d; cell.numFmt = "yyyy-mm-dd"; return; }
  }
  cell.value = s;
}

function addPlainTextSheet(wb, markdown) {
  const ws = wb.addWorksheet("正文");
  const lines = `${markdown}`.split("\n");
  for (const line of lines) ws.addRow([line]);
  ws.getColumn(1).width = 80;
}

function autoFitColumns(ws, colCount) {
  for (let c = 1; c <= colCount; c += 1) {
    const col = ws.getColumn(c);
    let max = 8;
    col.eachCell({ includeEmpty: false }, (cell) => {
      const len = displayWidth(`${cell.value == null ? "" : cell.value}`);
      if (len > max) max = len;
    });
    col.width = Math.min(60, max + 2);
  }
}

// 中文按 2 宽估算列宽。
function displayWidth(s) {
  let w = 0;
  for (const ch of s) w += ch.charCodeAt(0) > 255 ? 2 : 1;
  return w;
}

// Excel sheet 名 ≤31 字符，不能含 \ / ? * [ ] :，不能重名。
function safeSheetName(raw, index, wb) {
  let name = `${raw || ""}`.replace(/[\\/?*[\]:]/g, " ").trim().slice(0, 28) || `表 ${index + 1}`;
  let candidate = name;
  let n = 2;
  while (wb.worksheets.some((w) => w.name === candidate)) {
    candidate = `${name.slice(0, 25)} ${n}`;
    n += 1;
  }
  return candidate;
}

function plainText(token) {
  if (token == null) return "";
  if (typeof token === "string") return token;
  if (typeof token.text === "string" && (!token.tokens || token.tokens.length === 0)) return token.text;
  if (Array.isArray(token.tokens)) return token.tokens.map(plainText).join("");
  return `${token.text || ""}`;
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
  if (!params.outputPath || typeof params.outputPath !== "string") fail("INPUT_INVALID", "outputPath 必填。");
  if (!path.isAbsolute(params.outputPath)) fail("INPUT_INVALID", "outputPath 必须是绝对路径。");
  if (!params.source || typeof params.source !== "object") fail("INPUT_INVALID", "source 必填。");
}

function enforceScope(outputPath) {
  const allow = process.env.YAOGUO_SCOPE_ALLOW;
  if (!allow) return;
  const allowed = allow.split(":").filter(Boolean).map((p) => path.resolve(p));
  const target = path.resolve(outputPath);
  if (!allowed.some((root) => target === root || target.startsWith(root + path.sep))) {
    fail("SCOPE_VIOLATION", `outputPath ${outputPath} 不在允许写入的范围内：${allowed.join(", ")}`);
  }
}

function emit(payload) {
  process.stdout.write(JSON.stringify(payload));
  process.stdout.write("\n");
}

function fail(code, message, cause) {
  emit({ ok: false, error: { code, message, cause: cause ? String(cause?.stack || cause) : undefined } });
  process.exit(1);
}
