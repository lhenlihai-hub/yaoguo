import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { AiRouter } = require("../src/platform/ai/aiRouter.js");
const { RegistryService } = require("../src/platform/registries/registryService.js");

async function promptFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "yaoguo-required-prompts-"));
  const registriesDir = path.join(root, "registries");
  const blocksDir = path.join(registriesDir, "prompts", "blocks");
  await mkdir(blocksDir, { recursive: true });
  return {
    root,
    registriesDir,
    blocksDir,
    registry: new RegistryService({ registriesDir })
  };
}

function promptAsset(id, content) {
  return JSON.stringify({
    id,
    kind: "prompt-block",
    version: 1,
    title: id,
    content
  });
}

test("必需 Prompt 缺失或损坏时 fail-closed", async () => {
  const fixture = await promptFixture();
  try {
    await assert.rejects(
      fixture.registry.getPromptBlock("block://system.agent", { required: true }),
      (error) => error?.code === "REQUIRED_PROMPT_UNAVAILABLE"
    );

    await writeFile(path.join(fixture.blocksDir, "00-corrupt.json"), "{", "utf8");
    await writeFile(
      path.join(fixture.blocksDir, "system.agent.json"),
      promptAsset("block://system.agent", "<identity>腰果</identity>"),
      "utf8"
    );
    await assert.rejects(
      fixture.registry.getPromptBlock("block://system.agent", { required: true }),
      (error) => error?.code === "REQUIRED_PROMPT_UNAVAILABLE"
        && /无法解析/.test(error.message)
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("AiRouter 不缓存可选 Prompt 的空结果，必需资产恢复后可正常读取", async () => {
  const fixture = await promptFixture();
  try {
    const router = new AiRouter(
      { get: async () => ({ deepseek: {} }) },
      { registriesDir: fixture.registriesDir },
      { registryService: fixture.registry }
    );
    assert.equal(await router.loadSystemPromptBlock("block://system.agent"), "");

    await writeFile(
      path.join(fixture.blocksDir, "system.agent.json"),
      promptAsset("block://system.agent", "<identity>腰果</identity>"),
      "utf8"
    );
    assert.equal(
      await router.loadSystemPromptBlock("block://system.agent", { required: true }),
      "<identity>腰果</identity>"
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("记忆缓存边界与行为规范是 system.agent 中独立且必需的稳定 section", async () => {
  const fixture = await promptFixture();
  try {
    await writeFile(
      path.join(fixture.blocksDir, "system.agent.json"),
      promptAsset("block://system.agent", "<identity>腰果</identity>"),
      "utf8"
    );
    const router = new AiRouter(
      { get: async () => ({ deepseek: {} }) },
      { registriesDir: fixture.registriesDir },
      { registryService: fixture.registry }
    );
    await assert.rejects(
      router.loadSystemPromptSection("block://system.agent", "memory.behavior", { required: true }),
      (error) => error?.code === "REQUIRED_PROMPT_SECTION_UNAVAILABLE"
        && error?.sectionId === "memory.behavior"
    );

    await writeFile(
      path.join(fixture.blocksDir, "system.agent.json"),
      JSON.stringify({
        id: "block://system.agent",
        kind: "prompt-block",
        version: 1,
        title: "system.agent",
        content: "<identity>腰果</identity>",
        sections: {
          "memory.cache": "<memory_cache>稳定缓存边界</memory_cache>",
          "memory.behavior": "<memory_behavior>稳定规范</memory_behavior>"
        }
      }),
      "utf8"
    );
    assert.equal(
      await router.loadSystemPromptSection("block://system.agent", "memory.behavior", { required: true }),
      "<memory_behavior>稳定规范</memory_behavior>"
    );
    assert.equal(
      await router.loadSystemPromptSection("block://system.agent", "memory.cache", { required: true }),
      "<memory_cache>稳定缓存边界</memory_cache>"
    );
    assert.equal(router._systemPromptSectionCache.size, 2);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("面向用户的系统 Prompt 缺少任一宪法资产时不发起降级调用", async () => {
  const fixture = await promptFixture();
  try {
    await writeFile(
      path.join(fixture.blocksDir, "system.agent.json"),
      promptAsset("block://system.agent", "<identity>腰果</identity>"),
      "utf8"
    );
    const router = new AiRouter(
      { get: async () => ({ deepseek: {} }) },
      { registriesDir: fixture.registriesDir },
      { registryService: fixture.registry }
    );
    await assert.rejects(
      router.assembleSystemPrompt("agent"),
      (error) => error?.code === "REQUIRED_PROMPT_UNAVAILABLE"
        && error?.blockId === "block://soul.zh"
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
