import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createApplicationServices } = require("../src/application/appServices.js");

function toolCall(id, name, args) {
  return {
    id,
    type: "function",
    function: { name, arguments: JSON.stringify(args) }
  };
}

function applicationRouter() {
  let round = 0;
  const invoke = (args, continuation) => {
    if (args.title === "Extract Memories 后台 Agent") {
      return {
        content: "NO_MEMORY",
        reasoningContent: "",
        toolCalls: [],
        finishReason: "stop",
        usage: { promptTokens: 10, completionTokens: 1, totalTokens: 11 },
        requestMessages: continuation
          ? args.messages
          : [{ role: "user", content: args.input || "" }],
        assistantMessage: { role: "assistant", content: "NO_MEMORY" },
        provider: { id: "test", baseUrl: "local" },
        model: "test-model",
        settings: {},
        taskType: "memory",
        modelContextTokens: 128000,
        maxTokens: 4096
      };
    }
    let content = "";
    let toolCalls = [];
    if (round === 0) {
      toolCalls = [toolCall("write-report", "write", {
        workspace: "artifact",
        path: "report.md",
        content: "# 验证报告\n\n这是唯一的最终产物。\n",
        deliverable: true
      })];
    } else if (round === 1) {
      content = "报告已经完成。";
    } else if (round === 2) {
      assert.match(JSON.stringify(args.messages || []), /尚未完成交付闭环/);
      toolCalls = [toolCall("inspect-report", "inspect_artifact", { path: "report.md" })];
    } else if (round === 3) {
      const inspectionId = JSON.stringify(args.messages || []).match(/inspection_[a-f0-9]{24}/)?.[0];
      assert.ok(inspectionId, "检查结果必须回填给同一个 Agent 回合");
      toolCalls = [toolCall("publish-report", "publish_artifact", {
        path: "report.md",
        inspectionId,
        title: "验证报告"
      })];
    } else {
      content = "报告已经检查并发布。";
    }
    round += 1;
    return {
      content,
      reasoningContent: "",
      toolCalls,
      finishReason: toolCalls.length ? "tool_calls" : "stop",
      usage: { promptTokens: 20, completionTokens: 5, totalTokens: 25 },
      requestMessages: continuation
        ? args.messages
        : [{ role: "user", content: args.input || "" }],
      assistantMessage: {
        role: "assistant",
        content: content || null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {})
      },
      provider: { id: "test", baseUrl: "local" },
      model: "test-model",
      settings: {},
      taskType: "agent",
      modelContextTokens: 128000,
      maxTokens: 8192
    };
  };
  return {
    get rounds() {
      return round;
    },
    async runTaskDetailed(args) {
      return invoke(args, false);
    },
    async continueTaskDetailed(args) {
      return invoke(args, true);
    }
  };
}

test("真实应用组合只把经过检查与发布的文件登记为任务成品", async () => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "yaoguo-app-services-"));
  const router = applicationRouter();
  let services = null;
  try {
    services = await createApplicationServices({
      projectRoot,
      memdirBaseDirectory: path.join(projectRoot, "memdir-home"),
      aiRouter: router,
      startBackgroundServices: false,
      requestToolApproval: async () => ({ decision: "allow_session" }),
      shellSandboxFactory: async () => ({
        tempDir: tmpdir(),
        wrap: async (command) => command,
        cleanupAfterCommand() {},
        async cleanup() {}
      })
    });
    assert.ok(services.memoryPrefetchService, "生产服务组合必须装配异步记忆 Prefetch");
    assert.ok(services.memoryExtractionService, "生产服务组合必须装配后台 Extract Memories Agent");
    assert.ok(services.autoDreamService, "生产服务组合必须装配 AutoDream 离线整合服务");
    assert.ok(services.sessionMemoryService, "生产服务组合必须装配渐进式 Session Memory");
    const project = await services.projectService.createProject({ name: "集成验证项目" });
    const task = await services.projectService.createTask(project.id, { title: "交付闭环验证" });

    const result = await services.workflowEngine.submitAgentInput({
      message: "生成一份验证报告",
      projectId: project.id,
      taskId: task.id,
      turnId: "integration-turn"
    });

    assert.equal(result.reply, "报告已经检查并发布。");
    assert.equal(router.rounds, 5);
    assert.equal(result.artifacts.length, 1);
    const files = await services.projectService.listTaskFiles(project.id, task.id);
    assert.equal(files.length, 1);
    assert.equal(files[0].absolute, result.artifacts[0].absolute);
    assert.match(files[0].absolute, /\/final\/report\.md$/);
    assert.match(files[0].sha256, /^[a-f0-9]{64}$/);
    assert.equal(files[0].sha256, result.artifacts[0].sha256);
    assert.match(files[0].inspectionId, /^inspection_[a-f0-9]{24}$/);
    assert.equal(await readFile(files[0].absolute, "utf8"), "# 验证报告\n\n这是唯一的最终产物。\n");
    await assert.rejects(
      access(path.join(projectRoot, "workspace", "chats")),
      /ENOENT/,
      "全新应用不应为旧 Chat 迁移主动创建存储目录"
    );
  } finally {
    await services?.memoryExtractionService?.stop?.();
    await services?.autoDreamService?.stop?.();
    await services?.sessionMemoryService?.stop?.();
    await rm(projectRoot, { recursive: true, force: true });
  }
});
