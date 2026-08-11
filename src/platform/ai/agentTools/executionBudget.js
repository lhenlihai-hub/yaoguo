// @ts-check

class AgentExecutionBudget {
  /**
   * @param {{
   *   maxModelCalls?: number,
   *   maxToolCalls?: number,
   *   wallClockMs?: number,
   *   signal?: AbortSignal | null,
   *   now?: () => number
   * }} [options]
   */
  constructor(options = {}) {
    this.maxModelCalls = positiveLimit(options.maxModelCalls, Number.POSITIVE_INFINITY);
    this.maxToolCalls = positiveLimit(options.maxToolCalls, Number.POSITIVE_INFINITY);
    this.wallClockMs = positiveLimit(options.wallClockMs, Number.POSITIVE_INFINITY);
    this.startedAt = typeof options.now === "function" ? options.now() : Date.now();
    this.deadlineAt = Number.isFinite(this.wallClockMs)
      ? this.startedAt + this.wallClockMs
      : Number.POSITIVE_INFINITY;
    this.now = typeof options.now === "function" ? options.now : Date.now;
    this.modelCalls = 0;
    this.toolCalls = 0;
    this.signal = combineAbortSignals(options.signal || null, this.wallClockMs);
  }

  /** @param {"model" | "tool"} kind @param {number} [count] */
  claim(kind, count = 1) {
    const health = this.check();
    if (!health.ok) return health;
    const amount = positiveInteger(count, 1);
    const key = kind === "model" ? "modelCalls" : "toolCalls";
    const limit = kind === "model" ? this.maxModelCalls : this.maxToolCalls;
    if (Number.isFinite(limit) && this[key] + amount > limit) {
      return budgetFailure(
        kind === "model" ? "AGENT_MODEL_BUDGET_EXCEEDED" : "AGENT_TOOL_BUDGET_EXCEEDED",
        kind === "model" ? "Agent 模型调用预算已满。" : "Agent 工具执行预算已满。"
      );
    }
    this[key] += amount;
    return { ok: true, remaining: limit - this[key] };
  }

  check() {
    if (this.signal?.aborted) {
      return budgetFailure("AGENT_ABORTED", "Agent 已被中止。", this.signal.reason);
    }
    if (Number.isFinite(this.deadlineAt) && this.now() >= this.deadlineAt) {
      return budgetFailure("AGENT_DEADLINE_EXCEEDED", "Agent 已超过墙钟时间预算。");
    }
    return { ok: true };
  }

  /** @param {"model" | "tool"} kind */
  remaining(kind) {
    return Math.max(0, (kind === "model" ? this.maxModelCalls - this.modelCalls : this.maxToolCalls - this.toolCalls));
  }

  snapshot() {
    const health = this.check();
    return {
      modelCalls: this.modelCalls,
      maxModelCalls: finiteLimitOrNull(this.maxModelCalls),
      remainingModelCalls: finiteLimitOrNull(this.remaining("model")),
      toolCalls: this.toolCalls,
      maxToolCalls: finiteLimitOrNull(this.maxToolCalls),
      remainingToolCalls: finiteLimitOrNull(this.remaining("tool")),
      wallClockMs: finiteLimitOrNull(this.wallClockMs),
      elapsedMs: Math.max(0, this.now() - this.startedAt),
      deadlineAt: Number.isFinite(this.deadlineAt) ? new Date(this.deadlineAt).toISOString() : null,
      ok: health.ok,
      stopCode: health.ok ? "" : ("code" in health ? health.code : "")
    };
  }
}

function resolveExecutionBudget(options = {}) {
  if (options.existing instanceof AgentExecutionBudget) return options.existing;
  if (options.existing && typeof options.existing.claim === "function"
    && typeof options.existing.snapshot === "function") return options.existing;
  return new AgentExecutionBudget(options);
}

function claimExecutionBudget(budget, kind, count = 1) {
  if (!budget || typeof budget.claim !== "function") return { ok: true };
  return budget.claim(kind, count);
}

function executionBudgetSnapshot(budget) {
  return budget && typeof budget.snapshot === "function" ? budget.snapshot() : null;
}

function budgetFailure(code, error, cause = null) {
  return {
    ok: false,
    code,
    error,
    ...(cause === null || cause === undefined ? {} : { cause: `${cause?.message || cause}` })
  };
}

function combineAbortSignals(signal, wallClockMs, abortApi = AbortSignal) {
  if (!Number.isFinite(wallClockMs)) return signal || null;
  const timeoutSignal = typeof abortApi?.timeout === "function"
    ? abortApi.timeout(wallClockMs)
    : null;
  if (!signal) return timeoutSignal;
  if (!timeoutSignal) return signal;
  if (typeof abortApi?.any === "function") return abortApi.any([signal, timeoutSignal]);
  const controller = new AbortController();
  const sources = [signal, timeoutSignal];
  const listeners = new Map();
  const cleanup = () => {
    for (const source of sources) {
      const listener = listeners.get(source);
      if (listener) source.removeEventListener("abort", listener);
    }
    listeners.clear();
  };
  for (const source of sources) {
    const forward = () => {
      if (!controller.signal.aborted) controller.abort(source.reason);
      cleanup();
    };
    listeners.set(source, forward);
    if (source.aborted) {
      forward();
      break;
    }
    source.addEventListener("abort", forward, { once: true });
  }
  return controller.signal;
}

function positiveInteger(value, fallback) {
  return Number.isFinite(value) && Number(value) > 0 ? Math.floor(Number(value)) : fallback;
}

function positiveLimit(value, fallback) {
  return value === Number.POSITIVE_INFINITY
    ? Number.POSITIVE_INFINITY
    : positiveInteger(value, fallback);
}

function finiteLimitOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

module.exports = {
  AgentExecutionBudget,
  resolveExecutionBudget,
  claimExecutionBudget,
  executionBudgetSnapshot,
  combineAbortSignals
};
