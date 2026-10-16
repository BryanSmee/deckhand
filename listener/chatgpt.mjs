// A ChatGPT plan's login for Codex, held by the listener alone (CODEX_AUTH_FILE: the auth.json
// `codex login` writes). Its refresh token is single-use and rotated on every refresh: copies
// in several sandboxes would invalidate each other, and it is an account-wide credential that
// must stay out of them anyway. So sandboxes keep their run's secret, openai.mjs asks this
// module for the plan's headers, and the refresh happens here, one at a time, written back to
// the file for the next start.
//
// What Codex itself does with such a login (checked against Codex 0.162.1, codex-rs/login and
// model-provider): its calls go to chatgpt.com/backend-api/codex with `Authorization: Bearer
// <access token>` and `ChatGPT-Account-ID`, and it refreshes the access token 5 minutes
// before it expires (or 8 days after the last refresh, when the token has no expiry) at
// auth.openai.com/oauth/token, with Codex's own OAuth client id.
import { readFile, rename, stat, writeFile } from "node:fs/promises";

export const CHATGPT_URL = "https://chatgpt.com/backend-api/codex";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const EARLY_MS = 5 * 60_000;
const MAX_AGE_MS = 8 * 24 * 60 * 60_000;

// A JWT's claims, or {} when it isn't one.
function claims(jwt) {
  try {
    return JSON.parse(Buffer.from(String(jwt).split(".")[1], "base64url").toString());
  } catch {
    return {};
  }
}

// The account and its FedRAMP flag: in auth.json's tokens, else in the ID token's claims.
function accountOf(tokens) {
  const auth = claims(tokens.id_token)["https://api.openai.com/auth"] ?? {};
  return {
    id: tokens.account_id ?? auth.chatgpt_account_id ?? null,
    fedramp: auth.chatgpt_account_is_fedramp === true,
  };
}

// Refused for good: an expired, reused or revoked refresh token. Signing in again is the fix.
class LoginError extends Error {
  status = 401;
}

export function createChatgptLogin({
  file, // CODEX_AUTH_FILE
  fetch = globalThis.fetch,
  now = Date.now,
  tokenUrl = TOKEN_URL,
  log = () => {},
}) {
  let login = null; // { mtimeMs, json }: the file as last read or written
  let refreshing = null; // the one refresh in flight, which every caller awaits
  let stale = null; // an access token the upstream refused: refreshed on the next call
  let broken = null; // a LoginError, until the file changes

  // The file again when someone replaced it (a new `codex login`), else what we hold.
  async function load() {
    const { mtimeMs } = await stat(file);
    if (login?.mtimeMs === mtimeMs) return login.json;
    const json = JSON.parse(await readFile(file, "utf8"));
    if (!json?.tokens?.access_token || !json.tokens.refresh_token) {
      throw new LoginError(`${file} holds no ChatGPT login (run \`codex login\` for one)`);
    }
    login = { mtimeMs, json };
    broken = null;
    return json;
  }

  function due(json) {
    const { access_token } = json.tokens;
    if (access_token === stale) return true;
    const exp = claims(access_token).exp;
    if (typeof exp === "number") return exp * 1000 - EARLY_MS <= now();
    const last = Date.parse(json.last_refresh ?? "");
    return Number.isFinite(last) && last + MAX_AGE_MS <= now();
  }

  async function refresh(json) {
    const res = await fetch(tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: json.tokens.refresh_token,
      }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const code = body.error?.code ?? body.error ?? body.code;
      const message = `the ChatGPT login can't be refreshed (${res.status}${typeof code === "string" ? ` ${code}` : ""})`;
      // 400 invalid_grant and 401: the refresh token is spent, retrying won't help.
      if (res.status === 401 || res.status === 400) {
        throw new LoginError(`${message}: run \`codex login\` again for CODEX_AUTH_FILE`);
      }
      throw new Error(message);
    }
    const fresh = await res.json();
    const next = {
      ...json,
      tokens: {
        ...json.tokens,
        ...(fresh.id_token && { id_token: fresh.id_token }),
        ...(fresh.access_token && { access_token: fresh.access_token }),
        ...(fresh.refresh_token && { refresh_token: fresh.refresh_token }),
      },
      last_refresh: new Date(now()).toISOString(),
    };
    // Written before anything uses it: the old refresh token is spent, a restart must not
    // read it back. Atomically, so a crash leaves one file or the other.
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
    await rename(tmp, file);
    login = { mtimeMs: (await stat(file)).mtimeMs, json: next };
    stale = null;
    log("Codex: refreshed the ChatGPT login");
    return next;
  }

  // The headers that make a call the plan's. Throws when there is no usable login.
  async function headers() {
    let json = await load();
    if (broken) throw broken;
    if (due(json)) {
      refreshing ??= refresh(json)
        .catch((error) => {
          if (error instanceof LoginError) broken = error;
          throw error;
        })
        .finally(() => (refreshing = null));
      json = await refreshing;
    }
    const account = accountOf(json.tokens);
    return {
      authorization: `Bearer ${json.tokens.access_token}`,
      ...(account.id && { "chatgpt-account-id": account.id }),
      ...(account.fedramp && { "x-openai-fedramp": "true" }),
    };
  }

  // The upstream refused this access token (401): the next call refreshes it first, once.
  function refused(authorization) {
    const token = String(authorization).replace(/^Bearer /, "");
    if (token === login?.json.tokens.access_token) stale = token;
  }

  // Its tokens as last read: redacted from runs' output like the other credentials, though
  // no sandbox has them.
  function secrets() {
    const tokens = login?.json.tokens ?? {};
    return [tokens.access_token, tokens.refresh_token];
  }

  return { headers, refused, secrets };
}
