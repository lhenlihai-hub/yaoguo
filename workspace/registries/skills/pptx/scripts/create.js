#!/usr/bin/env node
// @ts-check

// pptx skill — create.js
// markdown + 宿主校验后的可选配图 → 幻灯片（pptxgenjs，纯 JS）。
//
// 切片约定（保持稳定，测试有契约）：
//   - options.title → 标题页
//   - 每个 H1/H2 开一张新内容页，标题=该标题文本
//   - 输出 slides 计数 = 标题页 + 每个 H1/H2 一页
//
// 结构化"课件脚本"识别（让产物可用，而不是把 markdown 当 bullet 倾倒）：
//   一页内若出现以下标记，按语义分流，而不是全部上屏：
//     - `**屏幕主文字**`  → 之后的内容是投屏正文（幻灯片主角，字号大、行数少）
//     - `**讲解参考词**`  → 之后的内容是口播稿 → 写进 PPT 备注栏（演讲者视图，不上屏）
//     - `` `┌ 版式 ┐ … ` `` → 美术/版式指导 → 写进备注栏的「版式建议」，不上屏
//   没有这些标记的普通 markdown → 走通用渲染（干净 bullet / 表格 / 代码）。
//
// 设计系统（去 AI slop）：深色标题页 + 浅色内容页"三明治"；唯一暖色强调；
//   一个小色块母题贯穿全 deck；不画标题下装饰横线、不铺整条色带。
//   宿主最多注入 4 张已下载配图；脚本按原始宽高比放入标题页和内容页。
//
// 入参：{ source:{markdown}, outputPath, options:{title,author?,pageSize?,images?} }
// 出参：{ ok, outputPath, bytes, slides, warnings }

const fs = require("node:fs");
const path = require("node:path");
const PptxGenJS = require("pptxgenjs");
const { marked } = require("marked");

const CJK_FONT = "Microsoft YaHei";

// 单一默认主题。刻意避开"默认蓝 + 标题下蓝线"的模板化样式。
const THEME = {
  titleBg: "1B2330",   // 深墨蓝标题页
  titleFg: "FFFFFF",
  titleSub: "AEB9D4",
  contentBg: "FFFFFF", // 浅色内容页
  titleColor: "1A1A1A",
  bodyColor: "33404A",
  muted: "9099A6",
  accent: "D08C45"     // 唯一强调色（暖琥珀），只用于小色块母题
};

// 结构化标记（label 已被 marked 去掉 ** 包裹，这里匹配纯文本）。
const SCREEN_LABELS = /^(屏幕主文字|屏幕文字|投屏文字|主文字|屏幕)$/;
const NOTES_LABELS = /^(讲解参考词|讲解词|讲稿|口播|备注|讲解)$/;

// 作为 skill 被 spawn 时跑 main；被 require（单测）时只暴露纯函数，不执行。
if (require.main === module) {
  main().catch((err) => fail("UNDERLYING_LIB", err.message || String(err), err));
}

async function main() {
  const params = await readParams();
  validateParams(params);
  enforceScope(params.outputPath);

  const markdown = params.source?.markdown;
  if (typeof markdown !== "string") fail("INPUT_INVALID", "source.markdown 必须是字符串。");

  const options = params.options || {};
  const warnings = [];
  const tokens = marked.lexer(markdown);
  const slides = buildSlides(tokens, options);
  const images = normalizeImages(options.images, warnings);

  const pptx = new PptxGenJS();
  pptx.layout = options.pageSize === "a4" ? "LAYOUT_4x3" : "LAYOUT_WIDE";
  renderTitleSlide(pptx, options, images[0] || null, warnings);
  slides.forEach((slide, index) => {
    const image = images.length > 1 ? images[(index + 1) % images.length] : null;
    renderContentSlide(pptx, slide, warnings, index + 2, image);
  });

  const data = await pptx.write({ outputType: "nodebuffer" });
  fs.mkdirSync(path.dirname(params.outputPath), { recursive: true });
  fs.writeFileSync(params.outputPath, data);
  const bytes = fs.statSync(params.outputPath).size;

  emit({ ok: true, outputPath: params.outputPath, bytes, slides: slides.length + 1, images: images.length, warnings });
}

// ── markdown tokens → 幻灯片数据模型（切片 + 结构化分流）────────────────────

function newSlide(title) {
  return { title, section: null, screen: [], notes: [], art: [], blocks: [] };
}

function buildSlides(tokens, options) {
  const slides = [];
  let current = null;
  const deckTitle = options.title || "";
  const ensure = () => {
    if (!current) { current = newSlide(deckTitle || "概述"); slides.push(current); }
    return current;
  };

  for (const token of tokens) {
    if (token.type === "heading" && token.depth <= 2) {
      current = newSlide(plainText(token));
      slides.push(current);
      continue;
    }
    assignToken(ensure(), token);
  }
  return slides;
}

// 把单个 token 按"当前页 + 当前小节"分流到 screen / notes / art / blocks。
function assignToken(slide, token) {
  if (token.type === "heading") {
    // H3+：投屏小节内作加粗投屏行；否则进通用区当加粗 bullet。
    const text = plainText(token);
    if (slide.section === "screen") slide.screen.push({ text, strong: true });
    else slide.blocks.push({ type: "bullets", items: [{ text, level: 0, bold: true }] });
    return;
  }
  if (token.type === "paragraph") {
    const text = plainText(token).trim();
    const label = text.replace(/\*\*/g, "").trim();
    if (SCREEN_LABELS.test(label)) { slide.section = "screen"; return; }
    if (NOTES_LABELS.test(label)) { slide.section = "notes"; return; }
    if (isArtDirection(text)) { slide.art.push(text); return; }
    if (slide.section === "screen") { pushScreenLines(slide, text); return; }
    if (slide.section === "notes") { slide.notes.push(text); return; }
    slide.blocks.push({ type: "bullets", items: [{ text, level: 0 }] });
    return;
  }
  if (token.type === "blockquote") {
    const text = plainText(token).trim();
    if (isArtDirection(text)) { slide.art.push(text); return; }
    if (slide.section === "screen") { pushScreenLines(slide, text); return; }
    if (slide.section === "notes") { slide.notes.push(text); return; }
    slide.blocks.push({ type: "bullets", items: [{ text, level: 0, italic: true }] });
    return;
  }
  if (token.type === "list") {
    const items = flattenList(token, 0);
    if (slide.section === "screen") { for (const it of items) slide.screen.push({ text: it.text }); return; }
    if (slide.section === "notes") { for (const it of items) slide.notes.push(it.text); return; }
    slide.blocks.push({ type: "bullets", items });
    return;
  }
  if (token.type === "table") {
    slide.blocks.push({ type: "table", header: token.header.map(plainText), rows: token.rows.map((r) => r.map(plainText)) });
    return;
  }
  if (token.type === "code") {
    slide.blocks.push({ type: "code", text: token.text || "" });
  }
}

// 美术指导段：含「版式」且带 ┌ / ┐ 角标（脚本里用 `┌ 版式 ┐ …` 写）。
function isArtDirection(text) {
  const t = `${text || ""}`;
  return t.includes("版式") && (t.includes("┌") || t.includes("┐"));
}

// 投屏正文按软换行拆成多行，去掉残留的引用符号。
function pushScreenLines(slide, text) {
  for (const raw of `${text}`.split(/\n+/)) {
    const line = raw.trim().replace(/^>\s?/, "");
    if (line) slide.screen.push({ text: line });
  }
}

function flattenList(listToken, depth) {
  const items = [];
  for (const item of listToken.items || []) {
    const text = (item.tokens || [])
      .filter((t) => t.type === "text" || t.type === "paragraph")
      .map(plainText).join(" ").trim();
    if (text) items.push({ text, level: Math.min(depth, 4) });
    for (const sub of item.tokens || []) {
      if (sub.type === "list") items.push(...flattenList(sub, depth + 1));
    }
  }
  return items;
}

function plainText(token) {
  if (token == null) return "";
  if (typeof token === "string") return token;
  if (token.type === "table") return "";
  if (typeof token.text === "string" && (!token.tokens || token.tokens.length === 0)) return token.text;
  if (Array.isArray(token.tokens)) return token.tokens.map(plainText).join("");
  return `${token.text || ""}`;
}

// ── pptxgenjs 渲染 ────────────────────────────────────────────────────────

function renderTitleSlide(pptx, options, image = null, warnings = []) {
  const slide = pptx.addSlide();
  slide.background = { color: THEME.titleBg };
  if (image) {
    slide.addShape(pptx.ShapeType.roundRect, {
      x: 7.5, y: 0.55, w: 5.15, h: 6.4, rectRadius: 0.08,
      fill: { color: "111827", transparency: 15 }, line: { color: "334155", transparency: 40 }
    });
    addContainedImage(slide, image, { x: 7.7, y: 0.75, w: 4.75, h: 5.95 }, warnings);
  }
  // 母题：标题上方一个小色块（贯穿全 deck），不用装饰横线。
  slide.addShape(pptx.ShapeType.rect, { x: image ? 0.85 : "46%", y: "34%", w: 0.5, h: 0.14, fill: { color: THEME.accent }, line: { type: "none" } });
  slide.addText(options.title || "演示文稿", {
    x: image ? 0.85 : 0.8, y: "40%", w: image ? 5.9 : "84%", h: 1.6,
    fontSize: 40, bold: true, color: THEME.titleFg, align: image ? "left" : "center", fontFace: CJK_FONT
  });
  if (options.author) {
    slide.addText(String(options.author), {
      x: image ? 0.85 : 0.8, y: "62%", w: image ? 5.9 : "84%", h: 0.6,
      fontSize: 16, color: THEME.titleSub, align: image ? "left" : "center", fontFace: CJK_FONT
    });
  }
}

function renderContentSlide(pptx, slideData, warnings, pageNum, image = null) {
  const slide = pptx.addSlide();
  slide.background = { color: THEME.contentBg };
  // 母题小色块 + 标题（无装饰线）。
  slide.addShape(pptx.ShapeType.rect, { x: 0.5, y: 0.52, w: 0.16, h: 0.16, fill: { color: THEME.accent }, line: { type: "none" } });
  slide.addText(slideData.title || "", {
    x: 0.82, y: 0.42, w: "86%", h: 0.9,
    fontSize: 28, bold: true, color: THEME.titleColor, fontFace: CJK_FONT, valign: "middle"
  });

  if (slideData.screen.length) {
    renderScreenText(slide, slideData.screen, Boolean(image));
  } else {
    renderGenericBlocks(slide, slideData.blocks, warnings, slideData.title, Boolean(image));
  }
  if (image) {
    slide.addShape(pptx.ShapeType.roundRect, {
      x: 8.05, y: 1.55, w: 4.65, h: 4.95,
      fill: { color: "F3F4F6" }, line: { color: "E5E7EB" }
    });
    addContainedImage(slide, image, { x: 8.22, y: 1.72, w: 4.31, h: 4.28 }, warnings);
    if (image.credit) {
      slide.addText(image.credit, {
        x: 8.22, y: 6.07, w: 4.31, h: 0.28, fontSize: 8.5,
        color: THEME.muted, align: "right", fontFace: CJK_FONT, margin: 0
      });
    }
  }

  // 口播稿 + 版式建议进备注栏（演讲者视图可见，不上屏）。
  const notesParts = [];
  if (slideData.notes.length) notesParts.push(slideData.notes.join("\n\n"));
  if (slideData.art.length) notesParts.push(`【版式建议】\n${slideData.art.join("\n")}`);
  if (notesParts.length) { try { slide.addNotes(notesParts.join("\n\n")); } catch { /* notes 失败不影响主产物 */ } }

  // 页码（弱化，右下）。
  slide.addText(`${pageNum}`, { x: "90%", y: "92%", w: "8%", h: 0.3, fontSize: 10, color: THEME.muted, align: "right", fontFace: CJK_FONT });
}

// 投屏正文是主角：行数少、字号大、行距宽，左对齐留白。
function renderScreenText(slide, lines, hasImage = false) {
  const fontSize = lines.length <= 3 ? 28 : lines.length <= 6 ? 22 : 18;
  const runs = lines.map((ln) => ({
    text: ln.text,
    options: { fontSize, bold: !!ln.strong, color: THEME.titleColor, fontFace: CJK_FONT, breakLine: true, paraSpaceAfter: 10 }
  }));
  slide.addText(runs, { x: 0.9, y: 1.8, w: hasImage ? 6.35 : "84%", h: 4.6, valign: "top", lineSpacingMultiple: 1.3 });
}

// 通用 markdown：干净 bullet / 表格 / 代码（不带装饰线）。
function renderGenericBlocks(slide, blocks, warnings, title, hasImage = false) {
  let y = 1.6;
  const contentWidth = hasImage ? 6.4 : "86%";
  for (const block of blocks) {
    if (block.type === "bullets") {
      const runs = block.items.map((it) => ({
        text: it.text,
        options: { bullet: { indent: 15 }, indentLevel: it.level || 0, bold: !!it.bold, italic: !!it.italic,
          fontSize: 18, color: THEME.bodyColor, fontFace: CJK_FONT, breakLine: true }
      }));
      const h = Math.min(4.5, 0.4 * runs.length + 0.3);
      slide.addText(runs, { x: 0.8, y, w: contentWidth, h, valign: "top" });
      y += h + 0.12;
    } else if (block.type === "table") {
      const head = block.header.map((hh) => ({ text: hh, options: { bold: true, fill: { color: "EEF1F5" }, color: THEME.titleColor, fontFace: CJK_FONT } }));
      const body = block.rows.map((r) => r.map((c) => ({ text: c, options: { fontFace: CJK_FONT, color: THEME.bodyColor } })));
      slide.addTable([head, ...body], { x: 0.8, y, w: contentWidth, fontSize: 14, border: { type: "solid", color: "DDE3EA", pt: 1 } });
      y += 0.4 * (body.length + 1) + 0.2;
    } else if (block.type === "code") {
      slide.addText(block.text, { x: 0.8, y, w: contentWidth, h: 1.2, fontSize: 13, fontFace: "Consolas", color: THEME.bodyColor, fill: { color: "F4F6F8" }, valign: "top" });
      y += 1.3;
    }
    if (y > 6.8) { warnings.push(`幻灯片「${title}」内容较多，可能溢出一页。`); break; }
  }
}

function normalizeImages(input, warnings = []) {
  const rows = [];
  for (const item of Array.isArray(input) ? input.slice(0, 4) : []) {
    const data = `${item?.data || ""}`;
    if (!/^data:image\/(?:png|jpe?g|gif|webp);base64,/i.test(data)) {
      warnings.push(`配图格式不受支持，已跳过：${item?.title || "未命名图片"}`);
      continue;
    }
    try {
      const width = Number(item?.width);
      const height = Number(item?.height);
      if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)
        || width < 1 || height < 1 || width > 100000 || height > 100000
        || width * height > 400000000) throw new Error("缺少已验证尺寸");
      rows.push({
        data,
        width,
        height,
        title: `${item?.title || "配图"}`,
        credit: `${item?.credit || ""}`
      });
    } catch {
      warnings.push(`配图无法解析，已跳过：${item?.title || "未命名图片"}`);
    }
  }
  return rows;
}

function addContainedImage(slide, image, frame, warnings = []) {
  try {
    const sourceRatio = image.width / image.height;
    const frameRatio = frame.w / frame.h;
    let w = frame.w;
    let h = frame.h;
    let x = frame.x;
    let y = frame.y;
    if (sourceRatio > frameRatio) {
      h = w / sourceRatio;
      y += (frame.h - h) / 2;
    } else {
      w = h * sourceRatio;
      x += (frame.w - w) / 2;
    }
    slide.addImage({
      data: image.data,
      x, y, w, h,
      altText: image.title || "配图"
    });
  } catch {
    warnings.push(`配图写入失败，已跳过：${image?.title || "未命名图片"}`);
  }
}

// ── I/O / 校验 ────────────────────────────────────────────────────────────

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

// 暴露纯函数供单测（被 require 时不会执行 main）。
module.exports = { buildSlides, assignToken, isArtDirection, plainText, normalizeImages, addContainedImage };
