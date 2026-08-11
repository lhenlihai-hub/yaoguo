#!/usr/bin/env node
// @ts-check

// deckHtml —— 视觉之手：把结构化脚本渲染成一套 opinionated 的 HTML 幻灯片。
//
// 思路对标 Gamma / Presenton / v0：美来自"一套克制、统一、高质量的设计系统"，
// 把静态 HTML 视觉契约的可测量准则焊进 CSS：一页一焦点、标题与正文字号比≥1.6；
// 克制=色相≤3/字体≤2/无装饰线/一个母题；秩序=统一字阶与间距+左对齐栅格；
// 生命=非对称+hero+强调色；真实目的=配色/字体来自基调(brief)。
//
// 完整度：支持每页配图(options.images，url 来自公有领域检索或生成兜底)、自带 web 字体。
// 复用 create.js 的 buildSlides 做结构解析——单一解析器，两种渲染(pptxgenjs / HTML)。
//
// 入参：buildDeckHtml(markdown, { title, subtitle, brief, images })
//   images: { cover?: {url,credit}, 1: {url,credit}, 2: {...} }  键为内容页 1-based 序号

const { marked } = require("marked");
const { buildSlides } = require("./create.js");

const DEFAULT_BRIEF = {
  primary: "#1f2430",
  accent: "#c2603d",
  bg: "#ffffff",
  ink: "#1a1a1a",
  muted: "#8a8f98",
  display: "\"Noto Serif SC\",\"Songti SC\",Georgia,serif",
  body: "\"Noto Sans SC\",\"PingFang SC\",\"Microsoft YaHei\",system-ui,sans-serif"
};

function escapeHtml(s) {
  return `${s == null ? "" : s}`
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function buildDeckHtml(markdown, options = {}) {
  const brief = { ...DEFAULT_BRIEF, ...(options.brief || {}) };
  const title = `${options.title || "演示文稿"}`;
  const images = options.images || {};
  const slides = buildSlides(marked.lexer(`${markdown || ""}`), { title });

  let coverSub = `${options.subtitle || ""}`;
  let body = slides;
  if (slides.length && slides[0].title === title && !slides[0].screen.length) {
    coverSub = coverSub || textOfFirstBlock(slides[0]);
    body = slides.slice(1);
  }

  const sections = [renderCover(title, coverSub, images.cover)];
  body.forEach((slide, i) => sections.push(renderSlide(slide, i + 2, images[i + 1])));

  const styleVars = [
    `--primary:${brief.primary}`, `--accent:${brief.accent}`, `--bg:${brief.bg}`,
    `--ink:${brief.ink}`, `--muted:${brief.muted}`, `--display:${brief.display}`, `--body:${brief.body}`
  ].join(";");

  return [
    "<!doctype html>",
    "<html lang=\"zh\"><head><meta charset=\"utf-8\">",
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">",
    `<title>${escapeHtml(title)}</title>`,
    `<style>${DECK_CSS}</style></head>`,
    `<body><div class="deck" style="${styleVars}">`,
    sections.join("\n"),
    "</div></body></html>"
  ].join("\n");
}

function textOfFirstBlock(slide) {
  const b = (slide.blocks || [])[0];
  if (b && b.type === "bullets" && b.items[0]) return b.items[0].text;
  if (slide.screen && slide.screen[0]) return slide.screen[0].text;
  return "";
}

function renderCover(title, subtitle, image) {
  if (image && image.url) {
    return [
      "<div class=\"slide-wrap\"><section class=\"slide cover has-image\">",
      `<div class="cover-bg" style="background-image:url('${escapeHtml(image.url)}')"></div>`,
      "<div class=\"cover-veil\"></div>",
      "<div class=\"cover-inner\">",
      `<h1 class="title">${escapeHtml(title)}</h1>`,
      subtitle ? `<p class="sub">${escapeHtml(subtitle)}</p>` : "",
      image.credit ? `<p class="credit">${escapeHtml(image.credit)}</p>` : "",
      "</div></section></div>"
    ].join("");
  }
  return [
    "<div class=\"slide-wrap\"><section class=\"slide cover\">",
    `<h1 class="title">${escapeHtml(title)}</h1>`,
    subtitle ? `<p class="sub">${escapeHtml(subtitle)}</p>` : "",
    "</section></div>"
  ].join("");
}

function renderSlide(slide, pageNo, image) {
  const isStatement = slide.screen && slide.screen.length > 0;
  const inner = isStatement ? renderStatement(slide) : renderContent(slide);
  const notes = renderNotes(slide);
  let cls = `slide ${isStatement ? "statement" : "content"}`;
  let bodyHtml = inner;
  if (image && image.url) {
    cls += " has-image";
    bodyHtml = `<div class="slide-body">${inner}</div>${renderFigure(image)}`;
  }
  return [
    "<div class=\"slide-wrap\">",
    `<section class="${cls}">`,
    bodyHtml,
    `<span class="page-no">${pageNo}</span>`,
    "</section>",
    notes,
    "</div>"
  ].join("");
}

function renderFigure(image) {
  return [
    "<figure class=\"slide-figure\">",
    `<img src="${escapeHtml(image.url)}" alt="">`,
    image.credit ? `<figcaption>${escapeHtml(image.credit)}</figcaption>` : "",
    "</figure>"
  ].join("");
}

function renderStatement(slide) {
  const n = slide.screen.length;
  const size = n <= 3 ? 34 : n <= 6 ? 26 : 20;
  const lines = slide.screen.map((l) => `<p>${escapeHtml(l.text)}</p>`).join("");
  return [
    slide.title ? `<p class="kicker">${escapeHtml(slide.title)}</p>` : "",
    `<div class="hero" style="font-size:${size}px">${lines}</div>`
  ].join("");
}

function renderContent(slide) {
  const parts = [slide.title ? `<h2 class="stitle">${escapeHtml(slide.title)}</h2>` : ""];
  for (const block of (slide.blocks || [])) {
    if (block.type === "bullets") {
      const lis = block.items.map((it) => `<li${it.bold ? " class=\"strong\"" : ""}>${escapeHtml(it.text)}</li>`).join("");
      parts.push(`<ul>${lis}</ul>`);
    } else if (block.type === "table") {
      const head = `<tr>${block.header.map((h) => `<th>${escapeHtml(h)}</th>`).join("")}</tr>`;
      const rows = block.rows.map((r) => `<tr>${r.map((c) => `<td>${escapeHtml(c)}</td>`).join("")}</tr>`).join("");
      parts.push(`<table>${head}${rows}</table>`);
    } else if (block.type === "code") {
      parts.push(`<pre>${escapeHtml(block.text)}</pre>`);
    }
  }
  return parts.join("");
}

function renderNotes(slide) {
  const blocks = [];
  if (slide.notes && slide.notes.length) blocks.push(`<b>讲解</b> ${escapeHtml(slide.notes.join(" "))}`);
  if (slide.art && slide.art.length) blocks.push(`<b>版式</b> ${escapeHtml(slide.art.join(" "))}`);
  if (!blocks.length) return "";
  return `<div class="notes">${blocks.join("<br>")}</div>`;
}

const DECK_CSS = [
  "@import url('https://fonts.googleapis.com/css2?family=Noto+Serif+SC:wght@500;600&family=Noto+Sans+SC:wght@400;500&display=swap');",
  "*{box-sizing:border-box}",
  "body{margin:0;background:#e7e3dc;font-family:var(--body);color:var(--ink);-webkit-font-smoothing:antialiased}",
  ".deck{max-width:1040px;margin:0 auto;padding:48px 24px}",
  ".slide-wrap{margin:0 auto 44px}",
  ".slide{position:relative;width:100%;aspect-ratio:16/9;background:var(--bg);color:var(--ink);padding:60px 72px;border-radius:3px;box-shadow:0 10px 34px rgba(20,16,12,.10);overflow:hidden;display:flex;flex-direction:column}",
  ".slide::before{content:'';position:absolute;top:60px;left:72px;width:16px;height:16px;background:var(--accent)}",
  ".page-no{position:absolute;right:64px;bottom:46px;font-size:13px;color:var(--muted)}",
  ".kicker{font-size:14px;letter-spacing:.06em;color:var(--muted);margin:0 0 0 30px}",
  ".cover{background:var(--primary);color:#fff;justify-content:center}",
  ".cover .title{font-family:var(--display);font-weight:600;font-size:54px;line-height:1.18;margin:0;max-width:80%}",
  ".cover .sub{margin-top:22px;font-size:18px;color:rgba(255,255,255,.72);max-width:72%}",
  ".cover.has-image{padding:0;color:#fff}",
  ".cover.has-image::before{display:none}",
  ".cover-bg{position:absolute;inset:0;background-size:cover;background-position:center}",
  ".cover-veil{position:absolute;inset:0;background:rgba(22,17,12,.52)}",
  ".cover-inner{position:relative;padding:60px 72px;display:flex;flex-direction:column;justify-content:flex-end;height:100%}",
  ".cover-inner .credit{margin-top:14px;font-size:12px;color:rgba(255,255,255,.6)}",
  ".statement .hero{font-family:var(--display);font-weight:500;line-height:1.5;color:var(--primary);margin:auto 0;max-width:74%}",
  ".statement .hero p{margin:0 0 14px}",
  ".content .stitle{font-family:var(--display);font-weight:600;font-size:30px;line-height:1.3;margin:4px 0 24px 30px}",
  ".content ul{margin:0;padding:0;list-style:none;max-width:82%}",
  ".content li{position:relative;padding-left:22px;margin:0 0 14px;font-size:18px;line-height:1.6}",
  ".content li::before{content:'';position:absolute;left:0;top:12px;width:9px;height:2px;background:var(--accent)}",
  ".content li.strong{font-weight:500;font-size:19px}",
  ".content li.strong::before{display:none}",
  ".content table{border-collapse:collapse;font-size:15px;max-width:92%;margin-left:30px}",
  ".content th{background:rgba(0,0,0,.04);text-align:left;padding:8px 12px;font-weight:500}",
  ".content td{border-top:1px solid rgba(0,0,0,.08);padding:8px 12px}",
  ".content pre{background:#f4f6f8;padding:14px 18px;border-radius:4px;font-size:13px;overflow:auto;max-width:92%;margin-left:30px}",
  ".slide.has-image{flex-direction:row;gap:44px;align-items:stretch}",
  ".slide.has-image::before{display:none}",
  ".slide-body{flex:1;display:flex;flex-direction:column;justify-content:center;min-width:0}",
  ".slide-body .kicker,.slide-body .stitle{margin-left:0}",
  ".slide-figure{flex:0 0 40%;margin:0;display:flex;flex-direction:column;justify-content:center}",
  ".slide-figure img{width:100%;height:78%;object-fit:cover;border-radius:4px;display:block}",
  ".slide-figure figcaption{margin-top:8px;font-size:12px;color:var(--muted)}",
  ".notes{max-width:1040px;margin:10px auto 0;padding:0 6px;font-size:13px;line-height:1.6;color:#6f665b}",
  ".notes b{font-weight:500;color:#8a7f72}"
].join("");

if (require.main === module) {
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => { buf += c; });
  process.stdin.on("end", () => {
    let params = {};
    try { params = JSON.parse(buf || "{}"); } catch { params = {}; }
    process.stdout.write(buildDeckHtml(params.markdown || "", params.options || {}));
  });
}

module.exports = { buildDeckHtml, DEFAULT_BRIEF };
