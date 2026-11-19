import { randomBytes } from "node:crypto";
import { chmod, open, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { HttpError } from "./errors.js";
import { silentLogger } from "./log.js";

// Public OAuth client id of the Codex CLI (CLIENT_ID in codex-rs/login/src/auth/manager.rs).
const OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const DEFAULT_TOKEN_URL = "https://auth.openai.com/oauth/token";
const REFRESH_TIMEOUT_MS = 45_000; // matches the CLI's token endpoint timeout
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

// Write-to-temp, fsync, rename, chmod 0600, then fsync the directory. Readers
// (including a running Codex CLI) see either the old or the new document,
// never a truncated one. The temp name is random and opened with O_EXCL ("wx"),
// so a pre-planted file or symlink at that name makes the write fail instead of
// being followed.
export async function atomicWriteJson(path, value) {
  const directory = dirname(path);
  const tempPath = join(directory, `.${basename(path)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  let handle;
  try {
    handle = await open(tempPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(tempPath, path);
    await chmod(path, 0o600);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await unlink(tempPath).catch(() => {});
    throw error;
  }
  try {
    const dir = await open(directory, "r");
    await dir.sync().catch(() => {});
    await dir.close();
  } catch {
    // Directory fsync is best effort (not supported everywhere).
  }
}

// One instance per process (buildServer creates exactly one). Refresh policy:
//  1. Use the access token from auth.json while it is not within refreshSkewMs of expiry.
//  2. Near expiry, re-read auth.json first: a running Codex CLI refreshes earlier
//     (5 min window) and the proxy then just picks up its new token.
//  3. Only if the file still holds the stale token, and refreshMode is "expired",
//     spend the refresh token. Concurrent callers share one in-flight refresh.
//  4. Before writing, re-read again and compare the refresh token we used
//     (compare-and-swap, like the CLI's persist_tokens). If another process rotated
//     it meanwhile, its file wins and nothing is overwritten.
//  5. Upstream 401s never force-refresh an unexpired token: they re-read the file,
//     retry once if the token changed, and otherwise tell the user to run `codex login`.
// The CLI serialises its own writes with flock on $CODEX_HOME/auth.lock; Node has no
// flock, so step 4 narrows but cannot fully close the race. Hence the README advice
// not to run the CLI and the proxy at the same time.
export class CodexAuth {
  #inflight = null;

  constructor({
    authFile,
    refreshSkewMs = 30_000,
    refreshMode = "expired",
    tokenUrl = DEFAULT_TOKEN_URL,
    clientId = OAUTH_CLIENT_ID,
    baseHeaders = {},
    staticAccessToken,
    staticAccountId,
    fetchImpl = globalThis.fetch,
    now = Date.now,
    logger = silentLogger,
    readAuth = readAuthFile // injectable for race tests
  }) {
    this.authFile = authFile;
    this.refreshSkewMs = refreshSkewMs;
    this.refreshMode = refreshMode;
    this.tokenUrl = tokenUrl;
    this.clientId = clientId;
    this.baseHeaders = baseHeaders;
    this.staticAccessToken = staticAccessToken;
    this.staticAccountId = staticAccountId;
    this.fetch = fetchImpl;
    this.now = now;
    this.logger = logger;
    this.readAuth = readAuth;
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

  // Called after the upstream answered 401 for `usedAccessToken`.
  async onUnauthorized(usedAccessToken) {
    if (this.staticAccessToken) throw authError("ChatGPT rejected CODEX_ACCESS_TOKEN.", "codex_auth_rejected");
    const latest = await this.readAuth(this.authFile);
    if (latest?.tokens?.access_token !== usedAccessToken && this.#fresh(latest)) {
      return this.#credentials(latest);
    }
    if (!this.#fresh(latest)) return this.#refreshOnce();
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

  async #performRefresh() {
    const latest = await this.readAuth(this.authFile);
    if (this.#fresh(latest)) return this.#credentials(latest);

    if (this.refreshMode === "never") {
      throw authError("The Codex access token has expired and CODEX_PROXY_REFRESH=never. Running any `codex` command refreshes it.", "codex_auth_expired");
    }
    const refreshToken = latest?.tokens?.refresh_token;
    if (typeof refreshToken !== "string" || !refreshToken) {
      throw authError("The Codex login cannot be refreshed.", "codex_refresh_missing");
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
      throw new HttpError(502, "The authentication service returned an invalid refresh response.", "codex_refresh_invalid", "upstream_error");
    }

    const current = await this.readAuth(this.authFile);
    if (current?.tokens?.refresh_token !== refreshToken) {
      // Lost the race to another writer. Keep its file untouched.
      this.logger.warn("auth.json changed during refresh; keeping the other writer's tokens");
      if (this.#fresh(current)) return this.#credentials(current);
      return this.#credentials({ tokens: { ...current?.tokens, access_token: refreshed.access_token } });
    }

    current.tokens.access_token = refreshed.access_token;
    if (typeof refreshed.id_token === "string" && refreshed.id_token) current.tokens.id_token = refreshed.id_token;
    if (typeof refreshed.refresh_token === "string" && refreshed.refresh_token) current.tokens.refresh_token = refreshed.refresh_token;
    current.last_refresh = new Date(this.now()).toISOString();
    await atomicWriteJson(this.authFile, current);
    this.logger.info("codex token refreshed");
    return this.#credentials(current);
  }
}

export const authInternals = { accountIdFrom, decodeJwtPayload, tokenExpiresSoon };
