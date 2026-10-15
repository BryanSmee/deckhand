import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAuth, SESSION_COOKIE, SESSION_MS, sessionKey } from "../listener/auth.mjs";
import { loadConfig } from "../listener/config.mjs";

const credentials = { client_id: "Iv1.x", client_secret: "cs" };

// An auth handler behind a server, with GitHub answering that the browser is `login`.
async function serve({ login = "Alice", app = { credentials }, epochsPath } = {}) {
  const config = loadConfig({
    ALLOWED_USERS: "alice",
    GITHUB_URL: "https://gh.test",
    GITHUB_API: "https://api.gh.test",
  });
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? "GET", init });
    if (url === "https://gh.test/login/oauth/access_token") {
      const { code } = JSON.parse(init.body);
      return Response.json(
        code === "good" ? { access_token: "user-token" } : { error: "bad_verification_code" },
      );
    }
    if (url === "https://api.gh.test/user") return Response.json({ login });
    return new Response(null, { status: 204 });
  };
  let clock = 1_000_000;
  const auth = createAuth({
    config,
    app: () => app,
    publicUrl: () => "https://deck.example.com",
    key: Buffer.alloc(32, 1),
    epochsPath,
    fetch,
    now: () => clock,
    random: () => "state1",
  });
  const server = createServer((req, res) => {
    if (auth.handle(req, res)) return;
    const user = auth.user(req);
    res.writeHead(user ? 200 : 401).end(user ?? "");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (path, cookie) =>
    globalThis.fetch(base + path, { redirect: "manual", headers: cookie ? { cookie } : {} });
  return {
    auth,
    calls,
    get,
    later: (ms) => (clock += ms),
    close: () => server.close(),
  };
}

const value = (res, name) =>
  res.headers
    .getSetCookie()
    .find((c) => c.startsWith(`${name}=`))
    ?.split(";")[0];

test("sign-in goes to GitHub with the App's client id and a state bound to the browser", async (t) => {
  const s = await serve();
  t.after(s.close);
  const res = await s.get("/auth/login");
  assert.equal(res.status, 302);
  const to = new URL(res.headers.get("location"));
  assert.equal(to.origin + to.pathname, "https://gh.test/login/oauth/authorize");
  assert.equal(to.searchParams.get("client_id"), "Iv1.x");
  assert.equal(to.searchParams.get("redirect_uri"), "https://deck.example.com/auth/callback");
  assert.equal(to.searchParams.get("state"), "state1");
  const cookie = res.headers.getSetCookie()[0];
  assert.match(cookie, /^deckhand_oauth_state=state1; Path=\/; HttpOnly; SameSite=Lax/);
  assert.match(cookie, /; Secure$/);
});

test("an allowed user gets a session; the user token is revoked", async (t) => {
  const s = await serve();
  t.after(s.close);
  const res = await s.get("/auth/callback?code=good&state=state1", "deckhand_oauth_state=state1");
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "/");
  const session = value(res, SESSION_COOKIE);
  assert.ok(session);
  assert.equal(await (await s.get("/", session)).text(), "alice");
  const user = s.calls.find((c) => c.url === "https://api.gh.test/user");
  assert.equal(user.init.headers.authorization, "Bearer user-token");
  const revoke = s.calls.find((c) => c.method === "DELETE");
  assert.equal(revoke.url, "https://api.gh.test/applications/Iv1.x/token");
  assert.deepEqual(JSON.parse(revoke.init.body), { access_token: "user-token" });
});

test("a user outside ALLOWED_USERS is refused, by name", async (t) => {
  const s = await serve({ login: "mallory" });
  t.after(s.close);
  const res = await s.get("/auth/callback?code=good&state=state1", "deckhand_oauth_state=state1");
  assert.equal(res.status, 403);
  assert.match(await res.text(), /signed in on GitHub as <strong>mallory<\/strong>/);
  assert.equal(value(res, SESSION_COOKIE), undefined);
});

test("a callback without the browser's state, or with a bad code, gets no session", async (t) => {
  const s = await serve();
  t.after(s.close);
  // Login CSRF: someone else's code and state, without our cookie.
  const forged = await s.get("/auth/callback?code=good&state=state1");
  assert.equal(forged.status, 400);
  const other = await s.get("/auth/callback?code=good&state=state1", "deckhand_oauth_state=x");
  assert.equal(other.status, 400);
  const bad = await s.get("/auth/callback?code=nope&state=state1", "deckhand_oauth_state=state1");
  assert.equal(bad.status, 502);
  assert.equal(
    s.calls.some((c) => c.url.endsWith("/user")),
    false,
  );
});

test("sessions: forged, expired or for a removed user are refused", async (t) => {
  const s = await serve();
  t.after(s.close);
  const good = `${SESSION_COOKIE}=${s.auth.issue("alice")}`;
  assert.equal((await s.get("/", good)).status, 200);
  // Same payload, another login: the signature no longer matches.
  const [payload, signature] = good.split("=")[1].split(".");
  const other = Buffer.from(
    JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url")), login: "bob" }),
  ).toString("base64url");
  assert.equal((await s.get("/", `${SESSION_COOKIE}=${other}.${signature}`)).status, 401);
  // Signed, but bob isn't allowed (any more).
  assert.equal((await s.get("/", `${SESSION_COOKIE}=${s.auth.issue("bob")}`)).status, 401);
  s.later(SESSION_MS + 1);
  assert.equal((await s.get("/", good)).status, 401);
});

test("sign-out clears the session cookie", async (t) => {
  const s = await serve();
  t.after(s.close);
  const res = await fetch(new URL("/auth/logout", (await s.get("/auth/login")).url), {
    method: "POST",
    redirect: "manual",
  });
  assert.equal(res.status, 303);
  assert.match(value(res, SESSION_COOKIE), /^deckhand_session=$/);
});

test("sign-out ends the login's sessions everywhere, through a restart", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "deckhand-sessions-"));
  const epochsPath = join(dir, "sessions.json");
  const s = await serve({ epochsPath });
  t.after(s.close);
  const here = `${SESSION_COOKIE}=${s.auth.issue("alice")}`;
  const there = `${SESSION_COOKIE}=${s.auth.issue("alice")}`;
  assert.equal((await s.get("/", there)).status, 200);
  const res = await fetch(new URL("/auth/logout", (await s.get("/auth/login")).url), {
    method: "POST",
    redirect: "manual",
    headers: { cookie: here },
  });
  assert.equal(res.status, 303);
  // The other browser's cookie no longer works, nor a copy of this one.
  assert.equal((await s.get("/", there)).status, 401);
  assert.equal((await s.get("/", here)).status, 401);
  assert.equal(statSync(epochsPath).mode & 0o777, 0o600);
  // A new sign-in works, and the epoch survives a restart.
  const again = `${SESSION_COOKIE}=${s.auth.issue("alice")}`;
  assert.equal((await s.get("/", again)).status, 200);
  const next = await serve({ epochsPath });
  t.after(next.close);
  assert.equal((await next.get("/", again)).status, 200);
  assert.equal((await next.get("/", there)).status, 401);
});

test("without an App, sign-in says to set it up first", async (t) => {
  const s = await serve({ app: null });
  t.after(s.close);
  const res = await s.get("/auth/login");
  assert.equal(res.status, 503);
  assert.match(await res.text(), /setup link/);
});

test("the session key is created once, owner-only, and kept", () => {
  const dir = mkdtempSync(join(tmpdir(), "deckhand-key-"));
  const key = sessionKey(dir);
  assert.equal(key.length, 32);
  assert.equal(statSync(join(dir, "session.key")).mode & 0o777, 0o600);
  assert.deepEqual(sessionKey(dir), key);
});
