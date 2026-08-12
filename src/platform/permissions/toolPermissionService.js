// @ts-check

const crypto = require("node:crypto");
const path = require("node:path");
const { appendJsonl } = require("../shared/fs");
const { KeyedSerialExecutor } = require("../shared/keyedSerialExecutor");

const APPROVAL_DECISIONS = new Set([
  "deny",
  "allow_once",
  "allow_session",
  "allow_always",
  "allow_effect"
]);
const SAFE_EFFECTS = new Set(["read", "model_compute", "agent_state_write"]);
const MAX_PERMISSION_TARGET_CHARS = 4096;
const permissionPersistenceExecutor = new KeyedSerialExecutor();
const EFFECT_PRESENTATION = Object.freeze({
  workspace_write: {
    label: "修改工作空间",
    boundary: "精确授权只对界面中的操作及资源生效；普通文件修改授权不包含生成、发布或废弃。“该类型全部允许”会放行所有工作空间写入。宿主控制目录和路径边界始终生效。"
  },
  command_execute: {
    label: "执行系统命令",
    boundary: "允许一次、本次任务和始终允许只对界面中的完整命令生效；“该类型全部允许”会放行所有命令执行。命令仍受工作空间文件范围、无网络、无提权和无外部应用控制边界限制。"
  },
  network_read: {
    label: "读取外部网络",
    boundary: "允许一次、本次任务和始终允许只对当前网络资源生效；“该类型全部允许”会放行所有公开网络读取。私网、环回地址、凭据 URL 和不安全重定向仍被拦截。"
  },
  external_open: {
    label: "在系统浏览器打开网页",
    boundary: "精确授权只允许界面中的公开 HTTP(S) 网址；“该类型全部允许”会放行所有公开网址。授权不会让 Agent 控制浏览器、读取网页会话或操作其他系统应用。"
  },
  local_open: {
    label: "使用系统应用打开本地路径",
    boundary: "精确授权只允许界面中的文件或文件夹；“该类型全部允许”会放行当前任务可访问路径的打开操作。Agent 仍不能控制外部应用，且工作空间、用户本轮授权路径与宿主控制目录边界始终生效。"
  },
  memory_write: {
    label: "写入长期记忆",
    boundary: "精确授权只保存界面中的这条内容；本次任务和始终允许仍按完全相同的内容生效。“该类型全部允许”会允许 Agent 提交其他长期记忆。写入始终绑定当前 canonical workspace，并受四种封闭类型、信息边界、大小与路径安全校验约束。"
  }
});

class ToolPermissionService {
  /**
   * @param {{
   *   settingsService?:any,
   *   paths?:{privateDir?:string, workspace?:string},
   *   requestApproval?:((request:any, options:{signal:any}) => Promise<any>) | null,
   *   clock?:() => Date
   * }} options
   */
  constructor({ settingsService, paths = {}, requestApproval = null, clock = () => new Date() } = {}) {
    this.settingsService = settingsService;
    this.requestApproval = requestApproval;
    this.clock = clock;
    const auditRoot = paths.privateDir || paths.workspace || "";
    this.auditFile = auditRoot ? path.join(auditRoot, "permission-audit.jsonl") : "";
    this.sessionGrants = new Set();
    this.promptQueues = new Map();
  }

  async authorize(input = {}) {
    const requests = describeToolPermissions(input);
    if (!requests.length) return { allow: true, source: "safe_effect" };
    const grants = [];
    for (const request of requests) {
      const result = await this.authorizeRequest(request, input.signal || null);
      if (!result.allow) return result;
      grants.push({ effect: request.effect, source: result.source });
    }
    return {
      allow: true,
      source: grants.length === 1 ? grants[0].source : "composite",
      grants
    };
  }

  async authorizeRequest(request, signal) {
    const mode = await this.readMode(request);
    if (mode === "deny") return this.deny(request, "settings", "设置已禁止此类操作。");
    if (mode === "allow") return this.allow(request, "settings");
    const sessionKey = permissionSessionKey(request);
    if (this.sessionGrants.has(sessionKey)) return this.allow(request, "session");
    return this.enqueuePrompt(permissionEffectQueueKey(request), sessionKey, request, signal);
  }

  async enqueuePrompt(queueKey, sessionKey, request, signal) {
    const previous = this.promptQueues.get(queueKey) || Promise.resolve();
    const current = previous
      .catch(() => null)
      .then(async () => {
        const mode = await this.readMode(request);
        if (mode === "deny") return this.deny(request, "settings", "设置已禁止此类操作。");
        if (mode === "allow") return this.allow(request, "settings");
        if (this.sessionGrants.has(sessionKey)) return this.allow(request, "session");
        return this.prompt(request, sessionKey, signal);
      });
    this.promptQueues.set(queueKey, current);
    try {
      return await current;
    } finally {
      if (this.promptQueues.get(queueKey) === current) this.promptQueues.delete(queueKey);
    }
  }

  async prompt(request, sessionKey, signal) {
    if (signal?.aborted) return this.deny(request, "cancelled", "任务已停止。");
    if (typeof this.requestApproval !== "function") {
      return this.deny(request, "unavailable", "当前运行环境无法显示授权请求。");
    }
    let response;
    try {
      response = await requestApprovalWithAbort(this.requestApproval, request, signal);
    } catch (error) {
      if (signal?.aborted) return this.deny(request, "cancelled", "任务已停止。");
      return this.deny(request, "error", `授权请求失败：${error?.message || error}`);
    }
    if (signal?.aborted) return this.deny(request, "cancelled", "任务已停止。");
    const allowedDecisions = new Set(request.allowedDecisions || ["deny", "allow_once"]);
    const candidate = APPROVAL_DECISIONS.has(response?.decision) ? response.decision : "deny";
    const decision = allowedDecisions.has(candidate) ? candidate : "deny";
    if (decision === "deny") return this.deny(request, "user", "用户未授权此操作。");
    if (decision === "allow_session") this.sessionGrants.add(sessionKey);
    if (decision === "allow_always") {
      try {
        await this.persistRule(request.grantKey, "allow");
      } catch {
        return this.allow(request, "allow_once_persist_failed");
      }
    }
    if (decision === "allow_effect") {
      try {
        await this.persistRule(buildEffectGrantKey(request.effect), "allow");
      } catch {
        return this.allow(request, "allow_once_persist_failed");
      }
    }
    return this.allow(request, decision);
  }

  async persistRule(key, mode) {
    if (typeof this.settingsService?.setToolPermissionRule !== "function") {
      throw new Error("授权设置存储不可用。");
    }
    const persistenceKey = `${this.settingsService.paths?.settingsFile || "agent-permissions"}`;
    return permissionPersistenceExecutor.run(persistenceKey, () => (
      this.settingsService.setToolPermissionRule(key, mode)
    ));
  }

  clearSessionGrants() {
    this.sessionGrants.clear();
  }

  async readMode(request) {
    const settings = await this.settingsService?.get?.().catch(() => ({})) || {};
    const agent = settings.permissions?.agent || {};
    const globalMode = normalizeMode(agent.mode);
    if (globalMode !== "ask") return globalMode;
    const exactRule = agent.rules?.[request.grantKey];
    if (exactRule !== undefined) return normalizeMode(exactRule);
    const explicitEffectRule = agent.rules?.[buildEffectGrantKey(request.effect)];
    if (explicitEffectRule !== undefined) return normalizeMode(explicitEffectRule);
    // 兼容旧版的 effect 级 deny，但不复用旧版的宽泛 allow。
    // 需要全局放行时由用户在设置中明确切换 agent.mode=allow。
    return normalizeMode(agent.rules?.[request.effect]) === "deny" ? "deny" : "ask";
  }

  allow(request, source) {
    this.audit(request, { allow: true, source });
    return { allow: true, source };
  }

  deny(request, source, error) {
    this.audit(request, { allow: false, source, error });
    return {
      allow: false,
      decision: "deny",
      code: source === "settings" ? "TOOL_PERMISSION_DENIED" : "TOOL_APPROVAL_REQUIRED",
      error
    };
  }

  audit(request, result) {
    if (!this.auditFile) return;
    appendJsonl(this.auditFile, {
      createdAt: this.clock().toISOString(),
      effect: request.effect,
      toolName: request.toolName,
      resourceKind: request.resourceKind,
      resourceDigest: request.resourceDigest,
      projectId: request.projectId,
      taskId: request.taskId,
      turnId: request.turnId,
      allow: result.allow === true,
      source: result.source,
      errorCode: result.allow === true ? "" : `${result.source || "denied"}`
    }).catch(() => null);
  }
}

function requestApprovalWithAbort(requestApproval, request, signal) {
  if (!signal) return requestApproval(request, { signal: null });
  if (signal.aborted) return Promise.reject(signal.reason || new Error("任务已停止。"));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason || new Error("任务已停止。"));
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(requestApproval(request, { signal })).then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}

function describeToolPermissions({ name = "", args = {}, policy = {}, context = {} } = {}) {
  const effects = normalizeEffects(policy);
  return effects
    .filter((effect) => !SAFE_EFFECTS.has(effect))
    .map((effect) => describeEffectPermission({ name, args, effect, context }));
}

function describeToolPermission(input = {}) {
  return describeToolPermissions(input)[0] || null;
}

function describeEffectPermission({ name, args, effect, context }) {
  const presentation = EFFECT_PRESENTATION[effect] || {
    label: `执行 ${effect}`,
    boundary: "精确授权只取消当前输入的确认；“该类型全部允许”会放行此类操作。参数校验、作用域限制和宿主安全边界始终生效。"
  };
  const resource = describePermissionResource(name, args, effect, context);
  return {
    effect,
    toolName: `${name}`,
    resourceKind: resource.kind,
    resourceDigest: resource.digest,
    grantKey: buildGrantKey(effect, resource.digest),
    projectId: `${context.projectId || ""}`,
    taskId: `${context.taskId || ""}`,
    turnId: `${context.turnId || ""}`,
    title: "允许 Agent 执行这项操作？",
    summary: resource.summary || `工具 ${name || "unknown"} 请求${presentation.label}。`,
    target: resource.target,
    boundary: presentation.boundary,
    allowedDecisions: ["deny", "allow_once", "allow_session", "allow_always", "allow_effect"]
  };
}

function normalizeEffects(policy = {}) {
  const values = Array.isArray(policy.effects) && policy.effects.length
    ? policy.effects
    : [policy.effect];
  return [...new Set(values.map(normalizeEffect))];
}

function normalizeEffect(value) {
  const effect = `${value || ""}`.trim().toLowerCase();
  return /^[a-z][a-z0-9_]{0,63}$/.test(effect) ? effect : "uncatalogued";
}

function normalizeMode(value, fallback = "ask") {
  const mode = `${value || ""}`.trim().toLowerCase();
  return ["ask", "allow", "deny"].includes(mode) ? mode : fallback;
}

function describePermissionResource(name, args, effect, context) {
  const normalizedName = `${name || "unknown"}`;
  if (effect === "command_execute") {
    const command = normalizedCommand(args?.command);
    const cwd = `${context?.agentWorkDir || context?.workspacePath || context?.taskDir || process.cwd()}`;
    return permissionResource("command", `${path.resolve(cwd)}\n${command}`, command);
  }
  if (effect === "external_open") {
    const url = externalOpenUrl(args?.command) || canonicalUrl(args?.url);
    return permissionResource("url", url, displayUrl(url));
  }
  if (effect === "local_open") {
    const cwd = permissionWorkDir(context);
    const target = path.resolve(cwd, `${args?.path || ""}`.trim() || ".");
    return permissionResource(
      "path",
      `local_open\n${target}`,
      target,
      "工具 open_local_path 请求使用系统应用打开本地文件或文件夹。"
    );
  }
  if (effect === "workspace_write") {
    return describeWorkspaceWriteResource(normalizedName, args, context);
  }
  if (effect === "network_read") {
    const url = canonicalUrl(args?.url);
    if (url) return permissionResource("url", url, displayUrl(url));
  }
  if (effect === "memory_write") {
    const type = `${args?.type || ""}`.trim();
    const basis = `${args?.basis || ""}`.trim();
    const topic = `${args?.topic || ""}`.trim();
    const name = `${args?.name || ""}`.trim();
    const content = `${args?.content || ""}`.trim();
    const description = `${args?.description || ""}`.trim();
    const rationale = `${args?.valueBeyondCode || ""}`.trim();
    const polarity = `${args?.polarity || ""}`.trim();
    const reference = `${args?.reference || ""}`.trim();
    const target = [
      `类型：${type || "(未声明)"}`,
      basis ? `来源依据：${basis}` : "",
      `主题：${topic || "(未声明)"}`,
      name ? `名称：${name}` : "",
      description ? `摘要：${description}` : "",
      polarity ? `反馈方向：${polarity}` : "",
      reference ? `外部指针：${reference}` : "",
      rationale ? `跨会话价值：${rationale}` : "",
      `内容：${content || "(空内容)"}`
    ].filter(Boolean).join("\n");
    return permissionResource(
      "long_term_memory",
      `${normalizedName}\n${stableSerialize(args)}`,
      target,
      "Agent 请求保存一条长期记忆。"
    );
  }
  // grantKey 必须覆盖完整参数。界面仍只展示脱敏摘要；完整 content/html
  // 只进入单向摘要，避免两个不同交付内容错误复用同一“精确授权”。
  const exact = `${normalizedName}\n${stableSerialize(args)}`;
  return permissionResource("tool_input", exact, summarizeArguments(args));
}

function describeWorkspaceWriteResource(name, args, context) {
  const cwd = permissionWorkDir(context);
  if (name === "publish_artifact") return describeArtifactPublish(args, context, cwd);
  if (name === "generate_visual") return describeVisualGeneration(args, cwd);
  if (name === "generate_document") return describeDocumentGeneration(args, context, cwd);

  const rawPath = `${args?.path || args?.target || ""}`.trim();
  if (rawPath) {
    const absolute = path.resolve(cwd, rawPath);
    const family = ["write", "edit"].includes(name)
      ? "filesystem_content_mutation"
      : `tool:${name}`;
    const exactArgs = ["write", "edit"].includes(name)
      ? ""
      : `\n${stableSerialize(args)}`;
    return permissionResource("path", `${family}\n${absolute}${exactArgs}`, absolute);
  }

  const exact = `tool:${name}\n${stableSerialize(args)}`;
  return permissionResource("tool_input", exact, summarizeArguments(args));
}

function describeArtifactPublish(args, context, cwd) {
  const source = path.resolve(cwd, `${args?.path || ""}`.trim() || ".");
  const taskDir = `${context?.taskDir || ""}`.trim();
  const finalDir = taskDir ? path.resolve(taskDir, "final") : "(当前任务受管 final 目录不可用)";
  const destination = taskDir ? path.join(finalDir, path.basename(source)) : finalDir;
  const requested = `${args?.destination || ""}`.trim();
  const explicitTargets = Array.isArray(context?.explicitOutputTargets)
    ? context.explicitOutputTargets
    : [];
  const automatic = !requested && explicitTargets.length === 1 ? explicitTargets[0] : null;
  const external = requested
    ? path.resolve(requested)
    : (automatic?.kind === "file"
      ? path.resolve(automatic.path)
      : (automatic?.path ? path.join(path.resolve(automatic.path), path.basename(source)) : ""));
  const target = [
    `已检查来源：${source}`,
    `→ 受管最终成品：${destination}（同名时创建新版本）`,
    external ? `→ 用户指定位置：${external}（同名时创建新版本）` : ""
  ].filter(Boolean).join("\n");
  const exact = [
    "artifact_publish",
    source,
    finalDir,
    external,
    `${args?.title || ""}`.trim()
  ].join("\n");
  return permissionResource(
    "artifact_publish",
    exact,
    target,
    external
      ? "工具 publish_artifact 请求保留受管成品，并复制到用户明确指定的位置。"
      : "工具 publish_artifact 请求把已检查候选发布到当前任务的受管成品区。"
  );
}

function describeVisualGeneration(args, cwd) {
  const source = path.resolve(cwd, `${args?.path || ""}`.trim() || ".");
  const title = `${args?.title || ""}`.trim()
    || path.basename(source, path.extname(source))
    || "visual";
  const rows = [
    `来源 HTML：${source}`,
    `→ 视觉候选：${source}（验收时可能写回已本地化的远程图片）`
  ];
  if (args?.exportPdf === true) {
    rows.push(`→ PDF 候选：${versionedOutputLabel(path.dirname(source), title, "pdf")}`);
  }
  const exact = [
    "visual_generation",
    source,
    stableSerialize({ ...args, path: source })
  ].join("\n");
  return permissionResource(
    "visual_generation",
    exact,
    rows.join("\n"),
    "工具 generate_visual 请求验收 HTML，并在所示资源范围内生成视觉候选。"
  );
}

function describeDocumentGeneration(args, context, cwd) {
  const sourceType = `${args?.source || ""}`.trim();
  const format = `${args?.format || "文件"}`.trim().toLowerCase() || "文件";
  const sourcePath = sourceType === "workspace_file" && `${args?.path || ""}`.trim()
    ? path.resolve(cwd, `${args.path}`)
    : "";
  const source = {
    prepared_content: "Agent 已准备正文（正文不在授权卡片显示）",
    workspace_file: sourcePath || "未指定工作区来源文件",
    latest_artifact: "当前任务最新已发布成品",
    task_history: "当前任务工作记录"
  }[sourceType] || "未指定来源";
  const outputDir = `${context?.agentWorkDir || context?.workspacePath || ""}`.trim()
    ? path.resolve(`${context.agentWorkDir || context.workspacePath}`)
    : path.resolve(cwd);
  const output = `${args?.title || ""}`.trim()
    ? versionedOutputLabel(outputDir, `${args.title}`, format)
    : path.join(outputDir, `<由来源标题生成>[-vN].${format}`);
  const fallback = format === "pdf" ? "；必要时还会在同目录生成安全降级的 DOCX" : "";
  const normalizedArgs = sourcePath ? { ...args, path: sourcePath } : args;
  const exact = [
    "document_generation",
    outputDir,
    stableSerialize(normalizedArgs)
  ].join("\n");
  return permissionResource(
    "document_generation",
    exact,
    `来源：${source}\n→ ${format.toUpperCase()} 候选：${output}${fallback}`,
    `工具 generate_document 请求从所示来源生成 ${format.toUpperCase()} 候选文件。`
  );
}

function permissionWorkDir(context) {
  return `${context?.agentWorkDir || context?.workspacePath || context?.taskDir || process.cwd()}`;
}

function versionedOutputLabel(dir, title, extension) {
  const base = `${title || ""}`
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "document";
  return `${path.join(dir, `${base}.${extension}`)}（同名时创建 -vN 版本）`;
}

function permissionResource(kind, exact, target, summary = "") {
  const source = `${exact || ""}`;
  return {
    kind,
    digest: digest(source),
    target: clipTarget(target || "(未指定资源)"),
    summary: `${summary || ""}`
  };
}

function normalizedCommand(value) {
  return `${value || ""}`.replace(/\r\n?/g, "\n").trim();
}

function canonicalUrl(value) {
  const raw = `${value || ""}`.trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return raw;
    url.hash = "";
    return url.toString();
  } catch {
    return raw;
  }
}

function externalOpenUrl(command) {
  const source = normalizedCommand(command);
  const match = source.match(/^(?:open|\/usr\/bin\/open)\s+(?:"([^"]+)"|'([^']+)'|(\S+))$/);
  return canonicalUrl(match?.[1] || match?.[2] || match?.[3] || "");
}

function displayUrl(value) {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.hash = "";
    return url.toString();
  } catch {
    return `${value || ""}`;
  }
}

function summarizeArguments(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return clipTarget(`${args || ""}`);
  if (typeof args.command === "string") return clipTarget(normalizedCommand(args.command));
  if (typeof args.path === "string") return clipTarget(args.path);
  if (typeof args.url === "string") return clipTarget(displayUrl(canonicalUrl(args.url)));
  const visible = preferredScalar(args);
  return clipTarget(JSON.stringify(visible));
}

function preferredScalar(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return args;
  return Object.fromEntries(
    Object.entries(args)
      .filter(([key, value]) => !/(?:password|secret|token|api.?key|credential|authorization|content|text|html)/i.test(key)
        && ["string", "number", "boolean"].includes(typeof value))
      .slice(0, 8)
  );
}

function clipTarget(value) {
  const source = `${value || ""}`;
  return source.length <= MAX_PERMISSION_TARGET_CHARS
    ? source
    : `${source.slice(0, MAX_PERMISSION_TARGET_CHARS - 20)}\n…[超出命令上限]`;
}

function stableSerialize(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(",")}}`;
}

function digest(value) {
  return crypto.createHash("sha256").update(`${value || ""}`, "utf8").digest("hex");
}

function buildGrantKey(effect, resourceDigest) {
  const prefix = `${effect || "uncatalogued"}`.slice(0, 23);
  return `grant_${prefix}_${`${resourceDigest || ""}`.slice(0, 32)}`;
}

function buildEffectGrantKey(effect) {
  const normalized = normalizeEffect(effect);
  const readable = `effect_${normalized}`;
  if (readable.length <= 64) return readable;
  return `effect_${normalized.slice(0, 40)}_${digest(normalized).slice(0, 12)}`;
}

function permissionSessionKey(request) {
  const scope = request.taskId || request.turnId || "application";
  return `${request.projectId}::${scope}::${request.grantKey}`;
}

function permissionEffectQueueKey(request) {
  return `${request.projectId || "application"}::${request.taskId || "task"}::${request.effect}`;
}

module.exports = {
  APPROVAL_DECISIONS,
  SAFE_EFFECTS,
  MAX_PERMISSION_TARGET_CHARS,
  ToolPermissionService,
  buildEffectGrantKey,
  describeToolPermission,
  describeToolPermissions,
  permissionSessionKey,
  summarizeArguments
};
