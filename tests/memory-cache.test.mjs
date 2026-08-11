import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  MemoryCacheService
} = require("../src/platform/memory/cache");
const {
  InstructionMemoryService
} = require("../src/platform/memory/instructions");
const { RegistryService } = require("../src/platform/registries/registryService.js");
const { AiRouter } = require("../src/platform/ai/aiRouter.js");
const agentInputActions = require("../src/application/workflows/mixins/agent/agentInputActions.js");
const agentMemoryCacheActions = require("../src/application/workflows/mixins/agent/agentMemoryCacheActions.js");

test("三层缓存独立失效：memory 只清文件层，clear 与 compact 清全部", () => {
  const service = new MemoryCacheService();
  const scope = service.taskScope("p1", "t1");
  const session = service.session(scope);
  for (const layer of ["memoryFiles", "userContext", "systemPromptSections"]) {
    session[layer].set("sentinel", layer);
  }

  const memory = service.invalidate(scope, "/memory");
  assert.deepEqual(memory.layers, ["memoryFiles"]);
  assert.equal(session.memoryFiles.size, 0);
  assert.equal(session.userContext.size, 1);
  assert.equal(session.systemPromptSections.size, 1);

  session.memoryFiles.set("sentinel", true);
  const clear = service.invalidate(scope, "/clear");
  assert.deepEqual(clear.layers, ["memoryFiles", "userContext", "systemPromptSections"]);
  assert.deepEqual(service.stats(scope).sizes, {
    memoryFiles: 0,
    userContext: 0,
    systemPromptSections: 0
  });

  for (const layer of ["memoryFiles", "userContext", "systemPromptSections"]) {
    session[layer].set("sentinel", layer);
  }
  assert.deepEqual(service.invalidate(scope, "compact").layers, [
    "memoryFiles",
    "userContext",
    "systemPromptSections"
  ]);
});

test("规则文件与用户上下文没有热重载，日期也只在全量失效后切换", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "yaoguo-memory-cache-instructions-"));
  const workspace = path.join(root, "workspace");
  const managed = path.join(root, "managed");
  const user = path.join(root, "user");
  await Promise.all([workspace, managed, user].map((directory) => mkdir(directory, { recursive: true })));
  const ruleFile = path.join(workspace, "YAOGUO.md");
  const includeFile = path.join(workspace, "included.md");
  await writeFile(ruleFile, "old-rule\n<!-- hidden-rule -->\n@include ./included.md", "utf8");
  await writeFile(includeFile, "old-include", "utf8");
  const memoryCacheService = new MemoryCacheService();
  let now = new Date(2026, 7, 9, 23, 59, 0);
  const service = new InstructionMemoryService({
    managedRoot: managed,
    userRoot: user,
    platform: "linux",
    memoryCacheService,
    clock: () => now,
    settingsService: { get: async () => ({ instructions: {} }) }
  });
  const cacheScope = memoryCacheService.taskScope("p1", "t1");
  try {
    const first = await service.beginTurn({ scopeRoot: workspace, cwd: workspace, cacheScope });
    assert.match(first.initialReminder(), /old-rule/);
    assert.match(first.initialReminder(), /old-include/);
    assert.doesNotMatch(first.initialReminder(), /hidden-rule/);
    assert.match(first.initialReminder(), /current-date="2026-08-09"/);

    await writeFile(ruleFile, "new-rule\n@include ./included.md", "utf8");
    await writeFile(includeFile, "new-include", "utf8");
    now = new Date(2026, 7, 10, 0, 1, 0);

    const cached = await service.beginTurn({ scopeRoot: workspace, cwd: workspace, cacheScope });
    assert.match(cached.initialReminder(), /old-rule/);
    assert.match(cached.initialReminder(), /old-include/);
    assert.match(cached.initialReminder(), /current-date="2026-08-09"/);

    memoryCacheService.invalidate(cacheScope, "memory");
    const filesOnly = await service.beginTurn({ scopeRoot: workspace, cwd: workspace, cacheScope });
    assert.match(filesOnly.initialReminder(), /old-rule/);
    assert.match(filesOnly.initialReminder(), /current-date="2026-08-09"/);

    memoryCacheService.invalidate(cacheScope, "clear");
    const refreshed = await service.beginTurn({ scopeRoot: workspace, cwd: workspace, cacheScope });
    assert.match(refreshed.initialReminder(), /new-rule/);
    assert.match(refreshed.initialReminder(), /new-include/);
    assert.doesNotMatch(refreshed.initialReminder(), /old-rule|old-include/);
    assert.match(refreshed.initialReminder(), /current-date="2026-08-10"/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("system prompt section 按任务会话缓存，文件层失效不联动它", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "yaoguo-memory-cache-system-"));
  const registriesDir = path.join(root, "registries");
  const blocksDir = path.join(registriesDir, "prompts", "blocks");
  const file = path.join(blocksDir, "system.agent.json");
  await mkdir(blocksDir, { recursive: true });
  const writeAsset = (section) => writeFile(file, JSON.stringify({
    id: "block://system.agent",
    kind: "prompt-block",
    version: 1,
    title: "system.agent",
    content: "<identity>腰果</identity>",
    sections: { "memory.behavior": section }
  }), "utf8");
  const memoryCacheService = new MemoryCacheService();
  const router = new AiRouter(
    { get: async () => ({}) },
    { registriesDir },
    {
      registryService: new RegistryService({ registriesDir }),
      memoryCacheService
    }
  );
  const left = memoryCacheService.taskScope("p1", "left");
  const right = memoryCacheService.taskScope("p1", "right");
  try {
    await writeAsset("section-v1");
    assert.equal(await router.loadSystemPromptSection(
      "block://system.agent", "memory.behavior", { required: true, cacheScope: left }
    ), "section-v1");
    await writeAsset("section-v2");
    assert.equal(await router.loadSystemPromptSection(
      "block://system.agent", "memory.behavior", { required: true, cacheScope: left }
    ), "section-v1");
    memoryCacheService.invalidate(left, "memory");
    assert.equal(await router.loadSystemPromptSection(
      "block://system.agent", "memory.behavior", { required: true, cacheScope: left }
    ), "section-v1");
    assert.equal(await router.loadSystemPromptSection(
      "block://system.agent", "memory.behavior", { required: true, cacheScope: right }
    ), "section-v2");
    memoryCacheService.invalidate(left, "clear");
    assert.equal(await router.loadSystemPromptSection(
      "block://system.agent", "memory.behavior", { required: true, cacheScope: left }
    ), "section-v2");
    assert.deepEqual([...memoryCacheService.session(left).systemPromptSections.keys()], ["memory.behavior"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("/memory 与 /clear 是串行宿主命令，不调用模型", async () => {
  const memoryCacheService = new MemoryCacheService();
  const scope = memoryCacheService.taskScope("p1", "t1");
  const session = memoryCacheService.session(scope);
  const messages = [];
  const host = {
    ...agentInputActions,
    ...agentMemoryCacheActions,
    memoryCacheService,
    projectService: {
      getTask: async () => ({ id: "t1", projectId: "p1", title: "任务" })
    },
    appendAgentMessage: async (message) => {
      messages.push(message);
      return message;
    }
  };
  for (const layer of ["memoryFiles", "userContext", "systemPromptSections"]) {
    session[layer].set("sentinel", layer);
  }
  const memory = await host.submitAgentInput({
    projectId: "p1", taskId: "t1", turnId: "memory-command", message: "/memory"
  });
  assert.equal(memory.disposition, "cache-control");
  assert.deepEqual(memory.cache.layers, ["memoryFiles"]);
  assert.equal(session.userContext.size, 1);
  assert.equal(session.systemPromptSections.size, 1);

  session.memoryFiles.set("sentinel", true);
  const clear = await host.submitAgentInput({
    projectId: "p1", taskId: "t1", turnId: "clear-command", message: "/clear"
  });
  assert.deepEqual(clear.cache.layers, ["memoryFiles", "userContext", "systemPromptSections"]);
  assert.equal(messages.length, 4);
  assert.deepEqual(messages.map((message) => message.role), ["user", "assistant", "user", "assistant"]);
});

test("Session Compact 清除当前任务三层缓存", () => {
  const memoryCacheService = new MemoryCacheService();
  const scope = memoryCacheService.taskScope("p1", "t1");
  const session = memoryCacheService.session(scope);
  for (const layer of ["memoryFiles", "userContext", "systemPromptSections"]) {
    session[layer].set("sentinel", layer);
  }
  const result = memoryCacheService.invalidate(scope, "compact");
  assert.deepEqual(result.layers, ["memoryFiles", "userContext", "systemPromptSections"]);
  assert.deepEqual(memoryCacheService.stats(scope).sizes, {
    memoryFiles: 0,
    userContext: 0,
    systemPromptSections: 0
  });
});
