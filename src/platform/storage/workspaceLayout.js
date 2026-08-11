const path = require("node:path");
const { assertSafePathSegment } = require("../shared/pathSafety");

function safeSegment(value, fallback, label) {
  return assertSafePathSegment(value || fallback, label);
}

class WorkspaceLayout {
  constructor(paths = {}) {
    this.paths = paths;
    this.workspace = paths.workspace || "";
  }

  registryDir(...parts) {
    return path.join(this.paths.registriesDir || path.join(this.workspace, "registries"), ...parts);
  }

  projectDir(projectId = "") {
    return path.join(
      this.paths.projectsDir || path.join(this.workspace, "projects"),
      safeSegment(projectId, "legacy", "projectId")
    );
  }

  taskDir(projectId = "", taskId = "") {
    return path.join(this.projectDir(projectId), "tasks", safeSegment(taskId, "default-task", "taskId"));
  }

  runDir(projectId = "", taskId = "", runId = "") {
    return path.join(this.taskDir(projectId, taskId), "runs", safeSegment(runId, "default-run", "runId"));
  }

  stepDir(projectId = "", taskId = "", runId = "", stepId = "") {
    return path.join(
      this.runDir(projectId, taskId, runId),
      "steps",
      safeSegment(stepId, "default-step", "stepId")
    );
  }

  callDir(projectId = "", taskId = "", runId = "", callId = "") {
    return path.join(
      this.runDir(projectId, taskId, runId),
      "calls",
      safeSegment(callId, "default-call", "callId")
    );
  }

  artifactDir(projectId = "", taskId = "") {
    const projectArtifacts = path.join(this.projectDir(projectId), "artifacts");
    return taskId
      ? path.join(projectArtifacts, safeSegment(taskId, "project", "taskId"))
      : projectArtifacts;
  }

  conversationDir(projectId = "") {
    return path.join(this.projectDir(projectId), "conversations");
  }
}

module.exports = {
  WorkspaceLayout
};
