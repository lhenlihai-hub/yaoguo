import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { BridgeService } = require("../src/app/shell/bridgeService.js");

const TOKEN = "bridge-test-token";

async function createBridge({ workflowEngine = {}, limits = {}, config = {} } = {}) {
  const state = {
    enabled: true,
    host: "127.0.0.1",
    port: 0,
    token: TOKEN,
    ...config
  };
  const settingsService = { get: async () => ({ bridge: { ...state } }) };
  const schedulerService = {
    list: async () => [],
    create: async (body) => body
  };
  const service = new BridgeService(settingsService, workflowEngine, schedulerService, limits);
  const info = await service.start();
  assert.equal(info.running, true);
  return { service, info, state };
}

function request({ info, path = "/health", method = "GET", body = null, headers = {} }) {
  const rawBody = body === null ? "" : (typeof body === "string" ? body : JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: info.host,
      port: info.port,
      path,
      method,
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        ...(rawBody ? {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(rawBody)
        } : {}),
        ...headers
      }
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* raw response */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.once("error", reject);
    if (rawBody) req.write(rawBody);
    req.end();
  });
}

function requestChunked({ info, path, chunks = [] }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const req = http.request({
      host: info.host,
      port: info.port,
      path,
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
        "Transfer-Encoding": "chunked"
      }
    }, (res) => {
      const responseChunks = [];
      res.on("data", (chunk) => responseChunks.push(chunk));
      res.on("end", () => {
        if (settled) return;
        settled = true;
        resolve({
          status: res.statusCode,
          text: Buffer.concat(responseChunks).toString("utf8")
        });
      });
    });
    req.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    for (const chunk of chunks) req.write(chunk);
    req.end();
  });
}

function slowBodyRequest(info) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const req = http.request({
      host: info.host,
      port: info.port,
      path: "/agent",
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
        "Transfer-Encoding": "chunked"
      }
    }, (res) => {
      res.resume();
      res.on("end", () => {
        if (settled) return;
        settled = true;
        resolve(res.statusCode);
      });
    });
    req.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    req.flushHeaders();
    req.write('{"message":"partial');
  });
}

function rawExchange(info, initialBytes, timeoutMs = 1_000) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: info.host, port: info.port });
    let response = "";
    let settled = false;
    const finish = (error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(response);
    };
    const timer = setTimeout(() => finish(new Error("raw bridge request timed out")), timeoutMs);
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(initialBytes));
    socket.on("data", (chunk) => { response += chunk; });
    socket.on("end", () => finish());
    socket.on("close", () => finish());
    socket.on("error", (error) => finish(error));
  });
}

async function waitFor(predicate, timeoutMs = 1_000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("bridge 强制 header/body 大小上限，且超限不进入业务层", async () => {
  let agentCalls = 0;
  const { service, info } = await createBridge({
    workflowEngine: {
      submitAgentInput: async () => {
        agentCalls += 1;
        return { reply: "unexpected" };
      }
    },
    limits: { maxBodyBytes: 128, maxHeaderBytes: 256 }
  });
  try {
    assert.equal(service.server.maxHeadersCount, 64);
    const declared = await request({
      info,
      path: "/agent",
      method: "POST",
      body: { message: "x".repeat(256), projectId: "p1", taskId: "t1", turnId: "turn-large" }
    });
    assert.equal(declared.status, 413);
    assert.equal(declared.json.code, "BRIDGE_BODY_TOO_LARGE");

    const streamed = await requestChunked({
      info,
      path: "/agent",
      chunks: ['{"turnId":"turn-chunked","message":"', "x".repeat(256), '"}']
    });
    assert.equal(streamed.status, 413);

    const oversizedHeader = await rawExchange(info, [
      "GET /health HTTP/1.1",
      "Host: localhost",
      `X-Filler: ${"x".repeat(512)}`,
      "Connection: close",
      "",
      ""
    ].join("\r\n"));
    assert.match(oversizedHeader, /^HTTP\/1\.1 431 /);
    assert.equal(agentCalls, 0);
  } finally {
    await service.stop();
  }
});

test("bridge 对未完整 header 和慢速 body 都有有界超时", async () => {
  const { service, info } = await createBridge({
    limits: {
      headersTimeoutMs: 30,
      requestTimeoutMs: 120,
      bodyTimeoutMs: 35,
      connectionsCheckingIntervalMs: 5
    }
  });
  try {
    assert.equal(service.server.headersTimeout, 30);
    assert.equal(service.server.requestTimeout, 120);
    const partialHeader = rawExchange(info, "POST /agent HTTP/1.1\r\nHost: localhost\r\nX-Slow:");
    const bodyStatus = slowBodyRequest(info);
    assert.match(await partialHeader, /^HTTP\/1\.1 408 /);
    assert.equal(await bodyStatus, 408);
  } finally {
    await service.stop();
  }
});

test("/agent 强制稳定幂等键，不再为断线重试随机生成新 turnId", async () => {
  const calls = [];
  const { service, info } = await createBridge({
    workflowEngine: {
      submitAgentInput: async (payload, options) => {
        calls.push({ payload, options });
        return { reply: "ok", turnId: payload.turnId };
      }
    }
  });
  try {
    const missing = await request({
      info,
      path: "/agent",
      method: "POST",
      body: { message: "hello", projectId: "p1", taskId: "t1" }
    });
    assert.equal(missing.status, 400);
    assert.equal(missing.json.code, "BRIDGE_TURN_ID_REQUIRED");
    assert.equal(calls.length, 0);

    const accepted = await request({
      info,
      path: "/agent",
      method: "POST",
      body: { message: "hello", projectId: "p1", taskId: "t1" },
      headers: { "Idempotency-Key": "turn-retry-stable" }
    });
    assert.equal(accepted.status, 200);
    assert.equal(calls[0].payload.turnId, "turn-retry-stable");
    assert.equal(calls[0].options.signal instanceof AbortSignal, true);

    const conflict = await request({
      info,
      path: "/agent",
      method: "POST",
      body: {
        message: "hello",
        projectId: "p1",
        taskId: "t1",
        turnId: "turn-body"
      },
      headers: { "Idempotency-Key": "turn-header" }
    });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.json.code, "BRIDGE_TURN_ID_CONFLICT");
    assert.equal(calls.length, 1);
  } finally {
    await service.stop();
  }
});

test("/run-workflow 只接受稳定 runId，旧 workflowId 不再进入 Agent 请求", async () => {
  const starts = [];
  const { service, info } = await createBridge({
    workflowEngine: {
      startRun: async (payload) => {
        starts.push(payload);
        return { run: { id: payload.runId } };
      }
    }
  });
  try {
    const missing = await request({
      info,
      path: "/run-workflow",
      method: "POST",
      body: { projectId: "p1", taskId: "t1", command: "执行", autoRun: false }
    });
    assert.equal(missing.status, 400);
    assert.equal(missing.json.code, "BRIDGE_RUN_ID_REQUIRED");

    const accepted = await request({
      info,
      path: "/run-workflow",
      method: "POST",
      body: {
        projectId: "p1",
        taskId: "t1",
        command: "执行",
        workflowId: "retired-custom-workflow",
        autoRun: false
      },
      headers: { "Idempotency-Key": "run-stable" }
    });
    assert.equal(accepted.status, 200);
    assert.equal(starts.length, 1);
    assert.equal(starts[0].runId, "run-stable");
    assert.equal("workflowId" in starts[0], false);
  } finally {
    await service.stop();
  }
});

test("/agent 客户端断连会 abort 对应执行，保留同 turnId 的可恢复语义", async () => {
  let signal = null;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const { service, info } = await createBridge({
    workflowEngine: {
      submitAgentInput: async (_payload, options) => {
        signal = options.signal;
        markStarted();
        return new Promise((resolve) => {
          signal.addEventListener("abort", () => resolve({ cancelled: true }), { once: true });
        });
      }
    }
  });
  try {
    const body = JSON.stringify({
      message: "long work",
      projectId: "p1",
      taskId: "t1",
      turnId: "turn-disconnect"
    });
    const req = http.request({
      host: info.host,
      port: info.port,
      path: "/agent",
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body)
      }
    });
    req.on("error", () => {});
    req.end(body);
    await started;
    req.destroy();
    await waitFor(() => signal?.aborted === true);
    assert.equal(signal.reason.code, "BRIDGE_CLIENT_DISCONNECTED");
  } finally {
    await service.stop();
  }
});

test("stop 在宽限期后强制关闭活动连接，不被忽略 abort 的业务永久挂起", async () => {
  let signal = null;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const { service, info } = await createBridge({
    workflowEngine: {
      submitAgentInput: async (_payload, options) => {
        signal = options.signal;
        markStarted();
        return new Promise(() => {});
      }
    },
    limits: { stopGraceMs: 30 }
  });
  const body = JSON.stringify({
    message: "never resolves",
    projectId: "p1",
    taskId: "t1",
    turnId: "turn-stop"
  });
  const req = http.request({
    host: info.host,
    port: info.port,
    path: "/agent",
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body)
    }
  });
  req.on("error", () => {});
  req.end(body);
  await started;

  const before = Date.now();
  await service.stop();
  const elapsed = Date.now() - before;
  assert.ok(elapsed < 500, `stop 应有界返回，实际 ${elapsed}ms`);
  assert.equal(signal.aborted, true);
  assert.equal(signal.reason.code, "BRIDGE_STOPPED");
  assert.equal(service.info.running, false);
});

test("重新读取到 disabled 配置时会关闭已在监听的旧 bridge", async () => {
  const { service, state } = await createBridge();
  const previousServer = service.server;
  state.enabled = false;
  const info = await service.start();
  assert.equal(info.running, false);
  assert.equal(previousServer.listening, false);
  assert.equal(service.server, null);
});
