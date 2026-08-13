const path = require("node:path");
const { createReadStream } = require("node:fs");
const readline = require("node:readline");
const { appendJsonl, ensureDir, exists, readJson, writeJsonAtomic } = require("../shared/fs");
const { hashObject, redactSensitive } = require("../shared/text");
const { captureOptionalError } = require("../observability/errorReporter");

class TokenLedger {
  constructor(paths = {}, options = {}) {
    this.paths = paths;
    this.aiCallsFile = paths.aiCallsFile || path.join(paths.privateDir || "", "ai-calls.jsonl");
    this.ledgerFile = paths.tokenLedgerFile || path.join(paths.privateDir || "", "token-ledger.jsonl");
    this.summaryFile = paths.tokenSummaryFile || path.join(paths.privateDir || "", "token-summary.json");
    this.errorReporter = options.errorReporter || null;
  }

  captureOptionalError(error, scope, context = {}) {
    return captureOptionalError(this.errorReporter, error, {
      scope,
      severity: "warning",
      context
    });
  }

  normalize(entry = {}) {
    const promptTokens = Number(entry.actualPromptTokens || entry.promptTokens || 0);
    const completionTokens = Number(entry.actualCompletionTokens || entry.outputTokens || 0);
    const reasoningTokens = Number(entry.reasoningTokens || 0);
    const cacheHitTokens = Number(entry.cacheHitTokens || 0);
    const cacheMissTokens = Number(entry.cacheMissTokens || Math.max(0, promptTokens - cacheHitTokens));
    return {
      id: entry.id || "",
      createdAt: entry.createdAt || new Date().toISOString(),
      projectId: entry.projectId || "",
      taskId: entry.taskId || "",
      runId: entry.runId || "",
      stepId: entry.stepId || "",
      taskType: entry.taskType || "default",
      internalCall: entry.internalCall === true,
      title: entry.title || "",
      providerId: entry.providerId || "",
      model: entry.model || "",
      status: entry.status || "unknown",
      promptTokens,
      completionTokens,
      // reasoningTokens 是 completionTokens 的子集，不再计入 totalTokens。
      reasoningTokens,
      totalTokens: promptTokens + completionTokens,
      cacheHitTokens,
      cacheMissTokens,
      cacheHitRate: Number(entry.cacheHitRate || 0),
      estimatedInputTokens: Number(entry.inputTokens || 0),
      estimatedRunContextTokens: Number(entry.runContextTokens || 0),
      estimatedPinnedTokens: Number(entry.pinnedTokens || 0),
      durationMs: Number(entry.durationMs || 0),
      modelContextTokens: Number(entry.modelContextTokens || 0),
      contextUsageRatio: Number(entry.contextUsageRatio || 0),
      actualContextUsageRatio: Number(entry.actualContextUsageRatio ?? entry.contextUsageRatio ?? 0),
      finishReason: `${entry.finishReason || ""}`,
      thinkingMode: `${entry.thinkingMode || ""}`,
      reasoningEffort: `${entry.reasoningEffort || ""}`,
      promptHash: entry.promptHash || hashObject({
        taskType: entry.taskType,
        title: entry.title,
        instructionPreview: entry.instructionPreview,
        inputPreview: entry.inputPreview,
        runContextPreview: entry.runContextPreview,
        pinnedPreview: entry.pinnedPreview
      }),
      error: entry.error ? redactSensitive(entry.error) : ""
    };
  }

  async ensure() {
    await ensureDir(path.dirname(this.aiCallsFile));
    await ensureDir(path.dirname(this.ledgerFile));
    if (!(await exists(this.summaryFile))) {
      await writeJsonAtomic(this.summaryFile, {
        version: 1,
        updatedAt: new Date().toISOString(),
        totals: {
          calls: 0,
          promptTokens: 0,
          completionTokens: 0,
          reasoningTokens: 0,
          cacheHitTokens: 0
        },
        byTaskType: {},
        byModel: {}
      });
    }
  }

  async recordCall(entry = {}) {
    await this.ensure();
    // 原始副本同样脱敏错误文本：错误信息可能回显请求片段与凭据，
    // 不能只在 ledger 副本做 normalize 后才清洗。
    await appendJsonl(this.aiCallsFile, {
      ...entry,
      ...(entry.error ? { error: redactSensitive(entry.error) } : {})
    });
    const normalized = this.normalize(entry);
    await appendJsonl(this.ledgerFile, normalized);
    try {
      await this.updateSummary(normalized);
    } catch (error) {
      this.captureOptionalError(error, "telemetry.tokenLedger.updateSummary", {
        projectId: normalized.projectId,
        taskId: normalized.taskId,
        runId: normalized.runId,
        model: normalized.model
      });
    }
    return normalized;
  }

  addBucket(map = {}, key = "unknown", row = {}) {
    const bucketKey = key || "unknown";
    const current = {
      calls: 0,
      promptTokens: 0,
      completionTokens: 0,
      reasoningTokens: 0,
      cacheHitTokens: 0,
      durationMs: 0,
      ...(map[bucketKey] || {})
    };
    current.calls += 1;
    current.promptTokens += row.promptTokens;
    current.completionTokens += row.completionTokens;
    current.reasoningTokens += row.reasoningTokens;
    current.cacheHitTokens += row.cacheHitTokens;
    current.durationMs += row.durationMs;
    map[bucketKey] = current;
  }

  async updateSummary(row = {}) {
    const summary = await readJson(this.summaryFile, null) || {
      version: 1,
      totals: { calls: 0, promptTokens: 0, completionTokens: 0, reasoningTokens: 0, cacheHitTokens: 0 },
      byTaskType: {},
      byModel: {}
    };
    summary.totals = {
      calls: 0,
      promptTokens: 0,
      completionTokens: 0,
      reasoningTokens: 0,
      cacheHitTokens: 0,
      ...(summary.totals || {})
    };
    summary.byTaskType = summary.byTaskType || {};
    summary.byModel = summary.byModel || {};
    summary.updatedAt = new Date().toISOString();
    summary.totals.calls += 1;
    summary.totals.promptTokens += row.promptTokens;
    summary.totals.completionTokens += row.completionTokens;
    summary.totals.reasoningTokens += row.reasoningTokens;
    summary.totals.cacheHitTokens += row.cacheHitTokens;
    this.addBucket(summary.byTaskType, row.taskType, row);
    this.addBucket(summary.byModel, row.model || row.providerId, row);
    await writeJsonAtomic(this.summaryFile, summary);
  }

  async summarizeUsage({ projectId = "", taskId = "" } = {}) {
    await this.ensure();
    const summary = emptyUsageSummary();
    if (!(await exists(this.ledgerFile))) return summary;
    const lines = readline.createInterface({
      input: createReadStream(this.ledgerFile, { encoding: "utf8" }),
      crlfDelay: Infinity
    });
    for await (const line of lines) {
      if (!line.trim()) continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        summary.invalidRows += 1;
        continue;
      }
      if (projectId && `${row.projectId || ""}` !== `${projectId}`) continue;
      if (taskId && `${row.taskId || ""}` !== `${taskId}`) continue;
      addUsageRow(summary, row);
    }
    return finalizeUsageSummary(summary);
  }
}

function emptyUsageSummary() {
  return {
    modelCalls: 0,
    completedCalls: 0,
    failedCalls: 0,
    promptTokens: 0,
    completionTokens: 0,
    reasoningTokens: 0,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    totalTokens: 0,
    cacheHitRate: 0,
    invalidRows: 0,
    currentContextTokens: 0,
    contextWindowTokens: 0,
    contextUsageRatio: 0,
    foreground: emptyUsageBucket(),
    background: emptyUsageBucket()
  };
}

function addUsageRow(summary, row = {}) {
  addUsageCounters(summary, row);
  const background = isBackgroundCall(row);
  const bucket = background ? summary.background : summary.foreground;
  addUsageCounters(bucket, row);
  if (!background && `${row.status || ""}` === "completed") {
    setCurrentContext(summary, row);
    setCurrentContext(summary.foreground, row);
  }
}

function setCurrentContext(summary, row = {}) {
  const contextWindowTokens = Math.max(0, Number(row.modelContextTokens) || 0);
  const currentContextTokens = Math.max(0,
    Number(row.promptTokens) + Number(row.completionTokens)
  );
  summary.currentContextTokens = currentContextTokens;
  summary.contextWindowTokens = contextWindowTokens;
  summary.contextUsageRatio = contextWindowTokens > 0
    ? Number((currentContextTokens / contextWindowTokens).toFixed(6))
    : Math.max(0, Number(row.actualContextUsageRatio) || 0);
}

function addUsageCounters(summary, row = {}) {
  summary.modelCalls += 1;
  if (`${row.status || ""}` === "completed") summary.completedCalls += 1;
  else summary.failedCalls += 1;
  summary.promptTokens += Math.max(0, Number(row.promptTokens) || 0);
  summary.completionTokens += Math.max(0, Number(row.completionTokens) || 0);
  summary.reasoningTokens += Math.max(0, Number(row.reasoningTokens) || 0);
  summary.cacheHitTokens += Math.max(0, Number(row.cacheHitTokens) || 0);
  summary.cacheMissTokens += Math.max(0, Number(row.cacheMissTokens) || 0);
}

function finalizeUsageSummary(summary) {
  finalizeUsageBucket(summary.foreground);
  finalizeUsageBucket(summary.background);
  return finalizeUsageBucket(summary);
}

function emptyUsageBucket() {
  return {
    modelCalls: 0,
    completedCalls: 0,
    failedCalls: 0,
    promptTokens: 0,
    completionTokens: 0,
    reasoningTokens: 0,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    totalTokens: 0,
    cacheHitRate: 0,
    currentContextTokens: 0,
    contextWindowTokens: 0,
    contextUsageRatio: 0
  };
}

function finalizeUsageBucket(summary) {
  summary.totalTokens = summary.promptTokens + summary.completionTokens;
  const cachePromptTokens = summary.cacheHitTokens + summary.cacheMissTokens;
  summary.cacheHitRate = cachePromptTokens > 0
    ? Number((summary.cacheHitTokens / cachePromptTokens).toFixed(4))
    : 0;
  return summary;
}

function isBackgroundCall(row = {}) {
  if (row.internalCall === true) return true;
  if (row.internalCall === false) return false;
  return ["memory", "title"].includes(`${row.taskType || ""}`);
}

module.exports = {
  TokenLedger,
  emptyUsageSummary
};
