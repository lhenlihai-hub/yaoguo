// @ts-check

// 通用 Skill 执行桥。它永不常驻；只有 load_capability 命中一个声明为 agent-direct
// 的 Skill action 后才会被挂载，且只能执行本轮精确授权的 action。

const RUN_SKILL_TOOL_SCHEMA = {
  type: "function",
  function: {
    name: "run_skill",
    description: "执行刚由 load_capability 激活的 Skill action。严格照装载结果里的 action 契约传参；不能执行未激活或不可直连的 Skill。",
    parameters: {
      type: "object",
      properties: {
        skillId: { type: "string", minLength: 1, maxLength: 160, description: "load_capability 返回的 skill id。" },
        action: { type: "string", minLength: 1, maxLength: 64, description: "该 Skill 声明的 action。" },
        params: { type: "object", description: "action 参数；字段以装载时返回的契约为准。", additionalProperties: true }
      },
      required: ["skillId", "action", "params"]
    }
  }
};

async function executeRunSkill(args = {}, ctx = {}) {
  const skillId = `${args.skillId || ""}`.trim();
  const action = `${args.action || ""}`.trim();
  const grant = `${skillId}#${action}`;
  const active = ctx.activeSkillActions instanceof Set ? ctx.activeSkillActions : new Set();
  if (!active.has(grant)) {
    return { ok: false, code: "SKILL_ACTION_NOT_ACTIVE", error: "该 Skill action 尚未授权；先用 load_capability 精确装载。" };
  }
  if (!ctx.skillsService || typeof ctx.skillsService.invoke !== "function") {
    return { ok: false, code: "SKILLS_UNAVAILABLE", error: "Skill 运行时不可用。" };
  }
  const scopeAllow = Array.isArray(ctx.skillScopeAllow) ? ctx.skillScopeAllow.filter(Boolean) : [];
  return ctx.skillsService.invoke(skillId, action, args.params || {}, {
    workDir: ctx.skillWorkDir || scopeAllow[0] || undefined,
    scopeAllow,
    readScopeAllow: Array.isArray(ctx.skillReadScopeAllow) ? ctx.skillReadScopeAllow : undefined,
    writeScopeAllow: Array.isArray(ctx.skillWriteScopeAllow) ? ctx.skillWriteScopeAllow : undefined,
    approvedSkillActions: ctx.approvedSkillActions,
    timeoutMs: ctx.skillTimeoutMs,
    signal: ctx.signal || null,
    agentInvocation: true
  });
}

const runSkillTool = {
  schema: RUN_SKILL_TOOL_SCHEMA,
  execute: executeRunSkill
};

module.exports = {
  runSkillTool,
  RUN_SKILL_TOOL_SCHEMA,
  executeRunSkill
};
