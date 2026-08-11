const SESSION_VERSION = 1;
const MAX_MESSAGE_WINDOW = 2000;
const SESSION_INLINE_CONTENT_CHARS = 65536;

function assertSessionScope(projectId, taskId) {
  if (!projectId || !taskId) throw new Error("任务会话缺少 projectId 或 taskId。");
}

module.exports = {
  SESSION_VERSION,
  MAX_MESSAGE_WINDOW,
  SESSION_INLINE_CONTENT_CHARS,
  assertSessionScope
};
