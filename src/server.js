import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { CodexAuth } from "./auth.js";
import { loadConfig } from "./config.js";
import { HttpError, UpstreamStreamError, openAIError } from "./errors.js";
import { ConcurrencyLimiter, RateLimiter, StateStore, UpstreamGuard } from "./guard.js";
import { createLogger, silentLogger } from "./log.js";
import { ModelCatalog } from "./models.js";
import { QuotaReporter } from "./quota.js";
import { encodeSse, jsonFromSse, parseSse } from "./sse.js";
import { ChatCompletionState, toResponsesRequest } from "./translate.js";
import { CodexUpstream, baseHeaders } from "./upstream.js";

// The only paths served, matched against the raw request path (before "?"),
// byte for byte: no dot-segment normalisation, no percent-decoding, no "//"
// collapsing. Everything else gets a 404 before authentication, the request
// body is never read, and only a count is logged.
const ROUTES = new Set(["/healthz", "/v1/models", "/v1/chat/completions"]);
const UNMATCHED_SUMMARY_MS = 60_000;
// Upstream lifecycle events that carry nothing for the client. Streaming
// headers are held back past these so an immediate failure is an HTTP status.
const LIFECYCLE_EVENTS = new Set(["response.created", "response.in_progress", "response.queued"]);
// After an overall timeout, how long the handler gets to send its own error
// before the response is destroyed (a stalled client would never take it).
const TIMEOUT_GRACE_MS = 1_000;
const SSE_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-store",
  connection: "keep-alive",
  "x-accel-buffering": "no",
  "x-content-type-options": "nosniff"
};

function digest(value) {
  return createHash("sha256").update(value).digest();
}

// Hashing both sides gives equal-length buffers, so timingSafeEqual neither
// throws nor leaks the key length.
export function authorized(header, expected) {
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  return timingSafeEqual(digest(header.slice(7)), digest(expected));
}

export function rawPath(url) {
  const text = typeof url === "string" ? url : "";
  const cut = text.search(/[?#]/);
  return cut === -1 ? text : text.slice(0, cut);
}

function sendJson(response, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...extraHeaders
  });
  response.end(payload);
}

// For answers sent before the request body was read (401, 404, 413, local
// 429/503): close the connection and drop whatever body is still arriving,
// so an unauthenticated client cannot make the proxy read or buffer it.
function sendAndClose(request, response, status, body, extraHeaders = {}) {
  response.shouldKeepAlive = false;
  sendJson(response, status, body, { ...extraHeaders, connection: "close" });
  response.once("finish", () => request.destroy());
}

async function readJson(request, maxBytes) {
  const declared = Number.parseInt(request.headers["content-length"] ?? "0", 10);
  if (declared > maxBytes) throw new HttpError(413, "Request body is too large.", "request_too_large");
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new HttpError(413, "Request body is too large.", "request_too_large");
    chunks.push(chunk);
  }
  if (size === 0) throw new HttpError(400, "A JSON request body is required.", "body_required");
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Request body must be valid JSON.", "invalid_json");
  }
}

// Writes with backpressure. A client that stops reading (full socket buffer,
// no "drain") would otherwise pin this handler and its upstream stream
// forever; after drainTimeoutMs the response is destroyed, which also aborts
// the upstream request through the "close" listener.
export async function write(response, text, drainTimeoutMs = 30_000) {
  if (response.destroyed || response.writableEnded) return;
  if (response.write(text)) return;
  await new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      response.off("drain", done);
      response.off("close", done);
    };
    const done = () => {
      cleanup();
      resolve();
    };
    const timer = setTimeout(() => {
      cleanup();
      response.destroy();
      reject(new HttpError(504, "The client stopped reading the response.", "client_stalled", "timeout_error"));
    }, drainTimeoutMs);
    response.once("drain", done);
    response.once("close", done);
  });
}

function streamError(error) {
  return encodeSse(openAIError(error).body);
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function createProxyServer({
  config,
  upstream,
  models,
  quota,
  guard = new UpstreamGuard(),
  limiter = new ConcurrencyLimiter({ max: config.maxConcurrentRequests, maxWaitMs: config.maxQueueWaitMs }),
  rate = new RateLimiter({ perMinute: config.rateLimitPerMinute, minSpacingMs: config.minRequestSpacingMs, dailyLimit: config.dailyRequestLimit }),
  logger = silentLogger,
  now = Date.now
}) {
  let unmatched = 0;
  let lastUnmatchedSummary = now();

  function countUnmatched() {
    unmatched += 1;
    if (now() - lastUnmatchedSummary >= UNMATCHED_SUMMARY_MS) {
      logger.warn("unmatched requests (paths not logged)", { count: unmatched, window_s: Math.round((now() - lastUnmatchedSummary) / 1000) });
      unmatched = 0;
      lastUnmatchedSummary = now();
    }
  }

  async function handle(request, response) {
    const started = now();
    const pathname = rawPath(request.url);

    if (!ROUTES.has(pathname)) {
      countUnmatched();
      return sendAndClose(request, response, 404, openAIError(new HttpError(404, "Not found.", "not_found")).body);
    }

    // Socket inactivity limit; Node destroys the socket when it fires. Upstream
    // events re-arm it below, so only a truly dead exchange is cut.
    const armSocket = () => request.socket?.setTimeout?.(config.socketIdleTimeoutMs ?? 330_000);
    armSocket();

    const abortController = new AbortController();
    let timedOut = false;
    let idleTimedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      abortController.abort();
      // Destroy if the handler cannot get its error out (stalled client).
      setTimeout(() => { if (!response.writableFinished) response.destroy(); }, TIMEOUT_GRACE_MS).unref();
    }, config.requestTimeoutMs);
    // Client went away (Cursor cancelled): stop the upstream request too, so no
    // quota is spent on output nobody reads.
    response.once("close", () => {
      if (!response.writableFinished) abortController.abort();
    });
    const fields = { method: request.method, route: pathname };
    let release;
    let idleTimer;
    let keepAlive;
    let firstEventTimer;

    try {
      if (pathname === "/healthz") {
        if (request.method !== "GET" && request.method !== "HEAD") throw new HttpError(405, "Method not allowed.", "method_not_allowed");
        return sendJson(response, 200, { status: "ok" });
      }

      if (!authorized(request.headers.authorization, config.apiKey)) {
        throw new HttpError(401, "Invalid or missing proxy API key.", "invalid_api_key", "authentication_error");
      }
      guard.checkKill();

      if (pathname === "/v1/models") {
        if (request.method !== "GET") throw new HttpError(405, "Method not allowed.", "method_not_allowed");
        const { source, body } = await models.list(abortController.signal);
        fields.models_source = source;
        return sendJson(response, 200, body, { "x-codex-proxy-models-source": source });
      }

      // /v1/chat/completions
      if (request.method !== "POST") throw new HttpError(405, "Method not allowed.", "method_not_allowed");
      // Cooldowns and the concurrency slot come before the body is read, so a
      // flood of requests costs neither memory nor upstream calls.
      guard.checkCooldown();
      const queuedAt = now();
      release = await limiter.acquire(abortController.signal);
      const queuedMs = now() - queuedAt;
      if (queuedMs > 0) fields.queued_ms = queuedMs;
      const body = await readJson(request, config.maxRequestBytes);
      const { request: upstreamRequest, meta } = toResponsesRequest(body, {
        defaultReasoningEffort: config.defaultReasoningEffort,
        defaultServiceTier: config.defaultServiceTier
      });
      Object.assign(fields, {
        wire: meta.wireFormat,
        model: meta.model,
        effort: meta.effort,
        tier: meta.serviceTier,
        stream: meta.stream,
        dropped: meta.droppedKnown.join(",") || undefined,
        dropped_unknown: meta.droppedUnknown || undefined,
        dropped_items: meta.droppedItems || undefined,
        orphan_outputs: meta.orphanOutputs || undefined,
        missing_outputs: meta.missingOutputs || undefined,
        ignored_messages: meta.ignoredMessages || undefined
      });
      if (!(await models.allows(meta.requestedModel, abortController.signal))) {
        // The id matched MODEL_ID_RE in toResponsesRequest, so echoing it is safe.
        throw new HttpError(400, `The model '${meta.requestedModel}' is not offered by this proxy. Use an id from /v1/models.`, "model_not_found");
      }

      const wait = rate.reserve(Math.max(0, (config.maxQueueWaitMs ?? 60_000) - queuedMs));
      if (wait > 0) {
        fields.rate_wait_ms = wait;
        await sleep(wait, abortController.signal);
      }
      rate.admit();

      const upstreamResponse = await upstream.createResponse(upstreamRequest, abortController.signal);
      quota?.observe(upstreamResponse.headers);
      const state = new ChatCompletionState(body.model, {
        customToolShape: meta.customToolShape,
        includeUsage: meta.includeUsage,
        onWarning: (message, warnFields) => logger.warn(message, warnFields)
      });

      // B4: no upstream event for streamIdleTimeoutMs ends the request.
      const idleMs = config.streamIdleTimeoutMs ?? 300_000;
      const resetIdle = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          idleTimedOut = true;
          abortController.abort();
        }, idleMs);
      };
      resetIdle();
      const recordUsage = () => {
        if (!state.usage) return;
        Object.assign(fields, {
          in: state.usage.prompt_tokens,
          out: state.usage.completion_tokens,
          cached: state.usage.prompt_tokens_details?.cached_tokens
        });
      };

      if (!meta.stream) {
        for await (const sse of parseSse(upstreamResponse.body)) {
          resetIdle();
          armSocket();
          const event = jsonFromSse(sse);
          if (event) state.consume(event);
        }
        state.finish();
        guard.onSuccess();
        recordUsage();
        return sendJson(response, 200, state.completion());
      }

      // Hold the headers until the first event with content (or a short wait),
      // so a failure that arrives first is still an HTTP error status.
      const pending = [];
      const startStream = () => {
        if (response.headersSent || response.destroyed) return;
        clearTimeout(firstEventTimer);
        response.writeHead(200, SSE_HEADERS);
        for (const text of pending.splice(0)) response.write(text);
        keepAlive = config.keepAliveMs > 0
          ? setInterval(() => {
            if (!response.writableEnded && !response.writableNeedDrain) response.write(": keep-alive\n\n");
          }, config.keepAliveMs)
          : null;
      };
      const firstWait = config.firstEventWaitMs ?? 10_000;
      if (firstWait > 0) firstEventTimer = setTimeout(startStream, firstWait);
      else startStream();

      for await (const sse of parseSse(upstreamResponse.body)) {
        resetIdle();
        armSocket();
        const event = jsonFromSse(sse);
        if (!event) continue;
        const chunks = state.consume(event);
        if (!response.headersSent) {
          for (const chunk of chunks) pending.push(encodeSse(chunk));
          if (!LIFECYCLE_EVENTS.has(event.type)) startStream();
        } else {
          for (const chunk of chunks) await write(response, encodeSse(chunk), config.drainTimeoutMs);
        }
      }
      state.finish();
      guard.onSuccess();
      startStream();
      await write(response, encodeSse("[DONE]"), config.drainTimeoutMs);
      recordUsage();
      response.end();
    } catch (error) {
      let normalized = error;
      if (!(error instanceof HttpError) && (error?.name === "AbortError" || error?.name === "TimeoutError" || abortController.signal.aborted)) {
        if (idleTimedOut) {
          normalized = new HttpError(504, `The upstream stream sent nothing for ${Math.round((config.streamIdleTimeoutMs ?? 300_000) / 1000)} s.`, "upstream_idle_timeout", "timeout_error");
        } else if (timedOut) {
          normalized = new HttpError(504, "The request timed out.", "request_timeout", "timeout_error");
        } else {
          normalized = new HttpError(499, "The client closed the request.", "client_closed", "timeout_error");
        }
      }
      if (normalized instanceof UpstreamStreamError) {
        guard.observeError(normalized.status, normalized.code, { resetsAt: normalized.resetsAt, resetsInSeconds: normalized.resetsInSeconds });
      }
      const { status, body: errorBody } = openAIError(normalized);
      fields.status = status;
      fields.code = normalized?.code;
      const retryAfter = normalized?.retryAfter ?? (status === 429 ? guard.retryAfterFor() : undefined);
      const extra = retryAfter ? { "retry-after": String(retryAfter) } : {};
      if (response.headersSent) {
        // Mid-stream failure: send an OpenAI-style error event and end WITHOUT
        // [DONE], so the client sees a failure rather than a short, "complete" answer.
        if (!response.writableEnded && !response.destroyed) {
          response.write(streamError(normalized));
          response.end();
        }
      } else if (!response.destroyed) {
        if (request.complete && status !== 401 && status !== 413) sendJson(response, status, errorBody, extra);
        else sendAndClose(request, response, status, errorBody, extra);
      }
      if (!(normalized instanceof HttpError)) {
        // Unexpected bug: log its class only. error.message could quote request content.
        fields.error = normalized?.name ?? "Error";
      }
    } finally {
      release?.();
      clearTimeout(timeout);
      clearTimeout(idleTimer);
      clearTimeout(firstEventTimer);
      if (keepAlive) clearInterval(keepAlive);
      fields.status ??= response.statusCode;
      fields.ms = now() - started;
      // Fixed fields only: never headers, bodies, prompts, or tokens.
      logger.info("request", fields);
    }
  }

  const server = createServer((request, response) => {
    handle(request, response).catch(() => {
      if (!response.headersSent && !response.destroyed) sendJson(response, 500, openAIError(new Error("x")).body);
      else response.destroy();
    });
  });
  server.headersTimeout = 30_000;
  return server;
}

export function buildServer(config = loadConfig(), { fetchImpl = globalThis.fetch, logger = createLogger(), now = Date.now, random = Math.random } = {}) {
  const store = new StateStore({ file: config.stateFile, logger });
  const guard = new UpstreamGuard({
    store,
    logger,
    now,
    random,
    openAfter: config.breakerOpenAfter ?? 3,
    maxBackoffMs: config.breakerMaxBackoffMs ?? 60_000
  });
  const auth = new CodexAuth({
    authFile: config.authFile,
    refreshSkewMs: config.refreshSkewMs,
    refreshMode: config.refreshMode,
    tokenUrl: config.tokenUrl,
    baseHeaders: baseHeaders(config),
    staticAccessToken: config.staticAccessToken,
    staticAccountId: config.staticAccountId,
    fetchImpl,
    logger
  });
  const upstream = new CodexUpstream({ config, auth, guard, fetchImpl, logger });
  const models = new ModelCatalog({
    upstream,
    cacheFile: config.modelsCacheFile,
    configuredModels: config.configuredModels,
    variants: config.modelVariants,
    logger
  });
  const quota = new QuotaReporter({ enabled: config.quotaLog, usageFetch: config.quotaUsageFetch, intervalMs: config.quotaIntervalMs, upstream, logger });
  const limiter = new ConcurrencyLimiter({ max: config.maxConcurrentRequests, maxWaitMs: config.maxQueueWaitMs });
  const rate = new RateLimiter({
    perMinute: config.rateLimitPerMinute,
    minSpacingMs: config.minRequestSpacingMs,
    dailyLimit: config.dailyRequestLimit,
    warnPercent: config.dailyWarnPercent,
    store,
    now,
    logger
  });
  const server = createProxyServer({ config, upstream, models, quota, guard, limiter, rate, logger, now });
  Object.assign(server, { proxyState: { store, guard, limiter, rate } });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const logger = createLogger();
  try {
    const config = loadConfig();
    const server = buildServer(config, { logger });
    server.listen(config.port, config.host, () => {
      const { port } = server.address();
      logger.info(`listening on http://${config.host}:${port}`);
      logger.info("request bodies, headers and credentials are never logged", {
        effort: config.defaultReasoningEffort,
        tier: config.defaultServiceTier ?? "unset",
        refresh: config.refreshMode,
        quota_log: config.quotaLog ? "headers" : "off",
        usage_fetch: config.quotaUsageFetch ? "on" : "off",
        concurrency: config.maxConcurrentRequests,
        per_minute: config.rateLimitPerMinute,
        daily: config.dailyRequestLimit
      });
    });
  } catch (error) {
    logger.error(`startup failed: ${error.message}`);
    process.exitCode = 1;
  }
}

export const serverInternals = { authorized, readJson, rawPath, write, ROUTES };
