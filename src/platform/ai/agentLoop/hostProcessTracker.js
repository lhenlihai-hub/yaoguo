// @ts-check

const fs = require("node:fs");
const { execFile } = require("node:child_process");

const DEFAULT_POLL_MS = 15;
const PROCESS_LIST_MAX_BYTES = 32 * 1024 * 1024;

class HostProcessTracker {
  /**
   * @param {{
   *   rootPid:number,
   *   rootPgid:number,
   *   token:string,
   *   snapshotProvider?:(token:string) => Promise<any[]>,
   *   pollMs?:number
   * }} options
   */
  constructor(options) {
    this.rootPid = options.rootPid;
    this.rootPgid = options.rootPgid;
    this.token = options.token;
    this.snapshotProvider = options.snapshotProvider || readHostProcessSnapshot;
    this.pollMs = Math.max(5, Number(options.pollMs) || DEFAULT_POLL_MS);
    this.tracked = new Map();
    this.lastSnapshot = [];
    this.stopped = false;
    this.failure = null;
    this.loopPromise = null;
    this.failurePromise = new Promise((resolve) => {
      this.resolveFailure = resolve;
    });
  }

  async start() {
    await this.capture();
    this.loopPromise = this.monitorLoop();
    return this;
  }

  async monitorLoop() {
    while (!this.stopped) {
      await delay(this.pollMs);
      if (this.stopped) break;
      try {
        await this.capture();
      } catch (error) {
        this.failure = error;
        this.resolveFailure(error);
        break;
      }
    }
  }

  async capture() {
    const rows = normalizeSnapshot(await this.snapshotProvider(this.token));
    this.lastSnapshot = rows;
    const live = new Map(rows.map((row) => [row.pid, row]));
    for (const [pid, birth] of this.tracked) {
      const row = live.get(pid);
      if (row && row.birth !== birth) this.tracked.delete(pid);
    }
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of rows) {
        if (this.tracked.has(row.pid)) continue;
        if (
          row.pid === this.rootPid ||
          row.pgid === this.rootPgid ||
          row.hasToken ||
          this.tracked.has(row.ppid)
        ) {
          this.tracked.set(row.pid, row.birth);
          changed = true;
        }
      }
    }
    return rows;
  }

  async stopAndReap() {
    this.stopped = true;
    await this.loopPromise?.catch(() => {});
    let captureError = this.failure;
    try {
      await this.capture();
    } catch (error) {
      captureError ||= error;
    }
    for (const row of this.lastSnapshot) {
      if (row.pid <= 1 || row.pid === process.pid) continue;
      if (this.tracked.get(row.pid) !== row.birth) continue;
      try {
        process.kill(row.pid, "SIGKILL");
      } catch (error) {
        if (error?.code !== "ESRCH") captureError ||= error;
      }
    }
    if (captureError) throw captureError;
  }
}

async function readHostProcessSnapshot(token) {
  const psPath = ["/bin/ps", "/usr/bin/ps"].find((candidate) => fs.existsSync(candidate));
  if (!psPath) throw new Error("宿主缺少进程身份跟踪工具 ps。");
  const stdout = await execFileText(psPath, [
    "eww",
    "-axo",
    "pid=,ppid=,pgid=,lstart=,command="
  ]);
  const marker = `YAOGUO_COMMAND_TOKEN=${token}`;
  return stdout.split(/\r?\n/).flatMap((line) => {
    const match = line.match(
      /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.*)$/
    );
    if (!match) return [];
    return [{
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      birth: match.slice(4, 9).join(" "),
      hasToken: match[9].includes(marker)
    }];
  });
}

function execFileText(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, {
      encoding: "utf8",
      maxBuffer: PROCESS_LIST_MAX_BYTES,
      timeout: 2000,
      env: {
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        LANG: "C",
        LC_ALL: "C"
      }
    }, (error, stdout) => {
      if (error) {
        reject(new Error(`无法读取宿主进程身份：${error.message || error}`));
        return;
      }
      resolve(`${stdout || ""}`);
    });
  });
}

function normalizeSnapshot(rows) {
  return (Array.isArray(rows) ? rows : []).flatMap((row) => {
    const pid = Number(row?.pid);
    const ppid = Number(row?.ppid);
    const pgid = Number(row?.pgid);
    const birth = `${row?.birth || ""}`.trim();
    if (![pid, ppid, pgid].every(Number.isSafeInteger) || !birth) return [];
    return [{ pid, ppid, pgid, birth, hasToken: row?.hasToken === true }];
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  HostProcessTracker,
  readHostProcessSnapshot
};
