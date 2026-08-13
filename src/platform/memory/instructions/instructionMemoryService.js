// @ts-check

const fsp = require("node:fs/promises");
const path = require("node:path");
const { InstructionFileLoader, sha256 } = require("./instructionFileLoader");
const { InstructionMemoryTurn } = require("./instructionMemoryTurn");
const {
  resolveManagedInstructionRoot,
  resolveUserInstructionRoot
} = require("./instructionPaths");

const DEFAULT_INSTRUCTION_MEMORY_CONFIG = Object.freeze({
  enabled: true,
  initialTokens: 16000,
  activeTokens: 32000,
  perDocumentTokens: 8000,
  maxRulesPerDirectory: 256,
  maxCandidates: 1024,
  maxOwnerDirectories: 4096
});

class InstructionMemoryService {
  constructor({
    settingsService = null,
    managedRoot = "",
    userRoot = "",
    platform = process.platform,
    homeDirectory = "",
    memoryCacheService = null,
    clock = () => new Date()
  } = {}) {
    this.settingsService = settingsService;
    this.platform = platform;
    this.managedRoot = managedRoot || resolveManagedInstructionRoot(platform);
    this.userRoot = userRoot || resolveUserInstructionRoot(homeDirectory || undefined);
    this.memoryCacheService = memoryCacheService;
    this.clock = clock;
    this.loader = new InstructionFileLoader();
  }

  async beginTurn({ scopeRoot = "", cwd = "", explicitTargets = [], cacheScope = "" } = {}) {
    const config = await this.resolveConfig();
    if (!config.enabled) return null;
    const canonicalRoot = await requireDirectory(scopeRoot, "scopeRoot");
    const canonicalCwd = await requireDirectory(cwd || scopeRoot, "cwd");
    const cacheSession = cacheScope && this.memoryCacheService
      ? this.memoryCacheService.session(cacheScope)
      : null;
    const contextKey = instructionContextKey({
      scopeRoot: canonicalRoot,
      cwd: canonicalCwd,
      managedRoot: this.managedRoot,
      userRoot: this.userRoot,
      config
    });
    const onUserContextChange = cacheSession
      ? (value) => cacheSession.userContext.set(contextKey, value)
      : null;
    const loader = cacheSession
      ? new InstructionFileLoader({ cache: cacheSession.memoryFiles })
      : this.loader;
    const cached = cacheSession?.userContext.get(contextKey) || null;
    const today = localDate(this.clock());
    if (cached) {
      return new InstructionMemoryTurn({
        ...config,
        platform: this.platform,
        scopeRoot: canonicalRoot,
        cwd: canonicalCwd,
        managedRoot: this.managedRoot,
        userRoot: this.userRoot,
        currentDate: today,
        loader,
        onUserContextChange
      }).resume(cached, Array.isArray(explicitTargets) ? explicitTargets : []);
    }
    const managedRoot = await optionalDirectory(this.managedRoot);
    const userRoot = await optionalDirectory(this.userRoot);
    const turn = new InstructionMemoryTurn({
      ...config,
      platform: this.platform,
      scopeRoot: canonicalRoot,
      cwd: canonicalCwd,
      managedRoot,
      userRoot,
      currentDate: localDate(this.clock()),
      loader,
      onUserContextChange
    });
    return turn.initialize(Array.isArray(explicitTargets) ? explicitTargets : []);
  }

  async resolveConfig() {
    let settings = {};
    try {
      settings = await this.settingsService?.get?.() || {};
    } catch {}
    const source = settings.instructions || {};
    const initialTokens = bounded(source.initialTokens, 1000, 64000, DEFAULT_INSTRUCTION_MEMORY_CONFIG.initialTokens);
    return {
      enabled: source.enabled !== false,
      initialTokens,
      activeTokens: Math.max(initialTokens, bounded(source.activeTokens, 1000, 128000, DEFAULT_INSTRUCTION_MEMORY_CONFIG.activeTokens)),
      perDocumentTokens: bounded(source.perDocumentTokens, 256, 32000, DEFAULT_INSTRUCTION_MEMORY_CONFIG.perDocumentTokens),
      maxRulesPerDirectory: bounded(source.maxRulesPerDirectory, 1, 1024, DEFAULT_INSTRUCTION_MEMORY_CONFIG.maxRulesPerDirectory),
      maxCandidates: bounded(source.maxCandidates, 1, 4096, DEFAULT_INSTRUCTION_MEMORY_CONFIG.maxCandidates),
      maxOwnerDirectories: bounded(source.maxOwnerDirectories, 1, 16384, DEFAULT_INSTRUCTION_MEMORY_CONFIG.maxOwnerDirectories)
    };
  }
}

function instructionContextKey({ scopeRoot = "", cwd = "", managedRoot = "", userRoot = "", config = {} } = {}) {
  return sha256(JSON.stringify({ scopeRoot, cwd, managedRoot, userRoot, config }));
}

function localDate(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("指令记忆 current date 无效");
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join("-");
}

async function optionalDirectory(value = "") {
  if (!value) return "";
  try {
    const stat = await fsp.lstat(value);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return "";
    return await fsp.realpath(value);
  } catch {
    return "";
  }
}

async function requireDirectory(value = "", label = "directory") {
  const absolute = path.resolve(`${value || ""}`);
  const stat = await fsp.stat(absolute).catch(() => null);
  if (!stat?.isDirectory()) throw new Error(`指令记忆 ${label} 不是有效目录`);
  return fsp.realpath(absolute);
}

function bounded(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.floor(number))) : fallback;
}

module.exports = {
  InstructionMemoryService,
  DEFAULT_INSTRUCTION_MEMORY_CONFIG,
  instructionContextKey,
  localDate
};
