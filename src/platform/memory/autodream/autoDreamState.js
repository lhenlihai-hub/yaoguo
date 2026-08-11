// @ts-check

const crypto = require("node:crypto");
const fsp = require("node:fs/promises");
const path = require("node:path");

const AUTO_DREAM_LOCK_FILE = ".autodream.lock";
const AUTO_DREAM_SIGNAL_DIRECTORY = ".autodream-sessions";
const AUTO_DREAM_MIN_INTERVAL_MS = 24 * 60 * 60 * 1000;
const AUTO_DREAM_MIN_SESSIONS = 5;
const AUTO_DREAM_APPEND_ONLY_MIN_SESSIONS = 1;

class AutoDreamStateStore {
  constructor({
    memoryDirectory = "",
    clock = () => new Date(),
    pid = process.pid,
    minSessions = AUTO_DREAM_MIN_SESSIONS,
    tokenFactory = () => crypto.randomUUID(),
    settle = () => new Promise((resolve) => setImmediate(resolve))
  } = {}) {
    this.memoryDirectory = path.resolve(`${memoryDirectory || ""}`);
    this.lockFile = path.join(this.memoryDirectory, AUTO_DREAM_LOCK_FILE);
    this.signalDirectory = path.join(this.memoryDirectory, AUTO_DREAM_SIGNAL_DIRECTORY);
    this.clock = clock;
    this.pid = Number.isSafeInteger(Number(pid)) ? Number(pid) : process.pid;
    this.minSessions = Math.max(1, Math.min(200, Math.floor(Number(minSessions) || AUTO_DREAM_MIN_SESSIONS)));
    this.tokenFactory = tokenFactory;
    this.settle = settle;
  }

  async ensure() {
    await fsp.mkdir(this.signalDirectory, { recursive: true, mode: 0o700 });
    await assertDirectory(this.signalDirectory);
    const now = this.now();
    await fsp.writeFile(this.lockFile, JSON.stringify(idleOwner(this.pid, "", now)), {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx"
    }).then(async () => {
      const baseline = new Date(Math.max(0, now.getTime() - 1));
      await fsp.utimes(this.lockFile, baseline, baseline);
    }).catch((error) => {
      if (error?.code !== "EEXIST") throw error;
    });
    await assertRegularFile(this.lockFile);
  }

  async recordSession({ sessionId = "", projectId = "", taskId = "", writtenFiles = [] } = {}) {
    if (!`${sessionId || ""}`.trim()) throw stateError("AUTODREAM_SESSION_INVALID", "AutoDream 会话标识不能为空");
    await this.ensure();
    const digest = sha256(`${sessionId}`).slice(0, 32);
    const file = path.join(this.signalDirectory, `${digest}.json`);
    const now = this.now();
    const row = {
      version: 1,
      session: digest,
      projectId: safeId(projectId),
      taskId: safeId(taskId),
      writtenFiles: normalizeMemoryFiles(writtenFiles),
      recordedAt: now.toISOString()
    };
    await writeJsonAtomic(file, row);
    const lockStat = await fsp.stat(this.lockFile);
    const signalTime = new Date(Math.max(now.getTime(), Math.floor(lockStat.mtimeMs) + 1));
    await fsp.utimes(file, signalTime, signalTime);
    return { ...row, file, mtimeMs: signalTime.getTime() };
  }

  async evaluate() {
    await this.ensure();
    const now = this.now();
    const lockStat = await fsp.stat(this.lockFile);
    const lockRow = await readJson(this.lockFile);
    const priorRunningMtime = lockRow?.state === "running" ? Date.parse(`${lockRow.previousMtime || ""}`) : NaN;
    const lastMtimeMs = Number.isFinite(priorRunningMtime) ? priorRunningMtime : lockStat.mtimeMs;
    const signals = await this.listSignalsAfter(lastMtimeMs);
    const elapsedMs = Math.max(0, now.getTime() - lastMtimeMs);
    const timeReady = elapsedMs >= AUTO_DREAM_MIN_INTERVAL_MS;
    const sessionReady = signals.length >= this.minSessions;
    return {
      eligible: timeReady && sessionReady,
      timeReady,
      sessionReady,
      elapsedMs,
      sessionCount: signals.length,
      minSessions: this.minSessions,
      lastConsolidatedAt: new Date(lastMtimeMs).toISOString(),
      signals,
      code: gateCode(timeReady, sessionReady)
    };
  }

  async acquire() {
    const eligibility = await this.evaluate();
    if (!eligibility.eligible) return { acquired: false, ...eligibility };
    const currentContent = await fsp.readFile(this.lockFile, "utf8");
    const previousStat = await fsp.stat(this.lockFile);
    const currentOwner = parseJson(currentContent);
    const inheritedMtime = currentOwner?.state === "running"
      ? new Date(`${currentOwner.previousMtime || ""}`)
      : previousStat.mtime;
    const previousMtime = Number.isFinite(inheritedMtime.getTime()) ? inheritedMtime : previousStat.mtime;
    const previousContent = currentOwner?.state === "running"
      ? JSON.stringify(idleOwner(currentOwner.pid || this.pid, currentOwner.token || "", previousMtime))
      : currentContent;
    const token = `${this.pid}:${this.tokenFactory()}`;
    const owner = {
      version: 1,
      state: "running",
      pid: this.pid,
      token,
      startedAt: this.now().toISOString(),
      previousMtime: previousMtime.toISOString()
    };
    await this.writeOwner(owner);
    if (!(await this.confirmOwner(token))) return { acquired: false, ...eligibility, code: "LOCK_CONTENDED" };
    await fsp.utimes(this.lockFile, previousStat.atime, previousMtime);
    if (!(await this.confirmOwner(token))) return { acquired: false, ...eligibility, code: "LOCK_CONTENDED" };
    return {
      acquired: true,
      code: "LOCK_ACQUIRED",
      token,
      pid: this.pid,
      previousContent,
      previousAtime: previousStat.atime,
      previousMtime,
      signals: eligibility.signals,
      sessionCount: eligibility.sessionCount,
      minSessions: eligibility.minSessions,
      lastConsolidatedAt: eligibility.lastConsolidatedAt
    };
  }

  async owns(lease = {}) {
    if (!lease?.token) return false;
    const row = await readJson(this.lockFile);
    return row?.state === "running"
      && row?.pid === lease.pid
      && row?.token === lease.token;
  }

  async complete(lease = {}) {
    if (!(await this.owns(lease))) throw stateError("AUTODREAM_LOCK_LOST", "AutoDream 完成前已失去锁");
    const now = this.now();
    await this.writeOwner(idleOwner(this.pid, lease.token, now));
    await fsp.utimes(this.lockFile, now, now);
    await this.pruneConsumedSignals(lease.signals);
    return { completedAt: now.toISOString() };
  }

  async rollback(lease = {}) {
    if (!(await this.owns(lease))) return { restored: false, code: "LOCK_ALREADY_LOST" };
    await fsp.writeFile(this.lockFile, `${lease.previousContent || ""}`, { encoding: "utf8", mode: 0o600 });
    await fsp.utimes(this.lockFile, lease.previousAtime, lease.previousMtime);
    return { restored: true, lastConsolidatedAt: lease.previousMtime.toISOString() };
  }

  async confirmOwner(token = "") {
    await this.settle();
    const first = await readJson(this.lockFile);
    if (first?.token !== token || first?.pid !== this.pid || first?.state !== "running") return false;
    await this.settle();
    const second = await readJson(this.lockFile);
    return second?.token === token && second?.pid === this.pid && second?.state === "running";
  }

  async writeOwner(owner) {
    await fsp.writeFile(this.lockFile, JSON.stringify(owner), { encoding: "utf8", mode: 0o600 });
    await fsp.chmod(this.lockFile, 0o600);
  }

  async listSignalsAfter(mtimeMs) {
    const entries = await fsp.readdir(this.signalDirectory, { withFileTypes: true }).catch(() => []);
    const signals = [];
    for (const entry of entries) {
      if (!entry.isFile() || entry.isSymbolicLink() || !/^[a-f0-9]{32}\.json$/.test(entry.name)) continue;
      const file = path.join(this.signalDirectory, entry.name);
      const stat = await fsp.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.mtimeMs <= mtimeMs) continue;
      const row = await readJson(file);
      if (!row?.session) continue;
      signals.push({ ...row, file, mtimeMs: stat.mtimeMs });
    }
    return signals.sort((left, right) => right.mtimeMs - left.mtimeMs).slice(0, 200);
  }

  async pruneConsumedSignals(signals = []) {
    for (const signal of Array.isArray(signals) ? signals : []) {
      const file = path.resolve(`${signal?.file || ""}`);
      if (path.dirname(file) !== this.signalDirectory) continue;
      const stat = await fsp.lstat(file).catch(() => null);
      if (!stat?.isFile() || stat.isSymbolicLink()) continue;
      if (stat.mtimeMs <= Number(signal.mtimeMs)) await fsp.unlink(file).catch(() => {});
    }
  }

  now() {
    const value = this.clock();
    const date = value instanceof Date ? value : new Date(value);
    return Number.isFinite(date.getTime()) ? date : new Date();
  }
}

function gateCode(timeReady, sessionReady) {
  if (timeReady && sessionReady) return "ELIGIBLE";
  if (!timeReady && !sessionReady) return "TIME_AND_SESSION_GATE";
  return timeReady ? "SESSION_GATE" : "TIME_GATE";
}

function idleOwner(pid, token, now) {
  return { version: 1, state: "idle", pid, token, completedAt: now.toISOString() };
}

async function writeJsonAtomic(file, row) {
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomUUID()}.tmp`);
  try {
    await fsp.writeFile(temp, JSON.stringify(row), { encoding: "utf8", mode: 0o600, flag: "wx" });
    await fsp.rename(temp, file);
    await fsp.chmod(file, 0o600);
  } catch (error) {
    await fsp.unlink(temp).catch(() => {});
    throw error;
  }
}

async function readJson(file) {
  try { return JSON.parse(await fsp.readFile(file, "utf8")); } catch { return null; }
}

function parseJson(value = "") {
  try { return JSON.parse(`${value || ""}`); } catch { return null; }
}

async function assertDirectory(directory) {
  const stat = await fsp.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw stateError("AUTODREAM_STATE_UNSAFE", "AutoDream 状态目录不安全");
}

async function assertRegularFile(file) {
  const stat = await fsp.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw stateError("AUTODREAM_LOCK_UNSAFE", "AutoDream 锁必须是 nlink=1 的普通文件");
  }
}

function safeId(value = "") {
  const source = `${value || ""}`;
  return /^[A-Za-z0-9._-]{1,160}$/.test(source) ? source : "";
}

function normalizeMemoryFiles(values = []) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => `${value || ""}`.trim())
    .filter((value) => /^(?:user|feedback|project|reference)-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/.test(value)))];
}

function sha256(value = "") {
  return crypto.createHash("sha256").update(`${value || ""}`, "utf8").digest("hex");
}

function stateError(code, message) {
  return Object.assign(new Error(message), { code });
}

module.exports = {
  AutoDreamStateStore,
  AUTO_DREAM_LOCK_FILE,
  AUTO_DREAM_SIGNAL_DIRECTORY,
  AUTO_DREAM_MIN_INTERVAL_MS,
  AUTO_DREAM_MIN_SESSIONS,
  AUTO_DREAM_APPEND_ONLY_MIN_SESSIONS,
  gateCode
};
