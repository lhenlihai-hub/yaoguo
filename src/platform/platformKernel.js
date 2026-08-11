const { ensureDir } = require("./shared/fs");
const { WorkspaceLayout } = require("./storage/workspaceLayout");
const { RegistryService } = require("./registries/registryService");
const { TokenLedger } = require("./telemetry/tokenLedger");
const { ArtifactStore } = require("./artifacts/artifactStore");
const { RunStore } = require("./runs/runStore");
const { SkillsRegistry } = require("./skills/skillsRegistry");
const { SkillRunner } = require("./skills/skillRunner");
const { DependencyResolver } = require("./skills/dependencyResolver");
const { SkillsService } = require("./skills/skillsService");

class PlatformKernel {
  constructor({ paths = {}, errorReporter = null } = {}) {
    this.paths = paths;
    this.layout = new WorkspaceLayout(paths);
    this.registries = new RegistryService(paths);
    this.tokenLedger = new TokenLedger(paths, { errorReporter });
    this.artifacts = new ArtifactStore(paths);
    this.runs = new RunStore(paths, { errorReporter });
    this.skillsRegistry = new SkillsRegistry({ registryService: this.registries });
    this.skillRunner = new SkillRunner({ projectRoot: paths.projectRoot || process.cwd() });
    this.dependencyResolver = new DependencyResolver({ projectRoot: paths.projectRoot || process.cwd() });
    this.skills = new SkillsService({
      skillsRegistry: this.skillsRegistry,
      skillRunner: this.skillRunner,
      dependencyResolver: this.dependencyResolver
    });
  }

  async ensure() {
    await Promise.all([
      ensureDir(this.paths.privateDir),
      ensureDir(this.paths.registriesDir),
      this.registries.ensure(),
      this.tokenLedger.ensure()
    ]);
  }

  async describe() {
    return {
      version: 1,
      name: "Yaoguo Platform Kernel",
      boundaries: [
        "model-gateway",
        "workflow-engine",
        "memory-engine",
        "artifact-store",
        "run-store",
        "telemetry-ledger"
      ],
      registries: await this.registries.describe()
    };
  }
}

module.exports = {
  PlatformKernel
};
