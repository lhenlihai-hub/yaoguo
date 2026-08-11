// @ts-check

const fsp = require("node:fs/promises");
const path = require("node:path");
const { estimateTokens } = require("../../tokens/tokenEstimator");
const { truncateForPromptTokens } = require("../../shared/promptText");
const { isPathInside } = require("../../shared/pathSafety");
const { directoryChain } = require("./instructionPaths");
const { candidateMatchesTargets } = require("./instructionMatcher");
const {
  discoverLayerRoot,
  discoverOwner,
  discoverAllOwners
} = require("./instructionDiscovery");
const {
  compareInstructionDocuments,
  renderInstructionReminder,
  snapshotDigest
} = require("./instructionSnapshot");

class InstructionMemoryTurn {
  /** @param {any} options */
  constructor(options = {}) {
    this.platform = `${options.platform || process.platform}`;
    this.scopeRoot = `${options.scopeRoot || ""}`;
    this.cwd = `${options.cwd || ""}`;
    this.managedRoot = `${options.managedRoot || ""}`;
    this.userRoot = `${options.userRoot || ""}`;
    this.loader = options.loader;
    this.initialTokens = Number(options.initialTokens) || 16000;
    this.activeTokens = Number(options.activeTokens) || 32000;
    this.perDocumentTokens = Number(options.perDocumentTokens) || 8000;
    this.maxRulesPerDirectory = Number(options.maxRulesPerDirectory) || 256;
    this.maxCandidates = Number(options.maxCandidates) || 1024;
    this.maxOwnerDirectories = Number(options.maxOwnerDirectories) || 4096;
    this.currentDate = `${options.currentDate || ""}`;
    this.onUserContextChange = typeof options.onUserContextChange === "function"
      ? options.onUserContextChange
      : null;
    this.candidates = new Map();
    this.documents = new Map();
    this.documentCache = new Map();
    this.evaluated = new Set();
    this.initialIds = new Set();
    this.discoveredOwners = new Set();
    this.diagnostics = [];
    this.totalTokens = 0;
    this.activationVersion = 0;
    this.deliveredVersion = 0;
    this.dynamicTimestamp = 0;
    this.initialReminderValue = "";
  }

  async initialize(explicitTargets = []) {
    for (const [authority, root] of [["managed", this.managedRoot], ["user", this.userRoot]]) {
      this.addCandidates(await discoverLayerRoot(this.discoveryContext(), authority, root));
    }
    await this.discoverChain(this.cwd);
    const targets = [];
    for (const target of explicitTargets) {
      const resolved = await this.resolveTarget(target);
      if (resolved) targets.push(resolved.target);
    }
    await this.activate({ targets, all: false, initial: true });
    this.initialIds = new Set(this.documents.keys());
    this.deliveredVersion = this.activationVersion;
    this.refreshInitialReminder();
    this.publishUserContext();
    return this;
  }

  async resume(cached = {}, explicitTargets = []) {
    this.restoreUserContext(cached);
    const targets = [];
    for (const target of explicitTargets) {
      const resolved = await this.resolveTarget(target);
      if (!resolved) continue;
      targets.push(resolved.target);
      await this.discoverChain(resolved.owner);
    }
    await this.activate({ targets, all: false, initial: true });
    this.initialIds = new Set(this.documents.keys());
    this.deliveredVersion = this.activationVersion;
    this.refreshInitialReminder();
    this.publishUserContext();
    return this;
  }

  discoveryContext() {
    return {
      scopeRoot: this.scopeRoot,
      loader: this.loader,
      diagnostics: this.diagnostics,
      maxRulesPerDirectory: this.maxRulesPerDirectory,
      maxOwnerDirectories: this.maxOwnerDirectories
    };
  }

  addCandidates(rows = []) {
    for (const candidate of rows) {
      if (this.candidates.size >= this.maxCandidates) {
        this.diagnostics.push({
          code: "INSTRUCTION_CANDIDATE_LIMIT_EXCEEDED",
          source: candidate.source,
          detail: `${this.maxCandidates}`
        });
        break;
      }
      if (!this.candidates.has(candidate.id)) this.candidates.set(candidate.id, candidate);
    }
  }

  async discoverChain(targetDirectory) {
    for (const owner of directoryChain(this.scopeRoot, targetDirectory)) {
      if (this.discoveredOwners.has(owner)) continue;
      this.discoveredOwners.add(owner);
      this.addCandidates(await discoverOwner(this.discoveryContext(), owner));
    }
  }

  async prepareToolBatch(calls = []) {
    const targets = [];
    let opaque = false;
    for (const call of calls) {
      const name = `${call?.function?.name || ""}`;
      const args = parseArguments(call?.function?.arguments);
      if (name === "bash") opaque = true;
      if (!["read", "write", "edit"].includes(name) || !args.path) continue;
      const resolved = await this.resolveTarget(args.path);
      if (!resolved) continue;
      targets.push(resolved.target);
      await this.discoverChain(resolved.owner);
    }
    if (opaque) {
      this.addCandidates(await discoverAllOwners(this.discoveryContext()));
      for (const owner of directoryChain(this.scopeRoot, this.cwd)) this.discoveredOwners.add(owner);
    }
    const before = this.documents.size;
    await this.activate({ targets, all: opaque, initial: false });
    if (this.documents.size > before) this.publishUserContext();
    return {
      changed: this.documents.size > before,
      pending: this.hasUndeliveredRules(),
      digest: this.digest()
    };
  }

  async activate({ targets = [], all = false, initial = false } = {}) {
    const eligible = [...this.candidates.values()].filter((candidate) => {
      if (this.evaluated.has(candidate.id)) return false;
      return all || candidateMatchesTargets(candidate, targets, {
        scopeRoot: this.scopeRoot,
        platform: this.platform
      });
    });
    const highToLow = eligible.sort((left, right) => compareInstructionDocuments(right, left));
    const limit = initial ? this.initialTokens : this.activeTokens;
    let selected = 0;
    for (const candidate of highToLow) {
      this.evaluated.add(candidate.id);
      const document = await this.loadDocument(candidate);
      if (!document) continue;
      if (this.totalTokens + document.tokens > limit) {
        this.diagnostics.push({
          code: "INSTRUCTION_TOKEN_BUDGET_EXCEEDED",
          source: candidate.source,
          detail: `${document.tokens} tokens`
        });
        continue;
      }
      this.documents.set(candidate.id, document);
      this.totalTokens += document.tokens;
      selected += 1;
    }
    if (selected) this.activationVersion += 1;
  }

  async loadDocument(candidate) {
    if (this.documentCache.has(candidate.id)) return this.documentCache.get(candidate.id);
    const expanded = await this.loader.expand(candidate, this.diagnostics);
    let content = `${expanded.content || ""}`.trim();
    if (!content) {
      this.documentCache.set(candidate.id, null);
      return null;
    }
    if (estimateTokens(content) > this.perDocumentTokens) {
      content = truncateForPromptTokens(content, this.perDocumentTokens);
      this.diagnostics.push({
        code: "INSTRUCTION_DOCUMENT_TRUNCATED",
        source: candidate.source,
        detail: `${this.perDocumentTokens} tokens`
      });
    }
    const document = {
      ...candidate,
      content,
      digest: expanded.digest,
      tokens: estimateTokens(content)
    };
    this.documentCache.set(candidate.id, document);
    return document;
  }

  async resolveTarget(input = "") {
    const requested = path.resolve(this.cwd, `${input || ""}`);
    if (!isPathInside(this.scopeRoot, requested)) return null;
    let canonical = await fsp.realpath(requested).catch(() => "");
    if (!canonical) {
      const parent = await closestExistingParent(path.dirname(requested));
      const realParent = await fsp.realpath(parent).catch(() => "");
      if (!realParent || !isPathInside(this.scopeRoot, realParent)) return null;
      canonical = path.resolve(realParent, path.relative(parent, requested));
    }
    if (!isPathInside(this.scopeRoot, canonical)) return null;
    const stat = await fsp.stat(canonical).catch(() => null);
    const owner = stat?.isDirectory() ? canonical : path.dirname(canonical);
    return { target: canonical, owner };
  }

  initialReminder() {
    return this.initialReminderValue;
  }

  dynamicReminder() {
    const documents = this.selectedDocuments().filter((document) => !this.initialIds.has(document.id));
    return renderInstructionReminder(
      documents,
      this.selectedDocuments(),
      "path-activated",
      this.currentDate
    );
  }

  refreshInitialReminder() {
    const documents = this.selectedDocuments().filter((document) => this.initialIds.has(document.id));
    this.initialReminderValue = renderInstructionReminder(
      documents,
      documents,
      "initial",
      this.currentDate
    );
  }

  publishUserContext() {
    if (!this.onUserContextChange) return;
    const documents = this.selectedDocuments();
    this.onUserContextChange({
      state: this.exportUserContextState(),
      value: {
        currentDate: this.currentDate,
        instructionReminder: renderInstructionReminder(
          documents,
          documents,
          "initial",
          this.currentDate
        ),
        markdown: documents.map((document) => `${document.content || ""}`).join("\n\n"),
        digest: snapshotDigest(documents)
      }
    });
  }

  exportUserContextState() {
    return {
      currentDate: this.currentDate,
      candidates: cloneMap(this.candidates),
      documents: cloneMap(this.documents),
      documentCache: cloneMap(this.documentCache),
      evaluated: [...this.evaluated],
      initialIds: [...this.initialIds],
      discoveredOwners: [...this.discoveredOwners],
      diagnostics: this.diagnostics.map((item) => ({ ...item })),
      totalTokens: this.totalTokens,
      activationVersion: this.activationVersion,
      deliveredVersion: this.deliveredVersion,
      dynamicTimestamp: this.dynamicTimestamp,
      initialReminderValue: this.initialReminderValue
    };
  }

  restoreUserContext(cached = {}) {
    const state = cached?.state || {};
    this.currentDate = `${state.currentDate || cached?.value?.currentDate || this.currentDate || ""}`;
    this.candidates = restoreMap(state.candidates);
    this.documents = restoreMap(state.documents);
    this.documentCache = restoreMap(state.documentCache);
    this.evaluated = new Set(Array.isArray(state.evaluated) ? state.evaluated : []);
    this.initialIds = new Set(Array.isArray(state.initialIds) ? state.initialIds : []);
    this.discoveredOwners = new Set(Array.isArray(state.discoveredOwners) ? state.discoveredOwners : []);
    this.diagnostics = Array.isArray(state.diagnostics)
      ? state.diagnostics.map((item) => ({ ...item }))
      : [];
    this.totalTokens = Number(state.totalTokens) || 0;
    this.activationVersion = Number(state.activationVersion) || 0;
    this.deliveredVersion = Number(state.deliveredVersion) || 0;
    this.dynamicTimestamp = Number(state.dynamicTimestamp) || 0;
    this.initialReminderValue = `${cached?.value?.instructionReminder || state.initialReminderValue || ""}`;
  }

  selectedDocuments() {
    return [...this.documents.values()].sort(compareInstructionDocuments);
  }

  hasUndeliveredRules() {
    return this.activationVersion > this.deliveredVersion;
  }

  markDelivered() {
    this.deliveredVersion = this.activationVersion;
    if (!this.dynamicTimestamp) this.dynamicTimestamp = Date.now();
  }

  isProtectedPath(input = "") {
    const absolute = path.resolve(this.cwd, `${input || ""}`);
    if (!isPathInside(this.scopeRoot, absolute)) return false;
    const segments = path.relative(this.scopeRoot, absolute).split(path.sep);
    const base = path.basename(absolute);
    if (["YAOGUO.md", "YAOGUO.local.md"].includes(base)) return true;
    return segments.some((segment, index) => (
      segment === ".yaoguo" && ["rules", "rules.local"].includes(segments[index + 1])
    ));
  }

  shellTouchesProtectedPath(command = "") {
    return /(?:^|[^A-Za-z0-9_.-])(?:YAOGUO(?:\.local)?\.md|\.yaoguo[\\/]rules(?:\.local)?)(?:$|[^A-Za-z0-9_.-])/.test(`${command || ""}`);
  }

  digest() {
    return snapshotDigest(this.selectedDocuments());
  }

  summary() {
    return {
      digest: this.digest(),
      tokens: this.totalTokens,
      currentDate: this.currentDate,
      sources: this.selectedDocuments().map((document) => document.source),
      diagnostics: this.diagnostics.map((item) => ({ ...item }))
    };
  }
}

function cloneMap(source) {
  return [...source.entries()].map(([key, value]) => [
    key,
    value && typeof value === "object" ? { ...value } : value
  ]);
}

function restoreMap(rows) {
  return new Map((Array.isArray(rows) ? rows : []).map(([key, value]) => [
    key,
    value && typeof value === "object" ? { ...value } : value
  ]));
}

async function closestExistingParent(start) {
  let cursor = path.resolve(start);
  while (true) {
    try {
      await fsp.access(cursor);
      return cursor;
    } catch {}
    const parent = path.dirname(cursor);
    if (parent === cursor) return cursor;
    cursor = parent;
  }
}

function parseArguments(raw = "") {
  try {
    const value = JSON.parse(`${raw || "{}"}`);
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

module.exports = {
  InstructionMemoryTurn
};
