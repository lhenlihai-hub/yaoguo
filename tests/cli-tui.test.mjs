import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createTerminalUi } = require("../src/cli/tui/terminalUi.js");

class FakeTerminal {
  constructor(columns = 92, rows = 32) {
    this.columns = columns;
    this.rows = rows;
    this.kittyProtocolActive = false;
    this.output = [];
    this.onInput = null;
    this.progress = false;
  }

  start(onInput) { this.onInput = onInput; }
  stop() { this.onInput = null; }
  async drainInput() {}
  write(data) { this.output.push(`${data}`); }
  moveBy() {}
  hideCursor() {}
  showCursor() {}
  clearLine() {}
  clearFromCursor() {}
  clearScreen() {}
  setTitle(title) { this.title = title; }
  setProgress(active) { this.progress = active; }
  send(data) { this.onInput?.(data); }
  text() { return this.output.join(""); }
}

function waitForRender() {
  return new Promise((resolve) => setTimeout(resolve, 40));
}

test("TUI 提供真实输入框、斜杠菜单、蓝色用户消息与流式回复", async () => {
  const terminal = new FakeTerminal();
  const submissions = [];
  const ui = await createTerminalUi({
    terminal,
    workspacePath: "/tmp/Yaoguo Workspace",
    modelLabel: "Pro",
    keyAvailable: true,
    version: "0.1.0"
  });
  ui.start({ onSubmit: (message) => submissions.push(message) });
  ui.addUserMessage("请继续完成项目");
  const stream = ui.beginAssistant();
  ui.appendAssistant(stream, "已经开始");
  ui.appendAssistant(stream, "处理。");
  ui.finishAssistant(stream);
  terminal.send("/");
  await waitForRender();

  const output = terminal.text();
  assert.match(output, /腰果/);
  assert.match(output, /请继续完成项目/);
  assert.match(output, /已经开始处理/);
  assert.match(output, /model/);
  assert.match(output, /\u001b\[48;2;20;82;138m/);

  terminal.send("\u001b");
  terminal.send("\u007f");
  for (const character of "hello") terminal.send(character);
  terminal.send("\r");
  await waitForRender();
  assert.deepEqual(submissions, ["hello"]);
  assert.equal(terminal.title, "腰果");
  await ui.dispose();
});

test("TUI 选择菜单可键盘操作，API Key 只渲染掩码", async () => {
  const terminal = new FakeTerminal();
  const ui = await createTerminalUi({ terminal, workspacePath: "/tmp/work" });
  ui.start();

  const selection = ui.choose({
    title: "模型设置",
    items: [
      { value: "pro", label: "Pro", description: "标准模型" },
      { value: "flash", label: "Flash", description: "快速模型" }
    ]
  });
  terminal.send("\u001b[B");
  terminal.send("\r");
  assert.equal(await selection, "flash");

  const secret = ui.promptSecret({
    title: "DeepSeek API Key",
    description: "输入已隐藏"
  });
  for (const character of "sk-test-secret") terminal.send(character);
  await waitForRender();
  assert.doesNotMatch(terminal.text(), /sk-test-secret/);
  assert.match(terminal.text(), /•••/);
  terminal.send("\r");
  assert.equal(await secret, "sk-test-secret");
  assert.doesNotMatch(terminal.text(), /sk-test-secret/);
  await ui.dispose();
});

test("TUI Ctrl+C 在运行时中止任务，在空闲时干净退出", async () => {
  const terminal = new FakeTerminal();
  let interrupts = 0;
  const ui = await createTerminalUi({ terminal, workspacePath: "/tmp/work" });
  ui.start({ onInterrupt: () => { interrupts += 1; } });
  ui.setBusy(true);
  terminal.send("\u0003");
  assert.equal(interrupts, 1);
  assert.equal(ui.stopped, false);
  ui.setBusy(false);
  terminal.send("\u0003");
  await ui.waitForExit();
  assert.equal(ui.stopped, true);
  assert.equal(terminal.onInput, null);
});
