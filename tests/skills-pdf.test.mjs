import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
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
  return new SkillsService({
    skillsRegistry,
    skillRunner: new SkillRunner(),
    dependencyResolver: new DependencyResolver({ projectRoot: root })
  });
}

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "yaoguo-pdf-skill-"));
  return Promise.resolve(fn(dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test("skill registry 同时识别 docx 与 pdf，且不把 _lib 当 skill", async () => {
  const service = makeService();
  const ids = (await service.list()).map((s) => s.id);
  assert.ok(ids.includes("skill://docx@1"));
  assert.ok(ids.includes("skill://pdf@1"));
  assert.ok(!ids.some((id) => id.includes("_lib")));
});

test("pdf skill 声明 create / validate，format=pdf", async () => {
  const service = makeService();
  const pdf = (await service.list()).find((s) => s.id === "skill://pdf@1");
  assert.equal(pdf.format, "pdf");
  for (const a of ["create", "validate"]) assert.ok(pdf.actions.includes(a));
});

test("pdf create：有 LibreOffice 则真转 docx→pdf；没有则 DEP_MISSING 优雅降级", async () => {
  const service = makeService();
  await withTempDir(async (dir) => {
    // 先用 docx skill 造一个真实 docx
    const docxPath = join(dir, "src.docx");
    const create = await service.invoke("skill://docx@1", "create", {
      source: { markdown: "# PDF 源\n\n这是要转 PDF 的中文正文。" },
      outputPath: docxPath
    }, { workDir: dir, scopeAllow: [dir] });
    assert.equal(create.ok, true, "docx 源生成应成功");

    const pdfPath = join(dir, "out.pdf");
    const result = await service.invoke("skill://pdf@1", "create", {
      inputPath: docxPath, outputPath: pdfPath
    }, { workDir: dir, readScopeAllow: [docxPath], writeScopeAllow: [dir] });

    if (result.ok) {
      // 装了 LibreOffice 的环境
      assert.ok(existsSync(pdfPath), "PDF 应真实存在");
      const validate = await service.invoke("skill://pdf@1", "validate", { inputPath: pdfPath }, { readScopeAllow: [pdfPath] });
      assert.equal(validate.ok, true, "PDF 应通过 %PDF- 魔数校验");
    } else {
      // 没装 LibreOffice：必须是 DEP_MISSING + missingHint（依赖 gate 在 spawn 前拦截）
      assert.equal(result.error?.code, "DEP_MISSING");
      const hint = result.error?.missing?.[0]?.hint || result.error?.missingHint;
      assert.ok(hint && /LibreOffice/i.test(hint), "DEP_MISSING 必须带 LibreOffice 安装引导");
    }
  });
});

test("pdf validate：非 PDF 文件被 BAD_MAGIC 拦下", async () => {
  const service = makeService();
  await withTempDir(async (dir) => {
    const fake = join(dir, "not-a.pdf");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(fake, "这不是 PDF 内容");
    const result = await service.invoke("skill://pdf@1", "validate", { inputPath: fake }, { readScopeAllow: [fake] });
    assert.equal(result.ok, false);
    assert.equal(result.errors?.[0]?.code, "BAD_MAGIC");
  });
});

test("pdf create scope 越界被拒", async () => {
  const service = makeService();
  await withTempDir(async (allowDir) => {
    // 造个 docx 源（在 allowDir 内）
    const docxPath = join(allowDir, "src.docx");
    await service.invoke("skill://docx@1", "create", {
      source: { markdown: "# x" }, outputPath: docxPath
    }, { workDir: allowDir, scopeAllow: [allowDir] });
    // 输出指向 allowDir 之外
    const result = await service.invoke("skill://pdf@1", "create", {
      inputPath: docxPath, outputPath: join(tmpdir(), "yaoguo-pdf-escape.pdf")
    }, { workDir: allowDir, scopeAllow: [allowDir] });
    // 没 LibreOffice 时 DEP_MISSING 会先于 scope 检查（gate 在 spawn 前）；
    // 装了 LibreOffice 时应是 SCOPE_VIOLATION。两者都可接受，但不能成功。
    assert.equal(result.ok, false);
    assert.ok(["SCOPE_VIOLATION", "DEP_MISSING"].includes(result.error?.code));
  });
});
