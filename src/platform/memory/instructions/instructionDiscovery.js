// @ts-check

const fsp = require("node:fs/promises");
const path = require("node:path");
const { relativeDepth, toPosixPath } = require("./instructionPaths");
const { validateInstructionPatterns } = require("./instructionMatcher");

const AUTHORITY_RANK = Object.freeze({ managed: 0, user: 1, project: 2, local: 3 });
const SKIP_OWNER_DIRECTORIES = new Set([
  ".git", ".yaoguo", ".venv", "build", "coverage", "dist", "node_modules", "vendor"
]);

async function discoverLayerRoot(context, authority, root) {
  if (!root || !await isDirectory(root)) return [];
  const candidates = [];
  await addMainCandidate(context, candidates, {
    authority,
    owner: root,
    allowedRoot: root,
    patternBase: context.scopeRoot,
    file: path.join(root, "YAOGUO.md"),
    sourceKind: 0
  });
  await addRulesCandidates(context, candidates, {
    authority,
    owner: root,
    allowedRoot: root,
    patternBase: context.scopeRoot,
    directory: path.join(root, "rules")
  });
  return candidates;
}

async function discoverOwner(context, owner) {
  const candidates = [];
  const shared = {
    owner,
    allowedRoot: context.scopeRoot,
    patternBase: owner
  };
  await addMainCandidate(context, candidates, {
    ...shared,
    authority: "project",
    file: path.join(owner, "YAOGUO.md"),
    sourceKind: 0
  });
  await addRulesCandidates(context, candidates, {
    ...shared,
    authority: "project",
    directory: path.join(owner, ".yaoguo", "rules")
  });
  await addMainCandidate(context, candidates, {
    ...shared,
    authority: "local",
    file: path.join(owner, "YAOGUO.local.md"),
    sourceKind: 0
  });
  await addRulesCandidates(context, candidates, {
    ...shared,
    authority: "local",
    directory: path.join(owner, ".yaoguo", "rules.local")
  });
  return candidates;
}

async function discoverAllOwners(context) {
  const owners = [];
  const pending = [context.scopeRoot];
  while (pending.length && owners.length < context.maxOwnerDirectories) {
    const owner = pending.shift();
    owners.push(owner);
    const entries = await fsp.readdir(owner, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || SKIP_OWNER_DIRECTORIES.has(entry.name)) continue;
      pending.push(path.join(owner, entry.name));
    }
  }
  if (pending.length) {
    context.diagnostics.push({
      code: "INSTRUCTION_OWNER_LIMIT_EXCEEDED",
      source: "project:",
      detail: `${context.maxOwnerDirectories}`
    });
  }
  const discovered = [];
  for (const owner of owners) discovered.push(...await discoverOwner(context, owner));
  return discovered;
}

async function addMainCandidate(context, candidates, spec) {
  const source = sourceLabel(context, spec.authority, spec.file, spec.allowedRoot);
  const entry = await context.loader.read(spec.file, {
    allowedRoot: spec.allowedRoot,
    source,
    allowPat: false,
    diagnostics: context.diagnostics
  });
  if (!entry) return;
  candidates.push(toCandidate(context, spec, entry, source));
}

async function addRulesCandidates(context, candidates, spec) {
  if (!await isDirectory(spec.directory)) return;
  const files = await listRuleFiles(spec.directory, context.maxRulesPerDirectory);
  if (files.truncated) {
    context.diagnostics.push({
      code: "INSTRUCTION_RULE_DIRECTORY_LIMIT_EXCEEDED",
      source: sourceLabel(context, spec.authority, spec.directory, spec.allowedRoot),
      detail: `${context.maxRulesPerDirectory}`
    });
  }
  for (const file of files.items) {
    const source = sourceLabel(context, spec.authority, file, spec.allowedRoot);
    const entry = await context.loader.read(file, {
      allowedRoot: spec.allowedRoot,
      source,
      allowPat: true,
      diagnostics: context.diagnostics
    });
    if (!entry) continue;
    const patternError = entry.patternError || validateInstructionPatterns(entry.patterns);
    if (patternError) {
      context.diagnostics.push({ code: "INSTRUCTION_PAT_INVALID", source, detail: patternError });
      continue;
    }
    candidates.push(toCandidate(context, { ...spec, file, sourceKind: 1 }, entry, source));
  }
}

function toCandidate(context, spec, entry, source) {
  const authority = `${spec.authority}`;
  return {
    id: `${authority}:${entry.absolute}`,
    authority,
    authorityRank: AUTHORITY_RANK[authority],
    owner: spec.owner,
    ownerDepth: ["project", "local"].includes(authority)
      ? relativeDepth(context.scopeRoot, spec.owner)
      : 0,
    sourceKind: Number(spec.sourceKind) || 0,
    source,
    sortPath: source.slice(source.indexOf(":") + 1),
    absolute: entry.absolute,
    allowedRoot: spec.allowedRoot,
    patternBase: spec.patternBase,
    patterns: entry.patterns
  };
}

async function listRuleFiles(root, limit) {
  const items = [];
  const pending = [root];
  while (pending.length && items.length <= limit) {
    const directory = pending.shift();
    const entries = await fsp.readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.isSymbolicLink()) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(absolute);
      else if (entry.isFile() && path.extname(entry.name).toLowerCase() === ".md") items.push(absolute);
      if (items.length > limit) break;
    }
  }
  return { items: items.slice(0, limit), truncated: items.length > limit };
}

function sourceLabel(context, authority, file, layerRoot) {
  const base = ["project", "local"].includes(authority) ? context.scopeRoot : layerRoot;
  return `${authority}:${toPosixPath(path.relative(base, file) || path.basename(file))}`;
}

async function isDirectory(value) {
  try {
    const stat = await fsp.lstat(value);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

module.exports = {
  AUTHORITY_RANK,
  discoverLayerRoot,
  discoverOwner,
  discoverAllOwners
};
