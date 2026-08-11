// @ts-check
// CheckpointStore — Claude Code 风格的 JSONL append-only checkpoint。
//
// 设计原则（对齐 Anthropic Claude Code、ChatGPT Tasks 本地侧）：
// 1. JSONL append-only：每行一个完整自含的 typed event，崩溃恢复 = 截到最后一个完整行。
// 2. parentStepId 形成链表：fork = 复制 jsonl 并截断到目标行，跨进程零锁竞争。
// 3. 不引入 SQLite / 任何 native binding——本地 Agent 运行是 append-heavy 单写者场景，
//    JSONL 在 grep/diff/git/人类可读上全面优于 SQLite。
// 4. 与现有 state.md（人类可读 markdown）并存：state.md 给 prompt 注入用，
//    checkpoints.jsonl 给程序读 typed state 用。两者来源同一份 handoff，不会漂移。
//
// 文件位置：runs/<runId>/checkpoints.jsonl
//
// Row schema（v=1）：
//   {
//     "v": 1,
//     "ts": ISO,
//     "runId": str,
//     "stepId": str,
//     "stepIndex": int,
//     "parentStepId": str|null,   // 上一个 completed step 的 id，形成链表
//     "status": "completed" | "blocked" | "cancelled",
//     "title": str,
//     "taskType": str,
//     "summary": str,             // 步骤摘要（来自 LLM 或 localStepSummary）
//     "handoff": {                // YAOGUO_HANDOFF JSON，可能为 null
//        "decisions": [],
//        "rejected": [],
//        "openQuestions": [],
//        "facts": []
//     } | null,
//     "outputFile": str,          // outputs/0X-*.md 相对路径
//     "artifactId": str|null,
//     "durationMs": number,
//     "userWaitMs": number        // 该步骤前等待人工决策的时长（与 L1.4 联动）
//   }

const path = require("node:path");
const fsp = require("node:fs/promises");
const { appendJsonl, exists } = require("../shared/fs");

const CHECKPOINT_VERSION = 1;
const CHECKPOINT_FILE = "checkpoints.jsonl";

class CheckpointStore {
  /**
   * @param {{ runDir?: string }} options
   *   runDir 可在 append 时显式传入；这里仅用于"全局默认 store"场景。
   */
  constructor(options = {}) {
    this.defaultRunDir = options.runDir || "";
  }

  resolveFile(runDir) {
    const base = runDir || this.defaultRunDir;
    if (!base) throw new Error("checkpointStore 缺少 runDir。");
    return path.join(base, CHECKPOINT_FILE);
  }

  /**
   * 追加一条 step 完成事件。append-only，绝不就地修改。
   */
  async append(runDir, payload = {}) {
    const row = this.normalize(payload);
    if (!row) return null;
    await appendJsonl(this.resolveFile(runDir), row);
    return row;
  }

  normalize(payload = {}) {
    if (!payload || !payload.stepId) return null;
    const handoff = payload.handoff && typeof payload.handoff === "object"
      ? {
        decisions: this.cleanList(payload.handoff.decisions),
        rejected: this.cleanList(payload.handoff.rejected),
        openQuestions: this.cleanList(payload.handoff.openQuestions),
        facts: this.cleanList(payload.handoff.facts)
      }
      : null;
    return {
      v: CHECKPOINT_VERSION,
      ts: payload.ts || new Date().toISOString(),
      runId: payload.runId || "",
      stepId: `${payload.stepId}`,
      stepIndex: Number.isFinite(payload.stepIndex) ? payload.stepIndex : -1,
      parentStepId: payload.parentStepId || null,
      status: payload.status || "completed",
      title: payload.title || "",
      taskType: payload.taskType || "",
      summary: `${payload.summary || ""}`,
      handoff,
      outputFile: payload.outputFile || "",
      artifactId: payload.artifactId || null,
      durationMs: Number(payload.durationMs) || 0,
      userWaitMs: Number(payload.userWaitMs) || 0
    };
  }

  cleanList(value) {
    if (!Array.isArray(value)) return [];
    return value
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter(Boolean);
  }

  /**
   * 读取整份 checkpoint 历史。append-only 保证最后一行最新；
   * 损坏的行（罕见，例如崩溃中途）会被静默跳过——这是 JSONL 的标准做法。
   */
  async loadHistory(runDir) {
    const file = this.resolveFile(runDir);
    if (!(await exists(file))) return [];
    const content = await fsp.readFile(file, "utf8").catch(() => "");
    const rows = [];
    for (const line of content.split(/\n+/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const row = JSON.parse(trimmed);
        if (row && row.v === CHECKPOINT_VERSION && row.stepId) rows.push(row);
      } catch {
        // 跳过损坏行——Claude Code 同样语义
      }
    }
    return rows;
  }

  async loadLatest(runDir) {
    const rows = await this.loadHistory(runDir);
    return rows.length ? rows[rows.length - 1] : null;
  }

  async findByStepId(runDir, stepId) {
    const rows = await this.loadHistory(runDir);
    // 同一 stepId 可能因为重跑出现多行——返回最新一条。
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      if (rows[i].stepId === stepId) return rows[i];
    }
    return null;
  }

  /**
   * 把所有已 completed step 的 handoff 聚合成一份 typed accumulated state。
   * 这是 L2.1 给下游 step 用的核心 API——以后 prompt 不再 parse state.md，
   * 直接 typed 读这个对象。
   */
  async loadAccumulatedState(runDir, { untilStepId = "" } = {}) {
    const rows = await this.loadHistory(runDir);
    const accumulated = {
      decisions: [],
      rejected: [],
      openQuestions: [],
      facts: [],
      stepSummaries: []
    };
    for (const row of rows) {
      if (row.status !== "completed") continue;
      if (row.handoff) {
        for (const key of ["decisions", "rejected", "openQuestions", "facts"]) {
          for (const item of row.handoff[key] || []) {
            if (!accumulated[key].includes(item)) accumulated[key].push(item);
          }
        }
      }
      accumulated.stepSummaries.push({
        stepId: row.stepId,
        stepIndex: row.stepIndex,
        title: row.title,
        summary: row.summary,
        outputFile: row.outputFile
      });
      if (untilStepId && row.stepId === untilStepId) break;
    }
    return accumulated;
  }

  /**
   * fork：把当前 run 的 checkpoint 截到 untilStepId 后复制到 targetRunDir。
   * 这是 time-travel 的基础——回到某一步换个方向重跑。
   * 不动 outputs/*.md，由调用方决定是否一并复制。
   */
  async fork(sourceRunDir, targetRunDir, { untilStepId = "" } = {}) {
    const rows = await this.loadHistory(sourceRunDir);
    if (!rows.length) return { copied: 0 };
    const sliceEnd = untilStepId
      ? rows.findIndex((row) => row.stepId === untilStepId) + 1
      : rows.length;
    if (sliceEnd <= 0) return { copied: 0 };
    const target = path.join(targetRunDir, CHECKPOINT_FILE);
    await fsp.mkdir(targetRunDir, { recursive: true });
    const text = rows.slice(0, sliceEnd).map((row) => JSON.stringify(row)).join("\n") + "\n";
    await fsp.writeFile(target, text, "utf8");
    return { copied: sliceEnd, file: target };
  }
}

module.exports = {
  CheckpointStore,
  CHECKPOINT_VERSION,
  CHECKPOINT_FILE
};
