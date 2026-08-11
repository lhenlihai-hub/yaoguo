import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const agentDeliveryActions = require("../src/application/workflows/mixins/agent/agentDeliveryActions.js");
const { GENERATE_VISUAL_TOOL } = require("../src/application/workflows/mixins/agent/generateVisualTool.js");

function toolCall(path, medium = "webpage", extra = {}) {
  return {
    function: {
      name: "generate_visual",
      arguments: JSON.stringify({ path, medium, ...extra })
    }
  };
}

function harness({ absolute = "", html = "", audit = null, pdf = null } = {}) {
  const engine = {
    paths: { workspace: absolute ? join(absolute, "..", "..") : "" },
    projectService: {
      previewTaskFile: async () => absolute ? { absolute, content: html } : null
    },
    artifactStore: null,
    pdfRenderer: null,
    settingsService: { get: async () => ({ visualExport: { pdf: false } }) },
    emitActivity: () => null,
    _inspectVisualQuality: async ({ html: source }) => audit || {
      issues: [],
      localization: { html: source, removed: 0 }
    },
    _renderVisualPdf: async () => pdf,
    _uniqueOutputPath: async (dir, base, ext) => join(dir, `${base}.${ext}`)
  };
  Object.assign(engine, agentDeliveryActions);
  engine._readTaskScopedTextFile = async () => absolute ? { absolute, content: html } : null;
  return engine;
}

test("generate_visual 只验收 Agent 已写入的 HTML，不接受内容来源或修改模式", () => {
  const parameters = GENERATE_VISUAL_TOOL.function.parameters;
  assert.deepEqual(parameters.required, ["medium", "path"]);
  assert.equal(parameters.properties.path.type, "string");
  assert.equal(parameters.properties.source, undefined);
  assert.equal(parameters.properties.instruction, undefined);
  assert.equal(parameters.properties.basedOnPrevious, undefined);
  assert.match(GENERATE_VISUAL_TOOL.function.description, /不会替你生成或重写内容/);
});

test("generate_visual 验收现有 HTML 后直接登记同一文件，不启动模型", async () => {
  const dir = await mkdtemp(join(tmpdir(), "yaoguo-visual-publish-"));
  try {
    const absolute = join(dir, "report.html");
    const html = "<!doctype html><html><head><style>main{display:grid}</style></head><body><main>报告</main></body></html>";
    await writeFile(absolute, html, "utf8");
    const engine = harness({ absolute, html });
    engine.aiRouter = { runTask: () => { throw new Error("不应启动第二个模型"); } };

    const result = await engine.runGenerateVisualFromToolCall({
      toolCall: toolCall("final/report.html"),
      message: "发布网页",
      projectId: "p1",
      taskId: "t1",
      options: { skipUserLog: true, skipAssistantLog: true }
    });

    assert.equal(result.blocked, undefined);
    assert.equal(result.artifact.absolute, absolute);
    assert.equal(result.artifact.format, "html");
    assert.equal(await readFile(absolute, "utf8"), html);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("generate_visual 在下载前按 HTML 中的真实 URL 请求宿主网络授权", async () => {
  const dir = await mkdtemp(join(tmpdir(), "yaoguo-visual-network-permission-"));
  try {
    const absolute = join(dir, "remote.html");
    const html = '<!doctype html><html><body><img src="https://8.8.8.8/a.png"></body></html>';
    await writeFile(absolute, html, "utf8");
    const requests = [];
    const engine = harness({ absolute, html });
    engine.toolPermissionService = {
      authorize: async (request) => {
        requests.push(request);
        return { allow: false, code: "TOOL_PERMISSION_DENIED", error: "denied" };
      }
    };
    let audited = false;
    engine._inspectVisualQuality = async () => {
      audited = true;
      return { issues: [], localization: { html } };
    };

    const result = await engine.runGenerateVisualFromToolCall({
      toolCall: toolCall("remote.html"),
      projectId: "p1",
      taskId: "t1",
      turnId: "turn-1"
    });

    assert.equal(result.blocked, true);
    assert.equal(audited, false, "网络拒绝后不能进入会下载图片的检查阶段");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].args.url, "https://8.8.8.8/a.png");
    assert.equal(requests[0].policy.effect, "network_read");
    assert.equal(requests[0].context.turnId, "turn-1");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("generate_visual 可以读取当前任务绑定的外部 Agent 工作空间", async () => {
  const taskDir = await mkdtemp(join(tmpdir(), "yaoguo-visual-task-"));
  const workspacePath = await mkdtemp(join(tmpdir(), "yaoguo-visual-workspace-"));
  try {
    const absolute = join(workspacePath, "report.html");
    const html = "<!doctype html><html><head><style>main{display:grid}</style></head><body><main>外部工作区报告</main></body></html>";
    await writeFile(absolute, html, "utf8");
    const engine = { projectService: {
      getTaskDir: () => taskDir,
      getTask: async () => ({ workspacePath })
    } };
    Object.assign(engine, agentDeliveryActions);

    const source = await engine._readTaskScopedTextFile({
      projectId: "p1",
      taskId: "t1",
      requestedPath: "report.html",
      allowedExtensions: [".html"]
    });

    assert.equal(source.absolute, await realpath(absolute));
    assert.equal(source.content, html);
  } finally {
    await rm(taskDir, { recursive: true, force: true });
    await rm(workspacePath, { recursive: true, force: true });
  }
});

test("generate_visual 检查失败时把可执行问题回填，不自动返修", async () => {
  const dir = await mkdtemp(join(tmpdir(), "yaoguo-visual-reject-"));
  try {
    const absolute = join(dir, "broken.html");
    const html = "<!doctype html><html><body><main>缺少样式</main></body></html>";
    await writeFile(absolute, html, "utf8");
    const engine = harness({
      absolute,
      html,
      audit: {
        issues: [{ code: "VISUAL_STYLE_MISSING", message: "HTML 没有内联 style。" }],
        localization: { html }
      }
    });

    const result = await engine.runGenerateVisualFromToolCall({
      toolCall: toolCall("final/broken.html"),
      projectId: "p1",
      taskId: "t1",
      options: { skipUserLog: true, skipAssistantLog: true }
    });

    assert.equal(result.blocked, true);
    assert.match(result.reply, /HTML 没有内联 style/);
    assert.equal(await readFile(absolute, "utf8"), html);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("generate_visual 拒绝工作区里不存在的 HTML 路径", async () => {
  const engine = harness();
  const result = await engine.runGenerateVisualFromToolCall({
    toolCall: toolCall("final/missing.html"),
    projectId: "p1",
    taskId: "t1",
    options: { skipUserLog: true, skipAssistantLog: true }
  });
  assert.equal(result.blocked, true);
  assert.match(result.reply, /先用 write\/edit/);
});

test("generate_visual 把取消信号作为发布边界", async () => {
  const controller = new AbortController();
  controller.abort(new Error("stop"));
  const engine = harness();
  await assert.rejects(
    () => engine.runGenerateVisualFromToolCall({
      toolCall: toolCall("final/page.html"),
      projectId: "p1",
      taskId: "t1",
      options: { signal: controller.signal }
    }),
    /stop/
  );
});
