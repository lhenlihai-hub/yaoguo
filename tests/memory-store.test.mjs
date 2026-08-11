import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { link, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  MemoryStore,
  MEMORY_TYPES,
  TYPE_BASIS,
  MAX_INDEX_LINES,
  MAX_INDEX_BYTES,
  MAX_INDEX_SUMMARY_CHARS
} = require("../src/platform/memory/memoryStore");

function makeStore() {
  const root = mkdtempSync(join(tmpdir(), "yaoguo-memdir-"));
  return { root, store: new MemoryStore({ workspaceRoot: root }) };
}

function memory(overrides = {}) {
  const type = overrides.type || "user";
  return {
    type,
    basis: TYPE_BASIS[type],
    topic: "profile",
    name: "用户协作画像",
    description: "用户偏好先看结论，再按需展开证据。",
    content: "用户偏好先看结论，再按需展开证据。",
    valueBeyondCode: "这是用户本人确认的协作偏好，仓库代码无法提供。",
    ...overrides
  };
}

test("空 Memdir 也会落盘 memory.md，并向常驻上下文明确暴露空状态", async () => {
  const { store } = makeStore();
  await store.ensure();
  const info = await store.info();

  assert.equal(await readFile(join(info.memoryDirectory, "memory.md"), "utf8"), "");
  assert.match(await store.indexContext(), /（当前 Memdir 为空）/);
});

test("Memdir 只接受 user、feedback、project、reference 四种封闭类型", async () => {
  const { store } = makeStore();
  await store.append(memory());
  await store.append(memory({
    type: "feedback",
    basis: TYPE_BASIS.feedback,
    topic: "successful-review",
    name: "评审中的成功做法",
    description: "用户确认先列风险证据再给修改建议的评审方式有效。",
    content: "用户确认：先列风险证据再给修改建议，这种评审方式应继续复用。",
    valueBeyondCode: "这是用户对 AI 行为的正向评价。",
    polarity: "positive"
  }));
  await store.append(memory({
    type: "project",
    basis: TYPE_BASIS.project,
    topic: "delivery-goal",
    name: "交付目标",
    description: "设计评审截止日期是 2026-08-21。",
    content: "设计评审截止日期是 2026-08-21。",
    valueBeyondCode: "截止日期来自团队安排，无法从代码推导。"
  }));
  await store.append(memory({
    type: "reference",
    basis: TYPE_BASIS.reference,
    topic: "delivery-issue",
    name: "交付追踪 Issue",
    description: "Linear 的 YG-317 是交付状态的外部事实源。",
    content: "交付状态以 Linear issue YG-317 为准。",
    valueBeyondCode: "外部系统持续更新，Memdir 只需保留入口。",
    reference: "YG-317"
  }));

  assert.deepEqual(MEMORY_TYPES, ["user", "feedback", "project", "reference"]);
  assert.deepEqual((await store.list()).map((item) => item.type).sort(), [...MEMORY_TYPES].sort());
  await assert.rejects(
    store.append(memory({ type: "episodic", basis: "task-log" })),
    (error) => error.code === "MEMDIR_TYPE_INVALID"
  );
  await assert.rejects(
    store.append({ scope: "global", ...memory() }),
    (error) => error.code === "MEMDIR_SCOPE_RETIRED"
  );
});

test("memory.md 是纯索引，正文只存在于带标准 front matter 的主题文件", async () => {
  const { store } = makeStore();
  const saved = await store.append(memory());
  const info = await store.info();
  const index = await readFile(join(info.memoryDirectory, "memory.md"), "utf8");
  const topic = await readFile(join(info.memoryDirectory, saved.file), "utf8");

  assert.equal(index, "[user-profile.md](./user-profile.md) — 用户偏好先看结论，再按需展开证据。\n");
  assert.doesNotMatch(index, /跨会话价值|用户本人确认/);
  assert.match(topic, /^---\nname: "用户协作画像"\ndescription: "用户偏好先看结论，再按需展开证据。"\ntype: user\n/);
  assert.match(topic, /用户偏好先看结论/);
  assert.ok(index.split("\n").filter(Boolean).length <= MAX_INDEX_LINES);
  assert.ok(Buffer.byteLength(index, "utf8") <= MAX_INDEX_BYTES);
});

test("memory.md 恒定上下文只暴露索引，不提前暴露主题正文", async () => {
  const { store } = makeStore();
  await store.append(memory({ content: "只应在 search_memory 后出现的正文密码不是秘密，只是测试哨兵。" }));
  const context = await store.indexContext();
  assert.match(context, /<long-term-memory-index source="memory.md">/);
  assert.match(context, /user-profile\.md/);
  assert.doesNotMatch(context, /测试哨兵/);
  assert.match(context, /search_memory/);
});

test("feedback 同时保存 positive 与 negative，避免只积累错误", async () => {
  const { store } = makeStore();
  await store.append(memory({
    type: "feedback", basis: TYPE_BASIS.feedback, topic: "review-style",
    name: "评审反馈", description: "用户对 AI 评审方式的正负反馈。",
    content: "先引用具体行号再解释风险的做法很好，应继续复用。",
    valueBeyondCode: "用户明确确认了 AI 行为。", polarity: "positive"
  }));
  await store.append(memory({
    type: "feedback", basis: TYPE_BASIS.feedback, topic: "review-style",
    name: "评审反馈", description: "用户对 AI 评审方式的正负反馈。",
    content: "不要在没有证据时猜测根因。",
    valueBeyondCode: "用户明确纠正了 AI 行为。", polarity: "negative"
  }));
  const [topic] = await store.search({ files: ["feedback-review-style.md"] });
  assert.match(topic.content, /反馈方向：\*\* 正向确认/);
  assert.match(topic.content, /反馈方向：\*\* 负向纠正/);
  assert.match(topic.content, /应继续复用/);
  assert.match(topic.content, /不要在没有证据时猜测根因/);
});

test("type 与来源依据必须匹配，feedback 必须声明方向", async () => {
  const { store } = makeStore();
  await assert.rejects(
    store.append(memory({ basis: TYPE_BASIS.project })),
    (error) => error.code === "MEMDIR_BASIS_INVALID"
  );
  await assert.rejects(
    store.append(memory({ type: "feedback", basis: TYPE_BASIS.feedback })),
    (error) => error.code === "MEMDIR_FEEDBACK_POLARITY_REQUIRED"
  );
  await assert.rejects(
    store.append(memory({ polarity: "positive" })),
    (error) => error.code === "MEMDIR_FEEDBACK_POLARITY_INVALID"
  );
});

test("检索拒绝开放类型与路径参数", async () => {
  const { store } = makeStore();
  await store.append(memory());
  await assert.rejects(
    store.search({ types: ["episodic"], query: "用户" }),
    (error) => error.code === "MEMDIR_TYPE_INVALID"
  );
  await assert.rejects(
    store.search({ files: ["../user-profile.md"] }),
    (error) => error.code === "MEMDIR_FILE_INVALID"
  );
});

test("project 相对日期必须绝对化", async () => {
  const { store } = makeStore();
  await assert.rejects(
    store.append(memory({
      type: "project", basis: TYPE_BASIS.project, topic: "deadline",
      content: "设计评审安排在下周五。"
    })),
    (error) => error.code === "MEMDIR_RELATIVE_DATE_REJECTED" && /当前日期/.test(error.message)
  );
  const saved = await store.append(memory({
    type: "project", basis: TYPE_BASIS.project, topic: "deadline",
    content: "设计评审安排在 2026-08-21。"
  }));
  assert.equal(saved.type, "project");
});

test("reference 只接受外部指针，并拒绝本地路径与凭据", async () => {
  const { store } = makeStore();
  const valid = memory({
    type: "reference", basis: TYPE_BASIS.reference, topic: "dashboard",
    reference: "https://grafana.example.com/d/latency",
    content: "延迟数据以该 Grafana 面板为准。"
  });
  assert.equal((await store.append(valid)).reference, valid.reference);
  await assert.rejects(
    store.append({ ...valid, topic: "local", reference: "/tmp/dashboard.json" }),
    (error) => error.code === "MEMDIR_REFERENCE_LOCAL_PATH"
  );
  await assert.rejects(
    store.append({ ...valid, topic: "secret", reference: "https://user:secret@example.com/panel" }),
    (error) => error.code === "MEMDIR_SECRET_REJECTED"
  );
});

test("检索按 query、封闭类型或索引文件选择主题正文", async () => {
  const { store } = makeStore();
  await store.append(memory({ topic: "profile", content: "用户熟悉 Node.js，偏好直接看测试证据。" }));
  await store.append(memory({
    type: "project", basis: TYPE_BASIS.project, topic: "board-review",
    name: "董事会评审", description: "董事会评审只接受有来源的经营数字。",
    content: "董事会评审只接受有来源的经营数字。",
    valueBeyondCode: "这是评审约定，不在代码中。"
  }));

  const queried = await store.search({ query: "董事会 经营数字", limit: 2 });
  assert.equal(queried[0].file, "project-board-review.md");
  const exact = await store.search({ files: ["user-profile.md"], types: ["user"] });
  assert.equal(exact.length, 1);
  assert.match(exact[0].content, /Node\.js/);
});

test("相同条目幂等去重，同一主题的并发写入不丢失", async () => {
  const { store } = makeStore();
  const first = await store.append(memory());
  const duplicate = await store.append(memory());
  assert.equal(first.id, duplicate.id);
  assert.equal(duplicate.deduplicated, true);

  await Promise.all(Array.from({ length: 30 }, (_, index) => store.append(memory({
    topic: "workflow",
    content: `用户确认的稳定工作习惯 ${index}`,
    valueBeyondCode: `第 ${index} 条由用户确认，代码无法提供。`
  }))));
  const [topic] = await store.search({ files: ["user-workflow.md"] });
  for (let index = 0; index < 30; index += 1) {
    assert.match(topic.content, new RegExp(`稳定工作习惯 ${index}(?:\\D|$)`));
  }
});

test("摘要、正文与索引上限是确定值", async () => {
  const { store } = makeStore();
  assert.equal(MAX_INDEX_SUMMARY_CHARS, 150);
  assert.equal(MAX_INDEX_LINES, 200);
  assert.equal(MAX_INDEX_BYTES, 25 * 1024);
  await assert.rejects(
    store.append(memory({ description: "摘".repeat(151) })),
    (error) => error.code === "MEMDIR_DESCRIPTION_INVALID"
  );
  await assert.rejects(
    store.append(memory({ content: "文".repeat(8001) })),
    (error) => error.code === "MEMDIR_CONTENT_INVALID"
  );
});

test("Memdir 拒绝目录、主题文件的符号链接与硬链接", async () => {
  const root = mkdtempSync(join(tmpdir(), "yaoguo-memdir-safety-"));
  const outside = mkdtempSync(join(tmpdir(), "yaoguo-memdir-outside-"));
  const store = new MemoryStore({ workspaceRoot: root });
  const info = await store.info();
  await mkdir(info.baseDirectory || join(root, ".memdir-home"), { recursive: true });
  await symlink(outside, info.memoryDirectory.replace(/\/memory$/, ""));
  await assert.rejects(store.ensure(), (error) => error.code === "MEMDIR_PATH_UNSAFE");

  const cleanRoot = mkdtempSync(join(tmpdir(), "yaoguo-memdir-file-safety-"));
  const cleanStore = new MemoryStore({ workspaceRoot: cleanRoot });
  await cleanStore.ensure();
  const cleanInfo = await cleanStore.info();
  const outsideFile = join(outside, "outside.md");
  await writeFile(outsideFile, "unchanged\n", "utf8");
  await symlink(outsideFile, join(cleanInfo.memoryDirectory, "user-profile.md"));
  await assert.rejects(cleanStore.append(memory()), (error) => error.code === "MEMDIR_FILE_UNSAFE");
  assert.equal(await readFile(outsideFile, "utf8"), "unchanged\n");

  const hardRoot = mkdtempSync(join(tmpdir(), "yaoguo-memdir-hardlink-"));
  const hardStore = new MemoryStore({ workspaceRoot: hardRoot });
  await hardStore.ensure();
  const hardInfo = await hardStore.info();
  await link(outsideFile, join(hardInfo.memoryDirectory, "user-profile.md"));
  await assert.rejects(hardStore.append(memory()), (error) => error.code === "MEMDIR_FILE_UNSAFE");
});

test("无效的同名主题文件不会被覆盖", async () => {
  const { store } = makeStore();
  await store.ensure();
  const info = await store.info();
  const file = join(info.memoryDirectory, "user-profile.md");
  await writeFile(file, "用户手工写入但缺少 front matter 的内容。\n", "utf8");
  await assert.rejects(
    store.append(memory()),
    (error) => error.code === "MEMDIR_TOPIC_INVALID"
  );
  assert.equal(await readFile(file, "utf8"), "用户手工写入但缺少 front matter 的内容。\n");
});
