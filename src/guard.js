import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { HttpError } from "./errors.js";
import { atomicWriteJson } from "./fsutil.js";
import { silentLogger } from "./log.js";

// Local protections that sit in front of every upstream call. None of them
// sends anything upstream; they make the proxy behave like one careful user
// instead of a retry loop. See README "Kill switch, breaker and limits".

// Error codes after which the account itself may be at risk. The proxy stops
// sending until a person looks (npm run reset).
export const KILL_CODES = new Set([
  "cyber_policy",
  "bio_policy",
  "misalignment_policy_violation",
  "access_program_not_enabled",
  "codex_workspace_access_denied",
  "invalid_workspace_selected",
  "runtime_instance_revoked",
  "runtime_instance_paused"
]);
export const QUOTA_CODES = new Set(["usage_limit_reached", "insufficient_quota"]);
export const TRANSIENT_CODES = new Set(["rate_limit_exceeded", "slow_down", "server_is_overloaded"]);
const CONSECUTIVE_401_TRIP = 2;
const QUOTA_FALLBACK_MS = 15 * 60 * 1000; // usage limit without any reset time
const MAX_COOLDOWN_MS = 8 * 24 * 60 * 60 * 1000; // a weekly window plus slack
const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;

function retryAfterSeconds(ms) {
  return Math.max(1, Math.ceil(ms / 1000));
}

function localError(status, message, code, retryAfterMs, type = "rate_limit_error") {
  const error = new HttpError(status, message, code, type);
  if (retryAfterMs !== undefined) error.retryAfter = retryAfterSeconds(retryAfterMs);
  error.local = true;
  return error;
}

// Retry-After: delta-seconds or an HTTP date.
export function parseRetryAfter(value, now) {
  if (value === null || value === undefined || value === "") return undefined;
  const text = String(value).trim();
  if (/^\d+$/.test(text)) return Math.min(Number(text) * 1000, MAX_RETRY_AFTER_MS);
  const at = Date.parse(text);
  if (Number.isFinite(at)) return Math.min(Math.max(0, at - now), MAX_RETRY_AFTER_MS);
  return undefined;
}

// ---------- persistent state ----------

// ~/.cursor-codex-proxy/state.json (mode 0600, written atomically). Holds the
// kill switch, a quota cooldown and the daily request counter, so a restart
// does not clear any of them. With file undefined (unit tests) it lives in
// memory only.
export class StateStore {
  #chain = Promise.resolve();

  constructor({ file, logger = silentLogger } = {}) {
    this.file = file;
    this.logger = logger;
    this.data = this.#read() ?? {};
  }

  #read() {
    if (!this.file) return undefined;
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8"));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch (error) {
      if (error?.code === "ENOENT") return {};
      // A corrupt state file must not silently clear a tripped kill switch.
      this.logger.error("state file unreadable; treating the kill switch as tripped", { code: error?.code ?? error?.name });
      return { killSwitch: { code: "state_file_unreadable", reason: "state file could not be parsed", at: new Date().toISOString() } };
    }
  }

  // Re-read from disk (used while tripped, so a reset needs no restart).
  reload() {
    if (!this.file) return;
    this.data = this.#read() ?? {};
  }

  save() {
    if (!this.file) return this.#chain;
    const snapshot = structuredClone({ version: 1, ...this.data });
    this.#chain = this.#chain.then(async () => {
      try {
        mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
        await atomicWriteJson(this.file, snapshot);
      } catch (error) {
        this.logger.error("could not write the state file", { code: error?.code ?? error?.name });
      }
    });
    return this.#chain;
  }

  flush() {
    return this.#chain;
  }
}

// ---------- kill switch + circuit breaker ----------

// check() runs before anything is sent upstream (and before the request body is
// read). It throws a local 503 while the kill switch is tripped, and a local
// 429 with Retry-After while a quota or backoff cooldown is active.
//
// Transient errors (429 other than quota, slow_down, server_is_overloaded,
// HTTP 503): the n-th consecutive one sets a cooldown of Retry-After when the
// upstream sent one, else full-jitter exponential backoff,
// random() * min(maxBackoffMs, baseBackoffMs * 2^(n-1)). From the openAfter-th
// in a row the breaker is open: the cooldown is at least maxBackoffMs. A
// completed response resets the count. Nothing is retried automatically;
// Cursor gets the error (or the local 429) and decides.
//
// Quota errors (usage_limit_reached, insufficient_quota): cooldown until the
// reset time from the error (resets_at / resets_in_seconds) or the
// x-codex-primary-reset-at header, else 15 minutes. Persisted.
export class UpstreamGuard {
  constructor({
    store = new StateStore(),
    logger = silentLogger,
    now = Date.now,
    random = Math.random,
    openAfter = 3,
    baseBackoffMs = 1_000,
    maxBackoffMs = 60_000
  } = {}) {
    this.store = store;
    this.logger = logger;
    this.now = now;
    this.random = random;
    this.openAfter = openAfter;
    this.baseBackoffMs = baseBackoffMs;
    this.maxBackoffMs = maxBackoffMs;
    this.transientCount = 0;
    this.cooldownUntil = 0;
    this.consecutive401 = 0;
    const tripped = this.store.data.killSwitch;
    if (tripped) this.logger.error(`KILL SWITCH IS TRIPPED (${tripped.code}): every request is refused until you check the account and run npm run reset`, {});
  }

  get tripped() {
    return this.store.data.killSwitch;
  }

  get open() {
    return this.transientCount >= this.openAfter && this.now() < this.cooldownUntil;
  }

  check() {
    this.checkKill();
    this.checkCooldown();
  }

  checkKill() {
    if (this.tripped) {
      this.store.reload();
      if (!this.tripped) {
        this.logger.warn("kill switch cleared on disk; accepting requests again");
        this.consecutive401 = 0;
      }
    }
    const kill = this.tripped;
    if (kill) {
      throw localError(503, `The proxy kill switch is tripped (${kill.code}). Stop using it, check the ChatGPT account and any email from OpenAI, then run \`npm run reset\` on the proxy machine.`, "proxy_kill_switch", undefined, "proxy_error");
    }
  }

  checkCooldown() {
    const now = this.now();
    const quotaUntil = Number(this.store.data.quotaUntil) || 0;
    if (now < quotaUntil) {
      throw localError(429, "The Codex usage limit was reached; the proxy is not sending requests until it resets.", "usage_limit_reached", quotaUntil - now);
    }
    if (now < this.cooldownUntil) {
      const open = this.transientCount >= this.openAfter;
      throw localError(429, open
        ? "The Codex upstream is rate limiting or overloaded; the proxy circuit breaker is open."
        : "The Codex upstream asked the proxy to slow down; retry later.", open ? "proxy_circuit_open" : "proxy_backoff", this.cooldownUntil - now);
    }
  }

  // HTTP 2xx: the credentials work.
  onAuthOk() {
    this.consecutive401 = 0;
  }

  // A response completed (or a JSON call succeeded).
  onSuccess() {
    this.consecutive401 = 0;
    if (this.transientCount) this.logger.info("upstream recovered", { after_errors: this.transientCount });
    this.transientCount = 0;
  }

  // Each 401 was sent with a token just read from auth.json, so two in a row
  // mean the login itself is rejected, not a stale copy in memory.
  onUnauthorized() {
    this.consecutive401 += 1;
    if (this.consecutive401 >= CONSECUTIVE_401_TRIP) {
      this.trip("consecutive_401", "two consecutive 401s with a token freshly read from auth.json");
    }
  }

  trip(code, reason) {
    if (this.tripped) return;
    this.store.data.killSwitch = { code, reason, at: new Date(this.now()).toISOString() };
    this.store.save();
    this.logger.error(`KILL SWITCH TRIPPED (${code}): ${reason}. Stop using the proxy, check the ChatGPT account and email, then run npm run reset`, {});
  }

  // Classifies an upstream error by status, code and headers.
  // info: { resetsAt (epoch s), resetsInSeconds, headers }
  observeError(status, code, info = {}) {
    const now = this.now();
    if (code && KILL_CODES.has(code)) {
      this.trip(code, `upstream returned ${code}`);
      return "kill";
    }
    if (code && QUOTA_CODES.has(code)) {
      const header = (name) => (typeof info.headers?.get === "function" ? info.headers.get(name) : undefined);
      let until;
      if (Number.isFinite(info.resetsAt)) until = info.resetsAt * 1000;
      else if (Number.isFinite(info.resetsInSeconds)) until = now + info.resetsInSeconds * 1000;
      else if (Number.isFinite(Number(header("x-codex-primary-reset-at"))) && header("x-codex-primary-reset-at")) until = Number(header("x-codex-primary-reset-at")) * 1000;
      if (!Number.isFinite(until) || until <= now) until = now + QUOTA_FALLBACK_MS;
      until = Math.min(until, now + MAX_COOLDOWN_MS);
      this.store.data.quotaUntil = until;
      this.store.save();
      this.logger.warn("usage limit reached; not sending until reset", { resets_in_s: Math.round((until - now) / 1000) });
      return "quota";
    }
    const transient = (code && TRANSIENT_CODES.has(code)) || status === 429 || status === 503;
    if (!transient) return null;
    this.transientCount += 1;
    const retryAfter = parseRetryAfter(typeof info.headers?.get === "function" ? info.headers.get("retry-after") : undefined, now);
    const ceiling = Math.min(this.maxBackoffMs, this.baseBackoffMs * 2 ** (this.transientCount - 1));
    let delay = retryAfter ?? this.random() * ceiling;
    if (this.transientCount >= this.openAfter) {
      delay = Math.max(delay, retryAfter ?? this.maxBackoffMs);
      this.logger.warn("circuit breaker open", { errors: this.transientCount, cooldown_s: Math.round(delay / 1000) });
    }
    this.cooldownUntil = Math.max(this.cooldownUntil, now + delay);
    return "transient";
  }

  // Retry-After to attach to a passed-through upstream error, if any.
  retryAfterFor() {
    const now = this.now();
    const until = Math.max(Number(this.store.data.quotaUntil) || 0, this.cooldownUntil);
    return until > now ? retryAfterSeconds(until - now) : undefined;
  }
}

// ---------- concurrency cap with a FIFO queue ----------

// At most `max` requests in flight upstream; the rest wait in arrival order for
// up to maxWaitMs, then get a local 429. max 0 disables the cap.
export class ConcurrencyLimiter {
  constructor({ max = 2, maxWaitMs = 60_000 } = {}) {
    this.max = max;
    this.maxWaitMs = maxWaitMs;
    this.active = 0;
    this.queue = [];
  }

  acquire(signal) {
    if (this.max <= 0) return Promise.resolve(() => {});
    if (this.active < this.max && this.queue.length === 0) {
      this.active += 1;
      return Promise.resolve(this.#releaser());
    }
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject };
      const remove = () => {
        const at = this.queue.indexOf(waiter);
        if (at !== -1) this.queue.splice(at, 1);
        clearTimeout(waiter.timer);
        signal?.removeEventListener("abort", waiter.onAbort);
      };
      waiter.grant = () => {
        remove();
        resolve(this.#releaser());
      };
      waiter.timer = setTimeout(() => {
        remove();
        reject(localError(429, "The proxy is busy (concurrency limit); the request waited too long in the queue.", "proxy_queue_timeout", Math.min(this.maxWaitMs, 10_000)));
      }, this.maxWaitMs);
      waiter.onAbort = () => {
        remove();
        const error = new Error("aborted while queued");
        error.name = "AbortError";
        reject(error);
      };
      signal?.addEventListener("abort", waiter.onAbort, { once: true });
      this.queue.push(waiter);
    });
  }

  #releaser() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.queue[0];
      if (next) next.grant(); // the slot passes straight to the next in line
      else this.active -= 1;
    };
  }
}

// ---------- request rate: token bucket + spacing + daily ceiling ----------

function localDay(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function msUntilLocalMidnight(ms) {
  const d = new Date(ms);
  const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
  return next.getTime() - ms;
}

// perMinute tokens refill continuously (bucket size perMinute), and two
// requests are never sent less than minSpacingMs apart. reserve() returns how
// long the caller must wait, or throws a local 429 if that is longer than
// maxWaitMs. admit() then enforces the daily ceiling (local calendar day,
// persisted) and counts the request. 0 disables a limit.
export class RateLimiter {
  constructor({ perMinute = 30, minSpacingMs = 250, dailyLimit = 1500, warnPercent = 80, store = new StateStore(), now = Date.now, logger = silentLogger } = {}) {
    this.perMinute = perMinute;
    this.minSpacingMs = minSpacingMs;
    this.dailyLimit = dailyLimit;
    this.warnPercent = warnPercent;
    this.store = store;
    this.now = now;
    this.logger = logger;
    this.tokens = perMinute;
    this.refilledAt = now();
    this.nextSlot = 0;
  }

  reserve(maxWaitMs) {
    const now = this.now();
    let tokenWait = 0;
    if (this.perMinute > 0) {
      const rate = this.perMinute / 60_000;
      this.tokens = Math.min(this.perMinute, this.tokens + (now - this.refilledAt) * rate);
      this.refilledAt = now;
      if (this.tokens < 1) tokenWait = (1 - this.tokens) / rate;
    }
    const spacingWait = Math.max(0, this.nextSlot - now);
    const wait = Math.ceil(Math.max(tokenWait, spacingWait));
    if (wait > maxWaitMs) {
      throw localError(429, "The proxy request-rate limit was reached; retry shortly.", "proxy_rate_limited", wait);
    }
    if (this.perMinute > 0) this.tokens -= 1;
    this.nextSlot = now + wait + this.minSpacingMs;
    return wait;
  }

  #daily() {
    const today = localDay(this.now());
    if (this.store.data.daily?.day !== today) this.store.data.daily = { day: today, count: 0, warned: false };
    return this.store.data.daily;
  }

  admit() {
    if (this.dailyLimit <= 0) return;
    const daily = this.#daily();
    if (daily.count >= this.dailyLimit) {
      throw localError(429, `The proxy's daily request ceiling (${this.dailyLimit}) was reached; it resets at local midnight.`, "proxy_daily_limit", msUntilLocalMidnight(this.now()));
    }
    daily.count += 1;
    if (!daily.warned && daily.count >= Math.ceil((this.dailyLimit * this.warnPercent) / 100)) {
      daily.warned = true;
      this.logger.warn("daily request ceiling nearly reached", { count: daily.count, limit: this.dailyLimit });
    }
    this.store.save();
  }
}

export const guardInternals = { localDay, msUntilLocalMidnight, CONSECUTIVE_401_TRIP, QUOTA_FALLBACK_MS };
