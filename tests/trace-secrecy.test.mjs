import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const agentExecutionActions = require("../src/application/workflows/mixins/agentExecutionActions.js");
const {
  AgentToolRegistry,
  runToolLoop
} = require("../src/platform/ai/agentTools/index.js");

const SENTINEL = "trace_secret_7c9f2b";

function toolCall(id, name, args) {
  return {
    id,
    type: "function",
    function: { name, arguments: JSON.stringify(args) }
  };
}

function createDetailedRouter(responder) {
  let round = 0;
  const invoke = async (args, continuation) => {
    const value = await responder(round++, args, continuation);
    const content = typeof value === "string" ? value : `${value?.content || ""}`;
    const toolCalls = Array.isArray(value?.toolCalls) ? value.toolCalls : [];
    return {
      content,
      toolCalls,
      finishReason: toolCalls.length ? "tool_calls" : "stop",
      requestMessages: continuation
        ? (args.messages || [])
        : [{ role: "user", content: args.input || "" }],
      assistantMessage: {
        role: "assistant",
        content: content || null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {})
      }
    };
  };
  return {
    runTaskDetailed: (args) => invoke(args, false),
    continueTaskDetailed: (args) => invoke(args, true)
  };
}

function makeTraceHost() {
  class TraceHost {}
  Object.assign(TraceHost.prototype, agentExecutionActions);
  return new TraceHost();
}

async function collectTraceFiles(root) {
  const files = [];
  const visit = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolute);
      } else if (["tool-trace.jsonl", "trace.jsonl"].includes(entry.name)) {
        files.push(absolute);
      }
    }
  };
  await visit(root);
  return files.sort();
}

function collectKeys(value, out = new Set()) {
  if (!value || typeof value !== "object") return out;
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, out);
    return out;
  }
  for (const [key, child] of Object.entries(value)) {
    out.add(key);
    collectKeys(child, out);
  }
  return out;
}

test("Agent 运行期保留工具原值，JSON trace 不枚举参数、结果或错误正文", async () => {
  const runDir = mkdtempSync(path.join(tmpdir(), "yaoguo-trace-runtime-"));
  const registry = new AgentToolRegistry();
  registry.register({
    schema: {
      type: "function",
      function: {
        name: "leaky_probe",
        description: "trace 安全回归工具",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string" },
            prompt: { type: "string" }
          },
          required: ["url", "prompt"],
          additionalProperties: false
        }
      }
    },
    execute: async () => {
      throw new Error(`上游错误正文 ${SENTINEL}`);
    }
  });
  const aiRouter = createDetailedRouter(async (round) => round === 0
    ? {
      toolCalls: [toolCall("leaky-1", "leaky_probe", {
        url: `https://example.test/private?token=${SENTINEL}`,
        prompt: `原始 prompt ${SENTINEL}`
      })]
    }
    : "已安全收束");

  try {
    const result = await runToolLoop({
      aiRouter,
      registry,
      toolNames: ["leaky_probe"],
      baseToolNames: [],
      toolCtx: { runDir },
      maxRounds: 2
    });

    assert.equal(result.toolCalls[0].args.prompt, `原始 prompt ${SENTINEL}`);
    assert.match(result.toolCalls[0].result.error, new RegExp(SENTINEL));
    assert.match(result.toolCalls[0].argsDigest, /^[a-f0-9]{64}$/);
    assert.match(result.toolCalls[0].targetDigest, /^[a-f0-9]{64}$/);

    const toolTraceJson = JSON.stringify(result.toolCalls);
    assert.equal(toolTraceJson.includes(SENTINEL), false);
    assert.equal(toolTraceJson.includes('"args"'), false);
    assert.equal(toolTraceJson.includes('"result"'), false);
    assert.equal(toolTraceJson.includes('"error"'), false);

    const contextJson = JSON.stringify(result.contextStats);
    assert.equal(contextJson.includes(SENTINEL), false);
    assert.equal(contextJson.includes("resultRecords"), false);
    assert.equal(contextJson.includes("valuePreview"), false);
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
});

test("秘密哨兵遍历主/子 Agent 磁盘 trace：只允许安全元数据、digest 与 ref", async () => {
  const runDir = mkdtempSync(path.join(tmpdir(), "yaoguo-trace-disk-"));
  const host = makeTraceHost();
  const rawCommand = `curl 'https://example.test/private?token=${SENTINEL}'`;
  const rawResult = {
    ok: false,
    code: "TOOL_EXECUTION_FAILED",
    error: `远程错误正文 ${SENTINEL}`,
    valuePreview: `结果预览 ${SENTINEL}`
  };

  try {
    await host._persistAgentTrace({
      projectId: "project-safe",
      taskId: "task-safe",
      runId: "run-safe",
      runDir,
      stepId: "step-safe",
      turnId: "turn-safe",
      toolNames: ["bash"],
      result: {
        rounds: 1,
        exhausted: false,
        aborted: false,
        stopCode: "",
        contextStats: {
          episodes: 1,
          storedResults: 1,
          availableTools: ["bash"],
          resultRecords: [{ valuePreview: SENTINEL }],
          secretExtension: SENTINEL,
          executionBudget: {
            modelCalls: 1,
            toolCalls: 1,
            stopCode: "",
            error: SENTINEL
          },
          edits: [{ round: 0, beforeTokens: 10, secretExtension: SENTINEL }],
          instructionMemory: {
            digest: "a".repeat(64),
            tokens: 42,
            sources: [`project:${SENTINEL}/YAOGUO.md`],
            diagnostics: [{ code: "INSTRUCTION_PAT_INVALID", detail: SENTINEL }]
          }
        },
        toolCalls: [{
          round: 0,
          name: "bash",
          args: { command: rawCommand, prompt: `命令 prompt ${SENTINEL}` },
          target: rawCommand,
          ok: false,
          result: rawResult,
          valuePreview: `外层预览 ${SENTINEL}`,
          artifactPath: `/private/${SENTINEL}.txt`
        }]
      },
      traceRows: [{
        round: 0,
        prompt: SENTINEL,
        toolCalls: [{
          name: "bash",
          argsRaw: SENTINEL,
          function: { arguments: JSON.stringify({ command: rawCommand }) }
        }]
      }]
    });

    await host._persistSpawnTrace({
      runDir,
      stepId: "step-safe",
      taskType: "agent"
    }, {
      purpose: `子任务目的 ${SENTINEL}`,
      prompt: `子任务 prompt ${SENTINEL}`,
      finalText: `子 Agent 输出 ${SENTINEL}`,
      allowedTools: ["bash"],
      deniedTools: [SENTINEL],
      maxRounds: 2,
      rounds: 1,
      exhausted: false,
      contextStats: {
        episodes: 1,
        availableTools: ["bash"],
        secretExtension: SENTINEL,
        resultRecords: [{ preview: SENTINEL }]
      },
      rounds_outline: [{
        round: 0,
        toolCalls: [{ name: "bash", arguments: rawCommand, prompt: SENTINEL }]
      }],
      toolCallsTrace: [{
        round: 0,
        name: "bash",
        args: { command: rawCommand, prompt: SENTINEL },
        target: rawCommand,
        result: rawResult,
        valuePreview: SENTINEL
      }]
    });

    const traceFiles = await collectTraceFiles(runDir);
    assert.equal(traceFiles.length, 2);
    const forbiddenKeys = new Set([
      "args", "arguments", "argsRaw", "result", "error", "preview", "valuePreview",
      "prompt", "purpose", "finalText", "output", "command", "url", "target",
      "artifactPath", "content", "text", "message", "input", "resultRecords", "deniedTools"
    ]);

    for (const file of traceFiles) {
      const content = await readFile(file, "utf8");
      assert.equal(content.includes(SENTINEL), false, file);
      assert.equal(content.includes("token="), false, file);
      assert.equal(content.includes("example.test"), false, file);
      for (const line of content.split("\n").map((item) => item.trim()).filter(Boolean)) {
        const row = JSON.parse(line);
        for (const key of collectKeys(row)) {
          assert.equal(forbiddenKeys.has(key), false, `${file} 不应持久化字段 ${key}`);
        }
      }
    }

    const stepTrace = JSON.parse((await readFile(traceFiles.find((file) => file.endsWith("tool-trace.jsonl")), "utf8")).trim());
    assert.match(stepTrace.toolCalls[0].argsDigest, /^[a-f0-9]{64}$/);
    assert.match(stepTrace.toolCalls[0].targetDigest, /^[a-f0-9]{64}$/);
    assert.match(stepTrace.toolCalls[0].resultDigest, /^[a-f0-9]{64}$/);
    assert.equal(stepTrace.context.secretExtension, undefined);
    assert.equal(stepTrace.context.executionBudget.error, undefined);
    assert.equal(stepTrace.context.instructionMemory.tokens, 42);
    assert.equal(stepTrace.context.instructionMemory.sourceCount, 1);
    assert.deepEqual(stepTrace.context.instructionMemory.diagnosticCodes, ["INSTRUCTION_PAT_INVALID"]);
    assert.match(stepTrace.context.instructionMemory.sourceDigests[0], /^[a-f0-9]{64}$/);

    const spawnRoot = path.join(runDir, "spawns");
    const spawnIds = await readdir(spawnRoot);
    const spawnDir = path.join(spawnRoot, spawnIds[0]);
    await assert.rejects(readFile(path.join(spawnDir, "output.md"), "utf8"), { code: "ENOENT" });
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
});
