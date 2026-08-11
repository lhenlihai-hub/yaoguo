const {
  fsp,
  path,
  crypto,
  exists,
  readJson,
  writeJsonAtomic,
  truncate
} = require("../../runtime");
const { constants: fsConstants } = require("node:fs");
const { isPathInside } = require("../../shared/pathSafety");
const {
  PUBLISHED_ARTIFACT_TRANSACTION_OWNER_ID,
  publishedArtifactManifestName,
  publishedArtifactTransactionName,
  isPublishedArtifactManifestName,
  isPublishedArtifactTransactionName,
  isPublishedArtifactManifest,
  isPublishedArtifactTransaction,
  publishedArtifactManifestFromTransaction
} = require("../../artifacts/publishedArtifactManifest");

const RECORDED_TEXT_EXTENSIONS = new Set([
  ".md", ".markdown", ".txt", ".json", ".css", ".js", ".mjs", ".cjs",
  ".ts", ".tsx", ".jsx", ".csv", ".tsv", ".xml", ".svg", ".yaml", ".yml"
]);
const AGENT_FILE_INDEX_NAME = ".agent-files.json";
const AGENT_FILE_INDEX_VERSION = 3;
const MAX_FILE_CARD_PREVIEW_BYTES = 64 * 1024;
const MAX_FULL_HTML_PREVIEW_BYTES = 16 * 1024 * 1024;

class ProjectFileReferenceActions {
  async listTaskFiles(projectId, taskId) {
    const rows = await this.listRecordedAgentFiles(projectId, taskId);
    return [...new Map(rows.map((row) => [row.absolute, row])).values()]
      .sort((a, b) => `${b.updatedAt}`.localeCompare(`${a.updatedAt}`));
  }

  async listRecordedAgentFiles(projectId, taskId, knownFiles = []) {
    const workspace = await this.resolveTaskWorkspace(projectId, taskId);
    const taskDir = await fsp.realpath(this.getTaskDir(projectId, taskId));
    const workDir = workspace.workspacePath || taskDir;
    const known = new Set(knownFiles.map((file) => file.absolute));
    const index = await this.ensureAgentFileIndex(projectId, taskId, workDir);
    const rows = [];
    for (const entry of index.files) {
      const absolute = `${entry?.absolute || ""}`;
      if (!absolute || known.has(absolute)) continue;
      const row = await this.describeRecordedAgentFile(absolute, taskDir, workDir, entry).catch(() => null);
      if (row) rows.push(row);
    }
    return rows;
  }

  async recordTaskArtifacts(projectId, taskId, artifacts = []) {
    if (!projectId || !taskId || !Array.isArray(artifacts) || !artifacts.length) return [];
    const operation = () => this._recordTaskArtifacts(projectId, taskId, artifacts);
    return this.taskFileWrites?.run
      ? this.taskFileWrites.run(`${projectId}::${taskId}`, operation)
      : operation();
  }

  async _recordTaskArtifacts(projectId, taskId, artifacts = []) {
    const workspace = await this.resolveTaskWorkspace(projectId, taskId);
    const taskDir = await fsp.realpath(this.getTaskDir(projectId, taskId));
    const workDir = workspace.workspacePath || taskDir;
    const index = await this.ensureAgentFileIndex(projectId, taskId, workDir);
    const files = new Map(index.files.map((entry) => [entry.absolute, entry]));
    for (const artifact of artifacts) {
      const requested = `${artifact?.absolute || ""}`.trim();
      if (!requested) continue;
      const absolute = await fsp.realpath(requested).catch(() => path.resolve(requested));
      const stat = await fsp.stat(absolute).catch(() => null);
      if (!stat?.isFile()) continue;
      if (![taskDir, workDir].some((root) => isPathInside(root, absolute))) continue;
      const source = `${artifact.source || "agent-publish"}`;
      if (source === "agent-publish") {
        const manifested = files.get(absolute);
        if (manifested?.source !== "agent-publish") continue;
        files.set(absolute, manifested);
        continue;
      }
      files.set(absolute, {
        absolute,
        source,
        title: `${artifact.title || ""}`,
        sha256: `${artifact.sha256 || ""}`,
        inspectionId: `${artifact.inspectionId || ""}`,
        recordedAt: `${artifact.updatedAt || new Date().toISOString()}`
      });
    }
    const next = { ...index, files: [...files.values()] };
    await writeJsonAtomic(path.join(taskDir, AGENT_FILE_INDEX_NAME), next);
    return next.files;
  }

  async ensureAgentFileIndex(projectId, taskId, workDir) {
    const taskDir = await fsp.realpath(this.getTaskDir(projectId, taskId));
    const indexFile = path.join(taskDir, AGENT_FILE_INDEX_NAME);
    const stored = await readJson(indexFile, null).catch(() => null);
    const storedVersion = Number(stored?.version) || 0;
    const published = await this.collectPublishedManifestEntries(taskDir);
    const publishedByPath = new Map(published.map((entry) => [entry.absolute, entry]));
    const files = new Map();
    for (const entry of Array.isArray(stored?.files) ? stored.files : []) {
      if (!entry?.absolute) continue;
      if (entry.source === "agent-publish") {
        if (publishedByPath.has(entry.absolute)) continue;
        if (storedVersion >= AGENT_FILE_INDEX_VERSION) continue;
        files.set(entry.absolute, {
          ...entry,
          source: await this.isLegacyFinalPath(taskDir, entry.absolute)
            ? "legacy-final"
            : "legacy-agent-publish"
        });
        continue;
      }
      files.set(entry.absolute, entry);
    }
    if (storedVersion < AGENT_FILE_INDEX_VERSION) {
      for (const entry of await this.collectLegacyFinalEntries(taskDir)) {
        files.set(entry.absolute, entry);
      }
      for (const entry of await this.collectLegacyAgentFileEntries(projectId, taskId, workDir)) {
        if (entry.source === "agent-publish" && !publishedByPath.has(entry.absolute)) {
          entry.source = "legacy-agent-publish";
        }
        files.set(entry.absolute, entry);
      }
    }
    for (const entry of published) files.set(entry.absolute, entry);
    const nextFiles = [...files.values()]
      .sort((left, right) => `${left.absolute}`.localeCompare(`${right.absolute}`));
    if (
      storedVersion === AGENT_FILE_INDEX_VERSION
      && JSON.stringify(stored.files || []) === JSON.stringify(nextFiles)
    ) return stored;
    const index = {
      version: AGENT_FILE_INDEX_VERSION,
      importedAt: `${stored?.importedAt || new Date().toISOString()}`,
      reconciledAt: new Date().toISOString(),
      files: nextFiles
    };
    await writeJsonAtomic(indexFile, index);
    return index;
  }

  async collectPublishedManifestEntries(taskDir) {
    const finalDir = await fsp.realpath(path.join(taskDir, "final")).catch(() => "");
    if (!finalDir || !isPathInside(taskDir, finalDir) || finalDir === taskDir) return [];
    await this.recoverPublishedArtifactTransactions(finalDir);
    const entries = (await fsp.readdir(finalDir, { withFileTypes: true }).catch(() => []))
      .filter((entry) => entry.isFile() && isPublishedArtifactManifestName(entry.name))
      .sort((left, right) => left.name.localeCompare(right.name));
    const rows = [];
    let manifestCleaned = false;
    for (const entry of entries) {
      const manifestPath = path.join(finalDir, entry.name);
      const record = await this.readPublishedManifestRecord(manifestPath);
      const manifest = record?.value;
      if (!isPublishedArtifactManifest(manifest)) continue;
      if (publishedArtifactManifestName(manifest.file) !== entry.name) continue;
      const absolute = path.join(finalDir, manifest.file);
      const stat = await fsp.lstat(absolute).catch(() => null);
      if (!stat?.isFile() || stat.isSymbolicLink() || stat.size !== Number(manifest.bytes)) {
        manifestCleaned = await unlinkIfIdentity(manifestPath, record.identity).catch(() => false)
          || manifestCleaned;
        continue;
      }
      const canonical = await fsp.realpath(absolute).catch(() => "");
      if (!canonical || !isPathInside(finalDir, canonical) || canonical === finalDir) {
        manifestCleaned = await unlinkIfIdentity(manifestPath, record.identity).catch(() => false)
          || manifestCleaned;
        continue;
      }
      if (await sha256File(canonical).catch(() => "") !== manifest.sha256) {
        manifestCleaned = await unlinkIfIdentity(manifestPath, record.identity).catch(() => false)
          || manifestCleaned;
        continue;
      }
      rows.push({
        absolute: canonical,
        source: "agent-publish",
        title: `${manifest.title || ""}` || path.basename(canonical),
        sha256: manifest.sha256,
        inspectionId: manifest.inspectionId,
        recordedAt: `${manifest.publishedAt || manifest.inspectedAt || ""}`
      });
    }
    if (manifestCleaned) await syncDirectory(finalDir);
    return rows;
  }

  async recoverPublishedArtifactTransactions(finalDir) {
    const entries = (await fsp.readdir(finalDir, { withFileTypes: true }).catch(() => []))
      .filter((entry) => entry.isFile() && isPublishedArtifactTransactionName(entry.name))
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const transactionPath = path.join(finalDir, entry.name);
      const record = await this.readPublishedManifestRecord(transactionPath);
      const transaction = record?.value;
      if (!isPublishedArtifactTransaction(transaction)) continue;
      if (publishedArtifactTransactionName(transaction.transactionId) !== entry.name) continue;
      if (transaction.ownerId === PUBLISHED_ARTIFACT_TRANSACTION_OWNER_ID) {
        const manifestPath = path.join(finalDir, publishedArtifactManifestName(transaction.file));
        const expected = publishedArtifactManifestFromTransaction(transaction);
        if (!await publishedManifestMatches(manifestPath, expected, this)) continue;
      }
      await this.recoverPublishedArtifactTransaction(finalDir, transactionPath, record);
    }
  }

  async recoverPublishedArtifactTransaction(finalDir, transactionPath, record) {
    const transaction = record.value;
    const target = path.join(finalDir, transaction.file);
    const stage = path.join(finalDir, transaction.stageFile);
    const manifestPath = path.join(finalDir, publishedArtifactManifestName(transaction.file));
    const expectedManifest = publishedArtifactManifestFromTransaction(transaction);
    const targetValid = await transactionTargetIsValid(target, transaction);
    let committed = await publishedManifestMatches(manifestPath, expectedManifest, this);
    if (targetValid && !committed) {
      const existing = await fsp.lstat(manifestPath).catch(() => null);
      if (!existing) {
        await writeJsonExclusive(manifestPath, expectedManifest).catch((error) => {
          if (error?.code !== "EEXIST") throw error;
        });
        await syncDirectory(finalDir);
        committed = await publishedManifestMatches(manifestPath, expectedManifest, this);
      }
    }
    await unlinkIfIdentity(stage, transaction.stageIdentity).catch(() => false);
    await unlinkIfIdentity(transactionPath, record.identity).catch(() => false);
    await syncDirectory(finalDir);
    return committed;
  }

  async readPublishedManifestRecord(manifestPath) {
    const noFollow = Number(fsConstants.O_NOFOLLOW) || 0;
    let handle = null;
    try {
      handle = await fsp.open(manifestPath, fsConstants.O_RDONLY | noFollow);
      const stat = await handle.stat({ bigint: true });
      if (!stat.isFile() || Number(stat.size) <= 0 || Number(stat.size) > 65536) return null;
      return {
        value: JSON.parse(await handle.readFile({ encoding: "utf8" })),
        identity: fileIdentity(stat)
      };
    } catch {
      return null;
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  async isLegacyFinalPath(taskDir, absolute) {
    const finalDir = await fsp.realpath(path.join(taskDir, "final")).catch(() => "");
    const canonical = await fsp.realpath(absolute).catch(() => path.resolve(absolute));
    return Boolean(finalDir && canonical !== finalDir && isPathInside(finalDir, canonical));
  }

  async collectLegacyFinalEntries(taskDir) {
    const rows = [];
    await this.walkFiles(path.join(taskDir, "final"), rows, taskDir);
    return rows.map((row) => ({
      absolute: row.absolute,
      source: "legacy-final",
      title: row.file,
      recordedAt: row.updatedAt
    }));
  }

  async collectLegacyAgentFileEntries(projectId, taskId, workDir) {
    const traceDir = this.legacyChatMigration?.harnessTraceDir?.(projectId) || "";
    if (!traceDir) return [];
    const traceFiles = (await fsp.readdir(traceDir).catch(() => []))
      .filter((file) => file.endsWith(".jsonl"))
      .sort();
    const files = new Map();
    for (const file of traceFiles) {
      const content = await fsp.readFile(path.join(traceDir, file), "utf8").catch(() => "");
      for (const line of content.split(/\n+/)) {
        const trace = parseJsonLine(line);
        if (trace?.projectId !== projectId || trace?.taskId !== taskId) continue;
        const calls = Array.isArray(trace.toolCalls) ? trace.toolCalls : [];
        const published = calls.filter((call) => call?.name === "publish_artifact" && call?.ok === true);
        const usesPublishBoundary = Number(trace.artifactProtocolVersion) >= 2;
        const candidates = published.length
          ? published
          : (usesPublishBoundary
            ? []
            : calls.filter((call) => ["write", "edit"].includes(call?.name) && call?.ok === true));
        for (const call of candidates) {
          const raw = `${call?.artifactPath || call?.args?.path || ""}`.trim();
          if (!raw) continue;
          const resolved = path.resolve(path.isAbsolute(raw) ? raw : path.join(workDir, raw));
          const absolute = await fsp.realpath(resolved).catch(() => resolved);
          files.set(absolute, {
            absolute,
            source: published.length ? "agent-publish" : "agent-trace",
            title: `${call?.args?.title || ""}`,
            recordedAt: `${trace.persistedAt || ""}`
          });
        }
      }
    }
    return [...files.values()];
  }

  async describeRecordedAgentFile(absolute, taskDir, workDir, entry = {}) {
    const canonical = await fsp.realpath(absolute);
    const stat = await fsp.stat(canonical);
    if (!stat.isFile()) return null;
    if (![taskDir, workDir].some((root) => isPathInside(root, canonical))) return null;
    const ext = path.extname(canonical).toLowerCase();
    let content = "";
    if (RECORDED_TEXT_EXTENSIONS.has(ext)) {
      content = await readTextPrefixNoFollow(canonical, MAX_FILE_CARD_PREVIEW_BYTES)
        .catch(() => "");
    }
    const managed = isPathInside(taskDir, canonical);
    const storage = managed ? "task" : "workspace";
    const relative = path.relative(managed ? taskDir : workDir, canonical);
    const artifact = {
      title: `${entry.title || ""}` || path.basename(canonical),
      file: path.basename(canonical),
      absolute: canonical,
      relative,
      format: ext.slice(1),
      bytes: stat.size,
      size: stat.size,
      updatedAt: stat.mtime.toISOString(),
      content,
      source: `${entry.source || "agent-trace"}`,
      sha256: `${entry.sha256 || ""}`,
      inspectionId: `${entry.inspectionId || ""}`,
      storage,
      managed
    };
    return {
      ...artifact,
      artifact
    };
  }

  async walkFiles(dir, rows, baseDir) {
    if (!(await exists(dir))) return;
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (
        isPublishedArtifactManifestName(entry.name)
        || isPublishedArtifactTransactionName(entry.name)
        || entry.name.startsWith(".publish-")
        || entry.name.startsWith(".manifest-")
      ) continue;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await this.walkFiles(absolute, rows, baseDir);
      } else if (entry.isFile()) {
        const stat = await fsp.stat(absolute);
        rows.push({
          file: entry.name,
          absolute,
          relative: path.relative(baseDir, absolute),
          size: stat.size,
          updatedAt: stat.mtime.toISOString()
        });
      }
    }
  }

  async resolveTaskFile(projectId, taskId, file, { followFinal = false } = {}) {
    const requestedTaskDir = path.resolve(this.getTaskDir(projectId, taskId));
    const taskDir = await fsp.realpath(requestedTaskDir);
    const raw = typeof file === "string" ? file : file?.absolute || file?.relative || "";
    const requested = path.resolve(path.isAbsolute(raw) ? raw : path.join(requestedTaskDir, raw));
    const lexicallyScoped = isPathInside(requestedTaskDir, requested)
      || isPathInside(taskDir, requested);
    if (!raw || !lexicallyScoped || requested === requestedTaskDir || requested === taskDir) {
      throw new Error("只能管理当前任务目录内的文件。");
    }
    const parent = await fsp.realpath(path.dirname(requested));
    if (!isPathInside(taskDir, parent)) {
      throw new Error("文件路径经符号链接越出当前任务目录。");
    }
    const entryPath = path.join(parent, path.basename(requested));
    const entryStat = await fsp.lstat(entryPath);
    if (!followFinal) return { taskDir, absolute: entryPath, entryStat };
    const absolute = await fsp.realpath(entryPath);
    if (!isPathInside(taskDir, absolute) || absolute === taskDir) {
      throw new Error("文件路径经符号链接越出当前任务目录。");
    }
    return { taskDir, absolute, entryPath, entryStat };
  }

  async previewTaskFile(projectId, taskId, file, options = {}) {
    const { taskDir, absolute } = await this.resolveTaskFile(projectId, taskId, file, { followFinal: true });
    const noFollow = Number(fsConstants.O_NOFOLLOW) || 0;
    const handle = await fsp.open(absolute, fsConstants.O_RDONLY | noFollow);
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error("只能预览文件。");
      const ext = path.extname(absolute).toLowerCase();
      const textExtensions = new Set([".md", ".txt", ".json", ".html", ".htm", ".css", ".js", ".mjs", ".cjs", ".csv", ".log"]);
      const relative = path.relative(taskDir, absolute);
      if (!textExtensions.has(ext)) {
        return {
          file: path.basename(absolute),
          absolute,
          relative,
          size: stat.size,
          updatedAt: stat.mtime.toISOString(),
          content: "这个文件不是文本格式，暂不支持内置预览。",
          previewable: false,
          storage: "task",
          managed: true
        };
      }
      const fullHtml = options.fullHtml === true && [".html", ".htm"].includes(ext);
      if (fullHtml && stat.size > MAX_FULL_HTML_PREVIEW_BYTES) {
        throw new Error("HTML 成品超过 16 MiB 内置预览上限，请导出后查看。");
      }
      return {
        file: path.basename(absolute),
        absolute,
        relative,
        size: stat.size,
        updatedAt: stat.mtime.toISOString(),
        content: fullHtml
          ? await handle.readFile({ encoding: "utf8" })
          : truncate(await readTextPrefix(handle, MAX_FILE_CARD_PREVIEW_BYTES), 32000),
        previewable: true,
        storage: "task",
        managed: true
      };
    } finally {
      await handle.close().catch(() => {});
    }
  }

  async resolveRegisteredTaskArtifact(projectId, taskId, file, options = {}) {
    await this.getTask(projectId, taskId);
    const raw = typeof file === "string" ? file : file?.absolute || file?.relative || "";
    if (!raw) throw new Error("产物文件路径缺失。");
    const requested = path.resolve(
      path.isAbsolute(raw) ? raw : path.join(this.getTaskDir(projectId, taskId), raw)
    );
    const target = await fsp.realpath(requested);
    const files = await this.listTaskFiles(projectId, taskId);
    const artifact = files.find((entry) => entry.absolute === target);
    if (!artifact) throw new Error("这个文件不属于当前任务的已登记产物。");
    if (options.requireManagedPublish === true) {
      const taskDir = await fsp.realpath(this.getTaskDir(projectId, taskId));
      const finalDir = await fsp.realpath(path.join(taskDir, "final")).catch(() => "");
      const manifested = await this.collectPublishedManifestEntries(taskDir);
      const isManifested = manifested.some((entry) => entry.absolute === target);
      if (
        artifact.source !== "agent-publish"
        || artifact.managed !== true
        || artifact.storage !== "task"
        || !finalDir
        || target === finalDir
        || !isPathInside(finalDir, target)
        || !isManifested
      ) {
        throw new Error("只能删除当前任务明确发布的受管成品快照。");
      }
    }
    return artifact;
  }

  async previewRegisteredTaskArtifact(projectId, taskId, file) {
    const artifact = await this.resolveRegisteredTaskArtifact(projectId, taskId, file);
    if (!artifact.managed) throw new Error("工作空间产物不属于任务内置预览边界。");
    return this.previewTaskFile(projectId, taskId, artifact.absolute, { fullHtml: true });
  }

  async deleteTaskFile(projectId, taskId, file) {
    const operation = () => this._deleteTaskFile(projectId, taskId, file);
    return this.taskFileWrites?.run
      ? this.taskFileWrites.run(`${projectId}::${taskId}`, operation)
      : operation();
  }

  async _deleteTaskFile(projectId, taskId, file) {
    const scoped = await this.resolveTaskFile(projectId, taskId, file);
    if (!scoped.entryStat.isFile() || scoped.entryStat.isSymbolicLink()) {
      throw new Error("只能删除普通成品文件。");
    }
    const artifact = await this.resolveRegisteredTaskArtifact(
      projectId,
      taskId,
      scoped.absolute,
      { requireManagedPublish: true }
    );
    const workspace = await this.resolveTaskWorkspace(projectId, taskId);
    const task = workspace.task;
    const taskDir = await fsp.realpath(this.getTaskDir(projectId, taskId));
    const indexFile = path.join(taskDir, AGENT_FILE_INDEX_NAME);
    const current = await this.ensureAgentFileIndex(
      projectId,
      taskId,
      workspace.workspacePath || taskDir
    );
    await fsp.unlink(artifact.absolute);
    await fsp.unlink(path.join(
      path.dirname(artifact.absolute),
      publishedArtifactManifestName(path.basename(artifact.absolute))
    )).catch(() => {});
    const files = (current.files || []).filter((entry) => entry.absolute !== artifact.absolute);
    await writeJsonAtomic(indexFile, {
      ...current,
      version: AGENT_FILE_INDEX_VERSION,
      reconciledAt: new Date().toISOString(),
      files
    });
    if (path.resolve(`${task.lastArtifact || ""}`) === path.resolve(artifact.absolute)) {
      const replacement = files
        .filter((entry) => entry.source === "agent-publish")
        .sort((left, right) => `${right.recordedAt || ""}`.localeCompare(`${left.recordedAt || ""}`))[0];
      await this.updateTask(projectId, taskId, { lastArtifact: replacement?.absolute || "" });
    }
    return { deleted: true, absolute: artifact.absolute };
  }

  getReferencesFile(projectId, taskId) {
    return path.join(this.getTaskDir(projectId, taskId), "sources", "references.json");
  }

  async listReferences(projectId, taskId) {
    if (!projectId || !taskId) return [];
    const file = this.getReferencesFile(projectId, taskId);
    return readJson(file, []);
  }

  async addReference(projectId, taskId, reference = {}) {
    if (!projectId || !taskId) throw new Error("请先选择一个任务，再引用参考资料。");
    await this.getTask(projectId, taskId);
    const refs = await this.listReferences(projectId, taskId);
    const sourceKey = reference.url || reference.absolute || reference.title || crypto.randomUUID();
    const existing = refs.find((item) => item.sourceKey === sourceKey);
    if (existing) return existing;

    const content = await this.buildReferenceContent(reference);
    const next = {
      id: crypto.randomUUID(),
      sourceKey,
      sourceType: reference.sourceType || (reference.url ? "internet" : "local"),
      title: reference.title || "未命名参考",
      url: reference.url || "",
      absolute: reference.absolute || "",
      relative: reference.relative || "",
      snippet: reference.snippet || "",
      content,
      relevanceScore: Number(reference.relevanceScore || 0),
      credibilityScore: Number(reference.credibilityScore || 0),
      qualityScore: Number(reference.qualityScore || 0),
      relevanceMatched: Array.isArray(reference.relevanceMatched) ? reference.relevanceMatched : [],
      aiScreening: reference.aiScreening || null,
      verificationStatus: reference.verificationStatus || "",
      verificationEvidence: reference.verificationEvidence || "",
      verifiedForFacts: reference.verifiedForFacts === true,
      addedAt: new Date().toISOString()
    };
    refs.unshift(next);
    await writeJsonAtomic(this.getReferencesFile(projectId, taskId), refs);
    return next;
  }

  async removeReference(projectId, taskId, referenceId) {
    const refs = await this.listReferences(projectId, taskId);
    const next = refs.filter((item) => item.id !== referenceId);
    await writeJsonAtomic(this.getReferencesFile(projectId, taskId), next);
    return next;
  }

  async buildReferenceContent(reference = {}) {
    if (reference.sourceType === "local" && reference.absolute) {
      const content = await readProjectLocalReference(
        this.paths.projectRoot,
        reference.absolute
      );
      if (content !== null) return content;
    }
    return `${reference.content || reference.snippet || ""}`;
  }

  async bundleReferences(projectId, taskId, maxChars = 18000) {
    const refs = await this.listReferences(projectId, taskId);
    if (!refs.length) return "";
    const parts = ["# 已引用参考资料"];
    let remaining = maxChars;
    for (const item of refs) {
      if (remaining <= 0) break;
      const block = [
        `\n\n## ${item.title}`,
        item.url ? `来源：${item.url}` : "",
        item.relative || item.absolute ? `本地：${item.relative || item.absolute}` : "",
        item.verificationStatus ? `验证状态：${item.verificationStatus}${item.verificationEvidence ? `；${item.verificationEvidence}` : ""}` : "",
        item.verifiedForFacts === false ? "事实使用限制：该来源未通过正文抓取或交叉核验，不能单独支撑具体事实。" : "",
        item.aiScreening?.decision ? `${item.aiScreening.method === "heuristic" ? "本地甄别" : "AI甄别"}：${item.aiScreening.decision}${item.aiScreening.reason ? `；${item.aiScreening.reason}` : ""}` : "",
        Number(item.relevanceScore || 0) ? `相关度：${item.relevanceScore}；可信度：${item.credibilityScore || 0}` : "",
        "",
        item.content || item.snippet || ""
      ].filter(Boolean).join("\n");
      parts.push(truncate(block, remaining));
      remaining -= block.length;
    }
    return truncate(parts.join("\n"), maxChars);
  }
}

async function readTextPrefixNoFollow(file, maxBytes) {
  const handle = await fsp.open(
    file,
    fsConstants.O_RDONLY | (Number(fsConstants.O_NOFOLLOW) || 0)
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("只能读取普通文件。");
    return readTextPrefix(handle, maxBytes);
  } finally {
    await handle.close().catch(() => {});
  }
}

async function readTextPrefix(handle, maxBytes) {
  const limit = Math.max(1, Math.floor(Number(maxBytes) || 1));
  const buffer = Buffer.allocUnsafe(limit);
  const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
  return buffer.subarray(0, bytesRead).toString("utf8");
}

async function readProjectLocalReference(projectRoot, requestedPath) {
  const lexicalRoot = path.resolve(`${projectRoot || ""}`);
  const requested = path.resolve(`${requestedPath || ""}`);
  if (!projectRoot || !requestedPath || !isPathInside(lexicalRoot, requested)) return null;
  const canonicalRoot = await fsp.realpath(lexicalRoot).catch(() => "");
  if (!canonicalRoot) return null;
  const entryStat = await fsp.lstat(requested).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!entryStat) return null;
  if (entryStat.isSymbolicLink()) throw new Error("本地参考文件不能是符号链接。");
  const canonical = await fsp.realpath(requested);
  if (!isPathInside(canonicalRoot, canonical) || canonical === canonicalRoot) {
    throw new Error("本地参考文件经路径解析越出项目工作区。");
  }
  const handle = await fsp.open(
    canonical,
    fsConstants.O_RDONLY | (Number(fsConstants.O_NOFOLLOW) || 0)
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("只能引用普通文件。");
    const maxBytes = 16 * 1024 * 1024;
    if (stat.size > maxBytes) {
      throw new Error(`参考文件超过 ${Math.round(maxBytes / 1024 / 1024)} MB，为避免静默丢失内容，本次未导入。`);
    }
    return handle.readFile({ encoding: "utf8" });
  } finally {
    await handle.close().catch(() => {});
  }
}

function fileIdentity(stat) {
  return {
    dev: `${stat.dev}`,
    ino: `${stat.ino}`,
    bytes: Number(stat.size)
  };
}

function matchesFileIdentity(stat, expected) {
  return Boolean(
    stat?.isFile?.()
    && !stat.isSymbolicLink?.()
    && `${stat.dev}` === `${expected?.dev || ""}`
    && `${stat.ino}` === `${expected?.ino || ""}`
    && Number(stat.size) === Number(expected?.bytes)
  );
}

async function unlinkIfIdentity(file, expected) {
  const stat = await fsp.lstat(file, { bigint: true }).catch(() => null);
  if (!matchesFileIdentity(stat, expected)) return false;
  await fsp.unlink(file);
  return true;
}

async function transactionTargetIsValid(target, transaction) {
  const before = await fsp.lstat(target, { bigint: true }).catch(() => null);
  if (!matchesFileIdentity(before, transaction.stageIdentity)) return false;
  const digest = await sha256File(target).catch(() => "");
  const after = await fsp.lstat(target, { bigint: true }).catch(() => null);
  return matchesFileIdentity(after, transaction.stageIdentity)
    && digest === transaction.sha256;
}

async function publishedManifestMatches(manifestPath, expected, actions) {
  const record = await actions.readPublishedManifestRecord(manifestPath);
  const manifest = record?.value;
  if (!isPublishedArtifactManifest(manifest)) return false;
  return manifest.file === expected.file
    && Number(manifest.bytes) === Number(expected.bytes)
    && manifest.sha256 === expected.sha256
    && manifest.inspectionId === expected.inspectionId;
}

async function writeJsonExclusive(destination, value) {
  const temporary = path.join(
    path.dirname(destination),
    `.manifest-${process.pid}-${crypto.randomBytes(12).toString("hex")}.tmp`
  );
  let handle = null;
  try {
    handle = await fsp.open(
      temporary,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
      0o600
    );
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fsp.link(temporary, destination);
  } finally {
    await handle?.close().catch(() => {});
    await fsp.unlink(temporary).catch(() => {});
  }
}

async function syncDirectory(directory) {
  const handle = await fsp.open(directory, fsConstants.O_RDONLY).catch(() => null);
  if (!handle) return;
  try {
    await handle.sync().catch(() => {});
  } finally {
    await handle.close().catch(() => {});
  }
}

async function sha256File(file) {
  const hash = crypto.createHash("sha256");
  const handle = await fsp.open(file, fsConstants.O_RDONLY | (Number(fsConstants.O_NOFOLLOW) || 0));
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close().catch(() => {});
  }
  return hash.digest("hex");
}

function parseJsonLine(line = "") {
  if (!line.trim()) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

module.exports = Object.fromEntries(
  Object.getOwnPropertyNames(ProjectFileReferenceActions.prototype)
    .filter((name) => name !== "constructor")
    .map((name) => [name, ProjectFileReferenceActions.prototype[name]])
);
