// @ts-check

const AGENT_MEMORY_SCOPES = Object.freeze(["agent", "project", "local"]);
const AGENT_MEMORY_MODES = Object.freeze(["indexed", "append-only"]);
const DEFAULT_AGENT_TYPE = "default";
const DEFAULT_AGENT_MEMORY_SCOPE = "local";
const DEFAULT_AGENT_MEMORY_MODE = "indexed";

function normalizeAgentMemoryProfile(value = {}) {
  const source = /** @type {any} */ (value && typeof value === "object" ? value : {});
  const agentType = normalizeAgentType(source.agentType || DEFAULT_AGENT_TYPE);
  const scope = `${source.scope || DEFAULT_AGENT_MEMORY_SCOPE}`.trim();
  const mode = `${source.mode || source.storageMode || DEFAULT_AGENT_MEMORY_MODE}`.trim();
  if (!AGENT_MEMORY_SCOPES.includes(scope)) {
    throw profileError("AGENT_MEMORY_SCOPE_INVALID", `Agent 记忆 scope 只允许 ${AGENT_MEMORY_SCOPES.join("/")}`);
  }
  if (!AGENT_MEMORY_MODES.includes(mode)) {
    throw profileError("AGENT_MEMORY_MODE_INVALID", `Agent 记忆 mode 只允许 ${AGENT_MEMORY_MODES.join("/")}`);
  }
  return { agentType, scope, mode };
}

function normalizeAgentType(value = "") {
  const source = `${value || ""}`.trim().toLowerCase();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(source) || source.length > 64) {
    throw profileError(
      "AGENT_MEMORY_TYPE_INVALID",
      "Agent 类型必须是 1-64 字符的小写 ASCII kebab-case"
    );
  }
  return source;
}

function agentMemoryContext(value = {}) {
  const profile = normalizeAgentMemoryProfile(value);
  return {
    agentType: profile.agentType,
    memoryScope: profile.scope,
    memoryMode: profile.mode
  };
}

function profileError(code, message) {
  return Object.assign(new Error(message), { code });
}

module.exports = {
  AGENT_MEMORY_SCOPES,
  AGENT_MEMORY_MODES,
  DEFAULT_AGENT_TYPE,
  DEFAULT_AGENT_MEMORY_SCOPE,
  DEFAULT_AGENT_MEMORY_MODE,
  normalizeAgentMemoryProfile,
  normalizeAgentType,
  agentMemoryContext
};
