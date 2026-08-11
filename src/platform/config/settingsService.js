const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { DEEPSEEK_V4_CONTEXT_WINDOW_TOKENS } = require("../ai/deepseekV4Policy");

const INSECURE_DEFAULT_BRIDGE_TOKEN = "local-change-me";

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

async function exists(file) {
  try {
    await fsp.access(file);
    return true;
  } catch {
    return false;
  }
}

async function readJson(file, fallback) {
  if (!(await exists(file))) return structuredClone(fallback);
  const content = await fsp.readFile(file, "utf8");
  if (!content.trim()) return structuredClone(fallback);
  return JSON.parse(content);
}

async function writeJsonAtomic(file, data) {
  await ensureDir(path.dirname(file));
  const temp = file + "." + crypto.randomUUID() + ".tmp";
  await fsp.writeFile(temp, JSON.stringify(data, null, 2) + "\n", "utf8");
  await fsp.rename(temp, file);
}

const DEFAULT_SETTINGS = {
  instructions: {
    enabled: true,
    initialTokens: 16000,
    activeTokens: 32000,
    perDocumentTokens: 8000,
    maxRulesPerDirectory: 256,
    maxCandidates: 1024,
    maxOwnerDirectories: 4096
  },
  deepseek: {
    enabled: false,
    baseUrl: "https://api.deepseek.com",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    model: "deepseek-v4-pro",
    thinking: "max",
    temperature: 0.65
  },
  permissions: {
    fileSystem: {
      fullAccess: false
    },
    agent: {
      mode: "ask",
      rules: {}
    }
  },
  context: {
    tokenBudgets: {
      defaultModelTokens: 128000,
      outputReserveTokens: 6000,
      models: {
        "deepseek-v4-pro": DEEPSEEK_V4_CONTEXT_WINDOW_TOKENS,
        "deepseek-v4-flash": DEEPSEEK_V4_CONTEXT_WINDOW_TOKENS
      }
    },
    agentHistory: {
      readLimit: 160,
      tokens: 12000
    },
    // Agent 活动上下文与模型物理窗口分离：大窗口不是工作集目标。
    // 达到 clearStart 后先清旧工具正文；达到 trigger 后生成无模型、可追溯 checkpoint，
    // 完整工具结果留在外部 ContextResultStore，需要时分页回读。
    agentLoop: {
      enabled: true,
      triggerRatio: 0.6,
      maxActiveTokens: 100000,
      clearStartRatio: 0.72,
      inlineToolResultTokens: 10000,
      toolResultPreviewTokens: 1800,
      keepRecentToolGroups: 2,
      checkpointMaxEvents: 24,
      checkpointArgumentChars: 600,
      checkpointPreviewChars: 320
    },
    // 单次长会话在压缩前由后台模型渐进维护 session/memory.md。
    // 达到 2 万 tokens 后，新增 1.2 万 tokens 或 6 次工具调用才更新；
    // 10 万 tokens 后可用现成笔记 + 1.2-3.2 万 tokens 完整消息尾部开新 episode。
    sessionMemory: {
      enabled: true,
      minContextTokens: 20000,
      updateDeltaTokens: 12000,
      updateToolCalls: 6,
      compactTriggerTokens: 100000,
      minKeepTokens: 12000,
      maxKeepTokens: 32000,
      maxUpdateInputTokens: 36000,
      maxNoteTokens: 6000
    }
  },
  fileStorage: {
    keepStepOutputs: true
  },
  webSearch: {
    // Bing Search API 已于 2025-08 关停，默认 provider 切到 Tavily（为 AI agent 设计）。
    // 启用需 enabled=true + 设 TAVILY_API_KEY；未配 key 时回落 publicFallback。
    enabled: false,
    provider: "tavily",
    apiKeyEnv: "TAVILY_API_KEY",
    endpoint: "https://api.tavily.com/search",
    market: "zh-CN",
    count: 8,
    publicFallback: true,
    // 免-key 公开检索源：jina=s.jina.ai（默认，结构化、无需 Key）；bing-rss=回落旧 RSS。
    publicProvider: "jina",
    publicEndpoint: "https://www.bing.com/search"
  },
  referenceSearch: {
    maxInternetResults: 18,
    maxLocalResults: 30,
    maxPreviewChars: 18000,
    maxLocalFileBytes: 1200000,
    localExtensions: [".md", ".txt", ".json", ".html", ".css", ".js", ".mjs", ".cjs", ".csv"]
  },
  // generate_visual 导出：HTML 成品之外，用 Chromium 额外渲染一份 PDF（成品的可发送形态，零计费）。
  visualExport: {
    pdf: true
  },
  bridge: {
    enabled: true,
    host: "127.0.0.1",
    port: 37521,
    token: ""
  },
  timeouts: {
    ttftDefaultMs: 60000,
    idleDefaultMs: 90000,
    wallDefaultMs: 600000,
    ttftReasoningMs: 240000,
    idleReasoningMs: 180000,
    wallReasoningMs: 1500000
  }
};

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function mergeDefaults(value, defaults) {
  if (Array.isArray(defaults)) {
    return Array.isArray(value) ? value : structuredClone(defaults);
  }
  if (!isPlainObject(defaults)) {
    return value === undefined ? defaults : value;
  }
  const source = isPlainObject(value) ? value : {};
  const merged = { ...source };
  for (const [key, defaultValue] of Object.entries(defaults)) {
    merged[key] = mergeDefaults(source[key], defaultValue);
  }
  return merged;
}

function normalizeDeepSeekModel(model = "") {
  const value = `${model || ""}`.trim().toLowerCase();
  if (value === "deepseek-chat") return "deepseek-v4-flash";
  if (value === "deepseek-reasoner") return "deepseek-v4-pro";
  if (/^deepseek-v4-(?:pro|flash)$/.test(value)) return value;
  return DEFAULT_SETTINGS.deepseek.model;
}

function normalizeThinkingLevel(value, fallback = DEFAULT_SETTINGS.deepseek.thinking) {
  if (value === true) return "high";
  if (value === false) return "disabled";
  const level = `${value || ""}`.trim().toLowerCase();
  return ["disabled", "high", "max"].includes(level) ? level : fallback;
}

function normalizePermissionMode(value, fallback = "ask") {
  const mode = `${value || ""}`.trim().toLowerCase();
  return ["ask", "allow", "deny"].includes(mode) ? mode : fallback;
}

function normalizePermissionRules(value) {
  if (!isPlainObject(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(([effect]) => /^[a-z][a-z0-9_]{0,63}$/.test(effect))
      .map(([effect, mode]) => [effect, normalizePermissionMode(mode)])
  );
}

function migrateDeepSeekSettings(value = {}) {
  const source = structuredClone(isPlainObject(value) ? value : {});
  const legacyProvider = Array.isArray(source.providers)
    ? source.providers.find((provider) => provider?.id === "deepseek")
    : null;
  const legacyRoute = `${source.taskRoutes?.default || ""}`;
  const legacyRouteModel = legacyRoute.startsWith("deepseek:") ? legacyRoute.slice("deepseek:".length) : "";
  const current = isPlainObject(source.deepseek) ? source.deepseek : {};
  const legacyThinking = isPlainObject(source.deepseekV4) ? source.deepseekV4 : {};
  const legacyThinkingByTask = {
    ...(isPlainObject(legacyThinking.thinkingByTask) ? legacyThinking.thinkingByTask : {}),
    ...(isPlainObject(current.thinkingByTask) ? current.thinkingByTask : {})
  };
  const legacyBrain = isPlainObject(source.aiBrain) ? source.aiBrain : {};
  const migratedThinking = current.thinking
    ?? current.thinkingLevel
    ?? legacyThinking.thinking
    ?? legacyThinkingByTask.agent
    ?? legacyThinkingByTask.default
    ?? (legacyBrain.thinkingMode === false ? "disabled" : undefined);
  source.deepseek = {
    ...current,
    enabled: current.enabled ?? legacyProvider?.enabled,
    baseUrl: current.baseUrl || legacyProvider?.baseUrl,
    apiKeyEnv: current.apiKeyEnv || legacyProvider?.apiKeyEnv,
    apiKey: current.apiKey || legacyProvider?.apiKey || "",
    model: normalizeDeepSeekModel(current.model || current.defaultModel || legacyProvider?.defaultModel || legacyRouteModel),
    thinking: normalizeThinkingLevel(migratedThinking),
    temperature: current.temperature ?? legacyProvider?.temperature
  };
  delete source.deepseek.defaultModel;
  delete source.deepseek.thinkingLevel;
  delete source.deepseek.thinkingByTask;
  delete source.deepseek.agentToolMaxTokens;
  delete source.deepseek.models;
  delete source.providers;
  delete source.taskRoutes;
  delete source.deepseekV4;
  return source;
}

function migrateAgentHistorySettings(value = {}) {
  const source = structuredClone(isPlainObject(value) ? value : {});
  const compaction = source.context?.compaction;
  if (!isPlainObject(source.context)) source.context = {};
  const current = isPlainObject(source.context.agentHistory) ? source.context.agentHistory : {};
  const legacy = isPlainObject(compaction) ? compaction : {};
  source.context.agentHistory = {
    ...current,
    readLimit: current.readLimit ?? legacy.agentHistoryReadLimit ?? legacy.chatHistoryReadLimit,
    tokens: current.tokens ?? legacy.agentHistoryTokens ?? legacy.chatHistoryTokens
  };
  delete source.context.compaction;
  return source;
}

function mergeSettings(value = {}) {
  const migrated = migrateAgentHistorySettings(migrateDeepSeekSettings(value));
  const merged = mergeDefaults(migrated, DEFAULT_SETTINGS);

  // V4 官方窗口是十进制 1M；迁移曾按 2^20 写入的旧值，并阻止配置高估物理上限。
  const modelTokenBudgets = merged.context?.tokenBudgets?.models;
  if (isPlainObject(modelTokenBudgets)) {
    for (const model of ["deepseek-v4-pro", "deepseek-v4-flash"]) {
      const configured = Number(modelTokenBudgets[model]);
      modelTokenBudgets[model] = Number.isFinite(configured) && configured > 0
        ? Math.min(configured, DEEPSEEK_V4_CONTEXT_WINDOW_TOKENS)
        : DEEPSEEK_V4_CONTEXT_WINDOW_TOKENS;
    }
  }

  merged.deepseek.model = normalizeDeepSeekModel(merged.deepseek.model);
  merged.deepseek.thinking = normalizeThinkingLevel(merged.deepseek.thinking);
  delete merged.aiBrain;
  delete merged.delegation;
  delete merged.evolution;
  delete merged.clarification;
  delete merged.workspaceName;
  delete merged.locale;
  delete merged.memory;
  if (isPlainObject(merged.decisions)) {
    delete merged.decisions.useAiCardGeneration;
    delete merged.decisions.autoApprove;
    if (!Object.keys(merged.decisions).length) delete merged.decisions;
  }
  if (merged.webSearch?.provider === "bing") {
    merged.webSearch = {
      ...merged.webSearch,
      enabled: false,
      provider: "tavily",
      apiKeyEnv: "TAVILY_API_KEY",
      endpoint: "https://api.tavily.com/search"
    };
    delete merged.webSearch.apiKey;
  }
  if (isPlainObject(merged.webSearch)) {
    for (const key of [
      "hotspots",
      "aiQueryPlanningEnabled",
      "searchConcurrency",
      "rerankThreshold",
      "readTopK",
      "readConcurrency",
      "maxArticleChars"
    ]) {
      delete merged.webSearch[key];
    }
  }
  delete merged.imageSearch;
  if (isPlainObject(merged.webSearch)) {
    if (merged.webSearch.apiKey
      && merged.webSearch.credentialProvider
      && merged.webSearch.credentialProvider !== merged.webSearch.provider) {
      delete merged.webSearch.apiKey;
    }
    delete merged.webSearch.credentialProvider;
  }
  if (isPlainObject(merged.referenceSearch)) {
    for (const key of [
      "maxInternetQueries",
      "minRelevanceScore",
      "minCitationRelevanceScore",
      "aiScreeningEnabled",
      "aiQueryPlanningEnabled",
      "factCheckPreviewSources"
    ]) {
      delete merged.referenceSearch[key];
    }
  }
  if (isPlainObject(merged.fileStorage)) {
    merged.fileStorage = {
      keepStepOutputs: merged.fileStorage.keepStepOutputs !== false
    };
  }
  merged.permissions = {
    fileSystem: {
      fullAccess: merged.permissions?.fileSystem?.fullAccess === true
    },
    agent: {
      mode: normalizePermissionMode(merged.permissions?.agent?.mode),
      rules: normalizePermissionRules(merged.permissions?.agent?.rules)
    }
  };

  return merged;
}

function overlaySettings(base = {}, overlay = {}) {
  if (Array.isArray(base) && Array.isArray(overlay)) {
    const overlayById = new Map(overlay.filter((item) => isPlainObject(item) && item.id).map((item) => [item.id, item]));
    const seen = new Set();
    const merged = base.map((item) => {
      if (!isPlainObject(item) || !item.id) return item;
      seen.add(item.id);
      return overlayById.has(item.id) ? overlaySettings(item, overlayById.get(item.id)) : item;
    });
    for (const item of overlay) {
      if (isPlainObject(item) && item.id && seen.has(item.id)) continue;
      merged.push(item);
    }
    return merged;
  }
  if (isPlainObject(base) && isPlainObject(overlay)) {
    const merged = { ...base };
    for (const [key, value] of Object.entries(overlay)) {
      merged[key] = key in merged ? overlaySettings(merged[key], value) : value;
    }
    return merged;
  }
  return overlay === undefined ? base : overlay;
}

function extractSensitiveSettings(settings = {}) {
  const migrated = migrateDeepSeekSettings(settings);
  const local = {};
  if (migrated.deepseek?.apiKey) local.deepseek = { apiKey: migrated.deepseek.apiKey };
  if (migrated.webSearch?.apiKey) {
    local.webSearch = {
      apiKey: migrated.webSearch.apiKey,
      credentialProvider: migrated.webSearch.provider || "tavily"
    };
  }
  if (migrated.bridge?.token && migrated.bridge.token !== INSECURE_DEFAULT_BRIDGE_TOKEN) {
    local.bridge = { token: migrated.bridge.token };
  }
  return local;
}

function stripSensitiveSettings(settings = {}) {
  const clean = migrateAgentHistorySettings(migrateDeepSeekSettings(settings));
  if (clean.deepseek) delete clean.deepseek.apiKey;
  if (clean.webSearch) {
    delete clean.webSearch.apiKey;
    delete clean.webSearch.credentialProvider;
  }
  delete clean.imageSearch;
  if (clean.bridge) delete clean.bridge.token;
  return clean;
}

function createBridgeToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function ensureBridgeLocalSecret(local = {}) {
  const next = structuredClone(local || {});
  if (!isPlainObject(next.bridge)) next.bridge = {};
  if (!next.bridge.token || next.bridge.token === INSECURE_DEFAULT_BRIDGE_TOKEN) {
    next.bridge.token = createBridgeToken();
  }
  return next;
}

function splitSettingsForStorage(settings = {}) {
  return {
    publicSettings: stripSensitiveSettings(settings),
    localSettings: extractSensitiveSettings(settings)
  };
}

class SettingsService {
  constructor(paths) {
    this.paths = paths;
    this.mutationTail = Promise.resolve();
  }

  async ensure() {
    await ensureDir(this.paths.configDir);
    if (!(await exists(this.paths.settingsFile))) {
      await writeJsonAtomic(this.paths.settingsFile, stripSensitiveSettings(DEFAULT_SETTINGS));
    }
    const current = await readJson(this.paths.settingsFile, {});
    const local = await readJson(this.paths.settingsLocalFile, {}).catch(() => ({}));
    const migratedLocal = ensureBridgeLocalSecret(
      extractSensitiveSettings(overlaySettings(current, local))
    );
    if (migratedLocal.webSearch?.apiKey && !migratedLocal.webSearch.credentialProvider) {
      migratedLocal.webSearch.credentialProvider = current.webSearch?.provider || "tavily";
    }
    const merged = stripSensitiveSettings(mergeSettings(stripSensitiveSettings(current)));
    if (JSON.stringify(current) !== JSON.stringify(merged)) {
      await writeJsonAtomic(this.paths.settingsFile, merged);
    }
    if (JSON.stringify(local) !== JSON.stringify(migratedLocal)) {
      await writeJsonAtomic(this.paths.settingsLocalFile, migratedLocal);
    }
  }

  async get() {
    await this.ensure();
    const settings = await readJson(this.paths.settingsFile, DEFAULT_SETTINGS);
    const local = await readJson(this.paths.settingsLocalFile, {}).catch(() => ({}));
    return mergeSettings(overlaySettings(settings, local));
  }

  async replace(nextSettings) {
    return this.enqueueMutation(async () => {
      const current = await this.get();
      const next = structuredClone(nextSettings || {});
      next.permissions = {
        ...(next.permissions || {}),
        agent: {
          ...(next.permissions?.agent || {}),
          rules: {
            ...(current.permissions?.agent?.rules || {}),
            ...(next.permissions?.agent?.rules || {})
          }
        }
      };
      return this.replaceUnlocked(next);
    });
  }

  async replaceUnlocked(nextSettings) {
    if (!nextSettings || typeof nextSettings !== "object") {
      throw new Error("配置必须是 JSON 对象。");
    }
    const { publicSettings, localSettings } = splitSettingsForStorage(nextSettings);
    await writeJsonAtomic(this.paths.settingsFile, stripSensitiveSettings(mergeSettings(publicSettings)));
    await writeJsonAtomic(this.paths.settingsLocalFile, localSettings);
    return this.get();
  }

  async setFullFileSystemAccess(enabled) {
    return this.mutate((settings) => {
      settings.permissions = {
        ...(settings.permissions || {}),
        fileSystem: { fullAccess: enabled === true }
      };
    });
  }

  async setAgentPermissionMode(mode) {
    return this.mutate((settings) => {
      settings.permissions = {
        ...(settings.permissions || {}),
        agent: {
          ...(settings.permissions?.agent || {}),
          mode: normalizePermissionMode(mode)
        }
      };
    });
  }

  async setToolPermissionRule(effect, mode) {
    const key = `${effect || ""}`.trim();
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(key)) {
      throw new Error("工具 effect 必须是小写标识符。");
    }
    return this.mutate((settings) => {
      settings.permissions = {
        ...(settings.permissions || {}),
        agent: {
          ...(settings.permissions?.agent || {}),
          rules: {
            ...(settings.permissions?.agent?.rules || {}),
            [key]: normalizePermissionMode(mode)
          }
        }
      };
    });
  }

  async clearToolPermissionRules() {
    return this.mutate((settings) => {
      settings.permissions = {
        ...(settings.permissions || {}),
        agent: {
          ...(settings.permissions?.agent || {}),
          rules: {}
        }
      };
    });
  }

  mutate(reducer) {
    return this.enqueueMutation(async () => {
      const settings = await this.get();
      await reducer(settings);
      return this.replaceUnlocked(settings);
    });
  }

  enqueueMutation(operation) {
    const current = this.mutationTail.catch(() => undefined).then(operation);
    this.mutationTail = current.then(() => undefined, () => undefined);
    return current;
  }
}

module.exports = {
  DEFAULT_SETTINGS,
  SettingsService,
  mergeSettings,
  migrateDeepSeekSettings,
  migrateAgentHistorySettings,
  normalizeDeepSeekModel,
  normalizeThinkingLevel,
  normalizePermissionMode,
  normalizePermissionRules,
  overlaySettings,
  extractSensitiveSettings,
  stripSensitiveSettings,
  splitSettingsForStorage
};
