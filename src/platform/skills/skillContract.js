// @ts-check

const path = require("node:path");
const { isPathInside } = require("../shared/pathSafety");

const VALID_RUNTIMES = new Set(["node", "python"]);
const VALID_EFFECTS = new Set(["none", "workspace_write", "network", "external"]);
const VALID_EXPOSURE_MODES = new Set(["orchestrated", "agent-direct", "internal"]);
const VALID_TRUST = new Set(["bundled", "local-reviewed"]);
// Agent-direct 需要不可由 workspace manifest 自我声明的代码级信任根。
// 当前没有经过签名/不可变包校验的直连 Skill，因此保持空集；文档类 Skill 走
// generate_document 宿主编排。未来新增时必须伴随安装来源与 sandbox 设计一起评审。
const TRUSTED_AGENT_DIRECT_SKILL_IDS = new Set();

function validateSkillManifest(manifest = {}, skillDir = "") {
  const errors = [];
  if (manifest.kind !== "skill") errors.push("kind 必须是 skill");
  if (!/^skill:\/\/[a-z0-9][a-z0-9-]*@\d+$/.test(`${manifest.id || ""}`)) errors.push("id 必须符合 skill://name@version");
  if (!Number.isInteger(manifest.version) || manifest.version < 1) errors.push("version 必须是正整数");
  if (manifest.instructionsRef !== "SKILL.md") errors.push("instructionsRef 必须指向 SKILL.md");
  if (!VALID_TRUST.has(manifest.trust)) errors.push("trust 必须是 bundled 或 local-reviewed");
  const entry = manifest.entry && typeof manifest.entry === "object" ? manifest.entry : {};
  if (!Object.keys(entry).length) errors.push("entry 至少声明一个 action");
  if (Object.keys(entry).length > 16) errors.push("entry 最多声明 16 个 action；请拆分 Skill 以保持渐进披露");
  for (const [action, definition] of Object.entries(entry)) {
    validateAction(action, definition, skillDir, errors);
  }
  const exposureMode = manifest.exposure?.mode || "internal";
  if (!VALID_EXPOSURE_MODES.has(exposureMode)) errors.push(`exposure.mode 不支持：${exposureMode}`);
  if (exposureMode === "orchestrated" && !`${manifest.exposure?.tool || ""}`.trim()) {
    errors.push("orchestrated Skill 必须声明 exposure.tool");
  }
  if (exposureMode === "agent-direct" && manifest.trust !== "bundled") {
    errors.push("当前运行时只允许 bundled Skill 直连 Agent");
  }
  if (exposureMode === "agent-direct" && !TRUSTED_AGENT_DIRECT_SKILL_IDS.has(manifest.id)) {
    errors.push("agent-direct Skill 尚未进入代码级信任根；不能由 workspace manifest 自我授权");
  }
  return { ok: errors.length === 0, errors };
}

function validateAction(action, definition, skillDir, errors) {
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(action)) errors.push(`action 名称不合法：${action}`);
  if (!definition || typeof definition !== "object") {
    errors.push(`action ${action} 定义无效`);
    return;
  }
  if (!VALID_RUNTIMES.has(definition.runtime)) errors.push(`action ${action} runtime 不支持：${definition.runtime}`);
  const script = `${definition.script || ""}`;
  if (!script || path.isAbsolute(script) || script.split(/[\\/]/).includes("..")) errors.push(`action ${action} script 必须是 Skill 内相对路径`);
  if (skillDir && script && !isPathInside(skillDir, path.resolve(skillDir, script))) errors.push(`action ${action} script 越出 Skill 目录`);
  if (!VALID_EFFECTS.has(definition.sideEffects)) errors.push(`action ${action} 必须声明合法 sideEffects`);
  if (typeof definition.idempotent !== "boolean") errors.push(`action ${action} 必须声明 idempotent`);
  if (definition.requiresUserConfirm !== undefined && typeof definition.requiresUserConfirm !== "boolean") {
    errors.push(`action ${action} requiresUserConfirm 必须是 boolean`);
  }
  if (["network", "external"].includes(definition.sideEffects) && definition.requiresUserConfirm !== true) {
    errors.push(`action ${action} 具有 ${definition.sideEffects} 副作用时必须 requiresUserConfirm=true`);
  }
  if (!definition.inputSchema || definition.inputSchema.type !== "object") errors.push(`action ${action} 必须声明 object inputSchema`);
  if (definition.inputSchema?.additionalProperties !== false) errors.push(`action ${action} inputSchema 必须 additionalProperties=false`);
  validatePathParams(action, definition, errors);
}

function validatePathParams(action, definition, errors) {
  const pathParams = definition.pathParams;
  if (!pathParams || typeof pathParams !== "object" || Array.isArray(pathParams)) {
    errors.push(`action ${action} 必须声明 pathParams.read 与 pathParams.write`);
    return;
  }
  const extraKeys = Object.keys(pathParams).filter((key) => !["read", "write"].includes(key));
  if (extraKeys.length) errors.push(`action ${action} pathParams 含未知字段：${extraKeys.join(", ")}`);
  for (const role of ["read", "write"]) {
    const paths = pathParams[role];
    if (!Array.isArray(paths)) {
      errors.push(`action ${action} pathParams.${role} 必须是参数路径数组`);
      continue;
    }
    if (paths.length > 32) errors.push(`action ${action} pathParams.${role} 最多声明 32 个参数路径`);
    const seen = new Set();
    for (const parameterPath of paths) {
      if (typeof parameterPath !== "string" || !isValidParameterPath(parameterPath)) {
        errors.push(`action ${action} pathParams.${role} 含非法参数路径：${parameterPath}`);
        continue;
      }
      if (seen.has(parameterPath)) {
        errors.push(`action ${action} pathParams.${role} 重复声明：${parameterPath}`);
        continue;
      }
      seen.add(parameterPath);
      const schema = schemaAtParameterPath(definition.inputSchema, parameterPath);
      if (!schema) {
        errors.push(`action ${action} pathParams.${role} 未指向 inputSchema 字段：${parameterPath}`);
      } else if (schema.type !== "string") {
        errors.push(`action ${action} pathParams.${role} 必须指向 string schema：${parameterPath}`);
      }
    }
  }
  const writePaths = Array.isArray(pathParams.write) ? pathParams.write : [];
  if (definition.sideEffects === "workspace_write" && writePaths.length === 0) {
    errors.push(`action ${action} sideEffects=workspace_write 时 pathParams.write 不能为空`);
  }
  if (definition.sideEffects === "none" && writePaths.length > 0) {
    errors.push(`action ${action} 声明写路径时 sideEffects 必须是 workspace_write`);
  }
}

function isValidParameterPath(parameterPath = "") {
  return /^[a-zA-Z_][a-zA-Z0-9_-]*(?:\.[a-zA-Z_][a-zA-Z0-9_-]*)*$/.test(parameterPath)
    && !parameterPath.split(".").some((segment) => ["__proto__", "prototype", "constructor"].includes(segment));
}

/**
 * @param {Record<string, any>} inputSchema
 * @param {string} parameterPath
 * @returns {Record<string, any> | null}
 */
function schemaAtParameterPath(inputSchema = {}, parameterPath = "") {
  let current = inputSchema;
  for (const segment of parameterPath.split(".")) {
    if (!current || current.type !== "object" || !current.properties || typeof current.properties !== "object") return null;
    if (!Object.prototype.hasOwnProperty.call(current.properties, segment)) return null;
    current = current.properties[segment];
  }
  return current && typeof current === "object" ? current : null;
}

module.exports = {
  validateSkillManifest,
  schemaAtParameterPath,
  isPathInside,
  TRUSTED_AGENT_DIRECT_SKILL_IDS
};
