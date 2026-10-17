import assert from "node:assert/strict";
import { request } from "node:http";
import { test } from "node:test";
import { createAnthropicProxy, credentialName } from "../listener/anthropic.mjs";
import { planWarning } from "../listener/upstream.mjs";
import { createBroker } from "../listener/broker.mjs";
import { AGENT_SECRETS } from "../listener/agents/index.mjs";
import { operatorSecrets, redact } from "../listener/secrets.mjs";
import { serve } from "./helpers.mjs";

// A fake Anthropic that records each request and streams two events, the second one only
// once the test lets it (`release`), so streaming shows: the first arrives before.
async function fakeAnthropic(t) {
  const requests = [];
  let release;
  const released = new Promise((resolve) => (release = resolve));
  const { url } = await serve(t, (req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", async () => {
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      res.writeHead(200, { "content-type": "text/event-stream", "request-id": "req_1" });
      res.write("event: message_start\ndata: {}\n\n");
      await released;
      res.end("event: message_stop\ndata: {}\n\n");
    });
  });
  return { url, requests, release };
}

async function serveProxy(
  t,
  { name = "CLAUDE_CODE_OAUTH_TOKEN", credential = "sk-ant-oat01-real" } = {},
) {
  const upstream = await fakeAnthropic(t);
  const broker = createBroker({ app: () => null });
  const proxy = createAnthropicProxy({ broker, name, credential, upstream: upstream.url });
  const { url } = await serve(t, (req, res) => proxy.handle(req, res));
  return { url, broker, upstream };
}

const ask = (url, headers) =>
  fetch(`${url}/anthropic/v1/messages?beta=true`, {
    method: "POST",
    headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", ...headers },
    body: JSON.stringify({ model: "claude-opus-5-5", stream: true }),
  });

test("the credential is the one Claude Code would use: an API key before an OAuth token", () => {
  assert.equal(credentialName({ CLAUDE_CODE_OAUTH_TOKEN: "t" }), "CLAUDE_CODE_OAUTH_TOKEN");
  assert.equal(
    credentialName({ CLAUDE_CODE_OAUTH_TOKEN: "t", ANTHROPIC_API_KEY: "k" }),
    "ANTHROPIC_API_KEY",
  );
  assert.equal(
    credentialName({
      CLAUDE_CODE_OAUTH_TOKEN: "t",
      ANTHROPIC_API_KEY: "k",
      ANTHROPIC_AUTH_TOKEN: "a",
    }),
    "ANTHROPIC_AUTH_TOKEN",
  );
  assert.equal(credentialName({ ANTHROPIC_API_KEY: "" }), null);
});

test("a plan's token is warned about at start, an API key or a gateway's token isn't", () => {
  assert.match(
    planWarning("CLAUDE_CODE_OAUTH_TOKEN"),
    /^Warning: CLAUDE_CODE_OAUTH_TOKEN is a Claude plan's/,
  );
  assert.match(
    planWarning("CODEX_AUTH_FILE"),
    /^Warning: CODEX_AUTH_FILE is a ChatGPT plan's login/,
  );
  assert.match(planWarning("CLAUDE_CODE_OAUTH_TOKEN"), /usually licensed to one person/);
  assert.match(planWarning("CLAUDE_CODE_OAUTH_TOKEN"), /For teams, use an API key\.$/);
  assert.equal(planWarning("ANTHROPIC_API_KEY"), null);
  assert.equal(planWarning("ANTHROPIC_AUTH_TOKEN"), null);
  assert.equal(planWarning("OPENAI_API_KEY"), null);
  assert.equal(planWarning(null), null);
});

test("an OAuth run's secret is swapped for the token, and the answer streams back", async (t) => {
  const { url, broker, upstream } = await serveProxy(t);
  const secret = broker.register("org/repo");
  const res = await ask(url, {
    authorization: `Bearer ${secret}`,
    "anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("request-id"), "req_1");
  const reader = res.body.getReader();
  // The first event, while Anthropic still holds the second.
  assert.match(new TextDecoder().decode((await reader.read()).value), /message_start/);
  upstream.release();
  let rest = "";
  for (let r = await reader.read(); !r.done; r = await reader.read()) {
    rest += new TextDecoder().decode(r.value);
  }
  assert.match(rest, /message_stop/);

  const [sent] = upstream.requests;
  assert.equal(sent.method, "POST");
  assert.equal(sent.url, "/v1/messages?beta=true");
  assert.equal(sent.headers.authorization, "Bearer sk-ant-oat01-real");
  assert.equal(sent.headers["x-api-key"], undefined);
  assert.equal(sent.headers["anthropic-beta"], "claude-code-20250219,oauth-2025-04-20");
  assert.equal(sent.headers["anthropic-version"], "2023-06-01");
  assert.deepEqual(JSON.parse(sent.body), { model: "claude-opus-5-5", stream: true });
  assert.ok(!JSON.stringify(sent).includes(secret));
});

test("an API key run's secret is swapped for the key", async (t) => {
  const { url, broker, upstream } = await serveProxy(t, {
    name: "ANTHROPIC_API_KEY",
    credential: "sk-ant-api03-real",
  });
  upstream.release();
  const secret = broker.register("org/repo");
  const res = await ask(url, { "x-api-key": secret });
  assert.equal(res.status, 200);
  await res.text();
  assert.equal(upstream.requests[0].headers["x-api-key"], "sk-ant-api03-real");
  assert.equal(upstream.requests[0].headers.authorization, undefined);
});

test("a gateway's token goes as a bearer, under the gateway's own path", async (t) => {
  const upstream = await fakeAnthropic(t);
  upstream.release();
  const broker = createBroker({ app: () => null });
  const proxy = createAnthropicProxy({
    broker,
    name: "ANTHROPIC_AUTH_TOKEN",
    credential: "sk-or-v1-real",
    upstream: `${upstream.url}/api`,
  });
  const { url } = await serve(t, (req, res) => proxy.handle(req, res));
  const res = await ask(url, { authorization: `Bearer ${broker.register("org/repo")}` });
  assert.equal(res.status, 200);
  await res.text();
  const [sent] = upstream.requests;
  assert.equal(sent.url, "/api/v1/messages?beta=true");
  assert.equal(sent.headers.authorization, "Bearer sk-or-v1-real");
  assert.equal(sent.headers["x-api-key"], undefined);
});

// A raw request line, since fetch() would normalise these paths before sending them.
const raw = (url, path, secret) =>
  new Promise((resolve, reject) => {
    const req = request(`${url}/`, { path, method: "POST", headers: { "x-api-key": secret } });
    req.on("response", (res) => res.resume().on("end", () => resolve(res.statusCode)));
    req.on("error", reject);
    req.end("{}");
  });

test("only Anthropic's /v1 paths go on: the credential never reaches another host", async (t) => {
  const elsewhere = await fakeAnthropic(t);
  elsewhere.release();
  const host = new URL(elsewhere.url).host;
  const { url, broker, upstream } = await serveProxy(t, {
    name: "ANTHROPIC_API_KEY",
    credential: "sk-ant-api03-real",
  });
  const secret = broker.register("org/repo");
  for (const path of [
    `/anthropic///${host}/steal`,
    `/anthropic//${host}/steal`,
    `/anthropic/http://${host}/steal`,
    `/anthropic/\\${host}/steal`,
    `/anthropic/v1/../../steal`,
    `/anthropic/v1/./messages`,
    `/anthropic/v1//messages`,
    `/anthropic/v1`,
    `/anthropic/oauth/token`,
  ]) {
    assert.equal(await raw(url, path, secret), 404, path);
  }
  assert.equal(elsewhere.requests.length, 0);
  assert.equal(upstream.requests.length, 0);
});

test("no secret, a wrong one or a finished run's: refused, and Anthropic never asked", async (t) => {
  const { url, broker, upstream } = await serveProxy(t);
  const secret = broker.register("org/repo");
  broker.revoke(secret);
  for (const headers of [{}, { authorization: "Bearer guess" }, { "x-api-key": secret }]) {
    const res = await ask(url, headers);
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error.type, "authentication_error");
  }
  assert.equal(upstream.requests.length, 0);
});

test("without a credential set, a live run gets an error rather than an empty header", async (t) => {
  const { url, broker, upstream } = await serveProxy(t, { name: null, credential: undefined });
  const res = await ask(url, { authorization: `Bearer ${broker.register("org/repo")}` });
  assert.equal(res.status, 503);
  assert.equal(upstream.requests.length, 0);
});

test("Anthropic out of reach: a 502 in Anthropic's error shape", async (t) => {
  const broker = createBroker({ app: () => null });
  const proxy = createAnthropicProxy({
    broker,
    name: "ANTHROPIC_API_KEY",
    credential: "k",
    upstream: "http://127.0.0.1:1",
  });
  const { url } = await serve(t, (req, res) => proxy.handle(req, res));
  const res = await ask(url, { "x-api-key": broker.register("org/repo") });
  assert.equal(res.status, 502);
  assert.equal((await res.json()).type, "error");
});

test("redaction replaces every occurrence of each secret, and leaves short values alone", () => {
  const token = "sk-ant-oat01-abcdefghijklmnop";
  const secret = "f".repeat(64);
  assert.equal(
    redact(`token ${token}, again ${token}; run ${secret}`, [token, secret, undefined, "", "abc"]),
    "token [redacted], again [redacted]; run [redacted]",
  );
  assert.equal(redact("abc", ["abc"]), "abc");
});

test("operatorSecrets: the agents' credentials from the environment, and the ChatGPT sign-in's", () => {
  const env = { ANTHROPIC_API_KEY: "sk-ant-api03-abcdefghijklmnop", OTHER: "not a secret" };
  const secrets = operatorSecrets({ openai: { secrets: () => ["chatgpt-token"] } }, env);
  assert.ok(AGENT_SECRETS.includes("ANTHROPIC_API_KEY"));
  assert.ok(secrets.includes(env.ANTHROPIC_API_KEY));
  assert.ok(!secrets.includes(env.OTHER));
  assert.equal(secrets.at(-1), "chatgpt-token");
  assert.equal(secrets.length, AGENT_SECRETS.length + 1);
  // Before the ChatGPT proxy exists.
  assert.equal(operatorSecrets({}, env).length, AGENT_SECRETS.length);
});

test("a run on another provider goes to its URL with its key; the provider's status is kept", async (t) => {
  const anthropic = await fakeAnthropic(t);
  const openrouter = await fakeAnthropic(t);
  openrouter.release();
  const broker = createBroker({ app: () => null });
  const proxy = createAnthropicProxy({
    broker,
    name: "CLAUDE_CODE_OAUTH_TOKEN",
    credential: "sk-ant-oat01-real",
    upstream: anthropic.url,
    providers: {
      openrouter: {
        name: "OPENROUTER_API_KEY",
        credential: "sk-or-v1-real",
        upstream: `${openrouter.url}/api`,
      },
      empty: { name: "OPENROUTER_API_KEY", credential: "", upstream: openrouter.url },
    },
  });
  const { url } = await serve(t, (req, res) => proxy.handle(req, res));

  const secret = broker.register("org/repo");
  broker.provide(secret, "openrouter");
  const res = await ask(url, { authorization: `Bearer ${secret}` });
  assert.equal(res.status, 200);
  await res.text();
  assert.equal(anthropic.requests.length, 0);
  assert.equal(openrouter.requests[0].url, "/api/v1/messages?beta=true");
  assert.equal(openrouter.requests[0].headers.authorization, "Bearer sk-or-v1-real");
  assert.equal(broker.runOf(secret).apiStatus, 200);

  // A provider without its credential answers so, and Anthropic gets nothing either.
  const other = broker.register("org/repo");
  broker.provide(other, "empty");
  const refused = await ask(url, { authorization: `Bearer ${other}` });
  assert.equal(refused.status, 503);
  assert.match((await refused.json()).error.message, /no credential for empty/);
  assert.equal(anthropic.requests.length, 0);
});

test("a provider that can't be reached counts as a 502", async (t) => {
  const broker = createBroker({ app: () => null });
  const proxy = createAnthropicProxy({
    broker,
    name: "ANTHROPIC_API_KEY",
    credential: "sk-ant-api03-real",
    upstream: "http://127.0.0.1:1",
  });
  const { url } = await serve(t, (req, res) => proxy.handle(req, res));
  const secret = broker.register("org/repo");
  const res = await ask(url, { "x-api-key": secret });
  assert.equal(res.status, 502);
  assert.equal(broker.runOf(secret).apiStatus, 502);
});
