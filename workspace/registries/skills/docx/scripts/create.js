#!/usr/bin/env node
// @ts-check

// docx skill — create.js
// 子进程入口：stdin 读 JSON params，stdout 输出 JSON 结果。
// 入参/出参契约见同目录 instructions.md §一。
//
// 设计原则：
//   1. 失败立即抛错并以非零退出码退出，stderr 留可读信息，stdout 仍出标准 JSON。
//   2. 默认值在这里强制设定（US Letter / Arial / 12pt / 1" 边距），不依赖 docx-js 库默认。
//   3. 作用域：outputPath 必须落在 YAOGUO_SCOPE_ALLOW 之内，否则拒绝。

const fs = require("node:fs");
const path = require("node:path");

const {
  Document, Packer, Paragraph, TextRun, ExternalHyperlink,
  Table, TableRow, TableCell, ImageRun, PageBreak,
  Header, Footer, AlignmentType, PageOrientation,
  LevelFormat, HeadingLevel, BorderStyle, WidthType, ShadingType,
  TableOfContents, PageNumber
} = require("docx");
const { marked } = require("marked");

const DXA_PER_INCH = 1440;
const LETTER = { width: 12240, height: 15840 };
const A4 = { width: 11906, height: 16838 };

const DEFAULTS = {
  pageSize: "letter",
  orientation: "portrait",
  fontFamily: "Arial",      // 西文（ascii / hAnsi 槽）
  cjkFont: "宋体",           // 中文正文（eastAsia 槽）—— 必须是含 CJK 字形的字体，不能用 Arial
  cjkHeadingFont: "黑体",    // 中文标题（eastAsia 槽）
  fontSize: 12,
  margins: { top: 1, right: 1, bottom: 1, left: 1 },
  headings: "auto",
  tableOfContents: false,
  header: null,
  footer: "page-number",
  title: null,
  author: null
};

// docx 把字体分槽：ascii/hAnsi=西文，eastAsia=中日韩。
// 只设 font:"Arial" 会让 eastAsia 也变 Arial（无中文字形），中文靠渲染器替换，结果不可控。
// 必须显式给 eastAsia 一个含 CJK 字形的字体。
function buildFont(latin, cjk) {
  return { ascii: latin, hAnsi: latin, eastAsia: cjk, cs: latin };
}

main().catch((err) => fail("UNDERLYING_LIB", err.message || String(err), err));

async function main() {
  const params = await readParams();
  const options = { ...DEFAULTS, ...(params.options || {}) };
  validateParams(params);
  enforceScope(params.outputPath);

  const markdown = params.source?.markdown;
  if (typeof markdown !== "string") {
    fail("INPUT_INVALID", "source.markdown 必须是字符串。v1 暂不支持 structured 输入。");
  }

  const warnings = [];
  const tokens = marked.lexer(markdown);
  const doc = buildDocument(tokens, options, warnings);

  const buffer = await Packer.toBuffer(doc);
  fs.mkdirSync(path.dirname(params.outputPath), { recursive: true });
  fs.writeFileSync(params.outputPath, buffer);

  emit({
    ok: true,
    outputPath: params.outputPath,
    bytes: buffer.length,
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
  if (!params.outputPath || typeof params.outputPath !== "string") {
    fail("INPUT_INVALID", "outputPath 必须是字符串。");
  }
  if (!path.isAbsolute(params.outputPath)) {
    fail("INPUT_INVALID", "outputPath 必须是绝对路径。");
  }
  if (!params.source || typeof params.source !== "object") {
    fail("INPUT_INVALID", "source 必填。");
  }
}

function enforceScope(outputPath) {
  const allow = process.env.YAOGUO_SCOPE_ALLOW;
  if (!allow) return;
  const allowed = allow.split(":").filter(Boolean).map((p) => path.resolve(p));
  const target = path.resolve(outputPath);
  const ok = allowed.some((root) => target === root || target.startsWith(root + path.sep));
  if (!ok) {
    fail("SCOPE_VIOLATION",
      `outputPath ${outputPath} 不在允许写入的范围内：${allowed.join(", ")}`);
  }
}

// 模块级 warnings 引用：inline 渲染（renderImage）通过它记录"图片越界"等告警，
// 避免把 warnings 一路穿过 inlineRuns / renderInline 每一层。
let activeWarnings = null;

function buildDocument(tokens, options, warnings) {
  activeWarnings = warnings;
  const pageBase = options.pageSize === "a4" ? A4 : LETTER;
  const marginsDXA = {
    top: inchesToDXA(options.margins.top),
    right: inchesToDXA(options.margins.right),
    bottom: inchesToDXA(options.margins.bottom),
    left: inchesToDXA(options.margins.left)
  };

  const children = [];
  if (options.tableOfContents) {
    children.push(new Paragraph({
      heading: HeadingLevel.HEADING_1,
      children: [new TextRun("目录")]
    }));
    children.push(new TableOfContents("Table of Contents", {
      hyperlink: true, headingStyleRange: "1-3"
    }));
    children.push(new Paragraph({ children: [new PageBreak()] }));
  }

  for (const token of tokens) {
    appendToken(token, children, options, warnings);
  }

  return new Document({
    title: options.title || undefined,
    creator: options.author || undefined,
    styles: buildStyles(options),
    numbering: buildNumbering(),
    sections: [{
      properties: {
        page: {
          size: {
            width: pageBase.width,
            height: pageBase.height,
            orientation: options.orientation === "landscape"
              ? PageOrientation.LANDSCAPE
              : PageOrientation.PORTRAIT
          },
          margin: marginsDXA
        }
      },
      headers: options.header ? buildHeader(options.header) : undefined,
      footers: options.footer ? buildFooter(options.footer) : undefined,
      children
    }]
  });
}

function buildStyles(options) {
  const bodyFont = buildFont(options.fontFamily, options.cjkFont);
  const headingFont = buildFont(options.fontFamily, options.cjkHeadingFont);
  const halfPt = options.fontSize * 2;
  return {
    default: { document: { run: { font: bodyFont, size: halfPt } } },
    paragraphStyles: [
      { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 36, bold: true, font: headingFont },
        paragraph: { spacing: { before: 280, after: 240 }, outlineLevel: 0 } },
      { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 30, bold: true, font: headingFont },
        paragraph: { spacing: { before: 240, after: 200 }, outlineLevel: 1 } },
      { id: "Heading3", name: "Heading 3", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 26, bold: true, font: headingFont },
        paragraph: { spacing: { before: 200, after: 160 }, outlineLevel: 2 } },
      { id: "Heading4", name: "Heading 4", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 24, bold: true, italics: true, font: headingFont },
        paragraph: { spacing: { before: 160, after: 120 }, outlineLevel: 3 } }
    ]
  };
}

function buildNumbering() {
  return {
    config: [
      { reference: "bullets",
        levels: [
          { level: 0, format: LevelFormat.BULLET, text: "•", alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: { left: 720, hanging: 360 } } } },
          { level: 1, format: LevelFormat.BULLET, text: "◦", alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: { left: 1440, hanging: 360 } } } },
          { level: 2, format: LevelFormat.BULLET, text: "▪", alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: { left: 2160, hanging: 360 } } } }
        ] },
      { reference: "numbers",
        levels: [
          { level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: { left: 720, hanging: 360 } } } },
          { level: 1, format: LevelFormat.LOWER_LETTER, text: "%2.", alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: { left: 1440, hanging: 360 } } } },
          { level: 2, format: LevelFormat.LOWER_ROMAN, text: "%3.", alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: { left: 2160, hanging: 360 } } } }
        ] }
    ]
  };
}

function buildHeader(text) {
  return {
    default: new Header({
      children: [new Paragraph({ children: [new TextRun(text)] })]
    })
  };
}

function buildFooter(spec) {
  if (spec === "page-number") {
    return {
      default: new Footer({
        children: [new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [
            new TextRun({ children: ["第 ", PageNumber.CURRENT, " 页 / 共 ", PageNumber.TOTAL_PAGES, " 页"] })
          ]
        })]
      })
    };
  }
  return {
    default: new Footer({
      children: [new Paragraph({ children: [new TextRun(String(spec))] })]
    })
  };
}

function appendToken(token, children, options, warnings) {
  switch (token.type) {
    case "heading":
      children.push(new Paragraph({
        heading: headingLevel(token.depth),
        children: inlineRuns(token.tokens || [{ type: "text", text: token.text }])
      }));
      return;
    case "paragraph":
      children.push(new Paragraph({ children: inlineRuns(token.tokens || []) }));
      return;
    case "blockquote":
      for (const sub of token.tokens || []) {
        children.push(new Paragraph({
          indent: { left: 720 },
          border: { left: { style: BorderStyle.SINGLE, size: 12, color: "999999", space: 8 } },
          children: inlineRuns(sub.tokens || [{ type: "text", text: sub.text || "" }])
        }));
      }
      return;
    case "list":
      appendList(token, children, 0);
      return;
    case "code":
      children.push(new Paragraph({
        shading: { type: ShadingType.CLEAR, fill: "F4F4F4" },
        children: [new TextRun({ text: token.text, font: "Consolas", size: 20 })]
      }));
      return;
    case "table":
      children.push(buildTable(token, options, warnings));
      return;
    case "hr":
      children.push(new Paragraph({
        border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "2E75B6", space: 1 } }
      }));
      return;
    case "space":
      return;
    case "html":
      warnings.push(`忽略原始 HTML 片段：${truncate(token.raw || "", 60)}`);
      return;
    default:
      if (token.tokens) {
        children.push(new Paragraph({ children: inlineRuns(token.tokens) }));
      } else if (token.text) {
        children.push(new Paragraph({ children: [new TextRun(token.text)] }));
      }
  }
}

function appendList(listToken, children, depth) {
  const ref = listToken.ordered ? "numbers" : "bullets";
  for (const item of listToken.items) {
    const runs = [];
    for (const sub of item.tokens || []) {
      if (sub.type === "text") {
        for (const inline of sub.tokens || [{ type: "text", text: sub.text }]) {
          runs.push(...renderInline(inline));
        }
      } else if (sub.type === "list") {
        // 嵌套列表先把当前 item 的内容落下来，再递归
        if (runs.length) {
          children.push(new Paragraph({
            numbering: { reference: ref, level: depth },
            children: runs.splice(0, runs.length)
          }));
        }
        appendList(sub, children, Math.min(depth + 1, 2));
      }
    }
    if (runs.length) {
      children.push(new Paragraph({
        numbering: { reference: ref, level: depth },
        children: runs
      }));
    }
  }
}

function buildTable(token, options, warnings) {
  const pageBase = options.pageSize === "a4" ? A4 : LETTER;
  const contentWidth = pageBase.width - inchesToDXA(options.margins.left) - inchesToDXA(options.margins.right);
  const cols = token.header.length;
  const colWidth = Math.floor(contentWidth / cols);
  const columnWidths = Array(cols).fill(colWidth);
  const border = { style: BorderStyle.SINGLE, size: 1, color: "CCCCCC" };
  const cellBorders = { top: border, bottom: border, left: border, right: border };
  const cellMargins = { top: 80, bottom: 80, left: 120, right: 120 };

  const headerRow = new TableRow({
    tableHeader: true,
    children: token.header.map((cell) => new TableCell({
      width: { size: colWidth, type: WidthType.DXA },
      borders: cellBorders,
      margins: cellMargins,
      shading: { fill: "EAEAEA", type: ShadingType.CLEAR },
      children: [new Paragraph({ children: inlineRuns(cell.tokens || [{ type: "text", text: cell.text }]) })]
    }))
  });

  const bodyRows = token.rows.map((row) => new TableRow({
    children: row.map((cell) => new TableCell({
      width: { size: colWidth, type: WidthType.DXA },
      borders: cellBorders,
      margins: cellMargins,
      children: [new Paragraph({ children: inlineRuns(cell.tokens || [{ type: "text", text: cell.text }]) })]
    }))
  }));

  return new Table({
    width: { size: colWidth * cols, type: WidthType.DXA },
    columnWidths,
    rows: [headerRow, ...bodyRows]
  });
}

function inlineRuns(tokens) {
  const runs = [];
  for (const token of tokens || []) {
    runs.push(...renderInline(token));
  }
  return runs;
}

function renderInline(token, formatting = {}) {
  switch (token.type) {
    case "text":
      if (token.tokens) {
        return token.tokens.flatMap((t) => renderInline(t, formatting));
      }
      return [new TextRun({ text: token.text, ...formatting })];
    case "strong":
      return token.tokens.flatMap((t) => renderInline(t, { ...formatting, bold: true }));
    case "em":
      return token.tokens.flatMap((t) => renderInline(t, { ...formatting, italics: true }));
    case "del":
      return token.tokens.flatMap((t) => renderInline(t, { ...formatting, strike: true }));
    case "codespan":
      return [new TextRun({ text: token.text, font: "Consolas", ...formatting })];
    case "br":
      return [new TextRun({ text: "", break: 1, ...formatting })];
    case "link":
      return [new ExternalHyperlink({
        link: token.href,
        children: token.tokens.flatMap((t) => renderInline(t, { ...formatting, style: "Hyperlink" }))
      })];
    case "image":
      return [renderImage(token, activeWarnings)];
    case "escape":
      return [new TextRun({ text: token.text, ...formatting })];
    default:
      return token.text ? [new TextRun({ text: token.text, ...formatting })] : [];
  }
}

// 图片输入作用域：只允许嵌入 YAOGUO_SCOPE_ALLOW / YAOGUO_WORK_DIR 内的本地图片。
// 否则模型生成的 markdown 可以用绝对路径把工作区外的本地文件（隐私照片等）嵌进交付文档。
// 无 scope 环境变量（独立 CLI 调用，无安全边界语境）时不限制，保持原行为。
function imageAllowedRoots() {
  const roots = [];
  const allow = process.env.YAOGUO_SCOPE_ALLOW;
  if (allow) roots.push(...allow.split(":").filter(Boolean));
  if (process.env.YAOGUO_WORK_DIR) roots.push(process.env.YAOGUO_WORK_DIR);
  return roots.map((r) => path.resolve(r));
}

function isImagePathAllowed(imgPath, roots) {
  if (roots.length === 0) return true; // 无 scope 语境，不限制
  const target = path.resolve(imgPath);
  return roots.some((root) => target === root || target.startsWith(root + path.sep));
}

function renderImage(token, warnings = null) {
  const workDir = process.env.YAOGUO_WORK_DIR || process.cwd();
  const imgPath = path.isAbsolute(token.href) ? token.href : path.resolve(workDir, token.href);

  if (!isImagePathAllowed(imgPath, imageAllowedRoots())) {
    if (warnings) warnings.push(`图片超出工作区范围，未嵌入：${token.href}`);
    return new TextRun({ text: `[图片超出工作区范围，未嵌入：${token.text || token.href}]`, italics: true });
  }
  if (!fs.existsSync(imgPath)) {
    return new TextRun({ text: `[图片缺失：${token.href}]`, italics: true });
  }
  const ext = path.extname(imgPath).slice(1).toLowerCase();
  const type = ["png", "jpg", "jpeg", "gif", "bmp", "svg"].includes(ext) ? ext : "png";
  return new ImageRun({
    type,
    data: fs.readFileSync(imgPath),
    transformation: { width: 480, height: 320 },
    altText: {
      title: token.text || "image",
      description: token.text || token.href,
      name: path.basename(imgPath)
    }
  });
}

function headingLevel(depth) {
  return [
    HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3,
    HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6
  ][Math.max(0, Math.min(5, depth - 1))];
}

function inchesToDXA(inches) {
  return Math.round(inches * DXA_PER_INCH);
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n) + "…" : s;
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
