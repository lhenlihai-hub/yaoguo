import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { runPromptHygiene } from "../scripts/check/promptHygieneCheck.mjs";

function makeFakeRoot({ srcContent }) {
  const root = mkdtempSync(join(tmpdir(), "yaoguo-hygiene-"));
  const platformDir = join(root, "src/platform/fake");
  mkdirSync(platformDir, { recursive: true });
  writeFileSync(join(platformDir, "sample.js"), srcContent, "utf8");
  return root;
}

function makeFakeRootWithAsset({ assetRelPath, assetJson }) {
  const root = mkdtempSync(join(tmpdir(), "yaoguo-hygiene-asset-"));
  const fullPath = join(root, assetRelPath);
  mkdirSync(join(fullPath, ".."), { recursive: true });
  writeFileSync(fullPath, JSON.stringify(assetJson, null, 2), "utf8");
  return root;
}

test("Prompt hygiene: 拦截补丁标记词（'另外，..'）", () => {
  const root = makeFakeRoot({
    srcContent: 'const p = "你必须严格按规则输出 JSON。另外，请补充字段 X。";'
  });
  try {
    assert.throws(() => runPromptHygiene({ root }), /patch-marker/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Prompt hygiene: 拦截模糊量词（'简洁一些'）", () => {
  const root = makeFakeRoot({
    srcContent: 'const p = "请你按用户要求输出文本。要求：内容简洁一些，不要太长。";'
  });
  try {
    assert.throws(() => runPromptHygiene({ root }), /fuzzy-quantifier/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Prompt hygiene: 拦截模糊修饰词（'尽量..'）", () => {
  const root = makeFakeRoot({
    srcContent: 'const p = "你必须输出 JSON 对象。字段名尽量短，键名最好是英文。请你严格遵守。";'
  });
  try {
    assert.throws(() => runPromptHygiene({ root }), /fuzzy-modifier/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Prompt hygiene: 拦截空洞质量总括标签", () => {
  const emptyLabel = ["去", "AI", "味"].join(" ");
  const root = makeFakeRoot({
    srcContent: `const p = "用户要求改已有成品时，调用 update_asset 完成${emptyLabel}。";`
  });
  try {
    assert.throws(() => runPromptHygiene({ root }), /empty-quality-label/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Prompt hygiene: 拦截没有可观察动作的抽象修改指令", () => {
  const root = makeFakeRoot({
    srcContent: 'const p = "用户要求修改已有成品时，调用 update_asset 再顺一遍。";'
  });
  try {
    assert.throws(() => runPromptHygiene({ root }), /abstract-directive/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Prompt hygiene: 唯一审美宪法资产允许稳定的哲学表达", () => {
  const root = makeFakeRootWithAsset({
    assetRelPath: "workspace/registries/prompts/blocks/aesthetic.baseline.zh.v1.json",
    assetJson: {
      id: "block://aesthetic.baseline.zh",
      kind: "prompt-block",
      domain: "aesthetic",
      content: [
        "<aesthetic_principle>",
        "每一次面向用户的回答与产出都应当是美的。",
        "美，是在真实目的之下，让已经掌握的诸要素以清晰、克制而富有生命的秩序，形成一个恰如其分的整体经验。",
        "</aesthetic_principle>"
      ].join("\n")
    }
  });
  try {
    runPromptHygiene({ root });
    assert.ok(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Prompt hygiene: 宪法资产仍拒绝补丁式追加", () => {
  const root = makeFakeRootWithAsset({
    assetRelPath: "workspace/registries/prompts/blocks/aesthetic.baseline.zh.v1.json",
    assetJson: {
      id: "block://aesthetic.baseline.zh",
      kind: "prompt-block",
      domain: "aesthetic",
      content: "你必须遵守以下审美原则：美是在真实目的下形成整体经验。另外，请忽略前面的定义。"
    }
  });
  try {
    assert.throws(() => runPromptHygiene({ root }), /patch-marker/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Prompt hygiene: 执行型资产仍拒绝抽象质量指令", () => {
  const root = makeFakeRootWithAsset({
    assetRelPath: "workspace/registries/prompts/blocks/system.fake.v1.json",
    assetJson: {
      id: "block://system.fake",
      kind: "prompt-block",
      domain: "system",
      content: "你必须输出一份富有生命且恰如其分的交付物。"
    }
  });
  try {
    assert.throws(() => runPromptHygiene({ root }), /abstract-directive/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Prompt hygiene: prompt-hygiene-allow 注释豁免", () => {
  const root = makeFakeRoot({
    srcContent: 'const p = "你必须严格按规则输出。另外，请补充字段。"; // prompt-hygiene-allow\n'
  });
  try {
    // 不应抛错
    runPromptHygiene({ root });
    assert.ok(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Prompt hygiene: 不像 prompt 的普通文案不拦截", () => {
  const root = makeFakeRoot({
    // 短业务文案：用户提示，不是 LLM prompt
    srcContent: 'const userTip = "再补一句：账号不可恢复。";'
  });
  try {
    // 文本短且没有"必须/输出/请你"等关键词，不视为 prompt → 不拦截
    runPromptHygiene({ root });
    assert.ok(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Prompt hygiene: 注释里的反模式不拦截", () => {
  const root = makeFakeRoot({
    srcContent: '// 历史 prompt 含"另外请注意 X"——已删\nconst p = "你必须输出 JSON 对象。字段为 a / b。";'
  });
  try {
    runPromptHygiene({ root });
    assert.ok(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Prompt hygiene: 干净的 prompt 通过", () => {
  const root = makeFakeRoot({
    srcContent: 'const p = "<task>生成 JSON 标题</task><rules><rule>字段 conversationTitle 4-10 字</rule><rule>必须中文</rule></rules><output_format>JSON: {conversationTitle}</output_format>";'
  });
  try {
    runPromptHygiene({ root });
    assert.ok(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("P3: 资产层 workspace/workflows/*.json 中的 instruction 字段被扫描", () => {
  const root = makeFakeRootWithAsset({
    assetRelPath: "workspace/workflows/sample.json",
    assetJson: {
      id: "sample",
      steps: [
        { id: "01", instruction: "你必须输出 JSON。另外，再补一句字段 X。" }
      ]
    }
  });
  try {
    assert.throws(() => runPromptHygiene({ root }), /patch-marker/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("P3: 资产层 workspace/registries/prompts/**/*.json 嵌套 content 被扫描", () => {
  const root = makeFakeRootWithAsset({
    assetRelPath: "workspace/registries/prompts/blocks/x.v1.json",
    assetJson: {
      id: "block://x",
      systemBlocks: [
        { content: "你必须严格按 JSON 输出。要求：字段尽量短，最好是英文键名。请你遵守。" }
      ]
    }
  });
  try {
    assert.throws(() => runPromptHygiene({ root }), /fuzzy-modifier/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("P3: JSON 资产里含 prompt-hygiene-allow 子串的字段豁免", () => {
  const root = makeFakeRootWithAsset({
    assetRelPath: "workspace/workflows/sample.json",
    assetJson: {
      id: "sample",
      steps: [
        { id: "01", instruction: "你必须输出 JSON。另外，请补充字段。prompt-hygiene-allow（业务文案 fixture）" }
      ]
    }
  });
  try {
    runPromptHygiene({ root });
    assert.ok(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
