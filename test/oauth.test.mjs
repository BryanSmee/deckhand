// MCP clients' sign-in (edge/oauth.mjs, #481): the real GitHub sign-in (../listener/auth.mjs) with
// GitHub's answers injected, edge's store in memory, and one clock for both.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { request } from "node:http";
import { test } from "node:test";
import { createOAuth, redirectUri, registeredRedirect, scopesOf } from "../edge/oauth.mjs";
import { createAuth, SESSION_COOKIE } from "../listener/auth.mjs";
import { openStore } from "../lib/store.mjs";
import { pathToFileURL } from "node:url";
import { serve, tempDir, testConfig } from "./helpers.mjs";

const PUBLIC = "https://deck.example.com";
const credentials = { client_id: "Iv1.x", client_secret: "cs" };
const VERIFIER = "v".repeat(43) + "-verifier_ok";
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");
const REDIRECT = "http://127.0.0.1:33418/callback";

// `storeUrl`: edge's store, in memory unless named; `clock`: where its clock starts.
async function serveOAuth(t, { storeUrl = "memory:", clock: start = 1_000_000_000 } = {}) {
  const config = testConfig({
    ALLOWED_USERS: "alice,bob",
    GITHUB_URL: "https://gh.test",
    GITHUB_API: "https://api.gh.test",
  });
  let clock = start;
  const now = () => clock;
  const store = openStore(storeUrl, { now });
  t.after(() => store.close());
  let github = "alice";
  const fetch = async (url) => {
    if (url === "https://gh.test/login/oauth/access_token") {
      return Response.json({ access_token: "user-token" });
    }
    if (url === "https://api.gh.test/user") return Response.json({ login: github });
    return new Response(null, { status: 204 });
  };
  const lines = [];
  const log = (line) => lines.push(line);
  const auth = createAuth({
    config,
    app: () => ({ credentials }),
    publicUrl: () => PUBLIC,
    key: Buffer.alloc(32, 1),
    store,
    fetch,
    now,
    random: () => "state1",
    log,
  });
  let n = 0;
  // Edge's store as oauth.mjs sees it: a compareAndSet matching a pause waits there until let
  // go, for the tests that run two calls at once.
  const pauses = [];
  const compareAndSet = async (...args) => {
    const at = pauses.findIndex((p) => p.match(...args));
    if (at >= 0) {
      const [pause] = pauses.splice(at, 1);
      pause.reached();
      await pause.held;
    }
    return store.compareAndSet(...args);
  };
  // The next compareAndSet(key, expected, value) that `match` takes: { reached, go }.
  function pauseAt(match) {
    const pause = { match };
    const reached = new Promise((resolve) => (pause.reached = resolve));
    let go;
    pause.held = new Promise((resolve) => (go = resolve));
    pauses.push(pause);
    return { reached, go };
  }
  const oauth = createOAuth({
    config,
    auth,
    store: { ...store, compareAndSet },
    publicUrl: () => PUBLIC,
    now,
    // Distinct, long enough to pass for tokens, and predictable.
    random: (bytes) => `r${String(++n).padStart(bytes, "0")}`,
    serve: (req, res, who) => res.writeHead(200).end(JSON.stringify(who)),
    log,
  });
  const { url: base } = await serve(t, (req, res) => {
    if (auth.handle(req, res) || oauth.handle(req, res)) return;
    res.writeHead(404).end();
  });
  const call = (path, { method = "GET", cookie, headers = {}, body } = {}) =>
    globalThis.fetch(base + path, {
      method,
      redirect: "manual",
      headers: { ...(cookie && { cookie }), ...headers },
      body,
    });
  const form = (path, fields, headers = {}) =>
    call(path, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
      body: new URLSearchParams(fields).toString(),
    });

  // Signs `login` in with GitHub, as a browser: its session cookie.
  async function signIn(login = "alice") {
    github = login;
    await call("/auth/login");
    const res = await call("/auth/callback?state=state1&code=good", {
      cookie: "deckhand_oauth_state=state1",
    });
    const set = res.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`));
    return set?.split(";")[0] ?? null;
  }

  // `from`: the address it registers from, 127.0.0.1 by default.
  async function register(redirect_uris = [REDIRECT], extra = {}, from = "127.0.0.1") {
    const body = JSON.stringify({ client_name: "Claude Code", redirect_uris, ...extra });
    const { port } = new URL(base);
    return new Promise((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port,
          method: "POST",
          path: "/oauth/register",
          localAddress: from,
          headers: { "content-type": "application/json" },
        },
        (res) => {
          let text = "";
          res.on("data", (d) => (text += d));
          res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
        },
      );
      req.on("error", reject);
      req.end(body);
    });
  }

  const authorizeQuery = (client, extra = {}) =>
    new URLSearchParams({
      response_type: "code",
      client_id: client,
      redirect_uri: REDIRECT,
      code_challenge: CHALLENGE,
      code_challenge_method: "S256",
      state: "xyz",
      resource: `${PUBLIC}/mcp`,
      ...extra,
    });

  // Through the consent page, allowed: the code, from the redirect back to the client.
  async function consent(cookie, client, { decision = "allow", extra = {} } = {}) {
    const page = await call(`/oauth/authorize?${authorizeQuery(client, extra)}`, { cookie });
    assert.equal(page.status, 200, await page.clone().text());
    const request = /name="request" value="([^"]+)"/.exec(await page.text())[1];
    const res = await call("/oauth/authorize", {
      method: "POST",
      cookie,
      headers: { "content-type": "application/x-www-form-urlencoded", origin: PUBLIC },
      body: new URLSearchParams({ request, decision }).toString(),
    });
    assert.equal(res.status, 302);
    return new URL(res.headers.get("location"));
  }

  const exchange = (client, code, extra = {}) =>
    form("/oauth/token", {
      grant_type: "authorization_code",
      code,
      client_id: client,
      redirect_uri: REDIRECT,
      code_verifier: VERIFIER,
      ...extra,
    });
  const refresh = (client, token) =>
    form("/oauth/token", { grant_type: "refresh_token", refresh_token: token, client_id: client });
  const mcp = (token) =>
    call("/mcp", { method: "POST", headers: token ? { authorization: `Bearer ${token}` } : {} });

  // A client registered, signed in as `login`, its first tokens.
  async function connect(login = "alice") {
    const cookie = await signIn(login);
    const client = (await register()).body.client_id;
    const back = await consent(cookie, client);
    const res = await exchange(client, back.searchParams.get("code"));
    assert.equal(res.status, 200);
    return { cookie, client, tokens: await res.json() };
  }

  return {
    config,
    store,
    lines,
    call,
    form,
    signIn,
    register,
    authorizeQuery,
    consent,
    exchange,
    refresh,
    mcp,
    connect,
    pauseAt,
    later: (ms) => (clock += ms),
  };
}

test("the metadata documents point at Deckhand's public URL", async (t) => {
  const s = await serveOAuth(t);
  for (const path of [
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-protected-resource/mcp",
  ]) {
    const res = await s.call(path);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
    const doc = await res.json();
    assert.equal(doc.resource, `${PUBLIC}/mcp`);
    assert.deepEqual(doc.authorization_servers, [PUBLIC]);
    assert.deepEqual(doc.scopes_supported, ["deckhand:read", "deckhand:work"]);
  }
  const as = await (await s.call("/.well-known/oauth-authorization-server")).json();
  assert.equal(as.issuer, PUBLIC);
  assert.equal(as.authorization_endpoint, `${PUBLIC}/oauth/authorize`);
  assert.equal(as.token_endpoint, `${PUBLIC}/oauth/token`);
  assert.equal(as.registration_endpoint, `${PUBLIC}/oauth/register`);
  assert.deepEqual(as.code_challenge_methods_supported, ["S256"]);
  assert.deepEqual(as.token_endpoint_auth_methods_supported, ["none"]);
});

test("/mcp without a token: 401 naming the resource metadata", async (t) => {
  const s = await serveOAuth(t);
  const res = await s.mcp();
  assert.equal(res.status, 401);
  assert.equal(
    res.headers.get("www-authenticate"),
    `Bearer resource_metadata="${PUBLIC}/.well-known/oauth-protected-resource/mcp"`,
  );
  const bad = await s.mcp("not-a-token-of-ours-at-all");
  assert.equal(bad.status, 401);
  assert.match(bad.headers.get("www-authenticate"), /error="invalid_token"/);
});

test("registration: public clients, loopback or https:// redirect URIs only", async (t) => {
  const s = await serveOAuth(t);
  const ok = await s.register([REDIRECT, "https://vscode.dev/redirect"], {
    token_endpoint_auth_method: "client_secret_basic",
  });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.token_endpoint_auth_method, "none");
  assert.equal(ok.body.client_secret, undefined);
  assert.deepEqual(ok.body.redirect_uris, [REDIRECT, "https://vscode.dev/redirect"]);
  for (const uris of [
    [],
    ["http://evil.example.com/cb"],
    ["cursor://anysphere/cb"],
    ["https://a.example.com/cb#frag"],
    "https://a.example.com/cb",
  ]) {
    const refused = await s.register(uris);
    assert.equal(refused.status, 400, JSON.stringify(uris));
    assert.equal(refused.body.error, "invalid_redirect_uri");
  }
  // Unused, a registration is gone after a day.
  s.later(25 * 3600_000);
  const cookie = await s.signIn();
  const page = await s.call(`/oauth/authorize?${s.authorizeQuery(ok.body.client_id)}`, { cookie });
  assert.equal(page.status, 400);
  assert.match(await page.text(), /Unknown client/);
});

test("registrations are capped per hour and source address: another's still get through", async (t) => {
  const s = await serveOAuth(t);
  for (let i = 0; i < 20; i++) assert.equal((await s.register()).status, 201);
  assert.equal((await s.register()).status, 429);
  assert.equal((await s.register([REDIRECT], {}, "127.0.0.2")).status, 201);
  s.later(3600_000);
  assert.equal((await s.register()).status, 201);
});

test("a client signs in with GitHub through authorize, with PKCE, and gets its tokens", async (t) => {
  const s = await serveOAuth(t);
  const client = (await s.register()).body.client_id;
  // Not signed in: to GitHub, then back here.
  const query = s.authorizeQuery(client);
  const first = await s.call(`/oauth/authorize?${query}`);
  assert.equal(first.status, 302);
  const login = new URL(first.headers.get("location"), PUBLIC);
  assert.equal(login.pathname, "/auth/login");
  const next = login.searchParams.get("next");
  assert.equal(next, `/oauth/authorize?${query}`);
  const toGithub = await s.call(`/auth/login?next=${encodeURIComponent(next)}`);
  const nextCookie = toGithub.headers
    .getSetCookie()
    .find((c) => c.startsWith("deckhand_next="))
    .split(";")[0];
  const back = await s.call("/auth/callback?state=state1&code=good", {
    cookie: `deckhand_oauth_state=state1; ${nextCookie}`,
  });
  assert.equal(back.headers.get("location"), next);
  const cookie = back.headers
    .getSetCookie()
    .find((c) => c.startsWith(`${SESSION_COOKIE}=`))
    .split(";")[0];

  // The consent page names the client, its redirect and the scopes.
  const page = await s.call(next, { cookie });
  const html = await page.text();
  assert.match(html, /Claude Code/);
  assert.match(html, /@alice/);
  assert.match(html, /http:\/\/127\.0\.0\.1:33418\/callback/);
  assert.match(html, /deckhand:read/);
  assert.match(html, /deckhand:work/);
  assert.doesNotMatch(html, /deckhand:machine/);

  const to = await s.consent(cookie, client);
  assert.equal(to.origin + to.pathname, REDIRECT);
  assert.equal(to.searchParams.get("state"), "xyz");
  assert.equal(to.searchParams.get("iss"), PUBLIC);
  const code = to.searchParams.get("code");

  // Another verifier: refused.
  const wrong = await s.exchange(client, code, { code_verifier: "w".repeat(50) });
  assert.equal(wrong.status, 400);
  assert.equal((await wrong.json()).error, "invalid_grant");

  const res = await s.exchange(client, code);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const tokens = await res.json();
  assert.equal(tokens.token_type, "Bearer");
  assert.equal(tokens.expires_in, 3600);
  assert.equal(tokens.scope, "deckhand:read deckhand:work");
  assert.ok(tokens.refresh_token);

  const ok = await s.mcp(tokens.access_token);
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), {
    login: "alice",
    scopes: ["deckhand:read", "deckhand:work"],
    client,
  });

  // A code works once: used again, it ends what it gave too.
  const again = await s.exchange(client, code);
  assert.equal(again.status, 400);
  assert.equal((await s.mcp(tokens.access_token)).status, 401);
});

test("authorize refuses a client without PKCE, or with plain", async (t) => {
  const s = await serveOAuth(t);
  const cookie = await s.signIn();
  const client = (await s.register()).body.client_id;
  for (const extra of [
    { code_challenge: "", code_challenge_method: "" },
    { code_challenge_method: "plain" },
  ]) {
    const query = s.authorizeQuery(client, extra);
    if (!extra.code_challenge_method) query.delete("code_challenge_method");
    if (extra.code_challenge === "") query.delete("code_challenge");
    const res = await s.call(`/oauth/authorize?${query}`, { cookie });
    assert.equal(res.status, 302);
    const to = new URL(res.headers.get("location"));
    assert.equal(to.origin + to.pathname, REDIRECT);
    assert.equal(to.searchParams.get("error"), "invalid_request");
    assert.equal(to.searchParams.get("state"), "xyz");
    assert.equal(to.searchParams.get("code"), null);
  }
  // Another resource, or a redirect it didn't register: refused too, the latter on the page.
  const other = await s.call(
    `/oauth/authorize?${s.authorizeQuery(client, { resource: "https://elsewhere.example.com/mcp" })}`,
    { cookie },
  );
  assert.equal(new URL(other.headers.get("location")).searchParams.get("error"), "invalid_target");
  const elsewhere = await s.call(
    `/oauth/authorize?${s.authorizeQuery(client, { redirect_uri: "https://evil.example.com/cb" })}`,
    { cookie },
  );
  assert.equal(elsewhere.status, 400);
  assert.equal(elsewhere.headers.get("location"), null);
});

test("not signed in, a request the client would get an error for goes to GitHub, never to it", async (t) => {
  const s = await serveOAuth(t);
  // Anyone may register a client, with any https:// redirect URI.
  const client = (await s.register(["https://evil.example.com/x"])).body.client_id;
  for (const extra of [
    { response_type: "x" },
    { code_challenge_method: "plain" },
    { resource: "https://elsewhere.example.com/mcp" },
  ]) {
    const query = s.authorizeQuery(client, {
      redirect_uri: "https://evil.example.com/x",
      ...extra,
    });
    const res = await s.call(`/oauth/authorize?${query}`);
    assert.equal(res.status, 302, JSON.stringify(extra));
    const to = new URL(res.headers.get("location"), PUBLIC);
    assert.equal(to.origin + to.pathname, `${PUBLIC}/auth/login`, JSON.stringify(extra));
  }
});

test("the consent: denied, a forged post, and a page used twice", async (t) => {
  const s = await serveOAuth(t);
  const cookie = await s.signIn();
  const client = (await s.register()).body.client_id;
  const denied = await s.consent(cookie, client, { decision: "deny" });
  assert.equal(denied.searchParams.get("error"), "access_denied");
  assert.equal(denied.searchParams.get("code"), null);

  const page = await s.call(`/oauth/authorize?${s.authorizeQuery(client)}`, { cookie });
  const request = /name="request" value="([^"]+)"/.exec(await page.text())[1];
  const post = (origin) =>
    s.call("/oauth/authorize", {
      method: "POST",
      cookie,
      headers: { "content-type": "application/x-www-form-urlencoded", origin },
      body: new URLSearchParams({ request, decision: "allow" }).toString(),
    });
  assert.equal((await post("https://evil.example.com")).status, 403);
  assert.equal((await post(PUBLIC)).status, 302);
  assert.equal((await post(PUBLIC)).status, 400);
});

test("a login outside ALLOWED_USERS never gets a code; a user removed loses their tokens", async (t) => {
  const s = await serveOAuth(t);
  // GitHub says mallory: no session, so authorize sends them to sign in again, never to the
  // client.
  assert.equal(await s.signIn("mallory"), null);
  const client = (await s.register()).body.client_id;
  const res = await s.call(`/oauth/authorize?${s.authorizeQuery(client)}`);
  assert.equal(new URL(res.headers.get("location"), PUBLIC).pathname, "/auth/login");

  const { client: bobs, tokens } = await s.connect("bob");
  assert.equal((await s.mcp(tokens.access_token)).status, 200);
  s.config.users.splice(s.config.users.indexOf("bob"), 1);
  assert.equal((await s.mcp(tokens.access_token)).status, 401);
  assert.equal((await s.refresh(bobs, tokens.refresh_token)).status, 400);
});

test("refresh rotates; a refresh token used twice ends its family", async (t) => {
  const s = await serveOAuth(t);
  const { client, tokens } = await s.connect();
  const res = await s.refresh(client, tokens.refresh_token);
  assert.equal(res.status, 200);
  const next = await res.json();
  assert.notEqual(next.refresh_token, tokens.refresh_token);
  assert.equal((await s.mcp(next.access_token)).status, 200);
  // Another client's id: refused, and the family goes on.
  assert.equal((await s.refresh("someone-else", next.refresh_token)).status, 400);
  assert.equal((await s.mcp(next.access_token)).status, 200);

  const reused = await s.refresh(client, tokens.refresh_token);
  assert.equal(reused.status, 400);
  assert.equal((await reused.json()).error, "invalid_grant");
  assert.equal((await s.mcp(next.access_token)).status, 401);
  assert.equal((await s.refresh(client, next.refresh_token)).status, 400);
  assert.ok(s.lines.some((l) => /refresh token was used twice/.test(l)));
});

test("an expired access token gets a 401 with WWW-Authenticate; its refresh token still works", async (t) => {
  const s = await serveOAuth(t);
  const { client, tokens } = await s.connect();
  s.later(3600_000 + 1);
  const res = await s.mcp(tokens.access_token);
  assert.equal(res.status, 401);
  assert.match(
    res.headers.get("www-authenticate"),
    /^Bearer resource_metadata="[^"]+", error="invalid_token"$/,
  );
  assert.equal((await s.refresh(client, tokens.refresh_token)).status, 200);
  // A refresh token unused for 30 days is gone.
  const later = await serveOAuth(t);
  const old = await later.connect();
  later.later(31 * 24 * 3600_000);
  assert.equal((await later.refresh(old.client, old.tokens.refresh_token)).status, 400);
});

test("signing out everywhere ends the login's MCP tokens", async (t) => {
  const s = await serveOAuth(t);
  const { client, cookie, tokens } = await s.connect();
  const out = await s.call("/auth/logout", { method: "POST", cookie });
  assert.equal(out.status, 303);
  assert.equal((await s.mcp(tokens.access_token)).status, 401);
  assert.equal((await s.refresh(client, tokens.refresh_token)).status, 400);
  // Signed in again, a new connection works.
  const again = await s.connect();
  assert.equal((await s.mcp(again.tokens.access_token)).status, 200);
});

test("Settings lists the login's clients, and Revoke ends one", async (t) => {
  const s = await serveOAuth(t);
  const first = await s.connect();
  const second = await s.connect();
  const bobs = await s.connect("bob");
  const list = async (cookie) =>
    (await (await s.call("/api/mcp/clients", { cookie })).json()).clients;
  const mine = await list(second.cookie);
  assert.deepEqual(
    mine.map((c) => [c.name, c.client, c.redirect, c.scopes]),
    [
      ["Claude Code", second.client, REDIRECT, ["deckhand:read", "deckhand:work"]],
      ["Claude Code", first.client, REDIRECT, ["deckhand:read", "deckhand:work"]],
    ],
  );
  assert.equal((await s.call("/api/mcp/clients")).status, 401);
  const revoke = (id, cookie, origin = PUBLIC) =>
    s.call(`/api/mcp/clients/${id}/revoke`, { method: "POST", cookie, headers: { origin } });
  // Not from the dashboard, or another login's: refused.
  assert.equal((await revoke(mine[1].id, first.cookie, "https://evil.example.com")).status, 403);
  const bobsId = (await list(bobs.cookie))[0].id;
  assert.equal((await revoke(bobsId, first.cookie)).status, 404);
  assert.equal((await s.mcp(bobs.tokens.access_token)).status, 200);

  assert.equal((await revoke(mine[1].id, first.cookie)).status, 200);
  assert.equal((await s.mcp(first.tokens.access_token)).status, 401);
  assert.equal((await s.refresh(first.client, first.tokens.refresh_token)).status, 400);
  assert.equal((await s.mcp(second.tokens.access_token)).status, 200);
  assert.deepEqual(
    (await list(first.cookie)).map((c) => c.client),
    [second.client],
  );
});

test("the client's own revocation ends its family", async (t) => {
  const s = await serveOAuth(t);
  const { client, tokens } = await s.connect();
  // Another client's id: nothing revoked, still 200.
  const other = await s.form("/oauth/revoke", { token: tokens.refresh_token, client_id: "x" });
  assert.equal(other.status, 200);
  assert.equal((await s.mcp(tokens.access_token)).status, 200);
  const res = await s.form("/oauth/revoke", { token: tokens.access_token, client_id: client });
  assert.equal(res.status, 200);
  assert.equal((await s.mcp(tokens.access_token)).status, 401);
});

test("the consent page lets the browser send its Origin; a post without one is refused", async (t) => {
  const s = await serveOAuth(t);
  const cookie = await s.signIn();
  const client = (await s.register()).body.client_id;
  const page = await s.call(`/oauth/authorize?${s.authorizeQuery(client)}`, { cookie });
  // Under no-referrer, a browser posts the form with `Origin: null`.
  assert.equal(page.headers.get("referrer-policy"), "same-origin");
  const request = /name="request" value="([^"]+)"/.exec(await page.text())[1];
  for (const origin of ["null", undefined]) {
    const res = await s.call("/oauth/authorize", {
      method: "POST",
      cookie,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...(origin && { origin }),
      },
      body: new URLSearchParams({ request, decision: "allow" }).toString(),
    });
    assert.equal(res.status, 403);
  }
});

test("a sign-out everywhere between the consent and the exchange voids the code", async (t) => {
  const s = await serveOAuth(t);
  const cookie = await s.signIn();
  const client = (await s.register()).body.client_id;
  const code = (await s.consent(cookie, client)).searchParams.get("code");
  await s.call("/auth/logout", { method: "POST", cookie });
  const res = await s.exchange(client, code);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "invalid_grant");
});

test("a used code is kept only for the rest of its life", async (t) => {
  const s = await serveOAuth(t);
  const cookie = await s.signIn();
  const client = (await s.register()).body.client_id;
  const code = (await s.consent(cookie, client)).searchParams.get("code");
  assert.equal((await s.exchange(client, code)).status, 200);
  const stored = `mcp/codes/${createHash("sha256").update(code).digest("base64url")}`;
  assert.equal((await s.store.get(stored)).used, true);
  s.later(5 * 60_000);
  assert.equal(await s.store.get(stored), null);
});

test("using a token never changes its family: a refresh racing a /mcp call goes through", async (t) => {
  const s = await serveOAuth(t);
  const { client, cookie, tokens } = await s.connect();
  const list = async () => (await (await s.call("/api/mcp/clients", { cookie })).json()).clients[0];
  // Not used yet: no "last used".
  assert.equal((await list()).used, null);
  const familyKey = `mcp/families/${(await s.store.get("mcp/logins/alice"))[0]}`;
  const before = await s.store.get(familyKey);
  s.later(2 * 60_000);
  assert.equal((await s.mcp(tokens.access_token)).status, 200);
  assert.deepEqual(await s.store.get(familyKey), before);
  assert.ok((await list()).used > before.created);
  assert.equal((await s.refresh(client, tokens.refresh_token)).status, 200);
});

test("a refresh asking only for scopes Deckhand doesn't know keeps those it has", async (t) => {
  const s = await serveOAuth(t);
  const cookie = await s.signIn();
  const client = (await s.register()).body.client_id;
  const back = await s.consent(cookie, client, { extra: { scope: "deckhand:read" } });
  const tokens = await (await s.exchange(client, back.searchParams.get("code"))).json();
  assert.equal(tokens.scope, "deckhand:read");
  const res = await s.form("/oauth/token", {
    grant_type: "refresh_token",
    refresh_token: tokens.refresh_token,
    client_id: client,
    scope: "offline_access",
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).scope, "deckhand:read");
});

// The write that issues a family's tokens: its creation (expected null), or its refresh's (the
// rotated value).
const issuing = (key, expected) =>
  key.startsWith("mcp/families/") &&
  (expected === null || expected.refresh?.startsWith("rotating-"));

test("two refreshes at once with one token: neither keeps tokens, the family ends", async (t) => {
  const s = await serveOAuth(t);
  const { client, tokens } = await s.connect();
  const pause = s.pauseAt(issuing);
  const first = s.refresh(client, tokens.refresh_token);
  await pause.reached;
  const second = await s.refresh(client, tokens.refresh_token);
  assert.equal(second.status, 400);
  pause.go();
  const res = await first;
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "invalid_grant");
  assert.equal((await s.mcp(tokens.access_token)).status, 401);
  assert.deepEqual(await s.store.get("mcp/logins/alice"), []);
});

test("Revoke while a refresh is on its way: the refresh gets nothing", async (t) => {
  const s = await serveOAuth(t);
  const { client, cookie, tokens } = await s.connect();
  const [{ id }] = (await (await s.call("/api/mcp/clients", { cookie })).json()).clients;
  const pause = s.pauseAt(issuing);
  const refreshing = s.refresh(client, tokens.refresh_token);
  await pause.reached;
  const revoked = await s.call(`/api/mcp/clients/${id}/revoke`, {
    method: "POST",
    cookie,
    headers: { origin: PUBLIC },
  });
  assert.equal(revoked.status, 200);
  pause.go();
  assert.equal((await refreshing).status, 400);
  assert.equal(await s.store.get(`mcp/families/${id}`), null);
  assert.deepEqual((await (await s.call("/api/mcp/clients", { cookie })).json()).clients, []);
});

test("a code used again before its first exchange made the family: no tokens from it", async (t) => {
  const s = await serveOAuth(t);
  const cookie = await s.signIn();
  const client = (await s.register()).body.client_id;
  const code = (await s.consent(cookie, client)).searchParams.get("code");
  const pause = s.pauseAt(issuing);
  const first = s.exchange(client, code);
  await pause.reached;
  assert.equal((await s.exchange(client, code)).status, 400);
  pause.go();
  assert.equal((await first).status, 400);
  assert.equal((await s.store.get("mcp/logins/alice"))?.length ?? 0, 0);
});

test("a refresh asking for fewer scopes narrows its access token only", async (t) => {
  const s = await serveOAuth(t);
  const { client, tokens } = await s.connect();
  const narrow = await s.form("/oauth/token", {
    grant_type: "refresh_token",
    refresh_token: tokens.refresh_token,
    client_id: client,
    scope: "deckhand:read",
  });
  const narrowed = await narrow.json();
  assert.equal(narrowed.scope, "deckhand:read");
  assert.deepEqual((await (await s.mcp(narrowed.access_token)).json()).scopes, ["deckhand:read"]);
  // The refresh token kept the whole grant (RFC 6749 §6).
  const again = await (await s.refresh(client, narrowed.refresh_token)).json();
  assert.equal(again.scope, "deckhand:read deckhand:work");
});

test("tokens survive a restart: edge's store keeps them", async (t) => {
  const storeUrl = pathToFileURL(tempDir(t)).href;
  const before = await serveOAuth(t, { storeUrl });
  const { client, tokens } = await before.connect();
  const after = await serveOAuth(t, { storeUrl });
  assert.equal((await after.mcp(tokens.access_token)).status, 200);
  assert.equal((await after.refresh(client, tokens.refresh_token)).status, 200);
});

test("tokens and codes are kept hashed, and never logged", async (t) => {
  const s = await serveOAuth(t);
  const cookie = await s.signIn();
  const client = (await s.register()).body.client_id;
  const code = (await s.consent(cookie, client)).searchParams.get("code");
  const tokens = await (await s.exchange(client, code)).json();
  const hash = (v) => createHash("sha256").update(v).digest("base64url");
  for (const secret of [code, tokens.access_token, tokens.refresh_token]) {
    assert.ok(!s.lines.some((l) => l.includes(secret)), "not in the logs");
  }
  assert.ok(await s.store.get(`mcp/access/${hash(tokens.access_token)}`));
  assert.ok(await s.store.get(`mcp/refresh/${hash(tokens.refresh_token)}`));
  assert.equal(await s.store.get(`mcp/access/${tokens.access_token}`), null);
  const family = (await s.store.get("mcp/logins/alice"))[0];
  const stored = JSON.stringify(await s.store.get(`mcp/families/${family}`));
  assert.ok(!stored.includes(tokens.refresh_token));
});

test("a machine's scope only when asked for; unknown scopes ignored", () => {
  assert.deepEqual(scopesOf(""), ["deckhand:read", "deckhand:work"]);
  assert.deepEqual(scopesOf("offline_access openid"), ["deckhand:read", "deckhand:work"]);
  assert.deepEqual(scopesOf("deckhand:read"), ["deckhand:read"]);
  assert.deepEqual(scopesOf("deckhand:machine offline_access"), ["deckhand:machine"]);
});

test("redirect URIs: loopback on any port, https:// as registered", () => {
  assert.equal(redirectUri("http://localhost:1234/cb"), "http://localhost:1234/cb");
  assert.equal(redirectUri("http://[::1]:1234/cb"), "http://[::1]:1234/cb");
  assert.equal(redirectUri("http://10.0.0.1/cb"), null);
  assert.equal(redirectUri("https://user:pw@a.example.com/cb"), null);
  assert.equal(redirectUri("javascript:alert(1)"), null);
  assert.ok(registeredRedirect(["http://127.0.0.1:1/cb"], "http://127.0.0.1:5555/cb"));
  assert.ok(!registeredRedirect(["http://127.0.0.1:1/cb"], "http://127.0.0.1:5555/other"));
  assert.ok(!registeredRedirect(["https://a.example.com/cb"], "https://a.example.com:8443/cb"));
  assert.ok(registeredRedirect(["https://a.example.com/cb"], "https://a.example.com/cb"));
});
