import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ConcurrencyLimiter, KILL_CODES, RateLimiter, StateStore, UpstreamGuard, guardInternals, parseRetryAfter } from "../src/guard.js";
import { serverInternals } from "../src/server.js";
import { captureLogger } from "./helpers.js";

const T0 = Date.UTC(2026, 10, 19, 12, 0, 0);

function headers(values = {}) {
  return new Headers(values);
}

async function tempState() {
  const dir = await mkdtemp(join(tmpdir(), "ccp-state-"));
  return join(dir, "nested", "state.json");
}

test("parseRetryAfter: seconds, HTTP date, junk, cap", () => {
  assert.equal(parseRetryAfter("7", T0), 7000);
  assert.equal(parseRetryAfter(new Date(T0 + 30_000).toUTCString(), T0), 30_000);
  assert.equal(parseRetryAfter("soon", T0), undefined);
  assert.equal(parseRetryAfter(undefined, T0), undefined);
  assert.equal(parseRetryAfter("999999999", T0), 24 * 60 * 60 * 1000);
});

test("breaker: Retry-After honoured; no Retry-After gives full-jitter backoff from 1 s; opens after 3 in a row", () => {
  let clock = T0;
  let rnd = 0.5;
  const guard = new UpstreamGuard({ now: () => clock, random: () => rnd });
  guard.check();
  // 1st: Retry-After 5 s
  assert.equal(guard.observeError(429, "rate_limit_exceeded", { headers: headers({ "retry-after": "5" }) }), "transient");
  assert.throws(() => guard.check(), (e) => e.status === 429 && e.code === "proxy_backoff" && e.retryAfter === 5 && e.local);
  clock += 5_000;
  guard.check();
  // 2nd: no Retry-After -> random * min(60 s, 1 s * 2^1) = 0.5 * 2000
  guard.observeError(503, undefined, { headers: headers() });
  assert.throws(() => guard.check(), (e) => e.retryAfter === 1);
  clock += 999;
  assert.throws(() => guard.check());
  clock += 1;
  guard.check();
  // 3rd in a row: breaker opens for at least the 60 s cap.
  rnd = 0;
  guard.observeError(200, "server_is_overloaded", {});
  assert.equal(guard.open, true);
  assert.throws(() => guard.check(), (e) => e.code === "proxy_circuit_open" && e.retryAfter === 60);
  clock += 59_999;
  assert.throws(() => guard.check());
  clock += 1;
  guard.check();
  // A completed response resets the count: the next error is a 1st again.
  guard.onSuccess();
  rnd = 1;
  guard.observeError(429, "slow_down", {});
  assert.throws(() => guard.check(), (e) => e.code === "proxy_backoff" && e.retryAfter === 1, "1 s * 2^0 * random(=1)");
});

test("breaker: jitter ceiling grows exponentially and is capped at 60 s", () => {
  let clock = T0;
  const guard = new UpstreamGuard({ now: () => clock, random: () => 0.999999, openAfter: 100 });
  const seen = [];
  for (let i = 0; i < 9; i += 1) {
    guard.observeError(429, undefined, {});
    seen.push(guard.cooldownUntil - clock);
    clock = guard.cooldownUntil;
  }
  assert.deepEqual(seen.map((ms) => Math.round(ms / 1000)), [1, 2, 4, 8, 16, 32, 60, 60, 60]);
});

test("breaker: other 4xx/5xx do not count; nothing classified as retry", () => {
  const guard = new UpstreamGuard({ now: () => T0 });
  assert.equal(guard.observeError(400, "invalid_request_error", {}), null);
  assert.equal(guard.observeError(500, undefined, {}), null);
  guard.check();
});

test("quota: usage_limit_reached blocks until resets_at, header fallback, 15 min fallback; persisted", async () => {
  const file = await tempState();
  let clock = T0;
  const store = new StateStore({ file });
  const guard = new UpstreamGuard({ store, now: () => clock });
  guard.observeError(429, "usage_limit_reached", { resetsAt: (T0 + 3_600_000) / 1000 });
  assert.throws(() => guard.check(), (e) => e.code === "usage_limit_reached" && e.retryAfter === 3600);
  await store.flush();
  assert.equal(JSON.parse(await readFile(file, "utf8")).quotaUntil, T0 + 3_600_000);
  // A restart keeps the cooldown.
  const again = new UpstreamGuard({ store: new StateStore({ file }), now: () => clock });
  assert.throws(() => again.check(), (e) => e.code === "usage_limit_reached");
  clock = T0 + 3_600_000;
  again.check();
  // x-codex-primary-reset-at header
  again.observeError(429, "insufficient_quota", { headers: headers({ "x-codex-primary-reset-at": String((clock + 120_000) / 1000) }) });
  assert.throws(() => again.check(), (e) => e.retryAfter === 120);
  clock += 120_000;
  // nothing at all -> 15 minutes
  again.observeError(429, "usage_limit_reached", {});
  assert.throws(() => again.check(), (e) => e.retryAfter === guardInternals.QUOTA_FALLBACK_MS / 1000);
});

test("kill switch: trips on every listed code, persists 0600, survives restart, cleared by deleting the key on disk", async () => {
  for (const code of KILL_CODES) {
    const guard = new UpstreamGuard({ now: () => T0 });
    assert.equal(guard.observeError(403, code, {}), "kill");
    assert.throws(() => guard.check(), (e) => e.status === 503 && e.code === "proxy_kill_switch" && e.message.includes(code));
  }
  const file = await tempState();
  const { lines, logger } = captureLogger();
  const store = new StateStore({ file, logger });
  const guard = new UpstreamGuard({ store, logger, now: () => T0 });
  guard.observeError(400, "cyber_policy", {});
  await store.flush();
  assert.ok(lines.some((l) => l.startsWith("error KILL SWITCH TRIPPED (cyber_policy)")), lines.join("\n"));
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await stat(join(file, ".."))).mode & 0o777, 0o700);
  const saved = JSON.parse(await readFile(file, "utf8"));
  assert.equal(saved.killSwitch.code, "cyber_policy");
  assert.ok(!JSON.stringify(saved).includes("prompt"));
  // Restart: still tripped.
  const restarted = new UpstreamGuard({ store: new StateStore({ file }), now: () => T0 });
  assert.throws(() => restarted.check(), (e) => e.status === 503);
  // Manual reset (what scripts/reset.mjs does) is picked up without restart.
  const { writeFile } = await import("node:fs/promises");
  await writeFile(file, JSON.stringify({ version: 1 }));
  restarted.check();
});

test("kill switch: two consecutive 401s trip it; a success in between resets", () => {
  const guard = new UpstreamGuard({ now: () => T0 });
  guard.onUnauthorized();
  guard.onAuthOk();
  guard.onUnauthorized();
  guard.check();
  guard.onUnauthorized();
  assert.throws(() => guard.check(), (e) => e.status === 503 && e.message.includes("consecutive_401"));
});

test("a corrupt state file counts as tripped (never silently cleared)", async () => {
  const file = await tempState();
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, "{not json");
  const guard = new UpstreamGuard({ store: new StateStore({ file }), now: () => T0 });
  assert.throws(() => guard.check(), (e) => e.status === 503 && e.message.includes("state_file_unreadable"));
});

test("concurrency limiter: FIFO order, queue timeout is a 429 with Retry-After, abort leaves the queue", async () => {
  const limiter = new ConcurrencyLimiter({ max: 2, maxWaitMs: 200 });
  const a = await limiter.acquire();
  const b = await limiter.acquire();
  const order = [];
  const c = limiter.acquire().then((release) => { order.push("c"); return release; });
  const d = limiter.acquire().then((release) => { order.push("d"); return release; });
  const controller = new AbortController();
  const e = limiter.acquire(controller.signal);
  controller.abort();
  await assert.rejects(e, (err) => err.name === "AbortError");
  assert.equal(limiter.queue.length, 2);
  a();
  a(); // double release is a no-op
  const releaseC = await c;
  b();
  const releaseD = await d;
  assert.deepEqual(order, ["c", "d"]);
  assert.equal(limiter.active, 2);
  const started = Date.now();
  await assert.rejects(limiter.acquire(), (err) => err.status === 429 && err.code === "proxy_queue_timeout" && err.retryAfter >= 1);
  assert.ok(Date.now() - started >= 190, "waited for the queue timeout, not an instant 429");
  releaseC();
  releaseD();
  assert.equal(limiter.active, 0);
  const unlimited = new ConcurrencyLimiter({ max: 0 });
  await Promise.all(Array.from({ length: 50 }, () => unlimited.acquire()));
});

test("rate limiter: 250 ms spacing, 30/min bucket, wait beyond budget is a 429", () => {
  let clock = T0;
  const rate = new RateLimiter({ perMinute: 30, minSpacingMs: 250, dailyLimit: 0, now: () => clock });
  assert.equal(rate.reserve(60_000), 0);
  assert.equal(rate.reserve(60_000), 250, "second request right away waits for the spacing");
  clock += 10_000;
  let total = 2;
  // Drain the bucket.
  while (rate.tokens >= 1) {
    rate.reserve(60_000);
    clock += 250;
    total += 1;
  }
  assert.ok(total >= 30);
  const wait = rate.reserve(60_000);
  assert.ok(wait > 250 && wait <= 2_000, `bucket refills at 1 token / 2 s (wait ${wait})`);
  clock += wait + 250;
  assert.throws(() => {
    for (let i = 0; i < 100; i += 1) rate.reserve(1_000);
  }, (e) => e.status === 429 && e.code === "proxy_rate_limited" && e.retryAfter >= 1);
});

test("daily ceiling: counts per local day, warns at 80%, 429 until local midnight, persisted", async () => {
  const file = await tempState();
  const { lines, logger } = captureLogger();
  const start = new Date(2026, 10, 19, 23, 0, 0).getTime(); // local time
  let clock = start;
  const store = new StateStore({ file });
  const rate = new RateLimiter({ perMinute: 0, minSpacingMs: 0, dailyLimit: 5, warnPercent: 80, store, now: () => clock, logger });
  for (let i = 0; i < 5; i += 1) rate.admit();
  assert.equal(lines.filter((l) => l.includes("daily request ceiling nearly reached")).length, 1);
  assert.throws(() => rate.admit(), (e) => e.status === 429 && e.code === "proxy_daily_limit" && e.retryAfter === 3600);
  await store.flush();
  const saved = JSON.parse(await readFile(file, "utf8"));
  assert.deepEqual({ day: saved.daily.day, count: saved.daily.count }, { day: "2026-11-19", count: 5 });
  // Restart on the same day: still over.
  const again = new RateLimiter({ perMinute: 0, dailyLimit: 5, store: new StateStore({ file }), now: () => clock });
  assert.throws(() => again.admit(), (e) => e.code === "proxy_daily_limit");
  clock = new Date(2026, 10, 20, 0, 0, 1).getTime();
  again.admit();
  assert.equal(again.store.data.daily.count, 1);
});

test("write(): a client that never drains gets its response destroyed after drainTimeoutMs", async () => {
  const fake = new EventEmitter();
  fake.destroyed = false;
  fake.writableEnded = false;
  fake.write = () => false; // buffer full, no "drain" will ever come
  fake.destroy = () => { fake.destroyed = true; };
  const started = Date.now();
  await assert.rejects(serverInternals.write(fake, "data", 100), (e) => e.code === "client_stalled");
  assert.ok(Date.now() - started >= 95);
  assert.equal(fake.destroyed, true);
  assert.equal(fake.listenerCount("drain"), 0);
  // drain arriving in time resolves normally
  const ok = new EventEmitter();
  ok.write = () => false;
  ok.destroy = () => assert.fail("not destroyed");
  setTimeout(() => ok.emit("drain"), 10);
  await serverInternals.write(ok, "data", 1000);
});
