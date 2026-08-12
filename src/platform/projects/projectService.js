const {
  fsp,
  path,
  crypto,
  ensureDir,
  exists,
  readJson,
  writeJsonAtomic,
  writeTextAtomic,
  sanitizeFileName,
  summarizeProjectNameFromMessage,
  isAutoProjectName,
  isPlaceholderTaskBrief,
  isPlaceholderDerivedProjectName,
  isAutoTaskTitle,
  uniqueEntityId
} = require("../runtime");
const { normalizeProjectType } = require("../shared/legacyProjectMigration");
const projectTaskActions = require("./actions/projectTaskActions.js");
const projectFileReferenceActions = require("./actions/projectFileReferenceActions.js");
const { MemoryStore } = require("../memory/memoryStore");
const { KeyedSerialExecutor } = require("../shared/keyedSerialExecutor");
const { LegacyChatMigrationAdapter } = require("./legacyChatMigrationAdapter");

class ProjectService {
  constructor(paths, settingsService, { memoryStore = null } = {}) {
    this.paths = paths;
    this.settingsService = settingsService;
    this.staleLegacyChatDataPruned = false;
    this.taskWrites = new KeyedSerialExecutor();
    this.taskFileWrites = new KeyedSerialExecutor();
    this.legacyChatMigration = new LegacyChatMigrationAdapter(paths, {
      ensureLegacyProject: () => this.ensureLegacyImportedProject()
    });
    // 应用组合注入 home 级 Memdir；独立测试默认把 Memdir 隔离在测试 workspace。
    this.memoryStore = memoryStore || new MemoryStore({
      workspaceRoot: paths.projectRoot,
      baseDirectory: path.join(paths.privateDir, "memdir")
    });
  }

  async ensure() {
    await ensureDir(this.paths.projectsDir);
    const marker = path.join(this.paths.projectsDir, ".initialized");
    await this.retireLegacyGeneralAgentProject();
    if (!(await exists(marker))) {
      await writeTextAtomic(marker, new Date().toISOString());
    }

    await this.normalizeLegacyProjectTypes();
    const entries = await fsp.readdir(this.paths.projectsDir);
    for (const entry of entries) {
      const projectFile = path.join(this.paths.projectsDir, entry, "project.json");
      if (await exists(projectFile)) {
        await this.ensureProjectStructure(entry);
      }
    }
    await this.normalizeReusableBlankProjects();
    await this.normalizeAutoProjectNamesFromTasks();
    if (!this.staleLegacyChatDataPruned) {
      await this.pruneStaleLegacyChatDataForExistingProjects();
      this.staleLegacyChatDataPruned = true;
    }
  }

  async retireLegacyGeneralAgentProject() {
    const project = await this.getProject("general-agent", false);
    if (!project || project.name !== "通用 Agent") return { retired: false };
    if (!await this.legacyGeneralAgentHasAuthoredContent(project)) {
      await fsp.rm(this.getProjectDir(project.id), { recursive: true, force: true });
      await this.legacyChatMigration.prune({ projectId: project.id });
      return { retired: true, preserved: false };
    }
    await this.updateProject(project.id, {
      name: "新项目",
      description: "从旧版通用 Agent 项目迁移，原有任务和文件已保留。"
    });
    return { retired: true, preserved: true };
  }

  async legacyGeneralAgentHasAuthoredContent(project) {
    if (await exists(path.join(this.getProjectDir(project.id), "memory"))) return true;
    const tasks = await this.listTasks(project.id).catch(() => []);
    if (tasks.length > 1) return true;
    for (const task of tasks) {
      if (!await this.isBlankTask(project.id, task)) return true;
    }
    if (await this.legacyChatMigration.projectHasLegacyContent(project.id)) return true;
    for (const dirName of ["assets", "archive", "workflows"]) {
      if (await this.directoryHasNonemptyFiles(path.join(this.getProjectDir(project.id), dirName))) return true;
    }
    return false;
  }

  async directoryHasNonemptyFiles(dir) {
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (await this.directoryHasNonemptyFiles(absolute)) return true;
        continue;
      }
      if (entry.isFile() && (await fsp.stat(absolute)).size > 0) return true;
    }
    return false;
  }

  getProjectDir(projectId) {
    return path.join(this.paths.projectsDir, sanitizeFileName(projectId, "project"));
  }

  getTaskDir(projectId, taskId) {
    return path.join(this.getProjectDir(projectId), "tasks", sanitizeFileName(taskId, "task"));
  }

  async ensureProjectStructure(projectId) {
    const project = await this.getProject(projectId, false);
    if (!project) return;
    const projectDir = this.getProjectDir(projectId);
    await Promise.all([
      ensureDir(path.join(projectDir, "tasks")),
      ensureDir(path.join(projectDir, "assets")),
      ensureDir(path.join(projectDir, "archive"))
    ]);
  }

  async normalizeLegacyProjectTypes() {
    const entries = await fsp.readdir(this.paths.projectsDir).catch(() => []);
    for (const entry of entries) {
      const file = path.join(this.paths.projectsDir, entry, "project.json");
      if (!(await exists(file))) continue;
      const project = await readJson(file, {});
      const type = normalizeProjectType(project.type);
      const { defaultWorkflowId: _legacyWorkflowId, ...canonicalProject } = project;
      if (project.type !== type || "defaultWorkflowId" in project) {
        await writeJsonAtomic(file, {
          ...canonicalProject,
          type,
          updatedAt: new Date().toISOString()
        });
      }
      const tasksDir = path.join(this.getProjectDir(entry), "tasks");
      const taskEntries = await fsp.readdir(tasksDir, { withFileTypes: true }).catch(() => []);
      for (const taskEntry of taskEntries.filter((item) => item.isDirectory())) {
        const taskFile = path.join(tasksDir, taskEntry.name, "task.json");
        if (!(await exists(taskFile))) continue;
        const task = await readJson(taskFile, {});
        if (!("workflowId" in task)) continue;
        const { workflowId: _legacyTaskWorkflowId, ...canonicalTask } = task;
        await writeJsonAtomic(taskFile, canonicalTask);
      }
    }
  }

  async listProjects() {
    await this.ensure();
    const entries = await fsp.readdir(this.paths.projectsDir);
    const projects = [];
    for (const entry of entries.sort()) {
      const file = path.join(this.paths.projectsDir, entry, "project.json");
      if (await exists(file)) {
        const project = await readJson(file, {});
        const tasks = await this.listTasks(project.id);
        projects.push({
          ...project,
          taskCount: tasks.length
        });
      }
    }
    return projects.sort((a, b) => `${b.createdAt || ""}`.localeCompare(`${a.createdAt || ""}`));
  }

  async ensureLegacyImportedProject() {
    const projectDir = this.getProjectDir("legacy");
    const projectFile = path.join(projectDir, "project.json");
    if (!(await exists(projectFile))) {
      await ensureDir(projectDir);
      await writeJsonAtomic(projectFile, {
        id: "legacy",
        name: "历史任务",
        description: "从旧版全局消息日志迁移而来的未归属任务。",
        type: "general",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
    }
    await this.ensureProjectStructure("legacy");
  }

  async hasTaskSessionEntries(projectId = "", taskId = "", since = "") {
    if (!projectId || !taskId) return false;
    const sinceTime = Date.parse(since || "");
    const hasSince = Number.isFinite(sinceTime);
    const eventsFile = path.join(this.getTaskDir(projectId, taskId), "session", "events.jsonl");
    const content = await fsp.readFile(eventsFile, "utf8").catch(() => "");
    for (const line of content.split(/\n+/)) {
      if (!line.trim()) continue;
      try {
        const item = JSON.parse(line);
        if (item.type !== "message" || !["user", "assistant", "system"].includes(item.role)) continue;
        if (hasSince) {
          const created = Date.parse(item.createdAt || "");
          if (!Number.isFinite(created) || created < sinceTime - 1000) continue;
        }
        return true;
      } catch {
        // 忽略单条损坏的任务事件。
      }
    }
    return this.legacyChatMigration.hasTaskMessages(projectId, taskId, since);
  }

  async getProject(projectId, throwIfMissing = true) {
    const file = path.join(this.getProjectDir(projectId), "project.json");
    if (!(await exists(file))) {
      if (throwIfMissing) throw new Error(`找不到项目：${projectId}`);
      return null;
    }
    return readJson(file, null);
  }

  async isBlankTask(projectId, task = {}) {
    if (!task?.id || !isAutoTaskTitle(task.title)) return false;
    if (task.lastRunId || task.lastArtifact || task.lastRunAt) return false;
    if (await this.hasTaskSessionEntries(projectId, task.id, task.createdAt)) return false;
    const taskDir = this.getTaskDir(projectId, task.id);
    if (await exists(path.join(taskDir, "memory"))) return false;
    for (const dirName of [
      "runs",
      "final",
      "drafts",
      "sources",
      "assets",
      ".candidates",
      "agent-state",
      "agent-traces",
      "context-results",
      "inspection-snapshots"
    ]) {
      const dir = path.join(taskDir, dirName);
      if (!(await exists(dir))) continue;
      const entries = await fsp.readdir(dir).catch(() => []);
      if (entries.some((entry) => !entry.startsWith("."))) return false;
    }
    return true;
  }

  async isReusableBlankProject(project = {}) {
    if (!project?.id || !isAutoProjectName(project.name) || project.autoNamedAt) return false;
    if (await exists(path.join(this.getProjectDir(project.id), "memory"))) return false;
    const tasks = await this.listTasks(project.id).catch(() => []);
    if (!tasks.length) return true;
    return tasks.length === 1 && await this.isBlankTask(project.id, tasks[0]);
  }

  async findReusableBlankProject(payload = {}) {
    await ensureDir(this.paths.projectsDir);
    const entries = await fsp.readdir(this.paths.projectsDir);
    const candidates = [];
    for (const entry of entries) {
      const file = path.join(this.paths.projectsDir, entry, "project.json");
      if (!(await exists(file))) continue;
      const project = await readJson(file, {});
      if (await this.isReusableBlankProject(project)) candidates.push(project);
    }
    candidates.sort((a, b) => `${b.createdAt || ""}`.localeCompare(`${a.createdAt || ""}`));
    return candidates[0] || null;
  }

  async normalizeReusableBlankProjects() {
    const entries = await fsp.readdir(this.paths.projectsDir).catch(() => []);
    for (const entry of entries) {
      const file = path.join(this.paths.projectsDir, entry, "project.json");
      if (!(await exists(file))) continue;
      const project = await readJson(file, {});
      if (!await this.isReusableBlankProject(project)) continue;
      const patch = {};
      if (project.name !== "新项目") patch.name = "新项目";
      if (project.description !== "第一次工作后会自动命名。") patch.description = "第一次工作后会自动命名。";
      if (Object.keys(patch).length) await this.updateProject(project.id, patch);
      const tasks = await this.listTasks(project.id).catch(() => []);
      for (const task of tasks) {
        if (await this.isBlankTask(project.id, task) && task.title !== "新任务") {
          await this.updateTask(project.id, task.id, { title: "新任务" });
        }
      }
    }
  }

  async isMeaningfulTask(projectId, task = {}) {
    if (!task?.id) return false;
    if (await this.isBlankTask(projectId, task)) return false;
    return Boolean(
      task.brief ||
      task.autoNamedAt ||
      task.lastRunId ||
      task.lastArtifact ||
      task.lastRunAt ||
      !isAutoTaskTitle(task.title) ||
      await this.hasTaskSessionEntries(projectId, task.id, task.createdAt)
    );
  }

  async normalizeAutoProjectNamesFromTasks() {
    const entries = await fsp.readdir(this.paths.projectsDir).catch(() => []);
    for (const entry of entries) {
      const file = path.join(this.paths.projectsDir, entry, "project.json");
      if (!(await exists(file))) continue;
      const project = await readJson(file, {});
      if (!project?.id) continue;

      // 自愈：上一版本误用占位 brief 派生的项目名（如"这是项目第"），重置为"新项目"，
      // 并清空 autoNamedAt，让后续步骤能重新命名。
      if (isPlaceholderDerivedProjectName(project.name)) {
        await this.updateProject(project.id, { name: "新项目", autoNamedAt: undefined });
        project.name = "新项目";
        project.autoNamedAt = undefined;
      }

      if (!isAutoProjectName(project.name)) continue;
      const tasks = await this.listTasks(project.id).catch(() => []);
      const meaningful = [];
      for (const task of tasks) {
        if (await this.isMeaningfulTask(project.id, task)) meaningful.push(task);
      }
      if (meaningful.length !== 1) continue;
      const task = meaningful[0];

      // 选择命名信号：拒绝从占位 brief 派生（会得到"这是项目第"这类垃圾名）。
      // 可信源优先级：非占位 brief > 非自动 task title > 跳过（等下次重命名机会）。
      let nameSource = "";
      if (task.brief && !isPlaceholderTaskBrief(task.brief)) {
        nameSource = task.brief;
      } else if (task.title && !isAutoTaskTitle(task.title)) {
        nameSource = task.title;
      }
      if (!nameSource) continue;

      await this.updateProject(project.id, {
        name: summarizeProjectNameFromMessage(nameSource),
        autoNamedAt: new Date().toISOString()
      });
    }
  }

  async pruneStaleLegacyChatDataForExistingProjects() {
    const cutoffs = new Map();
    const entries = await fsp.readdir(this.paths.projectsDir).catch(() => []);
    for (const entry of entries) {
      const file = path.join(this.paths.projectsDir, entry, "project.json");
      if (!(await exists(file))) continue;
      const project = await readJson(file, {});
      const projectCutoff = Date.parse(project.createdAt || "");
      if (project.id && Number.isFinite(projectCutoff)) {
        cutoffs.set(`${project.id}::`, projectCutoff);
      }
      const tasks = project.id ? await this.listTasks(project.id).catch(() => []) : [];
      for (const task of tasks) {
        const taskCutoff = Date.parse(task.createdAt || project.createdAt || "");
        if (task.id && Number.isFinite(taskCutoff)) {
          cutoffs.set(`${project.id}::${task.id}`, taskCutoff);
        }
      }
    }
    return this.legacyChatMigration.pruneStale(cutoffs);
  }

  async createProject(payload = {}) {
    if (payload.reuseBlank) {
      const reusable = await this.findReusableBlankProject(payload);
      if (reusable) {
        const patch = {
          name: payload.name || "新项目",
          description: payload.description || reusable.description || "",
          type: "general"
        };
        const updated = await this.updateProject(reusable.id, patch);
        return { ...updated, reused: true };
      }
    }
    let id = sanitizeFileName(payload.id || uniqueEntityId("project"), "project");
    if (await exists(path.join(this.getProjectDir(id), "project.json"))) {
      id = sanitizeFileName(`${id}-${crypto.randomUUID().slice(0, 8)}`, "project");
    }
    const project = {
      id,
      name: payload.name || "新项目",
      type: "general",
      description: payload.description || "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    await ensureDir(this.getProjectDir(id));
    await writeJsonAtomic(path.join(this.getProjectDir(id), "project.json"), project);
    await this.ensureProjectStructure(id);
    return project;
  }

  async updateProject(projectId, patch = {}) {
    const project = await this.getProject(projectId);
    const { defaultWorkflowId: _storedWorkflowId, ...canonicalProject } = project;
    const { defaultWorkflowId: _legacyWorkflowId, ...canonicalPatch } = patch || {};
    const next = {
      ...canonicalProject,
      ...canonicalPatch,
      id: project.id,
      type: "general",
      updatedAt: new Date().toISOString()
    };
    await writeJsonAtomic(path.join(this.getProjectDir(projectId), "project.json"), next);
    await this.ensureProjectStructure(projectId);
    return next;
  }

  async deleteProject(projectId) {
    const project = await this.getProject(projectId);
    await fsp.rm(this.getProjectDir(projectId), { recursive: true, force: true });
    await this.legacyChatMigration.prune({ projectId });
    return { deleted: true, project };
  }


}

Object.assign(
  ProjectService.prototype,
  projectTaskActions,
  projectFileReferenceActions
);

module.exports = {
  ProjectService
};
