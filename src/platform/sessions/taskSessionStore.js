// @ts-check

const path = require("node:path");
const { KeyedSerialExecutor } = require("../shared/keyedSerialExecutor");
const { ensureDirectoryInside } = require("./sessionEventFile");
const executionReceipts = require("./taskExecutionReceiptStore");
const messageActions = require("./taskSessionMessageActions");
const migrationActions = require("./taskSessionMigrationActions");
const queryActions = require("./taskSessionQueryActions");
const {
  SESSION_VERSION,
  MAX_MESSAGE_WINDOW,
  SESSION_INLINE_CONTENT_CHARS
} = require("./taskSessionPolicy");

class TaskSessionStore {
  /** @param {{projectService?:any, legacyMigration?:any, clock?:() => Date}} options */
  constructor({ projectService, legacyMigration = null, clock = () => new Date() } = {}) {
    if (!projectService) throw new Error("TaskSessionStore 缺少 projectService。");
    this.projectService = projectService;
    this.legacyMigration = legacyMigration;
    this.clock = clock;
    this.writes = new KeyedSerialExecutor();
    this.migrations = new Map();
  }

  getSessionDir(projectId = "", taskId = "") {
    return path.join(this.projectService.getTaskDir(projectId, taskId), "session");
  }

  getEventsFile(projectId = "", taskId = "") {
    return path.join(this.getSessionDir(projectId, taskId), "events.jsonl");
  }

  getSessionMemoryFile(projectId = "", taskId = "") {
    return path.join(this.getSessionDir(projectId, taskId), "memory.md");
  }

  getSessionMemoryStateFile(projectId = "", taskId = "") {
    return path.join(this.getSessionDir(projectId, taskId), ".memory.state.json");
  }

  getContentBodyFile(projectId = "", taskId = "", sha256 = "") {
    return path.join(
      this.projectService.getTaskDir(projectId, taskId),
      "agent-inputs",
      "content",
      `${sha256}.md`
    );
  }

  getStorageRoot(projectId = "", taskId = "") {
    const configured = `${this.projectService.paths?.workspace || ""}`;
    if (configured) return path.resolve(configured);
    const taskDir = path.resolve(this.projectService.getTaskDir(projectId, taskId));
    const projectsDir = path.dirname(path.dirname(path.dirname(taskDir)));
    return path.dirname(projectsDir);
  }

  /** @param {string} projectId @param {string} taskId @param {...string} segments */
  async ensureStorageDirectory(projectId, taskId, ...segments) {
    const taskDir = path.resolve(this.projectService.getTaskDir(projectId, taskId));
    return ensureDirectoryInside(
      this.getStorageRoot(projectId, taskId),
      path.join(taskDir, ...segments)
    );
  }

  async resolveEventsFile(projectId = "", taskId = "") {
    const directory = await this.ensureStorageDirectory(projectId, taskId, "session");
    return path.join(directory, "events.jsonl");
  }

  async resolveSessionMemoryFile(projectId = "", taskId = "") {
    const directory = await this.ensureStorageDirectory(projectId, taskId, "session");
    return path.join(directory, "memory.md");
  }

  async resolveSessionMemoryStateFile(projectId = "", taskId = "") {
    const directory = await this.ensureStorageDirectory(projectId, taskId, "session");
    return path.join(directory, ".memory.state.json");
  }

  async resolveContentBodyFile(projectId = "", taskId = "", sha256 = "") {
    const directory = await this.ensureStorageDirectory(projectId, taskId, "agent-inputs", "content");
    return path.join(directory, `${sha256}.md`);
  }

  async externalizeInput(input = {}) {
    return messageActions.externalizeInput(this, input);
  }

  async externalizeHistory(input = {}) {
    return queryActions.externalizeHistory(this, input);
  }

  async appendMessage(input = {}) {
    return messageActions.appendMessage(this, input);
  }

  async appendEvent(event = {}, options = {}) {
    return messageActions.appendEvent(this, event, options);
  }

  async appendDurableEvent(projectId = "", taskId = "", row = {}) {
    return messageActions.appendDurableEvent(this, projectId, taskId, row);
  }

  async listMessages(input = {}) {
    return queryActions.listMessages(this, input);
  }

  async listMessageWindow(input = {}) {
    return queryActions.listMessageWindow(this, input);
  }

  async findMessage(input = {}) {
    return queryActions.findMessage(this, input);
  }

  async findEvent(input = {}) {
    return queryActions.findEvent(this, input);
  }

  async findLatestEvent(input = {}) {
    return queryActions.findLatestEvent(this, input);
  }

  async scanEventById(projectId = "", taskId = "", eventId = "") {
    return queryActions.scanEventById(this, projectId, taskId, eventId);
  }

  async findTurnExecutionRows(projectId = "", taskId = "", turnId = "") {
    return queryActions.findTurnExecutionRows(this, projectId, taskId, turnId);
  }

  async persistContentBody(projectId = "", taskId = "", content = "") {
    return messageActions.persistContentBody(this, projectId, taskId, content);
  }

  async hydrateEvent(projectId = "", taskId = "", row = {}) {
    return messageActions.hydrateEvent(this, projectId, taskId, row);
  }

  async readContentBodyRef(input = {}) {
    return messageActions.readContentBodyRef(this, input);
  }

  async beginTurnExecution(input = {}) {
    return executionReceipts.beginTurnExecution(this, input);
  }

  async finishTurnExecution(input = {}) {
    return executionReceipts.finishTurnExecution(this, input);
  }

  async findTurnExecution(input = {}) {
    return executionReceipts.findTurnExecution(this, input);
  }

  async ensureMigrated(projectId = "", taskId = "") {
    return migrationActions.ensureMigrated(this, projectId, taskId);
  }

  async readLegacyMessages(projectId = "", taskId = "") {
    return migrationActions.readLegacyMessages(this, projectId, taskId);
  }
}

module.exports = {
  SESSION_VERSION,
  MAX_MESSAGE_WINDOW,
  SESSION_INLINE_CONTENT_CHARS,
  TaskSessionStore
};
