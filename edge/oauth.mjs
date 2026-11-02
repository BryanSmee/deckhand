// Sign-in for MCP clients (#481): edge is a small OAuth 2.1 authorization server for the `/mcp`
// resource, as the MCP authorization spec asks, and signs its users in with GitHub as the
// dashboard does (../listener/auth.mjs): no identity provider of its own.
//
//   GET  /.well-known/oauth-protected-resource[/mcp]   RFC 9728: /mcp, and who signs its users in
//   GET  /.well-known/oauth-authorization-server       RFC 8414: the endpoints below
//   POST /oauth/register     RFC 7591: public clients only, loopback or https:// redirect URIs;
//                            capped per hour, gone unless used within a day
//   GET  /oauth/authorize    PKCE (S256) required; signed in with GitHub (or the dashboard's
//                            session), then a consent page naming the client
//   POST /oauth/authorize    the consent: a code for an allowed login, or access_denied
//   POST /oauth/token        the code (with its verifier) or a refresh token → an access token
//                            (an hour) and a new refresh token (30 days, rotating: one used twice
//                            ends its whole family)
//   POST /oauth/revoke       RFC 7009: the client's own sign-out
//   *    /mcp                401 with WWW-Authenticate without a valid token; the tools: #482
//   GET  /api/mcp/clients               Settings: the signed-in login's connected clients
//   POST /api/mcp/clients/<id>/revoke   Settings' Revoke
//
// Tokens and codes are random, kept hashed in edge's store (its two copies share it), never
// logged: edge still holds only the webhook secret, the session key and the OAuth client's.
// Every check reads the login's family of tokens, ALLOWED_USERS and its session epoch again: a
// user removed, signed out everywhere, or a client revoked in Settings is cut off at once.
import { createHash, randomBytes } from "node:crypto";
import { escape, page, same } from "../listener/html.mjs";
import { sourceOf } from "../listener/deliveries.mjs";
import { sameOrigin } from "../listener/web.mjs";
import { readBody, send } from "../lib/http.mjs";

export const ACCESS_MS = 3600_000;
export const REFRESH_MS = 30 * 24 * 3600_000;
// A registration no one signed in with is gone after a day; a used one lives as its tokens do.
const UNUSED_MS = 24 * 3600_000;
const REQUEST_MS = 10 * 60_000;
const CODE_MS = 5 * 60_000;
// Registrations per hour: a public endpoint, so capped, per source address (its /64 for IPv6),
// and all together as a backstop against many addresses. At most a day's worth of unused ones
// are kept.
const REGISTRATIONS_PER_SOURCE = 20;
const REGISTRATIONS_PER_HOUR = 300;
// Connected clients per login: a new one past that ends the oldest.
const FAMILIES_PER_LOGIN = 20;
// How often a token's use is written down (Settings' "last used"), in a key of its own: never
// in its family, whose value a refresh compares and sets.
const USED_EVERY_MS = 60_000;
const MAX_BODY = 16 * 1024;
const MAX_REDIRECTS = 5;
const GRANTS = ["authorization_code", "refresh_token"];

export const SCOPES = {
  "deckhand:read": "Read your repositories, tasks, runs, their logs and the schedule",
  "deckhand:work": "Start, rerun, queue and cancel runs, as you can on the dashboard",
  "deckhand:machine": "Register machines of yours that take Deckhand's tasks",
};
// What a client gets when it asks for none of them, and what the metadata offers: a machine's
// scope is asked for by its driver alone.
const OFFERED = ["deckhand:read", "deckhand:work"];

const key = {
  client: (id) => `mcp/clients/${id}`,
  registrations: (hour, source = "") => `mcp/registrations/${hour}${source && `/${source}`}`,
  request: (id) => `mcp/requests/${id}`,
  code: (hash) => `mcp/codes/${hash}`,
  family: (id) => `mcp/families/${id}`,
  used: (id) => `mcp/used/${id}`,
  revoked: (id) => `mcp/revoked/${id}`,
  access: (hash) => `mcp/access/${hash}`,
  refresh: (hash) => `mcp/refresh/${hash}`,
  login: (login) => `mcp/logins/${login}`,
};

const digest = (token) => createHash("sha256").update(String(token)).digest("base64url");

// The scopes asked for that Deckhand knows (others, `offline_access`…, are ignored), else the
// offered ones.
export function scopesOf(asked) {
  const known = knownScopes(asked);
  return known.length ? known : [...OFFERED];
}

const knownScopes = (asked) =>
  [...new Set(String(asked ?? "").split(/\s+/))].filter((s) => Object.hasOwn(SCOPES, s));

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

// A redirect URI a client may register: https://, or http:// to the client's own machine
// (RFC 8252), without a fragment or credentials. Null when it isn't one.
export function redirectUri(text) {
  if (typeof text !== "string" || text.length > 2000) return null;
  let url;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.hash || url.username || url.password) return null;
  if (url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK.has(url.hostname))) {
    return url.href;
  }
  return null;
}

// Whether `asked` is one of `registered`: the same URI, or, on the loopback, the same but its
// port (RFC 8252 §7.3: a native app listens on whatever port is free).
export function registeredRedirect(registered, asked) {
  const url = redirectUri(asked);
  if (!url) return false;
  return registered.some((r) => {
    if (r === url) return true;
    const a = new URL(r);
    const b = new URL(url);
    if (a.protocol !== "http:" || !LOOPBACK.has(a.hostname)) return false;
    a.port = b.port = "";
    return a.href === b.href;
  });
}

// `auth`: ../listener/auth.mjs's (the signed-in login, its session epoch); `publicUrl()`:
// Deckhand's public URL, the issuer; `serve(req, res, who)`: /mcp itself once its token is
// checked (#482). `random(bytes)`: base64url, the tests' to choose.
export function createOAuth({
  config,
  auth,
  store,
  publicUrl,
  serve = (req, res) =>
    send(res, 501, { error: "Deckhand's MCP tools aren't served by this version yet." }),
  now = Date.now,
  random = (bytes) => randomBytes(bytes).toString("base64url"),
  log = () => {},
}) {
  const base = () => publicUrl().replace(/\/+$/, "");
  const resource = () => `${base()}/mcp`;
  const metadataUrl = () => `${base()}/.well-known/oauth-protected-resource/mcp`;
  const allowed = (login) => config.users.includes(login);
  // RFC 8707: the resource a client names is /mcp, with or without its trailing slash.
  const ours = (asked) => !asked || asked.replace(/\/+$/, "") === resource();

  // The metadata, the registration and the token endpoints are called by clients that may run
  // in a browser (the MCP Inspector): no cookie is read there.
  const CORS = {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "authorization, content-type, mcp-protocol-version",
    "access-control-expose-headers": "www-authenticate",
  };
  const json = (res, status, value, headers = {}) => {
    res.writeHead(status, {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...CORS,
      ...headers,
    });
    res.end(JSON.stringify(value));
  };
  const oauthError = (res, error, description, status = 400) =>
    json(res, status, { error, error_description: description });

  function protectedResource(res) {
    json(res, 200, {
      resource: resource(),
      authorization_servers: [base()],
      scopes_supported: OFFERED,
      bearer_methods_supported: ["header"],
      resource_name: "Deckhand",
    });
  }

  function authorizationServer(res) {
    json(res, 200, {
      issuer: base(),
      authorization_endpoint: `${base()}/oauth/authorize`,
      token_endpoint: `${base()}/oauth/token`,
      registration_endpoint: `${base()}/oauth/register`,
      revocation_endpoint: `${base()}/oauth/revoke`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      revocation_endpoint_auth_methods_supported: ["none"],
      scopes_supported: OFFERED,
      authorization_response_iss_parameter_supported: true,
    });
  }

  // Clients' bodies: JSON for the registration, a form for the rest (RFC 6749). Null when it
  // can't be read.
  async function body(req) {
    try {
      return (await readBody(req, MAX_BODY)).toString("utf8");
    } catch {
      return null;
    }
  }
  const form = async (req) => {
    const text = await body(req);
    return text === null ? null : new URLSearchParams(text);
  };

  async function register(req, res) {
    let asked;
    try {
      asked = JSON.parse((await body(req)) ?? "");
    } catch {
      return oauthError(res, "invalid_client_metadata", "A JSON body is expected.");
    }
    if (!asked || typeof asked !== "object") {
      return oauthError(res, "invalid_client_metadata", "A JSON object is expected.");
    }
    const uris = Array.isArray(asked.redirect_uris) ? asked.redirect_uris : [];
    const redirects = uris.map(redirectUri);
    if (!uris.length || uris.length > MAX_REDIRECTS || redirects.includes(null)) {
      return oauthError(
        res,
        "invalid_redirect_uri",
        `1 to ${MAX_REDIRECTS} redirect URIs, each https:// or http:// to localhost, 127.0.0.1 or [::1].`,
      );
    }
    const grants = asked.grant_types ?? ["authorization_code"];
    if (!Array.isArray(grants) || grants.some((g) => !GRANTS.includes(g))) {
      return oauthError(res, "invalid_client_metadata", `grant_types: ${GRANTS.join(" and ")}.`);
    }
    const hour = Math.floor(now() / 3600_000);
    const source = sourceOf(req.socket.remoteAddress);
    const fromSource = await store.increment(key.registrations(hour, source), 1, {
      ttlMs: 3600_000,
    });
    // One address over its share isn't counted against everyone's.
    const count =
      fromSource > REGISTRATIONS_PER_SOURCE
        ? 0
        : await store.increment(key.registrations(hour), 1, { ttlMs: 3600_000 });
    if (fromSource > REGISTRATIONS_PER_SOURCE || count > REGISTRATIONS_PER_HOUR) {
      log(`MCP: a registration from ${source} refused, too many this hour`);
      return oauthError(
        res,
        "temporarily_unavailable",
        "Too many registrations: retry later.",
        429,
      );
    }
    const name =
      typeof asked.client_name === "string" && asked.client_name.trim()
        ? asked.client_name.trim().slice(0, 80)
        : "An MCP client";
    const client = { id: random(16), name, redirects, created: now() };
    await store.set(key.client(client.id), client, { ttlMs: UNUSED_MS });
    log(`MCP: client ${client.id} registered (${JSON.stringify(name)})`);
    // Public clients: whatever authentication it asked for, it has none (RFC 7591 §3.2.1).
    json(res, 201, {
      client_id: client.id,
      client_id_issued_at: Math.floor(client.created / 1000),
      client_name: name,
      redirect_uris: redirects,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
  }

  // Back to the client with an error (RFC 6749 §4.1.2.1): only once its redirect is known good.
  function redirectError(res, to, error, description, state) {
    const url = new URL(to);
    url.searchParams.set("error", error);
    url.searchParams.set("error_description", description);
    if (state) url.searchParams.set("state", state);
    url.searchParams.set("iss", base());
    res.writeHead(302, { location: url.href, "cache-control": "no-store" });
    res.end();
  }

  const CSS = `.actions { display: flex; gap: 0.75rem; margin-top: 1.5rem; }
      button { padding: 0.6rem 1.2rem; font: inherit; border: 1px solid var(--line); border-radius: 6px; background: transparent; color: inherit; cursor: pointer; }
      button.allow { border-color: var(--accent); background: var(--accent); color: #fff; }
      ul { padding-left: 1.2rem; } code { overflow-wrap: anywhere; }`;
  // `same-origin`, not page()'s `no-referrer`: under that one, a browser posts the consent form
  // with `Origin: null`, which sameOrigin() refuses.
  const authPage = (res, status, title, html) =>
    page(res, status, title, html, { css: CSS, headers: { "referrer-policy": "same-origin" } });

  async function authorizeGet(req, res, url) {
    const p = url.searchParams;
    const client = await store.get(key.client(p.get("client_id") ?? ""));
    const to = p.get("redirect_uri") ?? "";
    // Neither the client nor where to send its error is known: told here, never redirected.
    if (!client || !registeredRedirect(client.redirects, to)) {
      return authPage(
        res,
        400,
        "Unknown client",
        `<p>This MCP client isn't registered with this Deckhand, or not with this redirect URI.
Connect it again from the client.</p>`,
      );
    }
    // Signed in first, before any redirect to the client: anyone may register one, so an error
    // sent there to someone not signed in would make this an open redirect (RFC 9700 §4.11.2).
    const login = await auth.user(req);
    if (!login) {
      const next = `/oauth/authorize${url.search}`;
      res.writeHead(302, {
        location: `/auth/login?next=${encodeURIComponent(next)}`,
        "cache-control": "no-store",
      });
      return res.end();
    }
    const state = p.get("state") ?? "";
    if (p.get("response_type") !== "code") {
      return redirectError(res, to, "unsupported_response_type", "code only.", state);
    }
    const challenge = p.get("code_challenge") ?? "";
    if (p.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43,128}$/.test(challenge)) {
      return redirectError(res, to, "invalid_request", "PKCE with S256 is required.", state);
    }
    if (!ours(p.get("resource"))) {
      return redirectError(res, to, "invalid_target", `The resource is ${resource()}.`, state);
    }
    const scopes = scopesOf(p.get("scope"));
    const id = random(24);
    await store.set(
      key.request(id),
      // The login's epoch now: a sign-out everywhere before the exchange voids the code too.
      {
        login,
        client: client.id,
        redirect: to,
        challenge,
        scopes,
        state,
        epoch: await auth.epoch(login),
      },
      { ttlMs: REQUEST_MS },
    );
    const items = scopes.map((s) => `<li><code>${s}</code>: ${escape(SCOPES[s])}</li>`).join("");
    return authPage(
      res,
      200,
      "Connect an MCP client",
      `<p><strong>${escape(client.name)}</strong> asks to act as <strong>@${escape(login)}</strong>
on this Deckhand, with your rights on its dashboard:</p>
<ul>${items}</ul>
<p class="muted">Its name is its own claim. Once allowed, it is sent back to
<code>${escape(to)}</code>. Settings › MCP clients lists it, with Revoke.</p>
<form method="post" action="/oauth/authorize">
  <input type="hidden" name="request" value="${escape(id)}" />
  <div class="actions">
    <button class="allow" type="submit" name="decision" value="allow">Allow</button>
    <button type="submit" name="decision" value="deny">Deny</button>
  </div>
</form>`,
    );
  }

  async function authorizePost(req, res) {
    const p = await form(req);
    const login = await auth.user(req);
    // SameSite=Lax already keeps the session cookie off another site's post; this the rest.
    if (!p || !login || !sameOrigin(req, base())) {
      return authPage(res, 403, "Not allowed", `<p>Connect the client again from the client.</p>`);
    }
    const id = p.get("request") ?? "";
    const request = await store.get(key.request(id));
    // Taken once: a second post of the same page gets nothing.
    if (!request || request.login !== login || !(await store.delete(key.request(id)))) {
      return authPage(
        res,
        400,
        "Expired",
        `<p>This page is no longer valid: connect the client again from the client.</p>`,
      );
    }
    if (p.get("decision") !== "allow") {
      log(`MCP: ${login} denied client ${request.client}`);
      return redirectError(res, request.redirect, "access_denied", "Denied.", request.state);
    }
    const code = random(32);
    await store.set(
      key.code(digest(code)),
      { ...request, login, issued: now() },
      { ttlMs: CODE_MS },
    );
    const to = new URL(request.redirect);
    to.searchParams.set("code", code);
    if (request.state) to.searchParams.set("state", request.state);
    to.searchParams.set("iss", base());
    res.writeHead(302, { location: to.href, "cache-control": "no-store" });
    res.end();
  }

  // A family of tokens (one client's sign-in), while it may still be used: there, its login
  // still allowed and not signed out everywhere since.
  async function live(id) {
    const family = id ? await store.get(key.family(id)) : null;
    if (!family || !allowed(family.login)) return null;
    if (family.epoch !== (await auth.epoch(family.login))) return null;
    return family;
  }

  // Each login's families, for Settings: a list in one key, changed with compareAndSet.
  async function changeList(login, change) {
    for (;;) {
      const ids = await store.get(key.login(login));
      const next = change(ids ?? []);
      if (await store.compareAndSet(key.login(login), ids, next)) return;
    }
  }

  // Its mark first: a family whose creation or refresh is on its way when it is revoked (a code
  // used twice before its first exchange created it) sees the mark, rather than come back.
  async function revokeFamily(id, why) {
    if (!id) return false;
    await store.set(key.revoked(id), true, { ttlMs: REFRESH_MS });
    const family = await store.get(key.family(id));
    await store.delete(key.family(id));
    await store.delete(key.used(id));
    if (!family) return false;
    await changeList(family.login, (ids) => ids.filter((x) => x !== id));
    log(`MCP: ${family.login}'s client ${family.client} (${JSON.stringify(family.name)}) ${why}`);
    return true;
  }

  // A new access token and refresh token for `family`, written with it: the refresh token it
  // holds is the only one that counts. `expected`: the family's value now (null: a new one),
  // which it replaces only if still there: one revoked meanwhile stays revoked. `scopes`: the
  // access token's, fewer than the family's when a refresh asked for fewer (RFC 6749 §6: the
  // refresh token keeps them all). The answer's body, or null when it was revoked.
  async function issue(family, expected, scopes = family.scopes) {
    const access = random(32);
    const refresh = random(32);
    const at = now();
    const next = { ...family, refresh: digest(refresh), expires: at + REFRESH_MS };
    const accessKey = key.access(digest(access));
    const refreshKey = key.refresh(digest(refresh));
    await store.set(
      accessKey,
      { family: family.id, exp: at + ACCESS_MS, scopes },
      {
        ttlMs: ACCESS_MS,
      },
    );
    await store.set(refreshKey, { family: family.id }, { ttlMs: REFRESH_MS });
    const kept =
      (await store.compareAndSet(key.family(family.id), expected, next, { ttlMs: REFRESH_MS })) &&
      !(await store.get(key.revoked(family.id)));
    if (!kept) {
      await store.delete(key.family(family.id)).catch(() => false);
      await store.delete(accessKey).catch(() => false);
      await store.delete(refreshKey).catch(() => false);
      return null;
    }
    // The client's registration lives as long as its tokens may.
    const client = await store.get(key.client(family.client));
    if (client) await store.set(key.client(client.id), client, { ttlMs: REFRESH_MS });
    return {
      access_token: access,
      token_type: "Bearer",
      expires_in: ACCESS_MS / 1000,
      refresh_token: refresh,
      scope: scopes.join(" "),
    };
  }

  async function exchangeCode(res, p) {
    const hash = digest(p.get("code") ?? "");
    const code = await store.get(key.code(hash));
    if (!code) return oauthError(res, "invalid_grant", "Unknown or expired code.");
    if (code.used) {
      // A code sent twice may have been stolen: its tokens end too (RFC 6749 §4.1.2).
      await revokeFamily(code.family, "revoked: its code was used twice");
      return oauthError(res, "invalid_grant", "This code was used already.");
    }
    if (code.client !== p.get("client_id") || code.redirect !== p.get("redirect_uri")) {
      return oauthError(res, "invalid_grant", "Not this client's code, or another redirect_uri.");
    }
    const verifier = p.get("code_verifier") ?? "";
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || !same(digest(verifier), code.challenge)) {
      return oauthError(res, "invalid_grant", "The code_verifier doesn't match.");
    }
    if (!ours(p.get("resource"))) {
      return oauthError(res, "invalid_target", `The resource is ${resource()}.`);
    }
    const id = random(16);
    // Kept as used for the rest of its life alone: a reuse within it ends the family.
    const left = Math.max(1, code.issued + CODE_MS - now());
    const used = { ...code, used: true, family: id };
    if (!(await store.compareAndSet(key.code(hash), code, used, { ttlMs: left }))) {
      return oauthError(res, "invalid_grant", "This code was used already.");
    }
    if (!allowed(code.login)) {
      return oauthError(res, "invalid_grant", "This login isn't one of Deckhand's users.");
    }
    if (code.epoch !== (await auth.epoch(code.login))) {
      return oauthError(res, "invalid_grant", "Signed out since this code was given.");
    }
    const client = await store.get(key.client(code.client));
    if (!client) return oauthError(res, "invalid_grant", "This client's registration expired.");
    const family = {
      id,
      login: code.login,
      client: client.id,
      name: client.name,
      redirect: code.redirect,
      scopes: code.scopes,
      resource: resource(),
      epoch: code.epoch,
      created: now(),
    };
    const tokens = await issue(family, null);
    if (!tokens) return oauthError(res, "invalid_grant", "This code was used already.");
    // Past the cap, the oldest of the login's clients goes.
    let dropped = [];
    await changeList(code.login, (ids) => {
      const all = [...ids, id];
      dropped = all.slice(0, Math.max(0, all.length - FAMILIES_PER_LOGIN));
      return all.slice(dropped.length);
    });
    for (const old of dropped) await revokeFamily(old, "revoked: too many clients");
    log(`MCP: ${code.login} connected client ${client.id} (${JSON.stringify(client.name)})`);
    // Revoked while it was being listed (Settings read the list before): not left in it.
    if (!(await store.get(key.family(id)))) {
      await changeList(code.login, (ids) => ids.filter((x) => x !== id));
      return oauthError(res, "invalid_grant", "Revoked.");
    }
    return json(res, 200, tokens);
  }

  async function refresh(res, p) {
    const hash = digest(p.get("refresh_token") ?? "");
    const found = await store.get(key.refresh(hash));
    const family = await live(found?.family);
    if (!family || family.client !== p.get("client_id")) {
      return oauthError(res, "invalid_grant", "Unknown, expired or revoked refresh token.");
    }
    if (family.refresh !== hash) {
      // Used before: one of the two who hold it isn't the client.
      await revokeFamily(family.id, "revoked: a refresh token was used twice");
      return oauthError(res, "invalid_grant", "This refresh token was used already.");
    }
    if (!ours(p.get("resource"))) {
      return oauthError(res, "invalid_target", `The resource is ${resource()}.`);
    }
    // Fewer scopes may be asked for, never more; none Deckhand knows: those it has.
    const asked = knownScopes(p.get("scope"));
    const scopes = asked.length ? asked : family.scopes;
    if (scopes.some((s) => !family.scopes.includes(s))) {
      return oauthError(res, "invalid_scope", "More scopes than were granted.");
    }
    // Two refreshes at once: the one that loses ends the family, as a reuse does.
    const rotated = { ...family, refresh: `rotating-${random(8)}` };
    if (
      !(await store.compareAndSet(key.family(family.id), family, rotated, { ttlMs: REFRESH_MS }))
    ) {
      await revokeFamily(family.id, "revoked: a refresh token was used twice");
      return oauthError(res, "invalid_grant", "This refresh token was used already.");
    }
    const tokens = await issue(family, rotated, scopes);
    if (!tokens) {
      // Revoked since its rotation: another refresh with the same token, or Revoke.
      return oauthError(res, "invalid_grant", "Unknown, expired or revoked refresh token.");
    }
    return json(res, 200, tokens);
  }

  async function token(req, res) {
    const p = await form(req);
    if (!p) return oauthError(res, "invalid_request", "A form body is expected.");
    const grant = p.get("grant_type");
    if (grant === "authorization_code") return exchangeCode(res, p);
    if (grant === "refresh_token") return refresh(res, p);
    return oauthError(res, "unsupported_grant_type", "authorization_code or refresh_token.");
  }

  // RFC 7009: the token's whole family, when the client is its own. Always 200.
  async function revoke(req, res) {
    const p = await form(req);
    if (!p) return oauthError(res, "invalid_request", "A form body is expected.");
    const hash = digest(p.get("token") ?? "");
    const found = (await store.get(key.access(hash))) ?? (await store.get(key.refresh(hash)));
    const family = found && (await store.get(key.family(found.family)));
    if (family && family.client === p.get("client_id")) {
      await revokeFamily(family.id, "signed out");
    }
    json(res, 200, {});
  }

  // The login and scopes the request's bearer token is for, or null: what /mcp acts as.
  async function authorize(req) {
    const header = String(req.headers.authorization ?? "");
    const match = /^Bearer ([A-Za-z0-9_-]{16,})$/i.exec(header);
    if (!match) return null;
    const access = await store.get(key.access(digest(match[1])));
    if (!access || !(access.exp > now())) return null;
    const family = await live(access.family);
    if (!family || family.resource !== resource()) return null;
    const used = await store.get(key.used(family.id));
    if (now() - (used ?? 0) > USED_EVERY_MS) {
      await store.set(key.used(family.id), now(), { ttlMs: REFRESH_MS }).catch(() => false);
    }
    return { login: family.login, scopes: access.scopes ?? family.scopes, client: family.client };
  }

  async function mcp(req, res) {
    if (req.method === "OPTIONS") return res.writeHead(204, CORS).end();
    const who = await authorize(req);
    if (!who) {
      const given = /^Bearer /i.test(String(req.headers.authorization ?? ""));
      return json(
        res,
        401,
        { error: given ? "invalid_token" : "Sign in first." },
        {
          "www-authenticate": `Bearer resource_metadata="${metadataUrl()}"${
            given ? ', error="invalid_token"' : ""
          }`,
        },
      );
    }
    return serve(req, res, who);
  }

  // Settings: the login's clients, the newest first.
  async function clients(login) {
    const ids = (await store.get(key.login(login))) ?? [];
    const all = await Promise.all(
      ids.map(async (id) => {
        const family = await live(id);
        return family && { family, used: await store.get(key.used(id)) };
      }),
    );
    return all
      .filter(Boolean)
      .reverse()
      .map(({ family: { id, name, client, redirect, scopes, created }, used }) => ({
        id,
        name,
        client,
        redirect,
        scopes,
        created,
        used: used ?? null,
      }));
  }

  async function dashboard(req, res, path) {
    const login = await auth.user(req);
    if (!login) return send(res, 401, { error: "Sign in first." });
    if (path === "/api/mcp/clients") {
      if (req.method !== "GET") return send(res, 405, { error: "GET only." });
      return send(res, 200, { clients: await clients(login) });
    }
    const revoking = /^\/api\/mcp\/clients\/([A-Za-z0-9_-]+)\/revoke$/.exec(path);
    if (!revoking) return send(res, 404, { error: "Not found." });
    if (req.method !== "POST") return send(res, 405, { error: "POST only." });
    if (!sameOrigin(req, base())) return send(res, 403, { error: "Not from this dashboard." });
    const family = await store.get(key.family(revoking[1]));
    if (family?.login !== login) return send(res, 404, { error: "No such client." });
    await revokeFamily(family.id, "revoked in Settings");
    return send(res, 200, { revoked: true });
  }

  // Handles the paths above; false for any other.
  function handle(req, res) {
    const url = new URL(req.url, "http://localhost");
    const path = url.pathname;
    const get = req.method === "GET";
    const post = req.method === "POST";
    let run;
    if (path === "/mcp" || path === "/mcp/") run = () => mcp(req, res);
    else if (path.startsWith("/api/mcp/")) run = () => dashboard(req, res, path);
    else if (path.startsWith("/.well-known/oauth-") || path.startsWith("/oauth/")) {
      run = () => {
        if (req.method === "OPTIONS") return res.writeHead(204, CORS).end();
        if (get && /^\/\.well-known\/oauth-protected-resource(\/mcp)?$/.test(path)) {
          return protectedResource(res);
        }
        if (get && path === "/.well-known/oauth-authorization-server") {
          return authorizationServer(res);
        }
        if (post && path === "/oauth/register") return register(req, res);
        if (get && path === "/oauth/authorize") return authorizeGet(req, res, url);
        if (post && path === "/oauth/authorize") return authorizePost(req, res);
        if (post && path === "/oauth/token") return token(req, res);
        if (post && path === "/oauth/revoke") return revoke(req, res);
        return json(res, 404, { error: "not_found" });
      };
    } else return false;
    Promise.resolve()
      .then(run)
      .catch((error) => {
        log(`MCP sign-in: ${req.method} ${path}: ${error.stack ?? error}`);
        if (!res.headersSent) json(res, 500, { error: "server_error" });
        else res.end();
      });
    return true;
  }

  return { handle, authorize, clients };
}
