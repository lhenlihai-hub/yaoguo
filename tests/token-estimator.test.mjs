import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  estimateTokens,
  estimateMessageTokens,
  estimateToolSchemasTokens,
  estimateRequestTokens
} = require("../src/platform/tokens/tokenEstimator.js");

test("estimateMessageTokens 保持普通文本消息的旧基准", () => {
  const content = "你好 DeepSeek";
  assert.equal(
    estimateMessageTokens([{ role: "user", content }]),
    estimateTokens(content) + 6
  );
});

test("estimateMessageTokens 计入多模态 content 的文本与结构", () => {
  const textOnly = estimateMessageTokens([{ role: "user", content: "分析图片" }]);
  const multimodal = estimateMessageTokens([{
    role: "user",
    content: [
      { type: "text", text: "分析图片" },
      { type: "image_url", image_url: { url: "https://example.com/chart.png", detail: "high" } }
    ]
  }]);

  assert.ok(multimodal > textOnly);
});

test("estimateMessageTokens 计入 reasoning_content", () => {
  const base = estimateMessageTokens([{ role: "assistant", content: "结论" }]);
  const withReasoning = estimateMessageTokens([{
    role: "assistant",
    reasoning_content: "先核对来源，再比较两个方案的约束。",
    content: "结论"
  }]);

  assert.ok(withReasoning > base);
});

test("estimateMessageTokens 计入 tool_calls 的 id、name 和 arguments", () => {
  const emptyCall = {
    role: "assistant",
    content: null,
    tool_calls: [{ type: "function", function: {} }]
  };
  const withId = {
    ...emptyCall,
    tool_calls: [{ id: "call_123456789", type: "function", function: {} }]
  };
  const withName = {
    ...emptyCall,
    tool_calls: [{ type: "function", function: { name: "read_reference" } }]
  };
  const withArguments = {
    ...emptyCall,
    tool_calls: [{ type: "function", function: { arguments: "{\"referenceId\":\"ref_123\",\"offsetChars\":12000}" } }]
  };

  const baseline = estimateMessageTokens([emptyCall]);
  assert.ok(estimateMessageTokens([withId]) > baseline);
  assert.ok(estimateMessageTokens([withName]) > baseline);
  assert.ok(estimateMessageTokens([withArguments]) > baseline);
});

test("estimateMessageTokens 计入工具结果的 tool_call_id 和 name", () => {
  const base = estimateMessageTokens([{ role: "tool", content: "ok" }]);
  const withCallId = estimateMessageTokens([{
    role: "tool",
    content: "ok",
    tool_call_id: "call_987654321"
  }]);
  const withName = estimateMessageTokens([{
    role: "tool",
    content: "ok",
    name: "read_reference"
  }]);

  assert.ok(withCallId > base);
  assert.ok(withName > base);
});

test("estimateToolSchemasTokens 计入工具 schema 全量结构", () => {
  const minimal = [{ type: "function", function: { name: "lookup" } }];
  const detailed = [{
    type: "function",
    function: {
      name: "lookup",
      description: "从可验证来源中查找信息",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "检索词" }
        },
        required: ["query"]
      }
    }
  }];

  assert.equal(estimateToolSchemasTokens(), 0);
  assert.ok(estimateToolSchemasTokens(minimal) > 0);
  assert.ok(estimateToolSchemasTokens(detailed) > estimateToolSchemasTokens(minimal));
});

test("estimateRequestTokens 统一计入 messages 与 tools", () => {
  const request = {
    messages: [{ role: "user", content: "读取这份参考资料" }],
    tools: [{
      type: "function",
      function: {
        name: "read_reference",
        parameters: { type: "object", properties: { referenceId: { type: "string" } } }
      }
    }]
  };

  assert.equal(
    estimateRequestTokens(request),
    estimateMessageTokens(request.messages) + estimateToolSchemasTokens(request.tools)
  );
  assert.ok(estimateRequestTokens(request) > estimateMessageTokens(request.messages));
});
