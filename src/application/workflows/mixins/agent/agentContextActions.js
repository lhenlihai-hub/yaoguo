const { estimateTokens, truncateForPromptTokens } = require("../../../../platform/runtime");

module.exports = {
async buildAgentContext({
  projectId = "", taskId = "", runId = "", turnId = "", message = "",
  state = null, step = null
} = {}) {
  void turnId;
  void message;
  const parts = [];
  const project = projectId && typeof this.projectService?.getProject === "function"
    ? await this.projectService.getProject(projectId).catch(() => null)
    : null;
  const task = projectId && taskId && typeof this.projectService?.getTask === "function"
    ? await this.projectService.getTask(projectId, taskId, false).catch(() => null)
    : null;
  const taskScope = [
    projectId ? `项目：${project?.name || projectId}` : "",
    taskId ? `任务：${task?.title || taskId}` : "",
    task?.brief ? `任务说明：${task.brief}` : ""
  ].filter(Boolean);
  if (taskScope.length) parts.push("【任务范围】", taskScope.join("\n"));

  if (state && step && typeof this.buildRunContext === "function") {
    const executionContext = await this.buildRunContext(state, step).catch(() => "");
    if (executionContext) parts.push("【当前执行状态】", executionContext);
  }

  const latest = projectId && taskId
    ? await this.loadLatestDeliverable({ projectId, taskId, runId }).catch(() => null)
    : null;
  if (latest?.source) {
    const tokens = estimateTokens(latest.content || "");
    parts.push("【当前已发布成品】", [
      `路径：${latest.source}`,
      latest.content && tokens <= 32000
        ? `正文：\n${latest.content}`
        : "正文较大，请使用 read 分页读取该路径；不要根据预览猜测内容。"
    ].join("\n"));
  }

  if (projectId && taskId && this.projectService) {
    const references = typeof this.projectService.listReferences === "function"
      ? await this.projectService.listReferences(projectId, taskId).catch(() => [])
      : [];
    if (references.length) {
      parts.push("【任务引用资料】", references.slice(0, 12).map((item, index) => [
        `${index + 1}. ${item.title || "未命名资料"}`,
        `来源：${item.url || item.relative || item.absolute || "本地资料"}`,
        item.snippet ? `摘要：${truncateForPromptTokens(item.snippet, 800)}` : ""
      ].filter(Boolean).join("\n")).join("\n\n"));
    }
  }

  return parts.join("\n\n");
}
};
