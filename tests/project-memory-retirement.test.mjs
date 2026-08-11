import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createPaths } = require("../src/platform/storage/workspaceRuntime.js");
const { ProjectService } = require("../src/platform/projects/projectService.js");
const { TYPE_BASIS } = require("../src/platform/memory/memoryStore.js");
const { normalizeProjectType } = require("../src/platform/shared/legacyProjectMigration.js");

function createService() {
  const paths = createPaths(mkdtempSync(join(tmpdir(), "yaoguo-project-memory-retired-")));
  return { paths, service: new ProjectService(paths, { get: async () => ({}) }) };
}

test("新项目与任务不再创建旧 memory 目录", async () => {
  const { paths, service } = createService();
  await service.ensure();
  const project = await service.createProject({ name: "精简验证", type: "legacy-type" });
  const task = await service.createTask(project.id, { title: "新任务" });

  assert.equal(normalizeProjectType("legacy-type"), "general");
  assert.equal(existsSync(join(service.getProjectDir(project.id), "memory")), false);
  assert.equal(existsSync(join(service.getTaskDir(project.id, task.id), "memory")), false);
  assert.equal("memoryDir" in paths, false);
  assert.equal("ragDir" in paths, false);
});

test("启动与空项目复用都不会删除或占用带遗留 memory 目录的数据", async () => {
  const projectMemory = createService();
  const taskMemory = createService();
  try {
    const generalDir = projectMemory.service.getProjectDir("general-agent");
    const legacyFile = join(generalDir, "memory", "10-长期上下文.md");
    await mkdir(join(generalDir, "memory"), { recursive: true });
    await writeFile(join(generalDir, "project.json"), `${JSON.stringify({
      id: "general-agent",
      name: "通用 Agent",
      type: "general"
    })}\n`, "utf8");
    await writeFile(legacyFile, "# 长期上下文\n\n用户手写的旧版内容。\n", "utf8");

    await projectMemory.service.ensure();
    assert.notEqual((await projectMemory.service.getProject("general-agent")).name, "通用 Agent");
    assert.match(await readFile(legacyFile, "utf8"), /用户手写的旧版内容/);

    const projectDir = taskMemory.service.getProjectDir("legacy-blank");
    const taskDir = taskMemory.service.getTaskDir("legacy-blank", "task-blank");
    const taskLegacyFile = join(taskDir, "memory", "50-项目要求.md");
    await mkdir(join(taskDir, "memory"), { recursive: true });
    await writeFile(join(projectDir, "project.json"), `${JSON.stringify({
      id: "legacy-blank",
      name: "新项目",
      type: "general",
      createdAt: "2026-08-01T00:00:00.000Z"
    })}\n`, "utf8");
    await writeFile(join(taskDir, "task.json"), `${JSON.stringify({
      id: "task-blank",
      projectId: "legacy-blank",
      title: "新任务",
      createdAt: "2026-08-01T00:00:00.000Z"
    })}\n`, "utf8");
    await writeFile(taskLegacyFile, "# 项目要求\n\n旧任务的人工要求。\n", "utf8");

    await taskMemory.service.ensure();
    const created = await taskMemory.service.createProject({ name: "新请求", reuseBlank: true });
    assert.notEqual(created.id, "legacy-blank");
    assert.match(await readFile(taskLegacyFile, "utf8"), /旧任务的人工要求/);
  } finally {
    await Promise.all([
      rm(projectMemory.paths.projectRoot, { recursive: true, force: true }),
      rm(taskMemory.paths.projectRoot, { recursive: true, force: true })
    ]);
  }
});

test("只有通过四类型协议显式写入后 Memdir 才出现主题", async () => {
  const { service } = createService();
  await service.ensure();
  const project = await service.createProject({ name: "Memdir 显式写入" });
  const projectDir = service.getProjectDir(project.id);
  const scoped = await service.memoryStore.forContext({ workspaceRoot: projectDir });

  await scoped.append({
    type: "feedback",
    basis: TYPE_BASIS.feedback,
    topic: "concise-confirmation",
    name: "简洁度正向反馈",
    description: "用户确认当前回答密度合适，应继续复用。",
    content: "用户明确确认：当前回答密度合适，应继续复用。",
    valueBeyondCode: "这是用户对 AI 行为的正向评价，无法从代码推导。",
    polarity: "positive"
  });

  assert.deepEqual((await scoped.list()).map((item) => item.file), ["feedback-concise-confirmation.md"]);
  assert.match(await readFile(join((await scoped.info()).memoryDirectory, "feedback-concise-confirmation.md"), "utf8"), /当前回答密度合适/);
});
