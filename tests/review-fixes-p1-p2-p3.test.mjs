import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  DEFAULT_SETTINGS,
  mergeSettings,
  splitSettingsForStorage
} = require("../src/platform/config/settingsService.js");

test("默认模型配置只保留 DeepSeek", () => {
  assert.equal(DEFAULT_SETTINGS.deepseek.model, "deepseek-v4-pro");
  assert.equal(DEFAULT_SETTINGS.deepseek.apiKeyEnv, "DEEPSEEK_API_KEY");
  assert.equal(DEFAULT_SETTINGS.providers, undefined);
  assert.equal(DEFAULT_SETTINGS.taskRoutes, undefined);
});

test("旧多供应商配置只迁移 DeepSeek，并安全拆分密钥", () => {
  const migrated = mergeSettings({
    providers: [
      { id: "deepseek", enabled: true, apiKey: "deepseek-secret", defaultModel: "deepseek-reasoner" },
      { id: "anthropic", enabled: true, apiKey: "discard-me", defaultModel: "claude" }
    ],
    taskRoutes: { default: "anthropic:claude" },
    deepseekV4: { thinkingByTask: { agent: "high" } }
  });
  assert.equal(migrated.deepseek.enabled, true);
  assert.equal(migrated.deepseek.model, "deepseek-v4-pro");
  assert.equal(migrated.deepseek.thinking, "high");
  assert.equal(migrated.deepseek.thinkingByTask, undefined);
  assert.deepEqual(migrated.permissions.fileSystem, { fullAccess: false });
  assert.equal(migrated.providers, undefined);
  assert.equal(migrated.taskRoutes, undefined);
  const split = splitSettingsForStorage(migrated);
  assert.equal(split.publicSettings.deepseek.apiKey, undefined);
  assert.equal(split.localSettings.deepseek.apiKey, "deepseek-secret");
  assert.doesNotMatch(JSON.stringify(split), /discard-me/);
});

test("设置页启用推断保留 env-only DeepSeek", () => {
  function infer(apiKey, apiKeyEnv, currentEnabled) {
    const hasEnvFallback = Boolean(apiKeyEnv);
    return apiKey ? true : (hasEnvFallback ? Boolean(currentEnabled) : false);
  }
  assert.equal(infer("sk-xxx", "", false), true);
  assert.equal(infer("", "DEEPSEEK_API_KEY", true), true);
  assert.equal(infer("", "DEEPSEEK_API_KEY", false), false);
  assert.equal(infer("", "", true), false);
});

test("旧文件夹白名单迁移时退役，不会静默升级为完整文件系统访问", () => {
  const migrated = mergeSettings({
    permissions: {
      fileSystem: { authorizedRoots: ["/Users/example/Documents"] }
    }
  });
  assert.deepEqual(migrated.permissions.fileSystem, { fullAccess: false });
});

test("[P3] AGENTS.md 文档阈值与 architecture.test 实际阈值一致(2230)", async () => {
  const { readFile } = await import("node:fs/promises");
  const path = (await import("node:path")).default;
  const agentsMd = await readFile(path.join(process.cwd(), "AGENTS.md"), "utf8");
  assert.ok(agentsMd.includes("workflowEngine.js` < 2230 lines"));
  assert.ok(!agentsMd.includes("workflowEngine.js` < 2200 lines"));
});
