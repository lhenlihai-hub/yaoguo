// @ts-check
// runInspector —— 统一读取一个 run 目录下所有 agent 工具 trace 产物,返回结构化 timeline。
//
// 业界对标:
//   - Claude Code UI 工具调用卡片 / Cursor Composer timeline / Devin run page
//   - LangSmith / Langfuse trace explorer:把多源 trace 聚合成可视化时序
//
// 本 service 是 UI / CLI / 审计接入的统一地基:
//   - renderer 通过 IPC 拿结构化 JSON,直接渲染
//   - CLI(scripts/inspect-run.mjs)pretty-print
//   - 未来 fork-replay 也能复用同一数据
//
// 设计:**纯读 + graceful** —— 任何子目录缺失 / 文件损坏都返回空数组,不抛错。

const path = require("node:path");
const fsp = require("node:fs/promises");
const { exists, readJson } = require("../shared/fs");

/**
 * 检查一个目录是否存在(不抛错)。
 */
async function dirExists(dir) {
  try {
    const stat = await fsp.stat(dir);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

/**
 * 读 runs/<runId>/steps/<stepId>/tool-trace.jsonl,返回 step-level 工具调用聚合。
 * 单个 step 可能有多条 Agent tool trace 记录，
 * 这里把所有行都吐出来,按时间顺序。
 */
async function loadStepToolTraces(runDir) {
  const stepsDir = path.join(runDir, "steps");
  if (!(await dirExists(stepsDir))) return [];
  const stepNames = await fsp.readdir(stepsDir).catch(() => []);
  const out = [];
  for (const stepId of stepNames) {
    const file = path.join(stepsDir, stepId, "tool-trace.jsonl");
    if (!(await exists(file))) continue;
    let content = "";
    try {
      content = await fsp.readFile(file, "utf8");
    } catch {
      continue;
    }
    const rows = [];
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        rows.push(JSON.parse(trimmed));
      } catch {
        // 损坏行跳过
      }
    }
    if (rows.length) out.push({ stepId, traces: rows });
  }
  // 按最近 trace 的 persistedAt 降序(最新 step 在前,便于 UI 默认展开)
  out.sort((a, b) => {
    const aTime = a.traces[a.traces.length - 1]?.persistedAt || "";
    const bTime = b.traces[b.traces.length - 1]?.persistedAt || "";
    return bTime.localeCompare(aTime);
  });
  return out;
}

/**
 * 读 runs/<runId>/spawns/<spawnId>/trace.jsonl。
 * 子 Agent 原始回答不属于审计 trace，只暴露 digest 与字符计数。
 */
async function loadSpawns(runDir) {
  const spawnsDir = path.join(runDir, "spawns");
  if (!(await dirExists(spawnsDir))) return [];
  const spawnIds = await fsp.readdir(spawnsDir).catch(() => []);
  const out = [];
  for (const spawnId of spawnIds) {
    if (!spawnId.startsWith("spawn_")) continue;
    const traceFile = path.join(spawnsDir, spawnId, "trace.jsonl");
    let trace = null;
    if (await exists(traceFile)) {
      try {
        const content = await fsp.readFile(traceFile, "utf8");
        const lines = content.split("\n").map((l) => l.trim()).filter(Boolean);
        // spawn 一次产生一行;如果异常多次写入,取第一行作为主 trace
        if (lines.length) trace = JSON.parse(lines[0]);
      } catch {
        // 损坏跳过
      }
    }
    out.push({ id: spawnId, trace });
  }
  out.sort((a, b) => {
    const aTime = a.trace?.completedAt || "";
    const bTime = b.trace?.completedAt || "";
    return bTime.localeCompare(aTime);
  });
  return out;
}

/**
 * 读 runs/<runId>/todos.json(TodoStore 落盘格式)。
 */
async function loadTodos(runDir) {
  const file = path.join(runDir, "todos.json");
  const data = await readJson(file, { todos: [] });
  return Array.isArray(data?.todos) ? data.todos : [];
}

/**
 * 检查点 typed handoff(append-only JSONL)。
 */
async function loadCheckpoints(runDir) {
  const file = path.join(runDir, "checkpoints.jsonl");
  if (!(await exists(file))) return [];
  let content;
  try {
    content = await fsp.readFile(file, "utf8");
  } catch {
    return [];
  }
  const rows = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rows.push(JSON.parse(trimmed));
    } catch {}
  }
  return rows;
}

/**
 * 给一个 run 目录返回结构化 timeline。
 *
 * @param {string} runDir
 * @returns {Promise<{
 *   runDir: string,
 *   exists: boolean,
 *   steps: Array<{ stepId: string, traces: any[] }>,
 *   spawns: Array<{ id: string, trace: any }>,
 *   todos: any[],
 *   checkpoints: any[],
 *   summary: {
 *     stepCount: number,
 *     totalToolCalls: number,
 *     spawnCount: number,
 *     todosByStatus: Record<string, number>
 *   }
 * }>}
 */
async function inspectRun(runDir) {
  const empty = {
    runDir,
    exists: false,
    steps: [],
    spawns: [],
    todos: [],
    checkpoints: [],
    summary: emptySummary()
  };
  if (!runDir || !(await dirExists(runDir))) return empty;

  const [steps, spawns, todos, checkpoints] = await Promise.all([
    loadStepToolTraces(runDir),
    loadSpawns(runDir),
    loadTodos(runDir),
    loadCheckpoints(runDir)
  ]);

  return {
    runDir,
    exists: true,
    steps,
    spawns,
    todos,
    checkpoints,
    summary: buildSummary({ steps, spawns, todos })
  };
}

function emptySummary() {
  return {
    stepCount: 0,
    totalToolCalls: 0,
    spawnCount: 0,
    todosByStatus: {}
  };
}

function buildSummary({ steps, spawns, todos }) {
  const summary = emptySummary();
  summary.stepCount = steps.length;
  for (const s of steps) {
    for (const t of s.traces) {
      summary.totalToolCalls += Number(t.toolCallsCount) || 0;
    }
  }
  summary.spawnCount = spawns.length;
  for (const t of todos) {
    const k = t.status || "pending";
    summary.todosByStatus[k] = (summary.todosByStatus[k] || 0) + 1;
  }
  return summary;
}

module.exports = {
  inspectRun,
  // 导出子函数便于细粒度复用 / 单测
  loadStepToolTraces,
  loadSpawns,
  loadTodos,
  loadCheckpoints
};
