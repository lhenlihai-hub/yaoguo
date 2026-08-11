const crypto = require("node:crypto");
const { estimateTokens } = require("../../../../platform/runtime");
const { replayTurnExecutionReceipt } = require("../../../agent/taskExecutionReceipt");

module.exports = {
async submitAgentInput(payload = {}, options = {}) {
  const message = `${payload.message || ""}`;
  let projectId = `${payload.projectId || ""}`;
  let taskId = `${payload.taskId || ""}`;
  // 普通消息属于 task session，不继承 UI 当前正在预览的历史 run。
  // 只有显式 workflow resume/continue 路径才持有 run identity。
  const runId = "";
  const turnId = `${payload.turnId || payload.streamId || crypto.randomUUID()}`;
  if (!message.trim()) throw new Error("Agent 输入不能为空。");
  if (!projectId || !taskId) throw new Error("Agent 输入缺少 projectId 或 taskId。");

  if (typeof this.projectService?.getTask === "function") {
    const task = await this.projectService.getTask(projectId, taskId);
    if ((task?.id && `${task.id}` !== taskId) || (task?.projectId && `${task.projectId}` !== projectId)) {
      throw new Error("Agent 输入的 projectId/taskId 不是规范任务标识。");
    }
    projectId = `${task?.projectId || projectId}`;
    taskId = `${task?.id || taskId}`;
  }

  const cacheOperation = this.parseMemoryCacheCommand?.(message) || "";
  if (cacheOperation) {
    const scope = { projectId, taskId, runId, turnId };
    const operation = () => this.executeMemoryCacheCommand({
      operation: cacheOperation,
      message,
      projectId,
      taskId,
      runId,
      turnId,
      source: `${payload.source || "desktop"}`,
      options
    });
    return this.taskAgentCoordinator
      ? this.taskAgentCoordinator.runExclusive(scope, operation)
      : operation();
  }

  const replay = await replayPersistedTurn(this, { projectId, taskId, turnId, message });
  if (replay) return replay;

  this.scheduleAutoNameFromFirstMessage({ projectId, taskId, message });
  if (!options.skipUserLog) {
    await this.appendAgentMessage({
      role: "user", content: message, projectId, taskId, runId, turnId,
      source: `${payload.source || "desktop"}`, status: "accepted"
    });
  }
  const scope = { projectId, taskId, runId, turnId };
  const operation = () => this._runAgentInputTurn({
    ...payload,
    message,
    projectId,
    taskId,
    runId,
    turnId
  }, options);
  const canSteer = payload.hasNewFileReferences !== true && estimateTokens(message) <= 700000;
  return this.taskAgentCoordinator
    ? this.taskAgentCoordinator.submitMessage(scope, message, operation, { canSteer })
    : operation();
},

async _runAgentInputTurn(payload = {}, options = {}) {
  const {
    message, projectId, taskId, runId, turnId, fileReferences = []
  } = payload;
  let artifacts = [];
  try {
    this._emitAgentActivity?.({
      projectId, taskId, runId, turnId,
      phase: "agent-run", status: "planning", label: "Agent 正在处理任务"
    });
    const outcome = await this.executeAgentTurn({
      message,
      projectId,
      taskId,
      runId,
      turnId,
      fileReferences,
      signal: options.signal || null,
      onToken: options.onToken,
      onToolEvent: (event) => emitAgentToolActivity(this, event, {
        projectId, taskId, runId, turnId
      })
    });
    artifacts = outcome.artifacts;
    const reply = outcome.reply;
    if (!options.skipAssistantLog) {
      await this.persistAgentTurnOutcome({
        outcome, projectId, taskId, runId, turnId,
        source: `${payload.source || "desktop"}`
      });
    }
    this._emitAgentActivity?.({
      projectId, taskId, runId, turnId,
      phase: "agent-run",
      status: outcome.cancelled || outcome.blocked ? "blocked" : "completed",
      label: outcome.cancelled ? "当前任务已停止" : (outcome.blocked ? "Agent 未完成" : "Agent 已完成")
    });
    return {
      reply,
      cancelled: outcome.cancelled,
      blocked: outcome.blocked,
      stopCode: outcome.stopCode,
      usage: outcome.usage || null,
      artifact: artifacts.at(-1) || null,
      artifacts,
      taskId,
      runId,
      turnId
    };
  } catch (error) {
    const cancelled = options.signal?.aborted || error?.name === "AbortError" || error?.code === "ABORT_ERR";
    const reply = cancelled
      ? "已停止当前任务。"
      : ["当前任务未能启动。", "", error.message, "", "请检查模型配置、项目数据或网络状态后重试。"].join("\n");
    if (!options.skipAssistantLog) {
      await this.persistAgentTurnOutcome({
        outcome: { reply, cancelled, blocked: !cancelled },
        projectId, taskId, runId, turnId,
        source: `${payload.source || "desktop"}`,
        errorCode: `${error?.code || ""}`
      });
    }
    return { reply, cancelled, blocked: !cancelled, taskId, runId, turnId };
  }
}
};

async function replayPersistedTurn(engine, { projectId, taskId, turnId, message }) {
  if (!turnId || !engine.taskSessionStore) return null;
  const existingUser = typeof engine.findAgentMessage === "function"
    ? await engine.findAgentMessage({ projectId, taskId, turnId, role: "user" })
    : null;
  if (existingUser && `${existingUser.content || ""}` !== `${message || ""}`) {
    throw Object.assign(new Error("同一 turnId 已对应另一条用户输入。"), {
      code: "AGENT_TURN_CONFLICT"
    });
  }
  const execution = typeof engine.taskSessionStore.findTurnExecution === "function"
    ? await engine.taskSessionStore.findTurnExecution({ projectId, taskId, turnId })
    : null;
  const inputDigest = crypto.createHash("sha256").update(`${message || ""}`, "utf8").digest("hex");
  if (execution?.started?.inputDigest && execution.started.inputDigest !== inputDigest) {
    throw Object.assign(new Error("同一 turnId 已对应另一条用户输入。"), {
      code: "AGENT_TURN_CONFLICT"
    });
  }
  const assistant = typeof engine.findAgentMessage === "function"
    ? await engine.findAgentMessage({ projectId, taskId, turnId, role: "assistant" })
    : null;
  if (assistant) {
    return {
      reply: `${assistant.content || ""}`,
      cancelled: Boolean(assistant.cancelled),
      blocked: Boolean(assistant.blocked),
      stopCode: `${assistant.stopCode || assistant.errorCode || ""}`,
      artifact: assistant.artifact || null,
      artifacts: Array.isArray(assistant.artifacts) ? assistant.artifacts : [],
      usage: assistant.usage || null,
      projectId,
      taskId,
      runId: `${assistant.runId || ""}`,
      turnId,
      disposition: "replayed"
    };
  }
  const steered = typeof engine.taskSessionStore.findEvent === "function"
    ? await engine.taskSessionStore.findEvent({
      projectId,
      taskId,
      eventId: `steered:${turnId}`
    })
    : null;
  if (steered) {
    const disposition = ["steered", "steering_cancelled", "steering_failed"].includes(steered.disposition)
      ? steered.disposition
      : "steered";
    const cancelled = disposition === "steering_cancelled";
    const blocked = disposition === "steering_failed";
    return {
      accepted: true,
      disposition,
      reply: cancelled
        ? "当前执行在处理这条补充后已停止。消息已保留；如需重试，请发送一条新消息。"
        : (blocked
          ? "当前执行在处理这条补充后未能完成。消息已保留；如需重试，请发送一条新消息。"
          : ""),
      cancelled,
      blocked,
      stopCode: `${steered.stopCode || ""}`,
      projectId,
      taskId,
      runId: `${steered.runId || ""}`,
      turnId
    };
  }
  if (!execution || execution.state === "none") return null;
  if (execution.state === "interrupted" && engine.taskAgentCoordinator?.hasInflightTurn?.({
    projectId, taskId, turnId
  })) return null;
  return replayTurnExecutionReceipt(execution, { projectId, taskId, turnId });
}

const AGENT_TOOL_LABELS = {
  search_reference: ["正在检索参考资料", "参考资料检索完成"],
  fetch_url: ["正在读取来源网页", "来源网页读取完成"],
  search_images: ["正在检索图片资源", "图片资源检索完成"],
  search_memory: ["正在查找长期记忆", "长期记忆查找完成"],
  read_artifact: ["正在读取已有成品", "已有成品读取完成"],
  search_run_artifacts: ["正在查找运行产物", "运行产物查找完成"],
  load_capability: ["正在加载所需能力", "所需能力加载完成"],
  run_skill: ["正在执行文件工具", "文件工具执行完成"],
  llm_judge_quality: ["正在检查内容质量", "内容质量检查完成"],
  spawn_subagent: ["正在委派子任务", "子任务已返回"],
  inspect_artifact: ["正在检查候选文件", "候选文件检查完成"],
  publish_artifact: ["正在登记最终成品", "最终成品已登记"],
  discard_artifact_candidate: ["正在废弃候选文件", "候选文件已废弃"],
  generate_document: ["正在生成文件", "文件生成完成"],
  generate_visual: ["正在生成视觉成品", "视觉成品生成完成"]
};

function emitAgentToolActivity(engine, event = {}, scope = {}) {
  if (typeof engine?._emitAgentActivity !== "function" || !event.name) return;
  const labels = AGENT_TOOL_LABELS[event.name] || [`正在执行 ${event.name}`, `${event.name} 执行完成`];
  const failed = event.status === "failed";
  engine._emitAgentActivity({
    ...scope,
    phase: `agent-tool-${event.name}`,
    status: event.status === "started" ? "running" : (failed ? "blocked" : "completed"),
    label: failed ? `${labels[0].replace(/^正在/, "")}未完成` : (event.status === "started" ? labels[0] : labels[1]),
    kind: "tool",
    toolName: event.name
  });
}
