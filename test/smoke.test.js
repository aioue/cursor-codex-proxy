// End-to-end smoke test: runs the real entry point (node src/server.js) as a child
// process against the mock upstream, with fake tokens in a temp CODEX_HOME.
// Everything binds to 127.0.0.1 on ephemeral ports. The child gets a minimal,
// explicit environment, so no real CODEX_* variable or ~/.codex is ever used.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { jwt, tempAuth } from "./helpers.js";
import { startMockUpstream } from "./mock-upstream.js";

const SERVER = fileURLToPath(new URL("../src/server.js", import.meta.url));
const KEY = "smoke-test-key-0123456789abcdefghijkl";

function startChild(env) {
  const child = spawn(process.execPath, [SERVER], { env, stdio: ["ignore", "ignore", "pipe"] });
  let log = "";
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`proxy did not start:\n${log}`)), 5000);
    child.stderr.on("data", (d) => {
      log += d;
      const match = log.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    child.on("exit", (code) => reject(new Error(`proxy exited ${code}:\n${log}`)));
  });
  return { child, ready, log: () => log };
}

test("smoke: real server process, mock upstream, fake credentials", async (t) => {
  const upstream = await startMockUpstream();
  const access = jwt({ exp: Math.floor(Date.now() / 1000) + 3600, "https://api.openai.com/auth": { chatgpt_account_id: "acct_smoke" } });
  const { dir } = await tempAuth({ access_token: access, refresh_token: "rt-smoke", account_id: "acct_smoke" });
  const proc = startChild({
    PATH: process.env.PATH,
    HOME: dir,
    PROXY_API_KEY: KEY,
    HOST: "127.0.0.1",
    PORT: "0",
    CODEX_HOME: dir,
    CODEX_UPSTREAM_BASE_URL: upstream.baseUrl,
    CODEX_REFRESH_TOKEN_URL_OVERRIDE: `${upstream.origin}/oauth/token`,
    CODEX_CLIENT_VERSION: "0.170.0"
  });
  t.after(async () => {
    proc.child.kill();
    await upstream.close();
  });
  const port = await proc.ready;
  const origin = `http://127.0.0.1:${port}`;
  const auth = { authorization: `Bearer ${KEY}`, "content-type": "application/json" };

  assert.equal((await fetch(`${origin}/healthz`)).status, 200);
  assert.equal((await fetch(`${origin}/v1/models`)).status, 401);
  assert.equal((await fetch(`${origin}/v1/responses`, { method: "POST", headers: auth, body: "{}" })).status, 404);

  const models = await fetch(`${origin}/v1/models`, { headers: auth });
  assert.equal(models.status, 200);
  assert.equal(models.headers.get("x-codex-proxy-models-source"), "live");

  const chat = await fetch(`${origin}/v1/chat/completions`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ model: "gpt-5.5-low", stream: true, messages: [{ role: "user", content: "smoke" }] })
  });
  const chatText = await chat.text();
  assert.match(chatText, /"content":"hello"/);
  assert.match(chatText, /\[DONE\]/);

  const responsesShaped = await fetch(`${origin}/v1/chat/completions`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ model: "gpt-5.5", user: "conv-smoke", input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "smoke" }] }] })
  });
  assert.equal((await responsesShaped.json()).choices[0].message.content, "hello");

  const upstreamCalls = upstream.requests.filter((r) => r.url.endsWith("/responses"));
  assert.equal(upstreamCalls.length, 2);
  assert.equal(upstreamCalls[0].body.reasoning.effort, "low");
  assert.equal(upstreamCalls[1].headers.session_id, "conv-smoke");
  assert.match(upstreamCalls[0].headers["user-agent"], /^codex_cli_rs\/0\.170\.0 \(.+\) cursor-codex-proxy\/0\.2\.0$/);

  const log = proc.log();
  assert.ok(!log.includes(KEY) && !log.includes(access) && !log.includes("smoke\""), log);
  assert.ok(!log.includes(dir), "log shows no temp/home paths");
});

test("smoke: startup refuses a non-loopback HOST and a short key", async () => {
  for (const env of [
    { PROXY_API_KEY: KEY, HOST: "0.0.0.0", PORT: "0", CODEX_CLIENT_VERSION: "0.170.0" },
    { PROXY_API_KEY: "short", HOST: "127.0.0.1", PORT: "0", CODEX_CLIENT_VERSION: "0.170.0" }
  ]) {
    const proc = startChild({ PATH: process.env.PATH, ...env });
    await assert.rejects(proc.ready, /startup failed/);
  }
});
