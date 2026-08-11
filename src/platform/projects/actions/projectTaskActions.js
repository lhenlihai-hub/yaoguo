const {
  fsp,
  path,
  crypto,
  ensureDir,
  exists,
  readJson,
  writeJsonAtomic,
  sanitizeFileName,
  uniqueEntityId
} = require("../../runtime");
const { isPathInside } = require("../../shared/pathSafety");
const {
  captureWorkspaceIdentity,
  hasWorkspaceIdentity,
  verifyWorkspaceIdentity
} = require("../workspaceIdentity");
const {
  normalizeAgentMemoryProfile,
  agentMemoryContext
} = require("../../memory/memdir/agentMemoryProfile");
class ProjectTaskActions {
  async listTasks(projectId) {
    const tasksDir = path.join(this.getProjectDir(projectId), "tasks");
    await ensureDir(tasksDir);
    const entries = await fsp.readdir(tasksDir);
    const tasks = [];
    for (const entry of entries.sort()) {
      const file = path.join(tasksDir, entry, "task.json");
      if (await exists(file)) tasks.push(await readJson(file, {}));
    }
    return tasks.sort((a, b) => `${b.updatedAt || b.createdAt}`.localeCompare(`${a.updatedAt || a.createdAt}`));
  }

  async getTask(projectId, taskId, throwIfMissing = true) {
    const file = path.join(this.getTaskDir(projectId, taskId), "task.json");
    if (!(await exists(file))) {
      if (throwIfMissing) throw new Error(`找不到任务：${taskId}`);
      return null;
    }
    return readJson(file, null);
  }

  async createTask(projectId, payload = {}) {
    await this.getProject(projectId);
    let id = sanitizeFileName(payload.id || uniqueEntityId("task"), "task");
    if (await exists(path.join(this.getTaskDir(projectId, id), "task.json"))) {
      id = sanitizeFileName(`${id}-${crypto.randomUUID().slice(0, 8)}`, "task");
    }
    const taskDir = this.getTaskDir(projectId, id);
    await Promise.all([
      ensureDir(taskDir),
      ensureDir(path.join(taskDir, "runs")),
      ensureDir(path.join(taskDir, "assets")),
      ensureDir(path.join(taskDir, "drafts")),
      ensureDir(path.join(taskDir, "final")),
      ensureDir(path.join(taskDir, "sources"))
    ]);
    await writeJsonAtomic(path.join(taskDir, ".agent-files.json"), {
      version: 3,
      importedAt: new Date().toISOString(),
      reconciledAt: new Date().toISOString(),
      files: []
    });
    const task = {
      id,
      projectId,
      title: payload.title || "新任务",
      brief: payload.brief || "",
      status: payload.status || "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      taskDir,
      ...(Object.hasOwn(payload, "agentMemory")
        ? { agentMemory: normalizeAgentMemoryProfile(payload.agentMemory) }
        : {})
    };
    await writeJsonAtomic(path.join(taskDir, "task.json"), task);
    return task;
  }

  async updateTask(projectId, taskId, patch = {}) {
    const operation = async () => {
      const task = await this.getTask(projectId, taskId);
      const { workflowId: _storedWorkflowId, ...canonicalTask } = task;
      const { workflowId: _legacyWorkflowId, ...canonicalPatch } = patch || {};
      const memoryPatch = Object.hasOwn(canonicalPatch, "agentMemory")
        ? {
          agentMemory: canonicalPatch.agentMemory == null
            ? null
            : normalizeAgentMemoryProfile(canonicalPatch.agentMemory)
        }
        : {};
      const next = {
        ...canonicalTask,
        ...canonicalPatch,
        ...memoryPatch,
        id: task.id,
        projectId: task.projectId,
        updatedAt: new Date().toISOString()
      };
      await writeJsonAtomic(path.join(this.getTaskDir(projectId, taskId), "task.json"), next);
      return next;
    };
    return this.taskWrites?.run
      ? this.taskWrites.run(`${projectId}::${taskId}`, operation)
      : operation();
  }

  async bindTaskWorkspace(projectId, taskId, requestedPath) {
    const workspaceIdentity = await captureWorkspaceIdentity(requestedPath);
    const workspacePath = workspaceIdentity.canonicalPath;
    const hostWorkspace = await fsp.realpath(this.paths.workspace)
      .catch(() => path.resolve(this.paths.workspace));
    if (isPathInside(hostWorkspace, workspacePath) || isPathInside(workspacePath, hostWorkspace)) {
      throw new Error("不能把腰果的宿主数据目录或其上级目录设为 Agent 工作空间。");
    }
    await verifyWorkspaceIdentity(workspacePath, workspaceIdentity);
    return this.updateTask(projectId, taskId, { workspacePath, workspaceIdentity });
  }

  async clearTaskWorkspace(projectId, taskId) {
    return this.updateTask(projectId, taskId, {
      workspacePath: "",
      workspaceIdentity: null
    });
  }

  async configureTaskAgentMemory(projectId, taskId, profile = {}) {
    return this.updateTask(projectId, taskId, {
      agentMemory: normalizeAgentMemoryProfile(profile)
    });
  }

  async exportTaskAgentMemorySnapshot(projectId, taskId, options = {}) {
    const store = await this.resolveTaskAgentMemoryStore(projectId, taskId);
    return store.exportSnapshotJson(options);
  }

  async importTaskAgentMemorySnapshot(projectId, taskId, snapshot, options = {}) {
    const store = await this.resolveTaskAgentMemoryStore(projectId, taskId);
    return store.importSnapshot(snapshot, options);
  }

  async resolveTaskAgentMemoryStore(projectId, taskId) {
    if (!this.memoryStore?.forContext) throw new Error("ProjectService 缺少 Agent Memdir");
    const task = await this.getTask(projectId, taskId);
    let workspaceRoot = `${task.workspacePath || ""}`.trim();
    if (workspaceRoot) {
      const resolved = await this.resolveTaskWorkspace(projectId, taskId);
      workspaceRoot = `${resolved.workspacePath || workspaceRoot}`;
    }
    if (!workspaceRoot) workspaceRoot = this.getProjectDir(projectId);
    return this.memoryStore.forContext({
      workspaceRoot,
      ...agentMemoryContext(task.agentMemory || {})
    });
  }

  async resolveTaskWorkspace(projectId, taskId) {
    const operation = async () => {
      const task = await this.getTask(projectId, taskId);
      const workspacePath = `${task.workspacePath || ""}`.trim();
      if (!workspacePath) {
        return { task, workspacePath: "", workspaceIdentity: null, backfilled: false };
      }
      const hadIdentity = hasWorkspaceIdentity(task.workspaceIdentity);
      const workspaceIdentity = await verifyWorkspaceIdentity(
        workspacePath,
        hadIdentity ? task.workspaceIdentity : undefined
      );
      if (hadIdentity) {
        return {
          task,
          workspacePath: workspaceIdentity.canonicalPath,
          workspaceIdentity,
          backfilled: false
        };
      }
      const next = {
        ...task,
        workspacePath: workspaceIdentity.canonicalPath,
        workspaceIdentity,
        updatedAt: new Date().toISOString()
      };
      await writeJsonAtomic(path.join(this.getTaskDir(projectId, taskId), "task.json"), next);
      return {
        task: next,
        workspacePath: workspaceIdentity.canonicalPath,
        workspaceIdentity,
        backfilled: true
      };
    };
    return this.taskWrites?.run
      ? this.taskWrites.run(`${projectId}::${taskId}`, operation)
      : operation();
  }

  async deleteTask(projectId, taskId) {
    const task = await this.getTask(projectId, taskId);
    await fsp.rm(this.getTaskDir(projectId, taskId), { recursive: true, force: true });
    await this.legacyChatMigration?.prune?.({ projectId, taskId });
    return { deleted: true, task };
  }


}

module.exports = Object.fromEntries(
  Object.getOwnPropertyNames(ProjectTaskActions.prototype)
    .filter((name) => name !== "constructor")
    .map((name) => [name, ProjectTaskActions.prototype[name]])
);
