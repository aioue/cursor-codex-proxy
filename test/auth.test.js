import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { once } from "node:events";
import { chmod, lstat, mkdtemp, readdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { CodexAuth, REFRESH_FAILURE_BACKOFF_MS, atomicWriteJson, authInternals } from "../src/auth.js";
import { captureLogger, jwt, tempAuth } from "./helpers.js";

const AUTH_MODULE = new URL("../src/auth.js", import.meta.url).href;

// Rewrites the file from a separate node process (stand-in for the Codex CLI).
function writeFromChild(path, value) {
  const result = spawnSync(process.execPath, ["-e", "require('node:fs').writeFileSync(process.argv[1], process.argv[2])", path, JSON.stringify(value)]);
  assert.equal(result.status, 0, String(result.stderr));
}

// Runs CodexAuth in auto mode in its own process and reports the outcome.
function refreshInChild(authFile, tokenUrl) {
  const script = `
    const { CodexAuth } = await import(process.argv[1]);
    const auth = new CodexAuth({ authFile: process.argv[2], tokenUrl: process.argv[3], refreshMode: "auto" });
    try {
      const creds = await auth.getCredentials();
      console.log(JSON.stringify({ ok: true, token: creds.accessToken }));
    } catch (error) {
      console.log(JSON.stringify({ ok: false, code: error.code }));
    }`;
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ["--input-type=module", "-e", script, AUTH_MODULE, authFile, tokenUrl], { timeout: 10_000 }, (error, stdout) => {
      if (error) return reject(error);
      resolve(JSON.parse(stdout.trim().split("\n").at(-1)));
    });
  });
}

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
    refreshMode: "auto",
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

// Logic test with an injected reader (the window is too small to hit with a
// real process reliably); the real-process races are further down.
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
  const auth = new CodexAuth({ authFile: "unused", refreshMode: "auto", readAuth, now: () => NOW, fetchImpl: async () => { calls += 1; } });
  const creds = await auth.getCredentials();
  assert.equal(creds.accessToken, cliToken);
  assert.equal(calls, 0);
  assert.equal(reads, 2);
});

test("compare-and-swap: a second process rotating auth.json during the refresh wins; loud warning", async () => {
  const { authFile } = await tempAuth({ access_token: expired(), refresh_token: "rt-old", account_id: "acct_1" });
  const cliToken = fresh();
  const { lines, logger } = captureLogger();
  const auth = new CodexAuth({
    authFile,
    refreshMode: "auto",
    now: () => NOW,
    logger,
    fetchImpl: async () => {
      // A separate OS process (stand-in for the Codex CLI) rewrites the file
      // while the proxy's token request is in flight.
      writeFromChild(authFile, { tokens: { access_token: cliToken, refresh_token: "rt-cli", account_id: "acct_1" } });
      return tokenResponse({ access_token: fresh(), refresh_token: "rt-proxy" });
    }
  });
  const creds = await auth.getCredentials();
  assert.equal(creds.accessToken, cliToken);
  const saved = JSON.parse(await readFile(authFile, "utf8"));
  assert.equal(saved.tokens.refresh_token, "rt-cli");
  assert.ok(lines.some((l) => l.includes("LOST AUTH RACE") && l.includes("NOT saved")), lines.join("\n"));
  assert.ok(!lines.join("\n").includes("rt-proxy"), "the discarded token itself is never logged");
});

test("refresh failure returns a 401 that tells the user to run codex login", async () => {
  const { authFile } = await tempAuth({ access_token: expired(), refresh_token: "rt-old", account_id: "acct_1" });
  const auth = new CodexAuth({ authFile, refreshMode: "auto", now: () => NOW, fetchImpl: async () => tokenResponse({ error: "refresh_token_reused" }, 401) });
  await assert.rejects(auth.getCredentials(), (error) => error.status === 401 && /codex login/.test(error.message) && !error.message.includes(authFile));
});

test("default refresh mode is never: expired token gives 401 'codex login' and no network call", async () => {
  const { authFile } = await tempAuth({ access_token: expired(), refresh_token: "rt-old", account_id: "acct_1" });
  let calls = 0;
  for (const refreshMode of [undefined, "never"]) {
    const auth = new CodexAuth({ authFile, ...(refreshMode ? { refreshMode } : {}), now: () => NOW, fetchImpl: async () => { calls += 1; } });
    await assert.rejects(auth.getCredentials(), (error) => error.status === 401 && error.code === "codex_auth_expired" && /codex login/.test(error.message));
  }
  assert.equal(calls, 0);
});

test("onUnauthorized never refreshes, even an expired token in auto mode", async () => {
  const { authFile } = await tempAuth({ access_token: expired(), refresh_token: "rt", account_id: "acct_1" });
  const auth = new CodexAuth({ authFile, refreshMode: "auto", now: () => NOW, fetchImpl: async () => assert.fail("no refresh after a 401") });
  await assert.rejects(auth.onUnauthorized("whatever"), (error) => error.status === 401 && error.code === "codex_auth_rejected");
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

test("atomicWriteJson replaces content, temp file is 0600 even with umask 000, no temp left", async () => {
  const { dir, authFile } = await tempAuth({ a: 1 });
  await chmod(authFile, 0o644);
  const previous = process.umask(0);
  let tempMode;
  let tempName;
  try {
    await atomicWriteJson(authFile, { b: 2 }, {
      beforeRename: async (tempPath) => {
        tempName = basename(tempPath);
        tempMode = (await stat(tempPath)).mode & 0o777;
      }
    });
  } finally {
    process.umask(previous);
  }
  assert.equal(tempMode, 0o600);
  assert.match(tempName, /^\.auth\.json\.\d+\.[0-9a-f]{12}\.tmp$/);
  assert.deepEqual(JSON.parse(await readFile(authFile, "utf8")), { b: 2 });
  assert.equal((await stat(authFile)).mode & 0o777, 0o600, "a looser existing mode is tightened");
  assert.deepEqual(await readdir(dir), ["auth.json"]);
});

test("atomicWriteJson writes through a symlinked auth.json and keeps the link", async () => {
  const { dir: realDir, authFile: target } = await tempAuth({ a: 1 });
  const linkDir = await mkdtemp(join(tmpdir(), "ccp-link-"));
  const link = join(linkDir, "auth.json");
  await symlink(target, link);
  await atomicWriteJson(link, { linked: true });
  assert.ok((await lstat(link)).isSymbolicLink(), "still a symlink");
  assert.deepEqual(JSON.parse(await readFile(target, "utf8")), { linked: true });
  assert.equal((await stat(target)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(linkDir), ["auth.json"], "no temp file next to the link");
  assert.deepEqual(await readdir(realDir), ["auth.json"]);
  const dangling = join(linkDir, "dangling.json");
  await symlink(join(linkDir, "missing", "x.json"), dangling);
  await assert.rejects(atomicWriteJson(dangling, {}), /dangling symlink/);
});

test("auto refresh through a symlinked auth.json updates the target", async () => {
  const { authFile: target } = await tempAuth({ access_token: expired(), refresh_token: "rt-old", account_id: "acct_1" });
  const linkDir = await mkdtemp(join(tmpdir(), "ccp-link-"));
  const link = join(linkDir, "auth.json");
  await symlink(target, link);
  const newAccess = fresh();
  const auth = new CodexAuth({ authFile: link, refreshMode: "auto", now: () => NOW, fetchImpl: async () => tokenResponse({ access_token: newAccess, refresh_token: "rt-new" }) });
  assert.equal((await auth.getCredentials()).accessToken, newAccess);
  assert.ok((await lstat(link)).isSymbolicLink());
  assert.equal(JSON.parse(await readFile(target, "utf8")).tokens.refresh_token, "rt-new");
});

test("last-moment check: a second process writing just before rename is not overwritten", async () => {
  const { authFile } = await tempAuth({ access_token: expired(), refresh_token: "rt-old", account_id: "acct_1" });
  const cliToken = fresh();
  const { lines, logger } = captureLogger();
  const auth = new CodexAuth({
    authFile,
    refreshMode: "auto",
    now: () => NOW,
    logger,
    fetchImpl: async () => tokenResponse({ access_token: fresh(), refresh_token: "rt-proxy" }),
    // Runs after the compare-and-swap read and immediately before the proxy's
    // own signature check: the narrowest window the code can still detect.
    beforeRename: async () => writeFromChild(authFile, { tokens: { access_token: cliToken, refresh_token: "rt-old", account_id: "acct_1" }, touched: true })
  });
  const creds = await auth.getCredentials();
  assert.equal(creds.accessToken, cliToken);
  const saved = JSON.parse(await readFile(authFile, "utf8"));
  assert.equal(saved.touched, true, "the other process's file survived");
  assert.ok(lines.some((l) => l.includes("LOST AUTH RACE")));
  assert.deepEqual((await readdir(dirname(authFile))).filter((f) => f.endsWith(".tmp")), []);
});

test("two proxy processes refreshing the same auth.json: one spends the token, the other adopts it", async () => {
  const { authFile } = await tempAuth({ access_token: expired(), refresh_token: "rt-old", account_id: "acct_1" });
  const used = new Set();
  const issued = jwt({ exp: Math.floor(Date.now() / 1000) + 3600, "https://api.openai.com/auth": { chatgpt_account_id: "acct_1" } });
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const { refresh_token: rt } = JSON.parse(raw);
    // Single-use refresh tokens, like the real endpoint. Slow, to overlap both.
    await new Promise((r) => setTimeout(r, 150));
    if (used.has(rt)) {
      res.writeHead(401, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: { code: "refresh_token_reused" } }));
    }
    used.add(rt);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ access_token: issued, refresh_token: "rt-new" }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const tokenUrl = `http://127.0.0.1:${server.address().port}/oauth/token`;
  try {
    const results = await Promise.all([refreshInChild(authFile, tokenUrl), refreshInChild(authFile, tokenUrl)]);
    const ok = results.filter((r) => r.ok);
    assert.ok(ok.length >= 1, JSON.stringify(results));
    for (const r of ok) assert.equal(r.token, issued);
    const saved = JSON.parse(await readFile(authFile, "utf8"));
    assert.equal(saved.tokens.refresh_token, "rt-new", "the rotated token is on disk, not the spent one");
    assert.equal(saved.tokens.access_token, issued);
    assert.equal(used.size, 1, "rt-old was spent exactly once successfully");
  } finally {
    server.close();
  }
});

test("negative cache: after a failed refresh no new attempt until auth.json changes or 10 minutes pass", async () => {
  const { authFile } = await tempAuth({ access_token: expired(), refresh_token: "rt-old", account_id: "acct_1" });
  let clock = NOW;
  let calls = 0;
  const auth = new CodexAuth({ authFile, refreshMode: "auto", now: () => clock, fetchImpl: async () => { calls += 1; return tokenResponse({ error: "invalid_grant" }, 400); } });
  await assert.rejects(auth.getCredentials(), (e) => e.code === "codex_refresh_failed");
  await assert.rejects(auth.getCredentials(), (e) => e.code === "codex_refresh_backoff" && /codex login/.test(e.message));
  assert.equal(calls, 1);
  clock += REFRESH_FAILURE_BACKOFF_MS - 1;
  await assert.rejects(auth.getCredentials(), (e) => e.code === "codex_refresh_backoff");
  assert.equal(calls, 1);
  clock += 2;
  await assert.rejects(auth.getCredentials(), (e) => e.code === "codex_refresh_failed");
  assert.equal(calls, 2, "retried after the backoff");
  // A change on disk (user ran codex login) also lifts it.
  writeFromChild(authFile, { tokens: { access_token: expired(), refresh_token: "rt-relogin", account_id: "acct_1" } });
  await assert.rejects(auth.getCredentials(), (e) => e.code === "codex_refresh_failed");
  assert.equal(calls, 3);
});
