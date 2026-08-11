// Tier B：把引用管理能力提成 Agent 按需工具。

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { executeManageCitations } = require("../src/platform/ai/agentTools/manageCitationsTool.js");
const { createAgentToolRegistry } = require("../src/platform/ai/agentTools/index.js");
const { observeReferenceUrl } = require("../src/platform/ai/agentTools/referenceObservation.js");

test("createAgentToolRegistry 含 Tier B 工具", () => {
  const reg = createAgentToolRegistry();
  assert.ok(reg.has("manage_citations"));
});

test("manage_citations：只保存真实观察到的来源，并拒绝缺失或臆造 URL", async () => {
  const store = [];
  const ps = {
    listReferences: async () => store,
    addReference: async (pid, tid, ref) => { const saved = { id: "r1", title: ref.title, url: ref.url }; store.push(saved); return saved; }
  };
  const ctx = { projectService: ps, projectId: "p1", taskId: "t1" };
  observeReferenceUrl(ctx, { title: "公告", url: "https://gov.cn/a" });
  const added = await executeManageCitations({ action: "add", reference: { url: "https://gov.cn/a" } }, ctx);
  assert.equal(added.ok, true);
  assert.equal(added.reference.url, "https://gov.cn/a");
  const list = await executeManageCitations({ action: "list" }, ctx);
  assert.equal(list.count, 1);
  const invented = await executeManageCitations({ action: "add", reference: { url: "https://example.com/invented" } }, ctx);
  assert.equal(invented.ok, false);
  assert.equal(invented.code, "CITATION_NOT_OBSERVED");
  const bad = await executeManageCitations({ action: "add", reference: {} }, ctx);
  assert.equal(bad.ok, false);
});

test("Tier B 工具缺服务/缺上下文时返回 ok:false，不抛", async () => {
  assert.equal((await executeManageCitations({ action: "list" }, { projectService: { listReferences: async () => [] }, projectId: "p1" })).ok, false);
});
