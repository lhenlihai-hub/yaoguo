// @ts-check

const path = require("node:path");
const fsp = require("node:fs/promises");
const { validateJsonSchema } = require("../shared/jsonSchemaValidation");
const { isPathInside } = require("./skillContract");
const { findInternalProtocolLeak } = require("./internalProtocolGuard");

// SkillsService 是 skill 子系统对外的唯一门面：
//   - invoke(skillId, action, params, ctx): 跑一个 skill 的具体动作
//   - list(): 列出所有 skill 摘要
//   - dependencies(skillId): 查 skill 依赖状态
//
// 业务规则集中在这里：依赖判断、作用域注入、错误码归一化。

class SkillsService {
  constructor({ skillsRegistry = null, skillRunner = null, dependencyResolver = null } = {}) {
    if (!skillsRegistry) throw new Error("SkillsService 需要 skillsRegistry。");
    if (!skillRunner) throw new Error("SkillsService 需要 skillRunner。");
    if (!dependencyResolver) throw new Error("SkillsService 需要 dependencyResolver。");
    this.registry = skillsRegistry;
    this.runner = skillRunner;
    this.deps = dependencyResolver;
  }

  async list() {
    const skills = await this.registry.list();
    return skills.map((s) => ({
      id: s.id, version: s.version, title: s.title, description: s.description,
      format: s.format, actions: s.actions, valid: s.valid,
      issues: s.issues, exposure: s.manifest.exposure || { mode: "internal" }
    }));
  }

  async describe(skillId, { includeInstructions = false } = {}) {
    const skill = await this.registry.getById(skillId);
    if (!skill) return null;
    return {
      id: skill.id,
      version: skill.version,
      name: skill.name,
      title: skill.title,
      description: skill.description,
      format: skill.format,
      valid: skill.valid,
      issues: [...skill.issues],
      exposure: skill.manifest.exposure || { mode: "internal" },
      actions: Object.entries(skill.manifest.entry || {}).map(([name, entry]) => ({
        name,
        description: entry.description || "",
        sideEffects: entry.sideEffects,
        idempotent: entry.idempotent,
        pathParams: entry.pathParams,
        inputSchema: entry.inputSchema
      })),
      ...(includeInstructions ? { instructions: skill.instructionsBody || "" } : {})
    };
  }

  async capabilityCatalog({ directOnly = true } = {}) {
    const skills = await this.registry.list();
    const selected = directOnly
      ? skills.filter((skill) => skill.valid && skill.manifest.exposure?.mode === "agent-direct")
      : skills;
    // Catalog 只描述能力，不在用户命中前 spawn `--version` 探测全部依赖。
    // 依赖按 action 在 invoke 时解析；一个 preview 依赖缺失不应隐藏同 Skill 的 read action。
    return selected.flatMap((skill) => Object.entries(skill.manifest.entry || {}).map(([action, entry]) => ({
      id: `${skill.id}#${action}`,
      kind: "skill-action",
      skillId: skill.id,
      action,
      name: `${skill.name}.${action}`,
      title: `${skill.title} · ${action}`,
      description: entry.description || skill.description,
      namespace: "skills",
      effect: normalizeSkillEffect(entry.sideEffects),
      idempotent: entry.idempotent === true,
      requiresUserConfirm: entry.requiresUserConfirm === true,
      keywords: [
        action,
        entry.description || "",
        ...(skill.manifest.triggers?.intents || []),
        ...(skill.manifest.triggers?.extensions || []),
        ...(skill.manifest.triggers?.outputFormats || [])
      ],
      actions: [{
        name: action,
        description: entry.description || "",
        sideEffects: entry.sideEffects,
        idempotent: entry.idempotent === true,
        requiresUserConfirm: entry.requiresUserConfirm === true,
        pathParams: entry.pathParams,
        inputSchema: entry.inputSchema
      }],
      instructions: skill.instructionsBody || "",
      mountTools: ["run_skill"],
      available: skill.valid,
      unavailableReason: skill.valid ? "" : skill.issues.join("；")
    })));
  }

  async dependencies(skillId) {
    const skill = await this.registry.getById(skillId);
    if (!skill) return { ok: false, error: { code: "SKILL_NOT_FOUND", message: skillId } };
    const deps = skill.manifest.dependencies || [];
    const results = await this.deps.resolveAll(deps);
    return { ok: true, results };
  }

  async invoke(skillId, action, params, ctx = {}) {
    const skill = await this.registry.getById(skillId);
    if (!skill) return this._fail("SKILL_NOT_FOUND", `未找到 skill: ${skillId}`);

    if (!skill.valid) return this._fail("SKILL_INVALID", `skill ${skillId} 契约无效`, { issues: skill.issues });

    const entry = skill.manifest.entry?.[action];
    if (!entry) return this._fail("ACTION_NOT_FOUND", `skill ${skillId} 不支持动作 ${action}`);
    if (ctx.agentInvocation && skill.manifest.exposure?.mode !== "agent-direct") {
      return this._fail("SKILL_NOT_AGENT_CALLABLE", `skill ${skillId} 只能由 ${skill.manifest.exposure?.tool || "宿主"} 编排。`);
    }
    const actionGrant = `${skillId}#${action}`;
    if (entry.requiresUserConfirm === true && !hasActionApproval(ctx.approvedSkillActions, actionGrant)) {
      return this._fail("USER_CONFIRM_REQUIRED", `skill ${skillId}.${action} 需要宿主确认后才能执行。`);
    }
    const inputValidation = validateJsonSchema(params, entry.inputSchema || {});
    if (!inputValidation.ok) {
      return this._fail("INPUT_INVALID", `skill ${skillId}.${action} 参数不符合契约`, { details: inputValidation.errors });
    }
    const scopes = resolveScopes(ctx);
    const pathFields = collectDeclaredPathFields(params, entry.pathParams);
    const needsReadScope = pathFields.some((item) => item.role === "read");
    const needsWriteScope = entry.sideEffects === "workspace_write"
      || pathFields.some((item) => item.role === "write");
    if ((needsReadScope && !scopes.read.length) || (needsWriteScope && !scopes.write.length)) {
      return this._fail("SCOPE_REQUIRED", `skill ${skillId}.${action} 必须由宿主分别授予所需的读/写文件作用域。`);
    }
    const scopeValidation = await validateScopedPaths(pathFields, scopes);
    if (!scopeValidation.ok) {
      return this._fail("SCOPE_VIOLATION", `skill ${skillId}.${action} 文件路径越出宿主作用域`, {
        details: scopeValidation.errors
      });
    }

    const missing = await this._checkRequiredDeps(skill, action);
    if (missing.length > 0) {
      return this._fail("DEP_MISSING",
        `执行 ${action} 缺依赖: ${missing.map((m) => m.dep.id).join(", ")}`,
        { missing });
    }

    const scriptPath = path.resolve(skill.dir, entry.script);
    if (!isPathInside(skill.dir, scriptPath)) {
      return this._fail("SCRIPT_SCOPE_VIOLATION", `skill ${skillId}.${action} 脚本越出技能目录。`);
    }
    const env = this._buildEnv(ctx);

    const runResult = await this.runner.run({
      runtime: entry.runtime,
      scriptPath,
      params,
      env,
      cwd: ctx.workDir || undefined,
      timeoutMs: ctx.timeoutMs || entry.timeoutMs,
      signal: ctx.signal || null
    });

    const normalized = this._normalize(runResult, { skillId, action });
    if (action !== "validate" || normalized?.ok !== true || !params?.inputPath) return normalized;
    try {
      const leak = await findInternalProtocolLeak(params.inputPath, skill.format);
      if (!leak) return normalized;
      return {
        ok: false,
        errors: [{
          code: "INTERNAL_PROTOCOL_LEAK",
          message: `${leak.part} 含内部工具调用协议，不能作为 ${skill.format.toUpperCase()} 内容交付。`
        }],
        warnings: normalized.warnings || []
      };
    } catch (error) {
      return {
        ok: false,
        errors: [{ code: "INTERNAL_PROTOCOL_SCAN_FAILED", message: `内部协议检查失败：${error.message}` }],
        warnings: normalized.warnings || []
      };
    }
  }

  async _checkRequiredDeps(skill, action) {
    const deps = (skill.manifest.dependencies || []).filter((d) =>
      d.required && (!d.for || d.for.length === 0 || d.for.includes(action))
    );
    const resolved = await this.deps.resolveAll(deps);
    return resolved.filter((r) => !r.installed);
  }

  _buildEnv(ctx) {
    const env = {};
    if (ctx.workDir) env.YAOGUO_WORK_DIR = ctx.workDir;
    const scopes = resolveScopes(ctx);
    const roots = [...new Set([...scopes.read, ...scopes.write])];
    if (roots.length) {
      env.YAOGUO_SCOPE_ALLOW = roots.join(":");
    }
    return env;
  }

  _normalize(runResult, { skillId, action }) {
    if (runResult.spawnError) {
      return this._fail("RUNTIME_NOT_FOUND",
        `无法启动子进程：${runResult.stderr || runResult.spawnError.message}`);
    }
    if (runResult.timedOut) {
      return this._fail("TIMEOUT", `skill ${skillId}.${action} 执行超时。`);
    }
    if (runResult.aborted) {
      return this._fail("ABORTED", `skill ${skillId}.${action} 已取消。`);
    }
    if (runResult.outputLimitExceeded) {
      return this._fail("OUTPUT_LIMIT", `skill ${skillId}.${action} 输出超过运行时上限。`);
    }
    if (runResult.inputLimitExceeded) {
      return this._fail("INPUT_LIMIT", `skill ${skillId}.${action} 输入超过运行时上限。`);
    }
    if (runResult.code !== 0) {
      if (runResult.result?.ok === false) return runResult.result;
      return this._fail("PROCESS_FAILED", `skill ${skillId}.${action} 子进程异常退出（exit=${runResult.code}）。`, {
        stderr: truncate(runResult.stderr)
      });
    }
    if (runResult.result && typeof runResult.result === "object") {
      return runResult.result;
    }
    return this._fail("NO_RESULT",
      `子进程未返回合法 JSON（exit=${runResult.code}）。stderr: ${truncate(runResult.stderr)}`);
  }

  _fail(code, message, extra = {}) {
    return { ok: false, error: { code, message, ...extra } };
  }
}

function normalizeSkillEffect(effect = "none") {
  return effect === "none" ? "read" : effect;
}

function resolveScopes(ctx = {}) {
  const legacy = Array.isArray(ctx.scopeAllow) ? ctx.scopeAllow.filter(Boolean) : [];
  return {
    read: Array.isArray(ctx.readScopeAllow) ? ctx.readScopeAllow.filter(Boolean) : legacy,
    write: Array.isArray(ctx.writeScopeAllow) ? ctx.writeScopeAllow.filter(Boolean) : legacy
  };
}

function hasActionApproval(approved, grant) {
  return approved instanceof Set
    ? approved.has(grant)
    : (Array.isArray(approved) && approved.includes(grant));
}

async function resolveRoots(scopeAllow) {
  return Promise.all(scopeAllow.map(async (root) => {
    const lexical = path.resolve(`${root}`);
    const ancestor = await nearestExistingPath(lexical);
    const realAncestor = await fsp.realpath(ancestor).catch(() => ancestor);
    const projectedReal = path.resolve(realAncestor, path.relative(ancestor, lexical));
    return { lexical, real: projectedReal };
  }));
}

async function validateScopedPaths(candidates, scopes) {
  if (!candidates.length) return { ok: true, errors: [] };
  const [readRoots, writeRoots] = await Promise.all([
    resolveRoots(scopes.read),
    resolveRoots(scopes.write)
  ]);
  const errors = [];
  for (const item of candidates) {
    if (!path.isAbsolute(item.value)) {
      errors.push(`${item.key} 必须是绝对路径`);
      continue;
    }
    const lexical = path.resolve(item.value);
    const roots = item.role === "write" ? writeRoots : readRoots;
    const lexicalRoots = roots.filter((root) => isPathInside(root.lexical, lexical));
    if (!lexicalRoots.length) {
      errors.push(`${item.key} 越出 ${item.role === "write" ? "writeScopeAllow" : "readScopeAllow"}`);
      continue;
    }
    const ancestor = await nearestExistingPath(lexical);
    const realAncestor = await fsp.realpath(ancestor).catch(() => ancestor);
    const projectedReal = path.resolve(realAncestor, path.relative(ancestor, lexical));
    if (!lexicalRoots.some((root) => isPathInside(root.real, projectedReal))) {
      errors.push(`${item.key} 经 realpath 解析后越出 scopeAllow`);
    }
  }
  return { ok: errors.length === 0, errors };
}

function collectDeclaredPathFields(params = {}, pathParams = {}) {
  const output = [];
  for (const role of ["read", "write"]) {
    const declared = Array.isArray(pathParams?.[role]) ? pathParams[role] : [];
    for (const parameterPath of declared) {
      const value = valueAtParameterPath(params, parameterPath);
      if (typeof value === "string") output.push({ key: `$.${parameterPath}`, value, role });
    }
  }
  return output;
}

function valueAtParameterPath(params = {}, parameterPath = "") {
  let current = params;
  for (const segment of `${parameterPath || ""}`.split(".")) {
    if (!current || typeof current !== "object" || !Object.prototype.hasOwnProperty.call(current, segment)) return undefined;
    current = current[segment];
  }
  return current;
}

async function nearestExistingPath(candidate) {
  let current = candidate;
  while (true) {
    try { await fsp.access(current); return current; } catch {}
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}

function truncate(s, n = 400) {
  if (!s) return "";
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

module.exports = {
  SkillsService
};
