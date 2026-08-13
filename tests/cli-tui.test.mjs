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

test("TUI 提供欢迎页、真实输入框、整合菜单与无底色蓝色用户消息", async () => {
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
  assert.match(output, /欢迎使用腰果/);
  assert.doesNotMatch(output, /基于 Pi/);
  assert.doesNotMatch(output, /DeepSeek only/);
  assert.doesNotMatch(output, /打开命令菜单/);
  assert.match(output, /请继续完成项目/);
  assert.match(output, /已经开始处理/);
  assert.match(output, /model/);
  assert.match(output, /resume/);
  assert.match(output, /permissions/);
  assert.doesNotMatch(output, /\u001b\[48;2;20;82;138m/);
  assert.match(output, /\u001b\[38;2;121;187;255m/);

  terminal.send("\u001b");
  terminal.send("\u007f");
  for (const character of "hello") terminal.send(character);
  terminal.send("\r");
  await waitForRender();
  assert.deepEqual(submissions, ["hello"]);
  assert.equal(terminal.title, "腰果");
  await ui.dispose();
});

test("TUI 展示真实推理耗时、工作流程与完整路径", async () => {
  const terminal = new FakeTerminal();
  const ui = await createTerminalUi({
    terminal,
    workspacePath: "/tmp/Yaoguo Workspace",
    taskTitle: "课件任务",
    thinkingLabel: "High",
    permissionLabel: "All agree"
  });
  ui.start();
  const stream = ui.beginAssistant();
  ui.recordActivity({
    phase: "search-reference",
    status: "running",
    label: "正在搜索参考材料",
    target: "/tmp/Yaoguo Workspace/references"
  });
  ui.appendReasoning(stream, "先核对用户指定的交付路径。");
  ui.appendReasoning(stream, "", { phase: "complete", durationMs: 1250 });
  ui.recordActivity({
    phase: "search-reference",
    status: "completed",
    label: "参考材料搜索完成",
    target: "/tmp/Yaoguo Workspace/references"
  });
  ui.appendAssistant(stream, "已完成。");
  ui.finishAssistant(stream);
  await waitForRender();

  const output = terminal.text();
  assert.match(output, /参考材料搜索完成/);
  assert.match(output, /\/tmp\/Yaoguo Workspace\/references/);
  assert.match(output, /思考过程 · 1\.3s/);
  assert.match(output, /先核对用户指定的交付路径/);
  assert.match(output, /最终结果/);
  assert.match(output, /\u001b\[38;2;139;153;173m/);
  assert.match(output, /\u001b\[3m/);
  assert.match(output, /All agree/);
  assert.match(output, /就绪/);
  const footer = ui.status.render(92).join("\n");
  assert.match(footer, /All agree.*Pro.*High/);
  assert.match(footer, /\/菜单/);
  assert.doesNotMatch(footer, /\/tmp\/Yaoguo Workspace|Key|Enter|Shift\+Enter/);
  await ui.dispose();
});

test("TUI 长推理过程不用高频动画或计时触发整屏重绘", async () => {
  const terminal = new FakeTerminal(72, 8);
  const ui = await createTerminalUi({ terminal, workspacePath: "/tmp/work" });
  ui.start();
  ui.setBusy(true, "正在思考…");
  const stream = ui.beginAssistant();
  ui.appendReasoning(stream, Array.from({ length: 24 }, (_, index) => `思考 ${index + 1}`).join("\n"));
  await waitForRender();

  const redrawsAfterContent = ui.tui.fullRedraws;
  await new Promise((resolve) => setTimeout(resolve, 1100));

  assert.equal(ui.loader, undefined, "任务状态行不应再创建独立加载器");
  assert.equal(ui.tui.fullRedraws, redrawsAfterContent, "底部秒级状态刷新不应重画屏幕上方的长内容");

  ui.appendReasoning(stream, "", { phase: "complete", durationMs: 1250 });
  ui.finishAssistant(stream, "已完成。");
  await waitForRender();
  assert.match(terminal.text(), /思考过程 · 1\.3s/);
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
