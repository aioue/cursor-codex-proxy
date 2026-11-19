import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.js";

const base = { PROXY_API_KEY: "a".repeat(32), CODEX_CLIENT_VERSION: "0.170.0", CODEX_HOME: "/tmp/ccp-config-test" };

test("defaults: loopback, medium effort, tier unset, never refresh, header quota on, usage fetch off, limits", () => {
  const config = loadConfig(base);
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.defaultReasoningEffort, "medium");
  assert.equal(config.defaultServiceTier, undefined);
  assert.equal(config.refreshMode, "never");
  assert.equal(config.quotaLog, true);
  assert.equal(config.quotaUsageFetch, false);
  assert.deepEqual(config.modelVariants, ["low", "medium", "high"], "no xhigh by default");
  assert.equal(config.maxConcurrentRequests, 2);
  assert.equal(config.maxQueueWaitMs, 60_000);
  assert.equal(config.rateLimitPerMinute, 30);
  assert.equal(config.minRequestSpacingMs, 250);
  assert.equal(config.dailyRequestLimit, 1500);
  assert.equal(config.dailyWarnPercent, 80);
  assert.equal(config.breakerOpenAfter, 3);
  assert.equal(config.streamIdleTimeoutMs, 300_000);
  assert.ok(config.socketIdleTimeoutMs > config.streamIdleTimeoutMs);
  assert.match(config.stateFile, /\.cursor-codex-proxy\/state\.json$/);
  assert.ok(config.quotaIntervalMs >= 60_000);
  assert.match(config.userAgent, /^codex_cli_rs\/0\.170\.0 \(.+; .+\) cursor-codex-proxy\/\d/);
});

test("rejects short, missing and placeholder keys", () => {
  assert.throws(() => loadConfig({ ...base, PROXY_API_KEY: "short" }), /24 characters/);
  assert.throws(() => loadConfig({ ...base, PROXY_API_KEY: undefined }), /24 characters/);
  assert.throws(() => loadConfig({ ...base, PROXY_API_KEY: "replace-with-a-long-random-secret" }), /24 characters/);
});

test("refuses non-loopback binds", () => {
  for (const host of ["0.0.0.0", "::", "192.168.1.5", "example.com"]) {
    assert.throws(() => loadConfig({ ...base, HOST: host }), /loopback/, host);
  }
  assert.equal(loadConfig({ ...base, HOST: "::1" }).host, "::1");
});

test("upstream and token URLs must be https unless loopback", () => {
  assert.throws(() => loadConfig({ ...base, CODEX_UPSTREAM_BASE_URL: "http://evil.example/codex" }), /https/);
  assert.throws(() => loadConfig({ ...base, CODEX_REFRESH_TOKEN_URL_OVERRIDE: "http://evil.example/token" }), /https/);
  assert.equal(loadConfig({ ...base, CODEX_UPSTREAM_BASE_URL: "http://127.0.0.1:9/backend-api/codex" }).upstreamBaseUrl, "http://127.0.0.1:9/backend-api/codex");
});

test("validates effort, tier and refresh mode; quota interval is clamped", () => {
  assert.throws(() => loadConfig({ ...base, DEFAULT_REASONING_EFFORT: "max" }));
  assert.throws(() => loadConfig({ ...base, DEFAULT_SERVICE_TIER: "turbo" }));
  assert.throws(() => loadConfig({ ...base, CODEX_PROXY_REFRESH: "always" }));
  assert.equal(loadConfig({ ...base, CODEX_PROXY_REFRESH: "auto" }).refreshMode, "auto");
  assert.equal(loadConfig({ ...base, CODEX_PROXY_REFRESH: "expired" }).refreshMode, "auto", "old name still accepted");
  assert.deepEqual(loadConfig({ ...base, CODEX_PROXY_MODEL_VARIANTS: "low,high,xhigh" }).modelVariants, ["low", "high", "xhigh"]);
  assert.equal(loadConfig({ ...base, QUOTA_LOG: "0" }).quotaLog, false);
  assert.equal(loadConfig({ ...base, CODEX_PROXY_STATE_FILE: "/tmp/ccp-x/state.json" }).stateFile, "/tmp/ccp-x/state.json");
  assert.throws(() => loadConfig({ ...base, CODEX_PROXY_MODELS: "gpt-5.5;tier=priority" }), /CODEX_PROXY_MODELS/);
  assert.equal(loadConfig({ ...base, DEFAULT_SERVICE_TIER: "priority" }).defaultServiceTier, "priority");
  assert.equal(loadConfig({ ...base, QUOTA_LOG: "1", QUOTA_LOG_INTERVAL_MS: "1000" }).quotaIntervalMs, 60_000);
  assert.equal(loadConfig({ ...base, CODEX_USER_AGENT: "custom/1" }).userAgent, "custom/1");
});
