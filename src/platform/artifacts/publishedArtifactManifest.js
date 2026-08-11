// @ts-check

const path = require("node:path");
const crypto = require("node:crypto");

const PUBLISHED_ARTIFACT_MANIFEST_VERSION = 1;
const PUBLISHED_ARTIFACT_MANIFEST_KIND = "yaoguo.published-artifact";
const PUBLISHED_ARTIFACT_TRANSACTION_VERSION = 1;
const PUBLISHED_ARTIFACT_TRANSACTION_KIND = "yaoguo.published-artifact-transaction";
const PUBLISHED_ARTIFACT_TRANSACTION_OWNER_ID = crypto.randomBytes(12).toString("hex");
const MANIFEST_PREFIX = ".yaoguo-publish-";
const MANIFEST_SUFFIX = ".json";
const TRANSACTION_PREFIX = ".yaoguo-publish-txn-";
const TRANSACTION_SUFFIX = ".json";

function publishedArtifactManifestName(fileName = "") {
  const name = path.basename(`${fileName || ""}`);
  const digest = crypto.createHash("sha256").update(name, "utf8").digest("hex").slice(0, 24);
  return `${MANIFEST_PREFIX}${digest}${MANIFEST_SUFFIX}`;
}

function isPublishedArtifactManifestName(fileName = "") {
  const name = `${fileName || ""}`;
  return name.startsWith(MANIFEST_PREFIX)
    && name.endsWith(MANIFEST_SUFFIX)
    && name.length === MANIFEST_PREFIX.length + 24 + MANIFEST_SUFFIX.length;
}

function publishedArtifactTransactionName(transactionId = "") {
  const digest = crypto.createHash("sha256")
    .update(`${transactionId || ""}`, "utf8")
    .digest("hex")
    .slice(0, 24);
  return `${TRANSACTION_PREFIX}${digest}${TRANSACTION_SUFFIX}`;
}

function isPublishedArtifactTransactionName(fileName = "") {
  const name = `${fileName || ""}`;
  return name.startsWith(TRANSACTION_PREFIX)
    && name.endsWith(TRANSACTION_SUFFIX)
    && name.length === TRANSACTION_PREFIX.length + 24 + TRANSACTION_SUFFIX.length;
}

function isPublishedArtifactManifest(value = null) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const file = `${value.file || ""}`;
  return Number(value.version) === PUBLISHED_ARTIFACT_MANIFEST_VERSION
    && value.kind === PUBLISHED_ARTIFACT_MANIFEST_KIND
    && value.source === "agent-publish"
    && Boolean(file)
    && path.basename(file) === file
    && /^[a-f0-9]{64}$/.test(`${value.sha256 || ""}`)
    && /^inspection_[a-f0-9]{24}$/.test(`${value.inspectionId || ""}`);
}

function isPublishedArtifactTransaction(value = null) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const file = `${value.file || ""}`;
  const stageFile = `${value.stageFile || ""}`;
  const identity = value.stageIdentity;
  return Number(value.version) === PUBLISHED_ARTIFACT_TRANSACTION_VERSION
    && value.kind === PUBLISHED_ARTIFACT_TRANSACTION_KIND
    && value.state === "pending"
    && value.source === "agent-publish"
    && /^publish_[a-f0-9]{24}$/.test(`${value.transactionId || ""}`)
    && /^[a-f0-9]{24}$/.test(`${value.ownerId || ""}`)
    && Boolean(file)
    && path.basename(file) === file
    && stageFile.startsWith(".publish-")
    && stageFile.endsWith(".tmp")
    && path.basename(stageFile) === stageFile
    && identity
    && typeof identity === "object"
    && /^\d+$/.test(`${identity.dev || ""}`)
    && /^\d+$/.test(`${identity.ino || ""}`)
    && Number.isSafeInteger(Number(identity.bytes))
    && Number(identity.bytes) >= 0
    && Number(identity.bytes) === Number(value.bytes)
    && /^[a-f0-9]{64}$/.test(`${value.sha256 || ""}`)
    && /^inspection_[a-f0-9]{24}$/.test(`${value.inspectionId || ""}`);
}

function publishedArtifactManifestFromTransaction(transaction = {}) {
  return {
    version: PUBLISHED_ARTIFACT_MANIFEST_VERSION,
    kind: PUBLISHED_ARTIFACT_MANIFEST_KIND,
    source: "agent-publish",
    file: `${transaction.file || ""}`,
    title: `${transaction.title || ""}` || `${transaction.file || ""}`,
    bytes: Number(transaction.bytes) || 0,
    sha256: `${transaction.sha256 || ""}`,
    inspectionId: `${transaction.inspectionId || ""}`,
    inspectedAt: `${transaction.inspectedAt || ""}`,
    publishedAt: `${transaction.publishedAt || ""}`
  };
}

module.exports = {
  PUBLISHED_ARTIFACT_MANIFEST_VERSION,
  PUBLISHED_ARTIFACT_MANIFEST_KIND,
  PUBLISHED_ARTIFACT_TRANSACTION_VERSION,
  PUBLISHED_ARTIFACT_TRANSACTION_KIND,
  PUBLISHED_ARTIFACT_TRANSACTION_OWNER_ID,
  publishedArtifactManifestName,
  publishedArtifactTransactionName,
  isPublishedArtifactManifestName,
  isPublishedArtifactTransactionName,
  isPublishedArtifactManifest,
  isPublishedArtifactTransaction,
  publishedArtifactManifestFromTransaction
};
