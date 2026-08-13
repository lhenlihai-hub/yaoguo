// @ts-check

// 记忆服务的 Prompt 契约共用同一加载策略：进程内缓存 60 秒，到期后自动重载；
// 失败即清缓存允许下次重试。Prompt 资产迭代无需重启进程。
const PROMPT_CONTRACT_TTL_MS = 60_000;

/**
 * @param {{
 *   registryService?:any,
 *   blockId:string,
 *   reportError?:((error:any) => void) | null,
 *   now?:() => number
 * }} options
 * @returns {() => Promise<string>}
 */
function createPromptContractLoader({ registryService, blockId, reportError = null, now = Date.now }) {
  let promise = null;
  let loadedAt = 0;
  return async function loadContract() {
    if (!registryService?.getPromptBlock) return "";
    if (promise && now() - loadedAt < PROMPT_CONTRACT_TTL_MS) return promise;
    loadedAt = now();
    promise = registryService
      .getPromptBlock(blockId, { required: true })
      .then((row) => `${row?.asset?.content || ""}`.trim())
      .catch((error) => {
        promise = null;
        if (typeof reportError === "function") reportError(error);
        return "";
      });
    return promise;
  };
}

module.exports = {
  PROMPT_CONTRACT_TTL_MS,
  createPromptContractLoader
};
