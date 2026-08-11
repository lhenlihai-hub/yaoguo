import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { validateSkillManifest } = require("../src/platform/skills/skillContract.js");
const { SkillsService } = require("../src/platform/skills/skillsService.js");

function manifestWithAction(action) {
  return {
    kind: "skill",
    id: "skill://path-contract@1",
    version: 1,
    trust: "local-reviewed",
    instructionsRef: "SKILL.md",
    exposure: { mode: "orchestrated", tool: "host" },
    entry: { run: action }
  };
}

function validPathAction() {
  return {
    runtime: "node",
    script: "package.json",
    sideEffects: "workspace_write",
    idempotent: true,
    pathParams: { read: ["source"], write: ["destination", "options.target"] },
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string" },
        destination: { type: "string" },
        options: {
          type: "object",
          properties: { target: { type: "string" } },
          required: ["target"],
          additionalProperties: false
        }
      },
      required: ["source", "destination", "options"],
      additionalProperties: false
    }
  };
}

function makeService(action = validPathAction()) {
  let runs = 0;
  const manifest = manifestWithAction(action);
  const service = new SkillsService({
    skillsRegistry: {
      getById: async () => ({
        id: manifest.id,
        valid: true,
        issues: [],
        dir: root,
        manifest
      })
    },
    dependencyResolver: { resolveAll: async () => [] },
    skillRunner: {
      run: async () => {
        runs += 1;
        return { code: 0, result: { ok: true } };
      }
    }
  });
  return { service, runs: () => runs };
}

test("Skill pathParams 接受 destination/target 点路径并要求 string schema", () => {
  const valid = validateSkillManifest(manifestWithAction(validPathAction()), root);
  assert.equal(valid.ok, true, valid.errors.join("；"));

  const missingContract = validPathAction();
  delete missingContract.pathParams;
  const missing = validateSkillManifest(manifestWithAction(missingContract), root);
  assert.equal(missing.ok, false);
  assert.ok(missing.errors.some((message) => /必须声明 pathParams\.read 与 pathParams\.write/.test(message)));

  const missingWrite = validPathAction();
  missingWrite.pathParams.write = [];
  const incomplete = validateSkillManifest(manifestWithAction(missingWrite), root);
  assert.equal(incomplete.ok, false);
  assert.ok(incomplete.errors.some((message) => /pathParams\.write 不能为空/.test(message)));

  const unknown = validPathAction();
  unknown.pathParams.read = ["missing"];
  const unknownResult = validateSkillManifest(manifestWithAction(unknown), root);
  assert.equal(unknownResult.ok, false);
  assert.ok(unknownResult.errors.some((message) => /未指向 inputSchema 字段：missing/.test(message)));

  const nonString = validPathAction();
  nonString.inputSchema.properties.options.properties.target = { type: "number" };
  const nonStringResult = validateSkillManifest(manifestWithAction(nonString), root);
  assert.equal(nonStringResult.ok, false);
  assert.ok(nonStringResult.errors.some((message) => /必须指向 string schema：options\.target/.test(message)));
});

test("SkillsService 只按显式路径角色分别执行 read/write scope 校验", async () => {
  const { service, runs } = makeService();
  const params = {
    source: join(root, "package.json"),
    destination: join(root, "destination.bin"),
    options: { target: join(root, "target.bin") }
  };

  const unscoped = await service.invoke("skill://path-contract@1", "run", params, {});
  assert.equal(unscoped.error.code, "SCOPE_REQUIRED");

  const sourceOutside = await service.invoke("skill://path-contract@1", "run", {
    ...params,
    source: "/tmp/source.bin"
  }, { readScopeAllow: [root], writeScopeAllow: [root] });
  assert.equal(sourceOutside.error.code, "SCOPE_VIOLATION");
  assert.ok(sourceOutside.error.details.some((message) => /\$\.source.*readScopeAllow/.test(message)));

  const destinationOutside = await service.invoke("skill://path-contract@1", "run", {
    ...params,
    destination: "/tmp/destination.bin"
  }, { readScopeAllow: [root], writeScopeAllow: [root] });
  assert.equal(destinationOutside.error.code, "SCOPE_VIOLATION");
  assert.ok(destinationOutside.error.details.some((message) => /\$\.destination.*writeScopeAllow/.test(message)));

  const targetOutside = await service.invoke("skill://path-contract@1", "run", {
    ...params,
    options: { target: "/tmp/target.bin" }
  }, { readScopeAllow: [root], writeScopeAllow: [root] });
  assert.equal(targetOutside.error.code, "SCOPE_VIOLATION");
  assert.ok(targetOutside.error.details.some((message) => /\$\.options\.target.*writeScopeAllow/.test(message)));

  const allowed = await service.invoke("skill://path-contract@1", "run", params, {
    readScopeAllow: [root],
    writeScopeAllow: [root]
  });
  assert.equal(allowed.ok, true);
  assert.equal(runs(), 1);
});

test("四个 bundled 文档 Skills 均声明完整 pathParams 契约", async () => {
  for (const format of ["docx", "pdf", "pptx", "xlsx"]) {
    const manifest = require(`../workspace/registries/skills/${format}/skill.json`);
    const validation = validateSkillManifest(manifest, join(root, "workspace", "registries", "skills", format));
    assert.equal(validation.ok, true, `${format}: ${validation.errors.join("；")}`);
    for (const [action, definition] of Object.entries(manifest.entry)) {
      assert.ok(Array.isArray(definition.pathParams.read), `${format}.${action} 缺 pathParams.read`);
      assert.ok(Array.isArray(definition.pathParams.write), `${format}.${action} 缺 pathParams.write`);
    }
  }
});
