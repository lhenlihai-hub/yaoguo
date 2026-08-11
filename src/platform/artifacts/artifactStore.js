// @ts-check
// ArtifactStore —— 工作流产物的存储与可审计全文检索层。
//
// 业界对标 2025-2026:
//   - Anthropic Claude Code 的源码 Read/Grep:agent 检索"过去产出"是长任务一致性的命门
//   - Cursor / Devin:run-scoped artifact 索引 + LLM 可主动查询
//
// 设计要点:
//   1. 保留原有 saveTextArtifact + upsertProjectIndex 行为,向后兼容
//   2. 索引层同步切分 chunk 并写入 append-only chunks.jsonl
//   3. 检索 API:searchArtifacts (BM25) + readArtifact (段落级精读)
//   4. 路径闭包:readArtifact 只接受 ArtifactStore 管辖的 artifactId 或 (projectId,runId,stepId,artifactType),
//      不开放任意文件路径,防止 LLM 越权访问。

const path = require("node:path");
const fsp = require("node:fs/promises");
const { ensureDir, readJson, writeJsonAtomic, writeTextAtomic, appendJsonl, exists } = require("../shared/fs");
const { estimateTokens, hashObject, sha1 } = require("../shared/text");
const { isPathInside } = require("../shared/pathSafety");
const { WorkspaceLayout } = require("../storage/workspaceLayout");
const { splitIntoChunks, tokenize, buildBM25Index, searchBM25, extractSnippet } = require("./chunkIndex");

class ArtifactStore {
  constructor(paths = {}) {
    this.paths = paths;
    this.layout = new WorkspaceLayout(paths);
  }

  async ensureProject(projectId = "") {
    await ensureDir(this.layout.artifactDir(projectId));
  }

  normalizeArtifact(input = {}) {
    const now = new Date().toISOString();
    const content = `${input.content || ""}`;
    // id 按"逻辑位置"稳定:projectId:taskId:runId:stepId:artifactType。
    // 重跑同一 step 同 type 时 id 保持不变;版本演化由 contentHash + version 表达。
    // 这样:
    //   - upsertProjectIndex 自然以同 id 覆盖旧版本
    //   - loadProjectChunks 按 (artifactId, contentHash) 取最新版本时旧版本被天然淘汰
    //   - readArtifact by id 永远拿到逻辑位置的当前版本,不会再读到错配 manifest
    return {
      id: input.id || sha1(`${input.projectId || ""}:${input.taskId || ""}:${input.runId || ""}:${input.stepId || ""}:${input.artifactType || "artifact"}`).slice(0, 16),
      version: Number(input.version || 1),
      projectId: input.projectId || "",
      taskId: input.taskId || "",
      runId: input.runId || "",
      stepId: input.stepId || "",
      artifactType: input.artifactType || "artifact",
      title: input.title || input.name || input.artifactType || "未命名资产",
      format: input.format || "markdown",
      createdAt: input.createdAt || now,
      updatedAt: now,
      contentHash: sha1(content),
      estimatedTokens: estimateTokens(content),
      metadata: input.metadata || {}
    };
  }

  stepArtifactDir({ projectId = "", taskId = "", runId = "", stepId = "" } = {}) {
    if (runId && stepId) return this.layout.stepDir(projectId, taskId, runId, stepId);
    return this.layout.artifactDir(projectId, taskId || "project");
  }

  // ---- 索引文件路径 ----
  chunksFile(projectId = "") {
    return path.join(this.layout.artifactDir(projectId), "chunks.jsonl");
  }

  async saveTextArtifact(input = {}) {
    const artifact = this.normalizeArtifact(input);
    const dir = this.stepArtifactDir(artifact);
    await ensureDir(dir);
    const baseName = input.fileName || (artifact.artifactType === "summary" ? "summary.md" : "output.md");
    const existingContentPath = input.existingContentPath
      ? await this.resolveExistingRunContentPath(artifact, input.existingContentPath, artifact.contentHash)
      : "";
    const contentPath = existingContentPath || path.join(dir, baseName);
    const manifestPath = path.join(dir, `${artifact.artifactType}.artifact.json`);
    const summaryPath = input.summary ? path.join(dir, "summary.md") : "";
    const fullContent = `${input.content || ""}`;
    if (!existingContentPath) await writeTextAtomic(contentPath, fullContent);
    if (input.summary) await writeTextAtomic(summaryPath, `${input.summary}`);
    const manifest = {
      ...artifact,
      paths: {
        content: contentPath,
        summary: summaryPath || null
      },
      summaryHash: input.summary ? sha1(input.summary) : ""
    };
    await writeJsonAtomic(manifestPath, manifest);
    await this.upsertProjectIndex(artifact.projectId, manifest);
    // 同步写 chunks 索引。
    // 失败不抛——保留 saveTextArtifact 的"必成功"语义,索引层降级为 best-effort。
    try {
      await this._indexChunks(manifest, fullContent);
    } catch (err) {
      // 仅记录,不破坏 save 主流程。下一次 save 同 artifactId 会重新建索引覆盖。
      // 真线上观测以 telemetry 为准,此处只防崩。
    }
    return manifest;
  }

  async resolveExistingRunContentPath(artifact, requestedPath, expectedHash) {
    if (!artifact.projectId || !artifact.taskId || !artifact.runId) {
      throw new Error("复用已有正文需要完整的 project/task/run 范围。");
    }
    const requested = path.resolve(`${requestedPath || ""}`);
    const lexicalRoot = this.layout.runDir(artifact.projectId, artifact.taskId, artifact.runId);
    if (!isPathInside(lexicalRoot, requested) || requested === path.resolve(lexicalRoot)) {
      throw new Error("已有正文路径超出当前运行范围。");
    }
    const entry = await fsp.lstat(requested);
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("已有正文必须是普通文件。");
    const [realRoot, realSource] = await Promise.all([
      fsp.realpath(lexicalRoot),
      fsp.realpath(requested)
    ]);
    if (!isPathInside(realRoot, realSource) || realSource === realRoot) {
      throw new Error("已有正文通过符号链接超出当前运行范围。");
    }
    const content = await fsp.readFile(realSource, "utf8");
    if (sha1(content) !== expectedHash) throw new Error("已有正文与待索引内容不一致。");
    return realSource;
  }

  async upsertProjectIndex(projectId = "", artifact = {}) {
    if (!projectId) return null;
    const indexFile = path.join(this.layout.artifactDir(projectId), "index.json");
    const index = await readJson(indexFile, { version: 1, artifacts: [] }) || { version: 1, artifacts: [] };
    const artifacts = Array.isArray(index.artifacts) ? index.artifacts : [];
    const next = artifacts.filter((item) => item.id !== artifact.id);
    next.push({
      id: artifact.id,
      artifactType: artifact.artifactType,
      title: artifact.title,
      projectId: artifact.projectId,
      taskId: artifact.taskId,
      runId: artifact.runId,
      stepId: artifact.stepId,
      contentHash: artifact.contentHash,
      estimatedTokens: artifact.estimatedTokens,
      updatedAt: artifact.updatedAt,
      paths: artifact.paths
    });
    await writeJsonAtomic(indexFile, {
      version: 1,
      updatedAt: new Date().toISOString(),
      artifacts: next.sort((a, b) => `${b.updatedAt || ""}`.localeCompare(`${a.updatedAt || ""}`)),
      indexHash: hashObject(next)
    });
    return indexFile;
  }

  // ---- 索引建立 ----

  /**
   * 切分 artifact 内容写入 chunks.jsonl,同一 artifactId 的新版本以 contentHash 区分,
   * append-only 历史保留(对齐 checkpointStore append-only 哲学,可支撑 fork/replay)。
   */
  async _indexChunks(manifest, content) {
    const projectId = manifest.projectId || "";
    if (!projectId) return; // 无项目 scope,索引无意义
    const text = `${content || ""}`.trim();
    if (!text) return;
    const chunks = splitIntoChunks(text);
    if (!chunks.length) return;

    const chunksPath = this.chunksFile(projectId);
    const now = new Date().toISOString();
    // chunkId 含 contentHash —— 不同版本的同 chunkIndex 永远不冲突。
    //
    // 每行带 totalChunks(本批所有 chunk 共享) —— crash-safety:
    // 半套写入时 loader 看到 chunks.length < totalChunks,不激活该 contentHash,
    // 仍用上一个齐全版本。等下次 save 完整跑通才切换。
    const totalChunks = chunks.length;
    const records = chunks.map((c) => ({
      chunkId: `${manifest.id}:${manifest.contentHash}:c${c.chunkIndex}`,
      artifactId: manifest.id,
      projectId,
      taskId: manifest.taskId || "",
      runId: manifest.runId || "",
      stepId: manifest.stepId || "",
      artifactType: manifest.artifactType || "",
      title: manifest.title || "",
      paragraphIndex: c.paragraphIndex,
      chunkIndex: c.chunkIndex,
      totalChunks,
      text: c.text,
      contentHash: manifest.contentHash,
      createdAt: now
    }));
    for (const row of records) {
      await appendJsonl(chunksPath, row);
    }
  }

  // ---- 索引加载(append-only patch-merge 语义) ----

  /**
   * 加载某项目下"最新且齐全"的 chunks。
   *
   * append-only + 完整性闸门:
   *   1. 按 (artifactId, contentHash) 分组累积 chunks
   *   2. 每组需收齐 totalChunks 条才视为"齐全"
   *   3. 对每个 artifactId,激活**最后一个齐全**的 contentHash
   *      —— 半套未完成的新版本(进程半途挂掉)不会顶掉前一个齐全版本
   *
   * 向后兼容:旧 row 没有 totalChunks 字段时,默认 expectedTotal=1
   *          (保守:每行视为独立完整,与旧"按 contentHash 切换"行为兼容)。
   *
   * @param {string} projectId
   * @returns {Promise<Array<any>>}
   */
  async loadProjectChunks(projectId = "") {
    if (!projectId) return [];
    const file = this.chunksFile(projectId);
    if (!(await exists(file))) return [];
    let content;
    try {
      content = await fsp.readFile(file, "utf8");
    } catch {
      return [];
    }
    /**
     * staging: artifactId → Map<contentHash, { chunks: any[], expectedTotal: number, order: number }>
     *   order 用来记录该 contentHash 在文件中"首次出现"的顺序,
     *   loader 据此找最后一个齐全 contentHash。
     */
    const staging = new Map();
    let orderSeq = 0;
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let row;
      try { row = JSON.parse(trimmed); } catch { continue; }
      if (!row?.artifactId || !row?.chunkId) continue;
      let arts = staging.get(row.artifactId);
      if (!arts) { arts = new Map(); staging.set(row.artifactId, arts); }
      let slot = arts.get(row.contentHash);
      if (!slot) {
        slot = {
          chunks: [],
          expectedTotal: Number.isFinite(row.totalChunks) ? row.totalChunks : 1,
          order: orderSeq++
        };
        arts.set(row.contentHash, slot);
      }
      slot.chunks.push(row);
    }
    const all = [];
    for (const arts of staging.values()) {
      // 在该 artifactId 下,选出 chunks.length >= expectedTotal 的所有 contentHash,
      // 然后取"最后出现"(order 最大)的那一份。半套(< expectedTotal)被自然忽略。
      let pick = null;
      for (const slot of arts.values()) {
        if (slot.chunks.length >= slot.expectedTotal) {
          if (!pick || slot.order > pick.order) pick = slot;
        }
      }
      if (pick) all.push(...pick.chunks);
    }
    return all;
  }

  // ---- 公开检索 API ----

  /**
   * 使用 BM25 检索 artifact chunks。
   * query / projectId 为空时返回空结果(运行时校验),所以 jsdoc 标 optional 让默认 {} 通过类型检查。
   *
   * @param {{
   *   query?: string,
   *   projectId?: string,
   *   taskId?: string,
   *   runId?: string,
   *   stepId?: string,
   *   artifactType?: string,
   *   topK?: number,
   *   snippetLength?: number
   * }} [options]
   * @returns {Promise<{
   *   hits: Array<any>,
   *   total: number,
   *   modeUsed: string
   * }>}
   */
  async searchArtifacts(options = {}) {
    const query = `${options.query || ""}`.trim();
    const projectId = `${options.projectId || ""}`;
    const topK = Math.max(1, Math.min(50, Number(options.topK) || 8));
    const snippetLength = Math.max(60, Math.min(600, Number(options.snippetLength) || 200));

    if (!query || !projectId) {
      return { hits: [], total: 0, modeUsed: "empty" };
    }

    // 1. 加载 + metadata prefilter
    const all = await this.loadProjectChunks(projectId);
    const filtered = all.filter((c) => {
      if (options.taskId && c.taskId !== options.taskId) return false;
      if (options.runId && c.runId !== options.runId) return false;
      if (options.stepId && c.stepId !== options.stepId) return false;
      if (options.artifactType && c.artifactType !== options.artifactType) return false;
      return true;
    });
    if (!filtered.length) return { hits: [], total: 0, modeUsed: "keyword" };

    // 2. BM25 关键词检索
    const bm25Index = buildBM25Index(filtered);
    const bm25Top = searchBM25(bm25Index, query, { topK: Math.max(20, topK * 3) });
    if (!bm25Top.length) {
      return { hits: [], total: 0, modeUsed: "keyword" };
    }

    // 3. 取 topK 并附 snippet + metadata
    const chunkById = new Map(filtered.map((c) => [c.chunkId, c]));
    const queryTerms = tokenize(query);
    const matchedByChunk = new Map(bm25Top.map((h) => [h.chunkId, h.matchedTerms || []]));
    const hits = bm25Top.slice(0, topK).map((h) => {
      const c = chunkById.get(h.chunkId);
      if (!c) return null;
      const termsForSnippet = matchedByChunk.get(h.chunkId)?.length ? matchedByChunk.get(h.chunkId) : queryTerms;
      const snippet = extractSnippet(c.text, termsForSnippet, { length: snippetLength });
      return {
        artifactId: c.artifactId,
        chunkId: c.chunkId,
        score: Number((h.score ?? 0).toFixed(6)),
        runId: c.runId,
        stepId: c.stepId,
        artifactType: c.artifactType,
        title: c.title,
        paragraphIndex: c.paragraphIndex,
        chunkIndex: c.chunkIndex,
        snippet
      };
    }).filter(Boolean);

    return { hits, total: bm25Top.length, modeUsed: "keyword" };
  }

  /**
   * 读取 artifact 全文(段落级 offset/limit)。
   *
   * 入参两种定位方式:
   *   - artifactId(优先)
   *   - (projectId, runId, stepId, artifactType) 联合定位
   * 路径闭包:不接受任意文件路径,只走 ArtifactStore 管辖的 artifact manifest。
   *
   * @param {{
   *   artifactId?: string,
   *   projectId?: string,
   *   runId?: string,
   *   stepId?: string,
   *   taskId?: string,
   *   artifactType?: string,
   *   offset?: number,
   *   limit?: number,
   *   maxChars?: number
   * }} [options]
   * @returns {Promise<{
   *   ok: boolean,
   *   reason?: string,
   *   artifactId?: string,
   *   meta?: any,
   *   totalParagraphs?: number,
   *   paragraphsRead?: { offset: number, limit: number, paragraphs: string[], charCount: number },
   *   truncated?: boolean,
   *   truncationReason?: "limit" | "maxChars" | "firstParagraphTooLong" | null
   * }>}
   */
  async readArtifact(options = {}) {
    const offset = Math.max(0, Number(options.offset) || 0);
    const limit = Math.max(1, Math.min(200, Number(options.limit) || 32));
    // maxChars 硬上限:防止单长段(无 \n\n)突破 context 预算。
    // 16000 字符 ≈ 5K tokens,够一次精读;边界 [500, 64000]。
    const maxChars = Math.max(500, Math.min(64000, Number(options.maxChars) || 16000));

    let manifest = null;
    if (options.artifactId && options.projectId) {
      manifest = await this._findManifestById(options.projectId, options.artifactId);
    } else if (options.projectId && options.runId && options.stepId && options.artifactType) {
      manifest = await this._findManifestByLocation({
        projectId: options.projectId,
        taskId: options.taskId || "",
        runId: options.runId,
        stepId: options.stepId,
        artifactType: options.artifactType
      });
    } else {
      return { ok: false, reason: "需要 artifactId+projectId 或 (projectId, runId, stepId, artifactType)" };
    }

    if (!manifest) return { ok: false, reason: "artifact not found" };
    const contentPath = manifest.paths?.content;
    if (!contentPath || !(await exists(contentPath))) {
      return { ok: false, reason: "artifact content file missing" };
    }
    const fullText = await fsp.readFile(contentPath, "utf8").catch(() => "");
    const paragraphs = fullText.split(/\n\s*\n+/).map((p) => p.trim()).filter(Boolean);
    const totalParagraphs = paragraphs.length;

    // 段落级 offset/limit + 字符级 maxChars 硬上限。
    // 边界:首段就 > maxChars 时截到 maxChars - marker.length,加 [truncated] 标记,
    // 让总输出严格 ≤ maxChars(maxChars 作为"输出字符上限"语义更严格)。
    const TRUNCATION_MARKER = "…[truncated]";
    const sliced = [];
    let charCount = 0;
    /** @type {"limit" | "maxChars" | "firstParagraphTooLong" | null} */
    let truncationReason = null;
    const start = offset;
    const end = Math.min(totalParagraphs, offset + limit);
    for (let i = start; i < end; i += 1) {
      const p = paragraphs[i];
      if (sliced.length === 0 && p.length > maxChars) {
        // maxChars 边界 [500, 64000] 远大于 marker 长度,sliceLen 必然 ≥ 1。
        const sliceLen = Math.max(1, maxChars - TRUNCATION_MARKER.length);
        const truncatedPara = `${p.slice(0, sliceLen)}${TRUNCATION_MARKER}`;
        sliced.push(truncatedPara);
        charCount = truncatedPara.length; // 实际输出字符数,严格 ≤ maxChars
        truncationReason = "firstParagraphTooLong";
        break;
      }
      if (charCount + p.length > maxChars) {
        truncationReason = "maxChars";
        break;
      }
      sliced.push(p);
      charCount += p.length;
    }
    if (!truncationReason && end < totalParagraphs) truncationReason = "limit";
    const truncated = truncationReason !== null;

    return {
      ok: true,
      artifactId: manifest.id,
      meta: {
        projectId: manifest.projectId,
        taskId: manifest.taskId,
        runId: manifest.runId,
        stepId: manifest.stepId,
        artifactType: manifest.artifactType,
        title: manifest.title,
        updatedAt: manifest.updatedAt,
        estimatedTokens: manifest.estimatedTokens,
        contentHash: manifest.contentHash
      },
      totalParagraphs,
      paragraphsRead: { offset, limit, paragraphs: sliced, charCount },
      truncated,
      truncationReason
    };
  }

  async _findManifestById(projectId, artifactId) {
    const indexFile = path.join(this.layout.artifactDir(projectId), "index.json");
    const index = await readJson(indexFile, { artifacts: [] });
    const hit = (index?.artifacts || []).find((a) => a.id === artifactId);
    if (!hit) return null;
    // index 里只有摘要;manifest 在 step 目录里
    const manifestPath = path.join(path.dirname(hit.paths?.content || ""), `${hit.artifactType}.artifact.json`);
    const manifest = await readJson(manifestPath, null);
    // 防御性校验:stable id 之下理论上 manifest.id 必然等于 artifactId,
    // 但若 index.json 与 manifest.json 因为 fork/手工编辑/路径错位而不一致,
    // 拒绝返回错配的 manifest(否则会读到非预期内容)。
    if (!manifest || manifest.id !== artifactId) return null;
    return manifest;
  }

  async _findManifestByLocation({ projectId, taskId, runId, stepId, artifactType }) {
    const dir = this.layout.stepDir(projectId, taskId || "", runId, stepId);
    const manifestPath = path.join(dir, `${artifactType}.artifact.json`);
    return readJson(manifestPath, null);
  }
}

module.exports = {
  ArtifactStore
};
