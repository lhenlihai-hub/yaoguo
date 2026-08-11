import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  resolveAgentLoopContextPolicy,
  buildToolResultMessageContent,
  buildCheckpointPayload,
  clearOldToolResults,
  editAgentLoopContext
} = require("../src/platform/context/agentContextLifecycle.js");
const { estimateRequestTokens } = require("../src/platform/tokens/tokenEstimator.js");

test("resolveAgentLoopContextPolicy 为百万上下文采用 10 万 Session Memory 压缩线", () => {
  const million = resolveAgentLoopContextPolicy({
    modelContextTokens: 1_000_000,
    outputReserveTokens: 8192,
    settings: { context: { agentLoop: {} } }
  });
  const compact = resolveAgentLoopContextPolicy({
    modelContextTokens: 32_000,
    outputReserveTokens: 4096,
    settings: { context: { agentLoop: {} } }
  });

  assert.equal(million.triggerTokens, 100_000);
  assert.equal(million.clearStartTokens, 72_000);
  assert.ok(compact.triggerTokens < million.triggerTokens);

  const overridden = resolveAgentLoopContextPolicy({
    modelContextTokens: 128_000,
    outputReserveTokens: 6000
  }, {
    triggerTokens: 9000,
    clearStartTokens: 5000
  });
  assert.equal(overridden.triggerTokens, 9000);
  assert.equal(overridden.clearStartTokens, 5000);
  assert.ok(overridden.hardInputTokens > overridden.triggerTokens);
});

test("buildToolResultMessageContent 小结果原样内联，大结果只传有引用的 receipt", () => {
  const policy = { inlineToolResultTokens: 20, toolResultPreviewTokens: 20 };
  const record = {
    toolName: "lookup",
    resultRef: `ctxr_${"a".repeat(64)}`,
    totalChars: 50_000,
    totalTokens: 30_000,
    preview: "已验证开头".repeat(100)
  };

  assert.equal(buildToolResultMessageContent({ ok: true }, record, policy), "{\"ok\":true}");
  const receipt = JSON.parse(buildToolResultMessageContent("长结果".repeat(200), record, policy));
  assert.equal(receipt.contextEdited, true);
  assert.equal(receipt.resultRef, record.resultRef);
  assert.ok(receipt.preview.length < record.preview.length);
  assert.match(receipt.read, /read_context_result/);
});

test("clearOldToolResults 只清理旧轮结果，保留最近工具组与协议顺序", () => {
  const records = [
    { round: 0, callId: "old", toolName: "lookup", resultRef: `ctxr_${"1".repeat(64)}`, preview: "old", cleared: false },
    { round: 2, callId: "recent-a", toolName: "lookup", resultRef: `ctxr_${"2".repeat(64)}`, preview: "a", cleared: false },
    { round: 3, callId: "recent-b", toolName: "lookup", resultRef: `ctxr_${"3".repeat(64)}`, preview: "b", cleared: false }
  ];
  const messages = [
    { role: "user", content: "task" },
    { role: "tool", tool_call_id: "old", content: "OLD-FULL-RESULT" },
    { role: "tool", tool_call_id: "recent-a", content: "RECENT-A" },
    { role: "tool", tool_call_id: "recent-b", content: "RECENT-B" }
  ];

  const edited = clearOldToolResults({
    messages,
    records,
    currentRound: 3,
    policy: { keepRecentToolGroups: 2, checkpointPreviewChars: 200 }
  });

  assert.deepEqual(edited.clearedCallIds, ["old"]);
  assert.deepEqual(edited.messages.map((message) => message.role), messages.map((message) => message.role));
  assert.match(edited.messages[1].content, /read_context_result/);
  assert.equal(edited.messages[2].content, "RECENT-A");
  assert.equal(edited.messages[3].content, "RECENT-B");
  assert.equal(records[0].cleared, true);
});

test("clearOldToolResults 直接编辑 Pi 的 toolResult 消息格式", () => {
  const record = {
    round: 0,
    callId: "pi-old",
    toolName: "read",
    resultRef: `ctxr_${"9".repeat(64)}`,
    preview: "旧工具正文",
    cleared: false
  };
  const messages = [
    { role: "user", content: "task", timestamp: 1 },
    {
      role: "toolResult",
      toolCallId: "pi-old",
      toolName: "read",
      content: [{ type: "text", text: "PI-FULL-RESULT" }],
      timestamp: 2
    }
  ];
  const edited = clearOldToolResults({
    messages,
    records: [record],
    currentRound: 3,
    policy: { keepRecentToolGroups: 1, toolResultPreviewTokens: 200 }
  });

  assert.deepEqual(edited.clearedCallIds, ["pi-old"]);
  assert.equal(edited.messages[1].role, "toolResult");
  assert.equal(edited.messages[1].content[0].type, "text");
  assert.match(edited.messages[1].content[0].text, /read_context_result/);
});

test("editAgentLoopContext 超额后从 root + 确定性 checkpoint 开新 episode", () => {
  const rootMessages = [{ role: "user", content: "完成初始任务" }];
  const records = [{
    round: 0,
    callId: "c1",
    toolName: "lookup",
    args: { query: "可验证事实" },
    ok: true,
    resultRef: `ctxr_${"4".repeat(64)}`,
    preview: "找到三条可核验证据",
    cleared: false
  }];
  const reasoning = `REASONING-SENTINEL-${"推理".repeat(20_000)}`;
  const messages = [
    ...rootMessages,
    {
      role: "assistant",
      content: null,
      reasoning_content: reasoning,
      tool_calls: [{
        id: "c1",
        type: "function",
        function: { name: "lookup", arguments: "{\"query\":\"可验证事实\"}" }
      }]
    },
    { role: "tool", tool_call_id: "c1", content: "找到三条可核验证据" }
  ];
  const tools = [{ type: "function", function: { name: "lookup", description: "检索证据" } }];
  const policy = {
    enabled: true,
    triggerTokens: 4000,
    clearStartTokens: 3000,
    keepRecentToolGroups: 1,
    checkpointMaxEvents: 8,
    checkpointArgumentChars: 300,
    checkpointPreviewChars: 300
  };

  const edited = editAgentLoopContext({
    messages,
    tools,
    rootMessages,
    records,
    currentRound: 0,
    episode: 0,
    policy
  });

  assert.equal(edited.beforeTokens, estimateRequestTokens({ messages, tools }));
  assert.equal(edited.checkpointed, true);
  assert.equal(edited.episode, 1);
  assert.equal(edited.messages.length, 2);
  assert.deepEqual(edited.messages[0], rootMessages[0]);
  assert.match(edited.messages[1].content, /AGENT_CONTEXT_CHECKPOINT/);
  assert.match(edited.messages[1].content, new RegExp(records[0].resultRef));
  assert.ok(!edited.messages[1].content.includes("REASONING-SENTINEL"));
  assert.ok(edited.afterTokens < edited.beforeTokens);
});

test("checkpoint 为超过详细窗口的全部早期工具结果保留可回读引用", () => {
  const records = Array.from({ length: 32 }, (_item, index) => ({
    round: index,
    toolName: "lookup",
    args: { query: `evidence-${index}` },
    ok: true,
    resultRef: `ctxr_${String(index).padStart(64, "0")}`,
    preview: `result-${index}`
  }));
  const payload = buildCheckpointPayload({
    records,
    policy: { checkpointMaxEvents: 24, checkpointArgumentChars: 300, checkpointPreviewChars: 300 }
  });

  assert.equal(payload.completedActions.length, 24);
  assert.equal(payload.archivedActionIndex.length, 8);
  assert.equal(payload.omittedEarlierActions, 0);
  const refs = [...payload.archivedActionIndex, ...payload.completedActions].map((item) => item.resultRef);
  assert.deepEqual(refs, records.map((item) => item.resultRef));
});
