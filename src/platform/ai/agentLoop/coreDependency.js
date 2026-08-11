// @ts-check

let coreModulePromise = null;

/**
 * The agent core dependency is ESM-only while Yaoguo is still CommonJS.
 * Keep the module-system boundary in one place.
 */
async function loadAgentCore() {
  if (!coreModulePromise) {
    coreModulePromise = Promise.all([
      import("@earendil-works/pi-agent-core"),
      import("@earendil-works/pi-agent-core/node")
    ]).then(([core, node]) => ({ ...core, ...node }));
  }
  return coreModulePromise;
}

module.exports = { loadAgentCore };
