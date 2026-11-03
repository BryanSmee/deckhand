// Dashboard login: GitHub's user-to-server OAuth through the operator's App, for the
// operator's allowed users only (ALLOWED_USERS).
//
//   GET  /auth/login     to GitHub's authorize page, with a state bound to this browser;
//                        `?next=/oauth/authorize?…`: back to an MCP client's authorize page after
//   GET  /auth/callback  the code becomes a user token, used once to read the login, then
//                        revoked; an allowed login gets a session cookie, others a refusal
//   POST /auth/logout    clears the cookie, and ends the login's sessions everywhere, its MCP
//                        clients' tokens too (../edge/oauth.mjs)
//
// The session is a signed cookie (login, expiry and the login's epoch, HMAC with a key kept in
// edge's data volume), so it survives a restart. The allowlist is checked again on every
// request: removing a user from ALLOWED_USERS and restarting signs them out. Signing out bumps
// the login's epoch, in edge's store (#506): a cookie copied before then no longer works, on
// either copy of edge.
import { createHmac, randomBytes } from "node:crypto";
import { chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GITHUB_HEADERS } from "./github-app.mjs";
import { escape, page as html, same } from "./html.mjs";
import { openStore } from "../lib/store.mjs";

export const SESSION_COOKIE = "deckhand_session";
const STATE_COOKIE = "deckhand_oauth_state";
// Where the browser goes once signed in, when not the dashboard: an MCP client's authorize page
// (../edge/oauth.mjs).
const NEXT_COOKIE = "deckhand_next";
export const SESSION_MS = 7 * 24 * 3600000;
const STATE_MS = 10 * 60000;

// The key that signs sessions: random, created once, owner-only. Two copies of edge starting
// together on one volume keep the same one: the first written wins, the other reads it.
export function sessionKey(dir) {
  const path = join(dir, "session.key");
  try {
    const key = readFileSync(path);
    if (key.length >= 32) return key;
    // One too short (cut by a crash) is replaced.
    rmSync(path, { force: true });
  } catch {
    // None yet.
  }
  const key = randomBytes(32);
  try {
    writeFileSync(path, key, { mode: 0o600, flag: "wx" });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    return sessionKey(dir);
  }
  chmodSync(path, 0o600);
  return key;
}

function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at > 0) out[part.slice(0, at).trim()] = part.slice(at + 1).trim();
  }
  return out;
}

const CSS = `.button { display: inline-block; margin-top: 1rem; padding: 0.6rem 1.2rem; font: inherit; border: 0; border-radius: 6px; background: var(--accent); color: #fff; cursor: pointer; text-decoration: none; }`;

// The sign-in pages, and the dashboard's before it (http.mjs).
export function authPage(res, status, title, body, headers = {}) {
  return html(res, status, title, body, { headers, css: CSS });
}

// A `next` that only ever leads to edge's own authorize page: never another site.
const nextPath = (next) =>
  typeof next === "string" && next.startsWith("/oauth/authorize?") && !/[\s\\]/.test(next)
    ? next
    : null;

// The store key of a login's session epoch.
const epochKey = (login) => `sessions/${login}`;

// The epochs a listener from before edge kept (its sessions.json, login → epoch), copied into
// `store` where it has none: a sign-out made then still holds.
export async function importEpochs(store, epochs) {
  if (!epochs || typeof epochs !== "object" || Array.isArray(epochs)) return 0;
  let count = 0;
  for (const [login, epoch] of Object.entries(epochs)) {
    if (!Number.isSafeInteger(epoch) || epoch < 1) continue;
    if (await store.setIfAbsent(epochKey(login.toLowerCase()), epoch)) count++;
  }
  return count;
}

export function createAuth({
  config,
  app, // () => the GitHub App, or null before /setup
  publicUrl, // () => where GitHub sends the browser back
  key, // signs session cookies (sessionKey()), or a function returning it
  // Each login's session epoch (lib/store.mjs): edge's, which both its copies share. None: in
  // memory.
  store = openStore("memory:"),
  fetch = globalThis.fetch,
  now = Date.now,
  random = () => randomBytes(16).toString("hex"),
  // Each sign-in's result: allowed, refused, expired or failed (../edge/metrics.mjs).
  signedIn = () => {},
  log = () => {},
}) {
  const secure = () => publicUrl().startsWith("https:");
  // A login without one is at 0.
  const epochOf = async (login) => (await store.get(epochKey(login))) ?? 0;

  function cookie(name, value, maxAgeMs) {
    return [
      `${name}=${value}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Lax",
      `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
      ...(secure() ? ["Secure"] : []),
    ].join("; ");
  }

  function sign(payload) {
    return createHmac("sha256", typeof key === "function" ? key() : key)
      .update(payload)
      .digest("base64url");
  }

  async function issue(login) {
    const session = { login, exp: now() + SESSION_MS, epoch: await epochOf(login.toLowerCase()) };
    const payload = Buffer.from(JSON.stringify(session)).toString("base64url");
    return `${payload}.${sign(payload)}`;
  }

  // The signed-in allowed login, or null: a promise, the epoch being the store's.
  async function user(req) {
    const value = cookies(req)[SESSION_COOKIE];
    if (!value) return null;
    const [payload, signature = ""] = value.split(".");
    if (!payload || !same(signature, sign(payload))) return null;
    let session;
    try {
      session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    } catch {
      return null;
    }
    const login = String(session.login ?? "").toLowerCase();
    if (!(session.exp > now()) || !config.users.includes(login)) return null;
    // Cookies from before epochs were kept are at 0.
    if ((session.epoch ?? 0) !== (await epochOf(login))) return null;
    return login;
  }

  function login(res, url) {
    const credentials = app()?.credentials;
    if (!credentials?.client_id) {
      return authPage(
        res,
        503,
        "No GitHub App yet",
        `<p>Sign-in goes through Deckhand's GitHub App: create it first with the setup link
from edge's logs.</p>`,
      );
    }
    const state = random();
    const target = new URL(`${config.githubUrl}/login/oauth/authorize`);
    target.searchParams.set("client_id", credentials.client_id);
    target.searchParams.set("redirect_uri", `${publicUrl()}/auth/callback`);
    target.searchParams.set("state", state);
    const next = nextPath(url?.searchParams.get("next"));
    res.writeHead(302, {
      location: target.href,
      "set-cookie": [
        cookie(STATE_COOKIE, state, STATE_MS),
        // None: an earlier one, from an authorize page left half-way, goes.
        next ? cookie(NEXT_COOKIE, encodeURIComponent(next), STATE_MS) : cookie(NEXT_COOKIE, "", 0),
      ],
      "cache-control": "no-store",
    });
    res.end();
  }

  // GitHub's answer as JSON, or null (logged).
  async function json(res, what) {
    if (res.ok) return res.json();
    log(`Login: ${what}: ${res.status} ${await res.text()}`);
    return null;
  }

  async function callback(req, res, url) {
    const credentials = app()?.credentials;
    const state = url.searchParams.get("state") ?? "";
    const code = url.searchParams.get("code") ?? "";
    const expected = cookies(req)[STATE_COOKIE] ?? "";
    const clear = [cookie(STATE_COOKIE, "", 0), cookie(NEXT_COOKIE, "", 0)];
    if (!credentials?.client_secret || !expected || !same(state, expected) || !code) {
      signedIn("expired");
      return authPage(
        res,
        400,
        "Sign-in expired",
        `<p><a class="button" href="/auth/login">Sign in again</a></p>`,
        { "set-cookie": clear },
      );
    }
    const token = await exchange(credentials, code);
    if (!token) {
      signedIn("failed");
      return authPage(
        res,
        502,
        "GitHub refused the sign-in",
        `<p><a class="button" href="/auth/login">Try again</a></p>`,
        { "set-cookie": clear },
      );
    }
    const me = await whoIs(credentials, token);
    if (!me) {
      signedIn("failed");
      return authPage(res, 502, "GitHub didn't say who you are", `<p>See edge's logs.</p>`, {
        "set-cookie": clear,
      });
    }
    const login = me.toLowerCase();
    if (!config.users.includes(login)) {
      signedIn("refused");
      log(`Login: refused ${me}: not in ALLOWED_USERS`);
      return authPage(
        res,
        403,
        "Not allowed",
        `<p>You are signed in on GitHub as <strong>${escape(me)}</strong>, who isn't one of
this Deckhand's allowed users.</p>
<p class="muted">Ask its operator to add you to <code>ALLOWED_USERS</code>, or sign out of
GitHub and sign in here with another account.</p>`,
        { "set-cookie": clear },
      );
    }
    signedIn("allowed");
    log(`Login: ${login} signed in to the dashboard`);
    let next = null;
    try {
      next = nextPath(decodeURIComponent(cookies(req)[NEXT_COOKIE] ?? ""));
    } catch {
      // Not ours: the dashboard.
    }
    res.writeHead(302, {
      location: next ?? "/",
      "set-cookie": [...clear, cookie(SESSION_COOKIE, await issue(login), SESSION_MS)],
      "cache-control": "no-store",
    });
    res.end();
  }

  // The code GitHub sent back → the user's token; null (logged) when GitHub refuses it.
  async function exchange(credentials, code) {
    const res = await fetch(`${config.githubUrl}/login/oauth/access_token`, {
      method: "POST",
      // Not the REST API: JSON only when asked for it.
      headers: {
        ...GITHUB_HEADERS,
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        client_id: credentials.client_id,
        client_secret: credentials.client_secret,
        code,
        redirect_uri: `${publicUrl()}/auth/callback`,
      }),
    });
    const grant = await json(res, "code exchange");
    if (grant && !grant.access_token) log(`Login: code exchange: ${grant.error ?? "no token"}`);
    return grant?.access_token ?? null;
  }

  // The login the token is for, or null (logged). The token is revoked right after.
  async function whoIs(credentials, token) {
    const me = await json(
      await fetch(`${config.githubApi}/user`, {
        headers: { ...GITHUB_HEADERS, authorization: `Bearer ${token}` },
      }),
      "user",
    );
    revoke(credentials, token);
    return me?.login ?? null;
  }

  // The token only served to read the login: nothing keeps it, GitHub forgets it.
  function revoke(credentials, token) {
    const basic = Buffer.from(`${credentials.client_id}:${credentials.client_secret}`).toString(
      "base64",
    );
    fetch(`${config.githubApi}/applications/${credentials.client_id}/token`, {
      method: "DELETE",
      headers: {
        ...GITHUB_HEADERS,
        authorization: `Basic ${basic}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ access_token: token }),
    }).catch((error) => log(`Login: revoking the user token: ${error}`));
  }

  // The cookie goes, and so does every other session of that login: a copied cookie or one
  // left in another browser stops working too.
  async function logout(req, res) {
    const login = await user(req);
    if (login) {
      await store.increment(epochKey(login));
      log(`Login: ${login} signed out, their sessions end`);
    }
    res.writeHead(303, {
      location: "/",
      "set-cookie": cookie(SESSION_COOKIE, "", 0),
      "cache-control": "no-store",
    });
    res.end();
  }

  // Handles /auth/*; false for any other path.
  function handle(req, res) {
    const url = new URL(req.url, "http://localhost");
    if (!url.pathname.startsWith("/auth/")) return false;
    const run = async () => {
      if (req.method === "GET" && url.pathname === "/auth/login") return login(res, url);
      if (req.method === "GET" && url.pathname === "/auth/callback") {
        return callback(req, res, url);
      }
      if (req.method === "POST" && url.pathname === "/auth/logout") return logout(req, res);
      res.writeHead(404).end();
    };
    run().catch((error) => {
      log(`Login: ${error.stack ?? error}`);
      if (!res.headersSent) authPage(res, 500, "Sign-in failed", `<p>See edge's logs.</p>`);
    });
    return true;
  }

  // A login's session epoch: what an MCP client's tokens are bound to as well, so that signing
  // out everywhere ends them too (../edge/oauth.mjs).
  return { handle, user, issue, epoch: (login) => epochOf(login.toLowerCase()) };
}
