// @ts-check

const { neutralizeInstructionTags } = require("./instructionParser");
const { sha256 } = require("./instructionFileLoader");

function compareInstructionDocuments(left = {}, right = {}) {
  return Number(left.authorityRank) - Number(right.authorityRank)
    || Number(left.ownerDepth) - Number(right.ownerDepth)
    || Number(left.sourceKind) - Number(right.sourceKind)
    || `${left.sortPath || left.source || ""}`.localeCompare(`${right.sortPath || right.source || ""}`);
}

function renderInstructionReminder(documents = [], effectiveDocuments = documents, kind = "initial", currentDate = "") {
  if (!documents.length) return "";
  const visible = [...documents].sort(compareInstructionDocuments);
  const effective = [...effectiveDocuments].sort(compareInstructionDocuments);
  const digest = snapshotDigest(effective);
  const order = effective.map((document, index) => (
    `<source order="${index + 1}" authority="${attribute(document.authority)}" path="${attribute(document.source)}" digest="${attribute(document.digest)}"/>`
  ));
  const bodies = visible.map((document) => [
    `<instruction-document authority="${attribute(document.authority)}" path="${attribute(document.source)}" depth="${Number(document.ownerDepth) || 0}" digest="${attribute(document.digest)}">`,
    neutralizeInstructionTags(document.content),
    "</instruction-document>"
  ].join("\n"));
  return [
    "<system-reminder>",
    `<instruction-memory version="1" kind="${attribute(kind)}" digest="${digest}">`,
    ...(currentDate ? [`<runtime-context current-date="${attribute(currentDate)}"/>`] : []),
    "<effective-order>",
    ...order,
    "</effective-order>",
    ...bodies,
    "</instruction-memory>",
    "</system-reminder>"
  ].join("\n");
}

function snapshotDigest(documents = []) {
  return sha256([...documents]
    .sort(compareInstructionDocuments)
    .map((document) => `${document.source}:${document.digest}`)
    .join("\n"));
}

function attribute(value = "") {
  return `${value || ""}`
    .replace(/[\u0000-\u001f\u007f]/g, "�")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

module.exports = {
  compareInstructionDocuments,
  renderInstructionReminder,
  snapshotDigest
};
