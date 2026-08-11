// 显式发布的成品与运行交付摘要；不保存消息、不做内容类型猜测。
const { fsp, path, exists } = require("../../../platform/runtime");
const {
  stripInternalToolProtocol
} = require("../../../platform/shared/internalToolProtocol");

module.exports = {
async loadLatestDeliverable({ projectId = "", taskId = "", runId = "" } = {}) {
  if (!this.projectService || !projectId || !taskId) return null;
  if (runId) {
    const runResult = await this.getRun(runId).catch(() => null);
    const current = await this.readPublishedTextArtifact(
      this.findExplicitPublishedArtifact(runResult?.run || runResult)
    );
    if (current) return current;
  }
  const task = await this.projectService.getTask(projectId, taskId, false);
  const files = typeof this.projectService.listTaskFiles === "function"
    ? await this.projectService.listTaskFiles(projectId, taskId).catch(() => [])
    : [];
  const published = files.filter((item) => this.isExplicitPublishedArtifact(item));
  const head = published.find((item) => (
    task?.lastArtifact && path.resolve(item.absolute || "") === path.resolve(task.lastArtifact)
  ));
  const current = await this.readPublishedTextArtifact(head);
  if (current) return current;
  if (task?.lastRunId) {
    const runResult = await this.getRun(task.lastRunId).catch(() => null);
    const previous = await this.readPublishedTextArtifact(
      this.findExplicitPublishedArtifact(runResult?.run || runResult)
    );
    if (previous) return previous;
  }
  for (const file of published) {
    const candidate = await this.readPublishedTextArtifact(file);
    if (candidate) return candidate;
  }
  return null;
},

async readPublishedTextArtifact(record = null) {
  if (!this.isExplicitPublishedArtifact(record)) return null;
  const absolute = `${record?.absolute || record?.artifact?.absolute || ""}`.trim();
  if (!absolute || !this.isTextDeliverablePath(absolute) || !(await exists(absolute))) return null;
  const content = `${await fsp.readFile(absolute, "utf8").catch(() => "")}`.trim();
  return content ? { content, source: absolute } : null;
},

isTextDeliverablePath(filePath = "") {
  return [".md", ".markdown", ".txt", ".html", ".htm", ".json", ".csv", ".tsv", ".xml", ".svg"]
    .includes(path.extname(`${filePath || ""}`).toLowerCase());
},

stripInternalDisclosure(content = "") {
  return stripInternalToolProtocol(`${content || ""}`).trim();
},

async cleanupRunProcessFiles(runId = "") {
  if (!runId) return;
  const settings = await this.settingsService.get();
  if (settings.fileStorage?.keepStepOutputs !== false) return;
  const state = await this.readRun(runId);
  for (const dirName of ["outputs", "sources", "assets"]) {
    await fsp.rm(path.join(state.runDir, dirName), { recursive: true, force: true }).catch(() => {});
  }
},

buildArtifactReply({ artifact }) {
  return [
    `已完成：${artifact?.title || "最终成品"}`,
    "点击下面的文件卡，可以在右侧预览完整成品。"
  ].join("\n");
},

buildWorkflowRunReply({ result, artifact }) {
  const run = result?.run || {};
  if (artifact) return this.buildArtifactReply({ artifact });
  const blocked = (Array.isArray(run.steps) ? run.steps : []).find((step) => step.status === "blocked");
  if (!blocked) return "";
  const reason = `${blocked.error || ""}`.trim() || "需要人工补充配置或材料";
  return `已暂停在「${blocked.title || blocked.id || "当前步骤"}」：${reason}`;
}
};
