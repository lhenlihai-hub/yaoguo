#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline/promises");
const { Writable } = require("node:stream");
const { spawn } = require("node:child_process");
const { createApplicationServices } = require("../application/appServices");
const { isPathInside } = require("../platform/shared/pathSafety");
const { summarizeNameFromMessage, isAutoTaskTitle } = require("../platform/runtime/contentSignals");
const { runUninstall, archiveTaskPublishedArtifacts } = require("./uninstall");

const PACKAGE_ROOT = path.resolve(__dirname, "../..");
const PACKAGE_JSON = require(path.join(PACKAGE_ROOT, "package.json"));
const DEFAULT_HOME_WORKSPACE = "Yaoguo Workspace";
const EXPLICIT_ARTIFACT_EXTENSIONS = new Set([
  ".docx", ".pdf", ".pptx", ".xlsx", ".html", ".htm", ".md", ".txt",
  ".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg", ".csv", ".json", ".zip"
]);

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

async function openLocalPathWithSystem(targetPath, options = {}) {
  const signal = options.signal || null;
  if (signal?.aborted) return { ok: false, error: "任务已停止。" };
  const requested = `${targetPath || ""}`.trim();
  if (!requested || !path.isAbsolute(requested)) {
    return { ok: false, error: "本地打开目标必须是绝对路径。" };
  }
  const absolute = await fsp.realpath(path.resolve(requested)).catch(() => "");
  const stat = absolute ? await fsp.stat(absolute).catch(() => null) : null;
  if (!stat || (!stat.isFile() && !stat.isDirectory())) {
    return { ok: false, error: `本地打开目标不存在或类型不受支持：${requested}` };
  }
  const platform = `${options.platform || process.platform}`;
  const command = platform === "darwin" ? "open" : (platform === "linux" ? "xdg-open" : "");
  if (!command) return { ok: false, error: `当前系统不支持本地打开操作：${platform}` };
  const spawnProcess = options.spawnProcess || spawn;
  try {
    await launchDetachedProcess(spawnProcess, command, absolute, signal);
    return { ok: true, absolute };
  } catch (error) {
    return { ok: false, error: `无法使用系统应用打开路径：${error?.message || error}` };
  }
}

function launchDetachedProcess(spawnProcess, command, target, signal) {
  return new Promise((resolve, reject) => {
    let child;
    let settled = false;
    const finish = (error = null) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener?.("abort", onAbort);
      if (error) reject(error);
      else resolve();
    };
    const onAbort = () => {
      child?.kill?.();
      finish(signal?.reason || new Error("任务已停止。"));
    };
    try {
      child = spawnProcess(command, [target], { detached: true, stdio: "ignore" });
      child.once("error", finish);
      child.once("spawn", () => {
        child.unref?.();
        finish();
      });
      signal?.addEventListener?.("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    } catch (error) {
      finish(error);
    }
  });
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
    "  /model                  模型、思考强度与 DeepSeek API Key",
    "  /usage                  token、缓存命中与模型调用",
    "  /resume                 打开或删除历史会话",
    "  /new                    在当前工作空间新建会话",
    "  /permissions            切换 Ask / All agree 授权模式",
    "  /clear                  清空当前屏幕，不删除已保存会话",
    "  /help                   查看交互命令与快捷键",
    "  /quit                   退出交互会话",
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
    activeSession: null,
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
  const thinking = ["disabled", "high", "max"].includes(config.thinking) ? config.thinking : "max";
  const keySource = config.apiKey
    ? "本机私有配置"
    : (env[envName] ? `环境变量 ${envName}` : "未配置");
  return {
    model,
    modelLabel: model === "deepseek-v4-flash" ? "Flash" : "Pro",
    thinking,
    thinkingLabel: { disabled: "Thinking off", high: "High", max: "Max" }[thinking],
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
      `\n当前：${current.modelLabel} · ${current.thinkingLabel} · API Key ${current.keySource}`,
      "\n1. Pro",
      "\n2. Flash",
      "\n3. 设置或更新 API Key",
      "\n4. 思考强度",
      "\n0. 返回\n"
    ].join(""));
    const choice = (await terminal.rl.question("选择 [0-4]：")).trim().toLowerCase();
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
    if (["4", "t", "thinking"].includes(choice)) {
      terminal.error.write("思考强度：1=关闭，2=High，3=Max\n");
      const level = (await terminal.rl.question("选择 [1-3]：")).trim();
      const thinking = { 1: "disabled", 2: "high", 3: "max" }[level];
      if (thinking) {
        await saveDeepSeekSettings(settingsService, { thinking });
        const next = await modelConfiguration(settingsService, env);
        terminal.error.write(`思考强度已设为 ${next.thinkingLabel}。\n`);
        return next;
      }
      terminal.error.write("未修改思考强度。\n");
      continue;
    }
    terminal.error.write("请输入 0、1、2、3 或 4。\n");
  }
}

async function runTuiModelMenu(settingsService, terminal, env = process.env) {
  const current = await modelConfiguration(settingsService, env);
  const choice = await terminal.ui.choose({
    title: "模型设置",
    description: `当前：${current.modelLabel} · ${current.thinkingLabel} · API Key ${current.keySource}`,
    selectedIndex: current.model === "deepseek-v4-flash" ? 1 : 0,
    items: [
      { value: "pro", label: "Pro", description: "DeepSeek V4 Pro" },
      { value: "flash", label: "Flash", description: "DeepSeek V4 Flash" },
      { value: "thinking", label: "思考强度", description: "关闭 / High / Max，立即用于后续模型调用" },
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
  if (choice === "thinking") {
    const thinking = await terminal.ui.choose({
      title: "思考强度",
      description: "该设置会真实写入 DeepSeek thinking / reasoning_effort 请求参数。",
      selectedIndex: ["disabled", "high", "max"].indexOf(current.thinking),
      items: [
        { value: "disabled", label: "关闭", description: "关闭模型思考模式" },
        { value: "high", label: "High", description: "开启高强度思考" },
        { value: "max", label: "Max", description: "开启最大思考强度" }
      ]
    });
    if (thinking) await saveDeepSeekSettings(settingsService, { thinking });
  }
  let next = await modelConfiguration(settingsService, env);
  if (choice === "key" || (["pro", "flash"].includes(choice) && !next.available)) {
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
  if (choice === "thinking") terminal.ui.addSuccess(`思考强度已设为 ${next.thinkingLabel}。`);
  return next;
}

async function permissionConfiguration(settingsService, terminal = null) {
  const settings = await settingsService.get();
  const mode = settings.permissions?.agent?.mode === "allow" ? "allow" : "ask";
  const sessionOverride = terminal?.options?.autoApprove === true;
  return {
    mode: sessionOverride ? "allow" : mode,
    label: sessionOverride || mode === "allow" ? "All agree" : "Ask"
  };
}

async function runPermissionMenu(settingsService, terminal) {
  const current = await permissionConfiguration(settingsService, terminal);
  if (!terminal.ui) {
    terminal.error.write(`当前授权模式：${current.label}\n1. Ask\n2. All agree\n0. 返回\n`);
    const choice = (await terminal.rl.question("选择 [0-2]：")).trim();
    if (!["1", "2"].includes(choice)) return current;
    const mode = choice === "2" ? "allow" : "ask";
    await settingsService.setAgentPermissionMode(mode);
    terminal.options.autoApprove = mode === "allow";
    return permissionConfiguration(settingsService, terminal);
  }
  const choice = await terminal.ui.choose({
    title: "授权模式",
    description: "All agree 自动同意工具授权，但路径、沙箱、无提权与私网拦截等安全边界仍然生效。",
    selectedIndex: current.mode === "allow" ? 1 : 0,
    items: [
      { value: "ask", label: "Ask", description: "每次敏感操作前询问" },
      { value: "allow", label: "All agree", description: "自动同意后续工具授权" },
      { value: "cancel", label: "返回", description: "保持当前模式" }
    ]
  });
  if (!choice || choice === "cancel") return current;
  await settingsService.setAgentPermissionMode(choice);
  terminal.options.autoApprove = choice === "allow";
  const next = await permissionConfiguration(settingsService, terminal);
  terminal.ui.updatePermissionMode(next.label);
  terminal.ui.addSuccess(`授权模式已切换为 ${next.label}。`);
  return next;
}

function workspaceTaskId(workspacePath) {
  const digest = crypto.createHash("sha256").update(workspacePath, "utf8").digest("hex").slice(0, 12);
  return `cwd-${digest}`;
}

function pathsOverlap(firstPath, secondPath) {
  return isPathInside(firstPath, secondPath) || isPathInside(secondPath, firstPath);
}

function isTerminalPlaceholderTaskTitle(task = {}) {
  if (isAutoTaskTitle(task.title)) return true;
  if (task.autoNamedAt) return false;
  const workspaceName = path.basename(`${task.workspacePath || ""}`.trim());
  const title = `${task.title || ""}`.trim();
  return Boolean(workspaceName && [workspaceName, `${workspaceName} · 新会话`].includes(title));
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
  const stableTaskId = workspaceTaskId(workspacePath);
  const existingTasks = typeof services.projectService.listTasks === "function"
    ? await services.projectService.listTasks(project.id)
    : [];
  const reusableBlank = options.taskId || options.newSession
    ? null
    : await findReusableWorkspaceTask(services.projectService, project.id, existingTasks, workspacePath);
  const taskId = options.taskId
    || reusableBlank?.id
    || (!options.newSession && !existingTasks.some((candidate) => candidate.id === stableTaskId)
      ? stableTaskId
      : `session-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`);
  let task = await services.projectService.getTask(project.id, taskId, false);
  if (!task) {
    task = await services.projectService.createTask(project.id, {
      id: taskId,
      title: "新任务"
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

async function findReusableWorkspaceTask(projectService, projectId, tasks, workspacePath) {
  for (const task of Array.isArray(tasks) ? tasks : []) {
    if (`${task.workspacePath || ""}` && path.resolve(task.workspacePath) !== workspacePath) continue;
    if (typeof projectService.isBlankTask === "function") {
      if (await projectService.isBlankTask(projectId, task).catch(() => false)) return task;
      continue;
    }
    if (isAutoTaskTitle(task.title) && !task.lastRunId && !task.lastArtifact && !task.lastRunAt) return task;
  }
  return null;
}

async function activateSession(services, terminal, session, selectedTask) {
  let task = selectedTask;
  let workspacePath = `${task?.workspacePath || session.workspacePath || ""}`;
  if (task?.workspacePath) {
    const resolved = await services.projectService.resolveTaskWorkspace(session.project.id, task.id);
    task = resolved.task;
    workspacePath = resolved.workspacePath;
  } else if (workspacePath) {
    task = await services.projectService.bindTaskWorkspace(session.project.id, task.id, workspacePath);
  }
  session.task = task;
  session.workspacePath = workspacePath;
  terminal.activeSession = session;
  if (terminal.ui) {
    terminal.ui.updateSession({ workspacePath, taskTitle: task.title || task.id });
    terminal.ui.replaceConversationHistory(await loadTerminalHistory(services, session));
    const usage = await sessionUsage(services, session).catch(() => null);
    if (usage) terminal.ui.setUsageText(formatTuiUsage(usage));
    terminal.ui.addNotice(`已打开会话：${task.title || task.id}\n${workspacePath}`);
  }
  return session;
}

async function createNewSession(services, terminal, session) {
  const task = await services.projectService.createTask(session.project.id, {
    id: `session-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
    title: "新任务"
  });
  await activateSession(services, terminal, session, task);
  terminal.ui?.addSuccess("已创建新会话。");
  return session;
}

async function runResumeMenu(services, terminal, session) {
  const listedTasks = await services.projectService.listTasks(session.project.id);
  const tasks = await Promise.all(listedTasks.map(async (task) => ({
    ...task,
    title: await resolveResumeTaskTitle(services, session.project.id, task)
  })));
  if (!terminal.ui) {
    terminal.error.write("/resume 历史管理需要完整 TUI。\n");
    return session;
  }
  if (!tasks.length) {
    terminal.ui.addNotice("没有可恢复的历史会话。");
    return session;
  }
  const selectedId = await terminal.ui.choose({
    title: "历史会话",
    description: "选择会话后可以打开或删除；路径完整显示。",
    selectedIndex: Math.max(0, tasks.findIndex((task) => task.id === session.task.id)),
    items: tasks.map((task) => ({
      value: task.id,
      label: `${task.id === session.task.id ? "● " : ""}${task.title || task.id}`,
      description: `${task.workspacePath || "未绑定工作空间"} · ${formatTaskTime(task.updatedAt || task.createdAt)}`
    }))
  });
  if (!selectedId) return session;
  const task = tasks.find((item) => item.id === selectedId);
  if (!task) return session;
  const action = await terminal.ui.choose({
    title: task.title || task.id,
    description: `${task.workspacePath || "未绑定工作空间"}\n${task.id}`,
    items: [
      { value: "open", label: "打开", description: "切换到该会话并恢复最近对话" },
      { value: "delete", label: "删除", description: "删除会话记录和受管任务数据" },
      { value: "cancel", label: "返回", description: "不做修改" }
    ]
  });
  if (action === "open") return activateSession(services, terminal, session, task);
  if (action !== "delete") return session;
  const confirmed = await terminal.ui.choose({
    title: "确认删除会话",
    description: `将删除“${task.title || task.id}”及其受管数据。工作空间中的用户文件不会删除。`,
    selectedIndex: 1,
    items: [
      { value: "delete", label: "确认删除", description: "此操作不可撤销" },
      { value: "cancel", label: "取消", description: "保留该会话" }
    ]
  });
  if (confirmed !== "delete") return session;
  const deletingCurrent = task.id === session.task.id;
  const archived = await preserveTaskArtifacts(services, session.project.id, task.id);
  await services.projectService.deleteTask(session.project.id, task.id);
  if (deletingCurrent) {
    await createNewSession(services, terminal, session);
    if (archived.count) terminal.ui.addSuccess(`已保留 ${archived.count} 个成品：${archived.directory}`);
  } else terminal.ui.addSuccess([
    `已删除会话：${task.title || task.id}`,
    archived.count ? `已保留 ${archived.count} 个成品：${archived.directory}` : ""
  ].filter(Boolean).join("\n"));
  return session;
}

async function resolveResumeTaskTitle(services, projectId, task) {
  if (!isTerminalPlaceholderTaskTitle(task)) return `${task?.title || task?.id || "新任务"}`;
  const messages = typeof services?.workflowEngine?.listAgentMessages === "function"
    ? await services.workflowEngine.listAgentMessages({ projectId, taskId: task.id, limit: 2000 }).catch(() => [])
    : [];
  const firstMessage = messages.find((row) => row?.role === "user" && `${row.content || ""}`.trim());
  if (!firstMessage) return `${task.title || "新任务"}`;
  const title = summarizeNameFromMessage(firstMessage.content, "新任务", 10);
  if (title === task.title || typeof services.projectService.updateTask !== "function") return title;
  const updated = await services.projectService.updateTask(projectId, task.id, {
    title,
    autoNamedAt: task.autoNamedAt || new Date().toISOString()
  }).catch(() => null);
  return `${updated?.title || title}`;
}

async function preserveTaskArtifacts(services, projectId, taskId) {
  const projectRoot = `${services?.paths?.projectRoot || ""}`.trim();
  if (!projectRoot || typeof services?.projectService?.getTaskDir !== "function") {
    return { count: 0, bytes: 0, directory: "" };
  }
  const resolvedRoot = path.resolve(projectRoot);
  const artifactRoot = path.basename(resolvedRoot) === "runtime"
    ? path.join(path.dirname(resolvedRoot), "artifacts")
    : path.join(resolvedRoot, "artifacts");
  return archiveTaskPublishedArtifacts({
    taskDir: services.projectService.getTaskDir(projectId, taskId),
    artifactRoot,
    projectId,
    taskId
  });
}

function formatTaskTime(value = "") {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "时间未知";
  return new Date(timestamp).toLocaleString("zh-CN", { hour12: false });
}

function activityReporter(terminal) {
  let previous = "";
  return (activity = {}) => {
    if (
      activity.status === "renamed"
      && activity.task?.id
      && activity.task?.title
      && activity.task.id === terminal.activeSession?.task?.id
    ) {
      terminal.activeSession.task.title = activity.task.title;
      terminal.ui?.updateSession({ taskTitle: activity.task.title });
    }
    if (terminal.options.json || terminal.options.quiet) return;
    if (!terminal.interactive && !terminal.options.verbose) return;
    const label = `${activity.label || activity.status || ""}`.trim();
    if (!label || label === previous) return;
    if (terminal.ui) {
      previous = activity.status === "completed" ? "" : label;
      terminal.ui.recordActivity(activity);
      return;
    }
    if (!terminal.options.verbose && activity.kind === "tool" && activity.status !== "running") {
      previous = "";
      return;
    }
    previous = label;
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
  const cacheUsage = foregroundCacheUsage(usage);
  const cacheHitTokens = Math.max(0, Number(cacheUsage.cacheHitTokens) || 0);
  const cacheMissTokens = Math.max(0, Number(cacheUsage.cacheMissTokens) || 0);
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
  const cacheLabel = cacheUsage === usage ? "缓存命中" : "前台缓存";
  rows.push(`${cacheLabel} ${cacheRate}（${formatTokenCount(cacheHitTokens)}/${formatTokenCount(cachePromptTokens)}）`);
  const backgroundCalls = Math.max(0, Number(usage.background?.modelCalls) || 0);
  if (backgroundCalls > 0) {
    const backgroundHit = Math.max(0, Number(usage.background?.cacheHitTokens) || 0);
    const backgroundMiss = Math.max(0, Number(usage.background?.cacheMissTokens) || 0);
    const backgroundPrompt = backgroundHit + backgroundMiss;
    const backgroundRate = backgroundPrompt > 0
      ? `${Math.round((backgroundHit / backgroundPrompt) * 100)}%`
      : "—";
    rows.push(`后台 ${formatTokenCount(backgroundCalls)} 次，缓存 ${backgroundRate}`);
  }
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
  const cacheUsage = foregroundCacheUsage(usage);
  const hit = Math.max(0, Number(cacheUsage.cacheHitTokens) || 0);
  const miss = Math.max(0, Number(cacheUsage.cacheMissTokens) || 0);
  const total = hit + miss;
  const cache = total > 0 ? `${Math.round((hit / total) * 100)}%` : "—";
  return `↑${formatTuiCount(usage.promptTokens)} ↓${formatTuiCount(usage.completionTokens)} C${cache}`;
}

function foregroundCacheUsage(usage = {}) {
  return usage.foreground && typeof usage.foreground === "object"
    ? usage.foreground
    : usage;
}

async function resolveExplicitOutputTargets(message = "") {
  const source = `${message || ""}`;
  if (!/(?:输出|保存|存到|写到|放到|生成|制作|交付|这里|目录|位置)/u.test(source)) return [];
  const targets = [];
  const matches = [...source.matchAll(/(?:^|[\s"'`“‘（(])(\/[^\r\n"'`”’）)，。；;！!？?]+)/gu)];
  for (const match of matches) {
    const fragment = `${match[1] || ""}`.trim();
    const fragmentStart = Number(match.index) + `${match[0] || ""}`.indexOf(match[1]);
    let candidate = fragment.replace(/[，。；;！!？?：:]+$/gu, "").trim();
    while (candidate.startsWith("/")) {
      const stat = await fsp.stat(candidate).catch(() => null);
      if (stat?.isDirectory()) {
        if (isExplicitOutputContext(source, fragmentStart, candidate.length)) {
          targets.push({ path: await fsp.realpath(candidate), kind: "directory" });
        }
        break;
      }
      if (stat?.isFile()) {
        if (isExplicitOutputContext(source, fragmentStart, candidate.length)) {
          targets.push({ path: await fsp.realpath(candidate), kind: "file" });
        }
        break;
      }
      const extension = path.extname(candidate).toLowerCase();
      const parent = path.dirname(candidate);
      const parentStat = await fsp.stat(parent).catch(() => null);
      if (parentStat?.isDirectory() && EXPLICIT_ARTIFACT_EXTENSIONS.has(extension)) {
        if (isExplicitOutputContext(source, fragmentStart, candidate.length)) {
          targets.push({ path: path.resolve(candidate), kind: "file" });
        }
        break;
      }
      const shorter = candidate.replace(/\s+\S+$/u, "").trim();
      if (!shorter || shorter === candidate) break;
      candidate = shorter;
    }
  }
  return [...new Map(targets.map((target) => [target.path, target])).values()].slice(0, 4);
}

async function resolveExplicitOpenTargets(message = "") {
  const source = `${message || ""}`;
  if (!/(?:打开|显示|定位|访达|文件管理器|open|reveal)/iu.test(source)) return [];
  const targets = [];
  const matches = [...source.matchAll(/(?:^|[\s"'`“‘（(])(\/[^\r\n"'`”’）)，。；;！!？?]+)/gu)];
  for (const match of matches) {
    const fragment = `${match[1] || ""}`.trim();
    const fragmentStart = Number(match.index) + `${match[0] || ""}`.indexOf(match[1]);
    let candidate = fragment.replace(/[，。；;！!？?：:]+$/gu, "").trim();
    while (candidate.startsWith("/")) {
      const absolute = await fsp.realpath(candidate).catch(() => "");
      const stat = absolute ? await fsp.stat(absolute).catch(() => null) : null;
      if (stat && (stat.isFile() || stat.isDirectory())) {
        const before = source.slice(Math.max(0, fragmentStart - 28), fragmentStart);
        const after = source.slice(fragmentStart + candidate.length, fragmentStart + candidate.length + 28);
        if (isExplicitOpenContext(before, after)) {
          targets.push({ path: absolute, kind: stat.isDirectory() ? "directory" : "file" });
        }
        break;
      }
      const shorter = candidate.replace(/\s+\S+$/u, "").trim();
      if (!shorter || shorter === candidate) break;
      candidate = shorter;
    }
  }
  return [...new Map(targets.map((target) => [target.path, target])).values()].slice(0, 4);
}

function isExplicitOpenContext(before = "", after = "") {
  const openBefore = /(?:打开|显示|定位|访达|文件管理器|open|reveal)(?:一下)?(?:这个|该)?(?:本地)?(?:文件|文件夹|目录|路径)?[\s：:]*$/iu;
  const openAfter = /^\s*(?:这个|该)?(?:文件|文件夹|目录|路径)?(?:中|里|下)?\s*(?:帮我|请)?\s*(?:打开|显示|定位|open|reveal)/iu;
  return openBefore.test(before) || openAfter.test(after);
}

function isExplicitOutputContext(source, start, length) {
  const before = source
    .slice(Math.max(0, start - 40), start)
    .replace(/["'`“‘（(]\s*$/u, "");
  const after = source.slice(start + length, start + length + 60);
  const outputBefore = /(?:输出|保存|存到|写入|写到|放到|生成|制作|交付)(?:到|至|在)?(?:目录|位置)?[\s：:]*$/u;
  const hereAfter = /^\s*(?:在\s*)?(?:这里|这个(?:目录|位置)?|该(?:目录|位置)?)(?:里|下|中)?\s*(?:帮我|请)?\s*(?:做|制作|生成|输出|保存|写|放|交付)/u;
  const locatedBefore = /(?:在|到|至)[\s：:]*$/u;
  const outputAfter = /^\s*(?:中|里|下)?\s*(?:制作|生成|输出|保存|写入|放置|交付)/u;
  return outputBefore.test(before) || hereAfter.test(after) || (locatedBefore.test(before) && outputAfter.test(after));
}

async function runTurn(services, terminal, session, message) {
  const startedAt = Date.now();
  const controller = new AbortController();
  terminal.activeController = controller;
  let streamed = false;
  let result;
  const explicitOutputTargets = await resolveExplicitOutputTargets(message);
  const explicitOpenTargets = await resolveExplicitOpenTargets(message);
  const tuiStream = terminal.ui?.beginAssistant();
  for (const target of explicitOutputTargets) {
    terminal.ui?.recordActivity({
      phase: `output-target-${target.path}`,
      status: "completed",
      label: "已确认指定输出位置",
      target: target.path
    });
  }
  try {
    result = await services.workflowEngine.submitAgentInput({
      message,
      projectId: session.project.id,
      taskId: session.task.id,
      source: "terminal",
      explicitOutputTargets,
      explicitOpenTargets,
      turnId: crypto.randomUUID()
    }, {
      signal: controller.signal,
      onToken: terminal.options.json ? null : (delta) => {
        if (!delta) return;
        streamed = true;
        if (terminal.ui) terminal.ui.appendAssistant(tuiStream, delta);
        else terminal.output.write(delta);
      },
      onReasoning: terminal.options.json ? null : (delta, event) => {
        if (!terminal.ui) return;
        terminal.ui.appendReasoning(tuiStream, delta, event);
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
  const initialPermission = await permissionConfiguration(services.settingsService, terminal);
  terminal.error.write([
    `腰果终端版 ${PACKAGE_JSON.version}`,
    `\n工作空间：${session.workspacePath}`,
    `\n模型：${initialModel.modelLabel} · ${initialModel.thinkingLabel} · API Key ${initialModel.keySource}`,
    `\n授权：${initialPermission.label}`,
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
    if (message.toLowerCase() === "/new") {
      await createNewSession(services, terminal, session);
      continue;
    }
    if (message.toLowerCase() === "/resume") {
      await runResumeMenu(services, terminal, session);
      continue;
    }
    if (message.toLowerCase() === "/permissions") {
      await runPermissionMenu(services.settingsService, terminal);
      continue;
    }
    if (message.toLowerCase() === "/help") {
      terminal.output.write(`${helpText()}\n`);
      continue;
    }
    if (message.startsWith("/")) {
      terminal.error.write(`未知命令：${message}\n`);
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
  const initialPermission = await permissionConfiguration(services.settingsService, terminal);
  const ui = await createTerminalUi({
    workspacePath: session.workspacePath,
    taskTitle: session.task.title || session.task.id,
    modelLabel: initialModel.modelLabel,
    thinkingLabel: initialModel.thinkingLabel,
    permissionLabel: initialPermission.label,
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
  if (command === "/resume") {
    await runResumeMenu(services, terminal, session);
    return;
  }
  if (command === "/new") {
    await createNewSession(services, terminal, session);
    return;
  }
  if (command === "/permissions") {
    await runPermissionMenu(services.settingsService, terminal);
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
      "/resume 打开或删除历史会话",
      "/new    新建会话",
      "/permissions  Ask / All agree",
      "/clear  清空当前屏幕",
      "/quit   退出",
      "Enter 发送 · Shift+Enter 换行 · Esc/Ctrl+C 中止任务"
    ].join("\n"));
    return;
  }
  if (command.startsWith("/")) {
    terminal.ui.addError(`未知命令：${message}`);
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
      openLocalPath: (targetPath, openOptions) => openLocalPathWithSystem(targetPath, openOptions),
      requestToolApproval: createApprovalHandler(terminal),
      onActivity: activityReporter(terminal)
    });
    const session = await resolveSession(services, options);
    terminal.activeSession = session;
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
  openLocalPathWithSystem,
  helpText,
  createTerminal,
  createApprovalHandler,
  ensureModelAvailable,
  isModelCommand,
  modelConfiguration,
  runModelMenu,
  permissionConfiguration,
  runPermissionMenu,
  formatUsage,
  formatTuiUsage,
  isUsageCommand,
  sessionUsage,
  workspaceTaskId,
  resolveWorkspaceSelection,
  resolveSession,
  activateSession,
  createNewSession,
  runResumeMenu,
  resolveExplicitOutputTargets,
  resolveExplicitOpenTargets,
  runTurn,
  runInteractive,
  main
};
