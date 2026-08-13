// @ts-check

const SYSTEM_PROMPT_DYNAMIC_BOUNDARY = "__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__";
const fallbackSystemPromptSectionCaches = new WeakMap();

const STATIC_SECTION_IDS = Object.freeze([
  "introduction",
  "system",
  "tasks",
  "actions",
  "tools",
  "tone-and-style",
  "output-efficiency"
]);

const DYNAMIC_SECTION_IDS = Object.freeze([
  "memory.cache",
  "memory.behavior",
  "memory-guidance",
  "context-guidance",
  "tool-guidance"
]);

const DYNAMIC_SECTION_DEFINITIONS = Object.freeze([
  Object.freeze({
    name: "memory-guidance",
    cacheKey: (options = {}) => memoryGuidanceCacheKey(options.memoryContext),
    compute: (source, options = {}) => buildMemoryGuidanceSection(source, options.memoryContext)
  }),
  Object.freeze({
    name: "context-guidance",
    cacheKey: (options = {}) => contextGuidanceCacheKey(options.contextManagement),
    compute: (source, options = {}) => buildContextGuidanceSection(source, options.contextManagement)
  }),
  Object.freeze({
    name: "tool-guidance",
    cacheKey: (options = {}) => normalizeToolNames(options.tools).join(","),
    compute: (source, options = {}) => buildToolGuidanceSection(source, options.tools)
  })
]);

/**
 * 装配面向用户的 System Prompt。返回独立 section；boundary 只供宿主识别
 * 静态缓存前缀与缓存作用域，不属于发给模型的文本。
 *
 * @param {any} source
 * @param {any} [options]
 * @returns {Promise<string[]>}
 */
async function getSystemPrompt(source, options = {}) {
  assertPromptSource(source);
  const cacheScope = `${options.cacheScope || ""}`;
  const requiredAssets = await Promise.allSettled([
    source.loadSystemPromptBlock("block://soul.zh", { required: true }),
    source.loadSystemPromptAsset("block://system.agent", { required: true }),
    source.loadSystemPromptBlock("block://aesthetic.baseline.zh", { required: true })
  ]);
  const firstFailure = requiredAssets.find((result) => result.status === "rejected");
  if (firstFailure?.status === "rejected") throw firstFailure.reason;
  const [soul, systemAsset, aesthetic] = requiredAssets.map((result) => (
    result.status === "fulfilled" ? result.value : ""
  ));
  const staticSections = STATIC_SECTION_IDS.map((sectionId) => (
    requiredAssetSection(systemAsset, sectionId)
  ));
  const [memoryCache, memoryBehavior] = await Promise.all([
    source.loadSystemPromptSection(
      "block://system.agent",
      "memory.cache",
      { required: true, cacheScope }
    ),
    source.loadSystemPromptSection(
      "block://system.agent",
      "memory.behavior",
      { required: true, cacheScope }
    )
  ]);
  const dynamicSections = await Promise.all(
    DYNAMIC_SECTION_DEFINITIONS.map((definition) => (
      memoizedSystemPromptSection(source, cacheScope, definition, options)
    ))
  );
  return [
    soul,
    ...staticSections,
    aesthetic,
    SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
    memoryCache,
    memoryBehavior,
    ...dynamicSections.filter(Boolean)
  ];
}

async function memoizedSystemPromptSection(source, cacheScope, definition, options) {
  const dependencyKey = `${definition.cacheKey(options)}`;
  const sectionKey = `dynamic:${definition.name}:${dependencyKey}`;
  const cached = getSystemPromptSectionCache(source, cacheScope, sectionKey);
  if (cached !== undefined) return cached;
  const pending = Promise.resolve(definition.compute(source, options));
  setSystemPromptSectionCache(source, cacheScope, sectionKey, pending);
  try {
    const content = `${await pending || ""}`.trim();
    setSystemPromptSectionCache(source, cacheScope, sectionKey, content);
    return content;
  } catch (error) {
    const cache = resolveSystemPromptSectionCache(source, cacheScope);
    if (cache.get(sectionKey) === pending) cache.delete(sectionKey);
    throw error;
  }
}

function getSystemPromptSectionCache(source, cacheScope = "", sectionKey = "") {
  return resolveSystemPromptSectionCache(source, cacheScope).get(`${sectionKey}`);
}

/** @param {any} source @param {string} cacheScope @param {string} sectionKey @param {any} value */
function setSystemPromptSectionCache(source, cacheScope = "", sectionKey = "", value = "") {
  resolveSystemPromptSectionCache(source, cacheScope).set(`${sectionKey}`, value);
  return value;
}

function resolveSystemPromptSectionCache(source, cacheScope = "") {
  if (typeof source?.systemPromptSectionCache === "function") {
    return source.systemPromptSectionCache(`${cacheScope || ""}`);
  }
  let scopes = fallbackSystemPromptSectionCaches.get(source);
  if (!scopes) {
    scopes = new Map();
    fallbackSystemPromptSectionCaches.set(source, scopes);
  }
  const scope = `${cacheScope || ""}`;
  if (!scopes.has(scope)) scopes.set(scope, new Map());
  return scopes.get(scope);
}

async function buildToolGuidanceSection(source, tools = []) {
  const toolNames = new Set(normalizeToolNames(tools));
  const sectionIds = [];
  if (toolNames.has("read")) sectionIds.push("file-read");
  if (toolNames.has("edit")) sectionIds.push("file-edit");
  if (toolNames.has("write")) sectionIds.push("file-write");
  if (toolNames.has("bash")) sectionIds.push("bash-routing");
  if (toolNames.has("search_run_artifacts")) sectionIds.push("search-artifacts");
  if (toolNames.has("read_artifact")) sectionIds.push("read-artifact");
  if (toolNames.has("search_memory")) sectionIds.push("search-memory");
  if (toolNames.has("pin_memory")) sectionIds.push("pin-memory");
  if (toolNames.has("search_reference")) sectionIds.push("search-reference");
  if (toolNames.has("fetch_url")) sectionIds.push("fetch-url");
  if (toolNames.has("read_reference")) sectionIds.push("read-reference");
  if (toolNames.has("write_todo")) sectionIds.push("todo-write");
  if (toolNames.has("list_todos")) sectionIds.push("todo-list");
  if (toolNames.has("spawn_subagent")) sectionIds.push("subagent");
  if (toolNames.has("load_capability")) sectionIds.push("capability-loader");
  if (toolNames.size > 1) sectionIds.push("parallel-calls");
  if (!sectionIds.length) return "";
  const asset = await source.loadSystemPromptAsset("block://tool.guidance", { required: true });
  return [
    "<dynamic_tool_guidance>",
    ...sectionIds.map((sectionId) => requiredAssetSection(
      asset,
      sectionId,
      "block://tool.guidance"
    )),
    "</dynamic_tool_guidance>"
  ].join("\n");
}

async function buildMemoryGuidanceSection(source, memoryContext = null) {
  const context = normalizeMemoryContext(memoryContext);
  if (!context.enabled) return "";
  const sectionIds = ["auto-memory"];
  if (context.storageMode === "append-only") sectionIds.push("daily-log");
  if (context.scope === "project") sectionIds.push("project-shared");
  if (context.autoDream) sectionIds.push("autodream");
  if (context.sessionMemory || context.transcript || context.contextResults) {
    sectionIds.push("session-continuity");
  }
  const asset = await source.loadSystemPromptAsset("block://memory.guidance", { required: true });
  return [
    "<dynamic_memory_guidance>",
    ...sectionIds.map((sectionId) => requiredAssetSection(
      asset,
      sectionId,
      "block://memory.guidance"
    )),
    "</dynamic_memory_guidance>"
  ].join("\n");
}

async function buildContextGuidanceSection(source, contextManagement = null) {
  const context = normalizeContextManagement(contextManagement);
  if (!context.enabled) return "";
  const sectionIds = ["external-context"];
  if (context.toolResultMasking) sectionIds.push("tool-result-masking");
  if (context.fileOffloading) sectionIds.push("file-offloading");
  if (context.sessionCompaction) sectionIds.push("session-compact");
  else if (context.deterministicCheckpoint) sectionIds.push("deterministic-checkpoint");
  if (context.subagentIsolation) sectionIds.push("subagent-isolation");
  const asset = await source.loadSystemPromptAsset("block://context.guidance", { required: true });
  return [
    "<dynamic_context_guidance>",
    ...sectionIds.map((sectionId) => requiredAssetSection(
      asset,
      sectionId,
      "block://context.guidance"
    )),
    "</dynamic_context_guidance>"
  ].join("\n");
}

function contextGuidanceCacheKey(contextManagement = null) {
  const context = normalizeContextManagement(contextManagement);
  if (!context.enabled) return "none";
  return [
    context.toolResultMasking ? "mask" : "no-mask",
    context.fileOffloading ? "offload" : "no-offload",
    context.sessionCompaction ? "session" : "no-session",
    context.deterministicCheckpoint ? "checkpoint" : "no-checkpoint",
    context.subagentIsolation ? "subagent" : "no-subagent"
  ].join(":");
}

function normalizeContextManagement(value = null) {
  const source = value && typeof value === "object" ? value : {};
  return {
    enabled: source.enabled === true,
    toolResultMasking: source.toolResultMasking === true,
    fileOffloading: source.fileOffloading === true,
    sessionCompaction: source.sessionCompaction === true,
    deterministicCheckpoint: source.deterministicCheckpoint === true,
    subagentIsolation: source.subagentIsolation === true
  };
}

function memoryGuidanceCacheKey(memoryContext = null) {
  const context = normalizeMemoryContext(memoryContext);
  if (!context.enabled) return "none";
  return [
    context.scope,
    context.storageMode,
    context.autoDream ? "dream" : "no-dream",
    context.sessionMemory ? "session" : "no-session",
    context.transcript ? "transcript" : "no-transcript",
    context.contextResults ? "results" : "no-results"
  ].join(":");
}

function normalizeMemoryContext(value = null) {
  const source = value && typeof value === "object" ? value : {};
  const enabled = source.enabled === true;
  const scope = ["agent", "project", "local"].includes(`${source.scope || source.memoryScope || ""}`)
    ? `${source.scope || source.memoryScope}`
    : "local";
  const storageMode = `${source.storageMode || source.mode || source.memoryMode || ""}` === "append-only"
    ? "append-only"
    : "indexed";
  return {
    enabled,
    scope,
    storageMode,
    autoDream: source.autoDream === true,
    sessionMemory: source.sessionMemory === true,
    transcript: source.transcript === true,
    contextResults: source.contextResults === true
  };
}

function compileSystemPromptSections(sections = []) {
  return (Array.isArray(sections) ? sections : [])
    .filter((section) => (
      typeof section === "string"
      && section.trim()
      && section !== SYSTEM_PROMPT_DYNAMIC_BOUNDARY
    ))
    .join("\n\n");
}

function requiredAssetSection(asset = {}, sectionId = "", blockId = "block://system.agent") {
  const content = typeof asset?.sections?.[sectionId] === "string"
    ? asset.sections[sectionId].trim()
    : "";
  if (content) return content;
  throw requiredPromptSectionError(blockId, sectionId);
}

function buildRuntimeContextSection(options = {}) {
  const toolNames = normalizeToolNames(options.tools);
  const workingDirectory = `${options.workingDirectory || ""}`.trim();
  const additionalDirectories = uniqueStrings(options.additionalWorkingDirectories)
    .filter((directory) => directory !== workingDirectory)
    .sort();
  const mcpClients = normalizeMcpClients(options.mcpClients);
  const model = `${options.model || ""}`.trim();
  const featureGates = normalizeFeatureGates(options.featureGates);
  const environment = normalizeEnvironmentContext(options.environment);
  const currentDate = `${options.currentDate || ""}`.trim();
  const timeZone = `${options.timeZone || ""}`.trim();
  const knowledgeCutoff = `${options.knowledgeCutoff || ""}`.trim();
  const languagePreference = normalizeLanguagePreference(options.languagePreference);
  const scratchpadDirectory = `${options.scratchpadDirectory || ""}`.trim();
  const capabilityCatalog = Array.isArray(options.capabilityCatalog) ? options.capabilityCatalog : [];
  const capabilities = normalizeCapabilityIndex(capabilityCatalog);
  const lines = ["<system-reminder>", "<runtime_meta_context>"];
  if (currentDate || knowledgeCutoff) {
    lines.push("<time_context>");
    if (currentDate) lines.push(`<current_date>${escapeXml(currentDate)}</current_date>`);
    if (timeZone) lines.push(`<timezone>${escapeXml(timeZone)}</timezone>`);
    lines.push(knowledgeCutoff
      ? `<knowledge_cutoff>${escapeXml(knowledgeCutoff)}</knowledge_cutoff>`
      : "<knowledge_cutoff status=\"provider-not-declared\">Do not infer a cutoff; verify changeable facts with current sources.</knowledge_cutoff>");
    lines.push("</time_context>");
  }
  lines.push("<environment>");
  if (environment.platform) lines.push(`<platform>${escapeXml(environment.platform)}</platform>`);
  if (environment.architecture) lines.push(`<architecture>${escapeXml(environment.architecture)}</architecture>`);
  if (environment.shell) lines.push(`<shell>${escapeXml(environment.shell)}</shell>`);
  if (workingDirectory) lines.push(`<working_directory>${escapeXml(workingDirectory)}</working_directory>`);
  if (environment.gitRepository !== null) {
    lines.push(`<git_repository>${environment.gitRepository ? "true" : "false"}</git_repository>`);
  }
  if (environment.gitRoot) lines.push(`<git_root>${escapeXml(environment.gitRoot)}</git_root>`);
  lines.push("</environment>");
  if (languagePreference) {
    lines.push(`<language_preference value="${escapeXml(languagePreference)}">Use this language for user communication, explanations, and new code comments; preserve quoted text, identifiers, commands, and required output formats.</language_preference>`);
  }
  lines.push("<runtime_capabilities>");
  lines.push(`<tools>${toolNames.length ? toolNames.map(escapeXml).join(", ") : "none"}</tools>`);
  if (model) lines.push(`<model>${escapeXml(model)}</model>`);
  if (additionalDirectories.length) {
    lines.push("<additional_working_directories>");
    for (const directory of additionalDirectories) {
      lines.push(`<directory>${escapeXml(directory)}</directory>`);
    }
    lines.push("</additional_working_directories>");
  }
  lines.push(`<mcp_clients>${mcpClients.length ? "" : "none"}`);
  if (mcpClients.length) {
    for (const client of mcpClients) lines.push(`<client>${escapeXml(client)}</client>`);
  }
  lines.push("</mcp_clients>");
  if (scratchpadDirectory) {
    lines.push(`<scratchpad_directory lifecycle="task" deliverable="false">${escapeXml(scratchpadDirectory)}</scratchpad_directory>`);
  }
  if (featureGates.length) {
    lines.push(`<feature_gates>${featureGates.map(escapeXml).join(", ")}</feature_gates>`);
  }
  if (capabilities.length) {
    lines.push(`<capability_index loader="load_capability" shown="${capabilities.length}" total="${capabilityCatalog.length}">`);
    for (const capability of capabilities) {
      const attributes = [
        `id=\"${escapeXml(capability.id)}\"`,
        `kind=\"${escapeXml(capability.kind)}\"`,
        ...(capability.trigger ? [`trigger=\"${escapeXml(capability.trigger)}\"`] : [])
      ].join(" ");
      lines.push(`<capability ${attributes}>${escapeXml(capability.description)}</capability>`);
    }
    lines.push("</capability_index>");
  }
  const outputStyle = `${options.outputStylePrompt || ""}`.trim();
  if (outputStyle) lines.push(outputStyle);
  lines.push("</runtime_capabilities>");
  lines.push("</runtime_meta_context>");
  lines.push("</system-reminder>");
  return lines.join("\n");
}

function normalizeEnvironmentContext(value = null) {
  const source = value && typeof value === "object" ? value : {};
  return {
    platform: `${source.platform || ""}`.trim(),
    architecture: `${source.architecture || source.arch || ""}`.trim(),
    shell: `${source.shell || ""}`.trim(),
    gitRepository: typeof source.gitRepository === "boolean" ? source.gitRepository : null,
    gitRoot: `${source.gitRoot || ""}`.trim()
  };
}

function normalizeLanguagePreference(value = null) {
  const raw = typeof value === "string" ? value : value?.preferred;
  return `${raw || ""}`.trim().replace(/\s+/g, " ").slice(0, 40);
}

function normalizeCapabilityIndex(value = []) {
  const entries = Array.isArray(value) ? value : [];
  const unique = new Map();
  for (const entry of entries) {
    const id = `${entry?.id || entry?.name || ""}`.trim();
    if (!id || unique.has(id)) continue;
    const triggers = uniqueStrings([
      ...(Array.isArray(entry?.intentExamples) ? entry.intentExamples : []),
      ...(Array.isArray(entry?.keywords) ? entry.keywords : [])
    ]).slice(0, 3);
    unique.set(id, {
      id,
      kind: `${entry?.kind || "tool"}`.trim().slice(0, 40),
      description: `${entry?.description || entry?.title || id}`.trim().replace(/\s+/g, " ").slice(0, 240),
      trigger: triggers.join(" | ").slice(0, 180)
    });
  }
  return [...unique.values()]
    .sort((left, right) => left.id.localeCompare(right.id))
    .slice(0, 96);
}

async function getOutputStylePrompt(source, config = null) {
  const mode = normalizeOutputStyleMode(config);
  if (mode === "standard") return "";
  assertPromptSource(source);
  const asset = await source.loadSystemPromptAsset("block://output.style", { required: true });
  return requiredAssetSection(asset, mode, "block://output.style");
}

function normalizeOutputStyleMode(config = null) {
  const raw = typeof config === "string"
    ? config
    : (config?.mode || config?.type || "standard");
  const mode = `${raw || "standard"}`.trim().toLowerCase();
  if (["explanatory", "explain", "explanation"].includes(mode)) return "explanatory";
  if (["learning", "learn", "tutorial"].includes(mode)) return "learning";
  return "standard";
}

function normalizeToolNames(tools = []) {
  const source = Array.isArray(tools) ? tools : [];
  return [...new Set(source.map((tool) => {
    if (typeof tool === "string") return tool.trim();
    return `${tool?.function?.name || tool?.name || ""}`.trim();
  }).filter(Boolean))].sort();
}

function normalizeMcpClients(clients = []) {
  return uniqueStrings((Array.isArray(clients) ? clients : []).map((client) => {
    if (typeof client === "string") return client;
    return client?.name || client?.id || client?.serverName || "";
  })).sort();
}

function normalizeFeatureGates(value = null) {
  if (Array.isArray(value)) return uniqueStrings(value).sort();
  if (!value || typeof value !== "object") return [];
  return Object.keys(value).filter((key) => value[key] === true).sort();
}

function uniqueStrings(values = []) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => `${value || ""}`.trim())
    .filter(Boolean))];
}

function escapeXml(value = "") {
  return `${value || ""}`
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function assertPromptSource(source) {
  if (
    typeof source?.loadSystemPromptBlock !== "function"
    || typeof source?.loadSystemPromptAsset !== "function"
    || typeof source?.loadSystemPromptSection !== "function"
  ) {
    throw new TypeError("getSystemPrompt 缺少 Prompt Registry 加载接口。");
  }
}

function requiredPromptSectionError(blockId, sectionId) {
  const error = /** @type {Error & {code?:string, blockId?:string, sectionId?:string}} */ (
    new Error(`缺少必需 Prompt section：${blockId}#${sectionId}`)
  );
  error.code = "REQUIRED_PROMPT_SECTION_UNAVAILABLE";
  error.blockId = blockId;
  error.sectionId = sectionId;
  return error;
}

module.exports = {
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
  STATIC_SECTION_IDS,
  DYNAMIC_SECTION_IDS,
  DYNAMIC_SECTION_DEFINITIONS,
  getSystemPrompt,
  getSystemPromptSectionCache,
  setSystemPromptSectionCache,
  compileSystemPromptSections,
  buildContextGuidanceSection,
  buildMemoryGuidanceSection,
  buildToolGuidanceSection,
  buildRuntimeContextSection,
  getOutputStylePrompt,
  normalizeOutputStyleMode,
  requiredPromptSectionError
};
