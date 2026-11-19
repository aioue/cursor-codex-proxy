import { UpstreamError } from "./errors.js";
import { sanitize, silentLogger } from "./log.js";

const MODELS_TIMEOUT_MS = 5_000;
const USAGE_TIMEOUT_MS = 5_000;

async function safeErrorMessage(response) {
  const text = await response.text().catch(() => "");
  const fallback = `Codex upstream returned HTTP ${response.status}`;
  if (!text) return fallback;
  try {
    const json = JSON.parse(text);
    const message = json?.error?.message || json?.detail?.message || json?.detail || json?.message;
    return sanitize(typeof message === "string" ? message : fallback, 500);
  } catch {
    return sanitize(text, 300);
  }
}

// The fixed header set sent on EVERY upstream call (responses, models, usage, and
// the token refresh via baseHeaders()). One originator, one user-agent, no
// per-process random ids. See AUDIT.md "Fingerprint" for what the real CLI sends
// that this proxy deliberately does not (installation id, attestation, turn state).
export function baseHeaders(config) {
  return { originator: config.originator, "user-agent": config.userAgent };
}

export class CodexUpstream {
  constructor({ config, auth, fetchImpl = globalThis.fetch, logger = silentLogger }) {
    this.config = config;
    this.auth = auth;
    this.fetch = fetchImpl;
    this.logger = logger;
  }

  #url(path) {
    return `${this.config.upstreamBaseUrl}/${path.replace(/^\/+/, "")}`;
  }

  async #send(url, options, credentials) {
    const headers = new Headers(options.headers);
    for (const [name, value] of Object.entries(baseHeaders(this.config))) headers.set(name, value);
    headers.set("authorization", `Bearer ${credentials.accessToken}`);
    headers.set("chatgpt-account-id", credentials.accountId);
    try {
      return await this.fetch(url, { ...options, headers });
    } catch (error) {
      if (error?.name === "AbortError" || error?.name === "TimeoutError") throw error;
      throw new UpstreamError(502, "Could not connect to the Codex upstream service.", "upstream_unavailable");
    }
  }

  async #request(url, options) {
    let credentials = await this.auth.getCredentials();
    let response = await this.#send(url, options, credentials);
    if (response.status === 401) {
      await response.body?.cancel().catch(() => {});
      // Re-read auth.json (and refresh only if expired); never force-rotate a live token.
      credentials = await this.auth.onUnauthorized(credentials.accessToken);
      response = await this.#send(url, options, credentials);
      if (response.status === 401) {
        await response.body?.cancel().catch(() => {});
        throw new UpstreamError(401, "ChatGPT rejected the Codex credentials. Run `codex login`, then retry.", "codex_auth_rejected");
      }
    }
    if (!response.ok) {
      const message = await safeErrorMessage(response);
      throw new UpstreamError(response.status, message, response.status === 429 ? "rate_limit_exceeded" : "upstream_rejected_request");
    }
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
    });
  }
}
