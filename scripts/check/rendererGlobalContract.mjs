import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const acorn = require("acorn");
const walk = require("acorn-walk");

const PLATFORM_CALLS = new Set([
  "Array", "BigInt", "Boolean", "Date", "Error", "EvalError", "Function", "Map", "Number", "Object",
  "Promise", "RangeError", "ReferenceError", "RegExp", "Set", "String", "SyntaxError", "TypeError", "URIError",
  "URL", "URLSearchParams", "WeakMap", "WeakSet",
  "addEventListener", "alert", "atob", "btoa", "cancelAnimationFrame", "clearInterval", "clearTimeout",
  "confirm", "decodeURI", "decodeURIComponent", "encodeURI", "encodeURIComponent", "fetch", "isFinite",
  "isNaN", "parseFloat", "parseInt", "prompt", "queueMicrotask", "removeEventListener",
  "requestAnimationFrame", "setInterval", "setTimeout", "structuredClone"
]);

function addPatternNames(pattern, names) {
  if (!pattern) return;
  if (pattern.type === "Identifier") {
    names.add(pattern.name);
    return;
  }
  if (pattern.type === "RestElement") {
    addPatternNames(pattern.argument, names);
    return;
  }
  if (pattern.type === "AssignmentPattern") {
    addPatternNames(pattern.left, names);
    return;
  }
  if (pattern.type === "ArrayPattern") {
    for (const item of pattern.elements) addPatternNames(item, names);
    return;
  }
  if (pattern.type === "ObjectPattern") {
    for (const property of pattern.properties) {
      addPatternNames(property.type === "RestElement" ? property.argument : property.value, names);
    }
  }
}

function addTopLevelDeclarations(ast, names) {
  for (const node of ast.body) {
    if ((node.type === "FunctionDeclaration" || node.type === "ClassDeclaration") && node.id) {
      names.add(node.id.name);
    }
    if (node.type === "VariableDeclaration") {
      for (const declaration of node.declarations) addPatternNames(declaration.id, names);
    }
  }
}

function rendererScriptFiles(root) {
  const html = readFileSync(join(root, "src/renderer/index.html"), "utf8");
  return [...html.matchAll(/<script\s+src="\.\/([^"]+\.js)"/g)]
    .map((match) => `src/renderer/${match[1]}`);
}

function analyzeFile(root, relative) {
  const source = readFileSync(join(root, relative), "utf8");
  const ast = acorn.parse(source, { ecmaVersion: "latest", sourceType: "script", locations: true });
  const declarations = new Set();
  const globals = new Set();
  const exports = new Map();
  const calls = [];
  addTopLevelDeclarations(ast, globals);

  walk.full(ast, (node) => {
    if ((node.type === "FunctionDeclaration" || node.type === "FunctionExpression" || node.type === "ClassDeclaration") && node.id) {
      declarations.add(node.id.name);
    }
    if (node.type === "FunctionDeclaration" || node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression") {
      for (const parameter of node.params) addPatternNames(parameter, declarations);
    }
    if (node.type === "VariableDeclarator") addPatternNames(node.id, declarations);
    if (node.type === "CatchClause") addPatternNames(node.param, declarations);
    if (node.type === "CallExpression" && node.callee.type === "Identifier") {
      calls.push({ name: node.callee.name, line: node.loc.start.line });
    }
    const isWindowAssign = node.type === "CallExpression"
      && node.callee.type === "MemberExpression"
      && node.callee.object?.type === "Identifier"
      && node.callee.object.name === "Object"
      && node.callee.property?.type === "Identifier"
      && node.callee.property.name === "assign"
      && node.arguments[0]?.type === "Identifier"
      && node.arguments[0].name === "window"
      && node.arguments[1]?.type === "ObjectExpression";
    if (!isWindowAssign) return;
    for (const property of node.arguments[1].properties) {
      const publicName = property.key?.name || property.key?.value;
      const localName = property.value?.name;
      if (publicName && localName) exports.set(`${publicName}`, `${localName}`);
    }
  });
  for (const name of globals) declarations.add(name);
  return { relative, source, declarations, globals, exports, calls };
}

function isMemberCall(node, objectName, propertyName) {
  return node.type === "CallExpression"
    && node.callee.type === "MemberExpression"
    && node.callee.object?.type === "Identifier"
    && node.callee.object.name === objectName
    && node.callee.property?.type === "Identifier"
    && node.callee.property.name === propertyName;
}

function firstStringArgument(node) {
  const value = node.arguments?.[0]?.value;
  return typeof value === "string" ? value : "";
}

function inspectBridgeContracts(root, rendererRows) {
  const preloadSource = readFileSync(join(root, "src/preload.js"), "utf8");
  const preloadAst = acorn.parse(preloadSource, { ecmaVersion: "latest", sourceType: "script" });
  const exposedMethods = new Set();
  const invokedChannels = new Set();
  const listenedChannels = new Set();
  walk.full(preloadAst, (node) => {
    const isExposeCall = node.type === "CallExpression"
      && node.callee.type === "MemberExpression"
      && node.callee.object?.type === "Identifier"
      && node.callee.object.name === "contextBridge"
      && node.callee.property?.name === "exposeInMainWorld"
      && node.arguments[1]?.type === "ObjectExpression";
    if (isExposeCall) {
      for (const property of node.arguments[1].properties) {
        const name = property.key?.name || property.key?.value;
        if (name) exposedMethods.add(`${name}`);
      }
    }
    if (isMemberCall(node, "ipcRenderer", "invoke")) invokedChannels.add(firstStringArgument(node));
    if (isMemberCall(node, "ipcRenderer", "on")) listenedChannels.add(firstStringArgument(node));
  });

  const rendererMethods = new Set();
  for (const row of rendererRows) {
    for (const match of row.source.matchAll(/\bapi\.([A-Za-z_$][\w$]*)/g)) rendererMethods.add(match[1]);
  }

  const mainSource = readFileSync(join(root, "src/app/shell/appMain.js"), "utf8");
  const mainAst = acorn.parse(mainSource, { ecmaVersion: "latest", sourceType: "script" });
  const handledChannels = new Set();
  const sentChannels = new Set();
  walk.full(mainAst, (node) => {
    if (isMemberCall(node, "ipcMain", "handle")) handledChannels.add(firstStringArgument(node));
    if (
      node.type === "CallExpression"
      && node.callee.type === "MemberExpression"
      && node.callee.property?.type === "Identifier"
      && node.callee.property.name === "send"
    ) {
      sentChannels.add(firstStringArgument(node));
    }
  });

  const issues = [];
  for (const method of rendererMethods) {
    if (!exposedMethods.has(method)) issues.push(`renderer 调用了 preload 未暴露的方法 api.${method}`);
  }
  for (const channel of invokedChannels) {
    if (channel && !handledChannels.has(channel)) issues.push(`preload invoke 了未注册的 IPC 频道 ${channel}`);
  }
  for (const channel of listenedChannels) {
    if (channel && !sentChannels.has(channel)) issues.push(`preload 监听了主进程从未发送的频道 ${channel}`);
  }
  return { exposedMethods, rendererMethods, invokedChannels, handledChannels, listenedChannels, sentChannels, issues };
}

export function inspectRendererGlobalContracts(root) {
  const rows = rendererScriptFiles(root).map((relative) => analyzeFile(root, relative));
  const visibleGlobals = new Set();
  for (const row of rows) {
    for (const name of row.globals) visibleGlobals.add(name);
    for (const name of row.exports.keys()) visibleGlobals.add(name);
  }
  const issues = [];
  for (const row of rows) {
    for (const [publicName, localName] of row.exports) {
      if (!row.declarations.has(localName)) {
        issues.push(`${row.relative}: window.${publicName} 指向未声明标识符 ${localName}`);
      }
    }
    for (const call of row.calls) {
      if (row.declarations.has(call.name) || visibleGlobals.has(call.name) || PLATFORM_CALLS.has(call.name)) continue;
      issues.push(`${row.relative}:${call.line} 调用了未接线的全局函数 ${call.name}()`);
    }
  }
  const bridge = inspectBridgeContracts(root, rows);
  issues.push(...bridge.issues);
  return { files: rows.map((row) => row.relative), visibleGlobals, bridge, issues };
}

export function runRendererGlobalContract({ root, assert }) {
  const result = inspectRendererGlobalContracts(root);
  assert(result.files.length > 0, "renderer/index.html 没有加载任何脚本");
  assert(result.issues.length === 0, `Renderer 跨文件调用契约失败：\n${result.issues.join("\n")}`);
  console.log(
    `✓ Renderer 调用契约通过：${result.files.length} 个脚本、`
    + `${result.bridge.rendererMethods.size} 个 preload 方法、${result.bridge.invokedChannels.size} 个 IPC 频道。`
  );
}
