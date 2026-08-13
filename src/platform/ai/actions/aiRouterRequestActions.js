const {
  truncate,
  estimateTokens,
  legacyCharsToTokens,
  truncateForPromptTokens,
  sanitizePromptForContentFilter,
  redactSensitive,
  sleep
} = require("../../runtime");
const { estimateRequestTokens } = require("../../tokens/tokenEstimator");
const { dedupeContextSections } = require("../../context/contextDeduper");
const {
  compileSystemPromptSections,
  buildRuntimeContextSection,
  getOutputStylePrompt
} = require("../prompts");

function normalizeConversationMessages(messages = []) {
  return (Array.isArray(messages) ? messages : [])
    .map((message) => ({
      role: message?.role === "assistant" ? "assistant" : "user",
      content: `${message?.content || ""}`.trim(),
      ...(message?.modelReady === true ? { modelReady: true } : {})
    }))
    .filter((message) => message.content);
}

module.exports = {
  isTransientModelError(error) {
    const message = `${error?.message || error || ""}`.toLowerCase();
    return /429|rate.?limit|too many requests|overload|engine_overloaded|try again later|timeout|temporarily unavailable|service unavailable|503|504|系统繁忙|服务繁忙|限流|稍后重试/.test(message);
  },

  buildTaskContextMessage({ runContext, pinnedSections, runtimeContext = "", budget }) {
    const candidates = [
      ...(pinnedSections || []).map((content, index) => ({ key: `pinned:${index}`, kind: "pinned", content, priority: 90, protected: true })),
      { key: "runContext", kind: "runContext", content: truncateForPromptTokens(runContext || "", budget.runContextTokens), priority: 75 }
    ];
    const selected = dedupeContextSections(candidates).included;
    const selectedByKey = new Map(selected.map((section) => [section.key, section]));
    const parts = [];
    for (const section of selected.filter((item) => item.kind === "pinned")) parts.push(section.content);
    const selectedRunContext = selectedByKey.get("runContext")?.content || "";
    if (selectedRunContext) parts.push("【运行上下文】", selectedRunContext);
    if (`${runtimeContext || ""}`.trim()) parts.push("【运行环境】", `${runtimeContext}`.trim());
    return parts.join("\n").trim();
  },

  buildTaskUserMessage({
    taskType, title, instruction, input, context = "", budget,
    instructionPlacement = "before-input"
  }) {
    const placeAfterInput = instructionPlacement === "after-input";
    return [
      ...(context ? ["【本轮上下文】", context, ""] : []),
      `【当前步骤】${title}（${taskType}）`,
      "",
      ...(!placeAfterInput ? ["【步骤要求】", instruction || "完成当前用户请求。", ""] : []),
      "【输入】",
      truncateForPromptTokens(input || "无", budget.inputTokens),
      ...(placeAfterInput ? ["", "【末尾操作指令】", instruction || "完成当前用户请求。"] : [])
    ].join("\n");
  },

  async loadTaskContextSections({
    contentFilterSafe, instruction, input, runContext, pinnedSections,
    conversationMessages, instructionReminder, internalCall = false
  }) {
    let safeInstruction = instruction;
    let safeInput = input;
    let safeRunContext = runContext;
    let safeInstructionReminder = internalCall ? "" : `${instructionReminder || ""}`.trim();
    let safePinnedSections = (Array.isArray(pinnedSections) ? pinnedSections : [pinnedSections])
      .map((section) => `${section || ""}`.trim())
      .filter(Boolean);
    let safeConversationMessages = normalizeConversationMessages(conversationMessages);
    if (contentFilterSafe) {
      safeInstruction = sanitizePromptForContentFilter(instruction);
      safeInput = sanitizePromptForContentFilter(input);
      safeRunContext = sanitizePromptForContentFilter(runContext);
      safeInstructionReminder = sanitizePromptForContentFilter(safeInstructionReminder);
      safePinnedSections = safePinnedSections.map((section) => sanitizePromptForContentFilter(section));
      safeConversationMessages = safeConversationMessages.map((message) => ({
        ...message,
        content: sanitizePromptForContentFilter(message.content)
      }));
    }
    return {
      safeInstruction,
      safeInput,
      safeRunContext,
      safePinnedSections,
      safeConversationMessages,
      safeInstructionReminder
    };
  },

  buildTaskMessages({ system = "", instructionReminder = "", conversation = [], user = "" } = {}) {
    return [
      { role: "system", content: system },
      ...(instructionReminder ? [{ role: "user", content: instructionReminder }] : []),
      ...normalizeConversationMessages(conversation).map(({ role, content }) => ({ role, content })),
      { role: "user", content: user }
    ];
  },

  contextWindowLimits(modelContextTokens, outputReserveTokens) {
    const safetyTokens = Math.max(8192, Math.ceil(modelContextTokens * 0.01));
    return {
      safetyTokens,
      hardInputTokens: Math.max(0, modelContextTokens - outputReserveTokens - safetyTokens)
    };
  },

  assertContextWindow(promptTokens, modelContextTokens, outputReserveTokens) {
    const limits = this.contextWindowLimits(modelContextTokens, outputReserveTokens);
    if (promptTokens <= limits.hardInputTokens) return limits;
    const error = new Error(`请求上下文 ${promptTokens} tokens 超过当前模型可用输入 ${limits.hardInputTokens} tokens。`);
    error.code = "MODEL_CONTEXT_EXCEEDED";
    error.promptTokens = promptTokens;
    error.hardInputTokens = limits.hardInputTokens;
    throw error;
  },

  async prepareTaskRequest(args = {}) {
    const profile = args.contextProfile || this.pickContextProfile(args.taskType);
    const baseBudget = this.getContextBudget(profile, args.settings);
    const budget = mergeContextBudget(baseBudget, args.contextBudget);
    const tokenBudget = this.normalizeTokenBudget(budget);
    const sections = await this.loadTaskContextSections({ ...args, budget, tokenBudget });
    const systemPromptSections = args.internalCall
      ? [await this.assembleInternalSystemPrompt(args.taskType)]
      : await this.assembleSystemPromptSections(args.taskType, {
        cacheScope: args.memoryCacheScope,
        memoryContext: args.memoryContext,
        contextManagement: args.contextManagement,
        tools: args.tools,
        model: args.model,
        workingDirectory: args.workingDirectory,
        additionalWorkingDirectories: args.additionalWorkingDirectories,
        mcpClients: args.mcpClients,
        featureGates: args.featureGates,
        outputStyleConfig: args.outputStyleConfig
      });
    const system = compileSystemPromptSections(systemPromptSections);
    const outputStylePrompt = args.internalCall
      ? ""
      : await getOutputStylePrompt(this, args.outputStyleConfig);
    const modelContextTokens = this.getModelContextTokens(args.provider, args.model, args.settings);
    const outputReserveTokens = this.getOutputReserveTokens(args.provider, args.settings, args.callMaxTokens);
    const context = this.buildTaskContextMessage({
      runContext: sections.safeRunContext,
      pinnedSections: sections.safePinnedSections,
      runtimeContext: args.internalCall ? "" : buildRuntimeContextSection({
        tools: args.tools,
        model: args.model,
        currentDate: localDate(this.clock?.() || new Date()),
        timeZone: localTimeZone(),
        knowledgeCutoff: args.provider?.knowledgeCutoff || args.settings?.deepseek?.knowledgeCutoff,
        languagePreference: args.settings?.language,
        workingDirectory: args.workingDirectory,
        scratchpadDirectory: args.scratchpadDirectory,
        additionalWorkingDirectories: args.additionalWorkingDirectories,
        mcpClients: args.mcpClients,
        featureGates: args.featureGates,
        environment: args.environment,
        capabilityCatalog: args.capabilityCatalog,
        outputStylePrompt
      }),
      budget: tokenBudget
    });
    const user = this.buildTaskUserMessage({
      taskType: args.taskType,
      title: args.title,
      instruction: sections.safeInstruction,
      input: sections.safeInput,
      context,
      budget: tokenBudget,
      instructionPlacement: args.instructionPlacement
    });
    const conversation = this.fitTaskConversationMessages({
      messages: this.buildTaskConversationMessages({
        messages: sections.safeConversationMessages,
        taskType: args.taskType,
        title: args.title,
        instruction: sections.safeInstruction,
        budget: tokenBudget
      }),
      tools: args.tools || [],
      system,
      instructionReminder: sections.safeInstructionReminder,
      user,
      modelContextTokens,
      outputReserveTokens
    });
    const messages = this.buildTaskMessages({
      system,
      instructionReminder: sections.safeInstructionReminder,
      conversation,
      user
    });
    const promptTokens = estimateRequestTokens({ messages, tools: args.tools || [] });
    this.assertContextWindow(promptTokens, modelContextTokens, outputReserveTokens);
    return {
      profile, budget, tokenBudget, sections, system, systemPromptSections,
      modelContextTokens, outputReserveTokens,
      messages, promptTokens, effectiveBudget: tokenBudget
    };
  },

  buildTaskConversationMessages({ messages = [], taskType, title, instruction, budget }) {
    return normalizeConversationMessages(messages).map((message) => {
      if (message.role !== "user" || message.modelReady) {
        return { role: message.role, content: message.content };
      }
      return {
        role: "user",
        content: this.buildTaskUserMessage({
          taskType,
          title,
          instruction,
          input: message.content,
          budget
        })
      };
    });
  },

  fitTaskConversationMessages({
    messages = [], tools = [], system = "", instructionReminder = "", user = "",
    modelContextTokens = 0, outputReserveTokens = 0
  } = {}) {
    const conversation = normalizeConversationMessages(messages)
      .map(({ role, content }) => ({ role, content }));
    const hardInputTokens = this.contextWindowLimits(
      modelContextTokens,
      outputReserveTokens
    ).hardInputTokens;
    while (conversation.length) {
      const promptTokens = estimateRequestTokens({
        messages: this.buildTaskMessages({
          system,
          instructionReminder,
          conversation,
          user
        }),
        tools
      });
      if (promptTokens <= hardInputTokens) break;
      conversation.shift();
    }
    return conversation;
  },

  buildTaskCallEntry(args = {}, request = {}) {
    const sections = request.sections;
    const inputTokenCount = estimateTokens(sections.safeInput || "");
    const runContextTokenCount = estimateTokens(sections.safeRunContext || "");
    const effective = request.effectiveBudget;
    return {
      id: args.callId,
      createdAt: args.startedAt.toISOString(),
      taskType: args.taskType,
      internalCall: args.internalCall === true,
      title: args.title,
      providerId: args.provider.id,
      providerName: args.provider.name || args.provider.id,
      model: args.model,
      projectId: args.projectId,
      taskId: args.taskId,
      runId: args.runId,
      stepId: args.stepId,
      inputChars: truncateForPromptTokens(sections.safeInput || "无", effective.inputTokens).length,
      runContextChars: truncateForPromptTokens(sections.safeRunContext || "无", effective.runContextTokens).length,
      rawInputChars: args.input.length,
      rawRunContextChars: args.runContext.length,
      rawInputTokens: inputTokenCount,
      rawRunContextTokens: runContextTokenCount,
      inputTokens: estimateTokens(truncateForPromptTokens(sections.safeInput || "无", effective.inputTokens)),
      runContextTokens: estimateTokens(truncateForPromptTokens(sections.safeRunContext || "无", effective.runContextTokens)),
      pinnedTokens: estimateTokens(sections.safePinnedSections.join("\n\n")),
      instructionMemoryTokens: estimateTokens(sections.safeInstructionReminder || ""),
      instructionMemoryDigest: `${args.instructionMemorySummary?.digest || ""}`,
      promptTokens: request.promptTokens,
      modelContextTokens: request.modelContextTokens,
      contextUsageRatio: Number((request.promptTokens / Math.max(1, request.modelContextTokens)).toFixed(4)),
      inputCoverageRatio: Number((Math.min(inputTokenCount, effective.inputTokens) / Math.max(1, inputTokenCount)).toFixed(4)),
      runContextCoverageRatio: Number((Math.min(runContextTokenCount, effective.runContextTokens) / Math.max(1, runContextTokenCount)).toFixed(4)),
      instructionPreview: truncate(redactSensitive(args.instruction), 1200),
      inputPreview: truncate(redactSensitive(sections.safeInput), 1200),
      runContextPreview: truncate(redactSensitive(sections.safeRunContext), 1600),
      pinnedPreview: truncate(redactSensitive(sections.safePinnedSections.join("\n\n")), 1600),
      contextProfile: request.profile,
      contentFilterSafe: args.contentFilterSafe,
      jsonMode: Boolean(args.jsonMode || args.responseFormat),
      streamed: Boolean(args.tokenHandler),
      thinkingMode: args.deepseekPolicy.applicable ? args.deepseekPolicy.thinking : null,
      reasoningEffort: args.deepseekPolicy.applicable ? args.deepseekPolicy.reasoningEffort : null,
      maxOutputTokens: args.callMaxTokens,
      outputReserveTokens: request.outputReserveTokens
    };
  },

  async retryTaskAfterError(context = {}) {
    const { error, retry, streamedAnyToken, propagated, request } = context;
    const totalAttempts = (Number(retry.totalAttempts) || 0) + 1;
    if (streamedAnyToken || totalAttempts >= 3 || error.code === "MODEL_OUTPUT_TRUNCATED") throw error;
    const message = `${error.message || ""}`.toLowerCase();
    const looksFiltered = error.code === "MODEL_CONTENT_FILTERED" || /content_filter|high risk|rejected because|安全|风险/.test(message);
    const looksTransient = error.code === "MODEL_RESOURCE_EXHAUSTED" || this.isTransientModelError(error);
    const baseRetry = { ...retry, totalAttempts };
    if (looksTransient) {
      const transientAttempts = Number(retry.transientAttempts) || 0;
      if (transientAttempts < 2) {
        await sleep(Math.min(8000, 1000 * (2 ** transientAttempts)) + Math.floor(Math.random() * 350));
        return this.runTaskDetailed({
          ...propagated,
          _retry: { ...baseRetry, transientAttempts: transientAttempts + 1 }
        });
      }
    }
    if (looksFiltered && !propagated.contentFilterSafe) {
      return this.runTaskDetailed({
        ...propagated,
        contextProfile: "minimal",
        contextBudget: {
          runContextTokens: Math.min(request.tokenBudget.runContextTokens, 1200),
          inputTokens: Math.min(request.tokenBudget.inputTokens, 1000)
        },
        contentFilterSafe: true,
        _retry: baseRetry
      });
    }
    throw error;
  }
};

function mergeContextBudget(baseBudget = {}, override = {}) {
  const merged = { ...baseBudget };
  for (const [tokenKey, charKey] of [
    ["runContextTokens", "runContextChars"],
    ["inputTokens", "inputChars"]
  ]) {
    if (Number.isFinite(override?.[tokenKey]) && Number(override[tokenKey]) >= 0) {
      merged[tokenKey] = Number(override[tokenKey]);
      continue;
    }
    if (Number.isFinite(override?.[charKey]) && Number(override[charKey]) >= 0) {
      merged[charKey] = Number(override[charKey]);
      merged[tokenKey] = legacyCharsToTokens(Number(override[charKey]));
    }
  }
  return merged;
}

function localDate(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("运行环境 current date 无效");
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join("-");
}

function localTimeZone() {
  try {
    return `${Intl.DateTimeFormat().resolvedOptions().timeZone || ""}`;
  } catch {
    return "";
  }
}
