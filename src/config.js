import { spawnSync } from "node:child_process";
import { arch, homedir, release, type as osType } from "node:os";
import { join, resolve } from "node:path";

export const PROXY_VERSION = "0.2.0";
const DEFAULT_UPSTREAM = "https://chatgpt.com/backend-api/codex";
const DEFAULT_TOKEN_URL = "https://auth.openai.com/oauth/token";
// Used only when `codex --version` is unavailable and CODEX_CLIENT_VERSION is unset.
// The models endpoint filters its catalog by client_version, so a very old value
// shrinks the list. 0.170.0 was the latest openai/codex release on 2026-11-18.
const FALLBACK_CLIENT_VERSION = "0.170.0";
export const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh"];
export const SERVICE_TIERS = ["priority"];
// The real CLI starts a proactive refresh 5 minutes before expiry
// (CHATGPT_ACCESS_TOKEN_REFRESH_WINDOW_MINUTES in codex-rs/login/src/auth/manager.rs).
// The proxy waits until 30 s before expiry, so a running CLI normally refreshes first
// and the proxy simply re-reads the file instead of spending the refresh token itself.
const DEFAULT_REFRESH_SKEW_MS = 30_000;
const MIN_QUOTA_INTERVAL_MS = 60_000;

function positiveInt(value, fallback, name) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function nonNegativeInt(value, fallback, name) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer`);
  return parsed;
}

function list(value) {
  return (value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
}

export function isLoopbackHost(host) {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

// Remote URLs must be https. Plain http is accepted only for loopback, which is
// what the mocked upstream in the tests and smoke script uses. This stops a stray
// env var from sending the refresh token to an arbitrary host in clear text.
function safeUrl(value, fallback, name) {
  const raw = (value || fallback).replace(/\/+$/, "");
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} is not a valid URL`);
  }
  const loopback = isLoopbackHost(url.hostname) || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error(`${name} must use https (http is allowed only for loopback test servers)`);
  }
  return raw;
}

function detectCodexVersion(env) {
  if (env.CODEX_CLIENT_VERSION?.trim()) return env.CODEX_CLIENT_VERSION.trim();
  // Runs the `codex` found on PATH once at startup, as devteapot did. Set
  // CODEX_CLIENT_VERSION to skip it.
  const result = spawnSync("codex", ["--version"], {
    encoding: "utf8",
    timeout: 2_000,
    stdio: ["ignore", "pipe", "ignore"]
  });
  return result.stdout?.match(/(\d+\.\d+\.\d+)/)?.[1] ?? FALLBACK_CLIENT_VERSION;
}

// One user-agent for every upstream call (responses, models, usage).
// It follows the CLI's "<originator>/<version> (<os> <release>; <arch>) <terminal>"
// layout (get_codex_user_agent in codex-rs/login/src/auth/default_client.rs) so it
// parses the same way, but the terminal slot names this proxy instead of
// pretending to be a terminal. Override with CODEX_USER_AGENT.
export function defaultUserAgent(originator, clientVersion) {
  const os = osType() === "Darwin" ? "Mac OS" : osType();
  return `${originator}/${clientVersion} (${os} ${release()}; ${arch()}) cursor-codex-proxy/${PROXY_VERSION}`;
}

export function loadConfig(env = process.env) {
  const apiKey = env.PROXY_API_KEY?.trim();
  if (!apiKey || apiKey.length < 24 || apiKey === "replace-with-a-long-random-secret") {
    throw new Error("PROXY_API_KEY is required and must contain at least 24 characters. Run `npm run init`.");
  }

  const host = env.HOST?.trim() || "127.0.0.1";
  if (!isLoopbackHost(host)) {
    throw new Error(`HOST must be a loopback address (127.0.0.1, ::1 or localhost); got ${host}. Use the tunnel for remote access.`);
  }

  const codexHome = env.CODEX_HOME ? resolve(env.CODEX_HOME) : join(homedir(), ".codex");
  const effort = env.DEFAULT_REASONING_EFFORT?.trim() || "medium";
  if (!REASONING_EFFORTS.includes(effort)) throw new Error(`DEFAULT_REASONING_EFFORT must be one of ${REASONING_EFFORTS.join(", ")}`);
  const tier = env.DEFAULT_SERVICE_TIER?.trim() || undefined;
  if (tier && !SERVICE_TIERS.includes(tier)) throw new Error(`DEFAULT_SERVICE_TIER must be empty or one of ${SERVICE_TIERS.join(", ")}`);
  const refreshMode = env.CODEX_PROXY_REFRESH?.trim() || "expired";
  if (!["expired", "never"].includes(refreshMode)) throw new Error("CODEX_PROXY_REFRESH must be expired or never");

  const originator = env.CODEX_ORIGINATOR?.trim() || "codex_cli_rs";
  const clientVersion = detectCodexVersion(env);
  const variants = env.CODEX_PROXY_MODEL_VARIANTS === undefined ? ["low", "high", "xhigh"] : list(env.CODEX_PROXY_MODEL_VARIANTS);

  return {
    host,
    port: nonNegativeInt(env.PORT, 8787, "PORT"),
    apiKey,
    codexHome,
    authFile: env.CODEX_AUTH_FILE ? resolve(env.CODEX_AUTH_FILE) : join(codexHome, "auth.json"),
    modelsCacheFile: env.CODEX_MODELS_CACHE_FILE ? resolve(env.CODEX_MODELS_CACHE_FILE) : join(codexHome, "models_cache.json"),
    upstreamBaseUrl: safeUrl(env.CODEX_UPSTREAM_BASE_URL, DEFAULT_UPSTREAM, "CODEX_UPSTREAM_BASE_URL"),
    // Same override variable name the Codex CLI itself honours.
    tokenUrl: safeUrl(env.CODEX_REFRESH_TOKEN_URL_OVERRIDE, DEFAULT_TOKEN_URL, "CODEX_REFRESH_TOKEN_URL_OVERRIDE"),
    clientVersion,
    originator,
    userAgent: env.CODEX_USER_AGENT?.trim() || defaultUserAgent(originator, clientVersion),
    configuredModels: list(env.CODEX_PROXY_MODELS),
    modelVariants: variants.filter((v) => REASONING_EFFORTS.includes(v) || v === "fast"),
    defaultReasoningEffort: effort,
    defaultServiceTier: tier,
    refreshMode,
    refreshSkewMs: nonNegativeInt(env.REFRESH_SKEW_MS, DEFAULT_REFRESH_SKEW_MS, "REFRESH_SKEW_MS"),
    staticAccessToken: env.CODEX_ACCESS_TOKEN?.trim() || undefined,
    staticAccountId: env.CODEX_ACCOUNT_ID?.trim() || undefined,
    quotaLog: env.QUOTA_LOG === "1" || env.QUOTA_LOG === "true",
    quotaIntervalMs: Math.max(MIN_QUOTA_INTERVAL_MS, positiveInt(env.QUOTA_LOG_INTERVAL_MS, 300_000, "QUOTA_LOG_INTERVAL_MS")),
    maxConcurrentRequests: nonNegativeInt(env.MAX_CONCURRENT_REQUESTS, 0, "MAX_CONCURRENT_REQUESTS"),
    maxRequestBytes: positiveInt(env.MAX_REQUEST_BYTES, 20 * 1024 * 1024, "MAX_REQUEST_BYTES"),
    requestTimeoutMs: positiveInt(env.REQUEST_TIMEOUT_MS, 15 * 60 * 1000, "REQUEST_TIMEOUT_MS"),
    // SSE comment every 15 s while the model is thinking, so tunnels and
    // clients with idle timeouts (Cloudflare: 100 s) do not drop the stream.
    keepAliveMs: nonNegativeInt(env.SSE_KEEPALIVE_MS, 15_000, "SSE_KEEPALIVE_MS")
  };
}

export { MIN_QUOTA_INTERVAL_MS };
