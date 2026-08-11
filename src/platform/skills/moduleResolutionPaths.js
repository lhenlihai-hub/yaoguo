// @ts-check

const path = require("node:path");
/** @type {NodeJS.Process & { resourcesPath?: string }} */
const runtimeProcess = process;

function unique(items) {
  return [...new Set(items.filter(Boolean))];
}

function buildModuleLookupRoots({
  projectRoot = "",
  resourcesPath = runtimeProcess.resourcesPath || ""
} = {}) {
  const roots = [];
  if (resourcesPath) {
    roots.push(path.join(resourcesPath, "app.asar.unpacked"));
    roots.push(path.join(resourcesPath, "app.asar"));
    roots.push(path.join(resourcesPath, "app"));
  }
  if (projectRoot) roots.push(projectRoot);
  return unique(roots);
}

function buildNodePathEntries(options = {}) {
  return buildModuleLookupRoots(options).map((root) => path.join(root, "node_modules"));
}

module.exports = {
  buildModuleLookupRoots,
  buildNodePathEntries
};
