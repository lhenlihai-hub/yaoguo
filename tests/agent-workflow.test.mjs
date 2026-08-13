import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const require = createRequire(import.meta.url);
const { WorkflowEngine } = require("../src/application/workflows/workflowEngine.js");

function detailedRouter(responder) {
  let round = 0;
  const invoke = async (args, continuation) => {
    const value = await responder(round++, args, continuation);
    const content = typeof value === "string" ? value : `${value?.content || ""}`;
    const toolCalls = Array.isArray(value?.toolCalls) ? value.toolCalls : [];
    return {
      content,
      toolCalls,
      taskType: continuation ? args.base?.taskType : args.taskType,
      title: continuation ? args.base?.title : args.title,
      requestMessages: continuation ? args.messages : [{ role: "user", content: args.input || "" }],
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

function toolCall(id, name, args = {}) {
  return {
    id,
    type: "function",
    function: { name, arguments: JSON.stringify(args) }
  };
}

function createWorkflowHarness() {
  const engine = Object.create(WorkflowEngine.prototype);
  engine.paths = {};
  engine.settingsService = {
    get: async () => ({ context: { compaction: { enabled: false, agentHistoryReadLimit: 20, agentHistoryTokens: 4000 } } })
  };
  engine.toolPermissionService = {
    authorize: async () => ({ allow: true, decision: "allow_once" })
  };
  engine.projectService = {
    getProject: async () => ({ id: "p1", type: "general" }),
    getTaskDir: () => join(tmpdir(), "yaoguo-agent-workflow-task")
  };
  engine.appendedLogs = [];
  engine.appendAgentMessage = async (row) => {
    engine.appendedLogs.push(row);
    return row;
  };
  engine.listAgentMessages = async () => engine.appendedLogs;
  engine.scheduleAutoNameFromFirstMessage = () => {};
  engine.buildAgentContext = async () => "";
  engine.renderNarrativeCorePinnedContext = async () => "";
  return engine;
}

test("身份与能力问题进入同一个模型回合，不由宿主即时回复覆盖 Soul", async () => {
  const engine = createWorkflowHarness();
  let modelCalls = 0;
  engine.aiRouter = detailedRouter(async (_round, payload) => {
      modelCalls += 1;
      assert.equal(payload.taskType, "agent");
      assert.equal(payload.instruction, "");
      return "我是腰果，可以结合当前可用能力和你一起把事情完成。";
  });

  const result = await engine.submitAgentInput({ message: "你是谁？", projectId: "p1", taskId: "t1" });

  assert.equal(modelCalls, 1);
  assert.match(result.reply, /腰果/);
  assert.equal(result.source, undefined);
  assert.deepEqual(engine.appendedLogs.map((row) => row.role), ["user", "assistant"]);
});

test("终端输入向模型声明 TUI 宿主边界，不混入桌面成品区认知", async () => {
  const engine = createWorkflowHarness();
  let captured = null;
  engine.aiRouter = detailedRouter(async (_round, payload) => {
    captured = payload.runContext;
    return "已按终端环境回答。";
  });

  await engine.submitAgentInput({
    message: "删除这个文件",
    projectId: "p1",
    taskId: "t1",
    source: "terminal"
  });

  assert.match(captured, /当前宿主】终端版 TUI/);
  assert.match(captured, /当前没有桌面窗口或预览面板/);
});

test("Agent 持久化真实首轮模型输入，下一轮可原样复用缓存前缀", async () => {
  const engine = createWorkflowHarness();
  let persistedBody = "";
  engine.taskSessionStore = {
    async persistContentBody(_projectId, _taskId, content) {
      persistedBody = content;
      return { sha256: "b".repeat(64) };
    }
  };
  await engine.persistAgentTurnOutcome({
    outcome: {
      reply: "完成。会保存模型输入。",
      modelInput: "【本轮上下文】\n动态上下文\n\n【输入】\n执行任务"
    },
    projectId: "p1",
    taskId: "t1",
    turnId: "turn-1",
    source: "terminal"
  });

  assert.match(persistedBody, /动态上下文[\s\S]*执行任务/);
  assert.deepEqual(engine.appendedLogs.at(-1).modelInputRef, {
    version: 1,
    sha256: "b".repeat(64)
  });
});

test("Agent 的 skipUserLog / skipAssistantLog 选项真实生效", async () => {
  const engine = createWorkflowHarness();
  engine.aiRouter = detailedRouter(async () => "仅返回调用方，不写任务消息记录。");

  const result = await engine.submitAgentInput(
    { message: "内部续跑", projectId: "p1", taskId: "t1" },
    { skipUserLog: true, skipAssistantLog: true }
  );

  assert.equal(result.reply, "仅返回调用方，不写任务消息记录。");
  assert.deepEqual(engine.appendedLogs, []);
});

test("Agent 不在模型前运行内容分类器或自动决策门", async () => {
  const engine = createWorkflowHarness();
  engine.enforceContentRequestGate = async () => { throw new Error("不应自动拦截"); };
  engine.aiRouter = detailedRouter(async () => "我会根据当前上下文处理。");

  const result = await engine.submitAgentInput({ message: "继续", projectId: "p1", taskId: "t1" });

  assert.equal(result.reply, "我会根据当前上下文处理。");
});

test("Agent 复杂任务超过十二轮工具调用后仍继续到最终可见结果", async () => {
  const engine = createWorkflowHarness();
  const advertisedCounts = [];
  engine.aiRouter = detailedRouter(async (round, payload) => {
    const advertised = Array.isArray(payload.tools) ? payload.tools.length : 0;
    advertisedCounts.push(advertised);
    if (!advertised) {
      return [
        "<｜｜DSML｜｜tool_calls>",
        "<｜｜DSML｜｜invoke name=\"probe\">",
        "</｜｜DSML｜｜invoke>",
        "</｜｜DSML｜｜tool_calls>"
      ].join("\n");
    }
    if (round < 14) {
      return { toolCalls: [toolCall(`probe-${round}`, "probe", { round })] };
    }
    return "任务已完成，最终产物已保留。";
  });

  const result = await engine.submitAgentInput({
    message: "完成一个需要多轮文件操作的任务",
    projectId: "p1",
    taskId: "t1"
  });

  assert.equal(advertisedCounts.length, 15);
  assert.ok(advertisedCounts.every((count) => count > 0), "工具循环期间不得静默移除工具");
  assert.equal(result.reply, "任务已完成，最终产物已保留。");
  assert.equal(engine.appendedLogs.at(-1).content, result.reply);
});

test("Agent 只登记明确发布的最终文件，不把构建脚本算成结果", async () => {
  const taskDir = await mkdtemp(join(tmpdir(), "yaoguo-agent-file-artifact-"));
  try {
    const engine = createWorkflowHarness();
    engine.projectService = {
      getProject: async () => ({ id: "p1", type: "general" }),
      getTaskDir: () => taskDir,
      getTask: async () => ({ id: "t1", projectId: "p1", taskDir })
    };
    engine.aiRouter = detailedRouter(async (round, payload) => {
      if (round === 0) {
        return { toolCalls: [
          toolCall("write-build", "write", {
            workspace: "artifact",
            path: "build.js",
            content: "console.log('build')",
            deliverable: false
          }),
          toolCall("write-game", "write", {
            workspace: "artifact",
            path: "game.html",
            content: "<!doctype html><html><body>可运行游戏</body></html>",
            deliverable: true
          })
        ] };
      }
      if (round === 1) {
        return { toolCalls: [toolCall("inspect-game", "inspect_artifact", {
          path: "game.html"
        })] };
      }
      if (round === 2) {
        const serialized = JSON.stringify(payload.messages || []);
        const inspectionId = serialized.match(/inspection_[a-f0-9]{24}/)?.[0];
        assert.ok(inspectionId, "发布前必须读取 inspect_artifact 返回的快照");
        return { toolCalls: [toolCall("publish-game", "publish_artifact", {
          path: "game.html",
          inspectionId,
          title: "可运行游戏"
        })] };
      }
      return "游戏已经完成。";
    });

    const result = await engine.submitAgentInput({
      message: "制作网页游戏",
      projectId: "p1",
      taskId: "t1"
    });

    assert.equal(result.reply, "游戏已经完成。");
    assert.equal(result.artifact?.absolute, await realpath(join(taskDir, "final", "game.html")));
    assert.equal(result.artifact?.source, "agent-publish");
    assert.equal(result.artifact?.title, "可运行游戏");
    assert.equal(result.artifact?.storage, "task");
    assert.equal(result.artifact?.managed, true);
    assert.equal(result.artifacts.length, 1);
    assert.equal(result.artifacts.some((item) => item.file === "build.js"), false);
    assert.equal(engine.appendedLogs.at(-1).artifact.absolute, result.artifact.absolute);
    assert.equal(await readFile(result.artifact.absolute, "utf8"), "<!doctype html><html><body>可运行游戏</body></html>");
    assert.equal(await readFile(join(taskDir, ".candidates", "build.js"), "utf8"), "console.log('build')");
  } finally {
    await rm(taskDir, { recursive: true, force: true });
  }
});

test("工作空间文件发布后再改写，collector 仍只交付已审查的 final 快照", async () => {
  const taskDir = await mkdtemp(join(tmpdir(), "yaoguo-published-snapshot-task-"));
  const workspaceDir = await mkdtemp(join(tmpdir(), "yaoguo-published-snapshot-workspace-"));
  try {
    const engine = createWorkflowHarness();
    engine.projectService = {
      getProject: async () => ({ id: "p1", type: "general" }),
      getTaskDir: () => taskDir,
      getTask: async () => ({
        id: "t1",
        projectId: "p1",
        taskDir,
        workspacePath: workspaceDir
      })
    };
    const reviewed = "# 已审查报告\n\n这是发布时的真实内容。";
    const rewritten = "# 未审查改写\n\n这些字节不得进入成品。";
    engine.aiRouter = detailedRouter(async (round, payload) => {
      if (round === 0) {
        return { toolCalls: [toolCall("write-workspace-report", "write", {
          workspace: "project",
          path: "report.md",
          content: reviewed,
          deliverable: true
        })] };
      }
      if (round === 1) {
        return { toolCalls: [toolCall("inspect-workspace-report", "inspect_artifact", {
          path: "report.md"
        })] };
      }
      if (round === 2) {
        const inspectionId = JSON.stringify(payload.messages || [])
          .match(/inspection_[a-f0-9]{24}/)?.[0];
        assert.ok(inspectionId);
        return { toolCalls: [toolCall("publish-workspace-report", "publish_artifact", {
          path: "report.md",
          inspectionId
        })] };
      }
      if (round === 3) {
        return { toolCalls: [toolCall("rewrite-workspace-report", "edit", {
          workspace: "project",
          path: "report.md",
          edits: [{ oldText: reviewed, newText: rewritten }],
          deliverable: false
        })] };
      }
      return "已交付发布时的快照。";
    });

    const result = await engine.submitAgentInput({
      message: "生成并发布报告",
      projectId: "p1",
      taskId: "t1"
    });

    assert.equal(await readFile(join(workspaceDir, "report.md"), "utf8"), rewritten);
    assert.equal(result.artifacts.length, 1);
    assert.equal(result.artifact.absolute, await realpath(join(taskDir, "final", "report.md")));
    assert.equal(result.artifact.storage, "task");
    assert.equal(result.artifact.managed, true);
    assert.equal(await readFile(result.artifact.absolute, "utf8"), reviewed);
  } finally {
    await rm(taskDir, { recursive: true, force: true });
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("声明为成品的普通写入未发布时，运行时阻止自然语言提前结束", async () => {
  const taskDir = await mkdtemp(join(tmpdir(), "yaoguo-agent-delivery-guardrail-"));
  try {
    const engine = createWorkflowHarness();
    engine.projectService = {
      getProject: async () => ({ id: "p1", type: "general" }),
      getTaskDir: () => taskDir,
      getTask: async () => ({ id: "t1", projectId: "p1", taskDir })
    };
    engine.aiRouter = detailedRouter(async (round, payload) => {
      if (round === 0) {
        return { toolCalls: [toolCall("write-report", "write", {
          workspace: "artifact",
          path: "report.md",
          content: "# 报告\n\n真实内容",
          deliverable: true
        })] };
      }
      if (round === 1) return "报告已经交付。";
      if (round === 2) {
        assert.match(JSON.stringify(payload.messages || []), /尚未完成交付闭环/);
        return { toolCalls: [toolCall("inspect-report", "inspect_artifact", {
          path: "report.md"
        })] };
      }
      if (round === 3) {
        const inspectionId = JSON.stringify(payload.messages || [])
          .match(/inspection_[a-f0-9]{24}/)?.[0];
        assert.ok(inspectionId);
        return { toolCalls: [toolCall("publish-report", "publish_artifact", {
          path: "report.md",
          inspectionId
        })] };
      }
      return "报告已经交付。";
    });

    const result = await engine.submitAgentInput({
      message: "生成一份 Markdown 报告文件",
      projectId: "p1",
      taskId: "t1"
    });

    assert.equal(result.reply, "报告已经交付。");
    assert.equal(result.artifacts.length, 1);
    assert.equal(result.artifact.absolute, await realpath(join(taskDir, "final", "report.md")));
  } finally {
    await rm(taskDir, { recursive: true, force: true });
  }
});

test("Agent 把内部工具协议转成非空的阻塞说明，不保存过程文字或尖括号残片", async () => {
  const engine = createWorkflowHarness();
  const leaked = [
    "正在继续修改文件。",
    "<｜｜DSML｜｜tool_calls>",
    "<｜｜DSML｜｜invoke name=\"write\">",
    "<｜｜DSML｜｜parameter name=\"path\">result.html</｜｜DSML｜｜parameter>",
    "</｜｜DSML｜｜invoke>",
    "</｜｜DSML｜｜tool_calls>"
  ].join("\n");
  engine.aiRouter = detailedRouter(async () => leaked);

  const result = await engine.submitAgentInput({
    message: "继续完成网页",
    projectId: "p1",
    taskId: "t1"
  });

  assert.equal(result.blocked, true);
  assert.equal(result.stopCode, "AGENT_TOOL_PROTOCOL_LEAK");
  assert.match(result.reply, /无法安全执行的工具指令/);
  assert.doesNotMatch(result.reply, /DSML|<|正在继续修改文件/);
  assert.deepEqual(engine.appendedLogs.map((row) => row.role), ["user", "assistant"]);
  assert.equal(engine.appendedLogs.at(-1).content, result.reply);
});

test("续轮上下文忽略未发布回复与二进制文件，读取显式发布的 HTML", async () => {
  const dir = await mkdtemp(join(tmpdir(), "yaoguo-agent-resume-"));
  try {
    const plainReplyPath = join(dir, "latest-reply.md");
    const pdfPath = join(dir, "latest.pdf");
    const htmlPath = join(dir, "page.html");
    await writeFile(plainReplyPath, "这是普通助手回复，不是成品。", "utf8");
    await writeFile(pdfPath, Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff]));
    await writeFile(htmlPath, "<!doctype html><html><body><main>可继续修改的交互网页</main></body></html>", "utf8");
    const engine = Object.create(WorkflowEngine.prototype);
    engine.projectService = {
      getTask: async () => ({ id: "t1" }),
      listTaskFiles: async () => [
        { absolute: plainReplyPath, file: "latest-reply.md" },
        { absolute: pdfPath, file: "latest.pdf", source: "agent-publish" },
        { absolute: htmlPath, file: "page.html", source: "agent-publish" }
      ]
    };

    const result = await engine.loadLatestDeliverable({ projectId: "p1", taskId: "t1" });

    assert.equal(result.source, htmlPath);
    assert.match(result.content, /可继续修改的交互网页/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Agent 上下文组装失败时转为有记录的友好响应", async () => {
  const engine = createWorkflowHarness();
  engine.buildAgentContext = async () => { throw new Error("context store unavailable"); };
  engine.aiRouter = detailedRouter(async () => { throw new Error("不应调用模型"); });

  const result = await engine.submitAgentInput({ message: "继续", projectId: "p1", taskId: "t1" });

  assert.equal(result.blocked, true);
  assert.match(result.reply, /当前任务未能启动/);
  assert.match(result.reply, /context store unavailable/);
  assert.deepEqual(engine.appendedLogs.map((row) => row.role), ["user", "assistant"]);
  assert.equal(engine.appendedLogs.at(-1).blocked, true);
});

test("Agent 把中断信号传进模型与工具循环，并把中断返回为取消状态", async () => {
  const engine = createWorkflowHarness();
  const controller = new AbortController();
  engine.aiRouter = detailedRouter(async (_round, payload) => {
      assert.ok(payload.signal);
      controller.abort(new Error("stop"));
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
  });

  const result = await engine.submitAgentInput(
    { message: "停止前的任务", projectId: "p1", taskId: "t1" },
    { signal: controller.signal }
  );

  assert.equal(result.cancelled, true);
  assert.equal(result.reply, "已停止当前任务。");
  assert.equal(engine.appendedLogs.at(-1).cancelled, true);
});

test("Agent trace 独立持久化，不混入工作消息", async () => {
  const root = await mkdtemp(join(tmpdir(), "yaoguo-agent-trace-"));
  const engine = createWorkflowHarness();
  engine.projectService.getTaskDir = () => root;
  await engine._persistAgentTrace({
    projectId: "p1", taskId: "t1", runId: "r1",
    toolNames: ["search_memory", "generate_document"],
    result: {
      rounds: 2,
      toolCalls: [{
        round: 0, name: "search_memory", args: { query: "偏好", apiKey: "secret" }, effect: "read",
        result: { ok: true, value: { ok: true } }, resultRef: `ctxr_${"a".repeat(64)}`, modelReceipt: true
      }],
      contextStats: { peakActiveTokens: 1200 }
    }
  });

  const dir = join(root, "agent-traces");
  const files = await readdir(dir);
  const row = JSON.parse((await readFile(join(dir, files[0]), "utf8")).trim());
  assert.equal(row.toolCalls[0].resultRef, `ctxr_${"a".repeat(64)}`);
  assert.match(row.toolCalls[0].argsDigest, /^[a-f0-9]{64}$/);
  assert.match(row.toolCalls[0].resultDigest, /^[a-f0-9]{64}$/);
  assert.equal("args" in row.toolCalls[0], false);
  assert.equal("result" in row.toolCalls[0], false);
  assert.doesNotMatch(JSON.stringify(row), /secret/);
  assert.equal(row.terminalCalls, undefined);
});

test("交付工具只能引用本轮 search_images 实际返回的图片资产", () => {
  const engine = Object.create(WorkflowEngine.prototype);
  const imageAssets = new Map([
    ["image_known", { assetId: "image_known", url: "https://images.example/known.jpg" }]
  ]);
  const call = {
    function: {
      name: "generate_document",
      arguments: JSON.stringify({ format: "pptx", source: "latest_artifact", imageAssetIds: ["image_known", "image_hallucinated"] })
    }
  };
  const resolved = engine._attachSelectedImageAssets(call, imageAssets);
  assert.deepEqual(resolved.resolvedImageAssets.map((item) => item.assetId), ["image_known"]);
});

test("会话上下文直接进入同一个通用 Agent 回合", async () => {
  const engine = createWorkflowHarness();
  let agentContext = "";
  engine.buildAgentContext = async () => "用户前面指定：给董事会看，保留三组对比数据。";
  engine.aiRouter = detailedRouter(async (_round, payload) => {
    agentContext = payload.runContext;
    return "报告已按同一段上下文完成。";
  });

  const result = await engine.submitAgentInput({ message: "按刚才的要求做成报告", projectId: "p1", taskId: "t1" });

  assert.equal(result.reply, "报告已按同一段上下文完成。");
  assert.match(agentContext, /给董事会看/);
  assert.match(agentContext, /三组对比数据/);
});

test("多个候选生成工具均执行，但未经发布不进入成品区", async () => {
  const engine = createWorkflowHarness();
  engine.skillsService = {};
  const called = [];
  engine.runGenerateDocumentFromToolCall = async ({ options }) => {
    called.push({ name: "document", skipUserLog: options.skipUserLog === true });
    return { reply: "PPTX 已交付。", artifact: { format: "pptx" }, taskId: "t1" };
  };
  engine.runGenerateVisualFromToolCall = async ({ options }) => {
    called.push({ name: "visual", skipUserLog: options.skipUserLog === true });
    return { reply: "网页已交付。", artifact: { format: "html" }, taskId: "t1" };
  };
  engine.aiRouter = detailedRouter(async (round) => {
    if (round === 0) {
      return { toolCalls: [
        { id: "d1", type: "function", function: { name: "generate_document", arguments: JSON.stringify({ format: "pptx", source: "latest_artifact" }) } },
        { id: "v1", type: "function", function: { name: "generate_visual", arguments: JSON.stringify({ medium: "webpage", path: "final/page.html" }) } }
      ] };
    }
    return "PPTX 与网页均已交付。";
  });

  const result = await engine.submitAgentInput({ message: "同时交付 PPTX 和网页", projectId: "p1", taskId: "t1" });

  assert.deepEqual(called.map((item) => item.name), ["document", "visual"]);
  assert.deepEqual(result.artifacts, []);
  assert.equal(result.reply, "PPTX 与网页均已交付。");
});

test("候选文件未处理时 Agent 自动续跑，废弃后才允许自然结束", async () => {
  const taskDir = await mkdtemp(join(tmpdir(), "yaoguo-agent-candidate-gate-"));
  try {
    const candidate = join(taskDir, "draft.pptx");
    await writeFile(candidate, "not a final deck", "utf8");
    const canonicalCandidate = await realpath(candidate);
    const engine = createWorkflowHarness();
    engine.skillsService = {};
    engine.projectService = {
      getProject: async () => ({ id: "p1", type: "general" }),
      getTaskDir: () => taskDir,
      getTask: async () => ({ id: "t1", projectId: "p1", taskDir })
    };
    engine.runGenerateDocumentFromToolCall = async () => ({
      reply: "PPTX 候选文件已生成。",
      artifact: { absolute: canonicalCandidate, file: "draft.pptx", format: "pptx" },
      taskId: "t1"
    });
    let modelCalls = 0;
    engine.aiRouter = detailedRouter(async (round, payload) => {
      modelCalls += 1;
      if (round === 0) {
        return { toolCalls: [toolCall("generate-draft", "generate_document", {
          format: "pptx",
          source: "task_history"
        })] };
      }
      if (round === 1) return "PPTX 已经完成。";
      if (round === 2) {
        assert.match(JSON.stringify(payload.messages || []), /尚未完成交付闭环/);
        return { toolCalls: [toolCall("discard-draft", "discard_artifact_candidate", {
          path: canonicalCandidate,
          reason: "真实文件不是有效 PPTX，不作为成品交付。"
        })] };
      }
      return "候选文件不合格，已停止交付。";
    });

    const result = await engine.submitAgentInput({
      message: "生成一份 PPTX",
      projectId: "p1",
      taskId: "t1"
    });

    assert.equal(modelCalls, 4);
    assert.equal(result.reply, "候选文件不合格，已停止交付。");
    assert.deepEqual(result.artifacts, []);
  } finally {
    await rm(taskDir, { recursive: true, force: true });
  }
});

test("模型没有调用交付工具时，宿主不会用关键词伪造视觉工具调用", async () => {
  const engine = createWorkflowHarness();
  let visualCalls = 0;
  engine.skillsService = {};
  engine.runGenerateVisualFromToolCall = async () => {
    visualCalls += 1;
    return { reply: "视觉课件已生成。" };
  };
  engine.aiRouter = detailedRouter(async () => "还需要先明确要做的内容。");

  const result = await engine.submitAgentInput({ message: "做成网页形式的高中课堂 PPT", projectId: "p1", taskId: "t1" });

  assert.equal(visualCalls, 0);
  assert.equal(result.reply, "还需要先明确要做的内容。");
});

test("模型明确调用 generate_visual 时执行视觉工具", async () => {
  const engine = createWorkflowHarness();
  let visualPayload = null;
  engine.skillsService = {};
  engine.runGenerateVisualFromToolCall = async (payload) => {
    visualPayload = payload;
    return { reply: "视觉课件已生成。", taskId: payload.taskId };
  };
  engine.aiRouter = detailedRouter(async (round) => {
    if (round === 0) {
      return { toolCalls: [{
        id: "v1", type: "function",
        function: { name: "generate_visual", arguments: JSON.stringify({ medium: "deck", path: "final/deck.html" }) }
      }] };
    }
    return "视觉课件已生成。";
  });

  const result = await engine.submitAgentInput({ message: "做成网页形式的高中课堂 PPT", projectId: "p1", taskId: "t1" });

  assert.equal(result.reply, "视觉课件已生成。");
  assert.equal(JSON.parse(visualPayload.toolCall.function.arguments).medium, "deck");
});

test("listDecisionCards 未指定 runId 时会扫描任务下的运行决策卡", async () => {
  const engine = createWorkflowHarness();
  engine.projectService = { getTask: async () => ({ id: "t1", decisionCards: [] }) };
  engine.listRuns = async () => ([{
    id: "r1",
    decisionCards: [
      { id: "card-run", status: "pending", question: "选一个方向" },
      { id: "card-answered", status: "answered", question: "已处理" }
    ]
  }]);

  const cards = await engine.listDecisionCards({ projectId: "p1", taskId: "t1", status: "pending" });

  assert.deepEqual(cards.map((card) => card.id), ["card-run"]);
});
