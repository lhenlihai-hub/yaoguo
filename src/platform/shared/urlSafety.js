// @ts-check

const dns = require("node:dns/promises");
const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const { Readable } = require("node:stream");

const BLOCKED_HOSTS = new Set([
  "localhost", "localhost.localdomain", "host.docker.internal", "gateway.docker.internal",
  "metadata.google.internal", "metadata.azure.internal"
]);

async function assertSafeHttpUrl(rawUrl, { resolveDns = true, lookupImpl = dns.lookup } = {}) {
  return (await resolveSafeHttpTarget(rawUrl, { resolveDns, lookupImpl })).target;
}

async function resolveSafeHttpTarget(rawUrl, { resolveDns = true, lookupImpl = dns.lookup } = {}) {
  let target;
  try { target = new URL(`${rawUrl || ""}`); } catch { throw unsafe("URL_INVALID", "URL 格式无效。"); }
  if (!['http:', 'https:'].includes(target.protocol)) throw unsafe("URL_PROTOCOL_BLOCKED", "只允许 http/https URL。");
  if (target.username || target.password) throw unsafe("URL_CREDENTIALS_BLOCKED", "URL 不得包含用户名或密码。");
  const hostname = target.hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
  if (!hostname || BLOCKED_HOSTS.has(hostname) || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    throw unsafe("URL_HOST_BLOCKED", "不允许访问本机或局域网主机。");
  }
  const literalFamily = net.isIP(hostname);
  if (literalFamily && isBlockedIp(hostname)) throw unsafe("URL_IP_BLOCKED", "不允许访问私网、链路本地或保留地址。");
  let addresses = literalFamily ? [{ address: hostname, family: literalFamily }] : [];
  if (resolveDns && !net.isIP(hostname)) {
    let resolved;
    try {
      resolved = await withTimeout(lookupImpl(hostname, { all: true, verbatim: true }), 2500);
    } catch {
      throw unsafe("URL_DNS_FAILED", "URL 主机无法安全解析。");
    }
    addresses = normalizeLookupAddresses(resolved);
    if (!addresses.length || addresses.some((row) => isBlockedIp(row.address))) {
      throw unsafe("URL_DNS_BLOCKED", "URL 解析到私网、链路本地或保留地址。");
    }
  }
  return { target, hostname, addresses };
}

async function fetchPublicHttp(rawUrl, init = {}, options = {}) {
  const maxRedirects = normalizeRedirectLimit(options.maxRedirects);
  const fetchImpl = options.fetchImpl === undefined ? globalThis.fetch : options.fetchImpl;
  const usePinnedTransport = fetchImpl === globalThis.fetch;
  const resolveOptions = { lookupImpl: options.lookupImpl || dns.lookup };
  let current = await resolveSafeHttpTarget(rawUrl, resolveOptions);
  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    const response = usePinnedTransport
      ? await requestPinnedHttp(current, init, { requestImpl: options.requestImpl })
      : await fetchImpl(current.target.href, { ...init, redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    await discardResponseBody(response);
    if (!location) throw unsafe("URL_REDIRECT_INVALID", "网页返回了没有 Location 的重定向。");
    if (redirectCount === maxRedirects) throw unsafe("URL_REDIRECT_LIMIT", `网页重定向超过 ${maxRedirects} 次。`);
    current = await resolveSafeHttpTarget(new URL(location, current.target).href, resolveOptions);
  }
  throw unsafe("URL_REDIRECT_LIMIT", "网页重定向次数过多。");
}

async function readResponseTextLimited(response, maxBytes = 4_000_000) {
  const limit = Math.max(1, Math.floor(Number(maxBytes) || 4_000_000));
  const reader = response?.body?.getReader?.();
  if (!reader) return "";
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      bytes += chunk.length;
      if (bytes > limit) {
        await reader.cancel().catch(() => {});
        throw unsafe("URL_RESPONSE_TOO_LARGE", `网络响应超过 ${limit} bytes。`);
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks, bytes).toString("utf8");
}

async function requestPinnedHttp(resolution, init = {}, { requestImpl = null } = {}) {
  const { target, hostname } = resolution;
  const addresses = normalizeLookupAddresses(resolution.addresses);
  if (!addresses.length) throw unsafe("URL_DNS_FAILED", "URL 主机没有可绑定的安全地址。");
  const allowedPeers = new Set(addresses.map((row) => normalizeIpForComparison(row.address)));
  const headers = new Headers(init.headers || {});
  headers.delete("host");
  if (!headers.has("accept-encoding")) headers.set("accept-encoding", "identity");
  const method = `${init.method || "GET"}`.trim().toUpperCase() || "GET";
  if (["CONNECT", "TRACE", "TRACK"].includes(method)) {
    throw unsafe("URL_METHOD_BLOCKED", `不允许使用 ${method} 请求公开网页。`);
  }
  const body = await normalizeRequestBody(init.body);
  if (body && ["GET", "HEAD"].includes(method)) {
    throw unsafe("URL_REQUEST_INVALID", `${method} 请求不得包含 body。`);
  }
  const transportRequest = requestImpl || (target.protocol === "https:" ? https.request : http.request);
  const requestOptions = {
    protocol: target.protocol,
    hostname,
    port: target.port || undefined,
    path: `${target.pathname || "/"}${target.search || ""}`,
    method,
    headers: Object.fromEntries(headers.entries()),
    // 不复用其他请求的 socket；每一跳都必须连到本跳刚验证的 IP 集合。
    agent: false,
    lookup: createPinnedLookup(addresses),
    autoSelectFamily: addresses.length > 1,
    ...(init.signal ? { signal: init.signal } : {}),
    ...(target.protocol === "https:" && !net.isIP(hostname) ? { servername: hostname } : {})
  };
  return new Promise((resolve, reject) => {
    let settled = false;
    const settleReject = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const request = transportRequest(requestOptions, (incoming) => {
      const peer = normalizeIpForComparison(incoming.socket?.remoteAddress || "");
      if (!peer || isBlockedIp(peer)) {
        const error = unsafe("URL_PEER_BLOCKED", "实际连接到了私网、链路本地或无法验证的地址。");
        incoming.destroy();
        settleReject(error);
        return;
      }
      if (!allowedPeers.has(peer)) {
        const error = unsafe("URL_PEER_MISMATCH", "实际连接地址与已验证的 DNS 结果不一致。");
        incoming.destroy();
        settleReject(error);
        return;
      }
      try {
        const response = toFetchResponse(incoming, target.href, method);
        settled = true;
        resolve(response);
      } catch (error) {
        incoming.destroy();
        settleReject(error);
      }
    });
    request.once("error", settleReject);
    if (body) request.end(body);
    else request.end();
  });
}

function createPinnedLookup(addresses) {
  const rows = normalizeLookupAddresses(addresses);
  const preferred = rows.find((row) => row.family === 4) || rows[0];
  return (_hostname, lookupOptions, callback) => {
    if (typeof lookupOptions === "function") {
      callback = lookupOptions;
      lookupOptions = {};
    }
    if (lookupOptions?.all) {
      callback(null, rows.map((row) => ({ ...row })));
      return;
    }
    callback(null, preferred.address, preferred.family);
  };
}

function toFetchResponse(incoming, url, method) {
  const status = Number(incoming.statusCode) || 500;
  const headers = responseHeaders(incoming);
  const bodyForbidden = method === "HEAD" || [204, 205, 304].includes(status);
  const body = bodyForbidden ? null : Readable.toWeb(incoming);
  if (bodyForbidden) incoming.resume();
  const response = new Response(/** @type {any} */ (body), {
    status,
    statusText: `${incoming.statusMessage || ""}`,
    headers
  });
  Object.defineProperty(response, "url", { configurable: true, value: url });
  return response;
}

function responseHeaders(incoming) {
  const headers = new Headers();
  if (Array.isArray(incoming.rawHeaders) && incoming.rawHeaders.length) {
    for (let index = 0; index + 1 < incoming.rawHeaders.length; index += 2) {
      headers.append(`${incoming.rawHeaders[index]}`, `${incoming.rawHeaders[index + 1]}`);
    }
    return headers;
  }
  for (const [name, value] of Object.entries(incoming.headers || {})) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item !== undefined) headers.append(name, `${item}`);
    }
  }
  return headers;
}

async function normalizeRequestBody(body) {
  if (body === undefined || body === null) return null;
  if (typeof body === "string" || Buffer.isBuffer(body)) return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  if (typeof Blob !== "undefined" && body instanceof Blob) return Buffer.from(await body.arrayBuffer());
  throw unsafe("URL_REQUEST_BODY_UNSUPPORTED", "这种请求 body 无法在安全网络连接中发送。");
}

function normalizeLookupAddresses(value) {
  const rows = Array.isArray(value) ? value : (value ? [value] : []);
  const seen = new Set();
  const output = [];
  for (const row of rows) {
    const address = `${typeof row === "string" ? row : row?.address || ""}`.replace(/^\[|\]$/g, "").trim();
    const family = Number(typeof row === "string" ? net.isIP(address) : row?.family) || net.isIP(address);
    const normalized = normalizeIpForComparison(address);
    if (![4, 6].includes(family) || !normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    output.push({ address: normalized, family: net.isIP(normalized) || family });
  }
  return output;
}

function normalizeIpForComparison(address = "") {
  const value = `${address || ""}`.toLowerCase().replace(/^\[|\]$/g, "");
  if (net.isIPv4(value)) return value.split(".").map((part) => Number(part)).join(".");
  if (!net.isIPv6(value)) return "";
  const words = parseIpv6Words(value);
  if (words && words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff) {
    return `${words[6] >> 8}.${words[6] & 255}.${words[7] >> 8}.${words[7] & 255}`;
  }
  try {
    return new URL(`http://[${value}]/`).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    return "";
  }
}

async function discardResponseBody(response) {
  try { await response.body?.cancel?.(); } catch { /* 重定向响应体不影响下一跳安全校验。 */ }
}

function normalizeRedirectLimit(value) {
  if (value === undefined) return 5;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 20 ? parsed : 5;
}

function isBlockedIp(address = "") {
  const value = `${address}`.toLowerCase().replace(/^\[|\]$/g, "");
  if (net.isIPv4(value)) return isBlockedIpv4(value);
  if (!net.isIPv6(value)) return true;
  const words = parseIpv6Words(value);
  if (!words) return true;
  if (words.every((word) => word === 0) || words.slice(0, 7).every((word) => word === 0) && words[7] === 1) return true;

  // IPv4-compatible / IPv4-mapped forms may be normalized by URL to hex
  // (for example ::ffff:127.0.0.1 -> ::ffff:7f00:1). Inspect the final 32 bits.
  if (words.slice(0, 5).every((word) => word === 0) && (words[5] === 0 || words[5] === 0xffff)) {
    const embedded = `${words[6] >> 8}.${words[6] & 255}.${words[7] >> 8}.${words[7] & 255}`;
    return isBlockedIpv4(embedded);
  }

  const first = words[0];
  const second = words[1];
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link local
  if ((first & 0xff00) === 0xff00) return true; // multicast
  if (first === 0x0064 && second === 0xff9b) return true; // NAT64 translation prefixes
  if (first === 0x0100 && second === 0) return true; // discard-only 100::/64
  if (first === 0x2002) return true; // deprecated 6to4 embeds an IPv4 target
  if (first === 0x2001 && [0x0000, 0x0002, 0x000d, 0x0db8].includes(second)) return true;
  if (first === 0x2001 && (second & 0xfff0) === 0x0010) return true; // ORCHIDv1
  if (first === 0x2001 && (second & 0xfff0) === 0x0020) return true; // ORCHIDv2
  return false;
}

function parseIpv6Words(address) {
  let source = `${address || ""}`;
  const dotted = source.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    if (!net.isIPv4(dotted[1])) return null;
    const octets = dotted[1].split(".").map(Number);
    source = `${source.slice(0, -dotted[1].length)}${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  const halves = source.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  const raw = [...left, ...Array(Math.max(0, missing)).fill("0"), ...right];
  const words = raw.map((part) => /^[0-9a-f]{1,4}$/.test(part) ? Number.parseInt(part, 16) : NaN);
  return words.length === 8 && words.every(Number.isFinite) ? words : null;
}

function isBlockedIpv4(address) {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b, c] = parts;
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 192 && b === 0 && c <= 2)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113);
}

function unsafe(code, message) {
  const error = /** @type {Error & {code?: string}} */ (new Error(message));
  error.code = code;
  return error;
}

async function withTimeout(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), timeoutMs); })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  assertSafeHttpUrl,
  fetchPublicHttp,
  readResponseTextLimited,
  isBlockedIp,
  parseIpv6Words
};
