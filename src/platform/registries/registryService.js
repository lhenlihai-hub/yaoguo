// @ts-check

const path = require("node:path");
const { ensureDir, listJsonFiles, readJson } = require("../shared/fs");

class RegistryService {
  constructor(paths = {}) {
    this.paths = paths;
    this.root = paths.registriesDir || path.join(paths.workspace || "", "registries");
  }

  async ensure() {
    await Promise.all([
      ensureDir(this.root),
      ensureDir(path.join(this.root, "domains")),
      ensureDir(path.join(this.root, "models")),
      ensureDir(path.join(this.root, "prompts")),
      ensureDir(path.join(this.root, "evaluators")),
      ensureDir(path.join(this.root, "roles")),
      ensureDir(path.join(this.root, "skills"))
    ]);
  }

  async listFiles(scope = "") {
    const dir = scope ? path.join(this.root, scope) : this.root;
    return listJsonFiles(dir);
  }

  async loadFile(file) {
    return readJson(file, null);
  }

  async list(scope = "") {
    const files = await this.listFiles(scope);
    const rows = [];
    for (const file of files) {
      const asset = await this.loadFile(file).catch(() => null);
      if (!asset) continue;
      rows.push({
        file,
        relative: path.relative(this.root, file),
        id: asset.id || asset.name || path.basename(file, ".json"),
        kind: asset.kind || scope || "asset",
        version: asset.version || 1,
        title: asset.title || asset.name || asset.id || path.basename(file, ".json"),
        asset
      });
    }
    return rows.sort((a, b) => a.relative.localeCompare(b.relative));
  }

  async getById(scope = "", id = "") {
    const rows = await this.list(scope);
    return rows.find((row) => row.id === id || row.asset?.id === id) || null;
  }

  async getPromptBlock(id = "", { required = false } = {}) {
    const blockId = `${id || ""}`.trim();
    if (!blockId) {
      if (required) throw requiredPromptError(blockId, "缺少 Prompt block id");
      return null;
    }
    const files = await this.listFiles("prompts/blocks");
    for (const file of files) {
      let asset;
      try {
        asset = await this.loadFile(file);
      } catch (error) {
        throw requiredPromptError(blockId, `Prompt 资产无法解析：${path.relative(this.root, file)}`, error);
      }
      if (asset?.id !== blockId) continue;
      const content = typeof asset.content === "string" ? asset.content.trim() : "";
      if (!content && required) {
        throw requiredPromptError(blockId, `Prompt 资产内容为空：${path.relative(this.root, file)}`);
      }
      return {
        file,
        relative: path.relative(this.root, file),
        id: asset.id,
        kind: asset.kind || "prompt-block",
        version: asset.version || 1,
        title: asset.title || asset.id,
        asset
      };
    }
    if (required) throw requiredPromptError(blockId, `缺少必需 Prompt 资产：${blockId}`);
    return null;
  }

  async describe() {
    const scopes = ["domains", "models", "prompts", "evaluators", "roles", "skills"];
    const result = {};
    for (const scope of scopes) {
      result[scope] = (await this.list(scope)).map((row) => ({
        id: row.id,
        title: row.title,
        version: row.version,
        relative: row.relative
      }));
    }
    return {
      root: this.root,
      scopes: result
    };
  }
}

function requiredPromptError(blockId, message, cause = null) {
  const error = Object.assign(new Error(message), {
    code: "REQUIRED_PROMPT_UNAVAILABLE",
    blockId
  });
  if (cause) error.cause = cause;
  return error;
}

module.exports = {
  RegistryService
};
