import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { CodexAuth } from "./auth.js";
import { loadConfig } from "./config.js";
import { HttpError, openAIError } from "./errors.js";
import { createLogger, silentLogger } from "./log.js";
import { ModelCatalog } from "./models.js";
import { QuotaReporter } from "./quota.js";
import { encodeSse, jsonFromSse, parseSse } from "./sse.js";
import { ChatCompletionState, toResponsesRequest } from "./translate.js";
import { CodexUpstream, baseHeaders } from "./upstream.js";

// The only paths served. Everything else gets a bodiless-to-the-log 404 before
// authentication, the request body is never read, and only a count is logged.
const ROUTES = new Set(["/healthz", "/v1/models", "/v1/chat/completions"]);
const UNMATCHED_SUMMARY_MS = 60_000;

function digest(value) {
  return createHash("sha256").update(value).digest();
}

// Hashing both sides gives equal-length buffers, so timingSafeEqual neither
// throws nor leaks the key length.
export function authorized(header, expected) {
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  return timingSafeEqual(digest(header.slice(7)), digest(expected));
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

async function write(response, text) {
  if (response.destroyed || response.writableEnded) return;
  if (!response.write(text)) {
    await new Promise((resolve) => {
      const done = () => {
        response.off("drain", done);
        response.off("close", done);
        resolve();
      };
      response.once("drain", done);
      response.once("close", done);
    });
  }
}

function streamError(error) {
  return encodeSse(openAIError(error).body);
}

export function createProxyServer({ config, upstream, models, quota, logger = silentLogger, now = Date.now }) {
  let activeRequests = 0;
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

  const server = createServer(async (request, response) => {
    const started = now();
    let pathname;
    try {
      pathname = new URL(request.url || "/", "http://proxy.invalid").pathname;
    } catch {
      pathname = "";
    }

    if (!ROUTES.has(pathname)) {
      countUnmatched();
      response.setHeader("connection", "close");
      return sendJson(response, 404, openAIError(new HttpError(404, "Not found.", "not_found")).body);
    }

    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), config.requestTimeoutMs);
    // Client went away (Cursor cancelled): stop the upstream request too, so no
    // quota is spent on output nobody reads.
    response.once("close", () => {
      if (!response.writableFinished) abortController.abort();
    });
    const fields = { method: request.method, route: pathname };

    try {
      if (pathname === "/healthz") {
        if (request.method !== "GET" && request.method !== "HEAD") throw new HttpError(405, "Method not allowed.", "method_not_allowed");
        return sendJson(response, 200, { status: "ok" });
      }

      if (!authorized(request.headers.authorization, config.apiKey)) {
        throw new HttpError(401, "Invalid or missing proxy API key.", "invalid_api_key", "authentication_error");
      }

      if (pathname === "/v1/models") {
        if (request.method !== "GET") throw new HttpError(405, "Method not allowed.", "method_not_allowed");
        const { source, body } = await models.list(abortController.signal);
        fields.models_source = source;
        return sendJson(response, 200, body, { "x-codex-proxy-models-source": source });
      }

      // /v1/chat/completions
      if (request.method !== "POST") throw new HttpError(405, "Method not allowed.", "method_not_allowed");
      if (config.maxConcurrentRequests > 0 && activeRequests >= config.maxConcurrentRequests) {
        throw new HttpError(429, "The proxy concurrency limit has been reached.", "rate_limit_exceeded", "rate_limit_error");
      }
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
        dropped_unknown: meta.droppedUnknown || undefined
      });

      activeRequests += 1;
      try {
        const upstreamResponse = await upstream.createResponse(upstreamRequest, abortController.signal);
        quota?.observe(upstreamResponse.headers);
        const state = new ChatCompletionState(body.model);

        if (!meta.stream) {
          for await (const sse of parseSse(upstreamResponse.body)) {
            const event = jsonFromSse(sse);
            if (event) state.consume(event);
          }
          state.finish();
          if (state.usage) Object.assign(fields, { in: state.usage.prompt_tokens, out: state.usage.completion_tokens });
          return sendJson(response, 200, state.completion());
        }

        response.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-store",
          connection: "keep-alive",
          "x-accel-buffering": "no",
          "x-content-type-options": "nosniff"
        });
        const keepAlive = config.keepAliveMs > 0
          ? setInterval(() => { if (!response.writableEnded) response.write(": keep-alive\n\n"); }, config.keepAliveMs)
          : null;
        try {
          for await (const sse of parseSse(upstreamResponse.body)) {
            const event = jsonFromSse(sse);
            if (!event) continue;
            for (const chunk of state.consume(event)) await write(response, encodeSse(chunk));
          }
          state.finish();
          await write(response, encodeSse("[DONE]"));
          if (state.usage) Object.assign(fields, { in: state.usage.prompt_tokens, out: state.usage.completion_tokens });
          response.end();
        } finally {
          if (keepAlive) clearInterval(keepAlive);
        }
      } finally {
        activeRequests -= 1;
      }
    } catch (error) {
      const normalized = error?.name === "AbortError" || error?.name === "TimeoutError"
        ? new HttpError(504, "The request timed out or was cancelled.", "request_timeout", "timeout_error")
        : error;
      const { status } = openAIError(normalized);
      fields.status = status;
      fields.code = normalized?.code;
      if (response.headersSent) {
        // Mid-stream failure: send an OpenAI-style error event and end WITHOUT
        // [DONE], so the client sees a failure rather than a short, "complete" answer.
        if (!response.writableEnded && !response.destroyed) {
          response.write(streamError(normalized));
          response.end();
        }
      } else if (!response.destroyed) {
        sendJson(response, status, openAIError(normalized).body);
      }
      if (!(normalized instanceof HttpError)) {
        // Unexpected bug: log its class only. error.message could quote request content.
        fields.error = normalized?.name ?? "Error";
      }
    } finally {
      clearTimeout(timeout);
      fields.status ??= response.statusCode;
      fields.ms = now() - started;
      // Fixed fields only: never headers, bodies, prompts, or tokens.
      logger.info("request", fields);
    }
  });
  server.headersTimeout = 30_000;
  return server;
}

export function buildServer(config = loadConfig(), { fetchImpl = globalThis.fetch, logger = createLogger() } = {}) {
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
  const upstream = new CodexUpstream({ config, auth, fetchImpl, logger });
  const models = new ModelCatalog({
    upstream,
    cacheFile: config.modelsCacheFile,
    configuredModels: config.configuredModels,
    variants: config.modelVariants,
    logger
  });
  const quota = new QuotaReporter({ enabled: config.quotaLog, intervalMs: config.quotaIntervalMs, upstream, logger });
  return createProxyServer({ config, upstream, models, quota, logger });
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
        quota_log: config.quotaLog ? "on" : "off"
      });
    });
  } catch (error) {
    logger.error(`startup failed: ${error.message}`);
    process.exitCode = 1;
  }
}

export const serverInternals = { authorized, readJson, ROUTES };
