#!/usr/bin/env node
// scripts/inspect-run.mjs <runDir>
//
// Pretty-print 一个 run 目录的 agent 工具调用 timeline:
//   - step 工具调用统计
//   - spawn_subagent 委派概要
//   - todos 状态分布
//   - typed handoff checkpoints
//
// 用法:
//   node scripts/inspect-run.mjs workspace/projects/<projectId>/tasks/<taskId>/runs/<runId>

import { createRequire } from "node:module";
import process from "node:process";

const require = createRequire(import.meta.url);
const { inspectRun } = require("../src/platform/runs/runInspector.js");

// ANSI 颜色(支持禁用)
const SUPPORTS_COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const c = SUPPORTS_COLOR
  ? {
      dim: (s) => `\x1b[2m${s}\x1b[0m`,
      bold: (s) => `\x1b[1m${s}\x1b[0m`,
      cyan: (s) => `\x1b[36m${s}\x1b[0m`,
      green: (s) => `\x1b[32m${s}\x1b[0m`,
      yellow: (s) => `\x1b[33m${s}\x1b[0m`,
      red: (s) => `\x1b[31m${s}\x1b[0m`,
      blue: (s) => `\x1b[34m${s}\x1b[0m`,
      magenta: (s) => `\x1b[35m${s}\x1b[0m`
    }
  : {
      dim: (s) => s, bold: (s) => s, cyan: (s) => s,
      green: (s) => s, yellow: (s) => s, red: (s) => s,
      blue: (s) => s, magenta: (s) => s
    };

function statusColor(status) {
  if (status === "applied" || status === "done" || status === "completed") return c.green;
  if (status === "rejected" || status === "cancelled" || status === "blocked") return c.red;
  if (status === "in_progress") return c.cyan;
  return c.yellow;
}

function truncate(s, n) {
  const str = `${s || ""}`;
  if (str.length <= n) return str;
  return `${str.slice(0, n)}…`;
}

async function main() {
  const runDir = process.argv[2];
  if (!runDir) {
    console.error("Usage: node scripts/inspect-run.mjs <runDir>");
    console.error("  e.g. node scripts/inspect-run.mjs workspace/projects/foo/tasks/bar/runs/baz");
    process.exit(1);
  }

  const data = await inspectRun(runDir);
  if (!data.exists) {
    console.log(c.red(`× runDir 不存在或不是目录: ${runDir}`));
    process.exit(2);
  }

  console.log(c.bold(c.cyan(`\n── Run Inspector ──`)));
  console.log(c.dim(`runDir: ${data.runDir}`));

  // 顶级 summary
  const s = data.summary;
  console.log(c.bold("\n── 总览 ──"));
  console.log(`  steps         ${c.bold(s.stepCount)}    工具调用总数 ${c.bold(s.totalToolCalls)}`);
  console.log(`  spawns        ${c.bold(s.spawnCount)}`);
  const todoLine = Object.entries(s.todosByStatus)
    .map(([k, v]) => `${statusColor(k)(k)} ${c.bold(v)}`)
    .join(" / ") || c.dim("(无)");
  console.log(`  todos         ${todoLine}`);
  console.log(`  checkpoints   ${c.bold(data.checkpoints.length)}`);

  // Steps
  if (data.steps.length) {
    console.log(c.bold("\n── Steps(按最新优先)──"));
    for (const stepEntry of data.steps) {
      const lastTrace = stepEntry.traces[stepEntry.traces.length - 1] || {};
      const callCount = stepEntry.traces.reduce((sum, t) => sum + (t.toolCallsCount || 0), 0);
      console.log(
        `  ${c.cyan(stepEntry.stepId)}  ${c.dim(`(${stepEntry.traces.length} trace,${callCount} 工具调用,exhausted=${lastTrace.exhausted ? "Y" : "N"})`)}`
      );
      // 列每个 trace 里的 toolCalls
      for (const trace of stepEntry.traces) {
        for (const tc of (trace.toolCalls || [])) {
          const okMark = tc.ok ? c.green("✓") : c.red("✗");
          const argsStr = truncate(JSON.stringify(tc.args || {}), 80);
          console.log(`    ${okMark} ${c.magenta(tc.name)} ${c.dim(argsStr)}`);
          if (!tc.ok && tc.error) {
            console.log(`        ${c.red("ERROR:")} ${truncate(tc.error, 200)}`);
          } else if (tc.valuePreview) {
            console.log(`        ${c.dim(truncate(tc.valuePreview.replace(/\n/g, " "), 200))}`);
          }
        }
      }
    }
  }

  // Spawns
  if (data.spawns.length) {
    console.log(c.bold("\n── Spawns ──"));
    for (const sp of data.spawns) {
      const t = sp.trace || {};
      console.log(`  ${c.magenta(sp.id)}  ${c.dim(`from ${t.spawnedByStepId || "?"} / ${t.spawnedByTaskType || "?"}`)}`);
      console.log(`    purpose:  ${truncate(t.purpose, 80)}`);
      console.log(`    rounds:   ${t.rounds || 0}/${t.maxRounds || "?"}${t.exhausted ? c.yellow("(exhausted)") : ""}`);
      console.log(`    tools:    ${(t.allowedTools || []).join(", ")}`);
      console.log(`    output:   ${truncate(sp.output.replace(/\n/g, " "), 100)}`);
      const subCalls = (t.toolCalls || []).map((tc) => tc.name).join(", ");
      if (subCalls) console.log(`    子调用:   ${c.dim(subCalls)}`);
    }
  }

  // Todos
  if (data.todos.length) {
    console.log(c.bold("\n── Todos ──"));
    for (const t of data.todos) {
      const statusFn = statusColor(t.status);
      console.log(
        `  ${statusFn(t.status.padEnd(12))} ${(t.priority || "").padEnd(6)} ${c.bold(truncate(t.text, 80))}`
      );
      if (t.blockedReason) console.log(c.dim(`    blocked: ${truncate(t.blockedReason, 100)}`));
      if (t.parentId) console.log(c.dim(`    parent: ${t.parentId}`));
    }
  }

  // Checkpoints
  if (data.checkpoints.length) {
    console.log(c.bold("\n── Typed Handoff Checkpoints ──"));
    for (const cp of data.checkpoints) {
      const h = cp.handoff || {};
      const parts = [];
      if (h.decisions?.length) parts.push(`decisions=${h.decisions.length}`);
      if (h.rejected?.length) parts.push(`rejected=${h.rejected.length}`);
      if (h.openQuestions?.length) parts.push(`open=${h.openQuestions.length}`);
      if (h.facts?.length) parts.push(`facts=${h.facts.length}`);
      console.log(`  ${c.cyan(cp.stepId || "?")}  ${c.dim(parts.join(" / ") || "(空)")}`);
    }
  }

  console.log("");
}

main().catch((err) => {
  console.error(c.red(`Inspector 失败:${err?.message || err}`));
  process.exit(3);
});
