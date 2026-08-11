// @ts-check

const path = require("node:path");

function ensureReferenceObservationState(ctx = {}) {
  if (!(ctx.observedReferenceUrls instanceof Set)) ctx.observedReferenceUrls = new Set();
  if (!(ctx.observedReferencePaths instanceof Set)) ctx.observedReferencePaths = new Set();
  if (!(ctx.observedReferencesByUrl instanceof Map)) ctx.observedReferencesByUrl = new Map();
  return ctx;
}

function normalizeReferenceUrl(value = "") {
  try {
    const url = new URL(`${value || ""}`.trim());
    if (!["http:", "https:"].includes(url.protocol)) return "";
    url.hash = "";
    return url.href;
  } catch {
    return "";
  }
}

function observeReferenceUrl(ctx, item = {}) {
  ensureReferenceObservationState(ctx);
  const url = normalizeReferenceUrl(item.url);
  if (!url) return "";
  const prior = ctx.observedReferencesByUrl.get(url) || {};
  ctx.observedReferenceUrls.add(url);
  ctx.observedReferencesByUrl.set(url, {
    url,
    title: `${item.title || prior.title || ""}`.slice(0, 500),
    snippet: `${item.snippet || item.content || prior.snippet || ""}`.slice(0, 12000)
  });
  return url;
}

function observeReferencePath(ctx, value = "") {
  ensureReferenceObservationState(ctx);
  const source = `${value || ""}`.trim();
  if (!source || !path.isAbsolute(source)) return "";
  const absolute = path.resolve(source);
  ctx.observedReferencePaths.add(absolute);
  return absolute;
}

function seedReferenceObservations(ctx, options = {}) {
  ensureReferenceObservationState(ctx);
  const text = `${options.input || ""}`;
  for (const match of text.matchAll(/https?:\/\/[^\s<>"'）)】\]]+/giu)) {
    observeReferenceUrl(ctx, { url: match[0] });
  }
  for (const value of Array.isArray(options.paths) ? options.paths : []) {
    observeReferencePath(ctx, value);
  }
  return ctx;
}

module.exports = {
  ensureReferenceObservationState,
  normalizeReferenceUrl,
  observeReferenceUrl,
  observeReferencePath,
  seedReferenceObservations
};
