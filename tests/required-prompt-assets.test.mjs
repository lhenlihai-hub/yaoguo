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

function sectionedSystemAsset(content = "<identity>腰果</identity>") {
  return JSON.stringify({
    id: "block://system.agent",
    kind: "prompt-block",
    version: 1,
    title: "system.agent",
    content,
    sections: {
      introduction: "<introduction>腰果</introduction>",
      system: "<system>系统</system>",
      tasks: "<doing_tasks>任务</doing_tasks>",
      actions: "<actions>行动</actions>",
      tools: "<tools>工具</tools>",
      "tone-and-style": "<tone_and_style>风格</tone_and_style>",
      "output-efficiency": "<output_efficiency>效率</output_efficiency>",
      "memory.cache": "<memory_cache>缓存</memory_cache>",
      "memory.behavior": "<memory_behavior>记忆</memory_behavior>"
    }
  });
}

test("必需 Prompt 缺失或目标损坏时 fail-closed，无关损坏资产被隔离", async () => {
  const fixture = await promptFixture();
  try {
    await assert.rejects(
      fixture.registry.getPromptBlock("block://system.agent", { required: true }),
      (error) => error?.code === "REQUIRED_PROMPT_UNAVAILABLE"
    );

    await writeFile(path.join(fixture.blocksDir, "00-corrupt.json"), "{", "utf8");
    await writeFile(
      path.join(fixture.blocksDir, "system.agent.json"),
      sectionedSystemAsset(),
      "utf8"
    );
    const row = await fixture.registry.getPromptBlock("block://system.agent", { required: true });
    assert.equal(row.id, "block://system.agent", "无关损坏资产不得污染目标 block 加载");
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

test("面向用户的系统 Prompt 缺少任一静态 section 时 fail-closed", async () => {
  const fixture = await promptFixture();
  try {
    const systemAsset = JSON.parse(sectionedSystemAsset());
    delete systemAsset.sections.tools;
    await writeFile(
      path.join(fixture.blocksDir, "system.agent.json"),
      JSON.stringify(systemAsset),
      "utf8"
    );
    for (const [file, id, content] of [
      ["soul.json", "block://soul.zh", "<soul>人格</soul>"],
      ["aesthetic.json", "block://aesthetic.baseline.zh", "<aesthetic>审美</aesthetic>"]
    ]) {
      await writeFile(path.join(fixture.blocksDir, file), promptAsset(id, content), "utf8");
    }
    const router = new AiRouter(
      { get: async () => ({ deepseek: {} }) },
      { registriesDir: fixture.registriesDir },
      { registryService: fixture.registry }
    );

    await assert.rejects(
      router.assembleSystemPrompt("agent"),
      (error) => error?.code === "REQUIRED_PROMPT_SECTION_UNAVAILABLE"
        && error?.sectionId === "tools"
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("启用非 standard Output Style 时缺少 Plugin 资产会 fail-closed", async () => {
  const fixture = await promptFixture();
  try {
    const router = new AiRouter(
      { get: async () => ({ deepseek: {} }) },
      { registriesDir: fixture.registriesDir },
      { registryService: fixture.registry }
    );
    await assert.rejects(
      router.loadSystemPromptAsset("block://output.style", { required: true }),
      (error) => error?.code === "REQUIRED_PROMPT_UNAVAILABLE"
        && error?.blockId === "block://output.style"
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("启用文件工具时缺少动态工具指导资产 fail-closed", async () => {
  const fixture = await promptFixture();
  try {
    await Promise.all([
      writeFile(
        path.join(fixture.blocksDir, "system.agent.json"),
        sectionedSystemAsset(),
        "utf8"
      ),
      writeFile(
        path.join(fixture.blocksDir, "soul.json"),
        promptAsset("block://soul.zh", "<soul>人格</soul>"),
        "utf8"
      ),
      writeFile(
        path.join(fixture.blocksDir, "aesthetic.json"),
        promptAsset("block://aesthetic.baseline.zh", "<aesthetic>审美</aesthetic>"),
        "utf8"
      )
    ]);
    const router = new AiRouter(
      { get: async () => ({ deepseek: {} }) },
      { registriesDir: fixture.registriesDir },
      { registryService: fixture.registry }
    );

    await assert.rejects(
      router.assembleSystemPrompt("agent", { tools: ["read"] }),
      (error) => error?.code === "REQUIRED_PROMPT_UNAVAILABLE"
        && error?.blockId === "block://tool.guidance"
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("绑定 Memdir 时缺少动态记忆指导资产 fail-closed", async () => {
  const fixture = await promptFixture();
  try {
    await Promise.all([
      writeFile(
        path.join(fixture.blocksDir, "system.agent.json"),
        sectionedSystemAsset(),
        "utf8"
      ),
      writeFile(
        path.join(fixture.blocksDir, "soul.json"),
        promptAsset("block://soul.zh", "<soul>人格</soul>"),
        "utf8"
      ),
      writeFile(
        path.join(fixture.blocksDir, "aesthetic.json"),
        promptAsset("block://aesthetic.baseline.zh", "<aesthetic>审美</aesthetic>"),
        "utf8"
      )
    ]);
    const router = new AiRouter(
      { get: async () => ({ deepseek: {} }) },
      { registriesDir: fixture.registriesDir },
      { registryService: fixture.registry }
    );

    await assert.rejects(
      router.assembleSystemPrompt("agent", {
        memoryContext: { enabled: true, scope: "local", storageMode: "indexed" }
      }),
      (error) => error?.code === "REQUIRED_PROMPT_UNAVAILABLE"
        && error?.blockId === "block://memory.guidance"
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("启用上下文生命周期能力时缺少动态指导资产 fail-closed", async () => {
  const fixture = await promptFixture();
  try {
    await Promise.all([
      writeFile(
        path.join(fixture.blocksDir, "system.agent.json"),
        sectionedSystemAsset(),
        "utf8"
      ),
      writeFile(
        path.join(fixture.blocksDir, "soul.json"),
        promptAsset("block://soul.zh", "<soul>人格</soul>"),
        "utf8"
      ),
      writeFile(
        path.join(fixture.blocksDir, "aesthetic.json"),
        promptAsset("block://aesthetic.baseline.zh", "<aesthetic>审美</aesthetic>"),
        "utf8"
      )
    ]);
    const router = new AiRouter(
      { get: async () => ({ deepseek: {} }) },
      { registriesDir: fixture.registriesDir },
      { registryService: fixture.registry }
    );

    await assert.rejects(
      router.assembleSystemPrompt("agent", {
        contextManagement: { enabled: true, toolResultMasking: true }
      }),
      (error) => error?.code === "REQUIRED_PROMPT_UNAVAILABLE"
        && error?.blockId === "block://context.guidance"
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("单个损坏的非目标资产文件不会炸掉其他 block 的加载", async () => {
  const fixture = await promptFixture();
  try {
    await writeFile(
      path.join(fixture.blocksDir, "system.json"),
      sectionedSystemAsset("<identity>腰果</identity>"),
      "utf8"
    );
    await writeFile(
      path.join(fixture.blocksDir, "broken.json"),
      "{ 不是合法 JSON",
      "utf8"
    );

    const row = await fixture.registry.getPromptBlock("block://system.agent", { required: true });

    assert.equal(row.id, "block://system.agent");
    assert.match(row.asset.content, /腰果/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("目标资产本身损坏时按 required 语义报出解析失败", async () => {
  const fixture = await promptFixture();
  try {
    await writeFile(
      path.join(fixture.blocksDir, "system.json"),
      "{ 损坏的目标资产",
      "utf8"
    );

    await assert.rejects(
      () => fixture.registry.getPromptBlock("block://system.agent", { required: true }),
      (error) => error?.code === "REQUIRED_PROMPT_UNAVAILABLE"
        && /无法解析/.test(error.message)
    );
    assert.equal(
      await fixture.registry.getPromptBlock("block://system.agent"),
      null,
      "required:false 时损坏资产按缺失返回 null"
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("AiRouter 资产缓存在磁盘文件修改后自动失效", async () => {
  const fixture = await promptFixture();
  const router = new AiRouter(
    { get: async () => ({ deepseek: {} }) },
    { registriesDir: fixture.registriesDir },
    { registryService: fixture.registry }
  );
  try {
    const file = path.join(fixture.blocksDir, "system.agent.json");
    await writeFile(file, promptAsset("block://system.agent", "<identity>v1</identity>"), "utf8");
    assert.equal(await router.loadSystemPromptBlock("block://system.agent"), "<identity>v1</identity>");

    await writeFile(file, promptAsset("block://system.agent", "<identity>v2</identity>"), "utf8");
    const now = new Date();
    await (await import("node:fs/promises")).utimes(file, now, new Date(now.getTime() + 2000));
    assert.equal(
      await router.loadSystemPromptBlock("block://system.agent"),
      "<identity>v2</identity>",
      "mtime 变化后必须重新加载，不要求重启进程"
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("完整 System Prompt 装配会在同一 cacheScope 热重载动态指导资产", async () => {
  const fixture = await promptFixture();
  const writeToolGuidance = (content) => writeFile(
    path.join(fixture.blocksDir, "tool.guidance.json"),
    JSON.stringify({
      id: "block://tool.guidance",
      kind: "prompt-block",
      version: 1,
      title: "tool.guidance",
      content: "动态工具指导。",
      sections: { "file-read": content }
    }),
    "utf8"
  );
  try {
    await Promise.all([
      writeFile(path.join(fixture.blocksDir, "system.agent.json"), sectionedSystemAsset(), "utf8"),
      writeFile(path.join(fixture.blocksDir, "soul.json"), promptAsset("block://soul.zh", "<soul>人格</soul>"), "utf8"),
      writeFile(path.join(fixture.blocksDir, "aesthetic.json"), promptAsset("block://aesthetic.baseline.zh", "<aesthetic>审美</aesthetic>"), "utf8"),
      writeToolGuidance("<file_read>工具规则 v1</file_read>")
    ]);
    const router = new AiRouter(
      { get: async () => ({ deepseek: {} }) },
      { registriesDir: fixture.registriesDir },
      { registryService: fixture.registry }
    );
    const options = { tools: ["read"], cacheScope: "task:p1:t1" };
    assert.match(await router.assembleSystemPrompt("agent", options), /工具规则 v1/);

    await writeToolGuidance("<file_read>工具规则 v2 已更新</file_read>");
    const now = new Date();
    await (await import("node:fs/promises")).utimes(
      path.join(fixture.blocksDir, "tool.guidance.json"),
      now,
      new Date(now.getTime() + 2000)
    );
    const refreshed = await router.assembleSystemPrompt("agent", options);
    assert.match(refreshed, /工具规则 v2 已更新/);
    assert.doesNotMatch(refreshed, /工具规则 v1\b/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
