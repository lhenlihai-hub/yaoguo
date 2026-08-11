// @ts-check

const path = require("node:path");
const fsp = require("node:fs/promises");
const { loadAgentCore } = require("../ai/agentLoop/coreDependency");
const { validateSkillManifest, isPathInside } = require("./skillContract");

const MAX_SKILL_INSTRUCTIONS_BYTES = 32 * 1024;

// 在 RegistryService("skills") 之上加一层薄包装，提供 skill 专用查询：
//   - 按 id 取
//   - 按文件后缀路由（用于附件上传）
//   - 按输出格式路由（用于"导出为 X"）
//   - 按意图词路由（用于统筹大脑触发）

class SkillsRegistry {
  constructor({ registryService = null } = {}) {
    if (!registryService) throw new Error("SkillsRegistry 需要 registryService。");
    this.registry = registryService;
    this._recordsPromise = null;
  }

  async list({ refresh = false } = {}) {
    if (refresh) this._recordsPromise = null;
    if (this._recordsPromise) return this._recordsPromise;
    this._recordsPromise = this._loadRecords().catch((error) => {
      this._recordsPromise = null;
      throw error;
    });
    return this._recordsPromise;
  }

  invalidateCache() {
    this._recordsPromise = null;
  }

  async _loadRecords() {
    const rows = await this.registry.list("skills");
    const records = await Promise.all(rows
      .filter((row) => row.asset?.kind === "skill")
      .map((row) => this._toRecord(row)));
    const counts = new Map();
    for (const record of records) counts.set(record.id, (counts.get(record.id) || 0) + 1);
    for (const record of records) {
      if ((counts.get(record.id) || 0) > 1) {
        record.valid = false;
        record.issues.push(`skill id 重复：${record.id}`);
      }
    }
    return records;
  }

  async getById(skillId) {
    if (!skillId) return null;
    const all = await this.list();
    return all.find((s) => s.id === skillId) || null;
  }

  async findByExtension(extension) {
    if (!extension) return [];
    const ext = extension.startsWith(".") ? extension.toLowerCase() : `.${extension.toLowerCase()}`;
    const all = await this.list();
    return all.filter((s) => (s.manifest.triggers?.extensions || []).includes(ext));
  }

  async _toRecord(row) {
    const dir = path.dirname(row.file);
    const manifest = row.asset;
    const validation = validateSkillManifest(manifest, dir);
    const issues = [...validation.errors];
    let skillDefinition = null;
    const instructionsPath = path.resolve(dir, manifest.instructionsRef || "SKILL.md");
    if (!isPathInside(dir, instructionsPath)) {
      issues.push("instructionsRef 越出 Skill 目录");
    } else {
      try {
        const stats = await fsp.stat(instructionsPath);
        if (stats.size > MAX_SKILL_INSTRUCTIONS_BYTES) {
          issues.push(`SKILL.md 超过 ${MAX_SKILL_INSTRUCTIONS_BYTES} bytes；请把详细资料拆到按需读取的 references`);
        } else {
          const loaded = await loadSkillDefinition(dir, instructionsPath);
          skillDefinition = loaded.skill;
          issues.push(...loaded.issues);
        }
      } catch (error) {
        issues.push(`无法通过 Pi 加载 SKILL.md：${error?.message || error}`);
      }
    }
    for (const [action, entry] of Object.entries(manifest.entry || {})) {
      const scriptPath = path.resolve(dir, `${entry?.script || ""}`);
      try {
        const [realDir, realScript] = await Promise.all([fsp.realpath(dir), fsp.realpath(scriptPath)]);
        if (!isPathInside(realDir, realScript)) issues.push(`action ${action} script 越出 Skill 目录`);
      } catch (error) {
        issues.push(`action ${action} script 不可用：${error?.message || error}`);
      }
    }
    const idName = `${manifest.id || ""}`.match(/^skill:\/\/([^@]+)@/)?.[1] || "";
    if (skillDefinition?.name && idName && skillDefinition.name !== idName) {
      issues.push(`SKILL.md name (${skillDefinition.name}) 与 manifest id (${idName}) 不一致`);
    }
    if (skillDefinition?.disableModelInvocation && manifest.exposure?.mode === "agent-direct") {
      issues.push("SKILL.md 禁止模型调用，不能声明 agent-direct");
    }
    return {
      id: manifest.id,
      version: manifest.version || 1,
      title: manifest.title || manifest.id,
      name: skillDefinition?.name || idName,
      description: skillDefinition?.description || "",
      format: manifest.format,
      actions: Object.keys(manifest.entry || {}),
      dir,
      manifestPath: row.file,
      instructionsPath,
      instructionsBody: skillDefinition?.content || "",
      valid: issues.length === 0,
      issues,
      manifest
    };
  }
}

async function loadSkillDefinition(dir, instructionsPath) {
  const agentCore = await loadAgentCore();
  const env = new agentCore.NodeExecutionEnv({ cwd: dir });
  try {
    const loaded = await agentCore.loadSkills(env, dir);
    const expectedPath = path.resolve(instructionsPath);
    const skill = loaded.skills.find((entry) => path.resolve(entry.filePath) === expectedPath) || null;
    const issues = loaded.diagnostics.map((diagnostic) => (
      `Pi Skill ${diagnostic.code}: ${diagnostic.message}`
    ));
    if (!skill) issues.push("Pi 未从指定 SKILL.md 加载有效 Skill");
    return { skill, issues };
  } finally {
    await env.cleanup();
  }
}

module.exports = {
  SkillsRegistry
};
