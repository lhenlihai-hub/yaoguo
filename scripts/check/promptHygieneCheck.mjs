// @ts-check
// Prompt 卫生检查：扫描源码中的 inline prompt 文本，拦截以下反模式：
//
//   1. 补丁标记词："另外/此外/补充一下/再补一句/之前的不算/前面那条作废"
//      —— 业界共识"重写 > 打补丁"（Braintrust / Latitude prompt versioning）。
//
//   2. 模糊量词："简洁/避免/不要太/适度/少量/几句/适当/一些"
//      —— Anthropic/OpenAI/Gemini 三家 prompt guide 共识"可测量约束优于模糊词"。
//
//   3. 模糊形容修饰："比较好/尽量/最好/有些/部分"
//      —— 同上。
//
//   4. 执行型 prompt 中的空洞质量标签与抽象动作：只给问题命名，却没有提供
//      可观察、可执行的修改动作。唯一的 soul / aesthetic 宪法资产允许表达稳定价值。
//
// 检查范围：src/{platform,application,domain}/ 下所有 .js 文件中的字符串字面量
// （单引号/双引号/反引号）。命中即 fail，强制重写为可测量约束。
//
// 豁免：
//   - 注释（行级 // 与块级 /* */）跳过。
//   - 测试文件 *.test.* 跳过。
//   - 业务文案（非 LLM prompt）通过 // prompt-hygiene-allow 行尾豁免。

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";

const SCAN_DIRS = ["src/platform", "src/application"];

// 资产层扫描目录（递归扫所有 *.json 中的字符串字段）。
// 现在大量 prompt 已迁到 workspace/registries 和 workspace/workflows，guardrail 必须覆盖到。
const ASSET_DIRS = ["workspace/registries/prompts", "workspace/workflows"];
const CONSTITUTIONAL_PROMPT_IDS = new Set([
  "block://soul.zh",
  "block://aesthetic.baseline.zh"
]);

// 仅在"看起来像 prompt"的字符串里检查——避免对随便的中文文案误报。
// 启发：字符串里同时含"指令性关键词"（必须/输出/请/不要/规则/请你/输出 JSON 等）
// 或 ≥ 80 个中文字符长度，就视为 prompt 文本。
const PROMPT_KEYWORDS = /必须|不得|不要|输出|请你|规则|你需要|严格|禁止|交付|步骤要求|按以下/;
const MIN_PROMPT_CHARS = 80;

// 三类反模式 regex
const PATCH_MARKERS = [
  /另外[，,]/,
  /此外[，,]/,
  /补充一下/,
  /再补一句/,
  /之前的不算/,
  /前面那条作废/,
  /忽略上面/,
  /忘记之前/
];

const FUZZY_QUANTIFIERS = [
  // 必须用更具体的次数/字数代替
  /简洁一[点些下]/,
  /避免太[长短大小多]/,
  /不要太[长短大小多]/,
  /适度[地的]/,
  /少量地?/,
  /几句话?/,
  /适当[地的]/,
  /一些(?:细节|内容|描写|句子)/
];

const FUZZY_MODIFIERS = [
  /尽量[^数]/,                    // 排除"尽量数"等极少出现的情况
  /最好(?:是)?[^的]?/,            // 排除"最好的 XX"这种正向短语
  /比较好地?/,
  /有些(?:细节|具体|抽象)/,
  /部分(?:具体|抽象)/
];

const EMPTY_QUALITY_LABELS = [
  /(?:去\s*)?AI\s*味/i
];

const ABSTRACT_DIRECTIVES = [
  /再顺一遍/,
  /让(?:这|文字|内容|表达).{0,8}更自然/,
  /讲究审美|有审美的/,
  /文笔优美|结构清晰|真情实感|引发共鸣/,
  /密度极高|恰如其分|富有生命|留白主动/,
  /顶级(?:中文|内容|写作|创作|Agent|智能体|AI)/i,
  /老练的?(?:编辑|作家|专家|顾问)/
];

function listJsFiles(dir, results = []) {
  try {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const stats = statSync(full);
      if (stats.isDirectory()) listJsFiles(full, results);
      else if (extname(entry) === ".js" && !/\.test\.|\.spec\./.test(entry)) results.push(full);
    }
  } catch {
    // 目录不存在跳过
  }
  return results;
}

// 简单字符串扫描器：扫描 ' " ` 三种引号包裹的字面量；对反引号 template literal 也扫；
// 跳过 // 和 /* */ 注释。不依赖 AST，速度优先；漏判好过误判。
function* iterateStringLiterals(source) {
  let i = 0;
  const n = source.length;
  while (i < n) {
    const ch = source[i];
    // 跳过行注释
    if (ch === "/" && source[i + 1] === "/") {
      const eol = source.indexOf("\n", i);
      i = eol === -1 ? n : eol + 1;
      continue;
    }
    // 跳过块注释
    if (ch === "/" && source[i + 1] === "*") {
      const close = source.indexOf("*/", i + 2);
      i = close === -1 ? n : close + 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch;
      let j = i + 1;
      const startLine = source.slice(0, i).split("\n").length;
      while (j < n) {
        if (source[j] === "\\" && j + 1 < n) { j += 2; continue; }
        if (source[j] === quote) break;
        j += 1;
      }
      const text = source.slice(i + 1, j);
      // 检查行尾是否有 hygiene 豁免标记
      const lineEnd = source.indexOf("\n", j);
      const lineRest = source.slice(j, lineEnd === -1 ? n : lineEnd);
      const allowed = /prompt-hygiene-allow/.test(lineRest);
      yield { text, line: startLine, allowed };
      i = j + 1;
      continue;
    }
    i += 1;
  }
}

function looksLikePromptText(text) {
  if (!text || text.length < 12) return false;
  if (text.length >= MIN_PROMPT_CHARS) return true;
  return PROMPT_KEYWORDS.test(text);
}

function detectViolations(text, { allowConstitutionalValues = false } = {}) {
  const found = [];
  for (const re of PATCH_MARKERS) {
    const m = text.match(re);
    if (m) found.push({ kind: "patch-marker", match: m[0] });
  }
  for (const re of FUZZY_QUANTIFIERS) {
    const m = text.match(re);
    if (m) found.push({ kind: "fuzzy-quantifier", match: m[0] });
  }
  for (const re of FUZZY_MODIFIERS) {
    const m = text.match(re);
    if (m) found.push({ kind: "fuzzy-modifier", match: m[0] });
  }
  for (const re of EMPTY_QUALITY_LABELS) {
    const m = text.match(re);
    if (m) found.push({ kind: "empty-quality-label", match: m[0] });
  }
  if (!allowConstitutionalValues) {
    for (const re of ABSTRACT_DIRECTIVES) {
      const m = text.match(re);
      if (m) found.push({ kind: "abstract-directive", match: m[0] });
    }
  }
  return found;
}

function hasAlwaysCheckedLabel(text) {
  return [...EMPTY_QUALITY_LABELS, ...ABSTRACT_DIRECTIVES].some((pattern) => pattern.test(text));
}

function listJsonFiles(dir, results = []) {
  try {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const stats = statSync(full);
      if (stats.isDirectory()) listJsonFiles(full, results);
      else if (extname(entry) === ".json") results.push(full);
    }
  } catch {
    // 目录不存在跳过
  }
  return results;
}

// 递归遍历 JSON 对象，yield 每个字符串值 + JSON path（用于错误定位）。
// path 用点号 + 方括号表达：steps[3].instruction、systemBlocks[0].content
function* iterateJsonStrings(node, path = "$") {
  if (typeof node === "string") {
    yield { text: node, path };
    return;
  }
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i += 1) {
      yield* iterateJsonStrings(node[i], `${path}[${i}]`);
    }
    return;
  }
  if (node && typeof node === "object") {
    for (const key of Object.keys(node)) {
      yield* iterateJsonStrings(node[key], `${path}.${key}`);
    }
  }
}

export function runPromptHygiene({ root }) {
  const violations = [];
  for (const rel of SCAN_DIRS) {
    const abs = join(root, rel);
    for (const file of listJsFiles(abs)) {
      const source = readFileSync(file, "utf8");
      for (const lit of iterateStringLiterals(source)) {
        if (lit.allowed) continue;
        if (!looksLikePromptText(lit.text) && !hasAlwaysCheckedLabel(lit.text)) continue;
        const issues = detectViolations(lit.text);
        if (!issues.length) continue;
        violations.push({
          file: file.replace(root + "/", ""),
          line: lit.line,
          preview: lit.text.slice(0, 80).replace(/\s+/g, " "),
          issues
        });
      }
    }
  }
  // 资产层扫描：JSON 文件里所有字符串字段都过同一套 detectViolations。
  // 豁免方式：字符串本身含子串 "prompt-hygiene-allow"（JSON 无注释，只能这样标记）。
  for (const rel of ASSET_DIRS) {
    const abs = join(root, rel);
    for (const file of listJsonFiles(abs)) {
      let parsed;
      try {
        parsed = JSON.parse(readFileSync(file, "utf8"));
      } catch {
        continue; // JSON 语法错误另有 check 流程兜底，这里不重复报
      }
      const allowConstitutionalValues = CONSTITUTIONAL_PROMPT_IDS.has(`${parsed?.id || ""}`);
      for (const lit of iterateJsonStrings(parsed)) {
        if (lit.text.includes("prompt-hygiene-allow")) continue;
        if (!looksLikePromptText(lit.text) && !hasAlwaysCheckedLabel(lit.text)) continue;
        const issues = detectViolations(lit.text, { allowConstitutionalValues });
        if (!issues.length) continue;
        violations.push({
          file: file.replace(root + "/", ""),
          line: lit.path,
          preview: lit.text.slice(0, 80).replace(/\s+/g, " "),
          issues
        });
      }
    }
  }
  if (!violations.length) {
    console.log("✓ Prompt 卫生检查通过：执行契约无补丁标记、模糊约束或抽象质量指令；宪法资产边界有效。");
    return;
  }
  console.error("✖ Prompt 卫生检查失败，发现以下反模式：");
  const kindSummary = new Set();
  for (const v of violations.slice(0, 30)) {
    const summary = v.issues.map((i) => `${i.kind}=${i.match}`).join(", ");
    console.error(`  ${v.file}:${v.line}  [${summary}]  '${v.preview}...'`);
    for (const i of v.issues) kindSummary.add(i.kind);
  }
  if (violations.length > 30) {
    console.error(`  ... 还有 ${violations.length - 30} 条未列出`);
  }
  throw new Error(
    `共 ${violations.length} 处 prompt 反模式（类型：${[...kindSummary].join(" / ")}）。`
      + ` 修改原则：删原文重写，禁止 append 补丁；执行型 prompt 用触发条件、具体动作和完成标准替换模糊词与抽象标签。`
      + ` 如确属业务文案非 prompt，请在该行末尾加 // prompt-hygiene-allow。`
  );
}
