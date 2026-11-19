# Audit of devteapot/codex-cursor-proxy

Audited commit `4666288` ("Allow unlimited proxy concurrency", 2026-08-30), the head of `main` on 2026-11-19. All 21 files were read: `package.json`, `.env.example`, `.gitignore`, `LICENSE`, `README.md`, `src/{auth,config,errors,server,sse,translate,upstream}.js`, `scripts/{init,service,tunnel-service}.mjs`, `test/{auth,server,service,sse,translate,tunnel-service}.test.js`. Citations are `file:line` in that commit. Facts about the real Codex CLI were checked against `openai/codex` at `b9559ff737` (2026-11-19).

## Verdict

Nothing malicious. No runtime or dev dependencies, no install scripts, no telemetry, no `eval`, no network destinations other than `chatgpt.com` and `auth.openai.com`. Child processes are limited to `codex --version`, `launchctl`, `which`, `pbpaste` and `cloudflared`. The flaws below are fixable with modest changes, so the build gate passed. The most serious are a functional one (Cursor's Responses-shaped bodies on `/v1/chat/completions` lose the whole conversation) and a token-safety one (any upstream 401 force-rotates the refresh token, which can log out a running Codex CLI).

## Findings

Severity: H high, M medium, L low, OK means the property holds.

| # | Sev | Area | Finding | Fix in this fork |
|---|-----|------|---------|------------------|
| 1 | H | Wire format | `chatToResponsesRequest` reads only `body.messages` (`src/translate.js:58`). Cursor sends `input` arrays to `/v1/chat/completions` for Codex models (fixture in hweihwang/cursor-codex-local `tests/fixtures/cursor-responses-request.json`). Those requests become a single empty user message (`src/translate.js:91-93`): the model answers a blank prompt. | `toResponsesRequest` accepts both shapes |
| 2 | H | Token race | On any upstream 401, `#request` calls `getCredentials({ forceRefresh: true })` (`src/upstream.js:41-43`), and `force` skips the freshness re-check (`src/auth.js:122-126`). An unexpired token is rotated, which invalidates the refresh token held in memory by a running CLI (the CLI then fails with `refresh_token_reused`, `codex-rs/login/src/auth/manager.rs:1870`). | 401 re-reads `auth.json`, retries if the token changed, refreshes only if expired, otherwise returns 401 "run `codex login`" |
| 3 | M | Token race | No compare-and-swap before writing (`src/auth.js:157-165`): if another writer rotated the token during the refresh request, its newer tokens are overwritten. The CLI checks the stored refresh token before persisting (`manager.rs` `persist_tokens`) and holds `flock` on `$CODEX_HOME/auth.lock` (`codex-rs/login/src/auth/storage.rs:195-212`). | CAS on refresh token before write; Node has no `flock`, so the residual race is documented |
| 4 | M | Token race | Refresh skew 5 min (`src/config.js:69`) equals the CLI's own window (`manager.rs:233`), so both race to refresh at the same moment. | Default skew 30 s: the CLI normally refreshes first and the proxy re-reads |
| 5 | M | Errors | `response.failed`/`error` throw after headers are sent; the handler just calls `response.end()` (`src/server.js:177-178`, `src/translate.js:215-218`). Cursor sees a short stream with no error and no `[DONE]`. `response.incomplete` is not handled at all. | Streamed OpenAI-style error event; `incomplete` maps to `length`/`content_filter` or an error |
| 6 | M | Tools | Only nested `function` tools survive (`src/translate.js:39`). Cursor's `custom` grammar tool (ApplyPatch) is dropped, and `custom_tool_call` output events are ignored (`src/translate.js:182`). Object `tool_choice` collapses to `auto` (`src/translate.js:49-52`). | Custom tools and calls pass through; object `tool_choice` mapped |
| 7 | M | Models | `/v1/models` calls upstream on every request with no cache and fails the request if upstream is down (`src/server.js:136-138`). | Live, then `models_cache.json`, then built-in, 5 min cache |
| 8 | M | Cost | Default reasoning effort `high` (`src/config.js:65`, `scripts/init.mjs:18`); client `service_tier` forwarded unchecked (`src/translate.js:246`), so a client can opt into priority. | Default `medium`; tier only via model suffix or env |
| 9 | M | Cancellation | Upstream abort hangs off `request.once("aborted")` (`src/server.js:125`). `aborted` is deprecated and is not guaranteed to fire once the body has been fully read, which is the case during the stream relay, so a client disconnect may leave the upstream request running and spending quota (not reproduced; fixed defensively). | Abort on `response` `close` before finish |
| 10 | L | Logging | 5xx log line prints `error.message` unsanitised (`src/server.js:187`); upstream text (`src/upstream.js:11`) can carry newlines or ANSI. Startup prints the absolute auth path (`src/server.js:207`). | All log output sanitised; home dir shown as `~` |
| 11 | L | Binding | `HOST` env accepted without checks (`src/config.js:58`); `HOST=0.0.0.0` exposes the proxy on the LAN. | Non-loopback hosts refused at startup |
| 12 | L | Config | `CODEX_REFRESH_TOKEN_URL_OVERRIDE` (`src/auth.js:135`) accepts any URL, including plain http. Same variable name as the CLI's override, so it is not a backdoor, but a stray value sends the refresh token elsewhere. | https required unless loopback |
| 13 | L | Robustness | `response.json()` on the refresh response is unguarded (`src/auth.js:152`); a non-JSON 200 gives a generic 500. Refresh fetch has no timeout. | Guarded, 45 s timeout (CLI's value) |
| 14 | L | Fingerprint | Sends `originator: codex_cli_rs` (`src/config.js:70`) but `user-agent: codex-cursor-proxy/0.1.0 codex/<ver>` (`src/upstream.js:28`), a mix that matches neither the CLI nor an honest client. Version comes from running `codex` on PATH (`src/config.js:25-34`), fallback `0.1.0`. Token refresh sends no UA or originator. | One UA on every call, including refresh; see below |
| 15 | L | Atomic write | Temp file `wx` + 0600 + rename + chmod (`src/auth.js:58-70`) is correct but has no `fsync`, and the temp name is predictable (pid + ms). `wx` prevents symlink following, so this is durability, not security. | fsync file and dir, random temp name |
| 16 | L | Tests | 14 tests, all mocked. No test for auth on any route other than `GET /v1/models` (`test/server.test.js:75-82`), no error-event, race or log-content tests. | 50 tests including those |
| 17 | info | Tunnel | Its README already says quick tunnels "do not support Server-Sent Events" (`README.md:146-151`). Cloudflare's TryCloudflare page (checked 2026-11-19) confirms: "Quick Tunnels do not support Server-Sent Events (SSE)", 200 in-flight request cap, no uptime guarantee. This undercuts the quick-tunnel plan for streaming chat. | Tunnel helper warns and supports a named tunnel |

Properties that hold and were kept:

| Property | Where |
|----------|-------|
| `PROXY_API_KEY` required, at least 24 chars, env only | `src/config.js:52-55` |
| Constant-time compare: SHA-256 of both sides then `timingSafeEqual`, so length is not leaked and the call cannot throw | `src/server.js:15-22` |
| Auth on every route except `GET /healthz` | `src/server.js:128-134` |
| Loopback default bind | `src/config.js:58` |
| Re-read `auth.json` before refreshing, single in-flight refresh per process | `src/auth.js:110-126` |
| `store: false`, `stream: true` forced upstream; field allowlist for `/v1/responses` | `src/translate.js:243-261` |
| No CORS headers at all (browsers cannot read responses cross-origin) | `src/server.js` (none emitted) |
| No request-body, header or token logging | `src/server.js:186-188` |
| 5xx messages masked from the client | `src/errors.js:20` |
| Request size cap, request timeout | `src/server.js:34-51`, `src/server.js:124` |
| Codex token never returned to the client | whole codebase |

Not adopted from devteapot: `/v1/responses` (outside the requested path allowlist), the LaunchAgent installers (`scripts/service.mjs`, `scripts/tunnel-service.mjs`; useful, but out of scope and they install under the author's `com.carlid` label), and the clipboard token import.

## Fingerprint reasoning

What the real CLI sends (openai/codex `b9559ff737`):

- `originator: codex_cli_rs` and `user-agent: codex_cli_rs/<version> (<os> <os version>; <arch>) <terminal>` on every request (`codex-rs/login/src/auth/default_client.rs:152-178, 493-497`).
- `x-codex-routing-hint: model=<m>` or `model=<m>;tier=<t>` (`codex-rs/core/src/client.rs:1573-1574`).
- A `session_id` header that drives cache affinity (`client.rs:812-816`).
- A persistent installation id, created once in `$CODEX_HOME/installation_id` (mode 0644) and sent in `client_metadata["x-codex-installation-id"]` (`codex-rs/runtime-agent-instance/src/installation_id.rs`, `codex-rs/core/tests/responses_headers.rs:198`).
- Turn-state, turn-metadata, window-id headers, and an attestation header (`X_OAI_ATTESTATION_HEADER`, `client.rs:1186-1197`) when the provider supports it.

Choices here:

- Originator stays `codex_cli_rs`. The backend appears to require it for subscription traffic; that is the impersonation the README's ToS section discusses.
- One user-agent, built once at startup and used for responses, models, usage and token refresh. It keeps the CLI layout (`codex_cli_rs/<ver> (<os> <release>; <arch>)`) but the terminal slot says `cursor-codex-proxy/<ver>`, so the proxy is identifiable in OpenAI's logs rather than posing as a terminal session. `CODEX_USER_AGENT` overrides it.
- No installation id. The CLI does not use a per-process random id (it persists one), so inventing one per process would be a fingerprint no real client has. Reusing the CLI's file would tie proxy traffic to that installation. Omitting it is the least misleading option.
- `session_id` is sent only when the request has a `prompt_cache_key` (from Cursor's `user`), and equals it, mirroring the CLI's coupling of the two. Nothing is invented when Cursor sends no key.
- No attestation, turn-state or window headers. The proxy cannot produce a valid attestation, so OpenAI can tell this traffic from the CLI regardless of headers.
- Routing hint follows the CLI format including `;tier=`.

## Other forks consulted (concepts only)

| Repo | Licence file | Used for |
|------|--------------|----------|
| moeelbadri/codex-cursor | none (package.json says MIT) | idea only: `user` to `prompt_cache_key`, mirrored `session_id`, `models_cache.json` fallback, 5h/weekly quota line; re-implemented, no code copied |
| ephraimduncan/codex-cursor | none (package.json says MIT) | not used |
| hweihwang/cursor-codex-local | MIT | Cursor request fixture (format reference), custom tool handling idea |
| Ungate | not inspected | brief mentions it; no source available here |

Rejected from forks: per-process random `x-codex-installation-id` (moeelbadri `src/upstream.ts:87`, sends `session_id` too but its quota call omits the UA and originator: `src/quota.ts:28-33`), websocket transports, request/response introspection logs.
