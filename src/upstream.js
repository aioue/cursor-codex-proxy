import { SERVICE_TIERS } from "./config.js";
import { HttpError, UpstreamError } from "./errors.js";
import { UpstreamGuard } from "./guard.js";
import { sanitize, silentLogger } from "./log.js";
import { MODEL_ID_RE } from "./translate.js";

const MODELS_TIMEOUT_MS = 5_000;
const USAGE_TIMEOUT_MS = 5_000;

const CODE_RE = /^[a-z0-9_.-]{1,64}$/i;

// Message, machine code and reset hints from an upstream error body. Shapes
// seen across the backend: {error:{type|code, message, resets_at}},
// {detail:{code, message}}, {detail:"text"}, {code, message}.
async function upstreamErrorInfo(response) {
  const text = await response.text().catch(() => "");
  const fallback = `Codex upstream returned HTTP ${response.status}`;
  if (!text) return { message: fallback };
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return { message: sanitize(text, 300) };
  }
  const error = json?.error && typeof json.error === "object" ? json.error : undefined;
  const detail = json?.detail && typeof json.detail === "object" ? json.detail : undefined;
  const message = error?.message || detail?.message || (typeof json?.detail === "string" ? json.detail : undefined) || json?.message;
  const code = [error?.code, error?.type, detail?.code, json?.code, typeof json?.error === "string" ? json.error : undefined]
    .find((value) => typeof value === "string" && CODE_RE.test(value));
  const resetsAt = Number(error?.resets_at ?? detail?.resets_at);
  const resetsInSeconds = Number(error?.resets_in_seconds ?? detail?.resets_in_seconds);
  return {
    message: sanitize(typeof message === "string" ? message : fallback, 500),
    code,
    ...(Number.isFinite(resetsAt) ? { resetsAt } : {}),
    ...(Number.isFinite(resetsInSeconds) ? { resetsInSeconds } : {})
  };
}

// The fixed header set sent on EVERY upstream call (responses, models, usage, and
// the token refresh via baseHeaders()). One originator, one user-agent, no
// per-process random ids. See AUDIT.md "Fingerprint" for what the real CLI sends
// that this proxy deliberately does not (installation id, attestation, turn state).
export function baseHeaders(config) {
  return { originator: config.originator, "user-agent": config.userAgent };
}

export class CodexUpstream {
  constructor({ config, auth, guard = new UpstreamGuard(), fetchImpl = globalThis.fetch, logger = silentLogger }) {
    this.config = config;
    this.auth = auth;
    this.guard = guard;
    this.fetch = fetchImpl;
    this.logger = logger;
  }

  #url(path) {
    return `${this.config.upstreamBaseUrl}/${path.replace(/^\/+/, "")}`;
  }

  async #send(url, options, credentials) {
    let headers;
    try {
      headers = new Headers(options.headers);
      for (const [name, value] of Object.entries(baseHeaders(this.config))) headers.set(name, value);
      headers.set("authorization", `Bearer ${credentials.accessToken}`);
      headers.set("chatgpt-account-id", credentials.accountId);
    } catch {
      // Header values are validated before this point; this is the backstop so a
      // bad value is a 400, not a misleading 500. The value is never echoed.
      throw new HttpError(400, "A request value cannot be sent as an HTTP header.", "invalid_header_value");
    }
    try {
      return await this.fetch(url, { ...options, headers });
    } catch (error) {
      if (error?.name === "AbortError" || error?.name === "TimeoutError") throw error;
      throw new UpstreamError(502, "Could not connect to the Codex upstream service.", "upstream_unavailable");
    }
  }

  // One upstream attempt, guarded. There are NO automatic retries for 429 or
  // 5xx: the error goes back to Cursor (with Retry-After) and the guard holds
  // further requests locally. The only replay is after a 401, and only when
  // auth.json now holds a different token (the CLI refreshed meanwhile).
  // `streaming`: success is reported by the caller when the stream completes,
  // so an error inside a 200 stream still counts towards the breaker.
  async #request(url, options, { streaming = false } = {}) {
    this.guard.check();
    let credentials = await this.auth.getCredentials();
    let response = await this.#send(url, options, credentials);
    if (response.status === 401) {
      await response.body?.cancel().catch(() => {});
      this.guard.onUnauthorized();
      // Re-read auth.json; never refresh or force-rotate a live token.
      credentials = await this.auth.onUnauthorized(credentials.accessToken);
      this.guard.check();
      response = await this.#send(url, options, credentials);
      if (response.status === 401) {
        await response.body?.cancel().catch(() => {});
        this.guard.onUnauthorized();
        throw new UpstreamError(401, "ChatGPT rejected the Codex credentials. Run `codex login`, then retry.", "codex_auth_rejected");
      }
    }
    if (!response.ok) {
      const info = await upstreamErrorInfo(response);
      this.guard.observeError(response.status, info.code, { headers: response.headers, resetsAt: info.resetsAt, resetsInSeconds: info.resetsInSeconds });
      const error = new UpstreamError(response.status, info.message, info.code ?? (response.status === 429 ? "rate_limit_exceeded" : "upstream_rejected_request"));
      error.retryAfter = this.guard.retryAfterFor();
      throw error;
    }
    this.guard.onAuthOk();
    if (!streaming) this.guard.onSuccess();
    return response;
  }

  async listModels(signal) {
    const query = new URLSearchParams({ client_version: this.config.clientVersion });
    const response = await this.#request(this.#url(`models?${query}`), {
      method: "GET",
      headers: { accept: "application/json" },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(MODELS_TIMEOUT_MS)]) : AbortSignal.timeout(MODELS_TIMEOUT_MS)
    });
    return response.json();
  }

  // Quota windows. Same endpoint the CLI's status view uses (backend-api/wham/usage),
  // derived from the configured base URL so tests hit the mock.
  async usage() {
    const base = this.config.upstreamBaseUrl.replace(/\/codex$/, "");
    const response = await this.#request(`${base}/wham/usage`, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(USAGE_TIMEOUT_MS)
    });
    return response.json();
  }

  async createResponse(request, signal) {
    // Defence in depth: translate.js already validated both. Nothing from the
    // client reaches the routing hint unless it matches the model-id pattern.
    if (!MODEL_ID_RE.test(request.model)) throw new HttpError(400, "The model id contains unsupported characters.", "model_not_found");
    if (request.service_tier !== undefined && !SERVICE_TIERS.includes(request.service_tier)) {
      throw new HttpError(400, "Unsupported service tier.", "invalid_service_tier");
    }
    const headers = {
      accept: "text/event-stream",
      "content-type": "application/json",
      // Same format as the CLI's build_routing_hint_header (codex-rs/core/src/client.rs).
      "x-codex-routing-hint": request.service_tier ? `model=${request.model};tier=${request.service_tier}` : `model=${request.model}`
    };
    // The CLI derives cache affinity from the session_id header; keep it equal to
    // the body's prompt_cache_key (Cursor's stable conversation id) so turns of one
    // conversation share the cache. No key, no header: no invented per-process id.
    if (request.prompt_cache_key) headers.session_id = request.prompt_cache_key;
    return this.#request(this.#url("responses"), {
      method: "POST",
      headers,
      body: JSON.stringify(request),
      signal
    }, { streaming: true });
  }
}
