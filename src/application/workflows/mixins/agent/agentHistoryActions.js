const { estimateTokens, headTailForPromptTokens } = require("../../../../platform/runtime");

module.exports = {
async prepareAgentInputForModel({ projectId = "", taskId = "", turnId = "", message = "" } = {}) {
  const tokens = estimateTokens(message);
  const settings = typeof this.settingsService?.get === "function"
    ? await this.settingsService.get().catch(() => ({}))
    : {};
  const compactTrigger = Math.max(
    8000,
    Number(settings.context?.sessionMemory?.compactTriggerTokens) || 100000
  );
  const directLimit = Math.max(8000, Math.min(64000, Math.floor(compactTrigger * 0.32)));
  if (tokens <= directLimit || !this.taskSessionStore?.externalizeInput) {
    return { input: message, externalized: false, tokens };
  }
  const file = await this.taskSessionStore.externalizeInput({
    projectId, taskId, turnId, content: message
  });
  return {
    input: [
      "本轮用户输入超过单次安全上下文预算，完整原文已无损外置。",
      `路径：${file.absolute}`,
      `大小：${file.bytes} bytes；估算 ${tokens} tokens。`,
      "请使用 read(offset, limit) 分页读取完整原文后再执行；不得只读取开头或根据摘要猜测。"
    ].join("\n"),
    externalized: true,
    tokens,
    file
  };
},

async appendAgentMessage(entry = {}) {
  if (!this.taskSessionStore) throw new Error("任务会话存储不可用。");
  return this.taskSessionStore.appendMessage(compactMessageEntry(entry));
},

async listAgentMessages({ projectId = "", taskId = "", limit = 160 } = {}) {
  if (!this.taskSessionStore || !projectId || !taskId) return [];
  return this.taskSessionStore.listMessages({ projectId, taskId, limit });
},

async listAgentMessageWindow({ projectId = "", taskId = "", limit = 160 } = {}) {
  if (!this.taskSessionStore || !projectId || !taskId) return { rows: [], total: 0 };
  if (typeof this.taskSessionStore.listMessageWindow === "function") {
    return this.taskSessionStore.listMessageWindow({ projectId, taskId, limit });
  }
  const rows = await this.taskSessionStore.listMessages({ projectId, taskId, limit });
  return { rows, total: rows.length };
},

async findAgentMessage({ projectId = "", taskId = "", turnId = "", role = "" } = {}) {
  if (!this.taskSessionStore?.findMessage || !projectId || !taskId || !turnId) return null;
  return this.taskSessionStore.findMessage({ projectId, taskId, turnId, role });
},

async buildAgentHistoryContext({
  projectId = "", taskId = "", currentTurnId = "", currentMessage = ""
  } = {}) {
  if (!projectId || !taskId) return "";
  const settings = typeof this.settingsService?.get === "function"
    ? await this.settingsService.get().catch(() => ({}))
    : {};
  const config = settings.context?.agentHistory || {};
  const readLimit = Math.max(1, Number(config.readLimit) || 240);
  const window = await this.listAgentMessageWindow({
    projectId,
    taskId,
    limit: readLimit + 2
  });
  let excluded = 0;
  const rows = window.rows.filter((row, index) => {
    const currentTurn = currentTurnId && row.turnId === currentTurnId && row.role === "user";
    const matchingLastInput = row.role === "user" && index === window.rows.length - 1
      && `${row.content || ""}`.trim() === `${currentMessage || ""}`.trim();
    if (currentTurn || matchingLastInput) excluded += 1;
    return !(currentTurn || matchingLastInput);
  });
  const totalRows = Math.max(0, Number(window.total || 0) - excluded);
  const totalTokens = Number(config.tokens) || 24000;
  const itemTokens = Math.max(512, Math.min(12000, Math.floor(totalTokens / 3)));
  const inlineRows = rows.slice(-readLimit);
  const picked = [];
  let used = 0;
  let clipped = false;
  for (let index = inlineRows.length - 1; index >= 0; index -= 1) {
    const row = inlineRows[index];
    const role = row.role === "user" ? "用户" : (row.role === "assistant" ? "Agent" : "系统");
    const raw = `${row.content || ""}`;
    const compacted = headTailForPromptTokens(raw, itemTokens, "[本条中间内容已外置，可按下方路径回读]");
    if (compacted !== raw) clipped = true;
    const line = `${role}：${compacted}`;
    const tokens = estimateTokens(line);
    if (picked.length && used + tokens > totalTokens) break;
    picked.unshift(line);
    used += tokens;
    if (used >= totalTokens) break;
  }
  const incomplete = picked.length < totalRows || clipped;
  if (!incomplete) return picked.join("\n\n");
  if (typeof this.taskSessionStore?.externalizeHistory !== "function") {
    throw new Error("任务历史超过内联预算，但完整历史外置能力不可用。");
  }
  const file = await this.taskSessionStore.externalizeHistory({
    projectId,
    taskId
  });
  return [
    picked.join("\n\n"),
    [
      `【历史未静默丢失】内联 ${picked.length}/${totalRows} 条；完整任务历史已无损外置。`,
      `路径：${file.absolute}`,
      `大小：${file.bytes} bytes。`,
      "需要更早约束或被裁掉的中间内容时，使用 read(offset, limit) 分页读取。"
    ].join("\n")
  ].filter(Boolean).join("\n\n");
},

async buildAgentConversationMessages({
  projectId = "", taskId = "", currentTurnId = "", currentMessage = ""
} = {}) {
  if (!projectId || !taskId) return [];
  const settings = typeof this.settingsService?.get === "function"
    ? await this.settingsService.get().catch(() => ({}))
    : {};
  const config = settings.context?.agentHistory || {};
  const readLimit = Math.max(1, Number(config.readLimit) || 240);
  const window = await this.listAgentMessageWindow({ projectId, taskId, limit: readLimit + 2 });
  const rows = window.rows.filter((row, index) => {
    const currentTurn = currentTurnId && row.turnId === currentTurnId && row.role === "user";
    const matchingLastInput = row.role === "user" && index === window.rows.length - 1
      && `${row.content || ""}`.trim() === `${currentMessage || ""}`.trim();
    return !(currentTurn || matchingLastInput);
  });
  const modelInputs = await loadPersistedModelInputs(this, { projectId, taskId, rows });
  const totalTokens = Number(config.tokens) || 24000;
  const picked = [];
  let used = 0;
  let clipped = false;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    const persistedModelInput = row.role === "user" && row.turnId
      ? modelInputs.get(`${row.turnId}`)
      : "";
    let content = persistedModelInput || `${row.content || ""}`;
    let tokens = estimateTokens(content);
    if (tokens > totalTokens) {
      // 单条消息超过整段预算时压缩到预算内，而不是丢弃全部历史。
      content = headTailForPromptTokens(content, totalTokens);
      tokens = estimateTokens(content);
      clipped = true;
    }
    if (picked.length && used + tokens > totalTokens) break;
    picked.unshift({
      role: row.role === "assistant" ? "assistant" : "user",
      content,
      ...(persistedModelInput ? { modelReady: true } : {})
    });
    used += tokens;
    if (used >= totalTokens) break;
  }
  if (clipped && typeof this.taskSessionStore?.externalizeHistory === "function" && projectId && taskId) {
    try {
      const file = await this.taskSessionStore.externalizeHistory({ projectId, taskId });
      picked.push({
        role: "user",
        modelReady: true,
        content: [
          "【历史未静默丢失】内联窗口包含被压缩的超预算消息；完整任务历史已无损外置。",
          `路径：${file.absolute}`,
          "需要被裁掉或压缩的中间内容时，使用 read(offset, limit) 分页读取。"
        ].join("\n")
      });
    } catch { /* 外置失败不阻塞本轮：压缩已保留首尾，本提示缺失不改变执行语义。 */ }
  }
  return picked;
},

async hasUserMessagesBefore({ projectId = "", taskId = "", scheduledAt = "" } = {}) {
  const rows = await this.listAgentMessages({ projectId, taskId, limit: 20 });
  const scheduledTime = Date.parse(scheduledAt || "") || Date.now();
  return rows.some((row) => {
    if (row.role !== "user") return false;
    const created = Date.parse(row.createdAt || "");
    return Number.isFinite(created) ? created < scheduledTime : true;
  });
}
};

async function loadPersistedModelInputs(engine, {
  projectId = "", taskId = "", rows = []
} = {}) {
  if (typeof engine.taskSessionStore?.readContentBodyRef !== "function") return new Map();
  const refs = new Map();
  for (const row of rows) {
    const sha256 = `${row?.modelInputRef?.sha256 || ""}`;
    const turnId = `${row?.turnId || ""}`;
    if (row?.role !== "assistant" || !turnId || !/^[a-f0-9]{64}$/.test(sha256)) continue;
    refs.set(turnId, sha256);
  }
  const resolved = new Map();
  await Promise.all([...refs].map(async ([turnId, sha256]) => {
    const content = await engine.taskSessionStore.readContentBodyRef({
      projectId,
      taskId,
      sha256
    }).catch(() => "");
    if (`${content || ""}`.trim()) resolved.set(turnId, `${content}`);
  }));
  return resolved;
}

function compactMessageEntry(entry = {}) {
  const next = { ...entry };
  if (entry.artifact) next.artifact = compactArtifactRef(entry.artifact);
  if (Array.isArray(entry.artifacts)) {
    next.artifacts = entry.artifacts.map(compactArtifactRef).filter(Boolean);
  }
  return next;
}

function compactArtifactRef(artifact = null) {
  if (!artifact || typeof artifact !== "object") return null;
  return Object.fromEntries([
    "id", "title", "file", "absolute", "relative", "format", "bytes", "size",
    "updatedAt", "source", "storage", "managed", "sha256", "inspectionId"
  ].filter((key) => artifact[key] !== undefined).map((key) => [key, artifact[key]]));
}
