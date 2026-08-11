"use strict";

const { ansi, createTuiTheme, formatHeader } = require("./theme");

const COMMANDS = Object.freeze([
  { name: "model", description: "模型、思考强度与 API Key" },
  { name: "usage", description: "token、缓存命中与模型调用" },
  { name: "resume", description: "打开或删除历史会话" },
  { name: "new", description: "在当前工作空间新建会话" },
  { name: "permissions", description: "Ask / All agree 授权模式" },
  { name: "clear", description: "清空当前屏幕，不删除会话" },
  { name: "help", description: "查看终端菜单与快捷键" },
  { name: "quit", description: "退出腰果" }
]);

async function createTerminalUi(options = {}) {
  const toolkit = options.toolkit || await import("@earendil-works/pi-tui");
  return new YaoguoTerminalUi(toolkit, options);
}

class YaoguoTerminalUi {
  constructor(toolkit, options = {}) {
    this.kit = toolkit;
    this.theme = createTuiTheme();
    this.terminal = options.terminal || new toolkit.ProcessTerminal();
    this.tui = new toolkit.TUI(this.terminal, true);
    this.workspacePath = `${options.workspacePath || process.cwd()}`;
    this.taskTitle = `${options.taskTitle || "当前会话"}`;
    this.modelLabel = `${options.modelLabel || "Pro"}`;
    this.thinkingLabel = `${options.thinkingLabel || "Max"}`;
    this.permissionLabel = `${options.permissionLabel || "Ask"}`;
    this.keyAvailable = Boolean(options.keyAvailable);
    this.version = `${options.version || "0.0.0"}`;
    this.usageText = "";
    this.activity = "";
    this.busy = false;
    this.stopped = false;
    this.loader = null;
    this.messageRecords = [];
    this.modalCancels = new Set();
    this.onSubmit = null;
    this.onInterrupt = null;
    this.resolveExit = null;
    this.activeStream = null;
    this.statusTimer = null;
    this.exitPromise = new Promise((resolve) => { this.resolveExit = resolve; });
    this.buildLayout();
  }

  buildLayout() {
    const { CombinedAutocompleteProvider, Editor, Spacer, Text } = this.kit;
    this.header = new Text(formatHeader(this.version), 1, 0);
    this.sessionInfo = new Text(
      formatSessionInfo(this.workspacePath, this.taskTitle),
      1,
      0
    );
    this.editor = new Editor(this.tui, this.theme.editor, {
      paddingX: 1,
      autocompleteMaxVisible: 7
    });
    this.editor.setAutocompleteProvider(new CombinedAutocompleteProvider(
      COMMANDS,
      this.workspacePath
    ));
    this.status = new Text("", 1, 0);
    this.tui.addChild(this.header);
    this.tui.addChild(this.sessionInfo);
    this.tui.addChild(new Spacer(1));
    this.tui.addChild(this.editor);
    this.tui.addChild(this.status);
    this.tui.setFocus(this.editor);
    this.renderStatus();
  }

  start({ onSubmit, onInterrupt } = {}) {
    if (this.started) return;
    this.started = true;
    this.onSubmit = onSubmit;
    this.onInterrupt = onInterrupt;
    this.editor.onSubmit = (value) => {
      const message = `${value || ""}`.trim();
      if (!message || this.busy || this.stopped) return;
      this.editor.addToHistory(message);
      Promise.resolve(this.onSubmit?.(message)).catch((error) => {
        this.addError(error?.message || error);
        this.setBusy(false);
      });
    };
    this.removeGlobalInput = this.tui.addInputListener((data) => this.handleGlobalInput(data));
    this.tui.start();
    this.terminal.setTitle?.("腰果");
    this.tui.requestRender(true);
  }

  handleGlobalInput(data) {
    const { Key, matchesKey } = this.kit;
    if (matchesKey(data, Key.ctrl("c"))) {
      if (this.busy) {
        this.onInterrupt?.();
        this.addNotice("正在停止当前任务…");
      } else {
        this.exit();
      }
      return { consume: true };
    }
    if (this.busy && matchesKey(data, Key.escape)) {
      this.onInterrupt?.();
      this.addNotice("正在停止当前任务…");
      return { consume: true };
    }
    if (!this.busy && !this.editor.getText() && matchesKey(data, Key.ctrl("d"))) {
      this.exit();
      return { consume: true };
    }
    return undefined;
  }

  waitForExit() {
    return this.exitPromise;
  }

  exit() {
    if (this.stopped) return;
    this.stopped = true;
    this.removeLoader();
    for (const cancel of this.modalCancels) cancel();
    this.modalCancels.clear();
    this.removeGlobalInput?.();
    this.tui.stop();
    this.resolveExit?.();
  }

  async dispose() {
    this.exit();
    this.stopStatusTimer();
    await this.terminal.drainInput?.(250, 25).catch(() => {});
  }

  addConversationHistory(rows = []) {
    for (const row of rows) {
      const content = messageContent(row?.content);
      if (!content) continue;
      if (row.role === "user") this.addUserMessage(content);
      else if (row.role === "assistant") this.addAssistantMessage(content);
      else if (row.role === "system") this.addNotice(content);
    }
  }

  addUserMessage(text) {
    const { Container, Markdown, Text } = this.kit;
    const message = new Container();
    message.addChild(new Text(ansi.blueBright(ansi.bold("你")), 1, 0));
    message.addChild(new Markdown(
      `${text || ""}`,
      1,
      0,
      this.theme.markdown,
      this.theme.userText
    ));
    this.insertMessage(message);
    return message;
  }

  addAssistantMessage(text) {
    const stream = this.beginAssistant();
    this.finishAssistant(stream, text);
    return stream.component;
  }

  beginAssistant() {
    const { Container, Markdown, Text } = this.kit;
    const component = new Container();
    const label = new Text(ansi.blueBright(ansi.bold("正在分析任务")), 1, 0);
    const workflow = new Text("", 1, 0);
    const reasoningTitle = new Text("", 1, 0);
    const reasoning = new Markdown("", 1, 0, this.theme.markdown);
    const markdown = new Markdown("", 1, 0, this.theme.markdown);
    component.addChild(label);
    component.addChild(workflow);
    component.addChild(reasoningTitle);
    component.addChild(reasoning);
    component.addChild(markdown);
    this.insertMessage(component);
    const stream = {
      component,
      label,
      workflow,
      reasoningTitle,
      reasoning,
      markdown,
      text: "",
      reasoningText: "",
      streamed: false,
      startedAt: Date.now(),
      thinkingStartedAt: 0,
      thinkingEndedAt: 0,
      thinkingDurationMs: 0,
      thinkingSegmentStartedAt: 0,
      activities: new Map(),
      activityRows: [],
      finished: false
    };
    this.activeStream = stream;
    return stream;
  }

  appendAssistant(stream, delta) {
    if (!stream || !delta) return;
    stream.streamed = true;
    stream.text += `${delta}`;
    stream.markdown.setText(stream.text);
    this.removeLoader();
    this.tui.requestRender();
  }

  appendReasoning(stream, delta, event = {}) {
    if (!stream) return;
    const now = Date.now();
    if (event.phase === "complete") {
      const measured = Math.max(0, Number(event.durationMs) || 0);
      const fallback = stream.thinkingSegmentStartedAt ? now - stream.thinkingSegmentStartedAt : 0;
      stream.thinkingDurationMs += measured || fallback;
      stream.thinkingSegmentStartedAt = 0;
      stream.thinkingEndedAt = now;
      this.renderReasoningTitle(stream);
      this.tui.requestRender();
      return;
    }
    if (!delta) return;
    if (!stream.thinkingStartedAt) stream.thinkingStartedAt = now;
    if (!stream.thinkingSegmentStartedAt) stream.thinkingSegmentStartedAt = now;
    stream.reasoningText += `${delta}`;
    stream.reasoning.setText(stream.reasoningText);
    this.renderReasoningTitle(stream);
    this.startStatusTimer();
    this.tui.requestRender();
  }

  finishAssistant(stream, fallback = "") {
    if (!stream) return;
    stream.finished = true;
    if (stream.thinkingSegmentStartedAt) {
      stream.thinkingDurationMs += Date.now() - stream.thinkingSegmentStartedAt;
      stream.thinkingSegmentStartedAt = 0;
    }
    stream.thinkingEndedAt = stream.reasoningText ? Date.now() : 0;
    const finalText = stream.text || `${fallback || ""}`;
    stream.markdown.setText(finalText || "未生成可显示回复。");
    this.renderReasoningTitle(stream);
    this.tui.requestRender();
  }

  cancelAssistant(stream) {
    if (!stream) return;
    this.removeMessageRecord(stream.component);
  }

  addNotice(text) {
    const component = new this.kit.Text(ansi.muted(`◆ ${text || ""}`), 1, 0);
    this.insertMessage(component);
    return component;
  }

  addSuccess(text) {
    const component = new this.kit.Text(ansi.green(`✓ ${text || ""}`), 1, 0);
    this.insertMessage(component);
    return component;
  }

  addError(text) {
    const component = new this.kit.Text(ansi.red(`! ${text || ""}`), 1, 0);
    this.insertMessage(component);
    return component;
  }

  addArtifact(absolute) {
    if (absolute) this.addSuccess(`成品  ${absolute}`);
  }

  insertMessage(component) {
    const spacer = new this.kit.Spacer(1);
    const index = Math.max(0, this.tui.children.indexOf(this.editor));
    this.tui.children.splice(index, 0, spacer, component);
    this.messageRecords.push({ component, spacer });
    this.tui.requestRender();
  }

  removeMessageRecord(component) {
    const index = this.messageRecords.findIndex((record) => record.component === component);
    if (index < 0) return;
    const [record] = this.messageRecords.splice(index, 1);
    this.tui.removeChild(record.component);
    this.tui.removeChild(record.spacer);
    this.tui.requestRender();
  }

  clearConversation() {
    for (const record of this.messageRecords.splice(0)) {
      this.tui.removeChild(record.component);
      this.tui.removeChild(record.spacer);
    }
    this.activeStream = null;
    this.tui.requestRender(true);
  }

  replaceConversationHistory(rows = []) {
    this.clearConversation();
    this.addConversationHistory(rows);
  }

  updateSession({ workspacePath, taskTitle } = {}) {
    if (workspacePath) this.workspacePath = `${workspacePath}`;
    if (taskTitle) this.taskTitle = `${taskTitle}`;
    this.sessionInfo.setText(formatSessionInfo(this.workspacePath, this.taskTitle));
    this.renderStatus();
    this.tui.requestRender(true);
  }

  setBusy(value, label = "正在思考…") {
    this.busy = Boolean(value);
    this.editor.disableSubmit = this.busy;
    this.terminal.setProgress?.(this.busy);
    if (this.busy) {
      this.activity = label;
      this.ensureLoader(label);
      this.startStatusTimer();
    } else {
      this.activity = "";
      this.removeLoader();
      this.stopStatusTimer();
    }
    this.renderStatus();
    if (!this.busy) this.tui.setFocus(this.editor);
    this.tui.requestRender();
  }

  setActivity(label = "") {
    this.activity = `${label || ""}`;
    if (this.loader && this.activity) this.loader.setMessage(this.activity);
    this.renderStatus();
  }

  recordActivity(activity = {}) {
    const stream = this.activeStream;
    const label = `${activity.label || activity.status || ""}`.trim();
    if (!label) return;
    this.setActivity(label);
    if (!stream || stream.finished) return;
    stream.label.setText(ansi.blueBright(ansi.bold(label)));
    const key = `${activity.phase || activity.toolName || label}`;
    const now = Date.now();
    const target = `${activity.target || ""}`.trim();
    const existing = stream.activities.get(key);
    if (["running", "planning"].includes(activity.status)) {
      stream.activities.set(key, { label, target, startedAt: existing?.startedAt || now });
    } else {
      const startedAt = existing?.startedAt || now;
      stream.activities.delete(key);
      stream.activityRows.push({
        label,
        target: target || existing?.target || "",
        status: activity.status,
        durationMs: Math.max(0, now - startedAt)
      });
    }
    this.renderWorkflow(stream);
    this.tui.requestRender();
  }

  renderWorkflow(stream) {
    const completed = stream.activityRows.map((row) => {
      const icon = row.status === "blocked" ? "!" : "✓";
      const color = row.status === "blocked" ? ansi.red : ansi.green;
      const target = row.target ? `\n  ${ansi.muted(row.target)}` : "";
      return `${color(icon)} ${row.label} · ${formatElapsed(row.durationMs)}${target}`;
    });
    const running = [...stream.activities.values()].map((row) => {
      const target = row.target ? `\n  ${ansi.muted(row.target)}` : "";
      return `${ansi.blueBright("↳")} ${row.label} · ${formatElapsed(Date.now() - row.startedAt)}${target}`;
    });
    stream.workflow.setText([...completed, ...running].join("\n"));
  }

  renderReasoningTitle(stream) {
    if (!stream?.reasoningText) {
      stream?.reasoningTitle?.setText("");
      return;
    }
    const active = stream.thinkingSegmentStartedAt ? Date.now() - stream.thinkingSegmentStartedAt : 0;
    const duration = Math.max(0, stream.thinkingDurationMs + active);
    stream.reasoningTitle.setText(ansi.muted(`思考过程 · ${formatElapsed(duration)}`));
  }

  startStatusTimer() {
    if (this.statusTimer) return;
    this.statusTimer = setInterval(() => {
      if (this.activeStream && !this.activeStream.finished) {
        this.renderWorkflow(this.activeStream);
        this.renderReasoningTitle(this.activeStream);
      }
      this.renderStatus();
      this.tui.requestRender();
    }, 250);
    this.statusTimer.unref?.();
  }

  stopStatusTimer() {
    if (!this.statusTimer) return;
    clearInterval(this.statusTimer);
    this.statusTimer = null;
  }

  ensureLoader(label) {
    if (this.loader) {
      this.loader.setMessage(label);
      return;
    }
    this.loader = new this.kit.Loader(
      this.tui,
      (text) => ansi.blueBright(text),
      (text) => ansi.muted(text),
      label
    );
    const index = Math.max(0, this.tui.children.indexOf(this.editor));
    this.tui.children.splice(index, 0, this.loader);
    this.loader.start();
  }

  removeLoader() {
    if (!this.loader) return;
    this.loader.stop();
    this.tui.removeChild(this.loader);
    this.loader = null;
    this.tui.requestRender();
  }

  updateModel({ modelLabel, thinkingLabel, available } = {}) {
    if (modelLabel) this.modelLabel = `${modelLabel}`;
    if (thinkingLabel) this.thinkingLabel = `${thinkingLabel}`;
    if (available !== undefined) this.keyAvailable = Boolean(available);
    this.renderStatus();
  }

  updatePermissionMode(label = "Ask") {
    this.permissionLabel = `${label || "Ask"}`;
    this.renderStatus();
  }

  setUsageText(text = "") {
    this.usageText = `${text || ""}`;
    this.renderStatus();
  }

  renderStatus() {
    const workspace = this.workspacePath;
    const key = this.keyAvailable ? ansi.green("Key ✓") : ansi.yellow("Key —");
    const permission = this.permissionLabel === "All agree"
      ? ansi.yellow("All agree")
      : ansi.muted("Ask");
    const elapsed = this.busy && this.activeStream
      ? ` · ${formatElapsed(Date.now() - this.activeStream.startedAt)}`
      : "";
    const state = this.busy
      ? ansi.blueBright(`${this.activity || "正在运行"}${elapsed}`)
      : ansi.muted("Enter 发送 · Shift+Enter 换行 · / 菜单");
    const usage = this.usageText ? `  ${ansi.muted(this.usageText)}` : "";
    this.status.setText(
      `${ansi.muted(workspace)}  ${ansi.blueBright(this.modelLabel)}  ${ansi.muted(this.thinkingLabel)}  ${key}  ${permission}${usage}  ${state}`
    );
    this.tui.requestRender();
  }

  async choose({ title, description = "", items = [], selectedIndex = 0 } = {}) {
    if (!items.length) return null;
    return new Promise((resolve) => {
      const list = new this.kit.SelectList(items, Math.min(8, items.length), this.theme.selectList);
      list.setSelectedIndex(Math.max(0, selectedIndex));
      const box = new this.kit.Box(1, 1, (text) => ansi.panelBackground(text));
      box.addChild(new this.kit.Text(ansi.blueBright(ansi.bold(title || "请选择")), 0, 0));
      if (description) box.addChild(new this.kit.Text(ansi.muted(description), 0, 1));
      box.addChild(list);
      const dialog = interactiveContainer(box, list);
      let settled = false;
      let handle;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        this.modalCancels.delete(cancel);
        handle?.hide();
        this.tui.setFocus(this.editor);
        resolve(value);
      };
      const cancel = () => finish(null);
      this.modalCancels.add(cancel);
      list.onSelect = (item) => finish(item.value);
      list.onCancel = cancel;
      handle = this.tui.showOverlay(dialog, {
        width: "70%",
        minWidth: 38,
        maxHeight: "70%",
        anchor: "center",
        margin: 1
      });
      this.tui.requestRender();
    });
  }

  async promptSecret({ title, description = "" } = {}) {
    return new Promise((resolve) => {
      const secret = createSecretInput(this.kit, this.theme, (value) => finish(value), () => finish(null));
      const box = new this.kit.Box(1, 1, (text) => ansi.panelBackground(text));
      box.addChild(new this.kit.Text(ansi.blueBright(ansi.bold(title || "API Key")), 0, 0));
      if (description) box.addChild(new this.kit.Text(ansi.muted(description), 0, 1));
      box.addChild(secret);
      const dialog = interactiveContainer(box, secret, true);
      let settled = false;
      let handle;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        this.modalCancels.delete(cancel);
        handle?.hide();
        this.tui.setFocus(this.editor);
        resolve(value);
      };
      const cancel = () => finish(null);
      this.modalCancels.add(cancel);
      handle = this.tui.showOverlay(dialog, {
        width: "70%",
        minWidth: 44,
        maxHeight: 10,
        anchor: "center",
        margin: 1
      });
      this.tui.requestRender();
    });
  }
}

function formatSessionInfo(workspacePath, taskTitle) {
  return ansi.muted(`工作空间  ${workspacePath}\n会话      ${taskTitle}`);
}

function formatElapsed(durationMs) {
  const seconds = Math.max(0, Number(durationMs) || 0) / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

function interactiveContainer(box, input, focusable = false) {
  const component = {
    render(width) { return box.render(width); },
    handleInput(data) { input.handleInput(data); },
    invalidate() {
      box.invalidate();
      input.invalidate();
    }
  };
  if (focusable) {
    Object.defineProperty(component, "focused", {
      get() { return input.focused; },
      set(value) { input.focused = value; },
      enumerable: true
    });
  } else {
    component.focused = false;
  }
  return component;
}

function createSecretInput(kit, theme, onSubmit, onCancel) {
  let value = "";
  return {
    focused: false,
    invalidate() {},
    render(width) {
      const masked = "•".repeat(Math.min(value.length, Math.max(1, width - 4)));
      const cursor = this.focused ? kit.CURSOR_MARKER : "";
      const line = `  ${masked}${cursor}${ansi.blueBright("█")}`;
      return [kit.truncateToWidth(line, Math.max(1, width))];
    },
    handleInput(data) {
      if (kit.matchesKey(data, kit.Key.enter)) {
        onSubmit(value.trim());
        value = "";
        return;
      }
      if (kit.matchesKey(data, kit.Key.escape)) {
        value = "";
        onCancel();
        return;
      }
      if (kit.matchesKey(data, kit.Key.backspace) || kit.matchesKey(data, kit.Key.delete)) {
        value = value.slice(0, -1);
        return;
      }
      const printable = `${data || ""}`
        .replace(/\u001b\[200~/g, "")
        .replace(/\u001b\[201~/g, "");
      if (/^[\x20-\x7e]+$/.test(printable)) value += printable;
    }
  };
}

function messageContent(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((item) => item?.type === "text")
    .map((item) => `${item.text || ""}`)
    .join("\n")
    .trim();
}

module.exports = { COMMANDS, YaoguoTerminalUi, createTerminalUi, messageContent };
