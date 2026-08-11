"use strict";

const path = require("node:path");
const { ansi, createTuiTheme, formatHeader } = require("./theme");

const COMMANDS = Object.freeze([
  { name: "model", description: "选择 Pro / Flash 或设置 API Key" },
  { name: "usage", description: "查看当前会话 token 与缓存命中" },
  { name: "tokens", description: "/usage 的别名" },
  { name: "clear", description: "清空当前屏幕，不删除会话" },
  { name: "help", description: "查看终端菜单与快捷键" },
  { name: "exit", description: "退出腰果" }
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
    this.modelLabel = `${options.modelLabel || "Pro"}`;
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
    this.exitPromise = new Promise((resolve) => { this.resolveExit = resolve; });
    this.buildLayout();
  }

  buildLayout() {
    const { CombinedAutocompleteProvider, Editor, Spacer, Text } = this.kit;
    this.header = new Text(formatHeader(this.version), 1, 0);
    this.sessionInfo = new Text(
      ansi.muted(`工作空间  ${this.workspacePath}`),
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
    const markdown = new Markdown("", 1, 0, this.theme.markdown);
    component.addChild(new Text(ansi.blue(ansi.bold("腰果")), 1, 0));
    component.addChild(markdown);
    this.insertMessage(component);
    return { component, markdown, text: "", streamed: false };
  }

  appendAssistant(stream, delta) {
    if (!stream || !delta) return;
    stream.streamed = true;
    stream.text += `${delta}`;
    stream.markdown.setText(stream.text);
    this.removeLoader();
    this.tui.requestRender();
  }

  finishAssistant(stream, fallback = "") {
    if (!stream) return;
    const finalText = stream.text || `${fallback || ""}`;
    stream.markdown.setText(finalText || "未生成可显示回复。");
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
    this.tui.requestRender(true);
  }

  setBusy(value, label = "正在思考…") {
    this.busy = Boolean(value);
    this.editor.disableSubmit = this.busy;
    this.terminal.setProgress?.(this.busy);
    if (this.busy) {
      this.activity = label;
      this.ensureLoader(label);
    } else {
      this.activity = "";
      this.removeLoader();
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

  updateModel({ modelLabel, available } = {}) {
    if (modelLabel) this.modelLabel = `${modelLabel}`;
    if (available !== undefined) this.keyAvailable = Boolean(available);
    this.renderStatus();
  }

  setUsageText(text = "") {
    this.usageText = `${text || ""}`;
    this.renderStatus();
  }

  renderStatus() {
    const workspace = path.basename(this.workspacePath) || this.workspacePath;
    const key = this.keyAvailable ? ansi.green("Key ✓") : ansi.yellow("Key —");
    const state = this.busy
      ? ansi.blueBright(this.activity || "正在运行")
      : ansi.muted("Enter 发送 · Shift+Enter 换行 · / 菜单");
    const usage = this.usageText ? `  ${ansi.muted(this.usageText)}` : "";
    this.status.setText(
      `${ansi.muted(workspace)}  ${ansi.blueBright(this.modelLabel)}  ${key}${usage}  ${state}`
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
