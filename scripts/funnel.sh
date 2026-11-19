#!/usr/bin/env bash
# Exposes the local proxy to Cursor's cloud through Tailscale Funnel.
#
# Why this exists: Cursor sends custom-model requests from its own servers, so a
# 127.0.0.1 base URL cannot work; something public must forward to the proxy.
# Funnel gives a stable https://<machine>.<tailnet>.ts.net URL and passes SSE through.
#
# Safety rules this script enforces:
#   * uses the system `tailscale` only; it never installs or logs in for you;
#   * needs PROXY_API_KEY (>= 24 chars) from the environment or .env, and does not
#     generate one (run `npm run init` first);
#   * refuses to open the funnel unless the proxy answers /healthz on 127.0.0.1,
#     an UNauthenticated /v1/models is refused (401) and the key is accepted (200);
#   * forwards only to 127.0.0.1:$PORT, in the foreground: Ctrl-C closes the funnel.
#
# Needs: Tailscale running and logged in, MagicDNS and HTTPS certificates enabled,
# and the funnel attribute allowed for this machine in your tailnet policy.
#
#   scripts/funnel.sh                 open the funnel
#   --show-key                        also print the API key (otherwise: grep PROXY_API_KEY .env)
set -euo pipefail

cd "$(dirname "$0")/.."

SHOW_KEY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --show-key) SHOW_KEY=1; shift ;;
    -h|--help) sed -n '2,19p' "$0"; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

TAILSCALE="$(command -v tailscale || true)"
if [ -z "$TAILSCALE" ]; then
  echo "tailscale is not installed. Install it yourself; this script will not download it." >&2
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
  echo "No PROXY_API_KEY. Run npm run init, start the proxy (npm start), then run this script again." >&2
  exit 1
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

if ! "$TAILSCALE" status >/dev/null 2>&1; then
  echo "Refusing to start: Tailscale is not running or not logged in. Start it and retry." >&2
  exit 1
fi
HOSTNAME_TS="$("$TAILSCALE" status --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(s).Self.DNSName||"").replace(/\.$/,""))}catch{}})')"
if [ -z "$HOSTNAME_TS" ]; then
  echo "Could not read this machine's Tailscale DNS name. Enable MagicDNS and retry." >&2
  exit 1
fi

echo
echo "Cursor > Settings > Models:"
echo "  OpenAI API Key:            $( [ "$SHOW_KEY" = 1 ] && printf '%s' "$KEY" || printf 'the PROXY_API_KEY value in .env (grep PROXY_API_KEY .env)' )"
echo "  Override OpenAI Base URL:  https://${HOSTNAME_TS}/v1"
echo "  Models:                    add ids from /v1/models, e.g. gpt-5.5, gpt-5.5-high"
echo
echo "Anyone with this URL and the key can spend your Codex quota. Ctrl-C closes the funnel."
echo
exec "$TAILSCALE" funnel "$PORT"
