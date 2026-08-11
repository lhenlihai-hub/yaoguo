const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { DEFAULT_SETTINGS, SettingsService, mergeSettings } = require("../config/settingsService");
const { TokenLedger } = require("../telemetry/tokenLedger");
const { ModelGateway } = require("../ai/modelGateway");
const { ArtifactStore } = require("../artifacts/artifactStore");
const { RunStore } = require("../runs/runStore");
const { CheckpointStore, CHECKPOINT_VERSION, CHECKPOINT_FILE } = require("../runs/checkpointStore");
const {
  canonicalTaskType,
  migrateWorkflowTaskTypes,
  normalizeWorkflowManifest
} = require("../workflows/workflowManifest");
const { STEP_STATUS, WorkflowStateMachine } = require("../workflows/workflowStateMachine");
const workspaceRuntime = require("../storage/workspaceRuntime");
const time = require("../shared/time");
const promptText = require("../shared/promptText");
const yaoguoMarkers = require("../workflows/yaoguoMarkers");
const memoryIndex = require("../memory/memoryIndex");
const rssParser = require("../research/rssParser");
const contentSignals = require("./contentSignals");
const credentials = require("./credentials");
const memoryRules = require("./memoryRules");
const referenceSignals = require("./referenceSignals");
const asyncTools = require("./asyncTools");

module.exports = {
  fs,
  fsp,
  path,
  crypto,
  DEFAULT_SETTINGS,
  SettingsService,
  mergeSettings,
  TokenLedger,
  ModelGateway,
  ArtifactStore,
  RunStore,
  CheckpointStore,
  CHECKPOINT_VERSION,
  CHECKPOINT_FILE,
  canonicalTaskType,
  migrateWorkflowTaskTypes,
  normalizeWorkflowManifest,
  STEP_STATUS,
  WorkflowStateMachine,
  ...workspaceRuntime,
  ...time,
  ...promptText,
  ...yaoguoMarkers,
  ...memoryIndex,
  ...rssParser,
  ...contentSignals,
  ...credentials,
  ...memoryRules,
  ...referenceSignals,
  ...asyncTools
};
