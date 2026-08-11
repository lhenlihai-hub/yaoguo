// pptx skill：注册、create 真产出合法 pptx、validate、scope、buildSlides 切片。

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, existsSync, mkdirSync, rmSync, readFileSync, symlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
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
  const dir = mkdtempSync(join(tmpdir(), "yaoguo-pptx-"));
  return Promise.resolve(fn(dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test("registry 识别 skill://pptx@1（create/validate/preview, format=pptx）", async () => {
  const service = makeService();
  const pptx = (await service.list()).find((s) => s.id === "skill://pptx@1");
  assert.ok(pptx, "应注册 pptx skill");
  assert.equal(pptx.format, "pptx");
  for (const a of ["create", "validate", "preview"]) assert.ok(pptx.actions.includes(a));
});

test("dependencyResolver 打包态从应用资源目录解析 pptxgenjs", async () => {
  await withTempDir(async (dir) => {
    const resourcesPath = join(dir, "Resources");
    const appRoot = join(resourcesPath, "app");
    const userWorkspaceRoot = join(dir, "Application Support", "腰果", "workspace-root");
    mkdirSync(appRoot, { recursive: true });
    mkdirSync(userWorkspaceRoot, { recursive: true });
    symlinkSync(join(root, "node_modules"), join(appRoot, "node_modules"), "dir");

    const resolver = new DependencyResolver({ projectRoot: userWorkspaceRoot, resourcesPath });
    const result = await resolver.resolve({ id: "pptxgenjs", kind: "npm" });
    assert.equal(result.installed, true);
    assert.equal(result.version, "4.0.1");
  });
});

test("pptx create：零外部依赖产出合法 pptx（PK + ppt/presentation.xml）", async () => {
  const service = makeService();
  await withTempDir(async (dir) => {
    const outputPath = join(dir, "deck.pptx");
    const md = "# 方案标题\n\n开场介绍。\n\n## 第一部分\n\n- 要点一\n- 要点二\n\n## 数据\n\n| 指标 | 值 |\n|---|---|\n| A | 1 |";
    const r = await service.invoke("skill://pptx@1", "create", {
      source: { markdown: md }, outputPath, options: { title: "测试演示" }
    }, { workDir: dir, scopeAllow: [dir] });
    assert.equal(r.ok, true, JSON.stringify(r.error || {}));
    assert.ok(existsSync(outputPath));
    assert.ok(r.slides >= 3, `应有标题页+内容页，实际 ${r.slides}`);
    // PK 魔数
    const head = readFileSync(outputPath).subarray(0, 2).toString("latin1");
    assert.equal(head, "PK");
    // validate 通过
    const v = await service.invoke("skill://pptx@1", "validate", { inputPath: outputPath }, { readScopeAllow: [outputPath] });
    assert.equal(v.ok, true, JSON.stringify(v.errors || []));
  });
});

test("pptx create：宿主提供的已验证图片真正写入 OOXML media", async () => {
  const service = makeService();
  await withTempDir(async (dir) => {
    const outputPath = join(dir, "deck-with-image.pptx");
    const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const r = await service.invoke("skill://pptx@1", "create", {
      source: { markdown: "# 封面\n\n## 主题\n\n核心内容。" },
      outputPath,
      options: {
        title: "带图演示",
        images: [{ data: png, width: 1, height: 1, title: "测试图", credit: "Public domain" }]
      }
    }, { workDir: dir, scopeAllow: [dir] });
    assert.equal(r.ok, true, JSON.stringify(r.error || {}));
    assert.equal(r.images, 1);
    const JSZip = require("jszip");
    const zip = await JSZip.loadAsync(readFileSync(outputPath));
    assert.ok(Object.keys(zip.files).some((name) => /^ppt\/media\/image[^/]*\./.test(name)), "PPTX 应包含图片 media 部件");
  });
});

test("pptx validate：非 pptx 文件被 BAD_MAGIC 拦下", async () => {
  const service = makeService();
  await withTempDir(async (dir) => {
    const { writeFileSync } = await import("node:fs");
    const fake = join(dir, "x.pptx");
    writeFileSync(fake, "不是 pptx");
    const v = await service.invoke("skill://pptx@1", "validate", { inputPath: fake }, { readScopeAllow: [fake] });
    assert.equal(v.ok, false);
    assert.equal(v.errors?.[0]?.code, "BAD_MAGIC");
  });
});

test("pptx validate：幻灯片中的内部工具协议被拒绝", async () => {
  const service = makeService();
  await withTempDir(async (dir) => {
    const outputPath = join(dir, "leaked.pptx");
    const leaked = "# <｜｜DSML｜｜tool_calls>\n\n<｜｜DSML｜｜invoke name=\"fetch_url\">";
    const created = await service.invoke("skill://pptx@1", "create", {
      source: { markdown: leaked }, outputPath, options: { title: "<｜｜DSML｜｜tool_calls>" }
    }, { workDir: dir, scopeAllow: [dir] });
    assert.equal(created.ok, true);
    const validated = await service.invoke("skill://pptx@1", "validate", { inputPath: outputPath }, { readScopeAllow: [outputPath] });
    assert.equal(validated.ok, false);
    assert.ok(validated.errors?.some((item) => item.code === "INTERNAL_PROTOCOL_LEAK"));
  });
});

test("pptx create：scope 越界被拒", async () => {
  const service = makeService();
  await withTempDir(async (allow) => {
    const r = await service.invoke("skill://pptx@1", "create", {
      source: { markdown: "# x" }, outputPath: join(tmpdir(), "yaoguo-pptx-escape.pptx")
    }, { workDir: allow, scopeAllow: [allow] });
    assert.equal(r.ok, false);
    assert.equal(r.error?.code, "SCOPE_VIOLATION");
  });
});

test("pptx create：标题切片 —— 每个 H1/H2 一张内容页", () => {
  // 直接跑 create.js 子进程，读 slides 计数验证切片逻辑。
  const createScript = join(root, "workspace/registries/skills/pptx/scripts/create.js");
  const dir = mkdtempSync(join(tmpdir(), "yaoguo-pptx-slice-"));
  try {
    const md = "# 一\n\n正文\n\n## 二\n\n要点\n\n## 三\n\n要点\n\n## 四\n\n要点";
    const out = execFileSync("node", [createScript], {
      input: JSON.stringify({ source: { markdown: md }, outputPath: join(dir, "d.pptx"), options: { title: "T" } }),
      env: { ...process.env, YAOGUO_WORK_DIR: dir, YAOGUO_SCOPE_ALLOW: dir },
      encoding: "utf8"
    });
    const r = JSON.parse(out.trim().split("\n").pop());
    assert.equal(r.ok, true);
    // 标题页(1) + H1"一"(1) + H2 二/三/四(3) = 5
    assert.equal(r.slides, 5, `切片数应为 5，实际 ${r.slides}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pptx buildSlides：课件脚本分流到投屏/备注/版式，不泄露字段标签", () => {
  const { buildSlides } = require(join(root, "workspace/registries/skills/pptx/scripts/create.js"));
  const { marked } = require("marked");
  const md = [
    "## 第1页：开场",
    "",
    "**屏幕主文字**",
    "",
    "> 一句话钩子。",
    "> 第二行钩子。",
    "",
    "**讲解参考词**",
    "",
    "这里是老师的口播稿，应当进备注栏，不上屏。",
    "",
    "`┌ 版式 ┐` 左图右文，标题占上半。`└──┘`"
  ].join("\n");
  const slides = buildSlides(marked.lexer(md), {});
  assert.equal(slides.length, 1);
  const s = slides[0];
  assert.equal(s.title, "第1页：开场");
  assert.deepEqual(s.screen.map((l) => l.text), ["一句话钩子。", "第二行钩子。"]);
  assert.ok(!s.screen.some((l) => /屏幕主文字|讲解参考词/.test(l.text)), "投屏正文不应含字段标签");
  assert.ok(s.notes.join("").includes("口播稿"), "口播稿应进 notes");
  assert.ok(s.art.join("").includes("版式"), "版式指导应进 art");
  assert.equal(s.blocks.length, 0, "结构化分流后通用 blocks 应为空");
});

test("pptx buildSlides：普通 markdown 仍按 H1/H2 切片，无标记走通用 blocks", () => {
  const { buildSlides } = require(join(root, "workspace/registries/skills/pptx/scripts/create.js"));
  const { marked } = require("marked");
  const slides = buildSlides(marked.lexer("# 一\n\n正文\n\n## 二\n\n- 要点"), {});
  assert.equal(slides.length, 2);
  assert.equal(slides[0].screen.length, 0, "无标记不应进投屏");
  assert.ok(slides[0].blocks.length >= 1, "普通段落应进通用 blocks");
  assert.equal(slides[1].title, "二");
});
