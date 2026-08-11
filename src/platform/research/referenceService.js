const {
  fs,
  fsp,
  path,
  uniqueValues,
  toSearchTerms,
  isProcessLocalReference,
  countOccurrences,
  buildSnippet
} = require("../runtime");
const { isPathInside } = require("../shared/pathSafety");
const { throwIfAborted } = require("./referenceAbort");

class ReferenceService {
  constructor(paths, settingsService, webSearchService, projectService) {
    this.paths = paths;
    this.settingsService = settingsService;
    this.webSearchService = webSearchService;
    this.projectService = projectService;
  }

  async search({ query = "", projectId = "", taskId = "", scope = "all", signal = null } = {}) {
    throwIfAborted(signal);
    const keyword = `${query || ""}`.trim();
    if (!keyword) throw new Error("请输入参考关键词或主题。");

    const settings = await this.settingsService.get();
    const config = settings.referenceSearch || {};
    const result = {
      query: keyword,
      scope,
      createdAt: new Date().toISOString(),
      internet: [],
      local: [],
      notices: []
    };

    const internetTask = scope !== "local"
      ? this.searchInternet(keyword, settings.webSearch || {}, config, signal)
      : Promise.resolve({ results: [] });
    const localTask = scope !== "internet"
      ? this.searchLocal({ query: keyword, projectId, taskId, config, signal })
      : Promise.resolve([]);
    const [internetResult, localResult] = await Promise.allSettled([internetTask, localTask]);
    throwIfAborted(signal);
    if (internetResult.status === "fulfilled") {
      result.internet = internetResult.value.results || [];
      if (internetResult.value.notice) result.notices.push(internetResult.value.notice);
    } else {
      result.notices.push(`联网参考检索失败：${internetResult.reason.message}`);
    }
    if (localResult.status === "fulfilled") {
      result.local = localResult.value || [];
    } else {
      result.notices.push(`本地参考检索失败：${localResult.reason.message}`);
    }

    return result;
  }

  async searchInternet(query, webConfig, referenceConfig, signal = null) {
    const maxResults = referenceConfig.maxInternetResults || 18;
    const seen = new Set();
    const rows = [];
    const chunk = await this.webSearchService.searchConfiguredOrPublic(query, { ...webConfig, signal });
    for (const item of chunk) {
      const url = `${item.url || ""}`.trim();
      if (!url || seen.has(url)) continue;
      seen.add(url);
      rows.push({
        sourceType: "internet",
        title: item.title || "未命名网页",
        url,
        snippet: item.snippet || "",
        datePublished: item.datePublished || "",
        query,
        searchProvider: item.searchProvider || ""
      });
    }
    return {
      results: rows.slice(0, maxResults)
    };
  }

  async searchLocal({ query, projectId = "", taskId = "", config = {}, signal = null }) {
    throwIfAborted(signal);
    const maxResults = config.maxLocalResults || 30;
    const roots = await this.buildLocalRoots(projectId, taskId);
    const files = [];
    for (const root of roots) {
      throwIfAborted(signal);
      await this.collectSearchableFiles(root, files, root, config);
    }

    const terms = toSearchTerms(query);
    const seen = new Set();
    const rows = [];
    for (const file of files) {
      throwIfAborted(signal);
      if (seen.has(file.absolute)) continue;
      seen.add(file.absolute);
      const row = await this.scoreLocalFile(file, terms, query, config).catch(() => null);
      if (row) rows.push(row);
    }

    return rows
      .filter((item) => !isProcessLocalReference(item))
      .sort((a, b) => b.score - a.score || `${b.updatedAt}`.localeCompare(`${a.updatedAt}`))
      .slice(0, maxResults);
  }

  async buildLocalRoots(projectId, taskId) {
    const roots = [];
    if (this.projectService && projectId) {
      if (taskId) roots.push(this.projectService.getTaskDir(projectId, taskId));
      roots.push(this.projectService.getProjectDir(projectId));
    }
    roots.push(this.paths.assetsDir);
    return uniqueValues(roots.map((item) => path.resolve(item))).filter((item) => fs.existsSync(item));
  }

  async collectSearchableFiles(root, rows, baseDir, config) {
    const maxBytes = config.maxLocalFileBytes || 1200000;
    const extensions = new Set(config.localExtensions || [".md", ".txt", ".json"]);
    const skippedDirs = new Set(["node_modules", ".git", ".yaoguo", "dist", "build", ".DS_Store"]);
    const entries = await fsp.readdir(root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (skippedDirs.has(entry.name)) continue;
      // 本地检索是资料入口，不跟随符号链接穿越工作区边界。
      if (entry.isSymbolicLink()) continue;
      const absolute = path.join(root, entry.name);
      if (entry.isDirectory()) {
        if (this.isRetiredProjectMemoryDirectory(absolute)) continue;
        await this.collectSearchableFiles(absolute, rows, baseDir, config);
        continue;
      }
      const ext = path.extname(entry.name).toLowerCase();
      if (!extensions.has(ext)) continue;
      const [realBase, realAbsolute] = await Promise.all([
        fsp.realpath(baseDir).catch(() => path.resolve(baseDir)),
        fsp.realpath(absolute).catch(() => "")
      ]);
      if (!realAbsolute || !isPathInside(realBase, realAbsolute)) continue;
      const stat = await fsp.stat(absolute).catch(() => null);
      if (!stat || stat.size > maxBytes) continue;
      rows.push({
        sourceType: "local",
        title: entry.name,
        absolute,
        relative: path.relative(baseDir, absolute),
        root: baseDir,
        size: stat.size,
        updatedAt: stat.mtime.toISOString()
      });
    }
  }

  isRetiredProjectMemoryDirectory(directory = "") {
    const projectsDir = `${this.paths?.projectsDir || ""}`.trim();
    if (!projectsDir) return false;
    const root = path.resolve(projectsDir);
    const absolute = path.resolve(`${directory || ""}`);
    if (!isPathInside(root, absolute)) return false;
    const segments = path.relative(root, absolute).split(path.sep).filter(Boolean);
    return (segments.length === 2 && segments[1] === "memory")
      || (segments.length === 4 && segments[1] === "tasks" && segments[3] === "memory");
  }

  async scoreLocalFile(file, terms, query, config) {
    const content = await fsp.readFile(file.absolute, "utf8");
    const lowerContent = content.toLowerCase();
    const lowerPath = `${file.relative} ${file.title}`.toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (lowerPath.includes(term)) score += term === `${query}`.toLowerCase() ? 90 : 45;
      const count = countOccurrences(lowerContent, term);
      score += Math.min(count, 12) * (term.length >= 4 ? 10 : 6);
    }
    if (score <= 0) return null;

    return {
      ...file,
      score,
      snippet: buildSnippet(content, terms, 320),
      previewChars: config.maxPreviewChars || 18000
    };
  }

  async preview(payload = {}) {
    const sourceType = payload.sourceType || (payload.absolute ? "local" : "internet");
    const offsetChars = Math.max(0, Number(payload.offsetChars) || 0);
    const requestedChars = Math.max(1000, Math.min(128000, Number(payload.maxChars) || 18000));
    if (sourceType === "internet") {
      const settings = await this.settingsService.get();
      const webConfig = {
        ...(settings.webSearch || {}),
        maxPreviewChars: Math.min(256000, offsetChars + requestedChars),
        readerFallback: false
      };
      let fullContent = payload.content || payload.snippet || "";
      let fetchError = "";
      if (payload.url && this.webSearchService) {
        try {
          fullContent = await this.webSearchService.fetchReadablePage(payload.url, webConfig);
        } catch (error) {
          fetchError = error.message;
          fullContent = [
            `自动抓取网页正文失败：${error.message}`,
            "",
            "检索摘要：",
            payload.snippet || "这个来源没有返回摘要。"
          ].join("\n");
        }
      }
      const content = fullContent.slice(offsetChars, offsetChars + requestedChars);
      return {
        sourceType,
        title: payload.title || "网页参考",
        url: payload.url || "",
        content,
        snippet: payload.snippet || "",
        fetchError,
        offsetChars,
        totalChars: fullContent.length,
        truncated: offsetChars + content.length < fullContent.length,
        nextOffset: offsetChars + content.length < fullContent.length ? offsetChars + content.length : null
      };
    }

    const settings = await this.settingsService.get();
    const config = settings.referenceSearch || {};
    const absolute = path.resolve(payload.absolute || "");
    const allowedRoot = path.resolve(this.paths.projectRoot);
    if (!isPathInside(allowedRoot, absolute)) {
      throw new Error("只能预览当前工作区内的文件。");
    }
    const lexicalStat = await fsp.lstat(absolute);
    if (lexicalStat.isSymbolicLink()) throw new Error("不读取符号链接资料。");
    const [realAllowedRoot, realAbsolute] = await Promise.all([
      fsp.realpath(allowedRoot),
      fsp.realpath(absolute)
    ]);
    if (!isPathInside(realAllowedRoot, realAbsolute)) {
      throw new Error("文件经 realpath 解析后越出当前工作区。");
    }
    const stat = await fsp.stat(realAbsolute);
    if (!stat.isFile()) throw new Error("只能预览文件。");
    const maxLocalFileBytes = Math.max(Number(config.maxLocalFileBytes) || 0, 16 * 1024 * 1024);
    if (stat.size > maxLocalFileBytes) {
      throw new Error(`文件超过 ${Math.round(maxLocalFileBytes / 1024 / 1024)} MB，未读取；系统不会静默截断资料。`);
    }
    const fullContent = await fsp.readFile(realAbsolute, "utf8");
    const content = fullContent.slice(offsetChars, offsetChars + requestedChars);
    return {
      sourceType: "local",
      title: payload.title || path.basename(absolute),
      absolute,
      relative: path.relative(this.paths.workspace, absolute),
      updatedAt: stat.mtime.toISOString(),
      size: stat.size,
      content,
      offsetChars,
      totalChars: fullContent.length,
      truncated: offsetChars + content.length < fullContent.length,
      nextOffset: offsetChars + content.length < fullContent.length ? offsetChars + content.length : null
    };
  }
}


module.exports = { ReferenceService };
