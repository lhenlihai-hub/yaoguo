import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  fetchPublicHttp,
  readResponseTextLimited
} = require("../src/platform/shared/urlSafety.js");
const {
  searchJina,
  searchPublicRss,
  searchTavily
} = require("../src/platform/research/webSearch/providers.js");

function createRequestHarness(specs, calls = []) {
  const pending = [...specs];
  return (options, onResponse) => {
    const request = new EventEmitter();
    request.end = (body) => {
      options.lookup(options.hostname, { all: true }, (lookupError, addresses) => {
        if (lookupError) {
          queueMicrotask(() => request.emit("error", lookupError));
          return;
        }
        const spec = pending.shift() || {};
        calls.push({
          hostname: options.hostname,
          path: options.path,
          agent: options.agent,
          addresses,
          body
        });
        queueMicrotask(() => {
          const incoming = Readable.from(spec.body === undefined ? [] : [Buffer.from(`${spec.body}`)]);
          incoming.statusCode = spec.status || 200;
          incoming.statusMessage = spec.statusMessage || "OK";
          incoming.socket = { remoteAddress: spec.peer || addresses[0]?.address || "" };
          incoming.headers = { ...(spec.headers || {}) };
          incoming.rawHeaders = Object.entries(spec.headers || {}).flatMap(([name, value]) => [name, `${value}`]);
          onResponse(incoming);
        });
      });
    };
    return request;
  };
}

test("fetchPublicHttp 把预校验 IP 绑定到实际连接，不会二次调用可变 DNS", async () => {
  let dnsCalls = 0;
  const requests = [];
  const response = await fetchPublicHttp(
    "https://rebind.test/report?mode=full",
    {},
    {
      lookupImpl: async () => {
        dnsCalls += 1;
        return dnsCalls === 1
          ? [{ address: "93.184.216.34", family: 4 }]
          : [{ address: "127.0.0.1", family: 4 }];
      },
      requestImpl: createRequestHarness([
        { peer: "::ffff:93.184.216.34", body: "public body" }
      ], requests)
    }
  );

  assert.equal(dnsCalls, 1);
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].addresses, [{ address: "93.184.216.34", family: 4 }]);
  assert.equal(requests[0].path, "/report?mode=full");
  assert.equal(requests[0].agent, false, "安全请求不得复用未校验 socket");
  assert.equal(await response.text(), "public body");
});

test("fetchPublicHttp 拒绝实际 peer 落到私网，即使 DNS 预校验返回公网", async () => {
  await assert.rejects(
    () => fetchPublicHttp("https://peer.test/", {}, {
      lookupImpl: async () => [{ address: "93.184.216.34", family: 4 }],
      requestImpl: createRequestHarness([{ peer: "127.0.0.1", body: "private" }])
    }),
    (error) => error?.code === "URL_PEER_BLOCKED"
  );
});

test("fetchPublicHttp 拒绝不在已验证 DNS 集合中的其他公网 peer", async () => {
  await assert.rejects(
    () => fetchPublicHttp("https://mismatch.test/", {}, {
      lookupImpl: async () => [{ address: "93.184.216.34", family: 4 }],
      requestImpl: createRequestHarness([{ peer: "1.1.1.1", body: "wrong peer" }])
    }),
    (error) => error?.code === "URL_PEER_MISMATCH"
  );
});

test("fetchPublicHttp 的每一跳重定向都重新校验并绑定各自 IP", async () => {
  const dnsHosts = [];
  const requests = [];
  const requestImpl = createRequestHarness([
    {
      status: 302,
      peer: "93.184.216.34",
      headers: { location: "https://second.test/final" },
      body: "redirect"
    },
    { status: 200, peer: "1.1.1.1", body: "done" }
  ], requests);
  const response = await fetchPublicHttp("https://first.test/start", {}, {
    lookupImpl: async (hostname) => {
      dnsHosts.push(hostname);
      return [{
        address: hostname === "first.test" ? "93.184.216.34" : "1.1.1.1",
        family: 4
      }];
    },
    requestImpl
  });

  assert.deepEqual(dnsHosts, ["first.test", "second.test"]);
  assert.deepEqual(
    requests.map((request) => request.addresses[0].address),
    ["93.184.216.34", "1.1.1.1"]
  );
  assert.equal(response.url, "https://second.test/final");
  assert.equal(await response.text(), "done");
});

test("fetchPublicHttp 保留显式 fetchImpl 注入的确定性测试路径", async () => {
  let calls = 0;
  const response = await fetchPublicHttp("https://8.8.8.8/image.png", {}, {
    fetchImpl: async (url, init) => {
      calls += 1;
      assert.equal(url, "https://8.8.8.8/image.png");
      assert.equal(init.redirect, "manual");
      return new Response("injected", { status: 200 });
    },
    requestImpl: () => {
      throw new Error("显式 fetchImpl 注入时不应进入生产 socket 路径");
    }
  });
  assert.equal(calls, 1);
  assert.equal(await response.text(), "injected");
});

test("readResponseTextLimited 在展示截断前先限制真实网络读取字节", async () => {
  const response = new Response("123456");
  await assert.rejects(
    () => readResponseTextLimited(response, 5),
    (error) => error?.code === "URL_RESPONSE_TOO_LARGE"
  );
});

test("检索 provider 拒绝把请求或 API key 发往自定义 origin", async () => {
  for (const operation of [
    () => searchJina("x", { jinaSearchEndpoint: "https://evil.example/search" }),
    () => searchPublicRss("x", { publicEndpoint: "https://evil.example/rss" }),
    () => searchTavily("x", { apiKey: "secret", endpoint: "https://evil.example/search" })
  ]) {
    await assert.rejects(operation, (error) => error?.code === "PROVIDER_ENDPOINT_BLOCKED");
  }
});
