import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const require = createRequire(import.meta.url);
const JSZip = require("jszip");
const { inspectArtifactTool } = require("../src/platform/ai/agentTools/artifactInspectionTool.js");
const { publishArtifactTool } = require("../src/platform/ai/agentTools/publishArtifactTool.js");

async function createContext(prefix = "yaoguo-artifact-lifecycle-") {
  const taskDir = await mkdtemp(join(tmpdir(), prefix));
  await mkdir(join(taskDir, ".candidates"), { recursive: true });
  return {
    taskDir,
    agentWorkDir: taskDir,
    artifactInspections: new Map(),
    artifactCandidates: new Map()
  };
}

async function writeMinimalPptx(file) {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", [
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
    "<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">",
    "<Override PartName=\"/ppt/presentation.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml\"/>",
    "</Types>"
  ].join(""));
  zip.file("ppt/presentation.xml", [
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
    "<p:presentation xmlns:p=\"http://schemas.openxmlformats.org/presentationml/2006/main\"/>"
  ].join(""));
  zip.file("ppt/slides/slide1.xml", [
    "<p:sld xmlns:p=\"http://schemas.openxmlformats.org/presentationml/2006/main\" ",
    "xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\">",
    "<a:t>腰果 Agent 架构</a:t><a:t>候选、检查、发布</a:t></p:sld>"
  ].join(""));
  zip.file("ppt/slides/slide2.xml", [
    "<p:sld xmlns:p=\"http://schemas.openxmlformats.org/presentationml/2006/main\" ",
    "xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\">",
    "<a:t>验收闭环</a:t><a:t>同一个 Agent 根据真实内容决策</a:t></p:sld>"
  ].join(""));
  await writeFile(file, await zip.generateAsync({ type: "nodebuffer" }));
}

test("inspect_artifact 读取真实 PPTX 页数与文字，发布绑定同一快照", async () => {
  const ctx = await createContext();
  try {
    const candidate = join(ctx.taskDir, ".candidates", "agent-architecture.pptx");
    await writeMinimalPptx(candidate);

    const inspection = await inspectArtifactTool.execute({ path: candidate }, ctx);

    assert.equal(inspection.valid, true);
    assert.equal(inspection.pages, 2);
    assert.match(inspection.textPreview, /腰果 Agent 架构/);
    assert.match(inspection.textPreview, /验收闭环/);

    const published = await publishArtifactTool.execute({
      path: candidate,
      inspectionId: inspection.inspectionId,
      title: "Agent 架构方案"
    }, ctx);

    assert.equal(published.published, true);
    assert.match(published.absolute, /\/final\/agent-architecture\.pptx$/);
    assert.equal(await readFile(published.absolute).then((buffer) => buffer.length > 0), true);
    await assert.rejects(() => access(candidate));
    assert.equal(ctx.artifactCandidates.get(published.absolute)?.status, "published");
    assert.deepEqual(
      (await readdir(join(ctx.taskDir, "final"))).filter((name) => (
        name.startsWith(".publish-")
        || name.startsWith(".manifest-")
        || name.startsWith(".yaoguo-publish-txn-")
      )),
      []
    );
  } finally {
    await rm(ctx.taskDir, { recursive: true, force: true });
  }
});

test("publish_artifact 保留受管快照并把成品交付到用户明确指定的目录", async () => {
  const ctx = await createContext("yaoguo-artifact-explicit-output-");
  const outputDir = await mkdtemp(join(tmpdir(), "yaoguo-artifact-user-output-"));
  try {
    await mkdir(join(ctx.taskDir, "final"), { recursive: true });
    await writeFile(join(ctx.taskDir, "final", "report.md"), "# 旧的受管成品\n", "utf8");
    const candidate = join(ctx.taskDir, ".candidates", "report.md");
    await writeFile(candidate, "# 新报告\n已按用户要求生成。", "utf8");
    const inspection = await inspectArtifactTool.execute({ path: candidate }, ctx);
    ctx.explicitOutputTargets = [{ path: outputDir, kind: "directory" }];

    const published = await publishArtifactTool.execute({
      path: candidate,
      inspectionId: inspection.inspectionId,
      title: "新报告"
    }, ctx);

    assert.equal(published.absolute, await realpath(join(outputDir, "report.md")));
    assert.equal(published.managedAbsolute, await realpath(join(ctx.taskDir, "final", "report-v2.md")));
    assert.match(await readFile(published.absolute, "utf8"), /新报告/);
    assert.match(await readFile(published.managedAbsolute, "utf8"), /新报告/);
    await assert.rejects(() => access(candidate));
  } finally {
    await rm(ctx.taskDir, { recursive: true, force: true });
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("受管文档任务默认只把一个主成品交付到绑定工作空间", async () => {
  const ctx = await createContext("yaoguo-artifact-primary-only-");
  const outputDir = await mkdtemp(join(tmpdir(), "yaoguo-artifact-bound-workspace-"));
  try {
    ctx.defaultArtifactDestination = outputDir;
    ctx.artifactPublishLimit = 1;
    ctx.publishedArtifactsThisTurn = new Map();
    const primary = join(ctx.taskDir, ".candidates", "course.pptx");
    await writeMinimalPptx(primary);
    const primaryInspection = await inspectArtifactTool.execute({ path: primary }, ctx);
    const published = await publishArtifactTool.execute({
      path: primary,
      inspectionId: primaryInspection.inspectionId,
      title: "公开课课件"
    }, ctx);

    assert.equal(published.absolute, await realpath(join(outputDir, "course.pptx")));
    assert.match(published.managedAbsolute, /\/final\/course\.pptx$/);
    await assert.rejects(() => access(primary));

    const helper = join(ctx.taskDir, ".candidates", "gen_pptx.js");
    await writeFile(helper, "console.log('helper')", "utf8");
    const helperInspection = await inspectArtifactTool.execute({ path: helper }, ctx);
    await assert.rejects(
      () => publishArtifactTool.execute({
        path: helper,
        inspectionId: helperInspection.inspectionId,
        title: "生成脚本"
      }, ctx),
      /最多发布 1 个成品/
    );
    assert.equal((await readdir(outputDir)).length, 1);
  } finally {
    await rm(ctx.taskDir, { recursive: true, force: true });
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("publish_artifact 即使有显式路径也不写入宿主控制目录或腰果运行数据", async () => {
  const ctx = await createContext("yaoguo-artifact-protected-output-");
  const workspace = await mkdtemp(join(tmpdir(), "yaoguo-artifact-protected-workspace-"));
  try {
    const gitDir = join(workspace, ".git");
    await mkdir(gitDir);
    const candidate = join(ctx.taskDir, ".candidates", "report.md");
    await writeFile(candidate, "# 安全报告\n", "utf8");
    const inspection = await inspectArtifactTool.execute({ path: candidate }, ctx);
    ctx.explicitOutputTargets = [{ path: gitDir, kind: "directory" }];
    await assert.rejects(
      () => publishArtifactTool.execute({
        path: candidate,
        inspectionId: inspection.inspectionId
      }, ctx),
      /宿主控制目录/
    );
    assert.equal(await readFile(candidate, "utf8"), "# 安全报告\n");

    ctx.explicitOutputTargets = [{ path: workspace, kind: "directory" }];
    ctx.explicitOutputDenyRoots = [workspace];
    await assert.rejects(
      () => publishArtifactTool.execute({
        path: candidate,
        inspectionId: inspection.inspectionId
      }, ctx),
      /腰果运行数据/
    );
    assert.deepEqual((await readdir(workspace)).sort(), [".git"]);
  } finally {
    await rm(ctx.taskDir, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test("文件在检查后变化时旧 inspectionId 不能发布", async () => {
  const ctx = await createContext("yaoguo-artifact-stale-");
  try {
    const candidate = join(ctx.taskDir, ".candidates", "report.md");
    await writeFile(candidate, "# 初稿\n真实内容", "utf8");
    const inspection = await inspectArtifactTool.execute({ path: candidate }, ctx);
    await writeFile(candidate, "# 已修改\n尚未重新检查", "utf8");

    await assert.rejects(
      () => publishArtifactTool.execute({
        path: candidate,
        inspectionId: inspection.inspectionId
      }, ctx),
      /检查后发生变化/
    );
  } finally {
    await rm(ctx.taskDir, { recursive: true, force: true });
  }
});

test("真实文件包含内部工具协议时检查失败且不能发布", async () => {
  const ctx = await createContext("yaoguo-artifact-protocol-");
  try {
    const candidate = join(ctx.taskDir, ".candidates", "leaked.txt");
    await writeFile(candidate, "正文\n<｜｜DSML｜｜tool_calls>\n内部调用", "utf8");

    const inspection = await inspectArtifactTool.execute({ path: candidate }, ctx);

    assert.equal(inspection.valid, false);
    assert.match(inspection.issues.join("\n"), /内部工具协议/);
    await assert.rejects(
      () => publishArtifactTool.execute({
        path: candidate,
        inspectionId: inspection.inspectionId
      }, ctx),
      /真实检查未通过/
    );
  } finally {
    await rm(ctx.taskDir, { recursive: true, force: true });
  }
});

test("任务内部文件不因位于 taskDir 就自动获得发布资格", async () => {
  const ctx = await createContext("yaoguo-artifact-internal-");
  try {
    ctx.agentWorkDir = join(ctx.taskDir, ".candidates");
    const internal = join(ctx.taskDir, "run.json");
    await writeFile(internal, "{\"internal\":true}", "utf8");

    await assert.rejects(
      () => inspectArtifactTool.execute({ path: internal }, ctx),
      /工作空间内的文件或生成工具登记的候选/
    );
  } finally {
    await rm(ctx.taskDir, { recursive: true, force: true });
  }
});

test("publish_artifact 拒绝经 final 符号链接写入任务外部", async () => {
  const ctx = await createContext("yaoguo-artifact-final-symlink-");
  const externalDir = await mkdtemp(join(tmpdir(), "yaoguo-artifact-final-outside-"));
  try {
    const candidate = join(ctx.taskDir, ".candidates", "report.md");
    await writeFile(candidate, "# 经检查的报告\n不应写入外部目录。", "utf8");
    const inspection = await inspectArtifactTool.execute({ path: candidate }, ctx);
    await symlink(externalDir, join(ctx.taskDir, "final"));

    await assert.rejects(
      () => publishArtifactTool.execute({
        path: candidate,
        inspectionId: inspection.inspectionId
      }, ctx),
      /成品目录经符号链接越出当前任务/
    );

    assert.deepEqual(await readdir(externalDir), []);
    assert.match(await readFile(candidate, "utf8"), /经检查的报告/);
  } finally {
    await rm(ctx.taskDir, { recursive: true, force: true });
    await rm(externalDir, { recursive: true, force: true });
  }
});

test("inspect_artifact 与 publish_artifact 拒绝经候选文件符号链接读取任务外部", async () => {
  const ctx = await createContext("yaoguo-artifact-candidate-symlink-");
  const externalDir = await mkdtemp(join(tmpdir(), "yaoguo-artifact-candidate-outside-"));
  try {
    const externalFile = join(externalDir, "outside.md");
    const candidateLink = join(ctx.taskDir, ".candidates", "escaped.md");
    await writeFile(externalFile, "# 外部文件\n不在 Agent 工作空间。", "utf8");
    await symlink(externalFile, candidateLink);

    await assert.rejects(
      () => inspectArtifactTool.execute({ path: candidateLink }, ctx),
      /只能检查当前 Agent 工作空间内的文件或生成工具登记的候选/
    );
    await assert.rejects(
      () => publishArtifactTool.execute({
        path: candidateLink,
        inspectionId: "inspection-forged"
      }, ctx),
      /只能检查当前 Agent 工作空间内的文件或生成工具登记的候选/
    );

    assert.equal(ctx.artifactInspections.size, 0);
    assert.match(await readFile(externalFile, "utf8"), /外部文件/);
  } finally {
    await rm(ctx.taskDir, { recursive: true, force: true });
    await rm(externalDir, { recursive: true, force: true });
  }
});

test("未知二进制格式检查失败，真实图片返回尺寸", async () => {
  const ctx = await createContext("yaoguo-artifact-formats-");
  try {
    const unknown = join(ctx.taskDir, "opaque.bin");
    await writeFile(unknown, Buffer.from([1, 2, 3, 4]));
    const unknownInspection = await inspectArtifactTool.execute({ path: unknown }, ctx);
    assert.equal(unknownInspection.valid, false);
    assert.match(unknownInspection.issues.join("\n"), /没有可用的结构或内容检查器/);

    const png = join(ctx.taskDir, "pixel.png");
    await writeFile(png, Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64"
    ));
    const imageInspection = await inspectArtifactTool.execute({ path: png }, ctx);
    assert.equal(imageInspection.valid, true);
    assert.equal(imageInspection.width, 1);
    assert.equal(imageInspection.height, 1);
  } finally {
    await rm(ctx.taskDir, { recursive: true, force: true });
  }
});
