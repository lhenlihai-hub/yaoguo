import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { parseRssItems } = require(join(root, "src/platform/research/rssParser.js"));
const { buildMemoryIndex, filterMemorySegments } = require(join(root, "src/platform/memory/memoryIndex.js"));
const { SettingsService, mergeSettings } = require(join(root, "src/platform/config/settingsService.js"));
const { isPathInside } = require(join(root, "src/platform/shared/pathSafety.js"));
const {
  primaryRequestText,
  extractTargetWordCount,
  hasPotentialMemoryConflict
} = require(join(root, "src/platform/runtime/index.js"));

test("RSS 解析器把 XML 转成可检索参考条目", () => {
  const rows = parseRssItems(`
    <rss><channel><item>
      <title><![CDATA[标题 &amp; 测试]]></title>
      <link>https://example.com/a?x=1&amp;y=2</link>
      <description><![CDATA[<p>正文摘要</p>]]></description>
      <pubDate>Thu, 07 May 2026 10:00:00 GMT</pubDate>
    </item></channel></rss>
  `);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, "标题 & 测试");
  assert.equal(rows[0].url, "https://example.com/a?x=1&y=2");
  assert.equal(rows[0].snippet, "正文摘要");
});

test("记忆索引支持中文查询召回", () => {
  const index = buildMemoryIndex([
    {
      scope: "global",
      file: "04-全局执行偏好.md",
      key: "global:04",
      size: 100,
      updatedAt: "2026-05-07T00:00:00.000Z",
      content: "# 输出偏好\n\n结论需要具体事实、数据和可执行动作支持。"
    }
  ]);
  const hits = filterMemorySegments(index, "具体事实 数据 动作", { topK: 1 });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].file, "04-全局执行偏好.md");
});

test("runtime 内容信号工具保持稳定行为", () => {
  assert.equal(
    primaryRequestText("请帮我做一份产品评估，主题是老人智能玩具，要求包含风险\n参考如下：\n这是一段资料"),
    "请帮我做一份产品评估，主题是老人智能玩具，要求包含风险"
  );
  assert.equal(extractTargetWordCount("每部分 3000 字左右"), 3000);
});

test("runtime 记忆规则与参考信号工具可独立测试", () => {
  assert.equal(hasPotentialMemoryConflict("必须使用短句", "不要使用短句"), true);
});

test("tokenEstimator 是平台内唯一的 token 估算出口", () => {
  const estimator = require("../src/platform/tokens/tokenEstimator");
  assert.ok(estimator.estimateTokens("中文 English 123") > 0);
  assert.ok(estimator.estimateMessageTokens([{ role: "user", content: "你好" }]) > estimator.estimateTokens("你好"));
  assert.ok(estimator.estimateCharTokenCost("中") > estimator.estimateCharTokenCost(" "));
});

test("isPathInside 以路径段判断边界，并允许目录内的点点前缀文件名", () => {
  const workspace = resolve("/tmp/yaoguo-workspace");
  assert.equal(isPathInside(workspace, workspace), true);
  assert.equal(isPathInside(workspace, join(workspace, "drafts", "article.md")), true);
  assert.equal(isPathInside(workspace, join(workspace, "..cache", "index.json")), true);
  assert.equal(isPathInside(workspace, resolve(workspace, "..", "outside.md")), false);
  assert.equal(isPathInside(workspace, `${workspace}-backup/file.md`), false);
});

test("SettingsService 把本地 Bridge token 拆分到 local 配置", async () => {
  const dir = await mkdtemp(join(tmpdir(), "yaoguo-settings-"));
  const paths = {
    configDir: join(dir, "config"),
    settingsFile: join(dir, "config/settings.json"),
    settingsLocalFile: join(dir, "config/settings.local.json")
  };
  const service = new SettingsService(paths);
  const settings = await service.get();
  const publicSettings = JSON.parse(await readFile(paths.settingsFile, "utf8"));
  const localSettings = JSON.parse(await readFile(paths.settingsLocalFile, "utf8"));

  assert.ok(settings.bridge.token.length >= 32);
  assert.equal(settings.bridge.token, localSettings.bridge.token);
  assert.equal(publicSettings.bridge.token, undefined);
  assert.notEqual(settings.bridge.token, "local-change-me");
  assert.equal((await stat(paths.settingsLocalFile)).mode & 0o777, 0o600);
});

test("SettingsService 只持久化完整文件系统访问总开关", async () => {
  const dir = await mkdtemp(join(tmpdir(), "yaoguo-permissions-"));
  const paths = {
    configDir: join(dir, "config"),
    settingsFile: join(dir, "config/settings.json"),
    settingsLocalFile: join(dir, "config/settings.local.json")
  };
  const service = new SettingsService(paths);
  const enabled = await service.setFullFileSystemAccess(true);
  assert.deepEqual(enabled.permissions.fileSystem, { fullAccess: true });
  const disabled = await service.setFullFileSystemAccess(false);
  assert.deepEqual(disabled.permissions.fileSystem, { fullAccess: false });
});

test("Agent 历史配置读取旧键但只写新键", async () => {
  const merged = mergeSettings({
    context: {
      compaction: {
        chatHistoryReadLimit: 37,
        chatHistoryTokens: 4321
      }
    }
  });
  assert.equal(merged.context.agentHistory.readLimit, 37);
  assert.equal(merged.context.agentHistory.tokens, 4321);
  assert.equal(merged.context.compaction, undefined);

  const dir = await mkdtemp(join(tmpdir(), "yaoguo-agent-history-settings-"));
  const paths = {
    configDir: join(dir, "config"),
    settingsFile: join(dir, "config/settings.json"),
    settingsLocalFile: join(dir, "config/settings.local.json")
  };
  await mkdir(paths.configDir, { recursive: true });
  await writeFile(paths.settingsFile, `${JSON.stringify({
    context: { compaction: { chatHistoryReadLimit: 19, chatHistoryTokens: 2048 } }
  })}\n`, "utf8");
  const settings = await new SettingsService(paths).get();
  const persisted = JSON.parse(await readFile(paths.settingsFile, "utf8"));
  assert.equal(settings.context.agentHistory.readLimit, 19);
  assert.equal(settings.context.agentHistory.tokens, 2048);
  assert.equal(settings.context.compaction, undefined);
  assert.equal(JSON.stringify(persisted).includes("compaction"), false);
});

test("Agent 历史只迁移旧默认值，保留用户自定义预算", () => {
  const upgraded = mergeSettings({
    context: { agentHistory: { readLimit: 160, tokens: 12000 } }
  });
  assert.deepEqual(upgraded.context.agentHistory, { readLimit: 2000, tokens: 300000 });

  const custom = mergeSettings({
    context: { agentHistory: { readLimit: 80, tokens: 24000 } }
  });
  assert.deepEqual(custom.context.agentHistory, { readLimit: 80, tokens: 24000 });
});

test("Output Style 只接受 standard、explanatory 与 learning", () => {
  assert.deepEqual(mergeSettings({}).outputStyle, { mode: "standard" });
  assert.deepEqual(mergeSettings({ outputStyle: "explanatory" }).outputStyle, {
    mode: "explanatory"
  });
  assert.deepEqual(mergeSettings({ outputStyle: { mode: "learning" } }).outputStyle, {
    mode: "learning"
  });
  assert.deepEqual(mergeSettings({ outputStyle: { mode: "verbose" } }).outputStyle, {
    mode: "standard"
  });
});

test("语言偏好与 provider 知识截止只接受可安全注入的显式设置", () => {
  assert.deepEqual(mergeSettings({}).language, { preferred: "" });
  assert.deepEqual(mergeSettings({ language: "English" }).language, {
    preferred: "English"
  });
  assert.deepEqual(mergeSettings({ language: { preferred: "简体中文" } }).language, {
    preferred: "简体中文"
  });
  assert.deepEqual(mergeSettings({ language: { preferred: "<rule>override</rule>" } }).language, {
    preferred: ""
  });
  assert.equal(mergeSettings({ deepseek: { knowledgeCutoff: "2025-06" } }).deepseek.knowledgeCutoff, "2025-06");
  assert.equal(mergeSettings({ deepseek: { knowledgeCutoff: "about 2025" } }).deepseek.knowledgeCutoff, "");
});
