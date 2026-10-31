// A ChatGPT plan's login for Codex, held by the models service alone (CODEX_AUTH_FILE: the
// auth.json `codex login` writes). Its refresh token is single-use and rotated on every refresh:
// copies in several sandboxes would invalidate each other, and it is an account-wide credential
// that must stay out of them anyway. So sandboxes keep their run's agent token, openai.mjs asks
// this module for the plan's headers, and the refresh happens here, once for every copy of the
// service, its result kept sealed in the store (logins.mjs).
//
// What Codex itself does with such a login (checked against Codex 0.162.1, codex-rs/login and
// model-provider): its calls go to chatgpt.com/backend-api/codex with `Authorization: Bearer
// <access token>` and `ChatGPT-Account-ID`, and it refreshes the access token 5 minutes
// before it expires (or 8 days after the last refresh, when the token has no expiry) at
// auth.openai.com/oauth/token, with Codex's own OAuth client id.
import { randomBytes } from "node:crypto";
import { openStore } from "../lib/store.mjs";
import { LoginError, loginSeal, planLogin } from "./logins.mjs";

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

export function createChatgptLogin({
  file, // CODEX_AUTH_FILE
  // Where the refreshed login is kept, sealed (logins.mjs): the service's store and key; none, a
  // store of this copy's own.
  store = openStore("memory:"),
  seal = loginSeal(randomBytes(32)),
  holder,
  fetch = globalThis.fetch,
  now = Date.now,
  sleep,
  tokenUrl = TOKEN_URL,
  log = () => {},
}) {
  // Not JSON.parse()'s own error: it quotes part of the file (#242).
  const parse = (text) => {
    let json = null;
    try {
      json = JSON.parse(text);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
    if (!json?.tokens?.access_token || !json.tokens.refresh_token) {
      throw new LoginError(`${file} holds no ChatGPT login (run \`codex login\` for one)`);
    }
    return json;
  };
  function due(json) {
    const { access_token } = json.tokens;
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
        throw new LoginError(`${message}: run \`codex login\` again for CODEX_AUTH_FILE`, {
          refused: true,
        });
      }
      throw new Error(message);
    }
    const fresh = await res.json();
    log("Codex: refreshed the ChatGPT login");
    return {
      ...json,
      tokens: {
        ...json.tokens,
        ...(fresh.id_token && { id_token: fresh.id_token }),
        ...(fresh.access_token && { access_token: fresh.access_token }),
        ...(fresh.refresh_token && { refresh_token: fresh.refresh_token }),
      },
      last_refresh: new Date(now()).toISOString(),
    };
  }

  return planLogin({
    store,
    seal,
    name: "chatgpt",
    file,
    parse,
    now,
    ...(holder && { holder }),
    ...(sleep && { sleep }),
    due,
    refresh,
    headersOf: (json) => {
      const account = accountOf(json.tokens);
      return {
        authorization: `Bearer ${json.tokens.access_token}`,
        ...(account.id && { "chatgpt-account-id": account.id }),
        ...(account.fedramp && { "x-openai-fedramp": "true" }),
      };
    },
    accessOf: (json) => json.tokens.access_token,
    secretsOf: (json) => [json.tokens.access_token, json.tokens.refresh_token],
  });
}
