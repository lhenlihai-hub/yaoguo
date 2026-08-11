function throwIfAborted(signal, cause = null) {
  if (!signal?.aborted && cause?.name !== "AbortError") return;
  if (signal?.reason instanceof Error) throw signal.reason;
  const error = new Error("操作已取消。");
  error.name = "AbortError";
  throw error;
}

module.exports = { throwIfAborted };
