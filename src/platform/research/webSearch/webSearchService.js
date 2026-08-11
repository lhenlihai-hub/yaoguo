const { getApiKey } = require("../../runtime");
const { throwIfAborted } = require("../referenceAbort");
const providers = require("./providers");

class WebSearchService {
  constructor(paths, settingsService) {
    this.paths = paths;
    this.settingsService = settingsService;
    this.cache = new Map();
  }

  canUseConfiguredSearch(config = {}) {
    return Boolean(config.enabled && getApiKey(config));
  }

  async withCache(cacheKey, ttlMs, loader) {
    const now = Date.now();
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > now) return cached.value;
    const value = await loader();
    this.cache.set(cacheKey, { value, expiresAt: now + ttlMs });
    if (this.cache.size > 120) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
    return value;
  }

  async searchConfiguredOrPublic(query, config = {}) {
    const useConfigured = this.canUseConfiguredSearch(config);
    const provider = useConfigured ? config.provider || "tavily" : "public-rss";
    const cacheKey = ["web", provider, config.market || "zh-CN", config.count || 8, query].join("|");
    const ttlMs = config.cacheTtlMs || 90000;
    return this.withCache(cacheKey, ttlMs, async () => {
      if (useConfigured) {
        try {
          if (provider !== "tavily") throw new Error(`网页检索 provider 已停用或不受支持：${provider}`);
          const chunk = await this.searchTavily(query, config);
          return chunk.map((item) => ({ ...item, searchProvider: provider }));
        } catch (error) {
          throwIfAborted(config.signal, error);
          if (config.publicFallback === false) throw error;
        }
      }
      return this.searchPublicWeb(query, config);
    });
  }

  async searchPublicWeb(query, config = {}) {
    if (config.publicProvider !== "bing-rss") {
      try {
        const jina = await this.searchJina(query, config);
        if (jina.length) return jina;
      } catch (error) {
        throwIfAborted(config.signal, error);
      }
    }
    return this.searchPublicRss(query, config);
  }

  async searchJina(query, config = {}) {
    return providers.searchJina(query, config);
  }

  async searchPublicRss(query, config = {}) {
    return providers.searchPublicRss(query, config);
  }

  async fetchReadablePage(url, config = {}) {
    return providers.fetchReadablePage(this, url, config);
  }

  async fetchReadablePageDirect(url, config = {}) {
    return providers.fetchReadablePageDirect(url, config);
  }

  async fetchReadablePageViaReader(url, config = {}) {
    return providers.fetchReadablePageViaReader(url, config);
  }

  async searchTavily(query, config = {}) {
    return providers.searchTavily(query, config);
  }
}

module.exports = { WebSearchService };
