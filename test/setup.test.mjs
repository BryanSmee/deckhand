import assert from "node:assert/strict";
import { test } from "node:test";
import { APP_EVENTS, APP_PERMISSIONS } from "../listener/github-app.mjs";
import { createSetup, manifest } from "../listener/setup.mjs";
import { serve, testConfig } from "./helpers.mjs";

const conversion = {
  id: 5,
  slug: "deckhand-x",
  client_id: "Iv1.x",
  client_secret: "cs",
  webhook_secret: "whs",
  pem: "-----BEGIN RSA PRIVATE KEY-----\n…",
  owner: { login: "alice" },
  html_url: "https://github.com/apps/deckhand-x",
};

async function serveSetup(t, env = {}) {
  const config = testConfig(env);
  const stored = [];
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, method: init?.method ?? "GET" });
    if (url.endsWith("/app-manifests/good/conversions")) {
      return Response.json(conversion, { status: 201 });
    }
    if (url.includes("/users/deckhand-x%5Bbot%5D")) return Response.json({ id: 77 });
    return new Response("bad code", { status: 404 });
  };
  let n = 0;
  const setup = createSetup({
    config,
    fetch,
    configured: () => stored.length > 0,
    onConfigured: (c) => stored.push(c),
    random: () => `rand${++n}`.padEnd(12, "0"),
  });
  const { url: base } = await serve(t, (req, res) => {
    if (!setup.handle(req, res)) res.writeHead(404).end();
  });
  const token = new URL(setup.link()).searchParams.get("token");
  const post = (form) =>
    globalThis.fetch(`${base}/setup`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form),
    });
  return { base, token, stored, calls, post };
}

function unescape(html) {
  return html
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

test("the manifest asks for the App's permissions and events, webhook on /webhook", () => {
  const m = manifest({ name: "d", publicUrl: "https://hooks.example.com" });
  assert.equal(m.public, false);
  assert.equal(m.hook_attributes.url, "https://hooks.example.com/webhook");
  assert.equal(m.redirect_url, "https://hooks.example.com/setup/callback");
  assert.deepEqual(m.callback_urls, ["https://hooks.example.com/auth/callback"]);
  assert.deepEqual(m.default_permissions, APP_PERMISSIONS);
  assert.deepEqual(m.default_events, APP_EVENTS);
});

test("the setup form needs the one-time token from the logs", async (t) => {
  const s = await serveSetup(t);
  assert.equal((await fetch(`${s.base}/setup`)).status, 403);
  assert.equal((await fetch(`${s.base}/setup?token=wrong`)).status, 403);
  const form = await fetch(`${s.base}/setup?token=${s.token}`, {
    headers: {
      "x-forwarded-proto": "https",
      "x-forwarded-host": "hooks.example.com",
    },
  });
  assert.equal(form.status, 200);
  assert.match(await form.text(), /value="https:\/\/hooks\.example\.com"/);
  assert.equal((await s.post({ token: "wrong", name: "d", url: "https://x.example" })).status, 403);
});

test("from the form to stored credentials and the install page", async (t) => {
  const s = await serveSetup(t);
  const res = await s.post({
    token: s.token,
    name: "deckhand-x",
    org: "",
    url: "https://hooks.example.com/",
  });
  assert.equal(res.status, 200);
  const html = unescape(await res.text());
  const action = /action="([^"]+)"/.exec(html)[1];
  const state = new URL(action).searchParams.get("state");
  assert.equal(
    new URL(action).origin + new URL(action).pathname,
    "https://github.com/settings/apps/new",
  );
  const sent = JSON.parse(/name="manifest" value="(.+)" \/>/.exec(html)[1]);
  assert.equal(sent.hook_attributes.url, "https://hooks.example.com/webhook");

  // GitHub redirects back with a code; a wrong state is refused and spends nothing.
  assert.equal((await fetch(`${s.base}/setup/callback?code=good&state=forged`)).status, 400);
  assert.equal(s.calls.length, 0);
  const done = await fetch(`${s.base}/setup/callback?code=good&state=${state}`, {
    redirect: "manual",
  });
  assert.equal(done.status, 302);
  assert.equal(
    done.headers.get("location"),
    "https://github.com/apps/deckhand-x/installations/new",
  );
  assert.equal(s.stored.length, 1);
  assert.equal(s.stored[0].webhook_secret, "whs");
  assert.equal(s.stored[0].pem, conversion.pem);
  assert.equal(s.stored[0].bot_id, 77);
  assert.equal(s.stored[0].public_url, "https://hooks.example.com");

  // Closed once an App is stored: the state can't be replayed, the form is gone.
  const again = await fetch(`${s.base}/setup/callback?code=good&state=${state}`);
  assert.match(await again.text(), /Already set up/);
  assert.match(await (await fetch(`${s.base}/setup?token=${s.token}`)).text(), /Already set up/);
  assert.equal(s.stored.length, 1);
});

test("an organization's App is created under the organization", async (t) => {
  const s = await serveSetup(t, { PUBLIC_URL: "https://hooks.example.com" });
  const res = await s.post({
    token: s.token,
    name: "d",
    org: "my-org",
    url: "https://hooks.example.com",
  });
  assert.match(
    await res.text(),
    /action="https:\/\/github\.com\/organizations\/my-org\/settings\/apps\/new\?state=/,
  );
  const bad = await s.post({
    token: s.token,
    name: "d",
    org: "../evil",
    url: "https://hooks.example.com",
  });
  assert.equal(bad.status, 400);
});

test("a code GitHub refuses stores nothing", async (t) => {
  const s = await serveSetup(t);
  const html = unescape(
    await (await s.post({ token: s.token, name: "d", url: "https://h.example" })).text(),
  );
  const state = new URL(/action="([^"]+)"/.exec(html)[1]).searchParams.get("state");
  assert.equal((await fetch(`${s.base}/setup/callback?code=bad&state=${state}`)).status, 502);
  assert.equal(s.stored.length, 0);
});
