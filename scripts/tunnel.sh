#!/usr/bin/env bash
# Exposes the local proxy to Cursor's cloud through a Cloudflare tunnel.
#
# Why this exists: Cursor sends custom-model requests from its own servers, so a
# 127.0.0.1 base URL cannot work; something public must forward to the proxy.
#
# Safety rules this script enforces:
#   * uses the system `cloudflared` only (no npm download, no localtunnel);
#   * generates PROXY_API_KEY (32 random bytes) into .env (mode 0600) when none is set,
#     then stops so you can start the proxy with that key;
#   * refuses to open the tunnel unless the key is set (>= 24 chars), the proxy
#     answers /healthz on 127.0.0.1, and an UNauthenticated /v1/models is refused (401);
#   * forwards only to 127.0.0.1:$PORT.
#
# Modes:
#   scripts/tunnel.sh                 quick tunnel (random trycloudflare.com URL, new each run)
#   scripts/tunnel.sh --named NAME --hostname HOST
#                                     existing named tunnel NAME already routed to HOST
#   --show-key                        also print the API key (otherwise: grep PROXY_API_KEY .env)
#
# Quick tunnels: Cloudflare documents that they "do not support Server-Sent Events
# (SSE)", cap in-flight requests at 200 and have no uptime guarantee. Cursor streams
# chat over SSE, so expect buffered or broken streaming; use them for a connectivity
# test, and a named tunnel for real use. Restart this script (Ctrl-C, run again) to
# get a fresh URL for each session, and update the base URL in Cursor each time.
set -euo pipefail

cd "$(dirname "$0")/.."

MODE=quick
TUNNEL_NAME=""
TUNNEL_HOSTNAME=""
SHOW_KEY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --named) MODE=named; TUNNEL_NAME="${2:-}"; shift 2 ;;
    --hostname) TUNNEL_HOSTNAME="${2:-}"; shift 2 ;;
    --show-key) SHOW_KEY=1; shift ;;
    -h|--help) sed -n '2,26p' "$0"; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [ "$MODE" = named ] && { [ -z "$TUNNEL_NAME" ] || [ -z "$TUNNEL_HOSTNAME" ]; }; then
  echo "--named needs a tunnel name and --hostname" >&2
  exit 2
fi

CLOUDFLARED="$(command -v cloudflared || true)"
if [ -z "$CLOUDFLARED" ]; then
  echo "cloudflared is not installed. Install it yourself (for example: brew install cloudflared); this script will not download it." >&2
  exit 1
fi

# Read PROXY_API_KEY and PORT from the environment, else from .env (without sourcing it).
env_value() {
  [ -f .env ] || return 0
  grep -E "^$1=" .env | tail -n 1 | cut -d= -f2-
}
KEY="${PROXY_API_KEY:-$(env_value PROXY_API_KEY)}"
PORT="${PORT:-$(env_value PORT)}"
PORT="${PORT:-8787}"
case "$PORT" in *[!0-9]*|"") echo "PORT must be numeric" >&2; exit 2 ;; esac

if [ -z "$KEY" ]; then
  if [ -e .env ]; then
    echo ".env exists but has no PROXY_API_KEY. Add one (npm run init on a fresh checkout) and retry." >&2
    exit 1
  fi
  NEW_KEY="$(head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n')"
  (umask 077 && printf '# Created by scripts/tunnel.sh. Keep this file private.\nPROXY_API_KEY=%s\nHOST=127.0.0.1\nPORT=%s\n' "$NEW_KEY" "$PORT" > .env)
  echo "Generated a new PROXY_API_KEY in .env (mode 0600)."
  echo "Start the proxy with it (npm start), then run this script again."
  exit 0
fi

if [ "${#KEY}" -lt 24 ]; then
  echo "Refusing to start: PROXY_API_KEY is shorter than 24 characters." >&2
  exit 1
fi

ORIGIN="http://127.0.0.1:${PORT}"
if ! curl -fsS --max-time 3 "${ORIGIN}/healthz" >/dev/null 2>&1; then
  echo "Refusing to start: the proxy is not answering on ${ORIGIN}. Run npm start first." >&2
  exit 1
fi
UNAUTH_STATUS="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "${ORIGIN}/v1/models" || true)"
if [ "$UNAUTH_STATUS" != "401" ]; then
  echo "Refusing to start: an unauthenticated /v1/models returned ${UNAUTH_STATUS}, expected 401." >&2
  exit 1
fi
# Pass the key to curl through stdin (-H @-), never on the command line where ps can see it.
AUTH_STATUS="$(printf 'Authorization: Bearer %s\n' "$KEY" | curl -s -o /dev/null -w '%{http_code}' --max-time 10 -H @- "${ORIGIN}/v1/models" || true)"
if [ "$AUTH_STATUS" != "200" ]; then
  echo "Refusing to start: the proxy rejected this script's PROXY_API_KEY (HTTP ${AUTH_STATUS}). Is it running with the same .env?" >&2
  exit 1
fi

print_settings() {
  echo
  echo "Cursor > Settings > Models:"
  echo "  OpenAI API Key:            $( [ "$SHOW_KEY" = 1 ] && printf '%s' "$KEY" || printf 'the PROXY_API_KEY value in .env (grep PROXY_API_KEY .env)' )"
  echo "  Override OpenAI Base URL:  $1/v1"
  echo "  Models:                    add ids from /v1/models, e.g. gpt-5.5, gpt-5.5-high"
  echo
  echo "Anyone with this URL and the key can spend your Codex quota. Ctrl-C closes the tunnel."
}

if [ "$MODE" = named ]; then
  print_settings "https://${TUNNEL_HOSTNAME}"
  exec "$CLOUDFLARED" tunnel --no-autoupdate --metrics 127.0.0.1:0 run --url "$ORIGIN" "$TUNNEL_NAME"
fi

echo "Starting a quick tunnel to ${ORIGIN} (SSE is not supported on quick tunnels; see the header of this script)."
LOG="$(mktemp -t cursor-codex-tunnel.XXXXXX)"
trap 'kill "${CF_PID:-}" 2>/dev/null || true; rm -f "$LOG"' EXIT INT TERM
"$CLOUDFLARED" tunnel --no-autoupdate --metrics 127.0.0.1:0 --url "$ORIGIN" >"$LOG" 2>&1 &
CF_PID=$!

URL=""
for _ in $(seq 1 30); do
  URL="$(grep -Eo 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG" | head -n 1 || true)"
  [ -n "$URL" ] && break
  if ! kill -0 "$CF_PID" 2>/dev/null; then
    echo "cloudflared exited early:" >&2
    cat "$LOG" >&2
    exit 1
  fi
  sleep 1
done
if [ -z "$URL" ]; then
  echo "No tunnel URL after 30 s; see cloudflared output below." >&2
  cat "$LOG" >&2
  exit 1
fi

print_settings "$URL"
wait "$CF_PID"
