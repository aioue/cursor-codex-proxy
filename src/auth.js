import { readFile } from "node:fs/promises";
import { HttpError } from "./errors.js";
import { atomicWriteJson, fileSignature } from "./fsutil.js";
import { silentLogger } from "./log.js";

// Public OAuth client id of the Codex CLI (CLIENT_ID in codex-rs/login/src/auth/manager.rs).
const OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const DEFAULT_TOKEN_URL = "https://auth.openai.com/oauth/token";
const REFRESH_TIMEOUT_MS = 45_000; // matches the CLI's token endpoint timeout
// After a failed refresh, do not try again until auth.json changes on disk
// (the user ran codex login, or the CLI refreshed) or this long has passed.
// Each failed attempt is a request to auth.openai.com with a dead token.
export const REFRESH_FAILURE_BACKOFF_MS = 10 * 60 * 1000;
const LOGIN_HINT = "Run `codex login` on the machine running the proxy, then retry.";

function decodeJwtPayload(token) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function tokenExpiresSoon(token, now, skewMs) {
  const exp = decodeJwtPayload(token)?.exp;
  if (!Number.isFinite(exp)) return false;
  return exp * 1000 <= now() + skewMs;
}

function accountIdFrom(data) {
  const direct = data?.tokens?.account_id;
  if (typeof direct === "string" && direct) return direct;

  for (const token of [data?.tokens?.access_token, data?.tokens?.id_token]) {
    const payload = decodeJwtPayload(token);
    const auth = payload?.["https://api.openai.com/auth"];
    const accountId = auth?.chatgpt_account_id
      ?? payload?.["https://api.openai.com/auth.chatgpt_account_id"]
      ?? payload?.chatgpt_account_id;
    if (typeof accountId === "string" && accountId) return accountId;
  }
  return null;
}

// All auth-state problems surface to the client as 401 with a `codex login` hint.
// The messages never contain the auth file path or any token material.
function authError(message, code) {
  return new HttpError(401, `${message} ${LOGIN_HINT}`, code, "authentication_error");
}

async function readAuthFile(path) {
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") throw authError("No Codex login was found.", "codex_auth_missing");
    throw error;
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw authError("The Codex auth file is not valid JSON.", "codex_auth_invalid");
  }
}

export { atomicWriteJson };

class LostRace extends Error {}

// One instance per process (buildServer creates exactly one).
//
// Default policy, CODEX_PROXY_REFRESH=never: the proxy never spends a refresh
// token. ChatGPT refresh tokens are single use, and the Codex CLI is the only
// process that should rotate them. The proxy re-reads auth.json on every
// request and, once the access token is within refreshSkewMs of expiry,
// answers 401 "run codex login" (any codex command refreshes the login).
//
// CODEX_PROXY_REFRESH=auto keeps the old refresh path:
//  1. Use the access token from auth.json while it is not within refreshSkewMs of expiry.
//  2. Near expiry, re-read auth.json first: a running Codex CLI refreshes earlier
//     (5 min window) and the proxy then just picks up its new token.
//  3. Only if the file still holds the stale token, spend the refresh token.
//     Concurrent callers share one in-flight refresh.
//  4. Before writing, re-read and compare the refresh token we used
//     (compare-and-swap, like the CLI's persist_tokens), then compare the file
//     signature (mtime, size, inode) once more immediately before rename. If
//     another writer touched the file, its version wins and a loud warning says
//     the newly issued refresh token was not saved.
//  5. After a failed refresh, no new attempt until auth.json changes or
//     REFRESH_FAILURE_BACKOFF_MS passes.
// Upstream 401s never refresh anything: they re-read the file and replay once
// only if the token on disk changed.
//
// Residual race: the CLI serialises its writes with flock on $CODEX_HOME/auth.lock
// and Node has no flock, so a CLI write landing between the last signature check
// and rename() is still overwritten. The window is a few syscalls wide.
export class CodexAuth {
  #inflight = null;
  #refreshFailure = null; // { at, signature }

  constructor({
    authFile,
    refreshSkewMs = 30_000,
    refreshMode = "never",
    tokenUrl = DEFAULT_TOKEN_URL,
    clientId = OAUTH_CLIENT_ID,
    baseHeaders = {},
    staticAccessToken,
    staticAccountId,
    fetchImpl = globalThis.fetch,
    now = Date.now,
    logger = silentLogger,
    readAuth = readAuthFile,
    beforeRename // test hook, passed to atomicWriteJson after the proxy's own check
  }) {
    this.authFile = authFile;
    this.refreshSkewMs = refreshSkewMs;
    this.refreshMode = refreshMode === "expired" ? "auto" : refreshMode;
    this.tokenUrl = tokenUrl;
    this.clientId = clientId;
    this.baseHeaders = baseHeaders;
    this.staticAccessToken = staticAccessToken;
    this.staticAccountId = staticAccountId;
    this.fetch = fetchImpl;
    this.now = now;
    this.logger = logger;
    this.readAuth = readAuth;
    this.beforeRenameHook = beforeRename;
  }

  #credentials(data) {
    const accessToken = data?.tokens?.access_token;
    if (typeof accessToken !== "string" || !accessToken) {
      throw authError("The Codex auth file does not contain a ChatGPT access token.", "codex_auth_mode_unsupported");
    }
    const accountId = accountIdFrom(data);
    if (!accountId) throw authError("The Codex login does not identify a ChatGPT workspace.", "codex_account_missing");
    return { accessToken, accountId };
  }

  #fresh(data) {
    const token = data?.tokens?.access_token;
    return typeof token === "string" && token !== "" && !tokenExpiresSoon(token, this.now, this.refreshSkewMs);
  }

  async getCredentials() {
    if (this.staticAccessToken) {
      const accountId = this.staticAccountId || accountIdFrom({ tokens: { access_token: this.staticAccessToken } });
      if (!accountId) throw authError("CODEX_ACCOUNT_ID is required with CODEX_ACCESS_TOKEN.", "codex_account_missing");
      return { accessToken: this.staticAccessToken, accountId };
    }
    const data = await this.readAuth(this.authFile);
    if (this.#fresh(data)) return this.#credentials(data);
    return this.#refreshOnce();
  }

  // Called after the upstream answered 401 for `usedAccessToken`. Returns new
  // credentials only when auth.json now holds a different, unexpired token
  // (the caller may replay once); otherwise throws. Never refreshes.
  async onUnauthorized(usedAccessToken) {
    if (this.staticAccessToken) throw authError("ChatGPT rejected CODEX_ACCESS_TOKEN.", "codex_auth_rejected");
    const latest = await this.readAuth(this.authFile);
    if (latest?.tokens?.access_token !== usedAccessToken && this.#fresh(latest)) {
      return this.#credentials(latest);
    }
    throw authError("ChatGPT rejected the Codex access token.", "codex_auth_rejected");
  }

  #refreshOnce() {
    if (!this.#inflight) {
      this.#inflight = this.#performRefresh().finally(() => {
        this.#inflight = null;
      });
    }
    return this.#inflight;
  }

  async #recordFailure() {
    this.#refreshFailure = { at: this.now(), signature: await fileSignature(this.authFile).catch(() => "unknown") };
  }

  async #performRefresh() {
    const latest = await this.readAuth(this.authFile);
    if (this.#fresh(latest)) return this.#credentials(latest);

    if (this.refreshMode !== "auto") {
      throw authError("The Codex access token has expired. The proxy does not refresh logins (CODEX_PROXY_REFRESH=never); running any `codex` command refreshes it.", "codex_auth_expired");
    }
    const refreshToken = latest?.tokens?.refresh_token;
    if (typeof refreshToken !== "string" || !refreshToken) {
      throw authError("The Codex login cannot be refreshed.", "codex_refresh_missing");
    }
    if (this.#refreshFailure) {
      const signature = await fileSignature(this.authFile).catch(() => "unknown");
      const recent = this.now() - this.#refreshFailure.at < REFRESH_FAILURE_BACKOFF_MS;
      if (recent && signature === this.#refreshFailure.signature) {
        throw authError("The last Codex token refresh failed; the proxy will not retry until auth.json changes.", "codex_refresh_backoff");
      }
      this.#refreshFailure = null;
    }

    let response;
    try {
      response = await this.fetch(this.tokenUrl, {
        method: "POST",
        headers: { ...this.baseHeaders, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ client_id: this.clientId, grant_type: "refresh_token", refresh_token: refreshToken }),
        signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS)
      });
    } catch {
      await this.#recordFailure();
      // Transient: do not tell the user to log in again for a network blip.
      throw new HttpError(503, "Codex token refresh could not reach the authentication service.", "codex_refresh_unavailable", "upstream_error");
    }

    if (!response.ok) {
      let reason = "";
      try {
        const body = await response.json();
        reason = typeof body?.error === "string" ? body.error : body?.error?.code ?? "";
      } catch {
        // ignore unparseable bodies
      }
      // Another process may have rotated the token while we tried (refresh_token_reused).
      const after = await this.readAuth(this.authFile).catch(() => null);
      if (after && after.tokens?.refresh_token !== refreshToken && this.#fresh(after)) {
        return this.#credentials(after);
      }
      await this.#recordFailure();
      this.logger.warn("codex token refresh failed", { status: response.status, reason: /^[a-z_]{1,64}$/.test(reason) ? reason : undefined });
      throw authError("The Codex login has expired or was revoked.", "codex_refresh_failed");
    }

    let refreshed;
    try {
      refreshed = await response.json();
    } catch {
      refreshed = null;
    }
    if (typeof refreshed?.access_token !== "string" || !refreshed.access_token) {
      await this.#recordFailure();
      throw new HttpError(502, "The authentication service returned an invalid refresh response.", "codex_refresh_invalid", "upstream_error");
    }
    const issuedNewRefreshToken = typeof refreshed.refresh_token === "string" && refreshed.refresh_token && refreshed.refresh_token !== refreshToken;
    const lostRace = async () => {
      // Never silent: the token endpoint has already rotated the refresh token,
      // so whichever copy is not on disk is now dead.
      this.logger.warn(issuedNewRefreshToken
        ? "LOST AUTH RACE: auth.json changed while the proxy was saving a refreshed login. The refresh token just issued to the proxy was NOT saved and is discarded. If codex later reports refresh_token_reused, run codex login."
        : "auth.json changed while the proxy was saving a refreshed login; keeping the other writer's file");
      const now = await this.readAuth(this.authFile).catch(() => null);
      if (now && this.#fresh(now)) return this.#credentials(now);
      return this.#credentials({ tokens: { ...now?.tokens, access_token: refreshed.access_token } });
    };

    const signature = await fileSignature(this.authFile);
    const current = await this.readAuth(this.authFile);
    if (current?.tokens?.refresh_token !== refreshToken || (await fileSignature(this.authFile)) !== signature) {
      return lostRace();
    }

    current.tokens.access_token = refreshed.access_token;
    if (typeof refreshed.id_token === "string" && refreshed.id_token) current.tokens.id_token = refreshed.id_token;
    if (issuedNewRefreshToken) current.tokens.refresh_token = refreshed.refresh_token;
    current.last_refresh = new Date(this.now()).toISOString();
    try {
      await atomicWriteJson(this.authFile, current, {
        beforeRename: async (tempPath) => {
          if (this.beforeRenameHook) await this.beforeRenameHook(tempPath);
          if ((await fileSignature(this.authFile)) !== signature) throw new LostRace();
        }
      });
    } catch (error) {
      if (error instanceof LostRace) return lostRace();
      throw error;
    }
    this.#refreshFailure = null;
    this.logger.info("codex token refreshed");
    return this.#credentials(current);
  }
}

export const authInternals = { accountIdFrom, decodeJwtPayload, tokenExpiresSoon };
