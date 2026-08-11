const http = require("node:http");
const crypto = require("node:crypto");

// 覆盖 Agent 约 700k token 的无损外置阈值，同时给本地桥保留明确内存上限。
const DEFAULT_LIMITS = Object.freeze({
  maxBodyBytes: 8 * 1024 * 1024,
  maxHeaderBytes: 16 * 1024,
  maxHeadersCount: 64,
  headersTimeoutMs: 5_000,
  requestTimeoutMs: 30_000,
  bodyTimeoutMs: 30_000,
  keepAliveTimeoutMs: 5_000,
  connectionsCheckingIntervalMs: 1_000,
  maxRequestsPerSocket: 100,
  stopGraceMs: 2_000
});

class BridgeService {
  constructor(settingsService, workflowEngine, schedulerService, options = {}) {
    this.settingsService = settingsService;
    this.workflowEngine = workflowEngine;
    this.schedulerService = schedulerService;
    this.limits = normalizeLimits(options);
    this.server = null;
    this.serverSockets = new Set();
    this.activeAgentRequests = new Set();
    this.stopPromise = null;
    this.info = { running: false };
  }

  async start() {
    const settings = await this.settingsService.get();
    const config = settings.bridge || {};
    // 重启或关闭开关都先停掉旧 listener，避免配置显示已关闭但端口仍可访问。
    await this.stop();
    if (!config.enabled) {
      this.info = { running: false, reason: "本地指令桥未启用" };
      return this.info;
    }

    const host = `${config.host || "127.0.0.1"}`;
    const port = normalizePort(config.port, 37521);
    const sockets = new Set();
    const server = http.createServer({
      maxHeaderSize: this.limits.maxHeaderBytes,
      headersTimeout: this.limits.headersTimeoutMs,
      requestTimeout: this.limits.requestTimeoutMs,
      keepAliveTimeout: this.limits.keepAliveTimeoutMs,
      connectionsCheckingInterval: this.limits.connectionsCheckingIntervalMs
    }, (req, res) => {
      this.handle(req, res).catch((error) => {
        this.sendJson(
          res,
          error.statusCode || 500,
          { error: error.message, ...(error.code ? { code: error.code } : {}) },
          { closeConnection: Boolean(error.closeConnection) }
        );
      });
    });
    server.maxHeadersCount = this.limits.maxHeadersCount;
    server.maxRequestsPerSocket = this.limits.maxRequestsPerSocket;
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });

    this.server = server;
    this.serverSockets = sockets;
    try {
      await listen(server, port, host);
    } catch (error) {
      if (this.server === server) this.server = null;
      for (const socket of sockets) socket.destroy();
      this.info = {
        running: false,
        reason: `本地指令桥启动失败：${error.message}`
      };
      return this.info;
    }
    const address = server.address();
    const listeningPort = typeof address === "object" && address ? address.port : port;
    this.info = {
      running: true,
      host,
      port: listeningPort,
      url: `http://${host}:${listeningPort}`
    };
    return this.info;
  }

  async stop() {
    if (this.stopPromise) return this.stopPromise;
    const server = this.server;
    if (!server) return;
    const sockets = this.serverSockets;
    this.server = null;
    this.info = { running: false };
    const stopping = this.stopServer(server, sockets).finally(() => {
      if (this.stopPromise === stopping) this.stopPromise = null;
      if (this.serverSockets === sockets) this.serverSockets = new Set();
    });
    this.stopPromise = stopping;
    return stopping;
  }

  async stopServer(server, sockets) {
    const reason = new Error("本地指令桥正在停止。");
    reason.code = "BRIDGE_STOPPED";
    for (const controller of this.activeAgentRequests) controller.abort(reason);
    this.activeAgentRequests.clear();

    const closed = closeServer(server);
    server.closeIdleConnections?.();
    if (await settlesWithin(closed, this.limits.stopGraceMs)) return;

    // close() 会等待活动请求；超过宽限期必须强制收口，不让应用退出/重启无限挂起。
    server.closeAllConnections?.();
    for (const socket of sockets) socket.destroy();
    await settlesWithin(closed, 100);
  }

  async restart() {
    return this.start();
  }

  async handle(req, res) {
    const url = new URL(req.url, "http://127.0.0.1");
    if (req.method === "OPTIONS") {
      return this.sendJson(res, 204, {});
    }
    if (url.pathname === "/health") {
      return this.sendJson(res, 200, { ok: true, bridge: this.info });
    }
    await this.requireAuth(req);
    if (req.method === "POST" && url.pathname === "/agent") {
      const body = await this.readBody(req);
      const turnId = resolveAgentTurnId(req, body);
      const lifecycle = this.trackAgentRequest(req, res);
      try {
        const result = await this.workflowEngine.submitAgentInput({
          message: body.message || "",
          projectId: body.projectId || "",
          taskId: body.taskId || "",
          source: "bridge",
          turnId
        }, { signal: lifecycle.signal });
        if (lifecycle.disconnected || res.destroyed) return;
        return this.sendJson(res, 200, result);
      } finally {
        lifecycle.release();
      }
    }
    if (req.method === "POST" && url.pathname === "/decision-answer") {
      const body = await this.readBody(req);
      const result = await this.workflowEngine.answerDecisionCard(body);
      return this.sendJson(res, 200, result);
    }
    if (req.method === "GET" && url.pathname === "/decisions") {
      const result = await this.workflowEngine.listDecisionCards({
        projectId: url.searchParams.get("projectId") || "",
        taskId: url.searchParams.get("taskId") || "",
        runId: url.searchParams.get("runId") || "",
        status: url.searchParams.get("status") || "pending"
      });
      return this.sendJson(res, 200, result);
    }
    if (req.method === "POST" && url.pathname === "/run-workflow") {
      const body = await this.readBody(req);
      const runId = resolveStableRequestId(req, body.runId, "runId");
      const started = await this.workflowEngine.startRun({
        projectId: body.projectId || "",
        taskId: body.taskId || "",
        topic: body.topic || "Agent 任务",
        command: body.command || "",
        runId
      });
      const result = body.autoRun === false
        ? started
        : await this.workflowEngine.runUntilBlocked(started.run.id);
      return this.sendJson(res, 200, result);
    }
    if (req.method === "GET" && url.pathname === "/jobs") {
      return this.sendJson(res, 200, await this.schedulerService.list());
    }
    if (req.method === "POST" && url.pathname === "/jobs") {
      const body = await this.readBody(req);
      return this.sendJson(res, 200, await this.schedulerService.create(body));
    }
    return this.sendJson(res, 404, { error: "未知接口" });
  }

  trackAgentRequest(req, res) {
    const controller = new AbortController();
    let disconnected = false;
    let released = false;
    const abortForDisconnect = () => {
      if (res.writableFinished || released) return;
      disconnected = true;
      controller.abort(Object.assign(new Error("桥客户端已断开连接。"), {
        code: "BRIDGE_CLIENT_DISCONNECTED"
      }));
    };
    req.once("aborted", abortForDisconnect);
    res.once("close", abortForDisconnect);
    this.activeAgentRequests.add(controller);
    return {
      signal: controller.signal,
      get disconnected() { return disconnected; },
      release: () => {
        if (released) return;
        released = true;
        req.off("aborted", abortForDisconnect);
        res.off("close", abortForDisconnect);
        this.activeAgentRequests.delete(controller);
      }
    };
  }

  async requireAuth(req) {
    const settings = await this.settingsService.get();
    const token = `${settings.bridge?.token || ""}`;
    const header = req.headers.authorization || "";
    const tokenHeader = req.headers["x-automation-token"] || "";
    if (token && (tokensEqual(header, `Bearer ${token}`) || tokensEqual(tokenHeader, token))) return;
    throw httpError(401, "本地指令桥鉴权失败。", "BRIDGE_AUTH_FAILED");
  }

  readBody(req) {
    const declaredLength = parseContentLength(req.headers["content-length"]);
    if (declaredLength > this.limits.maxBodyBytes) {
      req.resume();
      return Promise.reject(httpError(413, "请求体过大。", "BRIDGE_BODY_TOO_LARGE", true));
    }
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      let settled = false;
      const finish = (callback, value, { drain = false } = {}) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        req.off("data", onData);
        req.off("end", onEnd);
        req.off("aborted", onAborted);
        req.off("error", onError);
        if (drain && !req.destroyed) req.resume();
        callback(value);
      };
      const fail = (error, options) => finish(reject, error, options);
      const onData = (chunk) => {
        size += chunk.length;
        if (size > this.limits.maxBodyBytes) {
          fail(httpError(413, "请求体过大。", "BRIDGE_BODY_TOO_LARGE", true), { drain: true });
          return;
        }
        chunks.push(chunk);
      };
      const onEnd = () => {
        const text = Buffer.concat(chunks).toString("utf8");
        if (!text.trim()) return finish(resolve, {});
        try {
          finish(resolve, JSON.parse(text));
        } catch (error) {
          fail(httpError(400, `请求 JSON 解析失败：${error.message}`, "BRIDGE_JSON_INVALID"));
        }
      };
      const onAborted = () => fail(httpError(
        400,
        "客户端在请求体完整接收前断开。",
        "BRIDGE_REQUEST_ABORTED",
        true
      ));
      const onError = (error) => fail(error);
      const timer = setTimeout(() => fail(httpError(
        408,
        "请求体接收超时。",
        "BRIDGE_BODY_TIMEOUT",
        true
      ), { drain: true }), this.limits.bodyTimeoutMs);
      req.on("data", onData);
      req.once("end", onEnd);
      req.once("aborted", onAborted);
      req.once("error", onError);
    });
  }

  sendJson(res, status, payload, { closeConnection = false } = {}) {
    if (res.destroyed || res.writableEnded) return false;
    const body = status === 204 ? "" : JSON.stringify(payload ?? null);
    const headers = {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(body),
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "http://localhost",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Automation-Token, Idempotency-Key",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      ...(closeConnection ? { Connection: "close" } : {})
    };
    try {
      if (closeConnection) res.shouldKeepAlive = false;
      res.writeHead(status, headers);
      res.end(body);
      return true;
    } catch {
      res.destroy();
      return false;
    }
  }
}

function normalizeLimits(options = {}) {
  const limits = {};
  for (const [name, fallback] of Object.entries(DEFAULT_LIMITS)) {
    const value = Number(options[name]);
    limits[name] = Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
  }
  return Object.freeze(limits);
}

function normalizePort(value, fallback) {
  const port = Number(value);
  return Number.isInteger(port) && port >= 0 && port <= 65535 ? port : fallback;
}

function parseContentLength(value) {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined || raw === "") return 0;
  if (!/^\d+$/.test(`${raw}`)) throw httpError(400, "Content-Length 不合法。", "BRIDGE_CONTENT_LENGTH_INVALID", true);
  return Number(raw);
}

function resolveAgentTurnId(req, body = {}) {
  return resolveStableRequestId(req, body?.turnId, "turnId");
}

function resolveStableRequestId(req, bodyValue, fieldName) {
  const codeName = fieldName === "turnId" ? "TURN_ID" : "RUN_ID";
  const bodyId = `${bodyValue || ""}`.trim();
  const headerValue = req.headers["idempotency-key"];
  const headerId = `${Array.isArray(headerValue) ? headerValue[0] : (headerValue || "")}`.trim();
  if (bodyId && headerId && bodyId !== headerId) {
    throw httpError(409, `${fieldName} 与 Idempotency-Key 不一致。`, `BRIDGE_${codeName}_CONFLICT`);
  }
  const requestId = bodyId || headerId;
  if (!requestId) {
    throw httpError(
      400,
      `请求必须提供 ${fieldName} 或 Idempotency-Key，以便断线重试时复用同一执行。`,
      `BRIDGE_${codeName}_REQUIRED`
    );
  }
  if (requestId.length > 160 || requestId === "." || requestId === ".." || /[\/\\\0]/.test(requestId)) {
    throw httpError(400, `${fieldName} 不合法。`, `BRIDGE_${codeName}_INVALID`);
  }
  return requestId;
}

function httpError(statusCode, message, code = "", closeConnection = false) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  error.closeConnection = closeConnection;
  return error;
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    try {
      server.close(() => resolve());
    } catch (error) {
      if (error?.code === "ERR_SERVER_NOT_RUNNING") resolve();
      else resolve();
    }
  });
}

function settlesWithin(promise, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(false);
    }, timeoutMs);
    promise.then(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(true);
    }, () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function tokensEqual(actual, expected) {
  const actualValue = Array.isArray(actual) ? actual[0] : actual;
  const a = Buffer.from(`${actualValue || ""}`);
  const b = Buffer.from(`${expected || ""}`);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = {
  BridgeService,
  DEFAULT_LIMITS
};
