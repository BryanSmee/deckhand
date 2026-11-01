// A ChatGPT plan's login: the models service holds it, refreshes it once for every run and
// every copy of the service, and keeps the rotated refresh token sealed in its store.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmod, readFile, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { openStore } from "../lib/store.mjs";
import { createChatgptLogin } from "../models/chatgpt.mjs";
import { loginSeal } from "../models/logins.mjs";
import { tempDir } from "./helpers.mjs";

const NOW = Date.parse("2026-10-16T12:00:00Z");
const jwt = (claims) => `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;
// An access token that expires `minutes` after NOW.
const access = (minutes, n = 1) => jwt({ exp: (NOW + minutes * 60_000) / 1000, n });
const idToken = jwt({
  "https://api.openai.com/auth": { chatgpt_account_id: "acct-1", chatgpt_plan_type: "pro" },
});

async function authFile(t, tokens = {}) {
  const dir = tempDir(t, "deckhand-chatgpt-");
  const file = join(dir, "auth.json");
  await writeFile(
    file,
    JSON.stringify({
      auth_mode: "chatgpt",
      OPENAI_API_KEY: null,
      tokens: { id_token: idToken, access_token: access(60), refresh_token: "rt-1", ...tokens },
      last_refresh: "2026-10-16T11:00:00Z",
    }),
  );
  return file;
}

// A fake auth.openai.com: answers each refresh with `answer(call)`, recording the bodies.
function tokenServer(
  answer = (n) => ({ access_token: access(60, n), refresh_token: `rt-${n + 1}` }),
) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    const out = answer(calls.length);
    if (out instanceof Response) return out;
    return new Response(JSON.stringify(out), { status: 200 });
  };
  return { calls, fetch };
}

test("a fresh login's headers: its access token and account, no refresh", async (t) => {
  const file = await authFile(t);
  const server = tokenServer();
  const login = createChatgptLogin({ file, fetch: server.fetch, now: () => NOW });
  assert.deepEqual(await login.headers(), {
    authorization: `Bearer ${access(60)}`,
    "chatgpt-account-id": "acct-1",
  });
  assert.equal(server.calls.length, 0);
  // What runs' output is redacted of.
  assert.deepEqual(login.secrets(), [access(60), "rt-1"]);
});

test("a token about to expire: refreshed once for concurrent runs, and kept sealed in the store", async (t) => {
  const file = await authFile(t, { access_token: access(4) });
  const server = tokenServer();
  const store = openStore("memory:");
  const seal = loginSeal(randomBytes(32));
  const login = createChatgptLogin({ file, store, seal, fetch: server.fetch, now: () => NOW });
  const all = await Promise.all([1, 2, 3, 4, 5].map(() => login.headers()));
  // One refresh, with the one refresh token: a second would spend a rotated one.
  assert.equal(server.calls.length, 1);
  assert.deepEqual(server.calls[0].body, {
    client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
    grant_type: "refresh_token",
    refresh_token: "rt-1",
  });
  assert.equal(server.calls[0].url, "https://auth.openai.com/oauth/token");
  for (const headers of all) assert.equal(headers.authorization, `Bearer ${access(60, 1)}`);
  // Kept sealed in the store, the file left as it was.
  const raw = await store.get("login:chatgpt");
  assert.equal(raw.kid, seal.kid);
  assert.ok(!raw.sealed.includes("rt-2") && !raw.sealed.includes(access(60, 1)));
  const { login: saved } = JSON.parse(seal.open(raw.sealed));
  assert.equal(saved.tokens.refresh_token, "rt-2");
  assert.equal(saved.tokens.access_token, access(60, 1));
  assert.equal(saved.tokens.id_token, idToken);
  assert.equal(saved.last_refresh, new Date(NOW).toISOString());
  assert.equal(JSON.parse(await readFile(file, "utf8")).tokens.refresh_token, "rt-1");
  // Fresh now: no more refreshes.
  await login.headers();
  assert.equal(server.calls.length, 1);
  // A copy started anew on the same store takes the refreshed login, not the file's spent one.
  const next = createChatgptLogin({ file, store, seal, fetch: server.fetch, now: () => NOW });
  assert.equal((await next.headers()).authorization, `Bearer ${access(60, 1)}`);
  assert.equal(server.calls.length, 1);
});

test("two copies of the service on one store: a single refresh, the other waits for it", async (t) => {
  const file = await authFile(t, { access_token: access(4) });
  const store = openStore("memory:");
  const seal = loginSeal(randomBytes(32));
  let release;
  const held = new Promise((resolve) => (release = resolve));
  const calls = [];
  const fetch = async (url, init) => {
    calls.push(JSON.parse(init.body));
    await held;
    return new Response(JSON.stringify({ access_token: access(60, 1), refresh_token: "rt-2" }));
  };
  const sleep = () => new Promise((resolve) => setTimeout(resolve, 5));
  const copies = ["a", "b"].map((holder) =>
    createChatgptLogin({ file, store, seal, holder, fetch, sleep, now: () => NOW }),
  );
  const asked = copies.map((copy) => copy.headers());
  await new Promise((resolve) => setTimeout(resolve, 30));
  // One holds the lease and refreshes; the other waits, with no refresh of its own.
  assert.equal(calls.length, 1);
  release();
  for (const headers of await Promise.all(asked)) {
    assert.equal(headers.authorization, `Bearer ${access(60, 1)}`);
  }
  assert.equal(calls.length, 1);
  assert.equal(await store.lease("login:chatgpt:refresh"), null);
});

test("an access token the backend refused is refreshed before the next call", async (t) => {
  const file = await authFile(t);
  const server = tokenServer();
  const login = createChatgptLogin({ file, fetch: server.fetch, now: () => NOW });
  const { authorization } = await login.headers();
  login.refused("Bearer someone-else's");
  await login.headers();
  assert.equal(server.calls.length, 0);
  login.refused(authorization);
  assert.equal((await login.headers()).authorization, `Bearer ${access(60, 1)}`);
  assert.equal(server.calls.length, 1);
});

test("a spent refresh token: a 401 for fallbacks, no retry until the file is replaced", async (t) => {
  const file = await authFile(t, { access_token: access(1) });
  let spent = true;
  const server = tokenServer((n) =>
    spent
      ? new Response(JSON.stringify({ error: { code: "refresh_token_reused" } }), { status: 401 })
      : { access_token: access(60, n), refresh_token: "rt-new" },
  );
  const store = openStore("memory:");
  const seal = loginSeal(randomBytes(32));
  const login = createChatgptLogin({ file, store, seal, fetch: server.fetch, now: () => NOW });
  for (let i = 0; i < 3; i++) {
    await assert.rejects(login.headers(), (error) => {
      assert.equal(error.status, 401);
      assert.match(error.message, /refresh_token_reused.*run `codex login` again/);
      assert.equal(error.refused, true);
      return true;
    });
  }
  assert.equal(server.calls.length, 1);
  // Nor does another copy of the service on the same store.
  const other = createChatgptLogin({ file, store, seal, fetch: server.fetch, now: () => NOW });
  await assert.rejects(other.headers(), (error) => error.refused === true);
  assert.equal(server.calls.length, 1);
  // A new `codex login`, copied over the old one.
  spent = false;
  const json = JSON.parse(await readFile(file, "utf8"));
  json.tokens.access_token = access(60, 9);
  await writeFile(file, JSON.stringify(json));
  await utimes(file, new Date(NOW), new Date(NOW + 1000));
  assert.equal((await login.headers()).authorization, `Bearer ${access(60, 9)}`);
  assert.equal(server.calls.length, 1);
});

test("auth.openai.com failing for a while: an error, and the next call tries again", async (t) => {
  const file = await authFile(t, { access_token: access(1) });
  let down = true;
  const server = tokenServer((n) =>
    down ? new Response("busy", { status: 503 }) : { access_token: access(60, n) },
  );
  const login = createChatgptLogin({ file, fetch: server.fetch, now: () => NOW });
  await assert.rejects(login.headers(), (error) => error.status === undefined);
  down = false;
  assert.equal((await login.headers()).authorization, `Bearer ${access(60, 2)}`);
  // No new refresh token in the answer: the old one stays, for the next refresh.
  login.refused(`Bearer ${access(60, 2)}`);
  await login.headers();
  assert.equal(server.calls.at(-1).body.refresh_token, "rt-1");
});

test("an auth.json without a ChatGPT login, or none at all: an error", async (t) => {
  const file = await authFile(t);
  await writeFile(file, JSON.stringify({ OPENAI_API_KEY: "sk-1" }));
  const login = createChatgptLogin({ file, fetch: tokenServer().fetch, now: () => NOW });
  await assert.rejects(login.headers(), /holds no ChatGPT login/);
  const missing = createChatgptLogin({ file: `${file}.gone`, now: () => NOW });
  await assert.rejects(missing.headers(), /ENOENT/);
});

test("an auth.json that isn't JSON: an error that quotes none of it", async (t) => {
  const file = await authFile(t);
  await writeFile(file, '{"tokens": {"access_token": "eyJhbGciOiJSUzI1NiIs-cut-off');
  const login = createChatgptLogin({ file, fetch: tokenServer().fetch, now: () => NOW });
  await assert.rejects(login.headers(), (error) => {
    assert.match(error.message, /holds no ChatGPT login/);
    assert.doesNotMatch(error.message, /eyJ|access_token/);
    return true;
  });
});

test("a FedRAMP workspace gets its header; a token without expiry refreshes after 8 days", async (t) => {
  const fedramp = jwt({
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct-2",
      chatgpt_account_is_fedramp: true,
    },
  });
  const file = await authFile(t, { id_token: fedramp, access_token: "opaque" });
  const server = tokenServer();
  let now = NOW;
  const login = createChatgptLogin({ file, fetch: server.fetch, now: () => now });
  assert.deepEqual(await login.headers(), {
    authorization: "Bearer opaque",
    "chatgpt-account-id": "acct-2",
    "x-openai-fedramp": "true",
  });
  now = Date.parse("2026-10-24T11:00:00Z");
  await login.headers();
  assert.equal(server.calls.length, 1);
});

test("a read-only file: used as it is, never written", async (t) => {
  const file = await authFile(t, { access_token: access(1) });
  await chmod(file, 0o444);
  const server = tokenServer();
  const login = createChatgptLogin({ file, fetch: server.fetch, now: () => NOW });
  assert.equal((await login.headers()).authorization, `Bearer ${access(60, 1)}`);
  assert.equal(server.calls.length, 1);
  assert.equal(JSON.parse(await readFile(file, "utf8")).tokens.refresh_token, "rt-1");
});

test("a copy with another models.key refuses the stored login, never writes the file's over it", async (t) => {
  const file = await authFile(t, { access_token: access(4) });
  const store = openStore("memory:");
  const server = tokenServer();
  const a = createChatgptLogin({
    file,
    store,
    seal: loginSeal(randomBytes(32)),
    fetch: server.fetch,
    now: () => NOW,
  });
  await a.headers();
  const before = await store.get("login:chatgpt");
  const b = createChatgptLogin({
    file,
    store,
    seal: loginSeal(randomBytes(32)),
    fetch: server.fetch,
    now: () => NOW,
  });
  await assert.rejects(b.headers(), /sealed with another models\.key than this copy's/);
  assert.deepEqual(await store.get("login:chatgpt"), before);
  assert.equal(server.calls.length, 1);
});

test("current(): the headers of a fresh login, none for one due, and never a refresh", async (t) => {
  const server = tokenServer();
  const fresh = createChatgptLogin({
    file: await authFile(t),
    fetch: server.fetch,
    now: () => NOW,
  });
  assert.equal((await fresh.current()).authorization, `Bearer ${access(60)}`);
  const due = createChatgptLogin({
    file: await authFile(t, { access_token: access(2) }),
    fetch: server.fetch,
    now: () => NOW,
  });
  assert.equal(await due.current(), null);
  assert.equal(server.calls.length, 0);
});
