// @ts-check

const crypto = require("node:crypto");

/** @param {{sessionStore:any, scope:any, message:string}} options */
async function beginDurableTurn({ sessionStore, scope, message }) {
  if (typeof sessionStore?.beginTurnExecution !== "function"
    || typeof sessionStore?.finishTurnExecution !== "function") return null;
  const inputDigest = crypto.createHash("sha256").update(`${message || ""}`, "utf8").digest("hex");
  return sessionStore.beginTurnExecution({
    projectId: scope.projectId,
    taskId: scope.taskId,
    turnId: scope.turnId,
    runId: scope.runId,
    inputDigest
  });
}

/** @param {{sessionStore:any, scope:any, message:string, operation:Function, startedReceipt?:any}} options */
async function executeDurableTurn({ sessionStore, scope, message, operation, startedReceipt = null }) {
  const receipt = startedReceipt || await beginDurableTurn({ sessionStore, scope, message });
  if (!receipt) return operation();
  if (receipt.state !== "started") return replayTurnExecutionReceipt(receipt, scope);
  try {
    const result = await operation();
    await finishDurableTurn({
      sessionStore, scope, receipt, status: terminalStatus(result), stopCode: result?.stopCode
    });
    return result;
  } catch (error) {
    try {
      await finishDurableTurn({
        sessionStore,
        scope,
        receipt,
        status: "failed",
        stopCode: error?.code || "AGENT_EXECUTION_FAILED"
      });
    } catch (receiptError) {
      if (receiptError && typeof receiptError === "object" && !("cause" in receiptError)) receiptError.cause = error;
      throw receiptError;
    }
    throw error;
  }
}

/** @param {{sessionStore:any, scope:any, receipt:any, status:string, stopCode?:string}} options */
async function finishDurableTurn({ sessionStore, scope, receipt, status, stopCode = "" }) {
  if (!receipt || typeof sessionStore?.finishTurnExecution !== "function") return null;
  return sessionStore.finishTurnExecution({
    projectId: scope.projectId,
    taskId: scope.taskId,
    turnId: scope.turnId,
    runId: scope.runId,
    executionId: `${receipt.started?.executionId || ""}`,
    status,
    stopCode: safeCode(stopCode)
  });
}

function terminalStatus(result) {
  if (!result) return "failed";
  if (result.cancelled) return "cancelled";
  if (result.blocked) return "blocked";
  return "completed";
}

function safeCode(value) {
  return `${value || ""}`.replace(/[^a-zA-Z0-9_.-]+/g, "_").slice(0, 80);
}

function replayTurnExecutionReceipt(receipt = {}, scope = {}) {
  const status = `${receipt.terminal?.status || "interrupted"}`;
  const outcomes = {
    completed: ["execution_completed", "该轮执行已完成。为避免重复副作用，系统未再次执行。", false, false],
    cancelled: ["execution_cancelled", "该轮执行已停止。为避免重复副作用，系统未再次执行。", true, false],
    blocked: ["execution_blocked", "该轮执行已记录为阻塞。为避免重复副作用，系统未再次执行。", false, true],
    failed: ["execution_failed", "该轮执行已记录为失败。为避免重复副作用，系统未再次执行。", false, true],
    interrupted: [
      "execution_interrupted",
      "检测到该轮执行已开始但没有可靠终态。为避免重复副作用，系统不会自动重试；请发送一条新消息确认下一步。",
      false,
      true
    ]
  };
  const [disposition, reply, cancelled, blocked] = outcomes[status] || outcomes.interrupted;
  return {
    accepted: true,
    disposition,
    reply,
    cancelled,
    blocked,
    receiptStatus: status,
    projectId: `${scope.projectId || receipt.started?.projectId || ""}`,
    taskId: `${scope.taskId || receipt.started?.taskId || ""}`,
    runId: `${receipt.terminal?.runId || receipt.started?.runId || scope.runId || ""}`,
    turnId: `${scope.turnId || receipt.started?.turnId || ""}`,
    stopCode: `${receipt.terminal?.stopCode || (status === "interrupted" ? "AGENT_EXECUTION_INTERRUPTED" : "")}`
  };
}

module.exports = {
  beginDurableTurn,
  executeDurableTurn,
  finishDurableTurn,
  replayTurnExecutionReceipt
};
