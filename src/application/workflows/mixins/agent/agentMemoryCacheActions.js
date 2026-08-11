module.exports = {
  parseMemoryCacheCommand(message = "") {
    const command = `${message || ""}`.trim().toLowerCase();
    if (command === "/clear") return "clear";
    if (command === "/memory") return "memory";
    return "";
  },

  async executeMemoryCacheCommand({
    operation = "", message = "", projectId = "", taskId = "", runId = "",
    turnId = "", source = "desktop", options = {}
  } = {}) {
    if (!this.memoryCacheService?.taskScope || !this.memoryCacheService?.invalidate) {
      throw Object.assign(new Error("记忆缓存服务不可用。"), { code: "MEMORY_CACHE_UNAVAILABLE" });
    }
    if (!options.skipUserLog) {
      await this.appendAgentMessage({
        role: "user", content: message, projectId, taskId, runId, turnId,
        source, status: "accepted"
      });
    }
    const cacheScope = this.memoryCacheService.taskScope(projectId, taskId);
    const invalidation = this.memoryCacheService.invalidate(cacheScope, operation);
    const reply = operation === "memory"
      ? "已清除当前任务的规则文件解析缓存；用户上下文与系统记忆规范缓存保持不变。"
      : "已清除当前任务的规则文件、用户上下文和系统记忆规范三层缓存。";
    if (!options.skipAssistantLog) {
      await this.appendAgentMessage({
        role: "assistant", content: reply, projectId, taskId, runId, turnId,
        source, status: "completed", stopCode: `memory_cache_${operation}`
      });
    }
    return {
      reply,
      cancelled: false,
      blocked: false,
      stopCode: `memory_cache_${operation}`,
      projectId,
      taskId,
      runId,
      turnId,
      disposition: "cache-control",
      cache: invalidation
    };
  }
};
