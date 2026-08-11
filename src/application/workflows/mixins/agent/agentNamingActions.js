const {
  primaryRequestText,
  summarizeNameFromMessage,
  compactGeneratedName,
  summarizeProjectNameFromMessage,
  isAutoProjectName,
  isAutoTaskTitle,
  parseJsonObjectFromText
} = require("../../../../platform/runtime");

module.exports = {
scheduleAutoNameFromFirstMessage({ projectId = "", taskId = "", message = "" } = {}) {
  if (!this.projectService || !projectId || !taskId || !message.trim()) return;
  const key = `${projectId}::${taskId}`;
  if (this.autoNameJobs.has(key)) return;
  this.autoNameJobs.add(key);
  const scheduledAt = new Date().toISOString();
  setTimeout(() => {
    this.maybeAutoNameFromFirstMessage({ projectId, taskId, message, scheduledAt })
      .catch(() => null)
      .finally(() => this.autoNameJobs.delete(key));
  }, 0);
},

async generateAutoNamesWithAi({ project, task, message, shouldNameProject = false, shouldNameTask = false } = {}) {
  const promptBlock = await this.loadPromptBlockSafe("block://agent.naming");
  const input = [
    "<inputs>",
    `  <need_task_title>${shouldNameTask ? "true" : "false"}</need_task_title>`,
    `  <need_project_name>${shouldNameProject ? "true" : "false"}</need_project_name>`,
    `  <project_existing_name>${project?.name || ""}</project_existing_name>`,
    "  <first_user_message>",
    primaryRequestText(message) || message,
    "  </first_user_message>",
    "</inputs>"
  ].join("\n");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const raw = await this.aiRouter.runTask({
        taskType: "title",
        title: "首次任务自动命名",
        instruction: promptBlock,
        input,
        runContext: "",
        contextProfile: "minimal",
        contextBudget: { runContextTokens: 0, inputTokens: 400 },
        jsonMode: true,
        internalCall: true
      });
      const parsed = parseJsonObjectFromText(raw);
      if (parsed && (parsed.taskTitle || parsed.projectName)) return parsed;
    } catch { /* 一次短重试后使用确定性名称。 */ }
  }
  return {};
},

async loadPromptBlockSafe(blockId = "") {
  if (!blockId || !this.registryService) return "";
  try {
    const row = await this.registryService.getById("prompts/blocks", blockId);
    return row?.asset?.content || "";
  } catch {
    return "";
  }
},

async maybeAutoNameFromFirstMessage({ projectId = "", taskId = "", message = "", scheduledAt = "" } = {}) {
  if (!this.projectService || !projectId || !taskId || !message.trim()) return {};
  const project = await this.projectService.getProject(projectId, false);
  const task = await this.projectService.getTask(projectId, taskId, false);
  if (!project || !task || await this.hasUserMessagesBefore({ projectId, taskId, scheduledAt })) return {};

  const tasks = await this.projectService.listTasks(projectId).catch(() => []);
  const otherTasks = tasks.filter((item) => item.id !== taskId);
  const hasOtherMeaningfulTasks = (await Promise.all(
    otherTasks.map((item) => this.projectService.isMeaningfulTask(projectId, item).catch(() => true))
  )).some(Boolean);
  const shouldNameTask = isAutoTaskTitle(task.title);
  const shouldNameProject = !hasOtherMeaningfulTasks && isAutoProjectName(project.name);
  if (!shouldNameTask && !shouldNameProject) return {};

  const aiNames = await this.generateAutoNamesWithAi({
    project, task, message, shouldNameProject, shouldNameTask
  }).catch(() => ({}));
  const updates = {};
  if (shouldNameProject) {
    updates.project = await this.projectService.updateProject(projectId, {
      name: compactGeneratedName(aiNames.projectName, summarizeProjectNameFromMessage(message), 5),
      description: project.description || "根据第一个任务自动命名的项目。",
      type: "general",
      autoNamedAt: new Date().toISOString()
    });
  }
  if (shouldNameTask) {
    updates.task = await this.projectService.updateTask(projectId, taskId, {
      title: compactGeneratedName(aiNames.taskTitle, summarizeNameFromMessage(message, "新任务", 10), 10),
      autoNamedAt: new Date().toISOString()
    });
  }
  if (updates.project || updates.task) {
    this.emitActivity({
      projectId,
      taskId,
      status: "renamed",
      label: "命名完成",
      project: updates.project ? { id: updates.project.id, name: updates.project.name } : null,
      task: updates.task ? { id: updates.task.id, title: updates.task.title } : null
    });
  }
  return updates;
}
};
