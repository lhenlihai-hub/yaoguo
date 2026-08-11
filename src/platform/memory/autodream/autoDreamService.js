// @ts-check

const crypto = require("node:crypto");
const { KeyedSerialExecutor } = require("../../shared/keyedSerialExecutor");
const { runToolLoop } = require("../../ai/agentLoop/agentLoop");
const {
  AutoDreamStateStore,
  AUTO_DREAM_MIN_INTERVAL_MS,
  AUTO_DREAM_MIN_SESSIONS,
  AUTO_DREAM_APPEND_ONLY_MIN_SESSIONS
} = require("./autoDreamState");
const { createAutoDreamToolRegistry } = require("./autoDreamTools");
const { agentMemoryContext } = require("../memdir/agentMemoryProfile");

const AUTO_DREAM_PROMPT_BLOCK = "block://memory.autodream";
const MAX_AUTO_DREAM_ROUNDS = 12;
const MAX_AUTO_DREAM_TRANSCRIPTS = 20;

class AutoDreamService {
  constructor({
    aiRouter = null,
    registryService = null,
    memoryStore = null,
    projectService = null,
    taskSessionStore = null,
    clock = () => new Date(),
    pid = process.pid,
    stateStoreFactory = null,
    onError = null
  } = {}) {
    this.aiRouter = aiRouter;
    this.registryService = registryService;
    this.memoryStore = memoryStore;
    this.projectService = projectService;
    this.taskSessionStore = taskSessionStore;
    this.clock = clock;
    this.pid = pid;
    this.stateStoreFactory = stateStoreFactory;
    this.onError = onError;
    this.contractPromise = null;
    this.queue = new KeyedSerialExecutor();
    this.jobs = new Map();
    this.accepting = true;
    this.nightlyTimer = null;
  }

  scheduleMemoryWrite(options = {}) {
    const job = new AutoDreamJob(options);
    if (!this.accepting) {
      job.completion = Promise.resolve(job.complete({ status: "skipped", code: "SERVICE_STOPPED" }));
      return job;
    }
    this.jobs.set(job.id, job);
    job.completion = Promise.resolve()
      .then(async () => {
        const memoryStore = await this.resolveMemoryStore(job);
        const info = await memoryStore.info();
        return this.queue.run(info.memoryDirectory, () => this.process(job, memoryStore, info));
      })
      .then((result) => job.complete(result))
      .catch(async (error) => {
        this.reportError(error);
        await this.recordAudit(job, {
          status: "failed",
          code: `${error?.code || "AUTODREAM_FAILED"}`
        }).catch(() => null);
        return job.fail(error);
      })
      .finally(() => {
        if (this.jobs.get(job.id) === job) this.jobs.delete(job.id);
      });
    return job;
  }

  scheduleNightly(options = {}) {
    return this.scheduleMemoryWrite({
      ...options,
      trigger: "nightly",
      eventId: options.eventId || `nightly:${localDate(this.clock())}`
    });
  }

  async drain() {
    while (this.jobs.size) {
      await Promise.allSettled([...this.jobs.values()].map((job) => job.settled()));
    }
  }

  async stop() {
    this.accepting = false;
    if (this.nightlyTimer) clearTimeout(this.nightlyTimer);
    this.nightlyTimer = null;
    await this.drain();
  }

  startNightly({ hour = 2 } = {}) {
    if (this.nightlyTimer || !this.accepting) return false;
    this.runNightlySweep().catch((error) => this.reportError(error));
    this.scheduleNextNightly(hour);
    return true;
  }

  scheduleNextNightly(hour = 2) {
    if (!this.accepting) return;
    const delay = nextNightlyDelay(this.clock(), hour);
    this.nightlyTimer = setTimeout(() => {
      this.nightlyTimer = null;
      this.runNightlySweep()
        .catch((error) => this.reportError(error))
        .finally(() => this.scheduleNextNightly(hour));
    }, delay);
    this.nightlyTimer.unref?.();
  }

  async runNightlySweep() {
    if (!this.projectService?.listProjects || !this.projectService?.listTasks) return { scheduled: 0 };
    const projects = await this.projectService.listProjects().catch(() => []);
    const seen = new Set();
    let scheduled = 0;
    for (const project of projects) {
      const tasks = await this.projectService.listTasks(project.id).catch(() => []);
      for (const task of tasks) {
        if (task?.agentMemory?.mode !== "append-only") continue;
        const memoryStore = await this.resolveMemoryStore({
          projectId: project.id,
          taskId: task.id,
          memoryStore: null
        }).catch(() => null);
        if (!memoryStore) continue;
        const [info, snapshot] = await Promise.all([
          memoryStore.info(),
          memoryStore.createReshapeSnapshot()
        ]).catch(() => []);
        if (!info?.memoryDirectory || !snapshot?.logs?.length || seen.has(info.memoryDirectory)) continue;
        seen.add(info.memoryDirectory);
        this.scheduleNightly({
          projectId: project.id,
          taskId: task.id,
          sessionId: `${project.id}::${task.id}`,
          memoryStore
        });
        scheduled += 1;
      }
    }
    return { scheduled };
  }

  async process(job, memoryStore, info) {
    this.assertReady(job, memoryStore, info);
    if (job.trigger === "nightly" && info.storageMode !== "append-only") {
      return { status: "skipped", code: "NIGHTLY_APPEND_ONLY_REQUIRED" };
    }
    await memoryStore.ensure();
    const minSessions = info.storageMode === "append-only"
      ? AUTO_DREAM_APPEND_ONLY_MIN_SESSIONS
      : AUTO_DREAM_MIN_SESSIONS;
    const stateStore = this.createStateStore(info.memoryDirectory, minSessions);
    await stateStore.recordSession({
      sessionId: job.sessionId,
      projectId: job.projectId,
      taskId: job.taskId,
      writtenFiles: job.writtenFiles
    });
    if (info.storageMode === "append-only" && job.trigger !== "nightly") {
      return {
        status: "skipped",
        code: "NIGHTLY_DREAM_PENDING",
        sessionCount: 1
      };
    }
    const lease = await stateStore.acquire();
    if (!lease.acquired) {
      return {
        status: "skipped",
        code: lease.code,
        sessionCount: lease.sessionCount || 0,
        elapsedMs: lease.elapsedMs || 0
      };
    }
    try {
      this.assertAgentReady();
      const [contract, snapshot, transcripts] = await Promise.all([
        this.loadContract(),
        memoryStore.createReshapeSnapshot(),
        this.prepareTranscripts(lease.signals)
      ]);
      if (!contract) throw autoDreamError("AUTODREAM_PROMPT_UNAVAILABLE", "AutoDream Prompt 不可用。");
      const tools = createAutoDreamToolRegistry({
        memoryStore,
        snapshot,
        canonicalRoot: info.canonicalRoot,
        transcripts,
        guard: () => stateStore.owns(lease),
        completeLease: () => stateStore.complete(lease),
        clock: this.clock
      });
      const result = await this.runAgent({ job, contract, tools, info, lease });
      const summary = tools.state.summary();
      if (!summary.finished) {
        const code = result.aborted
          ? "AUTODREAM_ABORTED"
          : (result.exhausted ? "AUTODREAM_ROUND_LIMIT" : "AUTODREAM_INCOMPLETE");
        throw autoDreamError(code, "AutoDream 没有完成 Prune and Index 提交。");
      }
      const completed = {
        status: "completed",
        code: "AUTODREAM_COMPLETED",
        rounds: result.rounds,
        sessionCount: lease.sessionCount,
        replacedFiles: summary.commit?.replacedFiles || [],
        createdFiles: summary.commit?.createdFiles || [],
        deletedFiles: summary.commit?.deletedFiles || [],
        completedAt: summary.commit?.completedAt || ""
      };
      await this.recordAudit(job, completed).catch(() => null);
      return completed;
    } catch (error) {
      await stateStore.rollback(lease).catch(() => null);
      throw error;
    }
  }

  async runAgent({ job, contract, tools, info, lease }) {
    return runToolLoop({
      aiRouter: this.aiRouter,
      registry: tools.registry,
      toolNames: tools.registry.list().map((tool) => tool.schema.function.name),
      baseToolNames: [],
      toolCtx: {
        agentWorkDir: info.memoryDirectory,
        agentScopeAllow: [info.memoryDirectory],
        agentReadScopeAllow: [info.memoryDirectory, info.canonicalRoot],
        agentWriteScopeAllow: [info.memoryDirectory],
        autoDream: true,
        untrustedToolNames: new Set([
          "orient", "read_memory", "read_log", "read_repository", "read_transcript", "exact_search"
        ])
      },
      runTaskArgs: {
        taskType: "memory",
        title: "AutoDream 离线整合 Agent",
        instruction: contract,
        input: JSON.stringify({
          current_date: localDate(this.clock()),
          memory_cwd: ".",
          memory_mode: info.storageMode || "indexed",
          memory_log_pattern: info.logPathPattern || "",
          repository: "repository://canonical-root",
          new_memory_sessions: lease.sessionCount,
          time_gate_hours: AUTO_DREAM_MIN_INTERVAL_MS / 3600000,
          session_gate: lease.minSessions || AUTO_DREAM_MIN_SESSIONS
        }),
        runContext: "",
        pinnedSections: [],
        contextProfile: "minimal",
        contextBudget: { runContextTokens: 0, inputTokens: 32000 },
        internalCall: true,
        thinkingOverride: "high",
        maxOutputTokens: 8192,
        projectId: job.projectId,
        taskId: job.taskId,
        runId: job.runId,
        stepId: job.turnId,
        signal: null
      },
      maxRounds: MAX_AUTO_DREAM_ROUNDS,
      maxAgentModelCalls: MAX_AUTO_DREAM_ROUNDS,
      requireToolAuthorization: false,
      requireResolvedArtifacts: false,
      onRound: (round, calls) => tools.state.beginRound(round, calls)
    });
  }

  async prepareTranscripts(signals = []) {
    if (!this.taskSessionStore?.externalizeHistory) return [];
    const rows = [];
    for (const signal of (Array.isArray(signals) ? signals : []).slice(0, MAX_AUTO_DREAM_TRANSCRIPTS)) {
      if (!signal.projectId || !signal.taskId) continue;
      const stored = await this.taskSessionStore.externalizeHistory({
        projectId: signal.projectId,
        taskId: signal.taskId
      }).catch(() => null);
      if (!stored?.absolute) continue;
      rows.push({
        id: `session-${rows.length + 1}`,
        file: stored.absolute,
        recordedAt: `${signal.recordedAt || ""}`
      });
    }
    return rows;
  }

  async resolveMemoryStore(job) {
    if (job.memoryStore?.createReshapeSnapshot) return job.memoryStore;
    if (!this.memoryStore?.forContext) {
      throw autoDreamError("MEMORY_STORE_UNAVAILABLE", "AutoDream 缺少长期记忆存储。");
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
    if (!workspaceRoot) throw autoDreamError("MEMORY_CONTEXT_UNAVAILABLE", "无法确定 AutoDream 的 canonical workspace。");
    return this.memoryStore.forContext({
      workspaceRoot,
      ...agentMemoryContext(task?.agentMemory || {})
    });
  }

  createStateStore(memoryDirectory, minSessions = AUTO_DREAM_MIN_SESSIONS) {
    if (typeof this.stateStoreFactory === "function") {
      return this.stateStoreFactory({ memoryDirectory, clock: this.clock, pid: this.pid, minSessions });
    }
    return new AutoDreamStateStore({ memoryDirectory, clock: this.clock, pid: this.pid, minSessions });
  }

  async loadContract() {
    if (!this.registryService?.getPromptBlock) return "";
    if (!this.contractPromise) {
      this.contractPromise = this.registryService
        .getPromptBlock(AUTO_DREAM_PROMPT_BLOCK, { required: true })
        .then((row) => `${row?.asset?.content || ""}`.trim())
        .catch((error) => {
          this.contractPromise = null;
          this.reportError(error);
          return "";
        });
    }
    return this.contractPromise;
  }

  async recordAudit(job, result = {}) {
    if (!this.taskSessionStore?.appendEvent || !job.projectId || !job.taskId) return null;
    return this.taskSessionStore.appendEvent({
      eventId: `memory-autodream:${job.id}:${safeCode(result.code)}`,
      type: result.status === "failed" ? "memory.autodream.failed" : "memory.autodream.completed",
      version: 1,
      projectId: job.projectId,
      taskId: job.taskId,
      runId: job.runId,
      turnId: job.turnId,
      source: "memory-autodream",
      status: `${result.status || ""}`,
      code: safeCode(result.code),
      sessionCount: nonNegativeInteger(result.sessionCount),
      replacedFiles: normalizeMemoryFiles(result.replacedFiles),
      createdFiles: normalizeMemoryFiles(result.createdFiles),
      deletedFiles: normalizeMemoryFiles(result.deletedFiles)
    }, { deduplicate: true });
  }

  assertReady(job, memoryStore, info) {
    if (!job.projectId || !job.taskId || !job.sessionId) {
      throw autoDreamError("AUTODREAM_SCOPE_INVALID", "AutoDream 缺少会话作用域。");
    }
    if (!memoryStore?.ensure || !memoryStore?.createReshapeSnapshot || !memoryStore?.applyReshape) {
      throw autoDreamError("MEMORY_STORE_UNAVAILABLE", "当前 Memdir 不支持离线整合。");
    }
    if (!info?.memoryDirectory || !info?.canonicalRoot) {
      throw autoDreamError("MEMORY_CONTEXT_UNAVAILABLE", "AutoDream 缺少 canonical Memdir 信息。");
    }
  }

  assertAgentReady() {
    if (!this.aiRouter?.runTaskDetailed || !this.aiRouter?.continueTaskDetailed) {
      throw autoDreamError("AI_ROUTER_UNAVAILABLE", "AutoDream 缺少 Agent 模型调用能力。");
    }
  }

  reportError(error) {
    if (typeof this.onError !== "function") return;
    try { this.onError(error); } catch {}
  }
}

class AutoDreamJob {
  constructor(options = {}) {
    this.projectId = `${options.projectId || ""}`;
    this.taskId = `${options.taskId || ""}`;
    this.runId = `${options.runId || ""}`;
    this.turnId = `${options.turnId || ""}`;
    this.sessionId = `${options.sessionId || `${this.projectId}::${this.taskId}`}`;
    this.writtenFiles = normalizeMemoryFiles(options.writtenFiles);
    this.memoryStore = options.memoryStore || null;
    this.trigger = options.trigger === "nightly" ? "nightly" : "memory-write";
    this.id = jobId(this.projectId, this.taskId, this.turnId, options.eventId);
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
    this.code = `${error?.code || "AUTODREAM_FAILED"}`;
    this.result = { status: this.status, code: this.code, error: `${error?.message || error}` };
    return this.result;
  }

  settled() {
    return this.completion;
  }

  summary() {
    return { status: this.status, code: this.code };
  }
}

function jobId(projectId, taskId, turnId, eventId = "") {
  return crypto.createHash("sha256")
    .update(`${projectId}\0${taskId}\0${turnId}\0${eventId}`, "utf8")
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

function nextNightlyDelay(value = new Date(), hour = 2) {
  const now = value instanceof Date ? new Date(value) : new Date(value);
  const safeNow = Number.isFinite(now.getTime()) ? now : new Date();
  const targetHour = Math.max(0, Math.min(23, Math.floor(Number(hour) || 0)));
  const next = new Date(safeNow);
  next.setHours(targetHour, 0, 0, 0);
  if (next <= safeNow) next.setDate(next.getDate() + 1);
  return Math.max(1000, next.getTime() - safeNow.getTime());
}

function normalizeMemoryFiles(values = []) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => `${value || ""}`.trim())
    .filter((value) => /^(?:user|feedback|project|reference)-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/.test(value)))];
}

function safeCode(value = "") {
  const code = `${value || ""}`.toUpperCase();
  return /^[A-Z][A-Z0-9_]{0,95}$/.test(code) ? code : "AUTODREAM_COMPLETED";
}

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function autoDreamError(code, message) {
  return Object.assign(new Error(message), { code });
}

module.exports = {
  AutoDreamService,
  AutoDreamJob,
  AUTO_DREAM_PROMPT_BLOCK,
  MAX_AUTO_DREAM_ROUNDS,
  MAX_AUTO_DREAM_TRANSCRIPTS,
  nextNightlyDelay,
  jobId
};
