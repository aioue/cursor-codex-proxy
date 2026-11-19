# cursor-codex-proxy

A single-user, OpenAI-compatible proxy that lets Cursor's own chat use a ChatGPT Plus or Pro (Codex) subscription. It reads the Codex CLI's login from `~/.codex/auth.json` and forwards Cursor's requests to `chatgpt.com/backend-api/codex/responses`.

It is a hardened fork of [devteapot/codex-cursor-proxy](https://github.com/devteapot/codex-cursor-proxy) (MIT). [AUDIT.md](AUDIT.md) has the audit of that code and the reasoning behind each change. Node 22 or newer, no dependencies.

Not tested against real Cursor or the real ChatGPT backend. The test suite runs only against a mock upstream.

## Terms of service

The proxy sends `originator: codex_cli_rs`, the official CLI's identifier, so OpenAI's backend sees traffic presenting itself as Codex CLI traffic. OpenAI documents ChatGPT sign-in as access for Codex clients and Platform API keys for general API use. Whether a third-party proxy on a subscription is allowed is not confirmed. The user-agent names this proxy, and the proxy cannot produce the CLI's attestation header, so OpenAI can tell the traffic apart. Your account may be limited or banned. Read the terms that apply to you before using it.

## Setup

```bash
codex login status          # must show a ChatGPT login; else: codex login
cd ~/src/github/cursor-codex-proxy
npm run init                # writes .env (0600) with a random PROXY_API_KEY
npm test
npm start                   # listens on 127.0.0.1:8787
```

In another terminal:

```bash
scripts/tunnel.sh                                   # quick tunnel, test only
scripts/tunnel.sh --named codex --hostname codex.example.com   # named tunnel
```

The script prints what to enter in Cursor under Settings, Models: the API key (the `PROXY_API_KEY` value in `.env`), "Override OpenAI Base URL" set to `https://<tunnel host>/v1`, and the model ids to add.

## Quick tunnels and streaming

Cloudflare states that Quick Tunnels "do not support Server-Sent Events (SSE)", cap in-flight requests at 200 and have no uptime guarantee. Cursor streams chat over SSE, so expect buffered or broken replies through a quick tunnel. Use one to check connectivity, and a [named tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/) for real use.

A quick tunnel URL changes every run. Start a fresh one for each session (Ctrl-C, run `scripts/tunnel.sh` again) and update the base URL in Cursor. An old URL then stops working, which limits how long a leaked URL is useful.

## Tailscale Funnel

[Tailscale Funnel](https://tailscale.com/kb/1223/funnel) is an alternative to Cloudflare. It gives a stable `https://<machine>.<tailnet>.ts.net` URL, so there is nothing to update in Cursor between sessions, and it passes SSE through.

1. `npm run init`, then `npm start`.
2. Start Tailscale. MagicDNS, HTTPS certificates and the funnel attribute for this machine must be enabled in your tailnet; if Funnel refuses to start, check the admin console.
3. `scripts/funnel.sh`. It runs the same checks as `scripts/tunnel.sh` (key present, proxy healthy, unauthenticated request refused), prints the Cursor settings, and runs `tailscale funnel` in the foreground. Ctrl-C closes it.

The proxy binds to loopback and Funnel forwards to it locally, so no proxy change is needed. The URL is public and stays the same, so the only protection is `PROXY_API_KEY`. Keep it long and private, and close the funnel when you are not using it. Funnel relays encrypted traffic and TLS ends on your own machine, so the relay servers do not see it in clear.

## Threat model

Cursor calls custom models from its own servers, so the proxy has to be reachable from the internet. Through the tunnel:

- Cursor's cloud sees every prompt, every file Cursor attaches, every response, and the proxy key. Treat it as you would sending code to any hosted model provider.
- Anyone holding the tunnel URL and the key can spend your Codex quota. Nothing else is reachable: the key is checked on every route except `GET /healthz`, and any other path gets a 404 without the body being read.
- The Codex access and refresh tokens never leave the machine. Cursor only ever sees `PROXY_API_KEY`.
- Cloudflare terminates TLS and can see traffic in clear. With Funnel, TLS ends on your machine.

Local guarantees:

- Binds to loopback only. `HOST=0.0.0.0` or any other address is refused at startup.
- The key comes only from the environment and must be 24 characters or more. Comparison is constant time.
- No CORS headers, so a web page in your browser cannot read proxy responses.
- Logs hold method, route, status, timing, model, reasoning effort, token counts and dropped field names from a fixed list. Never bodies, headers, prompts or tokens. Everything logged has control characters removed and the home directory shown as `~`. Unmatched paths are logged as a count per minute, never by name.
- Writes to `auth.json` go through a temp file with mode 0600, fsync and rename.

Rotate the key by changing `PROXY_API_KEY` in `.env`, restarting the proxy, and updating Cursor.

## Token refresh and the Codex CLI

Do not run the Codex CLI while the proxy is in use. ChatGPT refresh tokens are single use. When one process refreshes, the other process's copy is spent, and the next refresh from that process fails with `refresh_token_reused` until you run `codex login` again.

The proxy reduces that risk without removing it:

- It uses the access token in `auth.json` until 30 s before expiry. The CLI refreshes 5 minutes before expiry, so a running CLI normally refreshes first and the proxy picks up the new token by re-reading the file.
- Before spending a refresh token it re-reads the file. Before writing, it checks that the refresh token on disk is still the one it used, and leaves the file alone if not.
- An upstream 401 never forces a refresh of a token that has not expired. The proxy re-reads the file, retries if the token changed, and otherwise answers 401 with "Run `codex login`".
- `CODEX_PROXY_REFRESH=never` stops the proxy from refreshing at all. Running any `codex` command then refreshes the login.

The CLI also locks `$CODEX_HOME/auth.lock` with `flock` while writing. Node cannot take that lock without native code, so a narrow race remains.

## Wire formats

`POST /v1/chat/completions` accepts both bodies Cursor sends:

- Chat Completions (`messages`): system messages become `instructions`; `image_url` parts become `input_image`; assistant `tool_calls` become `function_call` items and `tool` messages become `function_call_output`, keeping the call ids.
- Responses-shaped (`input`): system items are moved to `instructions`; nested `tools[].function` definitions are flattened; Cursor's `custom` grammar tools (ApplyPatch) pass through.

In both, `stream_options`, `store`, `temperature`, `prompt_cache_options`, `client_metadata` and other unsupported fields are dropped. `user` becomes `prompt_cache_key`, also sent as the `session_id` header. The reply is always Chat Completions: SSE chunks when `stream` is true, a single JSON object otherwise, with usage (including cached and reasoning tokens) when the backend reports it.

Upstream `response.failed` and `error` events become an OpenAI-style error event in the stream, with no `[DONE]`, or an HTTP error status for non-streaming requests. `response.incomplete` maps to `finish_reason: "length"` or `"content_filter"`. A stream that ends without a final event is reported as `upstream_truncated`.

## Models and suffixes

`GET /v1/models` lists the live Codex catalog (cached 5 minutes). If that fails it reads the CLI's `~/.codex/models_cache.json`, then a built-in list. The `x-codex-proxy-models-source` response header says which: `live`, `cache`, `builtin` or `configured`.

Each model is also listed with `-low`, `-high` and `-xhigh` suffixes (`CODEX_PROXY_MODEL_VARIANTS`). A suffix sets reasoning effort; `-fast` or `-priority` sets `service_tier: priority`. They combine: `gpt-5.5-xhigh-fast`. Without a suffix, effort is `medium` and no service tier is sent. A `service_tier` sent by the client is ignored, because priority uses quota faster.

## Configuration

See `.env.example`. The main settings:

| Variable | Default | Purpose |
|----------|---------|---------|
| `PROXY_API_KEY` | required | Key Cursor sends; 24+ characters |
| `PORT` | `8787` | Loopback port |
| `DEFAULT_REASONING_EFFORT` | `medium` | Effort when the model id has no suffix |
| `DEFAULT_SERVICE_TIER` | unset | `priority` opts every request into fast mode |
| `CODEX_PROXY_REFRESH` | `expired` | `never` leaves refresh to the CLI |
| `CODEX_PROXY_MODELS` | live catalog | Fixed model list |
| `QUOTA_LOG` | `0` | `1` logs 5h and weekly usage, at most once per `QUOTA_LOG_INTERVAL_MS` (minimum 60 s, default 5 min) |
| `CODEX_USER_AGENT` | see AUDIT.md | One user-agent for every upstream call |
| `CODEX_CLIENT_VERSION` | `codex --version` | Version in the UA and the models query |

The quota line uses the `x-codex-*-used-percent` headers on normal responses when present. Otherwise it calls `backend-api/wham/usage` with the same headers as every other call.

## Borrowed ideas

Code is from devteapot/codex-cursor-proxy (MIT): SSE parser, auth file handling, key check, Chat Completions conversion, all extended. Everything else was written for this fork. Ideas taken from other projects, re-implemented without copying:

| Idea | From |
|------|------|
| Accept Responses-shaped bodies on `/v1/chat/completions`; Cursor's request shape | hweihwang/cursor-codex-local (MIT, fixture used as a format reference), moeelbadri/codex-cursor |
| `user` to `prompt_cache_key`, mirrored into the `session_id` header | moeelbadri/codex-cursor |
| `models_cache.json` fallback for `/v1/models` | moeelbadri/codex-cursor |
| 5h and weekly quota line from `wham/usage` | moeelbadri/codex-cursor |
| Custom tool calls mapped to Chat Completions tool calls | moeelbadri/codex-cursor, hweihwang/cursor-codex-local |
| Header formats (UA layout, routing hint, rate-limit headers, refresh window) | openai/codex source |

moeelbadri/codex-cursor and ephraimduncan/codex-cursor have no licence file, so nothing was copied from them.

Not taken: a per-process random installation id, npm-downloaded or localtunnel tunnels, request introspection logs, the `/v1/responses` route, and devteapot's LaunchAgent installers.

## Development

```bash
npm test                   # node --test, mock upstream only
node --test test/smoke.test.js
npm run check              # node --check, bash -n, tests
```
