// @ts-check

const path = require("node:path");
const crypto = require("node:crypto");
const { appendJsonl, ensureDir, exists, readJson, writeJsonAtomic } = require("../shared/fs");
const { WorkspaceLayout } = require("../storage/workspaceLayout");
const { captureOptionalError } = require("../observability/errorReporter");
const { assertSafePathSegment } = require("../shared/pathSafety");

function shortId() {
  return crypto.randomUUID().slice(0, 8);
}

function stamp(date = new Date()) {
  const pad = (value) => `${value}`.padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "-",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join("");
}

class RunStore {
  constructor(paths = {}, options = {}) {
    this.paths = paths;
    this.layout = new WorkspaceLayout(paths);
    this.indexFile = path.join(paths.privateDir || paths.workspace || paths.projectRoot || ".", "run-index.json");
    this.errorReporter = options.errorReporter || null;
  }

  captureOptionalError(error, scope, context = {}) {
    return captureOptionalError(this.errorReporter, error, {
      scope,
      severity: "warning",
      context
    });
  }

  createRunId(date = new Date()) {
    return `${stamp(date)}-${shortId()}`;
  }

  async ensureRunDirs({ projectId = "", taskId = "", runId = "", id = "" } = {}) {
    const effectiveRunId = runId || id;
    const runDir = this.layout.runDir(projectId, taskId, effectiveRunId);
    await Promise.all([
      ensureDir(runDir),
      ensureDir(path.join(runDir, "steps")),
      ensureDir(path.join(runDir, "calls")),
      ensureDir(path.join(runDir, "evals")),
      ensureDir(path.join(runDir, "checkpoints"))
    ]);
    return runDir;
  }

  async createRun(input = {}) {
    const now = new Date().toISOString();
    const runId = input.runId || this.createRunId();
    const runDir = await this.ensureRunDirs({ ...input, runId });
    const run = {
      version: 2,
      id: runId,
      projectId: input.projectId || "",
      taskId: input.taskId || "",
      workflowRef: input.workflowRef || input.workflowId || "",
      title: input.title || input.topic || "未命名运行",
      status: input.status || "created",
      createdAt: now,
      updatedAt: now,
      runDir,
      steps: input.steps || []
    };
    await writeJsonAtomic(path.join(runDir, "run.json"), run);
    await this.registerRun(run);
    await this.appendEvent(run, { type: "run.created", status: run.status, title: run.title });
    return run;
  }

  async loadIndex() {
    try {
      const index = await readJson(this.indexFile, null);
      if (index && Array.isArray(index.runs)) return index;
    } catch (error) {
      this.captureOptionalError(error, "runs.loadIndex", { file: this.indexFile });
    }
    return { version: 1, runs: [] };
  }

  async saveIndex(index = {}) {
    await writeJsonAtomic(this.indexFile, {
      version: 1,
      updatedAt: new Date().toISOString(),
      runs: Array.isArray(index.runs) ? index.runs : []
    });
  }

  async registerRun(run = {}) {
    if (!run.id) return null;
    const runId = assertSafePathSegment(run.id, "runId");
    const projectId = run.projectId ? assertSafePathSegment(run.projectId, "projectId") : "";
    const taskId = run.taskId ? assertSafePathSegment(run.taskId, "taskId") : "";
    const index = await this.loadIndex();
    const row = {
      id: runId,
      projectId,
      taskId,
      // runDir 是派生缓存，读取时绝不信任索引或 run.json 自带的路径。
      runDir: this.layout.runDir(projectId, taskId, runId),
      createdAt: run.createdAt || "",
      updatedAt: run.updatedAt || "",
      status: run.status || "",
      title: run.title || run.topic || ""
    };
    index.runs = [row, ...index.runs.filter((item) => item.id !== runId)];
    await this.saveIndex(index);
    return row;
  }

  async readRunFile(file, expected = {}) {
    if (!file || !(await exists(file))) return null;
    const run = await readJson(file, null);
    if (!run || typeof run !== "object") return null;
    if (`${run.id || ""}` !== expected.runId) return null;
    if (expected.projectId !== undefined && `${run.projectId || ""}` !== expected.projectId) return null;
    if (expected.taskId !== undefined && `${run.taskId || ""}` !== expected.taskId) return null;
    return { ...run, runDir: path.dirname(file) };
  }

  async loadIndexedRun(item = {}, expectedRunId = "") {
    const runId = assertSafePathSegment(expectedRunId || item.id, "runId");
    const projectId = item.projectId ? assertSafePathSegment(item.projectId, "projectId") : "";
    const taskId = item.taskId ? assertSafePathSegment(item.taskId, "taskId") : "";
    const file = path.join(this.layout.runDir(projectId, taskId, runId), "run.json");
    const scoped = await this.readRunFile(file, { runId, projectId, taskId });
    if (scoped) return scoped;
    const legacyRoot = this.paths.runsDir || "";
    if (!legacyRoot) return null;
    return this.readRunFile(path.join(legacyRoot, runId, "run.json"), { runId });
  }

  async loadRunById(runId = "") {
    if (!runId) return null;
    const safeRunId = assertSafePathSegment(runId, "runId");
    const index = await this.loadIndex();
    const hit = index.runs.find((item) => item.id === safeRunId);
    if (hit) {
      try {
        const run = await this.loadIndexedRun(hit, safeRunId);
        if (run) return run;
      } catch (error) {
        this.captureOptionalError(error, "runs.loadRunById.indexHit", { runId: safeRunId });
      }
    }
    const legacyRoot = this.paths.runsDir || "";
    if (!legacyRoot) return null;
    const legacyFile = path.join(legacyRoot, safeRunId, "run.json");
    const legacy = await this.readRunFile(legacyFile, { runId: safeRunId });
    if (legacy) return legacy;
    return null;
  }

  async listRuns({ projectId = "", taskId = "" } = {}) {
    const index = await this.loadIndex();
    const rows = [];
    const invalidIds = new Set();
    for (const item of index.runs) {
      let run = null;
      try {
        run = await this.loadIndexedRun(item);
      } catch (error) {
        this.captureOptionalError(error, "runs.listRuns.readRun", { projectId, taskId, runId: item.id });
      }
      if (!run) {
        invalidIds.add(item.id);
        continue;
      }
      if (projectId && run.projectId !== projectId) continue;
      if (taskId && run.taskId !== taskId) continue;
      rows.push(run);
    }
    if (invalidIds.size) {
      index.runs = index.runs.filter((item) => !invalidIds.has(item.id));
      await this.saveIndex(index);
    }
    return rows.sort((a, b) => `${b.createdAt || ""}`.localeCompare(`${a.createdAt || ""}`));
  }

  async loadRun({ projectId = "", taskId = "", runId = "" } = {}) {
    const runFile = path.join(this.layout.runDir(projectId, taskId, runId), "run.json");
    return this.readRunFile(runFile, {
      runId: assertSafePathSegment(runId || "default-run", "runId"),
      projectId: projectId || "",
      taskId: taskId || ""
    });
  }

  async saveRun(run = {}) {
    const runDir = await this.ensureRunDirs(run);
    const next = {
      ...run,
      updatedAt: new Date().toISOString(),
      runDir
    };
    await writeJsonAtomic(path.join(runDir, "run.json"), next);
    await this.registerRun(next);
    return next;
  }

  async appendEvent(run = {}, event = {}) {
    const runDir = await this.ensureRunDirs(run);
    const row = {
      id: event.id || crypto.randomUUID(),
      createdAt: event.createdAt || new Date().toISOString(),
      projectId: run.projectId || event.projectId || "",
      taskId: run.taskId || event.taskId || "",
      runId: run.id || event.runId || "",
      ...event
    };
    await appendJsonl(path.join(runDir, "timeline.jsonl"), row);
    return row;
  }

  async saveStepManifest(run = {}, step = {}) {
    const dir = this.layout.stepDir(run.projectId, run.taskId, run.id, step.id || "step");
    await ensureDir(dir);
    const manifest = {
      version: 1,
      runId: run.id || "",
      projectId: run.projectId || "",
      taskId: run.taskId || "",
      id: step.id || "",
      title: step.title || step.id || "步骤",
      status: step.status || "pending",
      updatedAt: new Date().toISOString(),
      inputRefs: step.inputRefs || [],
      output: step.output || {}
    };
    await writeJsonAtomic(path.join(dir, "step.json"), manifest);
    return manifest;
  }
}

module.exports = {
  RunStore
};
