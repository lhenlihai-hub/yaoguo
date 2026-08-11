import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { WorkflowEngine } = require("../src/application/workflows/workflowEngine.js");

async function makeHarness() {
  const workspace = await mkdtemp(join(tmpdir(), "yaoguo-explicit-artifact-"));
  const writes = [];
  const taskUpdates = [];
  const engine = Object.create(WorkflowEngine.prototype);
  engine.paths = { workspace };
  engine.projectService = {
    updateTask: async (projectId, taskId, patch) => {
      taskUpdates.push({ projectId, taskId, patch });
      return patch;
    }
  };
  engine.writeRun = async (state) => {
    writes.push(structuredClone(state));
  };
  return { engine, workspace, writes, taskUpdates };
}

function makeState(workspace, files, patch = {}) {
  return {
    id: "run-1",
    projectId: "project-1",
    taskId: "task-1",
    taskTitle: "交付件",
    createdAt: "2026-07-31T00:00:00.000Z",
    completedAt: "2026-07-31T00:00:05.000Z",
    steps: [{ id: "agent", files }],
    ...patch
  };
}

test("引擎不再包含 final-package 第二条产物链", () => {
  const engine = Object.create(WorkflowEngine.prototype);
  assert.equal(engine.canUseLocalFinalPackage, undefined);
  assert.equal(engine.buildLocalFinalPackage, undefined);
  assert.equal(engine.resolveFinalSourceStep, undefined);
});

test("普通 Agent 回复和 finalPreview 不会被自动保存为成品", async () => {
  const { engine, workspace, writes, taskUpdates } = await makeHarness();
  const reply = join(workspace, "reply.md");
  await writeFile(reply, "这只是给用户的回复。", "utf8");
  const state = makeState(workspace, [reply], {
    finalPreview: { content: "这也不是发布产物。" }
  });

  assert.equal(await engine.ensureRunArtifact(state), null);
  assert.equal(state.finalArtifact, undefined);
  assert.equal(writes.length, 0);
  assert.equal(taskUpdates.length, 0);
});

test("ensureRunArtifact 只接受 publish_artifact 显式发布的文件", async () => {
  const { engine, workspace, writes, taskUpdates } = await makeHarness();
  const reply = join(workspace, "reply.md");
  const published = join(workspace, "report.md");
  const content = "文章中的内容数据都是真实的吗？\n这是用户明确要求发布的原文。";
  await writeFile(reply, "这是步骤回复。", "utf8");
  await writeFile(published, content, "utf8");
  const state = makeState(workspace, [reply, {
    title: "真实性说明",
    absolute: published,
    relative: "report.md",
    source: "agent-publish",
    storage: "workspace",
    managed: false
  }]);

  const artifact = await engine.ensureRunArtifact(state);

  assert.equal(artifact.absolute, published);
  assert.equal(artifact.content, content);
  assert.equal(artifact.source, "agent-publish");
  assert.equal(state.finalArtifact.absolute, published);
  assert.equal(state.finalArtifact.source, "agent-publish");
  assert.equal(writes.length, 1);
  assert.deepEqual(taskUpdates, [{
    projectId: "project-1",
    taskId: "task-1",
    patch: { status: "active", lastArtifact: published }
  }]);
});

test("显式发布的二进制文件也是成品，不依赖文本内容", async () => {
  const { engine, workspace } = await makeHarness();
  const published = join(workspace, "deck.pdf");
  await writeFile(published, Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff]));
  const state = makeState(workspace, [{
    absolute: published,
    source: "agent-publish"
  }]);

  const artifact = await engine.ensureRunArtifact(state);

  assert.equal(artifact.absolute, published);
  assert.equal(artifact.content, "");
  assert.equal(artifact.size, 6);
});

test("二进制成品已发布时，getRun 不回退到助手回复冒充成品预览", async () => {
  const { engine, workspace } = await makeHarness();
  const outputDir = join(workspace, "outputs");
  const reply = join(outputDir, "reply.md");
  const published = join(workspace, "deck.pdf");
  await mkdir(outputDir, { recursive: true });
  await writeFile(reply, "已经完成，请查收文件。", "utf8");
  await writeFile(published, Buffer.from([0x25, 0x50, 0x44, 0x46]));
  const state = makeState(workspace, [{ absolute: published, source: "agent-publish" }], {
    runDir: workspace
  });
  engine.readRun = async () => state;

  const result = await engine.getRun(state.id);

  assert.equal(result.finalPreview, null);
  assert.equal(result.outputs[0].absolute, reply);
});

test("旧 workflow-persistence 记录和回复预览不能冒充显式产物", async () => {
  const { engine, workspace, writes, taskUpdates } = await makeHarness();
  const legacy = join(workspace, "legacy.md");
  await writeFile(legacy, "旧版自动落盘内容", "utf8");
  const state = makeState(workspace, [], {
    finalArtifact: {
      absolute: legacy,
      source: "workflow-persistence"
    },
    finalPreview: { absolute: legacy, content: "旧版预览" }
  });

  assert.equal(await engine.ensureRunArtifact(state), null);
  assert.equal(writes.length, 0);
  assert.equal(taskUpdates.length, 0);
});

test("后续普通回复不会覆盖本运行已显式发布的产物", async () => {
  const { engine, workspace } = await makeHarness();
  const published = join(workspace, "published.html");
  const laterReply = join(workspace, "later-reply.md");
  await writeFile(published, "<main>已发布成品</main>", "utf8");
  await writeFile(laterReply, "之后的说明性回复", "utf8");
  const state = makeState(workspace, [{
    absolute: published,
    source: "agent-publish"
  }], {
    steps: [
      { id: "publish", files: [{ absolute: published, source: "agent-publish" }] },
      { id: "reply", files: [laterReply] }
    ]
  });

  const artifact = await engine.ensureRunArtifact(state);

  assert.equal(artifact.absolute, published);
  assert.equal(state.finalArtifact.absolute, published);
});

test("内容预览不再使用对话关键词黑名单", async () => {
  const { engine, workspace } = await makeHarness();
  const output = join(workspace, "reply.md");
  await writeFile(output, "文章中的内容数据都是真实的吗？", "utf8");

  const preview = await engine.buildFinalPreview([{
    file: "reply.md",
    absolute: output,
    updatedAt: "2026-07-31T00:00:00.000Z",
    previewRole: "output"
  }]);

  assert.match(preview.content, /内容数据都是真实的吗/);
});
