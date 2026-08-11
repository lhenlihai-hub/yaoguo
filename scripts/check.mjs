import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const terminalEdition = process.argv.includes("--terminal");
const require = createRequire(import.meta.url);
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const filesToCheck = [];

function collectJsFiles(relativeDir) {
  const absoluteDir = join(root, relativeDir);
  if (!existsSync(absoluteDir)) return;
  for (const entry of readdirSync(absoluteDir, { withFileTypes: true })) {
    const relative = `${relativeDir}/${entry.name}`;
    if (entry.isDirectory()) {
      collectJsFiles(relative);
    } else if (entry.isFile() && /\.(js|mjs|cjs)$/.test(entry.name)) {
      filesToCheck.push(relative);
    }
  }
}

collectJsFiles("src");
// Skill scripts are executable production code even though they live in the registry tree.
// Keep them under the same syntax gate as src/ so a broken bundled capability cannot ship.
collectJsFiles("workspace/registries/skills");

const jsonFiles = [
  "package.json",
  "workspace/config/settings.json",
  "workspace/schedules/jobs.json"
];

for (const file of readdirSync(join(root, "workspace/workflows"))) {
  if (file.endsWith(".json")) jsonFiles.push(`workspace/workflows/${file}`);
}

function collectJsonFiles(relativeDir) {
  const absoluteDir = join(root, relativeDir);
  if (!existsSync(absoluteDir)) return;
  for (const entry of readdirSync(absoluteDir, { withFileTypes: true })) {
    const relative = `${relativeDir}/${entry.name}`;
    if (entry.isDirectory()) {
      collectJsonFiles(relative);
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      jsonFiles.push(relative);
    }
  }
}

collectJsonFiles("workspace/registries");

for (const file of jsonFiles) {
  const absolute = join(root, file);
  JSON.parse(readFileSync(absolute, "utf8"));
}

for (const file of filesToCheck) {
  const absolute = join(root, file);
  if (!existsSync(absolute)) {
    throw new Error(`缺少文件：${file}`);
  }
  const result = spawnSync(process.execPath, ["--check", absolute], {
    encoding: "utf8"
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }
}

if (!terminalEdition) {
  const mainServicesShim = readFileSync(join(root, "src/main/services.js"), "utf8").trim();
  assert(
    mainServicesShim === 'module.exports = require("../application/appServices");',
    "src/main/services.js 必须保持为 application 组合根的兼容转发，不能重新塞入实现"
  );
  const legacyServicesSource = readFileSync(join(root, "src/legacy/monolith/servicesLegacy.js"), "utf8");
  assert(
    !/class\s+(MemoryService|ProjectService|AiRouter|WebSearchService|ReferenceService|WorkflowEngine)\b/.test(legacyServicesSource),
    "legacy/monolith/servicesLegacy.js 只能兼容导出，不能继续持有核心类实现"
  );
  const mainSource = readFileSync(join(root, "src/main/main.js"), "utf8");
  assert(
    !mainSource.includes('require("./services")') && !mainSource.includes("require('./services')"),
    "src/main/main.js 必须依赖 src/application/appServices.js，不能回退到 ./services"
  );
}
import { runWorkflowRegression } from "./check/workflowRegression.mjs";
import { runPlatformRegression } from "./check/platformRegression.mjs";
import { runComplexityRedlines } from "./check/complexityRedlines.mjs";
import { runPromptHygiene } from "./check/promptHygieneCheck.mjs";
import { runRendererGlobalContract } from "./check/rendererGlobalContract.mjs";

const checkContext = {
  root,
  require,
  assert,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  join
};

runComplexityRedlines(checkContext);
runPromptHygiene(checkContext);
if (!terminalEdition) runRendererGlobalContract(checkContext);
await runWorkflowRegression(checkContext);
await runPlatformRegression(checkContext);

console.log("配置、脚本语法、P0 回归、P1、P2 Verify-After-Fix / Stylometric / Coverage 回归测试通过。");
