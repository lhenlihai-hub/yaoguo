// @ts-check

const { parseJsonObjectFromText } = require("../../runtime");
const { createPromptContractLoader } = require("../promptContractLoader");
const {
  MAX_PREFETCH_FILES,
  normalizePrefetchSelection,
  normalizeConversation,
  selectorCandidates,
  renderPrefetchContext
} = require("./memoryPrefetchFormat");

const PREFETCH_PROMPT_BLOCK = "block://memory.prefetch";

class MemoryPrefetchService {
  constructor({ aiRouter = null, registryService = null, clock = () => new Date(), onError = null } = {}) {
    this.aiRouter = aiRouter;
    this.registryService = registryService;
    this.clock = clock;
    this.onError = onError;
    this.loadContract = createPromptContractLoader({
      registryService: this.registryService,
      blockId: PREFETCH_PROMPT_BLOCK,
      reportError: (error) => this.reportError(error)
    });
  }

  beginTurn(options = {}) {
    return new MemoryPrefetchTurn(this, options);
  }

  async select(turn) {
    if (!turn.memoryStore?.scanPrefetchMetadata || !turn.memoryStore?.search) {
      return { candidates: [], memories: [], selectedFiles: [], code: "MEMORY_STORE_UNAVAILABLE" };
    }
    const topics = await turn.memoryStore.scanPrefetchMetadata();
    const available = topics.filter((topic) => !turn.shownFiles.has(`${topic.file || ""}`));
    if (!available.length) return { candidates: [], memories: [], selectedFiles: [], code: "NO_CANDIDATES" };
    const now = this.clock();
    const candidates = selectorCandidates(available, now);
    const contract = await this.loadContract();
    if (!contract) {
      return { candidates, memories: [], selectedFiles: [], code: "PREFETCH_PROMPT_UNAVAILABLE" };
    }
    const response = await this.runSelector({ turn, contract, candidates });
    const payload = parseJsonObjectFromText(`${response?.content || response || ""}`);
    const selectedFiles = normalizePrefetchSelection(payload, candidates, [...turn.shownFiles]);
    if (!selectedFiles.length) {
      return { candidates, memories: [], selectedFiles: [], code: "NO_SELECTION" };
    }
    const memories = await turn.memoryStore.search({
      files: selectedFiles,
      limit: MAX_PREFETCH_FILES,
      now
    });
    const byFile = new Map(memories.map((memory) => [memory.file, memory]));
    const ordered = selectedFiles.map((file) => byFile.get(file)).filter(Boolean);
    return {
      candidates,
      memories: ordered,
      selectedFiles: ordered.map((memory) => memory.file),
      code: ordered.length ? "READY" : "NO_SELECTION"
    };
  }

  async runSelector({ turn, contract, candidates }) {
    const args = {
      taskType: "memory",
      title: "长期记忆 Prefetch 旁路筛选",
      instruction: contract,
      input: JSON.stringify({
        conversation: turn.conversation,
        recent_tools: turn.recentTools,
        candidates
      }),
      contextProfile: "minimal",
      contextBudget: {
        runContextTokens: 0,
        inputTokens: 24000
      },
      pinnedSections: [],
      internalCall: true,
      jsonMode: true,
      thinkingOverride: "disabled",
      maxOutputTokens: 512,
      signal: turn.signal || null,
      projectId: turn.projectId,
      taskId: turn.taskId,
      runId: turn.runId,
      stepId: turn.turnId
    };
    if (typeof this.aiRouter?.runTaskDetailed === "function") {
      return this.aiRouter.runTaskDetailed(args);
    }
    if (typeof this.aiRouter?.runTask === "function") {
      return this.aiRouter.runTask(args);
    }
    return { content: '{"files":[]}' };
  }


  reportError(error) {
    if (typeof this.onError !== "function") return;
    try { this.onError(error); } catch {}
  }
}

class MemoryPrefetchTurn {
  constructor(service, options = {}) {
    this.service = service;
    this.memoryStore = options.memoryStore || null;
    this.projectId = `${options.projectId || ""}`;
    this.taskId = `${options.taskId || ""}`;
    this.runId = `${options.runId || ""}`;
    this.turnId = `${options.turnId || ""}`;
    this.signal = options.signal || null;
    this.conversation = normalizeConversation(options.conversation || []);
    this.recentTools = normalizeToolNames(options.recentTools);
    this.shownFiles = new Set(normalizeMemoryFiles(options.shownFiles));
    this.shownThisTurn = new Set();
    this.deliveredFiles = [];
    this.selectedFiles = [];
    this.candidateCount = 0;
    this.status = "pending";
    this.code = "PENDING";
    this.closed = false;
    this.result = null;
    this.completion = Promise.resolve()
      .then(() => service.select(this))
      .then((result) => {
        this.result = result;
        this.selectedFiles = normalizeMemoryFiles(result.selectedFiles);
        this.candidateCount = Array.isArray(result.candidates) ? result.candidates.length : 0;
        this.code = `${result.code || "READY"}`;
        this.status = this.selectedFiles.length ? "ready" : "empty";
        return result;
      })
      .catch((error) => {
        this.status = "failed";
        this.code = `${error?.code || "PREFETCH_FAILED"}`;
        service.reportError(error);
        return null;
      });
  }

  takeReadyContext() {
    if (this.closed || this.status !== "ready" || !this.result) return "";
    const memories = this.result.memories.filter((memory) => !this.shownFiles.has(memory.file));
    const context = renderPrefetchContext(memories);
    if (!context) {
      this.status = "empty";
      this.code = "ALREADY_SHOWN";
      return "";
    }
    this.deliveredFiles = memories.map((memory) => memory.file);
    this.markShown(this.deliveredFiles);
    this.status = "delivered";
    this.code = "DELIVERED";
    return context;
  }

  dynamicReminder() {
    return this.takeReadyContext();
  }

  markShown(files = []) {
    for (const file of normalizeMemoryFiles(files)) {
      this.shownFiles.add(file);
      this.shownThisTurn.add(file);
    }
  }

  close() {
    this.closed = true;
  }

  settled() {
    return this.completion;
  }

  summary() {
    return {
      status: this.status,
      code: this.code,
      candidateCount: this.candidateCount,
      selectedFiles: [...this.selectedFiles],
      deliveredFiles: [...this.deliveredFiles],
      shownFiles: [...this.shownThisTurn],
      recentTools: [...this.recentTools]
    };
  }
}

function normalizeToolNames(value = []) {
  const rows = Array.isArray(value) ? value : [value];
  return [...new Set(rows
    .map((name) => `${name || ""}`.trim())
    .filter((name) => /^[a-z][a-z0-9_]{0,63}$/.test(name)))]
    .slice(-24);
}

function normalizeMemoryFiles(value = []) {
  const rows = Array.isArray(value) ? value : [value];
  return [...new Set(rows
    .map((file) => `${file || ""}`.trim())
    .filter((file) => /^(?:user|feedback|project|reference)-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/.test(file)))]
    .slice(0, 200);
}

module.exports = {
  MemoryPrefetchService,
  MemoryPrefetchTurn,
  PREFETCH_PROMPT_BLOCK,
  normalizeToolNames,
  normalizeMemoryFiles
};
