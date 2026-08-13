// Agent 的确定性文件与视觉交付能力。
const path = require("node:path");
const fsp = require("node:fs/promises");
const {
  collectRemoteImageUrls,
  localizeHtmlImages,
  fetchAsDataUri
} = require("../../../../platform/media/htmlImageLocalizer");
const { readImageMetadata } = require("../../../../platform/media/imageMetadata");
const { mergeVisualIssues } = require("../../../../platform/ai/visualQuality");
const { isPathInside } = require("../../../../platform/shared/pathSafety");
const { containsToolProtocol } = require("../../../../platform/shared/internalToolProtocol");

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error("当前任务已取消。");
  error.name = "AbortError";
  throw error;
}

async function bestEffortVisualOperation(operation, signal, fallback) {
  try {
    return await operation();
  } catch (error) {
    throwIfAborted(signal);
    return typeof fallback === "function" ? fallback(error) : fallback;
  }
}

module.exports = {
async _executeAgentDeliveryTool({
  call, name = "", context = null, message = "", history = [], runId = "",
  projectId = "", taskId = "", turnId = "", signal = null
} = {}) {
  if (!["generate_document", "generate_visual"].includes(name)) {
    return { ok: false, code: "TOOL_NOT_SUPPORTED", error: `不支持的交付工具：${name}`, value: null };
  }
  const liveHistory = projectId && taskId && typeof this.listAgentMessages === "function"
    ? await this.listAgentMessages({ projectId, taskId, limit: 160 })
    : history;
  const payload = {
    toolCall: call,
    message,
    finalReply: "",
    history: liveHistory,
    runId,
    projectId,
    taskId,
    turnId,
    options: { signal },
    injectedArtifact: null
  };
  const result = name === "generate_visual"
    ? await this.runGenerateVisualFromToolCall(payload)
    : await this.runGenerateDocumentFromToolCall(payload);
  if (!result) {
    return { ok: false, code: "DELIVERY_SOURCE_MISSING", error: `${name} 没有找到可执行的来源。`, value: null };
  }
  if (!result.blocked && !result.cancelled) await registerArtifactCandidates(context, result, name);
  const candidate = result.artifact ? {
    artifactId: result.artifact.artifactId || "",
    title: result.artifact.title || "",
    file: result.artifact.file || "",
    absolute: result.artifact.absolute || "",
    format: result.artifact.format || "",
    bytes: result.artifact.bytes || 0,
    pages: result.artifact.pages || 0,
    status: "candidate"
  } : null;
  const value = {
    ok: !result.blocked && !result.cancelled,
    reply: `${result.reply || ""}`,
    taskId: result.taskId || taskId,
    runId: result.runId || "",
    candidate
  };
  return value.ok
    ? { ok: true, value }
    : { ok: false, code: result.cancelled ? "AGENT_ABORTED" : "DELIVERY_BLOCKED", error: value.reply || `${name} 未完成。`, value };
},

// 通用 Agent 先用 write/edit 生成 HTML；本工具只做确定性验收、登记和导出。
async runGenerateVisualFromToolCall({
  toolCall, message, finalReply = "",
  runId, projectId, taskId, turnId = "", options = {}
} = {}) {
  throwIfAborted(options.signal);
  let toolArgs = {};
  try { toolArgs = JSON.parse(toolCall.function?.arguments || "{}"); } catch {}
  const medium = ["deck", "webpage", "poster", "report"].includes(toolArgs.medium) ? toolArgs.medium : "";
  const requestedPath = `${toolArgs.path || ""}`.trim();
  const title = `${toolArgs.title || ""}`.trim();
  const exportPdf = toolArgs.exportPdf === true;
  const requirements = toolArgs.requirements && typeof toolArgs.requirements === "object"
    ? toolArgs.requirements
    : null;
  const activityScope = { projectId, taskId, runId, turnId };

  if (!medium || !requestedPath || !requestedPath.toLowerCase().endsWith(".html")) {
    return this._respondGenerateBlocked({
      reply: "generate_visual 参数无效：medium 必须符合工具契约，path 必须指向当前任务目录或 Agent 工作空间内的 .html 文件。",
      runId, projectId, taskId, turnId, options
    });
  }
  const source = await this._readTaskScopedTextFile({
    projectId,
    taskId,
    requestedPath,
    artifactFirst: true,
    allowedExtensions: [".html", ".htm"]
  }).catch(() => null);
  throwIfAborted(options.signal);
  const html = `${source?.content || ""}`;
  const absolute = `${source?.absolute || source?.path || ""}`;
  if (!absolute || !html.trim() || !/<(?:!doctype\s+html|html)\b/i.test(html)) {
    return this._respondGenerateBlocked({
      reply: "没有读取到可发布的完整 HTML。请先用 write/edit 在当前任务目录或 Agent 工作空间内完成文件，再调用 generate_visual。",
      runId, projectId, taskId, turnId, options
    });
  }
  const dir = path.dirname(absolute);
  const resolvedTitle = title || path.basename(absolute, path.extname(absolute)) || "可视化成品";
  try {
    await this._authorizeDeliveryNetworkUrls(collectRemoteImageUrls(html, 24), {
      projectId, taskId, runId, turnId, signal: options.signal || null
    });
  } catch (error) {
    return this._respondGenerateBlocked({
      reply: `远程图片读取未获授权：${error?.message || error}`,
      runId, projectId, taskId, turnId, options
    });
  }
  this._emitAgentActivity({ ...activityScope, phase: "visual-audit", status: "running", label: "正在检查图片、越界、裁切与文字重叠" });
  const audit = await bestEffortVisualOperation(
    () => this._inspectVisualQuality({ html, medium, dir, requirements, signal: options.signal || null }),
    options.signal,
    (error) => ({ issues: [{ code: "VISUAL_INSPECTION_FAILED", message: `${error?.message || error}` }] })
  );
  if (audit.issues.length) {
    this._emitAgentActivity({ ...activityScope, phase: "visual-audit", status: "blocked", label: "图片与版式检查未通过" });
    return this._respondGenerateBlocked({
      reply: `视觉检查未通过：${audit.issues.map((issue) => issue.message).join("；")}`,
      runId, projectId, taskId, turnId, options
    });
  }
  this._emitAgentActivity({ ...activityScope, phase: "visual-audit", status: "completed", label: "图片与版式检查通过" });
  throwIfAborted(options.signal);
  const deliverableHtml = audit.localization?.html || html;
  if (deliverableHtml !== html) await fsp.writeFile(absolute, deliverableHtml, "utf8");
  throwIfAborted(options.signal);
  const kind = { deck: "幻灯片", webpage: "网页", poster: "海报", report: "报告" }[medium] || "网页";
  const baseName = this._safeBaseName(resolvedTitle);
  this._emitAgentActivity({ projectId, taskId, runId, turnId, phase: "visual-export", status: "running", label: "正在导出预览文件" });
  const pdf = exportPdf
    ? await bestEffortVisualOperation(
      () => this._renderVisualPdf({
        html: deliverableHtml, localizedHtml: deliverableHtml, dir, baseName, medium,
        signal: options.signal || null
      }),
      options.signal,
      null
    )
    : null;
  throwIfAborted(options.signal);
  this._emitAgentActivity({
    projectId, taskId, runId, turnId, phase: "visual-export", status: "completed",
    label: pdf ? "HTML 与 PDF 已导出" : "HTML 已导出"
  });
  const pdfNote = pdf ? `\n\n同时生成 PDF 候选：${pdf.path}（${pdf.bytes} bytes）。` : "";
  const delivered = await this._deliverDocument({
    deliverable: { path: absolute, format: "html", bytes: Buffer.byteLength(deliverableHtml, "utf8"), kind },
    resolved: { dir, markdown: deliverableHtml, sourceLabel: "Agent HTML" },
    resolvedTitle, finalReply,
    degradeNote: `\n\n可用浏览器检查这个 .html。${pdfNote}`,
    runId, projectId, taskId, turnId, options
  });
  if (!pdf) return delivered;
  const pdfArtifact = {
    title: `${resolvedTitle} PDF`,
    file: path.basename(pdf.path),
    absolute: pdf.path,
    relative: path.relative(this.paths?.workspace || dir, pdf.path),
    format: "pdf",
    bytes: pdf.bytes,
    size: pdf.bytes,
    pages: 0,
    updatedAt: new Date().toISOString(),
    content: "",
    candidate: true
  };
  return { ...delivered, artifacts: [delivered.artifact, pdfArtifact] };
},

// 把视觉 HTML 成品渲染成同名 PDF（成品的可发送形态）。远程图先本地化成 data: 再交给 Chromium。
// best-effort：渲染器不可用、settings.visualExport.pdf=false、或渲染失败都返回 null，由调用方退回只交付 HTML。
async _renderVisualPdf({ html = "", localizedHtml = "", dir = "", baseName = "", medium = "webpage", signal = null } = {}) {
  throwIfAborted(signal);
  if (!this.pdfRenderer?.isAvailable?.()) return null;
  let settings = null;
  try { settings = await this.settingsService?.get?.(); } catch { settings = null; }
  if (settings?.visualExport?.pdf === false) return null;
  const localized = localizedHtml
    ? { html: localizedHtml }
    : await bestEffortVisualOperation(() => localizeHtmlImages({ html, signal }), signal, { html });
  throwIfAborted(signal);
  const pdfPath = await this._uniqueOutputPath(dir, baseName, "pdf");
  const r = await this.pdfRenderer.renderHtmlToPdf({
    html: localized.html || html, outputPath: pdfPath, options: { medium, scopeDir: dir, signal }
  });
  throwIfAborted(signal);
  return r?.ok ? { path: pdfPath, bytes: r.bytes } : null;
},

async _inspectVisualQuality({ html = "", medium = "deck", dir = "", requirements = null, signal = null } = {}) {
  throwIfAborted(signal);
  const localization = await bestEffortVisualOperation(
    () => localizeHtmlImages({ html, signal }),
    signal,
    { html, total: 0, localized: 0, removed: 0 }
  );
  throwIfAborted(signal);
  const layout = this.pdfRenderer?.inspectHtmlLayout
    ? await this.pdfRenderer.inspectHtmlLayout({ html: localization.html || html, options: { medium, scopeDir: dir, signal } })
    : null;
  throwIfAborted(signal);
  return {
    localization,
    layout,
    issues: mergeVisualIssues({
      html,
      medium,
      localization,
      layout: layout?.ok ? layout : null,
      requirements
    })
  };
},

_emitAgentActivity({
  projectId = "", taskId = "", runId = "", turnId = "", phase = "",
  status = "running", label = "", kind = "phase", toolName = "", detail = "", event = ""
} = {}) {
  if (!label || typeof this.emitActivity !== "function") return;
  this.emitActivity({ projectId, taskId, runId, turnId, phase, status, label, kind, toolName, detail, event });
},

// PPTX 子进程不联网。宿主先把开放图库图片下载成 data URI，再把已验证的图片交给 skill。
// 单图与总量都设上限，确保 skill stdin 不超过 8 MiB。
async _materializePresentationImages(palette = [], {
  projectId = "", taskId = "", runId = "", turnId = "", signal = null
} = {}) {
  const rows = (Array.isArray(palette) ? palette : []).filter((item) => /^https?:\/\//i.test(`${item?.url || ""}`)).slice(0, 4);
  await this._authorizeDeliveryNetworkUrls(rows.map((item) => item.url), {
    projectId, taskId, runId, turnId, signal
  });
  const settled = await Promise.all(rows.map(async (item) => {
    const data = await fetchAsDataUri(item.url, {
      fetchImpl: fetch,
      maxBytes: 1_200_000,
      timeoutMs: 12_000,
      signal
    });
    if (!data) return null;
    try {
      const encoded = data.slice(data.indexOf(",") + 1);
      const dimensions = readImageMetadata(Buffer.from(encoded, "base64"));
      return {
        data,
        width: dimensions.width,
        height: dimensions.height,
        title: item.title || item.query || "配图",
        credit: [item.credit, item.license].filter(Boolean).join(" · ")
      };
    } catch {
      return null;
    }
  }));
  return settled.filter(Boolean);
},

async _authorizeDeliveryNetworkUrls(urls = [], {
  projectId = "", taskId = "", runId = "", turnId = "", signal = null
} = {}) {
  const resources = [...new Set(
    (Array.isArray(urls) ? urls : [])
      .map((url) => `${url || ""}`.trim())
      .filter((url) => /^https?:\/\//i.test(url))
  )];
  if (!resources.length) return [];
  if (typeof this.toolPermissionService?.authorize !== "function") {
    throw Object.assign(new Error("宿主网络授权能力不可用。"), { code: "TOOL_APPROVAL_UNAVAILABLE" });
  }
  for (const url of resources) {
    throwIfAborted(signal);
    const decision = await this.toolPermissionService.authorize({
      name: "fetch_remote_image",
      args: { url },
      policy: {
        namespace: "delivery",
        effect: "network_read",
        effects: ["network_read"],
        parallelSafe: false
      },
      context: { projectId, taskId, runId, turnId },
      signal
    });
    if (decision === false || decision?.allow === false || decision?.decision === "deny") {
      throw Object.assign(
        new Error(decision?.error || "用户未授权读取这个网络资源。"),
        { code: decision?.code || "TOOL_PERMISSION_DENIED" }
      );
    }
  }
  return resources;
},

// generate_document 只负责把已有内容转换为文件，不启动第二个 Agent。
//
// source 由模型显式选择；宿主只验证已完成正文、工作区文件或既有成品的真实性与作用域。
//
// 三层都没有可用正文时返回友好回复（不是崩溃）。
async runGenerateDocumentFromToolCall({
  toolCall, message, finalReply = "", history = [],
  runId, projectId, taskId, turnId = "", options = {},
  injectedArtifact = null
} = {}) {
  let toolArgs = {};
  try { toolArgs = JSON.parse(toolCall.function?.arguments || "{}"); } catch {}
  const format = `${toolArgs.format || ""}`.toLowerCase();
  const source = ["prepared_content", "workspace_file", "latest_artifact", "task_history"].includes(toolArgs.source)
    ? toolArgs.source
    : "";
  const title = `${toolArgs.title || ""}`.trim();

  if (!this.skillsService) {
    return this._respondGenerateBlocked({ reply: "文档技能子系统未初始化，无法生成文件。", runId, projectId, taskId, turnId, options });
  }
  if (!["docx", "pdf", "pptx", "xlsx"].includes(format) || !source) {
    // tool schema enum 已限定，但模型偶发越界时给一个安全 fallback。
    return this._respondGenerateBlocked({
      reply: "generate_document 参数无效：format 与 source 必须符合工具契约。",
      runId, projectId, taskId, turnId, options
    });
  }

  const resolved = await this._resolveDocumentSource({
    injectedArtifact, finalReply, history, message,
    preparedContent: toolArgs.content,
    sourcePath: toolArgs.path,
    projectId, taskId, runId, turnId, source
  });

  if (!resolved) {
    return this._respondGenerateBlocked({
      reply: "没有读取到可以直接导出的完整正文。请先完成内容，再用 prepared_content 或 workspace_file 交付。",
      runId, projectId, taskId, turnId, options
    });
  }
  const sourceError = this._validateDocumentSource({ format, resolved });
  if (sourceError) {
    return this._respondGenerateBlocked({
      reply: sourceError,
      runId, projectId, taskId, turnId, options
    });
  }

  const baseName = this._safeBaseName(title || resolved.title || "document");
  const resolvedTitle = title || resolved.title || baseName;
  const ctxFields = { resolved, resolvedTitle, finalReply, runId, projectId, taskId, turnId, options };

  // 路径 D：pptx / xlsx 直接由对应 skill 从 markdown 生成，零外部依赖，不走 docx/Chromium。
  const directSkill = { pptx: { id: "skill://pptx@1", kind: "PPT" }, xlsx: { id: "skill://xlsx@1", kind: "Excel" } }[format];
  if (directSkill) {
    const outPath = await this._uniqueOutputPath(resolved.dir, baseName, format);
    const skillOptions = { title: resolvedTitle };
    const selectedImages = Array.isArray(toolCall?.resolvedImageAssets) ? toolCall.resolvedImageAssets : [];
    if (format === "pptx" && selectedImages.length) {
      this._emitAgentActivity({ projectId, taskId, runId, turnId, phase: "document-images", status: "running", label: "正在下载并嵌入已选图片" });
      try {
        skillOptions.images = await this._materializePresentationImages(selectedImages, {
          projectId, taskId, runId, turnId, signal: options.signal || null
        });
      } catch (error) {
        this._emitAgentActivity({ projectId, taskId, runId, turnId, phase: "document-images", status: "blocked", label: "配图下载未获授权" });
        return this._respondGenerateBlocked({
          reply: `配图下载未获授权：${error?.message || error}`,
          runId, projectId, taskId, turnId, options
        });
      }
      this._emitAgentActivity({
        projectId, taskId, runId, turnId, phase: "document-images", status: "completed",
        label: `已嵌入 ${skillOptions.images.length} 张已选图片`
      });
    }
    const r = await this.skillsService.invoke(directSkill.id, "create", {
      source: { markdown: resolved.markdown },
      outputPath: outPath,
      options: skillOptions
    }, { workDir: resolved.dir, scopeAllow: [resolved.dir], signal: options.signal || null });
    if (r?.ok) {
      const verified = await this._verifySkillOutput(directSkill.id, outPath, resolved.dir, options.signal);
      if (!verified.ok) {
        return this._respondGenerateBlocked({
          reply: `${directSkill.kind} 文件已生成但结构校验失败：${verified.error}`,
          runId, projectId, taskId, turnId, options
        });
      }
      return this._deliverDocument({
        ...ctxFields,
        deliverable: {
          path: outPath,
          format,
          bytes: r.bytes || 0,
          kind: directSkill.kind,
          warnings: r.warnings || [],
          pages: Number(r.slides) || 0
        },
        degradeNote: ""
      });
    }
    return this._respondGenerateBlocked({
      reply: `生成 ${directSkill.kind} 失败（${r?.error?.code || "ERROR"}）：${r?.error?.message || "未知错误"}`,
      runId, projectId, taskId, turnId, options
    });
  }

  // 路径 A：format=pdf 且 Chromium 渲染器可用 → 直接 markdown→pdf，零外部依赖，不造 docx 中间件。
  if (format === "pdf" && this.pdfRenderer?.isAvailable?.()) {
    const pdfPath = await this._uniqueOutputPath(resolved.dir, baseName, "pdf");
    const r = await this.pdfRenderer.renderMarkdownToPdf({
      markdown: resolved.markdown, outputPath: pdfPath, options: { title: resolvedTitle }
    });
    if (r?.ok) {
      const verified = await this._verifySkillOutput("skill://pdf@1", pdfPath, resolved.dir, options.signal);
      if (!verified.ok) {
        // Chromium 产物结构不合法时走下面的 docx → LibreOffice 兜底。
      } else {
        return this._deliverDocument({
          ...ctxFields,
          deliverable: { path: pdfPath, format: "pdf", bytes: r.bytes || 0, kind: "PDF" },
          degradeNote: ""
        });
      }
    }
    // Chromium 渲染失败 → 落到下面 docx / LibreOffice 兜底，尽量给用户交付物。
  }

  // 路径 B：先生成 docx —— 它既是 Word 交付物，也是无 Chromium 时 PDF 的兜底渲染源。
  const docxPath = await this._uniqueOutputPath(resolved.dir, baseName, "docx");
  const docxResult = await this.skillsService.invoke("skill://docx@1", "create", {
    source: { markdown: resolved.markdown },
    outputPath: docxPath,
    options: { title: resolvedTitle }
  }, { workDir: resolved.dir, scopeAllow: [resolved.dir], signal: options.signal || null });

  if (!docxResult?.ok) {
    const code = docxResult?.error?.code || "ERROR";
    return this._respondGenerateBlocked({
      reply: `生成 Word 失败（${code}）：${docxResult?.error?.message || "未知错误"}`,
      runId, projectId, taskId, turnId, options
    });
  }

  const docxVerified = await this._verifySkillOutput("skill://docx@1", docxPath, resolved.dir, options.signal);
  if (!docxVerified.ok) {
    return this._respondGenerateBlocked({
      reply: `Word 文件已生成但结构校验失败：${docxVerified.error}`,
      runId, projectId, taskId, turnId, options
    });
  }

  let deliverable = { path: docxPath, format: "docx", bytes: docxResult.bytes || 0, kind: "Word", warnings: docxResult.warnings || [] };
  let degradeNote = "";
  if (format === "pdf") {
    // 到这里说明 Chromium 不可用或失败 → 用 LibreOffice 兜底把 docx 转 pdf。
    const pdfPath = await this._uniqueOutputPath(resolved.dir, baseName, "pdf");
    const pdfResult = await this.skillsService.invoke("skill://pdf@1", "create", {
      inputPath: docxPath, outputPath: pdfPath
    }, { workDir: resolved.dir, scopeAllow: [resolved.dir], signal: options.signal || null });

    if (pdfResult?.ok) {
      const pdfVerified = await this._verifySkillOutput("skill://pdf@1", pdfPath, resolved.dir, options.signal);
      if (pdfVerified.ok) {
        deliverable = { path: pdfPath, format: "pdf", bytes: pdfResult.bytes || 0, kind: "PDF", warnings: pdfResult.warnings || [] };
      } else {
        degradeNote = `\n\nPDF 结构校验失败（${pdfVerified.error}），已保留通过校验的 Word 文件。`;
      }
    } else if (pdfResult?.error?.code === "DEP_MISSING") {
      degradeNote = `\n\nPDF 渲染器暂不可用，已为你保留 Word 文件。${pdfResult.error.missingHint || ""}`;
    } else {
      degradeNote = `\n\nPDF 渲染失败（${pdfResult?.error?.code || "ERROR"}：${pdfResult?.error?.message || "未知错误"}）。已为你保留 Word 文件，可直接使用或重试。`;
    }
  }

  return this._deliverDocument({ ...ctxFields, deliverable, degradeNote });
},

// generate 子系统统一的成功出口：建立候选 artifact 并返回工具结果。
async _deliverDocument({
  deliverable, resolved, resolvedTitle, finalReply, degradeNote = "",
  runId, projectId, taskId, turnId = "", options = {}
}) {
  const outputPath = deliverable.path;
  let indexedArtifact = null;
  if (this.artifactStore?.saveTextArtifact && projectId && taskId) {
    const readableContent = deliverable.format === "html"
      ? await fsp.readFile(outputPath, "utf8").catch(() => `${resolved.markdown || ""}`)
      : `${resolved.markdown || ""}`;
    if (readableContent.trim()) {
      const suffix = `${turnId || Date.now()}`.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 80);
      indexedArtifact = await this.artifactStore.saveTextArtifact({
        projectId,
        taskId,
        runId: runId || "",
        stepId: turnId ? `agent-${turnId}` : "agent-delivery",
        artifactType: `agent-deliverable-${deliverable.format}-${suffix}`,
        title: resolvedTitle,
        format: deliverable.format === "html" ? "html" : "markdown",
        content: readableContent,
        fileName: `${this._safeBaseName(resolvedTitle)}-${suffix}.${deliverable.format === "html" ? "html" : "md"}`,
        metadata: {
          deliverablePath: outputPath,
          deliverableFormat: deliverable.format,
          pages: Number(deliverable.pages) || 0
        }
      }).catch(() => null);
    }
  }
  const docArtifact = {
    artifactId: indexedArtifact?.id || "",
    title: resolvedTitle,
    file: path.basename(outputPath),
    absolute: outputPath,
    relative: path.relative(this.paths?.workspace || resolved.dir, outputPath),
    format: deliverable.format,
    bytes: deliverable.bytes,
    pages: Number(deliverable.pages) || 0,
    updatedAt: new Date().toISOString(),
    content: ""
  };
  // task_history 来源是按已有工作记录直接转换，不启动第二个 Agent。
  const sourceNote = resolved.sourceLabel === "工作记录"
    ? "（按已有工作记录直接转换）"
    : "";
  const warnings = Array.isArray(deliverable.warnings) ? deliverable.warnings.filter(Boolean) : [];
  const warningNote = warnings.length ? `\n\n生成告警：${warnings.slice(0, 4).join("；")}` : "";
  const pageNote = Number(deliverable.pages) > 0 ? `，${deliverable.pages} 页` : "";
  const summary = [
    `已生成 ${deliverable.kind} 候选文件：${path.basename(outputPath)}（${deliverable.bytes} bytes${pageNote}，来源：${resolved.sourceLabel}${sourceNote}，基础结构校验通过）。`,
    `候选位置：${outputPath}。`,
    `请用 inspect_artifact 读取真实内容并对照用户要求；确认合格后用 publish_artifact 发布。未发布前不会成为用户可见成品。${warningNote}${degradeNote}`
  ].join("");
  const fullReply = finalReply ? `${finalReply}\n\n${summary}` : summary;

  return { reply: fullReply, artifact: { ...docArtifact, candidate: true }, taskId, runId };
},

async _verifySkillOutput(skillId, inputPath, scopeDir, signal = null) {
  const result = await this.skillsService.invoke(skillId, "validate", { inputPath }, {
    workDir: scopeDir,
    scopeAllow: [scopeDir],
    signal
  });
  if (result?.ok) return { ok: true, warnings: result.warnings || [] };
  const detail = result?.error?.message
    || result?.errors?.map((item) => item?.message || item?.code).filter(Boolean).join("；")
    || result?.error?.code
    || "未知校验错误";
  return { ok: false, error: detail };
},

// generate 子系统的统一拒绝出口。
async _respondGenerateBlocked({ reply, runId, projectId, taskId }) {
  return { reply, blocked: true, taskId, runId };
},

// 当前成品是转换与修改的权威来源；只有没有成品时才从工作记录回退。
async _resolveDocumentSource({
  injectedArtifact, history, message = "", preparedContent = "", sourcePath = "",
  projectId, taskId, runId, turnId = "", source = "latest_artifact"
}) {
  const exportDir = await this._resolveAgentExportDir({ projectId, taskId });
  if (!exportDir) return null;
  const prepared = `${preparedContent || ""}`.trim();
  if (source === "prepared_content") {
    if (!prepared || containsToolProtocol(prepared)) return null;
    return {
      markdown: prepared,
      title: this._deriveTitleFromMarkdown(prepared),
      dir: exportDir,
      sourceLabel: "Agent 准备的正文"
    };
  }
  if (source === "workspace_file") {
    const file = await this._readTaskScopedTextFile({
      projectId,
      taskId,
      requestedPath: sourcePath,
      allowedExtensions: [".md", ".markdown", ".txt", ".csv", ".tsv"]
    }).catch(() => null);
    const markdown = `${file?.content || ""}`.trim();
    if (!markdown || containsToolProtocol(markdown)) return null;
    return {
      markdown,
      title: this._deriveTitleFromMarkdown(markdown) || path.basename(file.absolute, path.extname(file.absolute)),
      dir: exportDir,
      sourceLabel: "Agent 工作区文件"
    };
  }
  // 1) injectedArtifact（P2.1：同轮 produce 刚生产的 artifact）
  if (injectedArtifact?.absolute && `${injectedArtifact.content || ""}`.trim()
      && !containsToolProtocol(injectedArtifact.content)) {
    return {
      markdown: injectedArtifact.content,
      title: injectedArtifact.title || "",
      dir: exportDir,
      sourceLabel: "刚生产的成品"
    };
  }
  // 2) 来源由模型通过工具参数明确声明；宿主只验证并解析真实来源，
  // 不再用长度或关键词猜测一段文本是不是正文。
  const task = projectId && taskId && this.projectService?.getTask
    ? await this.projectService.getTask(projectId, taskId).catch(() => null)
    : null;
  const taskHistoryMarkdown = this._pickMarkdownFromTaskHistory({
    history, message, taskBrief: task?.brief || "", turnId, source
  });
  if (taskHistoryMarkdown) {
    return {
      markdown: taskHistoryMarkdown,
      title: task?.title || this._deriveTitleFromMarkdown(taskHistoryMarkdown) || "工作记录导出",
      dir: exportDir,
      sourceLabel: "工作记录"
    };
  }
  if (source !== "latest_artifact") return null;
  const artifact = await this._findExportableArtifact({ projectId, taskId, runId });
  if (artifact?.absolute && `${artifact.content || ""}`.trim() && !containsToolProtocol(artifact.content)) {
    return {
      markdown: artifact.content,
      title: artifact.title || "",
      dir: exportDir,
      sourceLabel: "task 最新成品"
    };
  }
  return null;
},

// 从 markdown 推标题：优先第一段 H1，没有就取首行非空内容前 24 字。
_deriveTitleFromMarkdown(markdown) {
  if (containsToolProtocol(markdown)) return "";
  const lines = `${markdown || ""}`.split("\n").map((l) => l.trim()).filter(Boolean);
  for (const line of lines.slice(0, 5)) {
    const h1 = line.match(/^#\s+(.+)$/);
    if (h1) return h1[1].trim().slice(0, 40);
  }
  const first = lines[0] || "";
  return first.slice(0, 24);
},

// task_history 只在模型显式选择工作记录导出时使用，宿主仍负责协议泄漏检查与来源解析。
_pickMarkdownFromTaskHistory({
  history = [], message = "", taskBrief = "", turnId = "", source = ""
}) {
  if (source !== "task_history") return "";
  const clean = (value) => {
    const text = `${value || ""}`.trim();
    return text && !containsToolProtocol(text) ? text : "";
  };
  const sections = [];
  const brief = clean(taskBrief);
  const current = clean(message);
  if (brief && brief !== current) sections.push(`【任务目标】\n${brief}`);
  const rows = (Array.isArray(history) ? history : [])
    .filter((item) => ["user", "assistant"].includes(item?.role))
    .map((item) => ({ role: item.role, content: clean(item.content), turnId: `${item.turnId || ""}` }))
    .filter((item) => item.content);
  let currentIndex = -1;
  if (turnId) currentIndex = rows.findLastIndex((item) => item.role === "user" && item.turnId === turnId);
  if (currentIndex < 0 && current) currentIndex = rows.findLastIndex((item) => item.role === "user" && item.content === current);
  const transcript = rows
    .filter((_item, index) => index !== currentIndex)
    .map((item) => `${item.role === "user" ? "用户" : "Agent"}：${item.content}`)
    .join("\n\n");
  if (transcript) sections.push(`【此前工作记录】\n${transcript}`);
  if (current) sections.push(`【当前用户要求】\n${current}`);
  return sections.join("\n\n");
},

_validateDocumentSource({ format = "", resolved = null } = {}) {
  const markdown = `${resolved?.markdown || ""}`.trim();
  if (!markdown) return "没有可以直接导出的正文。";
  if (format !== "pptx") return "";
  const slideHeadings = markdown.match(/^#{1,2}\s+\S.*$/gm) || [];
  if (!slideHeadings.length) {
    return [
      "PPTX 来源没有可切页的 H1/H2 标题，继续生成会把任务说明挤进单页。",
      "请由你先完成逐页内容，再用 prepared_content 提交；title 生成封面，content 中每个 H1/H2 生成一张内容页。"
    ].join("");
  }
  return "";
},

async _readTaskScopedTextFile({
  projectId = "", taskId = "", requestedPath = "", allowedExtensions = [],
  artifactFirst = false
} = {}) {
  if (!projectId || !taskId || !requestedPath || !this.projectService?.getTaskDir) return null;
  const taskDir = await fsp.realpath(this.projectService.getTaskDir(projectId, taskId));
  const workspace = typeof this.projectService?.resolveTaskWorkspace === "function"
    ? await this.projectService.resolveTaskWorkspace(projectId, taskId)
    : await legacyDeliveryWorkspace(this.projectService, projectId, taskId);
  const workDir = `${workspace?.workspacePath || ""}`.trim() || taskDir;
  const artifactDir = path.join(taskDir, ".candidates");
  const candidates = path.isAbsolute(requestedPath)
    ? [requestedPath]
    : [...new Set((artifactFirst ? [artifactDir, workDir] : [workDir, artifactDir])
      .map((root) => path.join(root, requestedPath)))];
  let canonical = "";
  for (const candidate of candidates) {
    canonical = await fsp.realpath(path.resolve(candidate)).catch(() => "");
    if (canonical) break;
  }
  if (!canonical) throw new Error(`文件不存在：${requestedPath}`);
  if (![taskDir, workDir, artifactDir].some((root) => isPathInside(root, canonical))) {
    throw new Error("文件路径不在当前任务目录或 Agent 工作空间内。");
  }
  const extension = path.extname(canonical).toLowerCase();
  if (allowedExtensions.length && !allowedExtensions.includes(extension)) {
    throw new Error(`文件格式不受支持：${extension || "无扩展名"}`);
  }
  const stat = await fsp.stat(canonical);
  if (!stat.isFile()) throw new Error("只能读取文件。");
  if (stat.size > 2_000_000) throw new Error("文本来源超过 2000000 bytes。");
  return {
    absolute: canonical,
    content: await fsp.readFile(canonical, "utf8"),
    bytes: stat.size,
    updatedAt: stat.mtime.toISOString()
  };
},

// 所有可视成品先在任务隐藏候选区制作；检查与发布后再进入 final，
// 并由 publish_artifact 决定是否复制到用户工作空间。
async _resolveAgentExportDir({ projectId, taskId }) {
  if (!projectId || !taskId || !this.projectService?.getTaskDir) return null;
  const taskDir = this.projectService.getTaskDir(projectId, taskId);
  if (!taskDir) return null;
  const dir = path.join(taskDir, ".candidates");
  await fsp.mkdir(dir, { recursive: true });
  return dir;
},

// 同名文件已存在时自动 -v2、-v3 … 后缀，避免静默覆盖旧导出。
async _uniqueOutputPath(dir, baseName, ext) {
  const exists = async (p) => { try { await fsp.access(p); return true; } catch { return false; } };
  let candidate = path.join(dir, `${baseName}.${ext}`);
  if (!(await exists(candidate))) return candidate;
  for (let n = 2; n <= 999; n += 1) {
    candidate = path.join(dir, `${baseName}-v${n}.${ext}`);
    if (!(await exists(candidate))) return candidate;
  }
  return candidate;
},

// 找当前 task 范围内最新可导出的 artifact：优先 runId，再退回 task 最新已完成 run。
async _findExportableArtifact({ projectId, taskId, runId }) {
  if (runId) {
    const state = await this.readRun(runId).catch(() => null);
    if (state) {
      const a = await this.ensureRunArtifact(state).catch(() => null);
      if (a && a.absolute) return a;
    }
  }
  if (!projectId || !taskId) return null;
  const runs = await this.listRuns(projectId, taskId).catch(() => []);
  const completed = runs
    .filter((r) => r.status === "completed")
    .sort((a, b) => `${b.updatedAt || ""}`.localeCompare(`${a.updatedAt || ""}`));
  for (const r of completed) {
    const state = await this.readRun(r.id).catch(() => null);
    if (!state) continue;
    const a = await this.ensureRunArtifact(state).catch(() => null);
    if (a && a.absolute) return a;
  }
  return null;
},

// 把任意 title 转成可作为文件名的 base：保留中英文字数字、其余转 -，长度截到 40。
_safeBaseName(title) {
  const cleaned = `${title || ""}`
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return cleaned || `document-${Date.now()}`;
}
,

};

async function legacyDeliveryWorkspace(projectService, projectId, taskId) {
  const task = typeof projectService?.getTask === "function"
    ? await projectService.getTask(projectId, taskId, false).catch(() => null)
    : null;
  const requested = `${task?.workspacePath || ""}`.trim();
  return {
    task,
    workspacePath: requested ? await fsp.realpath(requested) : ""
  };
}

async function registerArtifactCandidates(context, result, sourceTool) {
  if (!context || !(context.artifactCandidates instanceof Map)) return;
  const artifacts = Array.isArray(result.artifacts)
    ? result.artifacts
    : (result.artifact ? [result.artifact] : []);
  for (const artifact of artifacts) {
    const requested = `${artifact?.absolute || ""}`.trim();
    if (!requested) continue;
    const resolved = path.resolve(requested);
    const absolute = await fsp.realpath(resolved).catch(() => resolved);
    context.artifactCandidates.set(absolute, {
      absolute,
      file: `${artifact.file || ""}`,
      title: `${artifact.title || ""}`,
      format: `${artifact.format || ""}`,
      bytes: Number(artifact.bytes) || 0,
      pages: Number(artifact.pages) || 0,
      sourceTool,
      status: "candidate",
      createdAt: new Date().toISOString()
    });
  }
}
