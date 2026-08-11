#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline/promises");
const { Writable } = require("node:stream");
const { createApplicationServices } = require("../application/appServices");
const { isPathInside } = require("../platform/shared/pathSafety");
const { runUninstall } = require("./uninstall");

const PACKAGE_ROOT = path.resolve(__dirname, "../..");
const PACKAGE_JSON = require(path.join(PACKAGE_ROOT, "package.json"));
const DEFAULT_HOME_WORKSPACE = "Yaoguo Workspace";

function parseArgs(argv = []) {
  const options = {
    prompt: "",
    workspace: "",
    dataDir: "",
    projectId: "",
    taskId: "",
    newSession: false,
    autoApprove: false,
    json: false,
    verbose: false,
    quiet: false,
    help: false,
    version: false
  };
  const positional = [];
  const valueFlags = new Map([
    ["--prompt", "prompt"],
    ["--workspace", "workspace"],
    ["--data-dir", "dataDir"],
    ["--project", "projectId"],
    ["--task", "taskId"]
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = `${argv[index] || ""}`;
    if (argument === "--") {
      positional.push(...argv.slice(index + 1));
      break;
    }
    const inline = argument.match(/^(--[^=]+)=(.*)$/s);
    const flag = inline?.[1] || argument;
    if (valueFlags.has(flag)) {
      const value = inline ? inline[2] : argv[++index];
      if (value === undefined || `${value}` === "") throw new Error(`${flag} 缺少参数。`);
      options[valueFlags.get(flag)] = `${value}`;
      continue;
    }
    if (["--new", "-n"].includes(flag)) options.newSession = true;
    else if (["--yes", "-y"].includes(flag)) options.autoApprove = true;
    else if (flag === "--json") options.json = true;
    else if (["--verbose", "-v"].includes(flag)) options.verbose = true;
    else if (["--quiet", "-q"].includes(flag)) options.quiet = true;
    else if (["--help", "-h"].includes(flag)) options.help = true;
    else if (["--version", "-V"].includes(flag)) options.version = true;
    else if (flag.startsWith("-")) throw new Error(`未知参数：${flag}`);
    else positional.push(argument);
  }
  if (!options.prompt && positional.length) options.prompt = positional.join(" ").trim();
  if (options.verbose && options.quiet) throw new Error("--verbose 与 --quiet 不能同时使用。");
  return options;
}

function resolveDataRoot(options = {}, env = process.env, homeDirectory = os.homedir()) {
  const configured = `${options.dataDir || env.YAOGUO_HOME || ""}`.trim();
  return path.resolve(configured || path.join(homeDirectory, ".yaoguo", "runtime"));
}

async function readStream(stream) {
  let content = "";
  for await (const chunk of stream) content += chunk.toString("utf8");
  return content.trim();
}

function helpText() {
  return [
    "腰果 — 基于 Pi、仅支持 DeepSeek 的终端 Agent",
    "",
    "用法：",
    "  yaoguo [选项] [任务]",
    "  echo '任务' | yaoguo [选项]",
    "  yaoguo                 进入交互会话",
    "  yaoguo uninstall       卸载程序和运行数据，保留已发布成品",
    "",
    "选项：",
    "  --workspace <目录>     Agent 工作空间，默认当前目录；主目录启动时使用 ~/Yaoguo Workspace",
    "  --data-dir <目录>      腰果运行数据目录，默认 ~/.yaoguo/runtime",
    "  --project <id>         使用或创建指定项目",
    "  --task <id>            使用或创建指定会话",
    "  -n, --new              在当前工作空间创建新会话",
    "  -y, --yes              本次进程自动授权需确认的工具操作",
    "  --json                  单次任务输出 JSON，不输出 token 流",
    "  -v, --verbose           在 stderr 显示 Agent 活动",
    "  -q, --quiet             隐藏活动与本轮 token 统计",
    "  -h, --help              显示帮助",
    "  -V, --version           显示版本",
    "",
    "交互命令：",
    "  /model                  选择 Pro / Flash，并设置 DeepSeek API Key",
    "  /usage                  查看当前会话累计 token 与缓存命中",
    "  /tokens                 /usage 的别名",
    "  /clear                  清空当前屏幕，不删除已保存会话",
    "  /help                   查看交互命令与快捷键",
    "  /exit                   退出交互会话",
    "",
    "终端界面：Enter 发送，Shift+Enter 或 Ctrl+J 换行，Esc 中止当前任务，/ 打开菜单。",
    "",
    "模型密钥只从 DEEPSEEK_API_KEY 或本机配置读取，不接受命令行明文参数。"
  ].join("\n");
}

function createTerminal(options = {}, streams = {}) {
  const input = streams.input || process.stdin;
  const output = streams.output || process.stdout;
  const error = streams.error || process.stderr;
  const interactive = Boolean(input.isTTY && output.isTTY && error.isTTY);
  const useTui = Boolean(
    interactive
    && streams.tui !== false
    && input === process.stdin
    && output === process.stdout
    && error === process.stderr
    && process.env.TERM !== "dumb"
  );
  const readlineState = { hidden: false };
  const rl = useTui ? null : createReadlineInterface({
    input, error, interactive, readlineState
  });
  const terminal = {
    input, output, error, interactive, rl, options,
    useTui,
    ui: null,
    readlineState,
    activeController: null,
    exitRequested: false
  };
  rl?.on("SIGINT", () => {
    terminal.exitRequested = true;
    if (terminal.activeController && !terminal.activeController.signal.aborted) {
      terminal.error.write("\n正在停止当前任务…\n");
      terminal.activeController.abort(new Error("用户中断终端任务"));
    }
    terminal.rl.close();
  });
  return terminal;
}

function createReadlineInterface({ input, error, interactive, readlineState }) {
  const readlineOutput = new Writable({
    write(chunk, encoding, callback) {
      if (!readlineState.hidden) error.write(chunk, encoding);
      callback();
    }
  });
  readlineOutput.isTTY = interactive;
  readlineOutput.columns = Number(error.columns) || 80;
  readlineOutput.rows = Number(error.rows) || 24;
  return readline.createInterface({
    input,
    output: readlineOutput,
    terminal: interactive,
    historySize: 100,
    removeHistoryDuplicates: true
  });
}

function createApprovalHandler(terminal) {
  return async (request = {}) => {
    if (terminal.options.autoApprove) return { decision: "allow_session" };
    if (!terminal.interactive) return { decision: "deny" };
    const allowed = new Set(request.allowedDecisions || ["deny", "allow_once"]);
    if (terminal.ui) {
      const choices = [
        ["allow_once", "允许一次", "仅允许本次工具操作"],
        ["allow_session", "本次进程允许", "相同目标在当前进程复用"],
        ["allow_always", "以后允许此项", "持久保存精确授权"],
        ["allow_effect", "以后允许此类型", "持久保存操作类型授权"],
        ["deny", "拒绝", "不执行本次操作"]
      ].filter(([decision]) => allowed.has(decision));
      const decision = await terminal.ui.choose({
        title: "需要授权",
        description: [
          request.summary,
          request.target && `目标：${request.target}`,
          request.boundary && `边界：${request.boundary}`
        ]
          .filter(Boolean)
          .join("\n"),
        items: choices.map(([value, label, description]) => ({ value, label, description }))
      });
      return { decision: decision || "deny" };
    }
    terminal.error.write([
      "\n需要授权",
      request.summary ? `\n${request.summary}` : "",
      request.target ? `\n目标：${request.target}` : "",
      request.boundary ? `\n边界：${request.boundary}` : "",
      "\n"
    ].join(""));
    const choices = [
      ["y", "allow_once", "允许一次"],
      ["s", "allow_session", "本次进程允许"],
      ["a", "allow_always", "以后允许此项"],
      ["e", "allow_effect", "以后允许此类型"],
      ["n", "deny", "拒绝"]
    ].filter(([, decision]) => allowed.has(decision));
    const label = choices.map(([key, , text]) => `${key}=${text}`).join("，");
    while (true) {
      const answer = (await terminal.rl.question(`选择 [${label}]：`)).trim().toLowerCase();
      const selected = choices.find(([key]) => answer === key);
      if (selected) return { decision: selected[1] };
    }
  };
}

async function ensureModelAvailable(settingsService, env = process.env) {
  const settings = await settingsService.get();
  const config = settings.deepseek || {};
  const envName = `${config.apiKeyEnv || "DEEPSEEK_API_KEY"}`;
  if (!config.apiKey && !env[envName]) {
    throw new Error(`缺少 DeepSeek API Key。请设置环境变量 ${envName}，或进入交互终端后输入 /model。`);
  }
  if (!config.enabled) {
    await settingsService.mutate((next) => {
      next.deepseek = { ...(next.deepseek || {}), enabled: true };
    });
  }
}

function isModelCommand(message = "") {
  return `${message || ""}`.trim().toLowerCase() === "/model";
}

async function modelConfiguration(settingsService, env = process.env) {
  const settings = await settingsService.get();
  const config = settings.deepseek || {};
  const envName = `${config.apiKeyEnv || "DEEPSEEK_API_KEY"}`;
  const model = config.model === "deepseek-v4-flash" ? "deepseek-v4-flash" : "deepseek-v4-pro";
  const keySource = config.apiKey
    ? "本机私有配置"
    : (env[envName] ? `环境变量 ${envName}` : "未配置");
  return {
    model,
    modelLabel: model === "deepseek-v4-flash" ? "Flash" : "Pro",
    keySource,
    available: Boolean(config.apiKey || env[envName])
  };
}

function forgetReadlineValue(rl, value) {
  if (!Array.isArray(rl?.history) || !value) return;
  for (let index = rl.history.length - 1; index >= 0; index -= 1) {
    if (rl.history[index] === value) rl.history.splice(index, 1);
  }
}

async function readSecret(terminal, prompt) {
  if (!terminal.interactive) throw new Error("API Key 只能在交互终端中输入。");
  terminal.error.write(prompt);
  if (terminal.readlineState) terminal.readlineState.hidden = true;
  let value = "";
  try {
    value = await terminal.rl.question("");
    return `${value || ""}`.trim();
  } finally {
    forgetReadlineValue(terminal.rl, value);
    if (terminal.readlineState) terminal.readlineState.hidden = false;
    terminal.error.write("\n");
  }
}

async function saveDeepSeekSettings(settingsService, patch = {}) {
  return settingsService.mutate((settings) => {
    settings.deepseek = {
      ...(settings.deepseek || {}),
      ...patch,
      enabled: true
    };
  });
}

async function runModelMenu(settingsService, terminal, env = process.env) {
  if (terminal.ui) return runTuiModelMenu(settingsService, terminal, env);
  while (true) {
    const current = await modelConfiguration(settingsService, env);
    terminal.error.write([
      "\n模型设置",
      `\n当前：${current.modelLabel} · API Key ${current.keySource}`,
      "\n1. Pro",
      "\n2. Flash",
      "\n3. 设置或更新 API Key",
      "\n0. 返回\n"
    ].join(""));
    const choice = (await terminal.rl.question("选择 [0-3]：")).trim().toLowerCase();
    if (["", "0", "q"].includes(choice)) return current;
    if (["1", "2"].includes(choice)) {
      const model = choice === "1" ? "deepseek-v4-pro" : "deepseek-v4-flash";
      await saveDeepSeekSettings(settingsService, { model });
      const next = await modelConfiguration(settingsService, env);
      terminal.error.write(`已选择 ${next.modelLabel}。\n`);
      if (!next.available) {
        const apiKey = await readSecret(terminal, "粘贴 DeepSeek API Key（输入已隐藏，留空跳过）：");
        if (apiKey) {
          await saveDeepSeekSettings(settingsService, { apiKey });
          terminal.error.write("API Key 已保存到本机私有配置。\n");
        }
      }
      return modelConfiguration(settingsService, env);
    }
    if (["3", "k", "key"].includes(choice)) {
      const apiKey = await readSecret(terminal, "粘贴 DeepSeek API Key（输入已隐藏，留空取消）：");
      if (apiKey) {
        await saveDeepSeekSettings(settingsService, { apiKey });
        terminal.error.write("API Key 已保存到本机私有配置。\n");
      }
      return modelConfiguration(settingsService, env);
    }
    terminal.error.write("请输入 0、1、2 或 3。\n");
  }
}

async function runTuiModelMenu(settingsService, terminal, env = process.env) {
  const current = await modelConfiguration(settingsService, env);
  const choice = await terminal.ui.choose({
    title: "模型设置",
    description: `当前：${current.modelLabel} · API Key ${current.keySource}`,
    selectedIndex: current.model === "deepseek-v4-flash" ? 1 : 0,
    items: [
      { value: "pro", label: "Pro", description: "DeepSeek V4 Pro" },
      { value: "flash", label: "Flash", description: "DeepSeek V4 Flash" },
      { value: "key", label: "API Key", description: "设置或更新本机密钥" },
      { value: "cancel", label: "返回", description: "保持当前设置" }
    ]
  });
  if (!choice || choice === "cancel") return current;
  if (["pro", "flash"].includes(choice)) {
    await saveDeepSeekSettings(settingsService, {
      model: choice === "flash" ? "deepseek-v4-flash" : "deepseek-v4-pro"
    });
  }
  let next = await modelConfiguration(settingsService, env);
  if (choice === "key" || !next.available) {
    const apiKey = await terminal.ui.promptSecret({
      title: "DeepSeek API Key",
      description: "输入已隐藏，不会写入终端历史。Esc 取消。"
    });
    if (apiKey) {
      await saveDeepSeekSettings(settingsService, { apiKey });
      terminal.ui.addSuccess("API Key 已保存到本机私有配置。");
    }
  }
  next = await modelConfiguration(settingsService, env);
  terminal.ui.updateModel(next);
  if (["pro", "flash"].includes(choice)) terminal.ui.addSuccess(`已选择 ${next.modelLabel}。`);
  return next;
}

function workspaceTaskId(workspacePath) {
  const digest = crypto.createHash("sha256").update(workspacePath, "utf8").digest("hex").slice(0, 12);
  return `cwd-${digest}`;
}

function pathsOverlap(firstPath, secondPath) {
  return isPathInside(firstPath, secondPath) || isPathInside(secondPath, firstPath);
}

async function resolveWorkspaceSelection(services, options = {}, runtime = {}) {
  const explicitWorkspace = `${options.workspace || ""}`.trim();
  const currentDirectory = runtime.currentDirectory || process.cwd();
  const homeDirectory = runtime.homeDirectory || os.homedir();
  const requestedWorkspace = path.resolve(explicitWorkspace || currentDirectory);
  const stat = await fsp.stat(requestedWorkspace).catch(() => null);
  if (!stat?.isDirectory()) throw new Error(`工作空间不是有效目录：${requestedWorkspace}`);
  const workspacePath = await fsp.realpath(requestedWorkspace);
  const hostWorkspace = `${services?.projectService?.paths?.workspace || ""}`.trim();
  if (!hostWorkspace) return { workspacePath, autoSelected: false };
  const canonicalHostWorkspace = await fsp.realpath(hostWorkspace)
    .catch(() => path.resolve(hostWorkspace));
  if (!pathsOverlap(canonicalHostWorkspace, workspacePath)) {
    return { workspacePath, autoSelected: false };
  }
  if (explicitWorkspace) {
    throw new Error("不能把腰果的宿主数据目录或其上级目录设为 Agent 工作空间；请通过 --workspace 选择独立目录。");
  }
  const fallbackPath = path.resolve(homeDirectory, DEFAULT_HOME_WORKSPACE);
  await fsp.mkdir(fallbackPath, { recursive: true });
  const canonicalFallback = await fsp.realpath(fallbackPath);
  if (pathsOverlap(canonicalHostWorkspace, canonicalFallback)) {
    throw new Error("默认工作空间与腰果宿主数据目录冲突；请通过 --workspace 选择独立目录。");
  }
  return { workspacePath: canonicalFallback, autoSelected: true };
}

async function resolveSession(services, options = {}, runtime = {}) {
  const workspaceSelection = await resolveWorkspaceSelection(services, options, runtime);
  const { workspacePath } = workspaceSelection;
  const projectId = options.projectId || "terminal";
  let project = await services.projectService.getProject(projectId, false);
  if (!project) {
    project = await services.projectService.createProject({
      id: projectId,
      name: projectId === "terminal" ? "终端工作区" : projectId
    });
  }
  const taskId = options.taskId || (options.newSession
    ? `session-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`
    : workspaceTaskId(workspacePath));
  let task = await services.projectService.getTask(project.id, taskId, false);
  if (!task) {
    task = await services.projectService.createTask(project.id, {
      id: taskId,
      title: options.newSession ? `${path.basename(workspacePath)} · 新会话` : path.basename(workspacePath)
    });
  }
  if (task.workspacePath) {
    const resolved = await services.projectService.resolveTaskWorkspace(project.id, task.id);
    if (resolved.workspacePath !== workspacePath) {
      throw new Error(`会话 ${task.id} 已绑定另一工作空间：${resolved.workspacePath}`);
    }
    task = resolved.task;
  } else {
    task = await services.projectService.bindTaskWorkspace(project.id, task.id, workspacePath);
  }
  return { project, task, ...workspaceSelection };
}

function activityReporter(terminal) {
  let previous = "";
  return (activity = {}) => {
    if (terminal.options.json || terminal.options.quiet) return;
    if (!terminal.interactive && !terminal.options.verbose) return;
    const label = `${activity.label || activity.status || ""}`.trim();
    if (!label || label === previous) return;
    if (!terminal.options.verbose && activity.kind === "tool" && activity.status !== "running") {
      previous = "";
      return;
    }
    previous = label;
    if (terminal.ui) {
      terminal.ui.setActivity(label, activity.status);
      return;
    }
    const icon = activity.status === "completed"
      ? "✓"
      : (activity.status === "blocked" ? "!" : (activity.kind === "tool" ? "↳" : "◆"));
    terminal.error.write(`${icon} ${label}\n`);
  };
}

function formatTokenCount(value) {
  return Math.max(0, Number(value) || 0).toLocaleString("en-US");
}

function formatDuration(durationMs) {
  const seconds = Math.max(0, Number(durationMs) || 0) / 1000;
  return seconds < 60 ? `${seconds.toFixed(1)}s` : `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

function formatUsage(usage = {}, { label = "本轮", durationMs = null } = {}) {
  const cacheHitTokens = Math.max(0, Number(usage.cacheHitTokens) || 0);
  const cacheMissTokens = Math.max(0, Number(usage.cacheMissTokens) || 0);
  const cachePromptTokens = cacheHitTokens + cacheMissTokens;
  const cacheRate = cachePromptTokens > 0
    ? `${Math.round((cacheHitTokens / cachePromptTokens) * 100)}%`
    : "—";
  const rows = [
    `${label} ${formatTokenCount(usage.modelCalls)} 次模型调用`,
    `输入 ${formatTokenCount(usage.promptTokens)}`,
    `输出 ${formatTokenCount(usage.completionTokens)}`
  ];
  if (Number(usage.reasoningTokens) > 0) rows.push(`推理 ${formatTokenCount(usage.reasoningTokens)}`);
  rows.push(`缓存命中 ${cacheRate}（${formatTokenCount(cacheHitTokens)}/${formatTokenCount(cachePromptTokens)}）`);
  if (durationMs !== null) rows.push(formatDuration(durationMs));
  return rows.join(" · ");
}

function isUsageCommand(message = "") {
  return ["/usage", "/tokens"].includes(`${message || ""}`.trim().toLowerCase());
}

async function sessionUsage(services, session) {
  const ledger = services?.platformKernel?.tokenLedger;
  if (typeof ledger?.summarizeUsage !== "function") throw new Error("Token 统计服务不可用。");
  return ledger.summarizeUsage({ projectId: session.project.id, taskId: session.task.id });
}

async function printSessionUsage(services, terminal, session) {
  const usage = await sessionUsage(services, session);
  if (terminal.ui) {
    terminal.ui.addNotice(formatUsage(usage, { label: "会话累计" }));
    terminal.ui.setUsageText(formatTuiUsage(usage));
  }
  else if (terminal.options.json) terminal.output.write(`${JSON.stringify({ usage }, null, 2)}\n`);
  else terminal.output.write(`${formatUsage(usage, { label: "会话累计" })}\n`);
  return usage;
}

function formatTuiCount(value) {
  const count = Math.max(0, Number(value) || 0);
  if (count < 1000) return `${Math.round(count)}`;
  if (count < 1_000_000) return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k`;
  return `${(count / 1_000_000).toFixed(1)}m`;
}

function formatTuiUsage(usage = {}) {
  const hit = Math.max(0, Number(usage.cacheHitTokens) || 0);
  const miss = Math.max(0, Number(usage.cacheMissTokens) || 0);
  const total = hit + miss;
  const cache = total > 0 ? `${Math.round((hit / total) * 100)}%` : "—";
  return `↑${formatTuiCount(usage.promptTokens)} ↓${formatTuiCount(usage.completionTokens)} C${cache}`;
}

async function runTurn(services, terminal, session, message) {
  const startedAt = Date.now();
  const controller = new AbortController();
  terminal.activeController = controller;
  let streamed = false;
  let result;
  const tuiStream = terminal.ui?.beginAssistant();
  try {
    result = await services.workflowEngine.submitAgentInput({
      message,
      projectId: session.project.id,
      taskId: session.task.id,
      source: "terminal",
      turnId: crypto.randomUUID()
    }, {
      signal: controller.signal,
      onToken: terminal.options.json ? null : (delta) => {
        if (!delta) return;
        streamed = true;
        if (terminal.ui) terminal.ui.appendAssistant(tuiStream, delta);
        else terminal.output.write(delta);
      }
    });
  } catch (error) {
    terminal.ui?.cancelAssistant(tuiStream);
    throw error;
  } finally {
    if (terminal.activeController === controller) terminal.activeController = null;
  }
  if (terminal.ui) {
    terminal.ui.finishAssistant(tuiStream, result.reply || "");
    for (const artifact of result.artifacts || []) terminal.ui.addArtifact(artifact?.absolute);
    if (result.usage) terminal.ui.setUsageText(formatTuiUsage(result.usage));
  }
  else if (terminal.options.json) {
    terminal.output.write(`${JSON.stringify({
      projectId: session.project.id,
      taskId: session.task.id,
      workspacePath: session.workspacePath,
      ...result
    }, null, 2)}\n`);
  } else {
    if (streamed) terminal.output.write("\n");
    if (!streamed || result.blocked || result.cancelled) terminal.output.write(`${result.reply || ""}\n`);
    for (const artifact of result.artifacts || []) {
      if (artifact?.absolute) terminal.error.write(`成品：${artifact.absolute}\n`);
    }
    if (!terminal.options.quiet && result.usage) {
      terminal.error.write(`${formatUsage(result.usage, { durationMs: Date.now() - startedAt })}\n`);
    }
  }
  return result;
}

async function stopServices(services) {
  services?.taskAgentCoordinator?.abortAll?.("终端进程正在退出");
  await Promise.allSettled([
    services?.memoryExtractionService?.stop?.(),
    services?.autoDreamService?.stop?.(),
    services?.sessionMemoryService?.stop?.(),
    services?.schedulerService?.stop?.(),
    services?.bridgeService?.stop?.()
  ].filter(Boolean));
}

async function runInteractive(services, terminal, session, env = process.env) {
  if (terminal.useTui) return runInteractiveTui(services, terminal, session, env);
  return runInteractiveReadline(services, terminal, session, env);
}

async function runInteractiveReadline(services, terminal, session, env = process.env) {
  const initialModel = await modelConfiguration(services.settingsService, env);
  terminal.error.write([
    `腰果终端版 ${PACKAGE_JSON.version}`,
    `\n工作空间：${session.workspacePath}`,
    `\n模型：${initialModel.modelLabel} · API Key ${initialModel.keySource}`,
    initialModel.available ? "" : "\n输入 /model 完成模型与 API Key 设置。",
    "\n输入 /exit 退出。\n\n"
  ].join(""));
  while (true) {
    let message;
    try {
      message = (await terminal.rl.question("你 > ")).trim();
    } catch {
      break;
    }
    if (!message) continue;
    if (["/exit", "/quit"].includes(message.toLowerCase())) break;
    if (isModelCommand(message)) {
      await runModelMenu(services.settingsService, terminal, env);
      terminal.error.write("\n");
      continue;
    }
    if (isUsageCommand(message)) {
      await printSessionUsage(services, terminal, session);
      terminal.error.write("\n");
      continue;
    }
    try {
      await ensureModelAvailable(services.settingsService, env);
    } catch (error) {
      terminal.error.write(`${error?.message || error}\n\n`);
      continue;
    }
    terminal.error.write("腰果 > ");
    await runTurn(services, terminal, session, message);
    if (terminal.exitRequested) break;
    terminal.error.write("\n");
  }
}

async function runInteractiveTui(services, terminal, session, env = process.env) {
  const { createTerminalUi } = require("./tui/terminalUi");
  const initialModel = await modelConfiguration(services.settingsService, env);
  const ui = await createTerminalUi({
    workspacePath: session.workspacePath,
    modelLabel: initialModel.modelLabel,
    keyAvailable: initialModel.available,
    version: PACKAGE_JSON.version
  });
  terminal.ui = ui;
  const history = await loadTerminalHistory(services, session);
  ui.addConversationHistory(history);
  if (history.length) ui.addNotice(`已恢复 ${history.length} 条会话记录。`);
  else ui.addNotice("输入消息开始对话；输入 / 打开命令菜单。");
  if (!initialModel.available) ui.addNotice("尚未配置 API Key，请通过 /model 完成设置。");
  ui.start({
    onSubmit: (message) => handleTuiSubmission(services, terminal, session, message, env),
    onInterrupt: () => {
      if (terminal.activeController && !terminal.activeController.signal.aborted) {
        terminal.activeController.abort(new Error("用户中断终端任务"));
      }
    }
  });
  try {
    await ui.waitForExit();
  } finally {
    await ui.dispose();
  }
}

async function loadTerminalHistory(services, session) {
  if (typeof services?.workflowEngine?.listAgentMessages !== "function") return [];
  return services.workflowEngine.listAgentMessages({
    projectId: session.project.id,
    taskId: session.task.id,
    limit: 24
  }).catch(() => []);
}

async function handleTuiSubmission(services, terminal, session, message, env = process.env) {
  const command = `${message || ""}`.trim().toLowerCase();
  if (["/exit", "/quit"].includes(command)) {
    terminal.ui.exit();
    return;
  }
  if (isModelCommand(command)) {
    await runModelMenu(services.settingsService, terminal, env);
    return;
  }
  if (isUsageCommand(command)) {
    await printSessionUsage(services, terminal, session);
    return;
  }
  if (command === "/clear") {
    terminal.ui.clearConversation();
    terminal.ui.addNotice("已清空当前屏幕，已保存的会话与成品未删除。");
    return;
  }
  if (command === "/help") {
    terminal.ui.addNotice([
      "/model  模型与 API Key",
      "/usage  token 与缓存命中",
      "/clear  清空当前屏幕",
      "/exit   退出",
      "Enter 发送 · Shift+Enter 换行 · Esc/Ctrl+C 中止任务"
    ].join("\n"));
    return;
  }
  terminal.ui.addUserMessage(message);
  terminal.ui.setBusy(true, "正在检查模型…");
  try {
    await ensureModelAvailable(services.settingsService, env);
    await runTurn(services, terminal, session, message);
  } catch (error) {
    if (isTerminalAbort(error)) terminal.ui.addNotice("当前任务已中止。");
    else terminal.ui.addError(error?.message || error);
  } finally {
    terminal.ui.setBusy(false);
  }
}

function isTerminalAbort(error) {
  return error?.name === "AbortError" || /取消|中止|abort/i.test(`${error?.message || error || ""}`);
}

async function main(argv = process.argv.slice(2), streams = {}) {
  if (argv[0] === "uninstall") {
    return runUninstall(argv.slice(1), { packageRoot: PACKAGE_ROOT, streams });
  }
  const options = parseArgs(argv);
  if (options.help) {
    (streams.output || process.stdout).write(`${helpText()}\n`);
    return 0;
  }
  if (options.version) {
    (streams.output || process.stdout).write(`${PACKAGE_JSON.version}\n`);
    return 0;
  }
  const input = streams.input || process.stdin;
  if (!options.prompt && !input.isTTY) options.prompt = await readStream(input);
  const terminal = createTerminal(options, streams);
  const dataRoot = resolveDataRoot(options);
  let services = null;
  try {
    services = await createApplicationServices({
      projectRoot: dataRoot,
      seedWorkspaceRoot: path.join(PACKAGE_ROOT, "workspace"),
      startBackgroundServices: false,
      requestToolApproval: createApprovalHandler(terminal),
      onActivity: activityReporter(terminal)
    });
    const session = await resolveSession(services, options);
    const prompt = options.prompt;
    if (prompt && isUsageCommand(prompt)) await printSessionUsage(services, terminal, session);
    else if (prompt && isModelCommand(prompt)) {
      if (!terminal.interactive) throw new Error("/model 只能在交互终端中使用。");
      await runModelMenu(services.settingsService, terminal);
    }
    else if (prompt) {
      await ensureModelAvailable(services.settingsService);
      await runTurn(services, terminal, session, prompt);
    }
    else if (terminal.interactive) await runInteractive(services, terminal, session);
    else {
      throw new Error("没有收到任务内容。请通过参数或 stdin 提供任务。");
    }
    return 0;
  } finally {
    terminal.rl?.close();
    await terminal.ui?.dispose?.();
    await stopServices(services);
  }
}

if (require.main === module) {
  main().then(
    (code) => { process.exitCode = code; },
    (error) => {
      process.stderr.write(`腰果启动失败：${error?.message || error}\n`);
      process.exitCode = 1;
    }
  );
}

module.exports = {
  parseArgs,
  resolveDataRoot,
  readStream,
  helpText,
  createTerminal,
  createApprovalHandler,
  ensureModelAvailable,
  isModelCommand,
  modelConfiguration,
  runModelMenu,
  formatUsage,
  formatTuiUsage,
  isUsageCommand,
  sessionUsage,
  workspaceTaskId,
  resolveWorkspaceSelection,
  resolveSession,
  runTurn,
  runInteractive,
  main
};
