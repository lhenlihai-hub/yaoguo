// @ts-check

const fsp = require("node:fs/promises");
const { KeyedSerialExecutor } = require("../../shared/keyedSerialExecutor");
const { readJson, writeJsonAtomic, writeTextAtomic } = require("../../shared/fs");
const { estimateTokens } = require("../../tokens/tokenEstimator");
const { serializeContextValue } = require("../../context/agentContextLifecycle");
const { createPromptContractLoader } = require("../promptContractLoader");

const SESSION_MEMORY_PROMPT_BLOCK = "block://memory.session";
const SESSION_MEMORY_HEADINGS = Object.freeze([
  "会话标题",
  "当前工作状态",
  "任务规格",
  "涉及的关键文件和函数",
  "工作流步骤",
  "遇到的错误与修正"
]);
const DEFAULT_SESSION_MEMORY_POLICY = Object.freeze({
  enabled: true,
  minContextTokens: 20000,
  updateDeltaTokens: 12000,
  updateToolCalls: 6,
  compactTriggerTokens: 100000,
  minKeepTokens: 12000,
  maxKeepTokens: 32000,
  maxUpdateInputTokens: 36000,
  maxNoteTokens: 6000
});

class SessionMemoryService {
  constructor({
    aiRouter = null,
    registryService = null,
    taskSessionStore = null,
    settingsService = null,
    clock = () => new Date(),
    onError = null
  } = {}) {
    this.aiRouter = aiRouter;
    this.registryService = registryService;
    this.taskSessionStore = taskSessionStore;
    this.settingsService = settingsService;
    this.clock = clock;
    this.onError = onError;
    this.loadContract = createPromptContractLoader({
      registryService: this.registryService,
      blockId: SESSION_MEMORY_PROMPT_BLOCK,
      reportError: (error) => this.reportError(error)
    });
    this.queue = new KeyedSerialExecutor();
    this.jobs = new Set();
    this.accepting = true;
  }

  async beginTurn(options = {}) {
    const policy = await this.resolvePolicy(options.policy || {});
    const scope = {
      projectId: `${options.projectId || ""}`,
      taskId: `${options.taskId || ""}`,
      runId: `${options.runId || ""}`,
      turnId: `${options.turnId || ""}`
    };
    if (policy.enabled === false || !scope.projectId || !scope.taskId) return null;
    if (!this.taskSessionStore?.resolveSessionMemoryFile) return null;
    const [file, stateFile] = await Promise.all([
      this.taskSessionStore.resolveSessionMemoryFile(scope.projectId, scope.taskId),
      this.taskSessionStore.resolveSessionMemoryStateFile(scope.projectId, scope.taskId)
    ]);
    const [note, state] = await Promise.all([
      readOptionalText(file),
      readJson(stateFile, null).catch(() => null)
    ]);
    return new SessionMemoryTurn(this, {
      ...scope,
      file,
      stateFile,
      note: isValidSessionMemory(note, policy.maxNoteTokens) ? note.trim() : "",
      state,
      policy,
      taskSeed: normalizeTaskSeed(options.taskSeed)
    });
  }

  async resolvePolicy(override = {}) {
    const settings = await this.settingsService?.get?.().catch(() => ({})) || {};
    const configured = settings.context?.sessionMemory || {};
    const merged = { ...DEFAULT_SESSION_MEMORY_POLICY, ...configured, ...override };
    return {
      enabled: merged.enabled !== false,
      minContextTokens: positiveInteger(merged.minContextTokens, 20000),
      updateDeltaTokens: positiveInteger(merged.updateDeltaTokens, 12000),
      updateToolCalls: positiveInteger(merged.updateToolCalls, 6),
      compactTriggerTokens: positiveInteger(merged.compactTriggerTokens, 100000),
      minKeepTokens: positiveInteger(merged.minKeepTokens, 12000),
      maxKeepTokens: Math.max(
        positiveInteger(merged.minKeepTokens, 12000),
        positiveInteger(merged.maxKeepTokens, 32000)
      ),
      maxUpdateInputTokens: positiveInteger(merged.maxUpdateInputTokens, 36000),
      maxNoteTokens: positiveInteger(merged.maxNoteTokens, 6000)
    };
  }

  schedule(turn, snapshot) {
    if (!this.accepting) return Promise.resolve(null);
    const key = `${turn.projectId}::${turn.taskId}`;
    const job = Promise.resolve().then(() => this.queue.run(key, () => this.update(turn, snapshot)));
    this.jobs.add(job);
    job.catch((error) => this.reportError(error)).finally(() => this.jobs.delete(job));
    return job;
  }

  async update(turn, snapshot) {
    const delta = snapshot.messages.slice(snapshot.fromIndex, snapshot.throughIndex);
    if (!delta.length) return { note: turn.note, coveredIndex: snapshot.throughIndex };
    const [contract, latestNote, latestState] = await Promise.all([
      this.loadContract(),
      readOptionalText(turn.file),
      readJson(turn.stateFile, null).catch(() => null)
    ]);
    if (!contract) throw sessionMemoryError("SESSION_MEMORY_PROMPT_UNAVAILABLE", "Session Memory Prompt 不可用。");
    if (!this.aiRouter?.runTaskDetailed) {
      throw sessionMemoryError("AI_ROUTER_UNAVAILABLE", "Session Memory 缺少模型调用能力。");
    }
    const response = await this.aiRouter.runTaskDetailed({
      taskType: "memory",
      title: "Session Memory 后台维护",
      instruction: contract,
      input: JSON.stringify({
        current_date: localDate(this.clock()),
        previous_memory: isValidSessionMemory(latestNote, turn.policy.maxNoteTokens)
          ? latestNote.trim()
          : "",
        task_seed: turn.taskSeed,
        new_messages: renderMessageDelta(delta, turn.policy.maxUpdateInputTokens)
      }),
      contextProfile: "minimal",
      contextBudget: { runContextTokens: 0, inputTokens: 48000 },
      instructionPlacement: "after-input",
      pinnedSections: [],
      internalCall: true,
      thinkingOverride: "disabled",
      maxOutputTokens: 8192,
      projectId: turn.projectId,
      taskId: turn.taskId,
      runId: turn.runId,
      stepId: turn.turnId,
      signal: null
    });
    const note = normalizeSessionMemory(`${response?.content || ""}`, turn.policy.maxNoteTokens);
    const revision = Math.max(0, Number(latestState?.revision) || 0) + 1;
    const updatedAt = this.clock().toISOString();
    await writeTextAtomic(turn.file, `${note}\n`);
    await fsp.chmod(turn.file, 0o600);
    await writeJsonAtomic(turn.stateFile, {
      version: 1,
      revision,
      updatedAt,
      turnId: turn.turnId,
      contextTokens: snapshot.contextTokens,
      toolCallCount: snapshot.toolCallCount
    });
    await fsp.chmod(turn.stateFile, 0o600);
    return { note, coveredIndex: snapshot.throughIndex, revision, updatedAt };
  }


  async drain() {
    while (this.jobs.size) await Promise.allSettled([...this.jobs]);
  }

  async stop() {
    this.accepting = false;
    await this.drain();
  }

  reportError(error) {
    if (typeof this.onError !== "function") return;
    try { this.onError(error); } catch {}
  }
}

class SessionMemoryTurn {
  constructor(service, options = {}) {
    this.service = service;
    Object.assign(this, options);
    this.policy = options.policy || DEFAULT_SESSION_MEMORY_POLICY;
    this.note = `${options.note || ""}`;
    this.state = options.state || null;
    this.coveredIndex = 0;
    this.lastScheduledTokens = 0;
    this.lastScheduledToolCalls = 0;
    this.pending = null;
    this.failedUpdates = 0;
    this.updateCount = 0;
    this.compactionCount = 0;
    this.closed = false;
  }

  observe({ messages = [], contextTokens = 0, toolCallCount = 0 } = {}) {
    if (this.closed || this.pending || !this.shouldUpdate(contextTokens, toolCallCount)) return false;
    this.startUpdate(messages, messages.length, contextTokens, toolCallCount);
    return true;
  }

  shouldUpdate(contextTokens, toolCallCount) {
    if (Number(contextTokens) < this.policy.minContextTokens) return false;
    return Number(contextTokens) - this.lastScheduledTokens >= this.policy.updateDeltaTokens
      || Number(toolCallCount) - this.lastScheduledToolCalls >= this.policy.updateToolCalls;
  }

  startUpdate(messages, throughIndex, contextTokens, toolCallCount) {
    const snapshot = {
      messages: [...messages],
      fromIndex: Math.min(this.coveredIndex, throughIndex),
      throughIndex,
      contextTokens: Math.max(0, Math.floor(Number(contextTokens) || 0)),
      toolCallCount: Math.max(0, Math.floor(Number(toolCallCount) || 0))
    };
    this.lastScheduledTokens = snapshot.contextTokens;
    this.lastScheduledToolCalls = snapshot.toolCallCount;
    const pending = this.service.schedule(this, snapshot)
      .then((result) => {
        if (!result) return null;
        this.note = `${result.note || this.note}`;
        this.coveredIndex = Math.max(this.coveredIndex, Number(result.coveredIndex) || 0);
        this.state = { ...(this.state || {}), ...result };
        this.updateCount += 1;
        return result;
      })
      .catch((error) => {
        this.failedUpdates += 1;
        return null;
      })
      .finally(() => {
        if (this.pending === pending) this.pending = null;
      });
    this.pending = pending;
    return pending;
  }

  async prepareForCompaction({ messages = [], keepIndex = 0, contextTokens = 0, toolCallCount = 0 } = {}) {
    await this.pending;
    void keepIndex;
    const target = messages.length;
    if (this.coveredIndex < target) {
      await this.startUpdate(messages, target, contextTokens, toolCallCount);
    }
    if (!this.note) {
      throw sessionMemoryError("SESSION_MEMORY_UNAVAILABLE", "压缩前没有可用的渐进式 Session Memory。");
    }
    return { note: this.note, coveredIndex: this.coveredIndex };
  }

  markCompacted({
    keptHistoryCount = 0,
    noteCoveredTail = false,
    contextTokens = 0,
    toolCallCount = 0
  } = {}) {
    this.compactionCount += 1;
    this.coveredIndex = noteCoveredTail ? keptHistoryCount : Math.min(1, keptHistoryCount);
    this.lastScheduledTokens = Math.max(0, Number(contextTokens) || 0);
    this.lastScheduledToolCalls = Math.max(0, Number(toolCallCount) || 0);
  }

  close() {
    this.closed = true;
  }

  summary() {
    return {
      status: this.note ? "ready" : (this.failedUpdates ? "failed" : "empty"),
      updates: this.updateCount,
      failedUpdates: this.failedUpdates,
      compactions: this.compactionCount,
      noteTokens: estimateTokens(this.note),
      file: this.note ? "session/memory.md" : ""
    };
  }
}

function renderMessageDelta(messages = [], maxTokens = 36000) {
  const rendered = messages.map((message, index) => renderMessage(message, index)).join("\n\n");
  if (estimateTokens(rendered) <= maxTokens) return rendered;
  let low = 1;
  let high = rendered.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (estimateTokens(headTailText(rendered, middle)) <= maxTokens) low = middle;
    else high = middle - 1;
  }
  return headTailText(rendered, low);
}

function headTailText(text = "", chars = 1) {
  const source = `${text || ""}`;
  const limit = Math.max(1, Math.floor(Number(chars) || 1));
  if (source.length <= limit) return source;
  const marker = "\n…[本次增量中段超出 36000 tokens，精确内容仍在任务会话与工具结果引用中]…\n";
  if (limit <= marker.length + 2) return source.slice(0, limit);
  const available = limit - marker.length;
  const head = Math.max(1, Math.floor(available * 0.62));
  return `${source.slice(0, head)}${marker}${source.slice(-(available - head))}`;
}

function renderMessage(message = {}, index = 0) {
  const role = `${message.role || "unknown"}`;
  const blocks = Array.isArray(message.content) ? message.content : [];
  const content = typeof message.content === "string"
    ? message.content
    : blocks.map((block) => {
      if (block?.type === "text") return `${block.text || ""}`;
      if (block?.type === "toolCall") {
        return `[tool-use ${block.name || ""} ${serializeContextValue(block.arguments || {})}]`;
      }
      return "";
    }).filter(Boolean).join("\n");
  const openAiCalls = Array.isArray(message.tool_calls)
    ? `\n${message.tool_calls.map((call) => (
      `[tool-use ${call?.function?.name || ""} ${call?.function?.arguments || "{}"}]`
    )).join("\n")}`
    : "";
  return `### message ${index + 1} (${role})\n${content}${openAiCalls}`;
}

function normalizeSessionMemory(raw = "", maxTokens = 6000) {
  const note = `${raw || ""}`
    .trim()
    .replace(/^```(?:markdown|md)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  if (!isValidSessionMemory(note, maxTokens)) {
    throw sessionMemoryError("SESSION_MEMORY_FORMAT_INVALID", "Session Memory 输出不符合固定章节或 Token 上限。");
  }
  return note;
}

function isValidSessionMemory(note = "", maxTokens = 6000) {
  if (!`${note || ""}`.trim() || estimateTokens(note) > maxTokens) return false;
  const matches = [...`${note}`.matchAll(/^##\s+(.+?)\s*$/gm)];
  const headings = matches.map((match) => match[1]);
  return headings.length === SESSION_MEMORY_HEADINGS.length
    && headings.every((heading, index) => heading === SESSION_MEMORY_HEADINGS[index])
    && matches.every((match, index) => {
      const start = Number(match.index) + match[0].length;
      const end = index + 1 < matches.length ? Number(matches[index + 1].index) : `${note}`.length;
      return `${note}`.slice(start, end).trim().length > 0;
    });
}

function normalizeTaskSeed(seed = {}) {
  return Object.fromEntries(["title", "instruction", "input", "runContext"].map((key) => {
    const value = `${seed?.[key] || ""}`;
    return [key, value.length <= 4000 ? value : `${value.slice(0, 2000)}\n…\n${value.slice(-2000)}`];
  }));
}

async function readOptionalText(file) {
  try {
    return await fsp.readFile(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}

function positiveInteger(value, fallback) {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function localDate(date) {
  const value = date instanceof Date ? date : new Date(date);
  const year = value.getFullYear();
  const month = `${value.getMonth() + 1}`.padStart(2, "0");
  const day = `${value.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function sessionMemoryError(code, message) {
  return Object.assign(new Error(message), { code });
}

module.exports = {
  DEFAULT_SESSION_MEMORY_POLICY,
  SESSION_MEMORY_HEADINGS,
  SESSION_MEMORY_PROMPT_BLOCK,
  SessionMemoryService,
  SessionMemoryTurn,
  isValidSessionMemory,
  normalizeSessionMemory,
  renderMessageDelta
};
