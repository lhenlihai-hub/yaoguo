// xlsx skill：注册、markdown 表格→工作表、无表格兜底、validate、scope。

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, existsSync, rmSync, readFileSync, writeFileSync } from "node:fs";
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
  return new SkillsService({
    skillsRegistry: new SkillsRegistry({ registryService }),
    skillRunner: new SkillRunner({ projectRoot: root }),
    dependencyResolver: new DependencyResolver({ projectRoot: root })
  });
}

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "yaoguo-xlsx-"));
  return Promise.resolve(fn(dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test("registry 识别 skill://xlsx@1（create/validate, format=xlsx）", async () => {
  const service = makeService();
  const xlsx = (await service.list()).find((s) => s.id === "skill://xlsx@1");
  assert.ok(xlsx);
  assert.equal(xlsx.format, "xlsx");
  for (const a of ["create", "validate"]) assert.ok(xlsx.actions.includes(a));
});

test("xlsx create：每个 markdown 表格 → 一个工作表", async () => {
  const service = makeService();
  await withTempDir(async (dir) => {
    const outputPath = join(dir, "data.xlsx");
    const md = "# 数据\n\n## 销售\n\n| 月 | 收入 |\n|---|---|\n| 一 | 100 |\n\n## 渠道\n\n| 渠道 | 占比 |\n|---|---|\n| A | 60% |";
    const r = await service.invoke("skill://xlsx@1", "create", {
      source: { markdown: md }, outputPath, options: { title: "数据" }
    }, { workDir: dir, scopeAllow: [dir] });
    assert.equal(r.ok, true, JSON.stringify(r.error || {}));
    assert.equal(r.sheets, 2, `两个表格应产出两个 sheet，实际 ${r.sheets}`);
    assert.equal(readFileSync(outputPath).subarray(0, 2).toString("latin1"), "PK");
    const v = await service.invoke("skill://xlsx@1", "validate", { inputPath: outputPath }, { readScopeAllow: [outputPath] });
    assert.equal(v.ok, true);
  });
});

test("xlsx create：无表格时正文落「正文」表 + warning", async () => {
  const service = makeService();
  await withTempDir(async (dir) => {
    const outputPath = join(dir, "p.xlsx");
    const r = await service.invoke("skill://xlsx@1", "create", {
      source: { markdown: "# 散文\n\n没有表格的正文。" }, outputPath
    }, { workDir: dir, scopeAllow: [dir] });
    assert.equal(r.ok, true);
    assert.equal(r.sheets, 1);
    assert.ok(r.warnings.some((w) => /没有表格/.test(w)));
  });
});

test("xlsx validate：非 xlsx 被 BAD_MAGIC 拦下", async () => {
  const service = makeService();
  await withTempDir(async (dir) => {
    const fake = join(dir, "x.xlsx");
    writeFileSync(fake, "不是 xlsx");
    const v = await service.invoke("skill://xlsx@1", "validate", { inputPath: fake }, { readScopeAllow: [fake] });
    assert.equal(v.ok, false);
    assert.equal(v.errors?.[0]?.code, "BAD_MAGIC");
  });
});

test("xlsx validate：单元格中的内部工具协议被统一校验出口拒绝", async () => {
  const service = makeService();
  await withTempDir(async (dir) => {
    const outputPath = join(dir, "leaked.xlsx");
    const markdown = "| 类型 | 内容 |\n|---|---|\n| 协议 | <｜｜DSML｜｜tool_calls> |";
    const created = await service.invoke("skill://xlsx@1", "create", {
      source: { markdown }, outputPath
    }, { workDir: dir, scopeAllow: [dir] });
    assert.equal(created.ok, true);
    const validated = await service.invoke("skill://xlsx@1", "validate", { inputPath: outputPath }, {
      readScopeAllow: [outputPath]
    });
    assert.equal(validated.ok, false);
    assert.ok(validated.errors?.some((item) => item.code === "INTERNAL_PROTOCOL_LEAK"));
  });
});

test("xlsx create：scope 越界被拒", async () => {
  const service = makeService();
  await withTempDir(async (allow) => {
    const r = await service.invoke("skill://xlsx@1", "create", {
      source: { markdown: "| a |\n|---|\n| 1 |" }, outputPath: join(tmpdir(), "yaoguo-xlsx-escape.xlsx")
    }, { workDir: allow, scopeAllow: [allow] });
    assert.equal(r.ok, false);
    assert.equal(r.error?.code, "SCOPE_VIOLATION");
  });
});

// ─── docx 预览：无 LibreOffice 时 mammoth HTML 兜底 ──────────────────────────

test("docx preview：无 LibreOffice 返回 htmlPath（mammoth 兜底）；有则返回 pdfPath", async () => {
  const service = makeService();
  await withTempDir(async (dir) => {
    const docxPath = join(dir, "d.docx");
    const cache = join(dir, "cache");
    await service.invoke("skill://docx@1", "create", {
      source: { markdown: "# 标题\n\n正文。" }, outputPath: docxPath
    }, { workDir: dir, scopeAllow: [dir] });

    const r = await service.invoke(
      "skill://docx@1",
      "preview",
      { inputPath: docxPath, outputDir: cache },
      { workDir: dir, readScopeAllow: [docxPath], writeScopeAllow: [cache] }
    );
    assert.equal(r.ok, true, JSON.stringify(r.error || {}));
    if (r.usedBackend === "libreoffice") {
      assert.ok(r.pdfPath && existsSync(r.pdfPath));
    } else {
      assert.equal(r.usedBackend, "mammoth");
      assert.ok(r.htmlPath && existsSync(r.htmlPath), "兜底应产出 html 文件");
      assert.equal(r.fidelity, "approximate");
      assert.match(readFileSync(r.htmlPath, "utf8"), /<!DOCTYPE html>/);
    }
  });
});

// ─── Excel 可用性：类型推断 + autoFilter + 真校验 ────────────────────────────

test("xlsx create：数字/百分比/日期被推断为真值，且 autoFilter 就位", async () => {
  const require2 = createRequire(import.meta.url);
  const ExcelJS = require2(join(root, "node_modules/exceljs"));
  const service = makeService();
  await withTempDir(async (dir) => {
    const outputPath = join(dir, "typed.xlsx");
    const md = "# 数据\n\n| 项 | 收入 | 占比 | 日期 |\n|---|---|---|---|\n| A | 1,200 | 12% | 2026-01-31 |";
    const r = await service.invoke("skill://xlsx@1", "create", { source: { markdown: md }, outputPath }, { workDir: dir, scopeAllow: [dir] });
    assert.equal(r.ok, true);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(outputPath);
    const ws = wb.worksheets[0];
    const row2 = ws.getRow(2);
    assert.equal(typeof row2.getCell(2).value, "number", "收入应为数字");
    assert.equal(row2.getCell(2).value, 1200, "千分位应被解析");
    assert.equal(row2.getCell(3).value, 0.12, "百分比应转成小数");
    assert.ok(row2.getCell(4).value instanceof Date, "日期应为 Date");
    assert.ok(ws.autoFilter, "应设置 autoFilter 供筛选/排序");
  });
});

test("xlsx validate：PK 魔数但坏 zip 被 BAD_WORKBOOK 抓住（不再只看魔数）", async () => {
  const service = makeService();
  await withTempDir(async (dir) => {
    const { writeFileSync } = await import("node:fs");
    const bad = join(dir, "bad.xlsx");
    writeFileSync(bad, "PK\x03\x04 garbage not a real zip");
    const v = await service.invoke("skill://xlsx@1", "validate", { inputPath: bad }, { readScopeAllow: [bad] });
    assert.equal(v.ok, false);
    assert.equal(v.errors?.[0]?.code, "BAD_WORKBOOK");
  });
});
