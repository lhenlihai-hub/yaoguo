async function mapLimit(items = [], limit = 3, worker) {
  const rows = Array.isArray(items) ? items : [];
  const results = new Array(rows.length);
  let cursor = 0;
  const size = Math.max(1, Number(limit) || 1);
  const runners = Array.from({ length: Math.min(size, rows.length) }, async () => {
    while (cursor < rows.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(rows[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

function sleep(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function timeoutSignal(ms = 8000, externalSignal = null) {
  const timeout = typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
    ? AbortSignal.timeout(ms)
    : null;
  if (!externalSignal) return timeout || undefined;
  if (!timeout) return externalSignal;
  return typeof AbortSignal.any === "function"
    ? AbortSignal.any([timeout, externalSignal])
    : externalSignal;
}

module.exports = {
  mapLimit,
  sleep,
  timeoutSignal
};
