import assert from "node:assert/strict";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createProxyServer } from "../src/server.js";
import { QuotaReporter } from "../src/quota.js";
import { captureLogger, jwt, sse } from "./helpers.js";
import { KEY, SECRET_MARKER, auth, chatBody, json, startProxy } from "./harness.js";

const setup = (options = {}) => startProxy(options);

test("auth is required on every route except GET /healthz", async (t) => {
  const app = await setup();
  t.after(app.close);
  assert.equal((await fetch(`${app.origin}/healthz`)).status, 200);
  const cases = [
    ["GET", "/v1/models"],
    ["POST", "/v1/chat/completions"],
    ["GET", "/v1/chat/completions"],
    ["OPTIONS", "/v1/chat/completions"],
    ["DELETE", "/v1/models"]
  ];
  for (const [method, path] of cases) {
    for (const headers of [{}, { authorization: "Bearer wrong-key-wrong-key-wrong-key" }, { authorization: KEY }, { authorization: `bearer ${KEY}` }]) {
      const response = await fetch(`${app.origin}${path}`, { method, headers: { ...headers, ...json }, body: method === "POST" ? chatBody() : undefined });
      assert.equal(response.status, 401, `${method} ${path} ${JSON.stringify(headers)}`);
      assert.equal((await response.json()).error.code, "invalid_api_key");
    }
  }
  assert.equal(app.upstream.requests.length, 0, "no upstream call without auth");
  // No CORS headers on any response.
  const response = await fetch(`${app.origin}/v1/models`, { headers: { origin: "https://evil.invalid" } });
  assert.equal(response.headers.get("access-control-allow-origin"), null);
});

test("path allowlist: everything else is 404, never logged by path, only counted", async (t) => {
  const app = await setup();
  t.after(app.close);
  const paths = ["/", "/v1/responses", "/v1/embeddings", `/v1/${SECRET_MARKER}`, "/healthz/", "/v1/models/x", "/V1/MODELS", "/v1/chat/completions/../models"];
  for (const path of paths) {
    const response = await fetch(`${app.origin}${path}`, { method: "POST", headers: { ...auth, ...json }, body: chatBody() });
    // fetch normalises "/../", which then hits /v1/models with POST -> 405 after auth.
    if (path.includes("..")) continue;
    assert.equal(response.status, 404, path);
  }
  assert.equal(app.upstream.requests.length, 0);
  assert.ok(!app.lines.join("\n").includes(SECRET_MARKER));
  assert.ok(!app.lines.join("\n").includes("/v1/responses"));
});

test("/v1/models: live catalog with suffix variants, source header, no paths leaked", async (t) => {
  const app = await setup();
  t.after(app.close);
  const response = await fetch(`${app.origin}/v1/models`, { headers: auth });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-codex-proxy-models-source"), "live");
  const body = await response.json();
  assert.deepEqual(body.data.map((m) => m.id), ["gpt-live-a", "gpt-live-a-high", "gpt-live-b", "gpt-live-b-high", "gpt-5.5", "gpt-5.5-high"]);
  assert.match(app.upstream.requests[0].url, /models\?client_version=0\.170\.0/);
  const raw = JSON.stringify(body) + JSON.stringify([...response.headers]);
  assert.ok(!raw.includes(homedir()) && !raw.includes(app.dir));
});

test("/v1/models falls back to models_cache.json, then the built-in list", async (t) => {
  const failing = { "/backend-api/codex/models": (_req, res) => { res.writeHead(500); res.end("nope"); } };
  const app = await setup({ handlers: failing });
  t.after(app.close);
  await writeFile(join(app.dir, "models_cache.json"), JSON.stringify({ fetched_at: "x", models: [{ slug: "gpt-cached", visibility: "list" }] }));
  let response = await fetch(`${app.origin}/v1/models`, { headers: auth });
  assert.equal(response.headers.get("x-codex-proxy-models-source"), "cache");
  assert.deepEqual((await response.json()).data.map((m) => m.id), ["gpt-cached", "gpt-cached-high"]);
  await writeFile(join(app.dir, "models_cache.json"), "not json");
  response = await fetch(`${app.origin}/v1/models`, { headers: auth });
  assert.equal(response.headers.get("x-codex-proxy-models-source"), "builtin");
  assert.ok((await response.json()).data.some((m) => m.id === "gpt-5.5"));
});

test("upstream fingerprint: same user-agent and originator on responses, models and usage", async (t) => {
  const app = await setup({ configOverrides: { quotaLog: true, quotaUsageFetch: true, modelVariants: ["high", "fast"] } });
  t.after(app.close);
  await fetch(`${app.origin}/v1/models`, { headers: auth });
  const r = await fetch(`${app.origin}/v1/chat/completions`, { method: "POST", headers: { ...auth, ...json }, body: chatBody({ user: "conv-1", model: "gpt-5.5-high-fast" }) });
  await r.text();
  // Let the background quota lookup finish.
  await new Promise((resolve) => setTimeout(resolve, 100));
  const byPath = Object.fromEntries(app.upstream.requests.map((q) => [new URL(q.url, "http://x").pathname, q]));
  const paths = ["/backend-api/codex/models", "/backend-api/codex/responses", "/backend-api/wham/usage"];
  for (const p of paths) {
    assert.ok(byPath[p], p);
    assert.equal(byPath[p].headers["user-agent"], "codex_cli_rs/0.170.0 (Test OS 1; arm64) cursor-codex-proxy/test", p);
    assert.equal(byPath[p].headers.originator, "codex_cli_rs", p);
    assert.equal(byPath[p].headers["chatgpt-account-id"], "acct_test", p);
    assert.equal(byPath[p].headers.authorization, `Bearer ${app.access}`, p);
    assert.equal(byPath[p].headers["x-codex-installation-id"], undefined, p);
  }
  const responses = byPath["/backend-api/codex/responses"];
  assert.equal(responses.headers["x-codex-routing-hint"], "model=gpt-5.5;tier=priority");
  assert.equal(responses.headers.session_id, "conv-1");
  assert.equal(responses.body.prompt_cache_key, "conv-1");
  assert.equal(responses.body.model, "gpt-5.5");
  assert.equal(responses.body.reasoning.effort, "high");
  assert.ok(app.lines.some((l) => /quota 5h 13% used.*weekly 40% used/.test(l)), app.lines.join("\n"));
});

test("non-streaming chat completion returns content and real usage", async (t) => {
  const app = await setup();
  t.after(app.close);
  const response = await fetch(`${app.origin}/v1/chat/completions`, { method: "POST", headers: { ...auth, ...json }, body: chatBody() });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.choices[0].message.content, "hello");
  assert.deepEqual(body.usage, { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 });
  assert.equal(body.model, "gpt-5.5");
});

test("streaming chat completion: chunks, usage chunk, [DONE]; logs hold no prompt or key", async (t) => {
  const app = await setup();
  t.after(app.close);
  const response = await fetch(`${app.origin}/v1/chat/completions`, { method: "POST", headers: { ...auth, ...json }, body: chatBody({ stream: true, stream_options: { include_usage: true } }) });
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.match(text, /"content":"hello"/);
  assert.match(text, /"choices":\[\],"usage":\{"prompt_tokens":2/);
  const noUsage = await (await fetch(`${app.origin}/v1/chat/completions`, { method: "POST", headers: { ...auth, ...json }, body: chatBody({ stream: true }) })).text();
  assert.doesNotMatch(noUsage, /"usage"/, "usage chunk only with stream_options.include_usage");
  assert.match(text, /data: \[DONE\]\n\n$/);
  const log = app.lines.join("\n");
  assert.ok(!log.includes(SECRET_MARKER));
  assert.ok(!log.includes(KEY));
  assert.ok(!log.includes(app.access));
  assert.match(log, /"wire":"messages"/);
});

test("streamed upstream failure becomes an error event, not a silent truncation", async (t) => {
  const handlers = {
    "/backend-api/codex/responses": (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(sse([
        { type: "response.created", response: { id: "r" } },
        { type: "response.output_text.delta", delta: "part" },
        { type: "response.failed", response: { error: { code: "server_error", message: "Model crashed" } } }
      ]));
    }
  };
  const app = await setup({ handlers });
  t.after(app.close);
  const text = await (await fetch(`${app.origin}/v1/chat/completions`, { method: "POST", headers: { ...auth, ...json }, body: chatBody({ stream: true }) })).text();
  assert.match(text, /"error":\{"message":"Model crashed"/);
  assert.doesNotMatch(text, /\[DONE\]/);
  // Non-streaming: proper HTTP error status.
  const response = await fetch(`${app.origin}/v1/chat/completions`, { method: "POST", headers: { ...auth, ...json }, body: chatBody() });
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error.message, "Model crashed");
});

test("stream that ends without a terminal event is reported as truncated", async (t) => {
  const handlers = {
    "/backend-api/codex/responses": (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end("data: {\"type\":\"response.output_text.delta\",\"delta\":\"x\"}\n\n");
    }
  };
  const app = await setup({ handlers });
  t.after(app.close);
  const text = await (await fetch(`${app.origin}/v1/chat/completions`, { method: "POST", headers: { ...auth, ...json }, body: chatBody({ stream: true }) })).text();
  assert.match(text, /upstream_truncated/);
});

test("upstream 4xx is passed through with a sanitised message", async (t) => {
  const handlers = {
    "/backend-api/codex/responses": (_req, res) => {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ detail: "Unsupported model\n\x1b[31m" }));
    }
  };
  const app = await setup({ handlers });
  t.after(app.close);
  const response = await fetch(`${app.origin}/v1/chat/completions`, { method: "POST", headers: { ...auth, ...json }, body: chatBody() });
  assert.equal(response.status, 400);
  assert.doesNotMatch((await response.json()).error.message, /[\n\x1b]/);
});

test("upstream 401 with an unexpired token: no forced refresh, clear codex login error", async (t) => {
  let tokenCalls = 0;
  const handlers = {
    "/backend-api/codex/responses": (_req, res) => { res.writeHead(401); res.end("{}"); },
    "/oauth/token": (_req, res) => { tokenCalls += 1; res.writeHead(500); res.end(); }
  };
  const app = await setup({ handlers });
  t.after(app.close);
  const response = await fetch(`${app.origin}/v1/chat/completions`, { method: "POST", headers: { ...auth, ...json }, body: chatBody() });
  assert.equal(response.status, 401);
  assert.match((await response.json()).error.message, /codex login/);
  assert.equal(tokenCalls, 0);
});

test("expired token is refreshed against the (mock) token endpoint with the same headers", async (t) => {
  const expiredToken = jwt({ exp: 1, "https://api.openai.com/auth": { chatgpt_account_id: "acct_test" } });
  const newToken = jwt({ exp: Math.floor(Date.now() / 1000) + 3600, "https://api.openai.com/auth": { chatgpt_account_id: "acct_test" } });
  const handlers = {
    "/oauth/token": (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ access_token: newToken, refresh_token: "rt-rotated" }));
    }
  };
  const app = await setup({ handlers, configOverrides: { refreshMode: "auto" }, authTokens: { access_token: expiredToken, refresh_token: "rt-fake", account_id: "acct_test" } });
  t.after(app.close);
  const response = await fetch(`${app.origin}/v1/chat/completions`, { method: "POST", headers: { ...auth, ...json }, body: chatBody() });
  assert.equal(response.status, 200);
  const tokenRequest = app.upstream.requests.find((r) => r.url === "/oauth/token");
  assert.equal(tokenRequest.body.refresh_token, "rt-fake");
  assert.equal(tokenRequest.headers["user-agent"], "codex_cli_rs/0.170.0 (Test OS 1; arm64) cursor-codex-proxy/test");
  const responsesRequest = app.upstream.requests.find((r) => r.url.endsWith("/responses"));
  assert.equal(responsesRequest.headers.authorization, `Bearer ${newToken}`);
});

test("quota reporter: off by default, usage fetch opt-in, at most one lookup per interval", async () => {
  let calls = 0;
  const upstream = { usage: async () => { calls += 1; return { rate_limit: { primary_window: { used_percent: 1, limit_window_seconds: 18000 } } }; } };
  const off = new QuotaReporter({ upstream });
  off.observe(new Headers());
  assert.equal(calls, 0);
  let clock = 0;
  const { lines, logger } = captureLogger();
  const headersOnly = new QuotaReporter({ enabled: true, upstream, logger, now: () => clock });
  headersOnly.observe(new Headers());
  assert.equal(calls, 0, "no wham/usage call unless usageFetch is enabled");
  const on = new QuotaReporter({ enabled: true, usageFetch: true, intervalMs: 1, upstream, logger, now: () => clock });
  assert.equal(on.intervalMs, 60_000, "interval is clamped to >= 60 s");
  await on.observe(new Headers());
  for (let i = 0; i < 50; i += 1) on.observe(new Headers());
  assert.equal(calls, 1);
  clock = 60_000;
  await on.observe(new Headers({ "x-codex-primary-used-percent": "33", "x-codex-primary-window-minutes": "300" }));
  assert.equal(calls, 1, "headers are used when present, no extra request");
  assert.ok(lines.some((l) => /quota 5h 33% used/.test(l)));
});

test("createProxyServer counts unmatched paths without logging them", async (t) => {
  let clock = 0;
  const { lines, logger } = captureLogger();
  const server = createProxyServer({ config: { apiKey: KEY, requestTimeoutMs: 1000 }, upstream: {}, models: {}, logger, now: () => clock });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  for (let i = 0; i < 3; i += 1) await (await fetch(`${origin}/secret-path-${i}`)).text();
  clock = 61_000;
  await (await fetch(`${origin}/secret-path-x`)).text();
  const summary = lines.find((l) => l.includes("unmatched"));
  assert.match(summary, /"count":4/);
  assert.ok(!lines.join("\n").includes("secret-path"));
});
