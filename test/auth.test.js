import assert from "node:assert/strict";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { CodexAuth, atomicWriteJson, authInternals } from "../src/auth.js";
import { jwt, tempAuth } from "./helpers.js";

const NOW = 1_000_000_000_000; // ms
const fresh = () => jwt({ exp: NOW / 1000 + 3600, "https://api.openai.com/auth": { chatgpt_account_id: "acct_1" } });
const expired = () => jwt({ exp: NOW / 1000 - 10, "https://api.openai.com/auth": { chatgpt_account_id: "acct_1" } });

function tokenResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("account id and expiry helpers", () => {
  const token = jwt({ exp: 100, "https://api.openai.com/auth": { chatgpt_account_id: "acct_1" } });
  assert.equal(authInternals.accountIdFrom({ tokens: { access_token: token } }), "acct_1");
  assert.equal(authInternals.tokenExpiresSoon(token, () => 100_000, 1), true);
});

test("an unexpired token is used without any refresh", async () => {
  const { authFile } = await tempAuth({ access_token: fresh(), refresh_token: "rt" });
  let calls = 0;
  const auth = new CodexAuth({ authFile, now: () => NOW, fetchImpl: async () => { calls += 1; } });
  const creds = await auth.getCredentials();
  assert.equal(creds.accountId, "acct_1");
  assert.equal(calls, 0);
});

test("expired token: refreshes once, writes atomically with 0600 and keeps other fields", async () => {
  const { dir, authFile } = await tempAuth({ access_token: expired(), refresh_token: "rt-old", account_id: "acct_1" }, { OPENAI_API_KEY: null, custom: "keep" });
  let calls = 0;
  const newAccess = fresh();
  const auth = new CodexAuth({
    authFile,
    now: () => NOW,
    baseHeaders: { "user-agent": "ua-test", originator: "codex_cli_rs" },
    fetchImpl: async (_url, options) => {
      calls += 1;
      assert.equal(JSON.parse(options.body).refresh_token, "rt-old");
      assert.equal(options.headers["user-agent"], "ua-test");
      return tokenResponse({ access_token: newAccess, refresh_token: "rt-new" });
    }
  });
  // Ten concurrent callers share one refresh.
  const results = await Promise.all(Array.from({ length: 10 }, () => auth.getCredentials()));
  assert.equal(calls, 1);
  assert.ok(results.every((r) => r.accessToken === newAccess));
  const saved = JSON.parse(await readFile(authFile, "utf8"));
  assert.equal(saved.tokens.refresh_token, "rt-new");
  assert.equal(saved.custom, "keep");
  assert.ok(saved.last_refresh);
  assert.equal((await stat(authFile)).mode & 0o777, 0o600);
  assert.deepEqual((await readdir(dir)).filter((f) => f.endsWith(".tmp")), []);
});

test("re-reads auth.json before refreshing: a CLI refresh is picked up, no token spent", async () => {
  const cliToken = fresh();
  let calls = 0;
  let reads = 0;
  // First read sees the stale token; by the second read (just before refreshing)
  // the CLI has already written a new one.
  const readAuth = async () => {
    reads += 1;
    return reads === 1
      ? { tokens: { access_token: expired(), refresh_token: "rt-old", account_id: "acct_1" } }
      : { tokens: { access_token: cliToken, refresh_token: "rt-cli", account_id: "acct_1" } };
  };
  const auth = new CodexAuth({ authFile: "unused", readAuth, now: () => NOW, fetchImpl: async () => { calls += 1; } });
  const creds = await auth.getCredentials();
  assert.equal(creds.accessToken, cliToken);
  assert.equal(calls, 0);
  assert.equal(reads, 2);
});

test("compare-and-swap: if the refresh token changed during refresh, the file is not overwritten", async () => {
  const { authFile } = await tempAuth({ access_token: expired(), refresh_token: "rt-old", account_id: "acct_1" });
  const cliToken = fresh();
  const auth = new CodexAuth({
    authFile,
    now: () => NOW,
    fetchImpl: async () => {
      // The CLI wins the race while our request is in flight.
      await writeFile(authFile, JSON.stringify({ tokens: { access_token: cliToken, refresh_token: "rt-cli", account_id: "acct_1" } }));
      return tokenResponse({ access_token: fresh(), refresh_token: "rt-proxy" });
    }
  });
  const creds = await auth.getCredentials();
  assert.equal(creds.accessToken, cliToken);
  const saved = JSON.parse(await readFile(authFile, "utf8"));
  assert.equal(saved.tokens.refresh_token, "rt-cli");
});

test("refresh failure returns a 401 that tells the user to run codex login", async () => {
  const { authFile } = await tempAuth({ access_token: expired(), refresh_token: "rt-old", account_id: "acct_1" });
  const auth = new CodexAuth({ authFile, now: () => NOW, fetchImpl: async () => tokenResponse({ error: "refresh_token_reused" }, 401) });
  await assert.rejects(auth.getCredentials(), (error) => error.status === 401 && /codex login/.test(error.message) && !error.message.includes(authFile));
});

test("refreshMode never: expired token gives 401 and no network call", async () => {
  const { authFile } = await tempAuth({ access_token: expired(), refresh_token: "rt-old", account_id: "acct_1" });
  let calls = 0;
  const auth = new CodexAuth({ authFile, refreshMode: "never", now: () => NOW, fetchImpl: async () => { calls += 1; } });
  await assert.rejects(auth.getCredentials(), (error) => error.status === 401 && error.code === "codex_auth_expired");
  assert.equal(calls, 0);
});

test("onUnauthorized never force-refreshes an unexpired token", async () => {
  const token = fresh();
  const { authFile } = await tempAuth({ access_token: token, refresh_token: "rt", account_id: "acct_1" });
  let calls = 0;
  const auth = new CodexAuth({ authFile, now: () => NOW, fetchImpl: async () => { calls += 1; } });
  await assert.rejects(auth.onUnauthorized(token), (error) => error.status === 401 && /codex login/.test(error.message));
  assert.equal(calls, 0);
});

test("onUnauthorized picks up a token rotated on disk by the CLI", async () => {
  const oldToken = fresh();
  const { authFile } = await tempAuth({ access_token: oldToken, refresh_token: "rt", account_id: "acct_1" });
  const newToken = jwt({ exp: NOW / 1000 + 7200, n: 2 });
  await writeFile(authFile, JSON.stringify({ tokens: { access_token: newToken, refresh_token: "rt2", account_id: "acct_1" } }));
  const auth = new CodexAuth({ authFile, now: () => NOW, fetchImpl: async () => assert.fail("no refresh expected") });
  assert.equal((await auth.onUnauthorized(oldToken)).accessToken, newToken);
});

test("missing auth file is a 401 without the path", async () => {
  const auth = new CodexAuth({ authFile: join("/nonexistent-dir-ccp", "auth.json"), now: () => NOW });
  await assert.rejects(auth.getCredentials(), (error) => error.status === 401 && !error.message.includes("nonexistent"));
});

test("atomicWriteJson replaces content and leaves no temp files", async () => {
  const { dir, authFile } = await tempAuth({ a: 1 });
  await atomicWriteJson(authFile, { b: 2 });
  assert.deepEqual(JSON.parse(await readFile(authFile, "utf8")), { b: 2 });
  assert.equal((await stat(authFile)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(dir), ["auth.json"]);
});
