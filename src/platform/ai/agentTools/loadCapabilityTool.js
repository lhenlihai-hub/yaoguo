// @ts-check

const { searchCapabilityCatalog } = require("../../capabilities/capabilityCatalog");

const LOAD_CAPABILITY_TOOL_SCHEMA = {
  type: "function",
  function: {
    name: "load_capability",
    description: "当前工具不足时分两步加载能力：先只传 query 获取候选，再携带候选的精确 capabilityId 装载一项。已有工具足够时不调用；不会自动选择或批量开放能力。",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          minLength: 2,
          maxLength: 500,
          description: "要完成的具体动作，例如「评估这份交付物的质量」「委派子 Agent 查三个来源」。"
        },
        capabilityId: {
          type: "string",
          maxLength: 160,
          description: "第二步填写候选返回的精确 id 或工具名。省略时只发现候选，不授予工具或 Skill action。"
        }
      },
      required: ["query"]
    }
  }
};

async function executeLoadCapability(args = {}, ctx = {}) {
  const query = `${args.query || ""}`.trim();
  if (!query) return { ok: false, code: "QUERY_REQUIRED", error: "query 不能为空" };
  const catalog = Array.isArray(ctx.loadableCatalog) ? ctx.loadableCatalog : [];
  if (!catalog.length) {
    return { ok: false, code: "CATALOG_EMPTY", loaded: [], error: "当前没有可按需装载的额外能力。" };
  }

  const capabilityId = `${args.capabilityId || ""}`.trim();
  if (capabilityId) {
    const selected = catalog.find((entry) => isExactCapability(entry, capabilityId));
    if (!selected) {
      return {
        ok: false,
        code: "CAPABILITY_NOT_FOUND",
        loaded: [],
        error: `候选目录中没有精确能力：${capabilityId}`
      };
    }
    return loadExactCapability(selected);
  }

  const { matches, suggestions } = searchCapabilityCatalog(query, catalog, { limit: 3 });
  const candidates = matches.map(({ entry, score }) => ({
    ...compactCapability(entry),
    score,
    available: entry.available !== false,
    unavailableReason: entry.unavailableReason || ""
  }));
  if (!candidates.length) {
    return {
      ok: false,
      code: "NO_CAPABILITY_MATCH",
      loaded: [],
      error: "没有找到高置信匹配能力；请换成更具体的动作描述，或使用当前工具完成。",
      suggestions: suggestions.map(({ entry }) => compactCapability(entry))
    };
  }
  return {
    ok: true,
    loaded: [],
    requiresSelection: true,
    candidates
  };
}

function loadExactCapability(selected) {
  if (selected.available === false) {
    return {
      ok: false,
      code: "CAPABILITY_UNAVAILABLE",
      loaded: [{
        ...compactCapability(selected),
        available: false,
        unavailableReason: selected.unavailableReason || ""
      }],
      error: selected.unavailableReason || `能力 ${selected.id || selected.name} 当前不可用。`
    };
  }
  const mountTools = unique(
    Array.isArray(selected.mountTools)
      ? selected.mountTools
      : ((!selected.kind || selected.kind === "tool") && selected.name ? [selected.name] : [])
  );
  const skillActions = selected.kind === "skill-action" && selected.skillId && selected.action
    ? [selected]
    : [];
  const activeSkillActions = unique(skillActions.map((entry) => `${entry.skillId}#${entry.action}`));
  const skillActionPolicies = Object.fromEntries(skillActions.map((entry) => [
    `${entry.skillId}#${entry.action}`,
    {
      effect: entry.effect || "workspace_write",
      idempotent: entry.idempotent === true,
      requiresUserConfirm: entry.requiresUserConfirm === true
    }
  ]));
  return {
    ok: true,
    loaded: [{
      ...compactCapability(selected),
      available: true,
      actions: Array.isArray(selected.actions) ? selected.actions : [],
      instructions: selected.instructions || ""
    }],
    ...(mountTools.length ? { __mountTools: mountTools } : {}),
    ...(activeSkillActions.length ? {
      __activateSkillActions: activeSkillActions,
      __skillActionPolicies: skillActionPolicies
    } : {})
  };
}

function isExactCapability(entry, capabilityId) {
  return [
    entry.id,
    entry.name,
    entry.name ? `tool://${entry.name}` : ""
  ].filter(Boolean).includes(capabilityId);
}

function compactCapability(entry = {}) {
  return {
    id: entry.id || (entry.name ? `tool://${entry.name}` : ""),
    kind: entry.kind || "tool",
    name: entry.name || "",
    title: entry.title || entry.name || entry.id || "",
    description: entry.description || "",
    namespace: entry.namespace || "",
    ...(entry.skillId ? { skillId: entry.skillId } : {}),
    ...(entry.action ? { action: entry.action } : {})
  };
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

const loadCapabilityTool = {
  schema: LOAD_CAPABILITY_TOOL_SCHEMA,
  execute: executeLoadCapability
};

module.exports = {
  loadCapabilityTool,
  LOAD_CAPABILITY_TOOL_SCHEMA,
  executeLoadCapability
};
