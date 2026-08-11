import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, existsSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const { RegistryService } = require(join(root, "src/platform/registries/registryService.js"));
const { SkillsRegistry } = require(join(root, "src/platform/skills/skillsRegistry.js"));
const { SkillRunner } = require(join(root, "src/platform/skills/skillRunner.js"));
const { DependencyResolver } = require(join(root, "src/platform/skills/dependencyResolver.js"));
const { SkillsService } = require(join(root, "src/platform/skills/skillsService.js"));

function makeService() {
  const registryService = new RegistryService({ workspace: join(root, "workspace") });
  const skillsRegistry = new SkillsRegistry({ registryService });
  const skillRunner = new SkillRunner();
  const dependencyResolver = new DependencyResolver({ projectRoot: root });
  return new SkillsService({ skillsRegistry, skillRunner, dependencyResolver });
}

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "yaoguo-docx-skill-"));
  return Promise.resolve(fn(dir)).finally(() => {
    rmSync(dir, { recursive: true, force: true });
  });
}

test("skill registry 能识别 skill://docx@1，且只宣称真实实现的 actions", async () => {
  const service = makeService();
  const skills = await service.list();
  const docx = skills.find((s) => s.id === "skill://docx@1");
  assert.ok(docx, "应该列出 docx skill");
  assert.equal(docx.format, "docx");
  // P1.2：v1 只支持这四个；edit 已从 manifest 拿掉直到 edit.py 真做出。
  for (const required of ["create", "read", "validate", "preview"]) {
    assert.ok(docx.actions.includes(required), `actions 必须含 ${required}`);
  }
  assert.ok(!docx.actions.includes("edit"), "actions 不能包含 edit（实现还没做就不能宣称）");
});

test("dependencyResolver 报告 npm 依赖均已安装", async () => {
  const service = makeService();
  const { ok, results } = await service.dependencies("skill://docx@1");
  assert.equal(ok, true);
  const npmDeps = results.filter((r) => r.dep.kind === "npm");
  for (const r of npmDeps) {
    assert.equal(r.installed, true, `npm 依赖 ${r.dep.id} 应该已安装`);
  }
});

test("create + validate + read 端到端跑通", async () => {
  const service = makeService();
  await withTempDir(async (dir) => {
    const outputPath = join(dir, "output.docx");
    const markdown = [
      "# 端到端测试标题",
      "",
      "这是一段带 **粗体** 和 *斜体* 的段落。",
      "",
      "## 列表",
      "- 第一项",
      "- 第二项",
      "",
      "## 表格",
      "| A | B |",
      "|---|---|",
      "| 一 | 二 |",
      ""
    ].join("\n");

    const create = await service.invoke("skill://docx@1", "create", {
      source: { markdown },
      outputPath,
      options: { title: "E2E Test" }
    }, { workDir: dir, scopeAllow: [dir] });

    assert.equal(create.ok, true, `create 应该成功：${JSON.stringify(create.error || {})}`);
    assert.ok(existsSync(outputPath), "outputPath 应该存在");
    assert.ok(statSync(outputPath).size > 1000, "生成的文件大小应该 > 1KB");

    const validate = await service.invoke("skill://docx@1", "validate", { inputPath: outputPath }, {
      readScopeAllow: [outputPath]
    });
    assert.equal(validate.ok, true, `validate 应该通过：${JSON.stringify(validate.errors || [])}`);
    assert.deepEqual(validate.errors, []);

    const read = await service.invoke("skill://docx@1", "read", { inputPath: outputPath }, {
      readScopeAllow: [outputPath]
    });
    assert.equal(read.ok, true, "read 应该成功");
    assert.equal(read.usedBackend, "mammoth");
    assert.match(read.markdown, /端到端测试标题/);
    const headings = read.structure.headings || [];
    assert.ok(headings.some((h) => h.level === 1 && h.text.includes("端到端测试标题")));
  });
});

test("docx validate：正文中的内部工具协议被统一校验出口拒绝", async () => {
  const service = makeService();
  await withTempDir(async (dir) => {
    const outputPath = join(dir, "leaked.docx");
    const leaked = "# <｜｜DSML｜｜tool_calls>\n\n<｜｜DSML｜｜invoke name=\"fetch_url\">";
    const created = await service.invoke("skill://docx@1", "create", {
      source: { markdown: leaked }, outputPath
    }, { workDir: dir, scopeAllow: [dir] });
    assert.equal(created.ok, true);
    const validated = await service.invoke("skill://docx@1", "validate", { inputPath: outputPath }, {
      readScopeAllow: [outputPath]
    });
    assert.equal(validated.ok, false);
    assert.ok(validated.errors?.some((item) => item.code === "INTERNAL_PROTOCOL_LEAK"));
  });
});

test("scope 违规：outputPath 不在 scopeAllow 内时拒绝", async () => {
  const service = makeService();
  await withTempDir(async (allowDir) => {
    const result = await service.invoke("skill://docx@1", "create", {
      source: { markdown: "# x" },
      outputPath: join(tmpdir(), "yaoguo-out-of-scope.docx"),
      options: {}
    }, { workDir: allowDir, scopeAllow: [allowDir] });

    assert.equal(result.ok, false, "应该被拒绝");
    assert.equal(result.error?.code, "SCOPE_VIOLATION");
  });
});

test("未知 skill 返回 SKILL_NOT_FOUND", async () => {
  const service = makeService();
  const result = await service.invoke("skill://no-such@9", "create", {}, {});
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "SKILL_NOT_FOUND");
});

test("未知 action 返回 ACTION_NOT_FOUND", async () => {
  const service = makeService();
  const result = await service.invoke("skill://docx@1", "no-such-action", {}, {});
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "ACTION_NOT_FOUND");
});

test("preview action 注册并响应", async () => {
  const service = makeService();
  const skills = await service.list();
  const docx = skills.find((s) => s.id === "skill://docx@1");
  assert.ok(docx.actions.includes("preview"), "actions 必须含 preview");
});

test("preview action 两档：装 LibreOffice→pdfPath；没装→mammoth htmlPath 兜底", async () => {
  // 不假设 LibreOffice 是否安装。两档都应是结构化成功结果（不再因没装而失败）。
  const service = makeService();
  await withTempDir(async (dir) => {
    const inputPath = join(dir, "preview-input.docx");
    const outputDir = join(dir, "preview-out");
    const create = await service.invoke("skill://docx@1", "create", {
      source: { markdown: "# preview 测试\n\n正文。" },
      outputPath: inputPath
    }, { workDir: dir, scopeAllow: [dir] });
    assert.equal(create.ok, true);

    const result = await service.invoke(
      "skill://docx@1",
      "preview",
      { inputPath, outputDir },
      { workDir: dir, readScopeAllow: [inputPath], writeScopeAllow: [outputDir] }
    );
    assert.equal(result.ok, true, "两档之一都应成功");
    if (result.usedBackend === "libreoffice") {
      assert.ok(result.pdfPath && existsSync(result.pdfPath), "pdfPath 必须存在");
    } else {
      assert.equal(result.usedBackend, "mammoth");
      assert.ok(result.htmlPath && existsSync(result.htmlPath), "兜底 htmlPath 必须存在");
      assert.equal(result.fidelity, "approximate");
    }
  });
});
