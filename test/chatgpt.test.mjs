// A ChatGPT plan's login: the listener holds it, refreshes it once for every run, and writes
// the rotated refresh token back.
import assert from "node:assert/strict";
import { chmod, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { createChatgptLogin } from "../listener/chatgpt.mjs";
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

test("a token about to expire: refreshed once for concurrent runs, and written back", async (t) => {
  const file = await authFile(t, { access_token: access(4) });
  const server = tokenServer();
  const login = createChatgptLogin({ file, fetch: server.fetch, now: () => NOW });
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
  const saved = JSON.parse(await readFile(file, "utf8"));
  assert.equal(saved.tokens.refresh_token, "rt-2");
  assert.equal(saved.tokens.access_token, access(60, 1));
  assert.equal(saved.tokens.id_token, idToken);
  assert.equal(saved.last_refresh, new Date(NOW).toISOString());
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  // Fresh now: no more refreshes.
  await login.headers();
  assert.equal(server.calls.length, 1);
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
  const login = createChatgptLogin({ file, fetch: server.fetch, now: () => NOW });
  for (let i = 0; i < 3; i++) {
    await assert.rejects(login.headers(), (error) => {
      assert.equal(error.status, 401);
      assert.match(error.message, /refresh_token_reused.*run `codex login` again/);
      assert.equal(error.refused, true);
      return true;
    });
  }
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
  // No new refresh token in the answer: the old one stays.
  assert.equal(JSON.parse(await readFile(file, "utf8")).tokens.refresh_token, "rt-1");
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

test("a file the listener can't rewrite: refused before any refresh spends its token", async (t) => {
  const file = await authFile(t, { access_token: access(1) });
  await chmod(dirname(file), 0o555);
  const server = tokenServer();
  const login = createChatgptLogin({ file, fetch: server.fetch, now: () => NOW });
  for (let i = 0; i < 2; i++) {
    await assert.rejects(login.headers(), (error) => {
      assert.match(
        error.message,
        /^CODEX_AUTH_FILE \(.+\) must be in a folder the listener can write to \(EACCES\)/,
      );
      assert.match(error.message, /\/data\/credentials/);
      assert.equal(error.status, 401);
      return true;
    });
  }
  assert.equal(server.calls.length, 0);
  // Writable again (a fixed mount): used at once.
  await chmod(dirname(file), 0o755);
  await login.headers();
  assert.equal(server.calls.length, 1);
});
