import { MIN_QUOTA_INTERVAL_MS } from "./config.js";
import { silentLogger } from "./log.js";

// Quota line (5h and weekly windows). ON by default (QUOTA_LOG=0 turns it off)
// because its normal source costs nothing: the x-codex-*-used-percent headers
// that arrive on every response. It logs at most once per intervalMs (>= 60 s).
// The wham/usage lookup is a separate upstream request, so it only runs when
// QUOTA_USAGE_FETCH=1 and the headers are absent; the attempt timestamp is set
// before any network call, so a burst of requests triggers at most one lookup.

function windowLabel(minutes) {
  if (!Number.isFinite(minutes)) return "window";
  if (minutes === 300) return "5h";
  if (minutes === 10080) return "weekly";
  return minutes % 1440 === 0 ? `${minutes / 1440}d` : minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`;
}

function num(value) {
  if (value === null || value === undefined || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function quotaFromHeaders(headers) {
  const get = (name) => (typeof headers?.get === "function" ? headers.get(name) : headers?.[name]);
  const windows = [];
  for (const slot of ["primary", "secondary"]) {
    const used = num(get(`x-codex-${slot}-used-percent`));
    if (used === undefined) continue;
    windows.push({ used, minutes: num(get(`x-codex-${slot}-window-minutes`)), resetAt: num(get(`x-codex-${slot}-reset-at`)) });
  }
  return windows.length ? windows : null;
}

export function quotaFromUsage(payload) {
  const limits = payload?.rate_limit;
  if (!limits || typeof limits !== "object") return null;
  const windows = [];
  for (const raw of [limits.primary_window ?? limits.primary, limits.secondary_window ?? limits.secondary]) {
    const used = num(raw?.used_percent);
    if (used === undefined) continue;
    const seconds = num(raw?.limit_window_seconds);
    windows.push({ used, minutes: seconds === undefined ? undefined : Math.round(seconds / 60), resetAt: num(raw?.reset_at ?? raw?.resets_at) });
  }
  return windows.length ? windows : null;
}

export function formatQuota(windows) {
  return windows
    .map((w) => {
      const reset = Number.isFinite(w.resetAt) ? ` resets ${new Date(w.resetAt * 1000).toISOString().slice(0, 16)}Z` : "";
      return `${windowLabel(w.minutes)} ${Math.round(w.used)}% used${reset}`;
    })
    .join(" · ");
}

export class QuotaReporter {
  constructor({ enabled = false, usageFetch = false, intervalMs = 300_000, upstream, logger = silentLogger, now = Date.now }) {
    this.enabled = enabled;
    this.usageFetch = usageFetch;
    this.intervalMs = Math.max(MIN_QUOTA_INTERVAL_MS, intervalMs);
    this.upstream = upstream;
    this.logger = logger;
    this.now = now;
    this.lastAttempt = -Infinity;
    this.fetches = 0;
  }

  // Returns a promise only so tests can await the background lookup.
  observe(headers) {
    if (!this.enabled) return undefined;
    const now = this.now();
    if (now - this.lastAttempt < this.intervalMs) return undefined;
    this.lastAttempt = now;
    const fromHeaders = quotaFromHeaders(headers);
    if (fromHeaders) {
      this.logger.info(`quota ${formatQuota(fromHeaders)}`);
      return undefined;
    }
    if (!this.usageFetch) return undefined;
    this.fetches += 1;
    return this.upstream.usage()
      .then((payload) => {
        const windows = quotaFromUsage(payload);
        if (windows) this.logger.info(`quota ${formatQuota(windows)}`);
      })
      .catch((error) => this.logger.warn("quota lookup failed", { code: error?.code ?? error?.name }));
  }
}
