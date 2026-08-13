// @ts-check

const crypto = require("node:crypto");
const { KeyedSerialExecutor } = require("../../shared/keyedSerialExecutor");
const { runToolLoop } = require("../../ai/agentLoop/agentLoop");
const { normalizeConversation } = require("../prefetch/memoryPrefetchFormat");
const { createMemoryExtractionToolRegistry } = require("./memoryExtractionTools");
const { agentMemoryContext } = require("../memdir/agentMemoryProfile");
const { createPromptContractLoader } = require("../promptContractLoader");

const MEMORY_EXTRACTION_PROMPT_BLOCK = "block://memory.extract";
const MEMORY_EXTRACTION_CURSOR_TYPE = "memory.extraction.cursor";
const MAX_MEMORY_EXTRACTION_ROUNDS = 5;
const EXTRACTION_MESSAGE_WINDOW = 80;

class MemoryExtractionService {
  constructor({
    aiRouter = null,
    registryService = null,
    memoryStore = null,
    projectService = null,
    taskSessionStore = null,
    autoDreamService = null,
    clock = () => new Date(),
    onError = null
  } = {}) {
    this.aiRouter = aiRouter;
    this.registryService = registryService;
    this.memoryStore = memoryStore;
    this.projectService = projectService;
    this.taskSessionStore = taskSessionStore;
    this.autoDreamService = autoDreamService;
    this.clock = clock;
    this.onError = onError;
    this.loadContract = createPromptContractLoader({
      registryService: this.registryService,
      blockId: MEMORY_EXTRACTION_PROMPT_BLOCK,
      reportError: (error) => this.reportError(error)
    });
    this.queue = new KeyedSerialExecutor();
    this.jobs = new Map();
    this.accepting = true;
  }

  scheduleTurn(options = {}) {
    const job = new MemoryExtractionJob(this, options);
    if (!this.accepting) {
      job.completion = Promise.resolve(job.complete({ status: "skipped", code: "SERVICE_STOPPED" }));
      return job;
    }
    const key = `${job.projectId}::${job.taskId}`;
    this.jobs.set(job.id, job);
    job.completion = Promise.resolve()
      .then(() => this.queue.run(key, () => this.process(job)))
      .then((result) => job.complete(result))
      .catch(async (error) => {
        this.reportError(error);
        await this.recordFailure(job, error).catch(() => null);
        return job.fail(error);
      })
      .finally(() => {
        if (this.jobs.get(job.id) === job) this.jobs.delete(job.id);
      });
    return job;
  }

  async drain() {
    while (this.jobs.size) {
      await Promise.allSettled([...this.jobs.values()].map((job) => job.settled()));
    }
  }

  async stop() {
    this.accepting = false;
    await this.drain();
  }

  async process(job) {
    this.assertReady(job);
    const existing = await this.taskSessionStore.findEvent({
      projectId: job.projectId,
      taskId: job.taskId,
      eventId: job.cursorEventId
    });
    if (existing) {
      return { status: "skipped", code: "ALREADY_PROCESSED", cursor: existing };
    }
    if (job.memoryWritePerformed) {
      const cursor = await this.advanceCursor(job, {
        status: "skipped_main_memory_write",
        code: "MAIN_MEMORY_WRITE"
      });
      this.scheduleAutoDream(job);
      return { status: "skipped", code: "MAIN_MEMORY_WRITE", cursor };
    }
    const loaded = await this.loadConversation(job);
    if (loaded.covered) {
      return { status: "skipped", code: "CURSOR_ALREADY_AHEAD" };
    }
    const conversation = loaded.conversation;
    if (!conversation.length) {
      const cursor = await this.advanceCursor(job, { status: "empty", code: "NO_CONVERSATION" });
      return { status: "empty", code: "NO_CONVERSATION", cursor };
    }
    this.assertAgentReady();
    const memoryStore = await this.resolveMemoryStore(job);
    await memoryStore.ensure();
    const [location, topics, contract] = await Promise.all([
      memoryStore.info(),
      memoryStore.scanPrefetchMetadata(),
      this.loadContract()
    ]);
    if (!contract) throw extractionError("MEMORY_EXTRACTION_PROMPT_UNAVAILABLE", "Extract Memories Prompt 不可用。");
    const extraction = createMemoryExtractionToolRegistry({
      memoryStore,
      memoryDirectory: location.memoryDirectory,
      storageMode: location.storageMode || "indexed",
      existingFiles: topics.map((topic) => topic.file)
    });
    const result = await this.runAgent({
      job,
      conversation,
      memoryDirectory: location.memoryDirectory,
      memoryMode: location.storageMode || "indexed",
      memoryLogPattern: location.logPathPattern || "",
      topics,
      contract,
      extraction
    });
    const toolSummary = extraction.state.summary();
    const failedWrites = result.toolCalls.filter((call) => (
      call?.name === "write_memory" && call?.ok !== true
    ));
    if (failedWrites.length) {
      const codes = [...new Set(failedWrites.map((call) => `${call?.code || "TOOL_FAILED"}`))];
      throw extractionError(
        "MEMORY_EXTRACTION_WRITE_INCOMPLETE",
        `至少一条后台记忆写入没有成功：${codes.join(", ")}`
      );
    }
    if (result.aborted) throw extractionError("MEMORY_EXTRACTION_ABORTED", "Extract Memories 已中止。");
    if (result.exhausted && !toolSummary.writtenFiles.length) {
      throw extractionError("MEMORY_EXTRACTION_ROUND_LIMIT", "Extract Memories 在 5 轮内没有完成判断。");
    }
    if (!toolSummary.writtenFiles.length && !`${result.text || ""}`.trim()) {
      throw extractionError("MEMORY_EXTRACTION_EMPTY_RESULT", "Extract Memories 没有返回决定。");
    }
    const status = toolSummary.writtenFiles.length ? "written" : "empty";
    const code = toolSummary.writtenFiles.length ? "MEMORIES_WRITTEN" : "NO_MEMORY";
    const cursor = await this.advanceCursor(job, {
      status,
      code,
      rounds: result.rounds,
      writtenFiles: toolSummary.writtenFiles,
      readFiles: toolSummary.readFiles
    });
    if (toolSummary.writtenFiles.length) {
      this.scheduleAutoDream(job, memoryStore, toolSummary.writtenFiles);
    }
    return {
      status,
      code,
      rounds: result.rounds,
      writtenFiles: toolSummary.writtenFiles,
      cursor
    };
  }

  async runAgent({
    job,
    conversation,
    memoryDirectory,
    memoryMode,
    memoryLogPattern,
    topics,
    contract,
    extraction
  }) {
    return runToolLoop({
      aiRouter: this.aiRouter,
      registry: extraction.registry,
      toolNames: ["read", "grep", "write_memory"],
      baseToolNames: [],
      toolCtx: {
        agentWorkDir: memoryDirectory,
        agentScopeAllow: [memoryDirectory],
        agentReadScopeAllow: [memoryDirectory],
        agentWriteScopeAllow: [memoryDirectory],
        memoryExtraction: true,
        untrustedToolNames: new Set(["read", "grep"])
      },
      runTaskArgs: {
        taskType: "memory",
        title: "Extract Memories 后台 Agent",
        instruction: contract,
        input: JSON.stringify({
          current_date: localDate(this.clock()),
          conversation,
          memory_index: topics.map(topicMetadata),
          memory_cwd: ".",
          memory_mode: memoryMode,
          memory_log_pattern: memoryLogPattern
        }),
        runContext: "",
        pinnedSections: [],
        contextProfile: "minimal",
        contextBudget: { runContextTokens: 0, inputTokens: 32000 },
        internalCall: true,
        thinkingOverride: "disabled",
        maxOutputTokens: 4096,
        projectId: job.projectId,
        taskId: job.taskId,
        runId: job.runId,
        stepId: job.turnId,
        signal: null
      },
      maxRounds: MAX_MEMORY_EXTRACTION_ROUNDS,
      maxAgentModelCalls: MAX_MEMORY_EXTRACTION_ROUNDS,
      requireToolAuthorization: false,
      requireResolvedArtifacts: false,
      onRound: (round, calls) => extraction.state.beginRound(round, calls)
    });
  }

  async loadConversation(job) {
    const [window, cursor] = await Promise.all([
      this.taskSessionStore.listMessages({
        projectId: job.projectId,
        taskId: job.taskId,
        limit: EXTRACTION_MESSAGE_WINDOW
      }),
      this.taskSessionStore.findLatestEvent({
        projectId: job.projectId,
        taskId: job.taskId,
        type: MEMORY_EXTRACTION_CURSOR_TYPE
      })
    ]);
    const covered = cursorCoversMessage(window, cursor, job);
    const rows = sliceThroughCurrentMessage(
      window,
      `${cursor?.lastMessageEventId || ""}`,
      job.assistantEventId,
      job.turnId
    );
    return {
      covered,
      conversation: covered ? [] : normalizeConversation(rows.map((row) => ({
        role: row.role,
        content: `${row.content || ""}`
      })))
    };
  }

  async resolveMemoryStore(job) {
    if (job.memoryStore?.append) return job.memoryStore;
    if (!this.memoryStore?.forContext) {
      throw extractionError("MEMORY_STORE_UNAVAILABLE", "Extract Memories 缺少长期记忆存储。");
    }
    const task = await this.projectService?.getTask?.(job.projectId, job.taskId, false).catch(() => null);
    let workspaceRoot = `${task?.workspacePath || ""}`.trim();
    if (workspaceRoot && typeof this.projectService?.resolveTaskWorkspace === "function") {
      const resolved = await this.projectService.resolveTaskWorkspace(job.projectId, job.taskId);
      workspaceRoot = `${resolved?.workspacePath || workspaceRoot}`;
    }
    if (!workspaceRoot && typeof this.projectService?.getProjectDir === "function") {
      workspaceRoot = this.projectService.getProjectDir(job.projectId);
    }
    if (!workspaceRoot) throw extractionError("MEMORY_CONTEXT_UNAVAILABLE", "无法确定 Extract Memories 的 canonical workspace。");
    return this.memoryStore.forContext({
      workspaceRoot,
      ...agentMemoryContext(task?.agentMemory || {})
    });
  }

  async advanceCursor(job, metadata = {}) {
    return this.taskSessionStore.appendEvent({
      eventId: job.cursorEventId,
      type: MEMORY_EXTRACTION_CURSOR_TYPE,
      version: 1,
      projectId: job.projectId,
      taskId: job.taskId,
      runId: job.runId,
      turnId: job.turnId,
      source: "memory-extraction",
      lastMessageEventId: job.assistantEventId,
      lastMessageCreatedAt: safeIsoTimestamp(job.assistantCreatedAt),
      status: safeStatus(metadata.status),
      code: safeCode(metadata.code),
      rounds: nonNegativeInteger(metadata.rounds),
      writtenFiles: normalizeMemoryFiles(metadata.writtenFiles).slice(0, 200),
      readFiles: normalizeMemoryFiles(metadata.readFiles).slice(0, 200),
      mainMemoryWrite: job.memoryWritePerformed
    }, { deduplicate: true });
  }

  async recordFailure(job, error) {
    if (!job.projectId || !job.taskId || !this.taskSessionStore?.appendEvent) return null;
    return this.taskSessionStore.appendEvent({
      eventId: `memory-extraction-failure:${job.id}`,
      type: "memory.extraction.failed",
      version: 1,
      projectId: job.projectId,
      taskId: job.taskId,
      runId: job.runId,
      turnId: job.turnId,
      source: "memory-extraction",
      lastMessageEventId: job.assistantEventId,
      status: "failed",
      code: safeCode(error?.code || "MEMORY_EXTRACTION_FAILED")
    }, { deduplicate: true });
  }

  scheduleAutoDream(job, memoryStore = null, writtenFiles = []) {
    if (typeof this.autoDreamService?.scheduleMemoryWrite !== "function") return null;
    try {
      return this.autoDreamService.scheduleMemoryWrite({
        projectId: job.projectId,
        taskId: job.taskId,
        runId: job.runId,
        turnId: job.turnId,
        eventId: job.assistantEventId,
        sessionId: `${job.projectId}::${job.taskId}`,
        writtenFiles,
        memoryStore: memoryStore || job.memoryStore || null
      });
    } catch {
      return null;
    }
  }


  assertReady(job) {
    if (!job.projectId || !job.taskId || !job.turnId || !job.assistantEventId) {
      throw extractionError("MEMORY_EXTRACTION_SCOPE_INVALID", "Extract Memories 缺少任务或消息游标。");
    }
    if (!this.taskSessionStore?.findEvent || !this.taskSessionStore?.appendEvent) {
      throw extractionError("TASK_SESSION_UNAVAILABLE", "Extract Memories 缺少任务会话存储。");
    }
  }

  assertAgentReady() {
    if (!this.aiRouter?.runTaskDetailed || !this.aiRouter?.continueTaskDetailed) {
      throw extractionError("AI_ROUTER_UNAVAILABLE", "Extract Memories 缺少 Agent 模型调用能力。");
    }
  }

  reportError(error) {
    if (typeof this.onError !== "function") return;
    try { this.onError(error); } catch {}
  }
}

class MemoryExtractionJob {
  constructor(service, options = {}) {
    this.service = service;
    this.projectId = `${options.projectId || ""}`;
    this.taskId = `${options.taskId || ""}`;
    this.runId = `${options.runId || ""}`;
    this.turnId = `${options.turnId || ""}`;
    this.assistantEventId = `${options.assistantEventId || (this.turnId ? `assistant:${this.turnId}` : "")}`;
    this.assistantCreatedAt = `${options.assistantCreatedAt || ""}`;
    this.memoryWritePerformed = options.memoryWritePerformed === true;
    this.memoryStore = options.memoryStore || null;
    this.id = extractionJobId(this.projectId, this.taskId, this.turnId);
    this.cursorEventId = `memory-extraction:${this.id}`;
    this.status = "pending";
    this.code = "PENDING";
    this.result = null;
    this.completion = Promise.resolve(null);
  }

  complete(result = {}) {
    this.result = result;
    this.status = `${result.status || "completed"}`;
    this.code = `${result.code || "COMPLETED"}`;
    return result;
  }

  fail(error) {
    this.status = "failed";
    this.code = `${error?.code || "MEMORY_EXTRACTION_FAILED"}`;
    this.result = { status: this.status, code: this.code, error: `${error?.message || error}` };
    return this.result;
  }

  settled() {
    return this.completion;
  }

  summary() {
    return {
      status: this.status,
      code: this.code,
      writtenFiles: normalizeMemoryFiles(this.result?.writtenFiles)
    };
  }
}

function sliceThroughCurrentMessage(rows = [], previousEventId = "", assistantEventId = "", turnId = "") {
  const source = (Array.isArray(rows) ? rows : [])
    .filter((row) => ["user", "assistant"].includes(row?.role));
  let end = source.findIndex((row) => row?.eventId === assistantEventId);
  if (end < 0) end = source.findIndex((row) => row?.role === "assistant" && row?.turnId === turnId);
  if (end < 0) end = source.length - 1;
  let start = previousEventId
    ? source.findIndex((row) => row?.eventId === previousEventId) + 1
    : Math.max(0, end - 19);
  if (start <= 0 && previousEventId && !source.some((row) => row?.eventId === previousEventId)) {
    start = Math.max(0, end - 19);
  }
  return end >= start ? source.slice(start, end + 1) : [];
}

function cursorCoversMessage(rows = [], cursor = null, job = {}) {
  const lastEventId = `${cursor?.lastMessageEventId || ""}`;
  if (!lastEventId) return false;
  if (lastEventId === `${job.assistantEventId || ""}`) return true;
  const source = (Array.isArray(rows) ? rows : [])
    .filter((row) => ["user", "assistant"].includes(row?.role));
  const cursorIndex = source.findIndex((row) => row?.eventId === lastEventId);
  let currentIndex = source.findIndex((row) => row?.eventId === job.assistantEventId);
  if (currentIndex < 0) {
    currentIndex = source.findIndex((row) => row?.role === "assistant" && row?.turnId === job.turnId);
  }
  if (cursorIndex >= 0 && currentIndex >= 0) return cursorIndex >= currentIndex;
  const cursorTime = safeIsoTimestamp(cursor?.lastMessageCreatedAt);
  const currentTime = safeIsoTimestamp(job.assistantCreatedAt);
  return Boolean(cursorTime && currentTime && cursorTime >= currentTime);
}

function topicMetadata(topic = {}) {
  return {
    file: `${topic.file || ""}`,
    type: `${topic.type || ""}`,
    name: `${topic.name || ""}`,
    description: `${topic.description || ""}`
  };
}

function extractionJobId(projectId = "", taskId = "", turnId = "") {
  return crypto.createHash("sha256")
    .update(`${projectId}\0${taskId}\0${turnId}`, "utf8")
    .digest("hex")
    .slice(0, 24);
}

function localDate(date = new Date()) {
  const value = date instanceof Date ? date : new Date(date);
  return [
    value.getFullYear(),
    `${value.getMonth() + 1}`.padStart(2, "0"),
    `${value.getDate()}`.padStart(2, "0")
  ].join("-");
}

function normalizeMemoryFiles(values = []) {
  return [...new Set((Array.isArray(values) ? values : [values])
    .map((value) => `${value || ""}`.trim())
    .filter((value) => /^(?:user|feedback|project|reference)-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/.test(value)))];
}

function safeStatus(value = "") {
  const status = `${value || ""}`;
  return /^[a-z][a-z0-9_]{0,63}$/.test(status) ? status : "completed";
}

function safeCode(value = "") {
  const code = `${value || ""}`.toUpperCase();
  return /^[A-Z][A-Z0-9_]{0,95}$/.test(code) ? code : "MEMORY_EXTRACTION_COMPLETED";
}

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function safeIsoTimestamp(value = "") {
  const source = `${value || ""}`.trim();
  return source && Number.isFinite(Date.parse(source)) ? new Date(source).toISOString() : "";
}

function extractionError(code, message) {
  return Object.assign(new Error(message), { code });
}

module.exports = {
  MemoryExtractionService,
  MemoryExtractionJob,
  MEMORY_EXTRACTION_PROMPT_BLOCK,
  MEMORY_EXTRACTION_CURSOR_TYPE,
  MAX_MEMORY_EXTRACTION_ROUNDS,
  sliceThroughCurrentMessage,
  cursorCoversMessage,
  extractionJobId
};
