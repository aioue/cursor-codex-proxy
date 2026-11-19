import { once } from "node:events";
import { join } from "node:path";
import { buildServer } from "../src/server.js";
import { captureLogger, jwt, tempAuth } from "./helpers.js";
import { startMockUpstream } from "./mock-upstream.js";

export const KEY = "test-proxy-api-key-that-is-long-enough-123";
export const SECRET_MARKER = "PROMPT-CONTENT-THAT-MUST-NOT-BE-LOGGED";
export const auth = { authorization: `Bearer ${KEY}` };
export const json = { "content-type": "application/json" };
export const chatBody = (extra = {}) => JSON.stringify({ model: "gpt-5.5", messages: [{ role: "user", content: SECRET_MARKER }], ...extra });

// Test config: every limit that would slow the suite down is relaxed unless a
// test overrides it. The state file always lives in the temp dir, never in ~.
export function testConfig(dir, upstream, overrides = {}) {
  return {
    host: "127.0.0.1",
    port: 0,
    apiKey: KEY,
    authFile: join(dir, "auth.json"),
    modelsCacheFile: join(dir, "models_cache.json"),
    stateFile: join(dir, "state", "state.json"),
    upstreamBaseUrl: upstream.baseUrl,
    tokenUrl: `${upstream.origin}/oauth/token`,
    clientVersion: "0.170.0",
    originator: "codex_cli_rs",
    userAgent: "codex_cli_rs/0.170.0 (Test OS 1; arm64) cursor-codex-proxy/test",
    configuredModels: [],
    modelVariants: ["high"],
    defaultReasoningEffort: "medium",
    defaultServiceTier: undefined,
    refreshMode: "never",
    refreshSkewMs: 30_000,
    quotaLog: false,
    quotaUsageFetch: false,
    quotaIntervalMs: 60_000,
    maxConcurrentRequests: 0,
    maxQueueWaitMs: 60_000,
    rateLimitPerMinute: 0,
    minRequestSpacingMs: 0,
    dailyRequestLimit: 0,
    dailyWarnPercent: 80,
    breakerOpenAfter: 3,
    breakerMaxBackoffMs: 60_000,
    maxRequestBytes: 1024 * 1024,
    requestTimeoutMs: 10_000,
    streamIdleTimeoutMs: 10_000,
    drainTimeoutMs: 5_000,
    socketIdleTimeoutMs: 30_000,
    firstEventWaitMs: 2_000,
    keepAliveMs: 0,
    ...overrides
  };
}

export async function startProxy({ handlers, configOverrides = {}, authTokens, dir: existingDir, now, random } = {}) {
  const upstream = await startMockUpstream(handlers);
  const access = jwt({ exp: Math.floor(Date.now() / 1000) + 3600, "https://api.openai.com/auth": { chatgpt_account_id: "acct_test" } });
  let dir = existingDir;
  if (!dir) ({ dir } = await tempAuth(authTokens ?? { access_token: access, refresh_token: "rt-fake", account_id: "acct_test" }));
  const config = testConfig(dir, upstream, configOverrides);
  const { lines, logger } = captureLogger();
  const server = buildServer(config, { logger, ...(now ? { now } : {}), ...(random ? { random } : {}) });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    upstream, origin, lines, dir, access, config, server, state: server.proxyState,
    responses: () => upstream.requests.filter((r) => r.url.endsWith("/codex/responses")),
    chat: (extra = {}, headers = {}) => fetch(`${origin}/v1/chat/completions`, { method: "POST", headers: { ...auth, ...json, ...headers }, body: chatBody(extra) }),
    close: async () => {
      server.closeAllConnections?.();
      server.close();
      await upstream.close();
    }
  };
}
