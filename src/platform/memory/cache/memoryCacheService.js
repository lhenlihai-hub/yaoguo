// @ts-check

const MEMORY_CACHE_OPERATIONS = Object.freeze({
  CLEAR: "clear",
  COMPACT: "compact",
  MEMORY: "memory"
});

const ALL_LAYERS = Object.freeze([
  "memoryFiles",
  "userContext",
  "systemPromptSections"
]);

class MemoryCacheService {
  constructor() {
    this.sessions = new Map();
  }

  taskScope(projectId = "", taskId = "") {
    const project = `${projectId || ""}`.trim();
    const task = `${taskId || ""}`.trim();
    return project && task ? `task:${project}:${task}` : "";
  }

  session(scope = "") {
    const key = normalizeScope(scope);
    let entry = this.sessions.get(key);
    if (!entry) {
      entry = {
        memoryFiles: new Map(),
        userContext: new Map(),
        systemPromptSections: new Map(),
        generations: {
          memoryFiles: 0,
          userContext: 0,
          systemPromptSections: 0
        }
      };
      this.sessions.set(key, entry);
    }
    return entry;
  }

  invalidate(scope = "", operation = MEMORY_CACHE_OPERATIONS.CLEAR) {
    const normalizedOperation = normalizeOperation(operation);
    const entry = this.session(scope);
    const layers = normalizedOperation === MEMORY_CACHE_OPERATIONS.MEMORY
      ? ["memoryFiles"]
      : ALL_LAYERS;
    const cleared = {};
    for (const layer of layers) {
      cleared[layer] = entry[layer].size;
      entry[layer].clear();
      entry.generations[layer] += 1;
    }
    return {
      scope: normalizeScope(scope),
      operation: normalizedOperation,
      layers: [...layers],
      cleared,
      generations: { ...entry.generations }
    };
  }

  stats(scope = "") {
    const entry = this.session(scope);
    return {
      scope: normalizeScope(scope),
      sizes: Object.fromEntries(ALL_LAYERS.map((layer) => [layer, entry[layer].size])),
      generations: { ...entry.generations }
    };
  }

  release(scope = "") {
    return this.sessions.delete(normalizeScope(scope));
  }

  releaseProject(projectId = "") {
    const prefix = `task:${`${projectId || ""}`.trim()}:`;
    let released = 0;
    for (const key of this.sessions.keys()) {
      if (!key.startsWith(prefix)) continue;
      this.sessions.delete(key);
      released += 1;
    }
    return released;
  }
}

function normalizeScope(value = "") {
  const scope = `${value || ""}`.trim();
  return scope || "application";
}

function normalizeOperation(value = "") {
  const operation = `${value || ""}`.trim().toLowerCase().replace(/^\//, "");
  if (["clear", "compact", "memory"].includes(operation)) return operation;
  const error = /** @type {Error & {code?: string}} */ (
    new Error(`未知记忆缓存操作：${operation || "(empty)"}`)
  );
  error.code = "MEMORY_CACHE_OPERATION_INVALID";
  throw error;
}

module.exports = {
  MemoryCacheService,
  MEMORY_CACHE_OPERATIONS,
  ALL_LAYERS
};
