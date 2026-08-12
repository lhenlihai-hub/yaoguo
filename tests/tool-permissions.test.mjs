import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const {
  SettingsService,
  mergeSettings
} = require("../src/platform/config/settingsService.js");
const {
  MAX_PERMISSION_TARGET_CHARS,
  ToolPermissionService,
  buildEffectGrantKey,
  describeToolPermission,
  describeToolPermissions
} = require("../src/platform/permissions/toolPermissionService.js");
const {
  BASE_TOOL_POLICIES
} = require("../src/platform/ai/agentLoop/scopedTools.js");
const {
  getToolCapabilityPolicy,
  resolveToolCapabilityPolicy
} = require("../src/platform/ai/agentTools/toolCapabilityPolicy.js");

function toolInput(name, args, effect, context = {}) {
  return {
    name,
    args,
    policy: { effect },
    context: {
      projectId: "project-1",
      taskId: "task-1",
      turnId: "turn-1",
      ...context
    }
  };
}

test("权限设置只有全局模式和按 effect 持久化的通用规则", () => {
  const defaults = mergeSettings({});
  assert.deepEqual(defaults.permissions.agent, { mode: "ask", rules: {} });
  const migrated = mergeSettings({
    permissions: {
      tools: { webRead: "allow", shell: "deny" },
      agent: {
        mode: "invalid",
        rules: {
          workspace_write: "allow",
          command_execute: "deny",
          "Invalid Effect": "allow",
          network_read: "invalid"
        }
      }
    }
  });
  assert.deepEqual(migrated.permissions.agent, {
    mode: "ask",
    rules: {
      workspace_write: "allow",
      command_execute: "deny",
      network_read: "ask"
    }
  });
  assert.equal(migrated.permissions.tools, undefined);
});

test("SettingsService 设置全局模式、effect 规则并可一次清空", async () => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "yaoguo-tool-permission-settings-"));
  const paths = {
    configDir: path.join(projectRoot, "config"),
    settingsFile: path.join(projectRoot, "config/settings.json"),
    settingsLocalFile: path.join(projectRoot, "config/settings.local.json")
  };
  try {
    const service = new SettingsService(paths);
    const allowed = await service.setAgentPermissionMode("allow");
    assert.equal(allowed.permissions.agent.mode, "allow");
    const ruled = await service.setToolPermissionRule("command_execute", "deny");
    assert.equal(ruled.permissions.agent.rules.command_execute, "deny");
    await assert.rejects(
      service.setToolPermissionRule("Command Execute", "allow"),
      /effect 必须是小写标识符/
    );
    const cleared = await service.clearToolPermissionRules();
    assert.deepEqual(cleared.permissions.agent.rules, {});
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("Pi 基础工具通过 effect 进入同一授权链", () => {
  assert.equal(BASE_TOOL_POLICIES.read.effect, "read");
  assert.equal(BASE_TOOL_POLICIES.write.effect, "workspace_write");
  assert.equal(BASE_TOOL_POLICIES.edit.effect, "workspace_write");
  assert.equal(BASE_TOOL_POLICIES.bash.effect, "command_execute");
  assert.equal(describeToolPermission(toolInput("read", { path: "draft.md" }, "read")), null);
  assert.equal(
    describeToolPermission(toolInput("write", { path: "draft.md" }, "workspace_write")).effect,
    "workspace_write"
  );
  assert.equal(
    describeToolPermission(toolInput("bash", { command: "open https://example.com" }, "command_execute")).effect,
    "command_execute"
  );
  assert.equal(
    describeToolPermission(toolInput("fetch_url", { url: "https://example.com" }, "network_read")).effect,
    "network_read"
  );
});

test("本地路径打开使用独立授权 effect，并展示规范绝对路径", () => {
  const permission = describeToolPermission(toolInput(
    "open_local_path",
    { path: "reports" },
    "local_open",
    { agentWorkDir: "/tmp/work" }
  ));
  assert.equal(permission.effect, "local_open");
  assert.equal(permission.resourceKind, "path");
  assert.equal(permission.target, "/tmp/work/reports");
  assert.match(permission.summary, /系统应用打开本地文件或文件夹/);
});

test("本地参考读取保持安全 read，只有真实联网参数请求 network_read", () => {
  const searchPolicy = getToolCapabilityPolicy("search_reference");
  const readPolicy = getToolCapabilityPolicy("read_reference");
  assert.equal(resolveToolCapabilityPolicy("search_reference", { scope: "local" }, searchPolicy).effect, "read");
  assert.equal(resolveToolCapabilityPolicy("search_reference", { scope: "all" }, searchPolicy).effect, "network_read");
  assert.equal(resolveToolCapabilityPolicy("read_reference", { path: "/tmp/reference.md" }, readPolicy).effect, "read");
  assert.equal(resolveToolCapabilityPolicy("read_reference", { referenceId: "ref-1" }, readPolicy).effect, "read");
  assert.equal(resolveToolCapabilityPolicy("read_reference", { url: "https://example.com" }, readPolicy).effect, "network_read");
});

test("长期记忆写入不是安全内部状态，必须经过独立授权边界", () => {
  const policy = getToolCapabilityPolicy("pin_memory");
  assert.equal(policy.effect, "memory_write");
  const request = describeToolPermission(toolInput("pin_memory", {
    type: "user",
    basis: "user-stated-profile",
    topic: "answer-style",
    description: "用户偏好所有报告先给结论。",
    content: "所有报告先给结论",
    valueBeyondCode: "这是用户确认的跨会话协作偏好。"
  }, policy.effect));
  assert.equal(request.effect, "memory_write");
  assert.equal(request.resourceKind, "long_term_memory");
  assert.match(request.summary, /长期记忆/);
  assert.match(request.target, /类型：user/);
  assert.match(request.target, /主题：answer-style/);
  assert.match(request.target, /所有报告先给结论/);
  assert.match(request.boundary, /canonical workspace/);
  assert.match(request.boundary, /四种封闭类型/);
});

test("精确工作区授权包含操作族，普通写入不能授权生成或发布", async () => {
  const workDir = path.join(tmpdir(), "yaoguo-permission-operation-work");
  const taskDir = path.join(tmpdir(), "yaoguo-permission-operation-task");
  const context = { agentWorkDir: workDir, taskDir };
  const write = toolInput("write", { path: "report.html", content: "draft" }, "workspace_write", context);
  const edit = toolInput("edit", { path: "report.html", oldText: "draft", newText: "final" }, "workspace_write", context);
  const visual = toolInput("generate_visual", {
    path: "report.html",
    medium: "report"
  }, "workspace_write", context);
  const publish = toolInput("publish_artifact", {
    path: "report.html",
    inspectionId: "inspection_1234567890abcdef12345678"
  }, "workspace_write", context);

  const writeRequest = describeToolPermission(write);
  const editRequest = describeToolPermission(edit);
  const visualRequest = describeToolPermission(visual);
  const publishRequest = describeToolPermission(publish);
  assert.equal(writeRequest.grantKey, editRequest.grantKey, "write/edit 可共享同一路径的内容修改能力");
  assert.notEqual(writeRequest.grantKey, visualRequest.grantKey);
  assert.notEqual(writeRequest.grantKey, publishRequest.grantKey);
  assert.notEqual(visualRequest.grantKey, publishRequest.grantKey);

  let prompts = 0;
  const service = new ToolPermissionService({
    settingsService: {
      get: async () => ({ permissions: { agent: { mode: "ask", rules: {} } } })
    },
    requestApproval: async () => {
      prompts += 1;
      return { decision: "allow_session" };
    }
  });
  assert.equal((await service.authorize(write)).source, "allow_session");
  assert.equal((await service.authorize(edit)).source, "session");
  assert.equal((await service.authorize(visual)).source, "allow_session");
  assert.equal((await service.authorize(publish)).source, "allow_session");
  assert.equal(prompts, 3, "普通写入、视觉生成和发布必须分别获得精确授权");
});

test("发布授权卡片显示已检查来源到受管 final 的实际边界", () => {
  const workDir = path.join(tmpdir(), "yaoguo-publish-source");
  const taskDir = path.join(tmpdir(), "yaoguo-publish-task");
  const externalDir = path.join(tmpdir(), "yaoguo-publish-user-output");
  const request = describeToolPermission(toolInput("publish_artifact", {
    path: "report.md",
    inspectionId: "inspection_1234567890abcdef12345678",
    title: "季度报告"
  }, "workspace_write", {
    agentWorkDir: workDir,
    taskDir,
    explicitOutputTargets: [{ path: externalDir, kind: "directory" }]
  }));

  assert.equal(request.resourceKind, "artifact_publish");
  assert.match(request.summary, /保留受管成品.*用户明确指定的位置/);
  assert.match(request.target, /已检查来源：/);
  assert.match(request.target, /→ 受管最终成品：/);
  assert.ok(request.target.includes(path.join(workDir, "report.md")));
  assert.ok(request.target.includes(path.join(taskDir, "final", "report.md")));
  assert.ok(request.target.includes(path.join(externalDir, "report.md")));
  assert.match(request.target, /同名时创建新版本/);
  assert.match(request.boundary, /普通文件修改授权不包含生成、发布或废弃/);
});

test("发布授权卡片显示制作区来源与绑定工作空间的自动交付", () => {
  const taskDir = path.join(tmpdir(), "yaoguo-publish-default-task");
  const artifactWorkDir = path.join(taskDir, ".candidates");
  const workspaceDir = path.join(tmpdir(), "yaoguo-publish-bound-workspace");
  const request = describeToolPermission(toolInput("publish_artifact", {
    path: "course.pptx",
    inspectionId: "inspection_1234567890abcdef12345678",
    title: "公开课课件"
  }, "workspace_write", {
    agentWorkDir: workspaceDir,
    artifactWorkDir,
    defaultArtifactDestination: workspaceDir,
    taskDir
  }));

  assert.match(request.summary, /绑定的用户工作空间/);
  assert.ok(request.target.includes(path.join(artifactWorkDir, "course.pptx")));
  assert.ok(request.target.includes(path.join(taskDir, "final", "course.pptx")));
  assert.ok(request.target.includes(path.join(workspaceDir, "course.pptx")));
});

test("生成工具展示来源与候选输出，精确摘要覆盖真实生成语义且不泄露正文", () => {
  const workDir = path.join(tmpdir(), "yaoguo-generation-work");
  const taskDir = path.join(tmpdir(), "yaoguo-generation-task");
  const visual = describeToolPermission(toolInput("generate_visual", {
    path: "slides.html",
    medium: "deck",
    title: "产品计划",
    exportPdf: true
  }, "workspace_write", { agentWorkDir: workDir, taskDir }));
  assert.equal(visual.resourceKind, "visual_generation");
  assert.match(visual.summary, /验收 HTML.*生成视觉候选/);
  assert.ok(visual.target.includes(path.join(workDir, "slides.html")));
  assert.ok(visual.target.includes(path.join(workDir, "产品计划.pdf")));
  assert.match(visual.target, /写回已本地化的远程图片/);

  const document = describeToolPermission(toolInput("generate_document", {
    format: "pdf",
    source: "prepared_content",
    content: "不得出现在授权界面的私密正文",
    title: "董事会报告"
  }, "workspace_write", { agentWorkDir: workDir, taskDir }));
  assert.equal(document.resourceKind, "document_generation");
  assert.match(document.summary, /生成 PDF 候选文件/);
  assert.match(document.target, /Agent 已准备正文/);
  assert.ok(document.target.includes(path.join(workDir, "董事会报告.pdf")));
  assert.match(document.target, /安全降级的 DOCX/);
  assert.equal(document.target.includes("不得出现在授权界面的私密正文"), false);
  assert.equal(document.summary.includes("不得出现在授权界面的私密正文"), false);
});

test("生成授权卡把视觉与文档候选定位到内部制作区", () => {
  const workDir = path.join(tmpdir(), "yaoguo-generation-project-zone");
  const artifactWorkDir = path.join(tmpdir(), "yaoguo-generation-artifact-zone");
  const context = { agentWorkDir: workDir, artifactWorkDir };
  const visual = describeToolPermission(toolInput("generate_visual", {
    path: "slides.html",
    medium: "deck"
  }, "workspace_write", context));
  const document = describeToolPermission(toolInput("generate_document", {
    format: "pptx",
    source: "prepared_content",
    content: "# 课件"
  }, "workspace_write", context));

  assert.ok(visual.target.includes(path.join(artifactWorkDir, "slides.html")));
  assert.ok(document.target.includes(artifactWorkDir));
  assert.equal(visual.target.includes(path.join(workDir, "slides.html")), false);
});

test("单次、会话和永久授权都只复用精确资源", async () => {
  const agent = { mode: "ask", rules: {} };
  const settingsService = {
    get: async () => ({ permissions: { agent: structuredClone(agent) } }),
    setToolPermissionRule: async (effect, mode) => { agent.rules[effect] = mode; }
  };
  const decisions = ["allow_once", "allow_session", "allow_always", "allow_once"];
  const requests = [];
  let prompts = 0;
  const service = new ToolPermissionService({
    settingsService,
    requestApproval: async (request) => {
      requests.push(request);
      return { decision: decisions[prompts++] };
    }
  });
  const write = toolInput("write", { path: "a.md" }, "workspace_write");
  assert.equal((await service.authorize(write)).allow, true);
  assert.equal((await service.authorize(write)).allow, true);
  assert.equal(prompts, 2, "允许一次后应再次询问");
  assert.equal((await service.authorize(write)).source, "session");
  assert.equal(prompts, 2, "会话授权应复用相同路径");

  const edit = toolInput("edit", { path: "b.md" }, "workspace_write");
  assert.equal((await service.authorize(edit)).source, "allow_always");
  assert.equal(prompts, 3);
  assert.equal((await service.authorize(edit)).source, "settings");
  assert.equal(Object.keys(agent.rules).length, 1);
  assert.match(Object.keys(agent.rules)[0], /^grant_workspace_write_[a-f0-9]{32}$/);

  const other = toolInput("edit", { path: "c.md" }, "workspace_write");
  assert.equal((await service.authorize(other)).source, "allow_once");
  assert.equal(prompts, 4, "精确永久授权不应扩展到其他路径");
  assert.notEqual(requests[2].grantKey, requests[3].grantKey);
});

test("清除授权会同步撤销进程内的本次任务 grant", async () => {
  let prompts = 0;
  const service = new ToolPermissionService({
    settingsService: {
      get: async () => ({ permissions: { agent: { mode: "ask", rules: {} } } })
    },
    requestApproval: async () => {
      prompts += 1;
      return { decision: "allow_session" };
    }
  });
  const input = toolInput("write", { path: "session.md" }, "workspace_write");
  assert.equal((await service.authorize(input)).source, "allow_session");
  assert.equal((await service.authorize(input)).source, "session");
  assert.equal(prompts, 1);

  service.clearSessionGrants();

  assert.equal((await service.authorize(input)).source, "allow_session");
  assert.equal(prompts, 2);
});

test("复合工具逐项授权，Agent 内部状态写入不等于文件写入", async () => {
  const effects = [];
  const service = new ToolPermissionService({
    settingsService: {
      get: async () => ({ permissions: { agent: { mode: "ask", rules: {} } } })
    },
    requestApproval: async (request) => {
      effects.push(request.effect);
      return { decision: "allow_once" };
    }
  });
  const composite = await service.authorize({
    ...toolInput("sync_remote_file", {
      url: "https://8.8.8.8/page.html",
      path: "final/page.html"
    }, "workspace_write"),
    policy: { effect: "workspace_write", effects: ["network_read", "workspace_write"] }
  });
  assert.equal(composite.allow, true);
  assert.deepEqual(effects, ["network_read", "workspace_write"]);

  const stateWrite = await service.authorize(toolInput(
    "write_todo",
    { action: "create", text: "私密待办" },
    "agent_state_write"
  ));
  assert.equal(stateWrite.source, "safe_effect");
  assert.equal(effects.length, 2);
  assert.equal(describeToolPermission(toolInput("write_todo", {}, "agent_state_write")), null);
  assert.equal(describeToolPermissions({
    ...toolInput("x", {}, "workspace_write"),
    policy: { effects: ["read", "workspace_write", "network_read"] }
  }).length, 2);
  assert.ok(describeToolPermission(
    toolInput("write", { path: "a.md" }, "workspace_write")
  ).allowedDecisions.includes("allow_effect"));
});

test("无权威路径的交付输入按完整参数生成精确授权，但界面不泄露正文", () => {
  const first = describeToolPermission(toolInput("generate_document", {
    format: "pdf",
    source: "prepared_content",
    content: "第一份私密正文"
  }, "workspace_write"));
  const second = describeToolPermission(toolInput("generate_document", {
    format: "pdf",
    source: "prepared_content",
    content: "第二份私密正文"
  }, "workspace_write"));

  assert.notEqual(first.grantKey, second.grantKey);
  assert.equal(first.target.includes("第一份私密正文"), false);
  assert.equal(first.target.includes('"content"'), false);
  assert.match(first.boundary, /该类型全部允许/);
});

test("该类型全部同意持久为显式 effect grant，新 Service 实例可复用", async () => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "yaoguo-effect-permission-"));
  const paths = {
    configDir: path.join(projectRoot, "config"),
    settingsFile: path.join(projectRoot, "config/settings.json"),
    settingsLocalFile: path.join(projectRoot, "config/settings.local.json")
  };
  try {
    const firstSettings = new SettingsService(paths);
    const first = new ToolPermissionService({
      settingsService: firstSettings,
      requestApproval: async () => ({ decision: "allow_effect" })
    });
    const initial = await first.authorize(
      toolInput("write", { path: "first.md" }, "workspace_write")
    );
    assert.equal(initial.source, "allow_effect");

    let prompts = 0;
    const second = new ToolPermissionService({
      settingsService: new SettingsService(paths),
      requestApproval: async () => {
        prompts += 1;
        return { decision: "deny" };
      }
    });
    const reused = await second.authorize(
      toolInput("edit", { path: "different.md" }, "workspace_write")
    );
    assert.equal(reused.source, "settings");
    assert.equal(prompts, 0);
    const stored = await second.settingsService.get();
    assert.equal(stored.permissions.agent.rules[buildEffectGrantKey("workspace_write")], "allow");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("同一 effect 的并发请求只显示一次类型授权", async () => {
  const agent = { mode: "ask", rules: {} };
  let prompts = 0;
  const service = new ToolPermissionService({
    settingsService: {
      get: async () => ({ permissions: { agent: structuredClone(agent) } }),
      setToolPermissionRule: async (key, mode) => {
        await new Promise((resolve) => setImmediate(resolve));
        agent.rules[key] = mode;
      }
    },
    requestApproval: async () => {
      prompts += 1;
      return { decision: "allow_effect" };
    }
  });
  const results = await Promise.all([
    service.authorize(toolInput("write", { path: "a.md" }, "workspace_write")),
    service.authorize(toolInput("edit", { path: "b.md" }, "workspace_write"))
  ]);
  assert.equal(prompts, 1);
  assert.deepEqual(results.map((result) => result.source).sort(), ["allow_effect", "settings"]);
});

test("不同 ToolPermissionService 与 SettingsService 实例并发写入不丢 effect grant", async () => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "yaoguo-effect-permission-race-"));
  const paths = {
    configDir: path.join(projectRoot, "config"),
    settingsFile: path.join(projectRoot, "config/settings.json"),
    settingsLocalFile: path.join(projectRoot, "config/settings.local.json")
  };
  try {
    const createService = () => new ToolPermissionService({
      settingsService: new SettingsService(paths),
      requestApproval: async () => ({ decision: "allow_effect" })
    });
    await Promise.all([
      createService().authorize(toolInput("write", { path: "a.md" }, "workspace_write")),
      createService().authorize(toolInput("bash", { command: "npm test" }, "command_execute"))
    ]);
    const stored = await new SettingsService(paths).get();
    assert.equal(stored.permissions.agent.rules[buildEffectGrantKey("workspace_write")], "allow");
    assert.equal(stored.permissions.agent.rules[buildEffectGrantKey("command_execute")], "allow");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("命令与网址授权显示完整精确目标，持久化键仍只保存摘要", () => {
  const command = `printf '${"x".repeat(3500)}'`;
  const commandRequest = describeToolPermission(toolInput(
    "bash",
    { command },
    "command_execute"
  ));
  assert.equal(commandRequest.target, command);
  assert.ok(commandRequest.target.length < MAX_PERMISSION_TARGET_CHARS);

  const first = describeToolPermission(toolInput(
    "fetch_url",
    { url: "https://example.com/report?token=secret-a" },
    "network_read"
  ));
  const second = describeToolPermission(toolInput(
    "fetch_url",
    { url: "https://example.com/report?token=secret-b" },
    "network_read"
  ));
  assert.equal(first.target, "https://example.com/report?token=secret-a");
  assert.notEqual(first.grantKey, second.grantKey, "精确授权仍应区分不同查询");
});

test("打开外部网页复用统一授权范围，类型授权可覆盖其他公开网址", async () => {
  const agent = { mode: "ask", rules: {} };
  const requests = [];
  const service = new ToolPermissionService({
    settingsService: {
      get: async () => ({ permissions: { agent: structuredClone(agent) } }),
      setToolPermissionRule: async (key, mode) => { agent.rules[key] = mode; }
    },
    requestApproval: async (value) => {
      requests.push(value);
      return { decision: "allow_effect" };
    }
  });
  const first = await service.authorize(toolInput(
    "bash",
    { command: "open https://example.com/start?mode=review" },
    "external_open"
  ));
  assert.equal(first.source, "allow_effect");
  assert.deepEqual(requests[0].allowedDecisions, [
    "deny", "allow_once", "allow_session", "allow_always", "allow_effect"
  ]);
  assert.equal(requests[0].target, "https://example.com/start?mode=review");
  const second = await service.authorize(toolInput(
    "bash",
    { command: "open https://openai.com/" },
    "external_open"
  ));
  assert.equal(second.source, "settings");
  assert.equal(requests.length, 1);
});

test("打开外部网页服从全局自动允许设置", async () => {
  let prompts = 0;
  const service = new ToolPermissionService({
    settingsService: {
      get: async () => ({
        permissions: {
          agent: {
            mode: "allow",
            rules: {
              external_open: "allow",
              [buildEffectGrantKey("external_open")]: "allow"
            }
          }
        }
      })
    },
    requestApproval: async () => {
      prompts += 1;
      return { decision: "deny" };
    }
  });
  const input = toolInput(
    "bash",
    { command: "open https://example.com" },
    "external_open"
  );
  assert.equal((await service.authorize(input)).source, "settings");
  assert.equal((await service.authorize(input)).source, "settings");
  assert.equal(prompts, 0);
});

test("旧版 effect 级 allow 不再横向放行，deny 仍以失败关闭兼容", async () => {
  let prompts = 0;
  const legacyAllow = new ToolPermissionService({
    settingsService: {
      get: async () => ({
        permissions: { agent: { mode: "ask", rules: { workspace_write: "allow" } } }
      })
    },
    requestApproval: async () => {
      prompts += 1;
      return { decision: "allow_once" };
    }
  });
  assert.equal((await legacyAllow.authorize(
    toolInput("write", { path: "new.md" }, "workspace_write")
  )).allow, true);
  assert.equal(prompts, 1);

  const legacyDeny = new ToolPermissionService({
    settingsService: {
      get: async () => ({
        permissions: { agent: { mode: "ask", rules: { command_execute: "deny" } } }
      })
    }
  });
  assert.equal((await legacyDeny.authorize(
    toolInput("bash", { command: "npm test" }, "command_execute")
  )).allow, false);
});

test("全局拒绝和无交互宿主都以失败关闭，安全读取不受影响", async () => {
  const denied = new ToolPermissionService({
    settingsService: {
      get: async () => ({ permissions: { agent: { mode: "deny", rules: {} } } })
    }
  });
  assert.equal(
    (await denied.authorize(toolInput("read", { path: "a.md" }, "read"))).allow,
    true
  );
  const deniedResult = await denied.authorize(
    toolInput("bash", { command: "npm test" }, "command_execute")
  );
  assert.equal(deniedResult.allow, false);
  assert.equal(deniedResult.code, "TOOL_PERMISSION_DENIED");

  const unavailable = new ToolPermissionService({
    settingsService: {
      get: async () => ({ permissions: { agent: { mode: "ask", rules: {} } } })
    }
  });
  const unavailableResult = await unavailable.authorize(
    toolInput("write", { path: "a.md" }, "workspace_write")
  );
  assert.equal(unavailableResult.allow, false);
  assert.equal(unavailableResult.code, "TOOL_APPROVAL_REQUIRED");
});

test("任务停止会在显示授权请求前取消等待", async () => {
  let prompts = 0;
  const controller = new AbortController();
  controller.abort();
  const service = new ToolPermissionService({
    settingsService: {
      get: async () => ({ permissions: { agent: { mode: "ask", rules: {} } } })
    },
    requestApproval: async () => {
      prompts += 1;
      return { decision: "allow_once" };
    }
  });
  const result = await service.authorize({
    ...toolInput("bash", { command: "npm test" }, "command_execute"),
    signal: controller.signal
  });
  assert.equal(result.allow, false);
  assert.equal(result.source, undefined);
  assert.equal(prompts, 0);
});

test("授权卡显示后停止任务会立即拒绝且不会留下会话授权", async () => {
  const controller = new AbortController();
  let resolveApproval;
  let notifyShown;
  let prompts = 0;
  const shown = new Promise((resolve) => { notifyShown = resolve; });
  const service = new ToolPermissionService({
    settingsService: {
      get: async () => ({ permissions: { agent: { mode: "ask", rules: {} } } })
    },
    requestApproval: async () => {
      prompts += 1;
      if (prompts === 1) {
        notifyShown();
        return new Promise((resolve) => { resolveApproval = resolve; });
      }
      return { decision: "allow_session" };
    }
  });
  const input = toolInput("write", { path: "cancelled.md" }, "workspace_write");
  const pending = service.authorize({ ...input, signal: controller.signal });
  await shown;
  controller.abort(new Error("用户停止任务"));
  const result = await pending;
  assert.equal(result.allow, false);
  assert.equal(result.code, "TOOL_APPROVAL_REQUIRED");
  assert.equal(prompts, 1);

  resolveApproval({ decision: "allow_session" });
  const retry = await service.authorize(input);
  assert.equal(retry.source, "allow_session");
  assert.equal(prompts, 2, "已取消的授权响应不得在后台转化成会话授权");
});

test("本次任务授权严格隔离 project 和 task", async () => {
  let prompts = 0;
  const service = new ToolPermissionService({
    settingsService: {
      get: async () => ({ permissions: { agent: { mode: "ask", rules: {} } } })
    },
    requestApproval: async () => {
      prompts += 1;
      return { decision: "allow_session" };
    }
  });
  const firstTask = toolInput(
    "write",
    { path: "shared-name.md" },
    "workspace_write",
    { projectId: "project-a", taskId: "task-a", turnId: "turn-a" }
  );
  const secondTask = toolInput(
    "write",
    { path: "shared-name.md" },
    "workspace_write",
    { projectId: "project-a", taskId: "task-b", turnId: "turn-b" }
  );
  const secondProject = toolInput(
    "write",
    { path: "shared-name.md" },
    "workspace_write",
    { projectId: "project-b", taskId: "task-a", turnId: "turn-c" }
  );

  assert.equal((await service.authorize(firstTask)).source, "allow_session");
  assert.equal((await service.authorize(firstTask)).source, "session");
  assert.equal((await service.authorize(secondTask)).source, "allow_session");
  assert.equal((await service.authorize(secondProject)).source, "allow_session");
  assert.equal(prompts, 3);
});
