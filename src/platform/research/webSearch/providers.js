const {
  compactText,
  decodeHtmlEntities,
  getApiKey,
  htmlToText,
  parseRssItems,
  timeoutSignal,
  truncate
} = require("../../runtime");
const {
  assertSafeHttpUrl,
  fetchPublicHttp,
  readResponseTextLimited
} = require("../../shared/urlSafety");
const { throwIfAborted } = require("../referenceAbort");

async function searchJina(query, config = {}) {
    const endpoint = officialProviderEndpoint(
      config.jinaSearchEndpoint,
      "https://s.jina.ai/",
      "https://s.jina.ai"
    );
    endpoint.searchParams.set("q", query);
    const response = await fetchPublicHttp(endpoint.href, {
      headers: {
        "Accept": "application/json",
        "X-Respond-With": "no-content",
        "User-Agent": "Mozilla/5.0 AppleWebKit/537.36 Chrome/120 Safari/537.36"
      },
      signal: timeoutSignal(config.timeoutMs || 9000, config.signal)
    }, networkInjection(config));
    const text = await readResponseTextLimited(response, 4_000_000);
    if (!response.ok) throw new Error(`Jina 检索失败 ${response.status}：${truncate(text, 240)}`);
    let data;
    try { data = JSON.parse(text); } catch { throw new Error("Jina 检索返回非 JSON。"); }
    const rows = Array.isArray(data?.data) ? data.data : [];
    const items = rows.slice(0, config.count || 8).map((item) => ({
      title: item.title || "",
      url: item.url || "",
      snippet: truncate(compactText(item.description || item.content || ""), 300),
      datePublished: item.date || item.timestamp || "",
      searchProvider: "jina"
    })).filter((item) => item.url);
    if (!items.length) throw new Error("Jina 检索没有返回结果。");
    return items;
  }

async function searchPublicRss(query, config = {}) {
    const endpoint = officialProviderEndpoint(
      config.publicEndpoint,
      "https://www.bing.com/search",
      "https://www.bing.com"
    );
    const params = new URLSearchParams({
      q: query,
      format: "rss",
      mkt: config.market || "zh-CN"
    });
    endpoint.search = params.toString();
    const response = await fetchPublicHttp(endpoint.href, {
      headers: {
        "Accept": "application/rss+xml, text/xml, application/xml;q=0.9, */*;q=0.6",
        "User-Agent": "Mozilla/5.0 AppleWebKit/537.36 Chrome/120 Safari/537.36"
      },
      signal: timeoutSignal(config.timeoutMs || 7000, config.signal)
    }, networkInjection(config));
    const text = await readResponseTextLimited(response, 2_000_000);
    if (!response.ok) {
      throw new Error(`公开检索失败 ${response.status}：${truncate(text, 300)}`);
    }
    const items = parseRssItems(text).slice(0, config.count || 8);
    if (!items.length) throw new Error("公开检索没有返回可解析的结果。");
    return items.map((item) => ({
      ...item,
      searchProvider: "public-rss"
    }));
  }

async function fetchReadablePage(service, url, config = {}) {
    try {
      return await service.fetchReadablePageDirect(url, config);
    } catch (directError) {
      throwIfAborted(config.signal, directError);
      if (config.readerFallback === false) throw directError;
      try {
        return await service.fetchReadablePageViaReader(url, config);
      } catch (readerError) {
        throw new Error(`${directError.message}；Reader 兜底失败：${readerError.message}`);
      }
    }
  }

async function fetchReadablePageDirect(url, config = {}) {
    const target = await assertSafeHttpUrl(url, { lookupImpl: config.lookupImpl });
    const response = await fetchPublicHttp(target.href, {
      headers: {
        "Accept": "text/html, text/plain, application/xhtml+xml;q=0.9, */*;q=0.5",
        "User-Agent": "Mozilla/5.0 AppleWebKit/537.36 Chrome/120 Safari/537.36"
      },
      signal: timeoutSignal(config.pageTimeoutMs || 9000, config.signal)
    }, networkInjection(config));
    const raw = await readResponseTextLimited(response, 8_000_000);
    if (!response.ok) {
      throw new Error(`网页抓取失败 ${response.status}：${truncate(raw, 240)}`);
    }
    const contentType = response.headers.get("content-type") || "";
    const text = contentType.includes("html")
      ? htmlToText(raw)
      : decodeHtmlEntities(raw).replace(/\s+/g, " ").trim();
    if (!text) throw new Error("网页没有可读正文。");
    return truncate(text, config.maxPreviewChars || 18000);
  }

async function fetchReadablePageViaReader(url, config = {}) {
    const target = await assertSafeHttpUrl(url, { lookupImpl: config.lookupImpl });
    const readerUrl = `https://r.jina.ai/${target.href}`;
    const response = await fetchPublicHttp(readerUrl, {
      headers: {
        "Accept": "text/plain, */*;q=0.5",
        "User-Agent": "Mozilla/5.0 AppleWebKit/537.36 Chrome/120 Safari/537.36"
      },
      signal: timeoutSignal(config.readerTimeoutMs || 12000, config.signal)
    }, networkInjection(config));
    const text = await readResponseTextLimited(response, 4_000_000);
    if (!response.ok) throw new Error(`Reader 返回 ${response.status}：${truncate(text, 240)}`);
    const clean = decodeHtmlEntities(text).replace(/\n{3,}/g, "\n\n").trim();
    if (!clean) throw new Error("Reader 没有返回可读正文。");
    return truncate(clean, config.maxPreviewChars || 18000);
  }

async function searchTavily(query, config) {
    const apiKey = getApiKey({ ...config, apiKeyEnv: config.apiKeyEnv || "TAVILY_API_KEY" });
    if (!apiKey) {
      throw new Error(`缺少网页检索 Key：${config.apiKeyEnv || "TAVILY_API_KEY"}`);
    }
    const endpoint = officialProviderEndpoint(
      config.endpoint,
      "https://api.tavily.com/search",
      "https://api.tavily.com"
    );
    const response = await fetchPublicHttp(endpoint.href, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        query,
        search_depth: config.searchDepth || "basic",
        max_results: config.count || 8,
        include_answer: false
      }),
      signal: timeoutSignal(config.timeoutMs || 7000, config.signal)
    }, networkInjection(config, { maxRedirects: 0 }));
    const text = await readResponseTextLimited(response, 4_000_000);
    if (!response.ok) {
      throw new Error(`Tavily 检索失败 ${response.status}：${truncate(text, 600)}`);
    }
    const data = JSON.parse(text);
    return (data.results || []).map((item) => ({
      title: item.title,
      url: item.url,
      snippet: item.content,
      score: item.score
    }));
  }

function officialProviderEndpoint(configured, fallback, allowedOrigin) {
  let endpoint;
  try { endpoint = new URL(`${configured || fallback}`); } catch {
    throw new Error("检索服务 endpoint 无效。");
  }
  if (endpoint.protocol !== "https:" || endpoint.origin !== allowedOrigin) {
    const error = new Error(`检索服务只允许官方 HTTPS endpoint：${allowedOrigin}`);
    error.code = "PROVIDER_ENDPOINT_BLOCKED";
    throw error;
  }
  endpoint.username = "";
  endpoint.password = "";
  endpoint.hash = "";
  return endpoint;
}

function networkInjection(config = {}, overrides = {}) {
  return {
    ...overrides,
    ...(typeof config.fetchImpl === "function" ? { fetchImpl: config.fetchImpl } : {}),
    ...(typeof config.lookupImpl === "function" ? { lookupImpl: config.lookupImpl } : {})
  };
}

module.exports = {
  fetchReadablePage,
  fetchReadablePageDirect,
  fetchReadablePageViaReader,
  searchJina,
  searchPublicRss,
  searchTavily
};
