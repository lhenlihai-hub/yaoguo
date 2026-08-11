// @ts-check

// Agent 工具的单一能力目录。
//
// schema 负责“怎么调用”，这里负责“何时揭示、能否并行、重复调用如何处理、
// 会产生什么副作用”。模型首轮只看到 resident schema；loadable 项只把这份短元数据
// 交给本地检索器，命中后才揭示完整 schema。

const TOOL_CAPABILITY_POLICIES = Object.freeze({
  recall_handoff: policy("run", "read", true, "reuse", ["交接", "决定", "事实", "前序结论", "handoff"], "resident"),
  search_run_artifacts: policy("artifacts", "read", true, "reuse", ["检索产物", "历史成品", "以前的产物", "前文", "artifact"], "resident", {
    intentMode: "artifact_search",
    intentExamples: ["看看以前的成品", "查找历史产物", "搜索旧稿", "读取以前的产物"]
  }),
  read_artifact: policy("artifacts", "read", true, "reuse", ["读取产物", "精读成品", "成品正文", "artifact"], "resident", {
    intentMode: "artifact_read",
    intentExamples: ["打开这个成品", "读取产物正文", "精读这份旧稿"]
  }),
  write_todo: policy("planning", "agent_state_write", false, "reject", ["计划", "待办", "拆解任务", "todo"], "resident"),
  list_todos: policy("planning", "read", true, "reuse", ["查看计划", "待办", "进度", "todo"], "resident"),
  search_memory: policy("memory", "read", true, "reuse", ["记忆", "偏好", "历史要求", "memory"], "resident"),
  pin_memory: policy("memory", "memory_write", false, "reject", ["记住", "沉淀", "保存偏好", "长期记忆", "remember"], "loadable", {
    intentMode: "memory_write",
    intentExamples: ["保存这个习惯", "以后都用短句", "记下这个偏好", "今后保持这个要求"]
  }),
  search_reference: policy("research", "network_read", true, "reuse", ["搜索", "查资料", "核实", "来源", "reference", "search"], "resident", {
    intentMode: "search",
    intentExamples: ["帮我查资料", "搜索新闻", "查证事实", "找可靠来源"]
  }),
  fetch_url: policy("research", "network_read", true, "reuse", ["网页全文", "抓取网址", "精读链接", "fetch", "url"], "resident"),
  search_images: policy("images", "network_read", true, "reuse", ["图片", "配图", "照片", "插图", "图像", "image", "photo"], "loadable", {
    intentMode: "image_search",
    intentExamples: ["搜索开放授权图片", "找一张可以使用的照片", "查找演示配图", "寻找历史图像"]
  }),
  read_reference: policy("research", "network_read", true, "reuse", ["精读资料", "继续阅读", "本地资料", "reference"], "resident"),
  llm_judge_quality: policy("quality", "model_compute", false, "reuse", ["评估", "打分", "检查质量", "要求覆盖", "证据", "一致性", "judge", "quality"], "loadable", {
    intentMode: "judge",
    intentExamples: ["评估这份交付物", "看看结果是否合格", "检查要求覆盖情况", "检查成品质量"],
    excludedPhrases: ["质量事故", "质量新闻", "质量标准"]
  }),
  read_context_result: policy("context", "read", true, "reuse", ["继续读取工具结果", "上下文结果", "result"], "hidden"),
  inspect_artifact: policy(
    "filesystem",
    "read",
    false,
    "rerun",
    ["检查文件", "验收成品", "实际内容", "页数", "工作表", "inspect", "artifact"],
    "resident"
  ),
  publish_artifact: policy(
    "artifacts",
    "workspace_write",
    false,
    "reject",
    ["发布成品", "登记文件", "最终文件", "交付物", "publish", "artifact"],
    "resident"
  ),
  discard_artifact_candidate: policy(
    "artifacts",
    "workspace_write",
    false,
    "reject",
    ["废弃候选", "放弃文件", "不采用", "discard", "candidate"],
    "resident"
  ),
  spawn_subagent: policy("delegation", "model_compute", false, "reject", ["委派", "并行处理", "分头", "子代理", "subagent", "delegate"], "loadable", {
    intentMode: "delegate",
    intentExamples: ["找个人帮我查资料", "让另一个智能体处理", "分派一个代理", "并行处理子任务"],
    excludedPhrases: ["并行世界", "并行宇宙"]
  }),
  load_capability: policy("capabilities", "read", true, "reuse", ["查找能力", "装载工具", "capability"], "resident"),
  run_skill: policy("skills", "workspace_write", false, "reject", ["运行技能", "执行技能", "skill"], "loadable"),
  manage_citations: policy("citations", "agent_state_write", false, "reject", ["管理引用", "添加来源", "标注出处", "参考文献", "citation", "cite"], "loadable", {
    intentMode: "citation_manage",
    intentExamples: ["给报告加引用", "保存这个来源", "整理参考文献", "标注事实出处"]
  })
});

function policy(namespace, effect, parallelSafe, repeat, keywords, tier = "hidden", limits = {}) {
  return Object.freeze({
    namespace,
    effect,
    parallelSafe,
    repeat,
    maxCallsPerLoop: Number(limits.maxCallsPerLoop) > 0 ? Number(limits.maxCallsPerLoop) : null,
    keywords: Object.freeze([...keywords]),
    intentMode: `${limits.intentMode || ""}`,
    intentExamples: Object.freeze([...(limits.intentExamples || [])]),
    excludedPhrases: Object.freeze([...(limits.excludedPhrases || [])]),
    tier
  });
}

const CONSERVATIVE_POLICY = Object.freeze({
  namespace: "uncatalogued",
  effect: "workspace_write",
  parallelSafe: false,
  repeat: "reject",
  maxCallsPerLoop: 1,
  keywords: Object.freeze([]),
  tier: "hidden"
});

function getToolCapabilityPolicy(name = "") {
  return TOOL_CAPABILITY_POLICIES[name] || CONSERVATIVE_POLICY;
}

function resolveToolCapabilityPolicy(name = "", args = {}, basePolicy = null) {
  const policy = basePolicy || getToolCapabilityPolicy(name);
  const localOnly = (
    (name === "search_reference" && `${args?.scope || "all"}` === "local")
    || (name === "read_reference" && !`${args?.url || ""}`.trim())
  );
  if (!localOnly || policy.effect === "read") return policy;
  return { ...policy, effect: "read", effects: ["read"] };
}

function listAgentToolNames(tier) {
  return Object.entries(TOOL_CAPABILITY_POLICIES)
    .filter(([, value]) => value.tier === tier)
    .map(([name]) => name);
}

function buildToolCapabilityCatalog(registry, names = [], ctx = null) {
  return names
    .filter((name) => registry?.has?.(name) && (!ctx || isToolAvailable(name, ctx)))
    .map((name) => {
      const tool = registry.get(name);
      const rule = getToolCapabilityPolicy(name);
      return {
        id: `tool://${name}`,
        kind: "tool",
        name,
        title: name,
        description: `${tool?.schema?.function?.description || ""}`,
        namespace: rule.namespace,
        effect: rule.effect,
        keywords: [...rule.keywords],
        intentMode: rule.intentMode,
        intentExamples: [...rule.intentExamples],
        excludedPhrases: [...rule.excludedPhrases],
        mountTools: [name],
        available: true
      };
    });
}

function isToolAvailable(name, ctx = {}) {
  if (["read_context_result", "load_capability"].includes(name)) return true;
  if (["recall_handoff"].includes(name)) return Boolean(ctx.checkpointStore && ctx.handoffDir);
  if (["write_todo", "list_todos"].includes(name)) return Boolean(ctx.todoStore && ctx.todoDir);
  if (["search_memory", "pin_memory"].includes(name)) return Boolean(ctx.memoryStore);
  if (name === "search_reference") return Boolean(ctx.referenceService);
  if (name === "fetch_url") return Boolean(ctx.webSearchService);
  if (name === "search_images") return true;
  if (name === "read_reference") return Boolean(ctx.referenceService || ctx.projectService);
  if (["search_run_artifacts", "read_artifact"].includes(name)) return Boolean(ctx.artifactStore);
  if (name === "llm_judge_quality") return Boolean(ctx.aiRouter);
  if (name === "spawn_subagent") return Boolean(ctx.aiRouter && ctx.registry);
  if (name === "manage_citations") return Boolean(ctx.projectService && ctx.projectId && ctx.taskId);
  if (name === "run_skill") return Boolean(ctx.skillsService);
  if (["inspect_artifact", "publish_artifact", "discard_artifact_candidate"].includes(name)) {
    return Boolean(ctx.agentWorkDir || ctx.taskDir);
  }
  return false;
}

module.exports = {
  TOOL_CAPABILITY_POLICIES,
  getToolCapabilityPolicy,
  resolveToolCapabilityPolicy,
  listAgentToolNames,
  buildToolCapabilityCatalog,
  isToolAvailable
};
