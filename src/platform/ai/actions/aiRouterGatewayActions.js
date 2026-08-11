const { resolveMaxTokens } = require("../maxTokensRegistry");

module.exports = {
  // runTask 内部已经填了 maxTokens；少数直接调用 complete 的场景会绕过
  // runTask。调用方没显式声明时统一补模型物理上限，避免落入 4096 的兜底。
  complete(provider, model, messages, options = {}) {
    if (options.maxTokens) {
      return this.modelGateway.complete(provider, model, messages, options);
    }
    const enriched = {
      ...options,
      maxTokens: resolveMaxTokens({
        model,
        providerOverride: provider?.maxTokens
      })
    };
    return this.modelGateway.complete(provider, model, messages, enriched);
  },

  completeDetailed(provider, model, messages, options = {}) {
    if (options.maxTokens) {
      return this.modelGateway.completeDetailed(provider, model, messages, options);
    }
    return this.modelGateway.completeDetailed(provider, model, messages, {
      ...options,
      maxTokens: resolveMaxTokens({
        model,
        providerOverride: provider?.maxTokens
      })
    });
  }
};
