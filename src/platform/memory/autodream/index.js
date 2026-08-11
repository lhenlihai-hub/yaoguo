const {
  AutoDreamService,
  AutoDreamJob,
  AUTO_DREAM_PROMPT_BLOCK,
  MAX_AUTO_DREAM_ROUNDS,
  MAX_AUTO_DREAM_TRANSCRIPTS,
  nextNightlyDelay,
  jobId
} = require("./autoDreamService");
const {
  AutoDreamStateStore,
  AUTO_DREAM_LOCK_FILE,
  AUTO_DREAM_SIGNAL_DIRECTORY,
  AUTO_DREAM_MIN_INTERVAL_MS,
  AUTO_DREAM_MIN_SESSIONS,
  AUTO_DREAM_APPEND_ONLY_MIN_SESSIONS,
  gateCode
} = require("./autoDreamState");
const {
  TOOL_SCHEMAS,
  AutoDreamToolState,
  createAutoDreamToolRegistry
} = require("./autoDreamTools");

module.exports = {
  AutoDreamService,
  AutoDreamJob,
  AutoDreamStateStore,
  AutoDreamToolState,
  AUTO_DREAM_PROMPT_BLOCK,
  AUTO_DREAM_LOCK_FILE,
  AUTO_DREAM_SIGNAL_DIRECTORY,
  AUTO_DREAM_MIN_INTERVAL_MS,
  AUTO_DREAM_MIN_SESSIONS,
  AUTO_DREAM_APPEND_ONLY_MIN_SESSIONS,
  MAX_AUTO_DREAM_ROUNDS,
  MAX_AUTO_DREAM_TRANSCRIPTS,
  nextNightlyDelay,
  TOOL_SCHEMAS,
  createAutoDreamToolRegistry,
  gateCode,
  jobId
};
