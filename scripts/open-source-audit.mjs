#!/usr/bin/env node

import { readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const allowPendingMetadata = process.argv.includes("--allow-pending-metadata");
const allowHistoryData = process.argv.includes("--allow-history-data");
const terminalReleaseTree = process.argv.includes("--release-tree");
const desktopReleaseTree = process.argv.includes("--desktop-release-tree");
const failures = [];
const warnings = [];

function git(args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.stderr.trim() || `git ${args.join(" ")} 执行失败`);
  return result.stdout;
}

function auditedFiles() {
  return git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"])
    .split("\0")
    .filter(Boolean);
}

function isForbiddenRuntimePath(file = "") {
  const normalized = file.replace(/^"/, "");
  return /^(?:dist|coverage)\//.test(normalized)
    || /^workspace\/(?:chats|private|projects|runs)\//.test(normalized)
    || normalized === "workspace/config/settings.local.json"
    || /(?:^|\/)[^/]+\.(?:dmg|zip|tgz|log)$/.test(normalized);
}

function inspectCurrentTree(files) {
  const forbidden = files.filter(isForbiddenRuntimePath);
  if (forbidden.length) failures.push(`当前版本仍追踪运行时或构建数据：${forbidden.slice(0, 8).join("，")}`);

  const secretPatterns = [
    /sk-[A-Za-z0-9_-]{20,}/,
    /gh[pousr]_[A-Za-z0-9]{20,}/,
    /AKIA[0-9A-Z]{16}/,
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    /(?:DEEPSEEK|TAVILY)_API_KEY[ \t]*=[ \t]*[^\s#"'<>]{12,}/
  ];
  const secretFiles = [];
  const largeFiles = [];
  for (const file of files) {
    const absolute = join(root, file);
    let stat;
    try {
      stat = statSync(absolute);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    if (stat.size > 10 * 1024 * 1024) largeFiles.push(`${file} (${Math.ceil(stat.size / 1024 / 1024)} MiB)`);
    if (stat.size > 2 * 1024 * 1024) continue;
    const content = readFileSync(absolute);
    if (content.includes(0)) continue;
    const text = content.toString("utf8");
    if (secretPatterns.some((pattern) => pattern.test(text))) secretFiles.push(file);
  }
  if (secretFiles.length) failures.push(`当前版本疑似包含高置信度密钥：${secretFiles.join("，")}`);
  if (largeFiles.length) failures.push(`当前版本包含超过 10 MiB 的文件：${largeFiles.join("，")}`);
}

function inspectIgnoreRules() {
  const ignore = readFileSync(join(root, ".gitignore"), "utf8");
  const required = [
    "node_modules/", "dist/", "*.dmg", "*.zip", "*.tgz", "workspace/chats/",
    "workspace/private/", "workspace/projects/", "workspace/runs/",
    "workspace/config/settings.local.json", "*.log", "coverage/"
  ];
  const missing = required.filter((entry) => !ignore.split(/\r?\n/).includes(entry));
  if (missing.length) failures.push(`.gitignore 缺少发布护栏：${missing.join("，")}`);
}

function inspectMetadata() {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const missing = [];
  if (!pkg.license || pkg.license === "UNLICENSED") missing.push("开源许可证");
  if (!pkg.repository) missing.push("repository");
  if (!pkg.homepage) missing.push("homepage");
  try {
    statSync(join(root, "LICENSE"));
  } catch {
    missing.push("LICENSE 文件");
  }
  if (!missing.length) return;
  const message = `发布元数据待补：${[...new Set(missing)].join("，")}`;
  if (allowPendingMetadata) warnings.push(message);
  else failures.push(message);
}

function inspectHistory() {
  const historicalPaths = git(["log", "--all", "--format=", "--name-only"])
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter(isForbiddenRuntimePath);
  const unique = [...new Set(historicalPaths)];
  if (!unique.length) return;
  const message = `Git 历史仍包含 ${unique.length} 个运行时/构建路径；公开前必须重写历史或从干净根发布。示例：${unique.slice(0, 5).join("，")}`;
  if (allowHistoryData) warnings.push(message);
  else failures.push(message);
}

function inspectRequiredDocuments() {
  const sharedDocuments = [
    "README.md",
    "CONTRIBUTING.md",
    "SECURITY.md",
    "CODE_OF_CONDUCT.md",
    "THIRD_PARTY_NOTICES.md",
    "docs/DEPENDENCY_SECURITY.md"
  ];
  const required = terminalReleaseTree
    ? [...sharedDocuments, "docs/terminal.md"]
    : desktopReleaseTree
      ? sharedDocuments
      : [...sharedDocuments, "docs/terminal.md", "docs/OPEN_SOURCE_CHECKLIST.md", "docs/REPOSITORY_SPLIT.md"];
  const missing = required.filter((file) => {
    try {
      return !statSync(join(root, file)).isFile();
    } catch {
      return true;
    }
  });
  if (missing.length) failures.push(`缺少开源文档：${missing.join("，")}`);
}

function inspectPublicPositioning() {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const readme = readFileSync(join(root, "README.md"), "utf8");
  const security = readFileSync(join(root, "SECURITY.md"), "utf8");
  if (!`${pkg.author || ""}`.includes("刘海涛") || !`${pkg.author || ""}`.includes("319895455@qq.com")) {
    failures.push("package.json 缺少已确认的版权主体或联系邮箱");
  }
  if (desktopReleaseTree) {
    if (!readme.includes("DeepSeek") || !/桌面|Electron/.test(readme)) {
      failures.push("桌面版 README 必须明确产品形态与 DeepSeek-only 边界");
    }
  } else {
    if (!readme.includes("Pi") || !readme.includes("DeepSeek")) {
      failures.push("公开 README 必须明确 Pi 基础与 DeepSeek-only 边界");
    }
    if (/桌面|Electron/.test(readme)) failures.push("终端公开 README 不得宣传尚未公开的桌面产品");
  }
  if (!security.includes("319895455@qq.com")) failures.push("SECURITY.md 缺少私密联系邮箱");
}

const files = auditedFiles();
inspectCurrentTree(files);
inspectIgnoreRules();
inspectMetadata();
inspectHistory();
inspectRequiredDocuments();
inspectPublicPositioning();

for (const warning of warnings) process.stdout.write(`WARN  ${warning}\n`);
for (const failure of failures) process.stderr.write(`FAIL  ${failure}\n`);
if (failures.length) {
  process.stderr.write(`开源审计未通过：${failures.length} 项。\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`开源审计通过${warnings.length ? `（${warnings.length} 项已显式暂缓）` : ""}。\n`);
}
