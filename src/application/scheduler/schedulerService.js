const crypto = require("node:crypto");
const { ensureDir, exists, readJson, writeJsonAtomic } = require("../../platform/shared/fs");
const { captureOptionalError } = require("../../platform/observability/errorReporter");
const { KeyedSerialExecutor } = require("../../platform/shared/keyedSerialExecutor");
const SCHEDULER_STOP_GRACE_MS = 10000;

class SchedulerService {
  constructor(paths, workflowEngine, options = {}) {
    this.paths = paths;
    this.workflowEngine = workflowEngine;
    this.errorReporter = options.errorReporter || null;
    this.timers = new Map();
    this.executions = new Map();
    this.mutations = new KeyedSerialExecutor();
    this.accepting = true;
  }

  captureOptionalError(error, scope, context = {}) {
    return captureOptionalError(this.errorReporter, error, {
      scope,
      severity: "warning",
      context
    });
  }

  async start() {
    this.accepting = true;
    await ensureDir(this.paths.schedulesDir);
    if (!(await exists(this.paths.jobsFile))) {
      await writeJsonAtomic(this.paths.jobsFile, []);
    }
    await this.reload();
  }

  async list() {
    const jobs = await readJson(this.paths.jobsFile, []);
    return jobs.map(({ workflowId: _legacyWorkflowId, ...job }) => job);
  }

  async save(jobs) {
    await writeJsonAtomic(this.paths.jobsFile, jobs);
  }

  async reload() {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    if (!this.accepting) return;
    const jobs = await this.list();
    for (const job of jobs) this.schedule(job);
  }

  async create(job) {
    if (!job.projectId) throw new Error("定时任务必须绑定一个项目。");
    const next = await this.mutateJobs((jobs) => {
      const created = {
        id: crypto.randomUUID(),
        name: job.name || "定时 Agent 任务",
        projectId: job.projectId,
        taskId: job.taskId || "",
        topic: job.topic || "待执行任务",
        command: job.command || "按当前任务要求执行",
        schedule: job.schedule || { type: "daily", time: "09:00" },
        active: job.active !== false,
        createdAt: new Date().toISOString(),
        lastRunAt: null,
        nextRunAt: null
      };
      created.nextRunAt = this.computeNextRun(created).toISOString();
      jobs.push(created);
      return created;
    });
    await this.reload();
    return next;
  }

  async update(id, patch) {
    const updated = await this.mutateJobs((jobs) => {
      const index = jobs.findIndex((job) => job.id === id);
      if (index === -1) throw new Error(`找不到定时任务：${id}`);
      const { workflowId: _legacyWorkflowId, ...canonicalPatch } = patch || {};
      jobs[index] = { ...jobs[index], ...canonicalPatch };
      jobs[index].nextRunAt = this.computeNextRun(jobs[index]).toISOString();
      return jobs[index];
    });
    await this.reload();
    return updated;
  }

  async remove(id) {
    const removed = await this.mutateJobs((jobs) => {
      const index = jobs.findIndex((job) => job.id === id);
      if (index === -1) return 0;
      jobs.splice(index, 1);
      return 1;
    });
    await this.reload();
    return { removed };
  }

  async mutateJobs(operation) {
    return this.mutations.run(`${this.paths.jobsFile || "scheduler-jobs"}`, async () => {
      const jobs = await this.list();
      const result = await operation(jobs);
      await this.save(jobs);
      return result;
    });
  }

  async stop() {
    this.accepting = false;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    let timeout;
    try {
      await Promise.race([
        Promise.allSettled([...this.executions.values()]),
        new Promise((resolve) => {
          timeout = setTimeout(resolve, SCHEDULER_STOP_GRACE_MS);
          timeout.unref?.();
        })
      ]);
    } finally {
      clearTimeout(timeout);
    }
  }

  schedule(job) {
    if (!job.active) return;
    const nextRun = new Date(job.nextRunAt || this.computeNextRun(job));
    const delay = Math.max(1000, Math.min(nextRun.getTime() - Date.now(), 2147483647));
    const timer = setTimeout(() => {
      this.execute(job.id).catch((error) => {
        this.captureOptionalError(error, "scheduler.executeTimer", { jobId: job.id });
      });
    }, delay);
    this.timers.set(job.id, timer);
  }

  computeNextRun(job) {
    const now = new Date();
    if (job.schedule?.type === "interval") {
      const minutes = Math.max(Number(job.schedule.intervalMinutes || 60), 5);
      const base = job.lastRunAt ? new Date(job.lastRunAt) : now;
      const next = new Date(base.getTime() + minutes * 60 * 1000);
      return next > now ? next : new Date(now.getTime() + minutes * 60 * 1000);
    }

    const [hour, minute] = `${job.schedule?.time || "09:00"}`.split(":").map((item) => Number(item));
    const next = new Date(now);
    next.setHours(Number.isFinite(hour) ? hour : 9, Number.isFinite(minute) ? minute : 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    return next;
  }

  async execute(id) {
    if (!this.accepting) return null;
    const existing = this.executions.get(id);
    if (existing) return existing;
    const execution = this.executeOnce(id);
    this.executions.set(id, execution);
    try {
      return await execution;
    } finally {
      if (this.executions.get(id) === execution) this.executions.delete(id);
    }
  }

  async executeOnce(id) {
    const jobs = await this.list();
    const job = jobs.find((item) => item.id === id);
    if (!job || !job.active) return null;
    const scheduledFor = `${job.nextRunAt || this.computeNextRun(job).toISOString()}`;
    const runId = `scheduled-${crypto.createHash("sha256")
      .update(`${job.id}\u0000${scheduledFor}`, "utf8")
      .digest("hex")
      .slice(0, 24)}`;
    const started = await this.workflowEngine.startRun({
      projectId: job.projectId || "",
      taskId: job.taskId || "",
      topic: job.topic,
      command: job.command,
      runId
    });
    const result = await this.workflowEngine.runUntilBlocked(started.run.id);
    const completedAt = new Date().toISOString();
    await this.mutateJobs((latestJobs) => {
      const latest = latestJobs.find((item) => item.id === id);
      if (!latest) return null;
      const scheduleUnchanged = `${latest.nextRunAt || ""}` === scheduledFor;
      latest.lastRunAt = completedAt;
      if (scheduleUnchanged) latest.nextRunAt = this.computeNextRun(latest).toISOString();
      return latest;
    });
    await this.reload();
    return result;
  }
}

module.exports = {
  SchedulerService
};
