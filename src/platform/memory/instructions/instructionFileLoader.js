// @ts-check

const crypto = require("node:crypto");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { isPathInside } = require("../../shared/pathSafety");
const { parseInstructionSource, parseIncludeLine } = require("./instructionParser");

class InstructionFileLoader {
  constructor({
    maxFileBytes = 65536,
    maxExpandedBytes = 524288,
    maxIncludeFiles = 64,
    maxIncludeDepth = 5,
    cache = null
  } = {}) {
    this.maxFileBytes = maxFileBytes;
    this.maxExpandedBytes = maxExpandedBytes;
    this.maxIncludeFiles = maxIncludeFiles;
    this.maxIncludeDepth = maxIncludeDepth;
    this.cache = cache instanceof Map ? cache : new Map();
  }

  /**
   * @param {string} file
   * @param {{allowedRoot?:string, source?:string, allowPat?:boolean, diagnostics?:any[]}} options
   */
  async read(file, { allowedRoot = "", source = "", allowPat = false, diagnostics = [] } = {}) {
    const absolute = path.resolve(file);
    const root = path.resolve(allowedRoot || path.dirname(absolute));
    const cacheKey = `file:${absolute}:${allowPat ? "pat" : "body"}`;
    if (this.cache.has(cacheKey)) {
      const cached = this.cache.get(cacheKey);
      replayDiagnostics(diagnostics, cached?.diagnostics, source);
      return cached?.value || null;
    }
    let stat;
    try {
      stat = await fsp.lstat(absolute);
    } catch (error) {
      const rows = error?.code === "ENOENT"
        ? []
        : [diag("INSTRUCTION_FILE_UNREADABLE", source, error.message)];
      diagnostics.push(...rows);
      this.cache.set(cacheKey, { value: null, diagnostics: rows });
      return null;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
      const rows = [diag("INSTRUCTION_FILE_UNSAFE", source, "只接受 nlink=1 的普通文件")];
      diagnostics.push(...rows);
      this.cache.set(cacheKey, { value: null, diagnostics: rows });
      return null;
    }
    if (stat.size > this.maxFileBytes) {
      const rows = [diag("INSTRUCTION_FILE_TOO_LARGE", source, `文件超过 ${this.maxFileBytes} bytes`)];
      diagnostics.push(...rows);
      this.cache.set(cacheKey, { value: null, diagnostics: rows });
      return null;
    }
    const real = await fsp.realpath(absolute).catch(() => "");
    if (!real || !samePath(real, absolute) || !isPathInside(root, real)) {
      const rows = [diag("INSTRUCTION_FILE_OUT_OF_SCOPE", source, "路径或符号链接超出规则根")];
      diagnostics.push(...rows);
      this.cache.set(cacheKey, { value: null, diagnostics: rows });
      return null;
    }
    const raw = await fsp.readFile(real, "utf8");
    const parsed = parseInstructionSource(raw, { allowPat });
    const value = {
      absolute: real,
      body: parsed.body,
      patterns: parsed.patterns,
      patternError: parsed.patternError,
      digest: sha256(raw)
    };
    this.cache.set(cacheKey, { value, diagnostics: [] });
    return value;
  }

  async expand(candidate = {}, diagnostics = []) {
    const cacheKey = `expanded:${path.resolve(candidate.absolute || "")}:${path.resolve(candidate.allowedRoot || ".")}`;
    if (this.cache.has(cacheKey)) {
      const cached = this.cache.get(cacheKey);
      replayDiagnostics(diagnostics, cached?.diagnostics, candidate.source);
      return cached?.value || { content: "", digest: sha256("") };
    }
    const state = { files: 0, bytes: 0, stopped: false };
    const expansionDiagnostics = [];
    const content = await this.expandFile(candidate.absolute, {
      allowedRoot: candidate.allowedRoot,
      source: candidate.source,
      diagnostics: expansionDiagnostics,
      depth: 0,
      stack: [],
      state
    });
    const value = { content, digest: sha256(content) };
    diagnostics.push(...expansionDiagnostics);
    this.cache.set(cacheKey, { value, diagnostics: expansionDiagnostics });
    return value;
  }

  async expandFile(file, context) {
    if (context.state.stopped) return "";
    const entry = await this.read(file, {
      allowedRoot: context.allowedRoot,
      source: context.source,
      allowPat: false,
      diagnostics: context.diagnostics
    });
    if (!entry) return "";
    if (context.stack.includes(entry.absolute)) {
      context.diagnostics.push(diag("INSTRUCTION_INCLUDE_CYCLE", context.source, path.basename(entry.absolute)));
      return "";
    }
    const stack = [...context.stack, entry.absolute];
    const parts = [];
    for (const line of entry.body.split("\n")) {
      const include = parseIncludeLine(line);
      if (!include) {
        parts.push(line);
        continue;
      }
      const included = await this.resolveInclude(include, entry.absolute, context, stack);
      if (included) parts.push(included);
      if (context.state.stopped) break;
    }
    const content = parts.join("\n");
    if (context.depth === 0 && Buffer.byteLength(content, "utf8") > this.maxExpandedBytes) {
      context.state.stopped = true;
      context.diagnostics.push(diag("INSTRUCTION_INCLUDE_BYTES_EXCEEDED", context.source, `展开内容超过 ${this.maxExpandedBytes} bytes`));
      return Buffer.from(content, "utf8").subarray(0, this.maxExpandedBytes).toString("utf8");
    }
    return content;
  }

  async resolveInclude(include, parentFile, context, stack) {
    if (path.isAbsolute(include) || include.startsWith("~") || /^[a-z][a-z0-9+.-]*:/i.test(include)) {
      context.diagnostics.push(diag("INSTRUCTION_INCLUDE_INVALID", context.source, include));
      return "";
    }
    if (context.depth >= this.maxIncludeDepth) {
      context.diagnostics.push(diag("INSTRUCTION_INCLUDE_DEPTH_EXCEEDED", context.source, include));
      return "";
    }
    if (context.state.files >= this.maxIncludeFiles) {
      context.state.stopped = true;
      context.diagnostics.push(diag("INSTRUCTION_INCLUDE_COUNT_EXCEEDED", context.source, `${this.maxIncludeFiles}`));
      return "";
    }
    const target = path.resolve(path.dirname(parentFile), include);
    if (path.extname(target).toLowerCase() !== ".md" || !isPathInside(context.allowedRoot, target)) {
      context.diagnostics.push(diag("INSTRUCTION_INCLUDE_OUT_OF_SCOPE", context.source, include));
      return "";
    }
    context.state.files += 1;
    return this.expandFile(target, {
      ...context,
      depth: context.depth + 1,
      stack
    });
  }
}

function replayDiagnostics(target = [], rows = [], source = "") {
  for (const row of Array.isArray(rows) ? rows : []) {
    target.push({ ...row, source: `${source || row.source || ""}` });
  }
}

function diag(code, source, detail) {
  return { code, source: `${source || ""}`, detail: `${detail || ""}`.slice(0, 240) };
}

function sha256(value = "") {
  return crypto.createHash("sha256").update(`${value || ""}`, "utf8").digest("hex");
}

function samePath(left = "", right = "") {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

module.exports = {
  InstructionFileLoader,
  sha256
};
