// @ts-check

const os = require("node:os");
const path = require("node:path");
const { KeyedSerialExecutor } = require("../shared/keyedSerialExecutor");
const { MemdirStore, PREFETCH_FRONT_MATTER_LINES } = require("./memdir/memdirStore");
const {
  MEMORY_TYPES,
  MAX_INDEX_LINES,
  MAX_INDEX_BYTES,
  MAX_INDEX_SUMMARY_CHARS,
  MAX_TOPIC_BYTES,
  MEMORY_STALE_AFTER_DAYS
} = require("./memdir/memdirFormat");
const { TYPE_BASIS, FEEDBACK_POLARITIES } = require("./memdir/memdirPolicy");
const {
  AGENT_MEMORY_SCOPES,
  AGENT_MEMORY_MODES,
  DEFAULT_AGENT_TYPE,
  normalizeAgentMemoryProfile
} = require("./memdir/agentMemoryProfile");
const { MEMORY_LOG_PATH_PATTERN } = require("./memdir/memdirJournal");

// MemoryStore 保留原服务名，运行实现是按 Agent profile 绑定的两层 Markdown Memdir。
// 未绑定实例只负责解析并缓存 agent/project/local scoped store；所有读写都在
// scoped store 内完成，模型不能通过工具参数选择 Agent 类型、作用域或任意路径。
class MemoryStore {
  constructor({
    workspaceRoot = "",
    baseDirectory = "",
    homeDirectory = "",
    execFileImpl = null,
    clock = () => new Date()
  } = {}) {
    this.defaultWorkspaceRoot = `${workspaceRoot || ""}`;
    this.homeDirectory = `${homeDirectory || os.homedir()}`;
    this.baseDirectory = `${baseDirectory || (workspaceRoot
      ? path.join(path.resolve(workspaceRoot), ".memdir-home")
      : "")}`;
    this.execFileImpl = execFileImpl;
    this.clock = clock;
    this.writes = new KeyedSerialExecutor();
    this.scopedStores = new Map();
    this.defaultStorePromise = null;
  }

  async forContext(context = {}) {
    const workspaceRoot = typeof context === "string"
      ? context
      : `${context.workspaceRoot || context.contextRoot || ""}`;
    if (!workspaceRoot) throw new Error("Memdir 需要 workspaceRoot");
    const profile = normalizeAgentMemoryProfile(typeof context === "string" ? {} : {
      agentType: context.agentType,
      scope: context.memoryScope || context.scope,
      mode: context.memoryMode || context.mode || context.storageMode
    });
    const provisional = new MemdirStore({
      workspaceRoot,
      baseDirectory: this.baseDirectory,
      homeDirectory: this.homeDirectory,
      execFileImpl: this.execFileImpl,
      writes: this.writes,
      clock: this.clock,
      agentType: profile.agentType,
      scope: profile.scope,
      mode: profile.mode
    });
    const location = await provisional.location();
    const cacheKey = location.memoryDirectory;
    if (this.scopedStores.has(cacheKey)) {
      const existing = this.scopedStores.get(cacheKey);
      if (location.storageMode === "append-only") await existing.activateAppendOnly();
      return existing;
    }
    this.scopedStores.set(cacheKey, provisional);
    return provisional;
  }

  async defaultStore() {
    if (!this.defaultWorkspaceRoot) throw new Error("MemoryStore 尚未绑定 Memdir context");
    if (!this.defaultStorePromise) {
      this.defaultStorePromise = this.forContext({ workspaceRoot: this.defaultWorkspaceRoot });
    }
    return this.defaultStorePromise;
  }

  async ensure() {
    return (await this.defaultStore()).ensure();
  }

  async append(input = {}) {
    return (await this.defaultStore()).append(input);
  }

  async search(options = {}) {
    return (await this.defaultStore()).search(options);
  }

  async list() {
    return (await this.defaultStore()).list();
  }

  async count(options = {}) {
    return (await this.defaultStore()).count(options);
  }

  async indexContext() {
    return (await this.defaultStore()).indexContext();
  }

  async readIndex() {
    return (await this.defaultStore()).readIndex();
  }

  async scanPrefetchMetadata() {
    return (await this.defaultStore()).scanPrefetchMetadata();
  }

  async createReshapeSnapshot() {
    return (await this.defaultStore()).createReshapeSnapshot();
  }

  async applyReshape(plan = {}, options = {}) {
    return (await this.defaultStore()).applyReshape(plan, options);
  }

  async info() {
    return (await this.defaultStore()).info();
  }

  async exportSnapshot(options = {}) {
    return (await this.defaultStore()).exportSnapshot(options);
  }

  async exportSnapshotJson(options = {}) {
    return (await this.defaultStore()).exportSnapshotJson(options);
  }

  async importSnapshot(snapshot = {}, options = {}) {
    return (await this.defaultStore()).importSnapshot(snapshot, options);
  }
}

module.exports = {
  MemoryStore,
  MEMORY_TYPES,
  TYPE_BASIS,
  FEEDBACK_POLARITIES,
  MAX_INDEX_LINES,
  MAX_INDEX_BYTES,
  MAX_INDEX_SUMMARY_CHARS,
  MAX_TOPIC_BYTES,
  MEMORY_STALE_AFTER_DAYS,
  PREFETCH_FRONT_MATTER_LINES,
  AGENT_MEMORY_SCOPES,
  AGENT_MEMORY_MODES,
  DEFAULT_AGENT_TYPE,
  MEMORY_LOG_PATH_PATTERN,
  normalizeAgentMemoryProfile
};
