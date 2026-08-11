class NullErrorReporter {
  capture() {
    return null;
  }
}

function normalizeError(error) {
  if (!error) return { name: "Error", message: "未知错误" };
  return {
    name: error.name || "Error",
    message: error.message || String(error),
    stack: error.stack || ""
  };
}

function captureOptionalError(reporter, error, meta = {}) {
  const payload = {
    severity: meta.severity || "warning",
    scope: meta.scope || "unknown",
    error: normalizeError(error),
    context: meta.context || {}
  };
  if (reporter && typeof reporter.capture === "function") {
    reporter.capture(payload);
  }
  return payload;
}

module.exports = {
  NullErrorReporter,
  normalizeError,
  captureOptionalError
};
