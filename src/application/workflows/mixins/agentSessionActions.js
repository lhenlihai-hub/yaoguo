const agentHistoryActions = require("./agent/agentHistoryActions");
const agentTurnActions = require("./agent/agentTurnActions");
const agentContextActions = require("./agent/agentContextActions");
const agentInputActions = require("./agent/agentInputActions");
const agentMemoryCacheActions = require("./agent/agentMemoryCacheActions");
const agentNamingActions = require("./agent/agentNamingActions");

module.exports = Object.assign(
  {},
  agentHistoryActions,
  agentTurnActions,
  agentContextActions,
  agentInputActions,
  agentMemoryCacheActions,
  agentNamingActions
);
