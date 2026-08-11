import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const acorn = require("acorn");
const walk = require("acorn-walk");

// 红线阈值：基于 2026-05 全量扫描的现状定，留出真实裕度。
// 未来可分别收紧；改阈值前请重新跑扫描确认未引入额外违规。
const FUNCTION_LINE_LIMIT = 250;
const CYCLOMATIC_LIMIT = 80;

// 当前已超阈值的函数：显式登记为待偿债务。
// 棘轮原则：
//   1) 新函数超阈值即 fail
//   2) 已登记函数的实测值不得超过 maxLines / maxComplexity（恶化即 fail）
//   3) 已登记函数若已不再超阈值则要求从 ALLOWLIST 移除（漂白即 fail）
// 收紧路径：把现存债务还清后，将 CYCLOMATIC_LIMIT 降到 50，再把当时 cx 50-79 的函数登记，循环。
const ALLOWLIST = new Map([
]);

// renderer 整体用 IIFE 包裹整个文件，长度/复杂度检测意义不大；前端架构整改是独立任务，先豁免。
const SKIP_DIRS = ["src/renderer/", "src/legacy/"];

function* walkJs(absoluteDir, relativePrefix) {
  if (!existsSync(absoluteDir)) return;
  for (const entry of readdirSync(absoluteDir, { withFileTypes: true })) {
    const abs = join(absoluteDir, entry.name);
    const rel = `${relativePrefix}/${entry.name}`;
    if (entry.isDirectory()) {
      yield* walkJs(abs, rel);
    } else if (entry.isFile() && /\.(c|m)?js$/.test(entry.name)) {
      yield { abs, rel };
    }
  }
}

function getFunctionName(node, ancestors) {
  if (node.id?.name) return node.id.name;
  // 命名属性 / 方法：父节点是 Property / MethodDefinition
  for (let i = ancestors.length - 2; i >= 0; i--) {
    const parent = ancestors[i];
    if (!parent) continue;
    if ((parent.type === "Property" || parent.type === "MethodDefinition") && parent.value === node) {
      if (parent.key?.name) return parent.key.name;
      if (parent.key?.value) return String(parent.key.value);
    }
    if (parent.type === "MethodDefinition" && parent.key?.name) {
      return parent.key.name;
    }
    if (parent.type === "VariableDeclarator" && parent.init === node && parent.id?.name) {
      return parent.id.name;
    }
    if (parent.type === "AssignmentExpression" && parent.right === node && parent.left?.type === "MemberExpression") {
      const prop = parent.left.property;
      if (prop?.name) return prop.name;
    }
    if (parent.type === "CallExpression") continue;
    break;
  }
  return "<anonymous>";
}

// 计算圈复杂度：分支点 + 1。
// 经典定义：if / else-if / case / for / while / do-while / catch / && / || / ?? / ?: / 顶层。
function computeCyclomatic(node) {
  let count = 1;
  walk.simple(node, {
    IfStatement() { count++; },
    ConditionalExpression() { count++; },
    LogicalExpression(n) {
      if (n.operator === "&&" || n.operator === "||" || n.operator === "??") count++;
    },
    ForStatement() { count++; },
    ForInStatement() { count++; },
    ForOfStatement() { count++; },
    WhileStatement() { count++; },
    DoWhileStatement() { count++; },
    SwitchCase(n) { if (n.test) count++; },
    CatchClause() { count++; }
  });
  return count;
}

function isFunctionNode(node) {
  return (
    node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression" ||
    node.type === "ArrowFunctionExpression"
  );
}

function analyzeFile(source) {
  let ast;
  try {
    ast = acorn.parse(source, {
      ecmaVersion: "latest",
      sourceType: "script",
      allowReturnOutsideFunction: true,
      locations: true
    });
  } catch (e) {
    try {
      ast = acorn.parse(source, {
        ecmaVersion: "latest",
        sourceType: "module",
        locations: true
      });
    } catch (e2) {
      throw new Error(`解析失败：${e2.message}`);
    }
  }
  const findings = [];
  walk.ancestor(ast, {
    FunctionDeclaration: visit,
    FunctionExpression: visit,
    ArrowFunctionExpression: visit
  });
  function visit(node, _state, ancestors) {
    if (!isFunctionNode(node)) return;
    // 跳过 renderer 顶层 IIFE 包裹整个文件的情况：祖先链是
    // Program → ExpressionStatement → CallExpression → FunctionExpression
    if (
      ancestors.length >= 4 &&
      ancestors[0].type === "Program" &&
      ancestors[ancestors.length - 2].type === "CallExpression"
    ) {
      const programBody = ancestors[0].body;
      if (programBody.length === 1) return;
    }
    const name = getFunctionName(node, ancestors);
    const startLine = node.loc.start.line;
    const endLine = node.loc.end.line;
    const lineCount = endLine - startLine + 1;
    const complexity = computeCyclomatic(node);
    findings.push({ name, startLine, lineCount, complexity });
  }
  return findings;
}

export function runComplexityRedlines(ctx) {
  const { root } = ctx;
  const violations = [];
  for (const { abs, rel } of walkJs(join(root, "src"), "src")) {
    if (SKIP_DIRS.some((dir) => rel.startsWith(dir))) continue;
    const source = readFileSync(abs, "utf8");
    let fns;
    try {
      fns = analyzeFile(source);
    } catch (e) {
      throw new Error(`复杂度红线扫描失败 ${rel}：${e.message}`);
    }
    for (const fn of fns) {
      const key = `${rel}:${fn.name}`;
      const allow = ALLOWLIST.get(key);
      if (allow) continue; // 该条目下方做单独验证
      if (fn.lineCount > FUNCTION_LINE_LIMIT) {
        violations.push({ key, kind: "lines", value: fn.lineCount, limit: FUNCTION_LINE_LIMIT, line: fn.startLine });
      }
      if (fn.complexity > CYCLOMATIC_LIMIT) {
        violations.push({ key, kind: "cyclomatic", value: fn.complexity, limit: CYCLOMATIC_LIMIT, line: fn.startLine });
      }
    }
  }
  if (violations.length) {
    const report = violations
      .map((v) => `  ${v.key} (第 ${v.line} 行)：${v.kind === "lines" ? "行数" : "圈复杂度"} ${v.value} > ${v.limit}`)
      .join("\n");
    throw new Error(
      `复杂度红线违规：\n${report}\n\n` +
      `行数上限 ${FUNCTION_LINE_LIMIT}，圈复杂度上限 ${CYCLOMATIC_LIMIT}。\n` +
      `如确需放宽，请在 scripts/check/complexityRedlines.mjs 的 ALLOWLIST 中显式登记并写明拆解路径（视为待偿债务）。`
    );
  }
  // 棘轮反向：debt 条目必须仍在违规且不超过登记阈值——否则要求清理或修订。
  for (const [key, allow] of ALLOWLIST.entries()) {
    const idx = key.lastIndexOf(":");
    const rel = key.slice(0, idx);
    const name = key.slice(idx + 1);
    const abs = join(root, rel);
    if (!existsSync(abs)) {
      throw new Error(`复杂度红线 ALLOWLIST 中的文件已不存在：${key}`);
    }
    const fns = analyzeFile(readFileSync(abs, "utf8"));
    const target = fns.find((f) => f.name === name);
    if (!target) {
      throw new Error(`复杂度红线 ALLOWLIST 中的 ${key} 在源码中已找不到。请同步移除条目或修正名称。`);
    }
    const stillOver =
      target.lineCount > FUNCTION_LINE_LIMIT || target.complexity > CYCLOMATIC_LIMIT;
    if (!stillOver) {
      throw new Error(
        `复杂度红线 ALLOWLIST 中的 ${key} 已不再超过通用阈值（行数 ${target.lineCount}，圈复杂度 ${target.complexity}）。请从 ALLOWLIST 移除以收回债务。`
      );
    }
    if (target.lineCount > allow.maxLines) {
      throw new Error(
        `复杂度红线 ALLOWLIST 中的 ${key} 行数 ${target.lineCount} 已超过登记上限 ${allow.maxLines}。请么减少行数，要么提升 ALLOWLIST 中的 maxLines 并补充理由（注意这意味着债务在恶化）。`
      );
    }
    if (target.complexity > allow.maxComplexity) {
      throw new Error(
        `复杂度红线 ALLOWLIST 中的 ${key} 圈复杂度 ${target.complexity} 已超过登记上限 ${allow.maxComplexity}。请么降低复杂度，要么提升 ALLOWLIST 中的 maxComplexity 并补充理由（注意这意味着债务在恶化）。`
      );
    }
  }
  console.log(
    `✓ 复杂度红线（行数 ≤ ${FUNCTION_LINE_LIMIT}、圈复杂度 ≤ ${CYCLOMATIC_LIMIT}）通过；当前债务：${ALLOWLIST.size} 条。`
  );
}
