// @ts-check

const crypto = require("node:crypto");
const { KeyedSerialExecutor } = require("../../platform/shared/keyedSerialExecutor");
const {
  beginDurableTurn,
  executeDurableTurn,
  finishDurableTurn,
  replayTurnExecutionReceipt
} = require("./taskExecutionReceipt");

class TaskAgentCoordinator {
  constructor({ sessionStore = null, clock = () => new Date() } = {}) {
    this.sessionStore = sessionStore;
    this.clock = clock;
    this.executions = new KeyedSerialExecutor();
    this.activeTurns = new Map();
    this.inflightTurns = new Map();
    this.blockedScopes = new Set();
    this.blockedProjects = new Set();
  }

  key(scope = {}) {
    return `${scope.projectId || "application"}::${scope.taskId || scope.runId || "agent"}`;
  }

  hasInflightTurn(scope = {}) {
    if (!scope.turnId) return false;
    return this.inflightTurns.has(`${this.key(scope)}::${scope.turnId}`);
  }

  submitMessage(scope = {}, message = "", operation, { canSteer = true } = {}) {
    if (this.isBlocked(scope)) return Promise.reject(scopeDeletedError());
    const turnKey = scope.turnId ? `${this.key(scope)}::${scope.turnId}` : "";
    const inflight = turnKey ? this.inflightTurns.get(turnKey) : null;
    if (inflight) {
      if (`${inflight.message || ""}` !== `${message || ""}`) {
        return Promise.reject(Object.assign(
          new Error("同一 turnId 不能提交不同的用户输入。"),
          { code: "AGENT_TURN_CONFLICT" }
        ));
      }
      return inflight.promise;
    }
    const current = this._submitMessage(scope, message, operation, { canSteer });
    if (!turnKey) return current;
    const entry = { message: `${message || ""}`, promise: current };
    this.inflightTurns.set(turnKey, entry);
    return current.finally(() => {
      if (this.inflightTurns.get(turnKey) === entry) this.inflightTurns.delete(turnKey);
    });
  }

  async _submitMessage(scope = {}, message = "", operation, { canSteer = true } = {}) {
    const key = this.key(scope);
    if (this.isBlocked(scope)) throw scopeDeletedError();
    const active = this.activeTurns.get(key);
    const durableReceipt = canSteer && active
      ? await beginDurableTurn({ sessionStore: this.sessionStore, scope, message })
      : null;
    if (durableReceipt && durableReceipt.state !== "started") {
      return replayTurnExecutionReceipt(durableReceipt, scope);
    }
    const steeringReceipt = canSteer
      ? (active?.control?.enqueueSteering?.(message) || null)
      : null;
    const consumed = Boolean(steeringReceipt?.accepted && await steeringReceipt.consumed);
    if (consumed) {
      const completion = await active.completion;
      const outcome = steeringTurnOutcome(completion);
      await finishDurableTurn({
        sessionStore: this.sessionStore,
        scope: { ...scope, runId: active.scope.runId || scope.runId || "" },
        receipt: durableReceipt,
        status: outcome.status,
        stopCode: `${completion?.stopCode || ""}`
      });
      await this.sessionStore?.appendEvent?.({
        eventId: `steered:${scope.turnId || crypto.randomUUID()}`,
        type: "turn.steered",
        projectId: scope.projectId,
        taskId: scope.taskId,
        turnId: scope.turnId || "",
        runId: active.scope.runId || scope.runId || "",
        executionId: active.executionId,
        status: outcome.status,
        disposition: outcome.disposition,
        stopCode: `${completion?.stopCode || ""}`,
        createdAt: this.clock().toISOString()
      }, { deduplicate: true });
      return {
        accepted: true,
        disposition: outcome.disposition,
        turnId: scope.turnId || "",
        taskId: scope.taskId || "",
        runId: active.scope.runId || scope.runId || "",
        reply: outcome.reply,
        cancelled: outcome.cancelled,
        blocked: outcome.blocked,
        stopCode: `${completion?.stopCode || ""}`
      };
    }
    // 只有 Pi 尚未消费的消息才能安全排队。已消费的 steering 可能已经
    // 触发写入或命令；即使活动 turn 后续失败，也不能自动重放副作用。
    return this.executions.run(key, () => {
      if (this.isBlocked(scope)) throw scopeDeletedError();
      return executeDurableTurn({
        sessionStore: this.sessionStore, scope, message, operation, startedReceipt: durableReceipt
      });
    });
  }

  runExclusive(scope = {}, operation) {
    const key = this.key(scope);
    if (this.isBlocked(scope)) return Promise.reject(scopeDeletedError());
    return this.executions.run(key, () => {
      if (this.isBlocked(scope)) throw scopeDeletedError();
      return operation();
    });
  }

  isBlocked(scope = {}) {
    return this.blockedProjects.has(`${scope.projectId || ""}`)
      || this.blockedScopes.has(this.key(scope));
  }

  async abortScope(scope = {}, reason = "任务正在删除") {
    const key = this.key(scope);
    this.blockedScopes.add(key);
    const active = this.activeTurns.get(key);
    if (active) {
      try { active.control?.abort?.(reason); } catch { /* 仍等待执行自行关闭。 */ }
      await waitForScopeCompletion(active.completion, 10_000);
    }
    await this.executions.run(key, () => undefined);
    return { aborted: Boolean(active), key };
  }

  releaseScope(scope = {}) {
    return this.blockedScopes.delete(this.key(scope));
  }

  async abortProject(projectId = "", reason = "项目正在删除") {
    const normalizedProjectId = `${projectId || ""}`;
    this.blockedProjects.add(normalizedProjectId);
    const active = [...this.activeTurns.values()]
      .filter((entry) => `${entry.scope?.projectId || ""}` === normalizedProjectId);
    for (const entry of active) {
      try { entry.control?.abort?.(reason); } catch { /* 仍等待执行自行关闭。 */ }
    }
    await Promise.all(active.map((entry) => waitForScopeCompletion(entry.completion, 10_000)));
    const prefix = `${normalizedProjectId}::`;
    const keys = [...this.executions.tails.keys()].filter((key) => key.startsWith(prefix));
    await Promise.all(keys.map((key) => this.executions.run(key, () => undefined)));
    return { aborted: active.length };
  }

  releaseProject(projectId = "") {
    return this.blockedProjects.delete(`${projectId || ""}`);
  }

  abortAll(reason = "Agent permissions changed") {
    let aborted = 0;
    for (const entry of this.activeTurns.values()) {
      try {
        if (entry.control?.abort?.(reason)) aborted += 1;
      } catch {
        // One broken control must not leave other turns running with stale grants.
      }
    }
    return aborted;
  }

  registerActive(scope = {}, control) {
    const key = this.key(scope);
    /** @type {(result:any) => void} */
    let settleCompletion = () => {};
    const completion = new Promise((resolve) => { settleCompletion = resolve; });
    let settled = false;
    const entry = {
      control,
      scope: { ...scope },
      executionId: `${scope.executionId || crypto.randomUUID()}`,
      startedAt: this.clock().toISOString(),
      completion
    };
    if (this.isBlocked(scope)) {
      try { control?.abort?.("任务正在删除"); } catch { /* noop */ }
    }
    this.activeTurns.set(key, entry);
    return (result = null) => {
      if (!settled) {
        settled = true;
        settleCompletion(result);
      }
      if (this.activeTurns.get(key) === entry) this.activeTurns.delete(key);
    };
  }

}

function scopeDeletedError() {
  return Object.assign(new Error("任务正在删除或已经删除，不能继续执行 Agent。"), {
    code: "AGENT_SCOPE_DELETED"
  });
}

async function waitForScopeCompletion(completion, timeoutMs) {
  let timer;
  try {
    await Promise.race([
      Promise.resolve(completion),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(Object.assign(new Error("Agent 未能在删除任务前完成停止。"), {
            code: "AGENT_SCOPE_ABORT_TIMEOUT"
          }));
        }, timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function steeringTurnOutcome(result) {
  if (result?.aborted) {
    return {
      status: "cancelled",
      disposition: "steering_cancelled",
      reply: "当前执行在处理这条补充后已停止。消息已保留；如需重试，请发送一条新消息。",
      cancelled: true,
      blocked: false
    };
  }
  if (!result || result.exhausted || !`${result.text || ""}`.trim()) {
    return {
      status: "failed",
      disposition: "steering_failed",
      reply: "当前执行在处理这条补充后未能完成。消息已保留；如需重试，请发送一条新消息。",
      cancelled: false,
      blocked: true
    };
  }
  return {
    status: "completed",
    disposition: "steered",
    reply: "",
    cancelled: false,
    blocked: false
  };
}

module.exports = { TaskAgentCoordinator };
