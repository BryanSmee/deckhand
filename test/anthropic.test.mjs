import assert from "node:assert/strict";
import { request } from "node:http";
import { test } from "node:test";
import { createAnthropicProxy, credentialName, resetOf } from "../listener/anthropic.mjs";
import { planWarning } from "../listener/upstream.mjs";
import { createBroker } from "../listener/broker.mjs";
import { AGENT_SECRETS } from "../listener/agents/index.mjs";
import { operatorSecrets, redact } from "../listener/secrets.mjs";
import { sandboxAt, serve } from "./helpers.mjs";

// A run of Claude Code's, on its provider as runs.mjs registers it.
function claudeRun(broker, provider = "anthropic") {
  const secret = broker.register("org/repo");
  broker.provide(secret, provider);
  return secret;
}

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
  {
    name = "CLAUDE_CODE_OAUTH_TOKEN",
    credential = "sk-ant-oat01-real",
    sentFrom = sandboxAt(),
  } = {},
) {
  const upstream = await fakeAnthropic(t);
  const broker = createBroker({ app: () => null, sentFrom });
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

test("the default credential: a gateway's token, then a plan's, already paid for, then an API key", () => {
  assert.equal(credentialName({ CLAUDE_CODE_OAUTH_TOKEN: "t" }), "CLAUDE_CODE_OAUTH_TOKEN");
  assert.equal(credentialName({ ANTHROPIC_API_KEY: "k" }), "ANTHROPIC_API_KEY");
  assert.equal(
    credentialName({ CLAUDE_CODE_OAUTH_TOKEN: "t", ANTHROPIC_API_KEY: "k" }),
    "CLAUDE_CODE_OAUTH_TOKEN",
  );
  // A named one: its variable, if set.
  const both = { CLAUDE_CODE_OAUTH_TOKEN: "t", ANTHROPIC_API_KEY: "k" };
  assert.equal(credentialName(both, "key"), "ANTHROPIC_API_KEY");
  assert.equal(credentialName({ CLAUDE_CODE_OAUTH_TOKEN: "t" }, "key"), null);
  assert.equal(credentialName(both, "other"), null);
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
  const secret = claudeRun(broker);
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
  const secret = claudeRun(broker);
  const res = await ask(url, { "x-api-key": secret });
  assert.equal(res.status, 200);
  await res.text();
  assert.equal(upstream.requests[0].headers["x-api-key"], "sk-ant-api03-real");
  assert.equal(upstream.requests[0].headers.authorization, undefined);
});

test("a gateway's token goes as a bearer, under the gateway's own path", async (t) => {
  const upstream = await fakeAnthropic(t);
  upstream.release();
  const broker = createBroker({ app: () => null, sentFrom: sandboxAt() });
  const proxy = createAnthropicProxy({
    broker,
    name: "ANTHROPIC_AUTH_TOKEN",
    credential: "sk-or-v1-real",
    upstream: `${upstream.url}/api`,
  });
  const { url } = await serve(t, (req, res) => proxy.handle(req, res));
  const res = await ask(url, { authorization: `Bearer ${claudeRun(broker)}` });
  assert.equal(res.status, 200);
  await res.text();
  const [sent] = upstream.requests;
  assert.equal(sent.url, "/api/v1/messages?beta=true");
  assert.equal(sent.headers.authorization, "Bearer sk-or-v1-real");
  assert.equal(sent.headers["x-api-key"], undefined);
});

// A plan and an API key both set (FALLBACKS=claude@anthropic:key): each run gets the
// credential its entry names, in that credential's header, and never the other.
async function serveBoth(t, limited = false) {
  const requests = [];
  const { url: upstreamUrl } = await serve(t, (req, res) => {
    requests.push({ headers: req.headers });
    req.resume().on("end", () => {
      if (!limited) return res.end("{}");
      res.writeHead(429, { "anthropic-ratelimit-unified-reset": "1900000000" });
      res.end('{"type":"error","error":{"type":"rate_limit_error"}}');
    });
  });
  const broker = createBroker({ app: () => null, sentFrom: sandboxAt() });
  const proxy = createAnthropicProxy({
    broker,
    name: "CLAUDE_CODE_OAUTH_TOKEN",
    credential: "sk-ant-oat01-plan",
    named: { plan: "sk-ant-oat01-plan", key: "sk-ant-api03-key" },
    upstream: upstreamUrl,
    clock: { now: () => 1_000 },
  });
  const { url } = await serve(t, (req, res) => proxy.handle(req, res));
  return { url, broker, requests, proxy };
}

test("a plan and a key: the plan's run sends its bearer, the key's run its x-api-key", async (t) => {
  const { url, broker, requests } = await serveBoth(t);
  const plan = broker.register("org/repo");
  broker.provide(plan, "anthropic");
  const key = broker.register("org/repo");
  broker.provide(key, "anthropic", null, "key");
  const named = broker.register("org/repo");
  broker.provide(named, "anthropic", null, "plan");
  for (const [secret, header] of [
    [plan, "authorization"],
    [key, "x-api-key"],
    [named, "authorization"],
  ]) {
    const res = await ask(url, { [header]: header === "x-api-key" ? secret : `Bearer ${secret}` });
    assert.equal(res.status, 200);
    await res.text();
  }
  const [onPlan, onKey, onNamed] = requests.map((r) => r.headers);
  assert.equal(onPlan.authorization, "Bearer sk-ant-oat01-plan");
  assert.equal(onPlan["x-api-key"], undefined);
  assert.equal(onKey["x-api-key"], "sk-ant-api03-key");
  assert.equal(onKey.authorization, undefined);
  assert.ok(!JSON.stringify(onKey).includes("oat01"));
  assert.ok(!JSON.stringify(onPlan).includes("api03"));
  assert.equal(onNamed.authorization, "Bearer sk-ant-oat01-plan");
});

test("a plan's 429: the run learns when its limit resets; a key's doesn't", async (t) => {
  const { url, broker } = await serveBoth(t, true);
  const plan = broker.register("org/repo");
  broker.provide(plan, "anthropic");
  const key = broker.register("org/repo");
  broker.provide(key, "anthropic", null, "key");
  await (await ask(url, { authorization: `Bearer ${plan}` })).text();
  await (await ask(url, { "x-api-key": key })).text();
  assert.equal(broker.runOf(plan).apiStatus, 429);
  assert.equal(broker.runOf(plan).apiReset, 1_900_000_000_000);
  assert.equal(broker.runOf(key).apiStatus, 429);
  assert.equal(broker.runOf(key).apiReset, null);
  // Without the header: Retry-After, else nothing.
  assert.equal(resetOf({ "retry-after": "60" }, 1_000), 61_000);
  assert.equal(resetOf({}, 1_000), null);
});

test("a run naming a credential the operator didn't set gets none, and says which", async (t) => {
  const upstream = await fakeAnthropic(t);
  const broker = createBroker({ app: () => null, sentFrom: sandboxAt() });
  const proxy = createAnthropicProxy({
    broker,
    name: "CLAUDE_CODE_OAUTH_TOKEN",
    credential: "sk-ant-oat01-plan",
    named: { plan: "sk-ant-oat01-plan" },
    upstream: upstream.url,
  });
  const { url } = await serve(t, (req, res) => proxy.handle(req, res));
  const secret = broker.register("org/repo");
  broker.provide(secret, "anthropic", null, "key");
  const res = await ask(url, { "x-api-key": secret });
  assert.equal(res.status, 503);
  assert.match((await res.json()).error.message, /no ANTHROPIC_API_KEY/);
  assert.equal(upstream.requests.length, 0);
});

// A raw request line, since fetch() would normalise these paths before sending them.
const raw = (url, path, secret, method = "POST") =>
  new Promise((resolve, reject) => {
    const req = request(`${url}/`, { path, method, headers: { "x-api-key": secret } });
    req.on("response", (res) => res.resume().on("end", () => resolve(res.statusCode)));
    req.on("error", reject);
    // Only POST has a body: Node frames none for the others.
    req.end(method === "POST" ? "{}" : undefined);
  });

test("only Anthropic's /v1 paths go on: the credential never reaches another host", async (t) => {
  const elsewhere = await fakeAnthropic(t);
  elsewhere.release();
  const host = new URL(elsewhere.url).host;
  const { url, broker, upstream } = await serveProxy(t, {
    name: "ANTHROPIC_API_KEY",
    credential: "sk-ant-api03-real",
  });
  const secret = claudeRun(broker);
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

test("only Claude Code's calls go on: not files, batches or another method", async (t) => {
  const { url, broker, upstream } = await serveProxy(t, {
    name: "ANTHROPIC_API_KEY",
    credential: "sk-ant-api03-real",
  });
  upstream.release();
  const notes = [];
  const secret = broker.register("org/repo");
  broker.provide(secret, "anthropic", (message) => notes.push(message));
  for (const [method, path] of [
    ["GET", "/anthropic/v1/files"],
    ["GET", "/anthropic/v1/files/file_1/content"],
    ["POST", "/anthropic/v1/messages/batches"],
    ["GET", "/anthropic/v1/messages"],
    ["DELETE", "/anthropic/v1/models/claude-opus-5-5"],
    ["POST", "/anthropic/v1/organizations/api_keys"],
  ]) {
    assert.equal(await raw(url, path, secret, method), 404, `${method} ${path}`);
  }
  assert.equal(upstream.requests.length, 0);
  // Each refusal is a line in the run's log, and the reply's last failed call.
  assert.equal(notes.length, 6);
  assert.match(
    notes[0],
    /refused the agent's call GET \/anthropic\/v1\/files: not an Anthropic API path/,
  );
  assert.equal(broker.runOf(secret).apiError, "not an Anthropic API path");
  for (const [method, path] of [
    ["POST", "/anthropic/v1/messages?beta=true"],
    ["POST", "/anthropic/v1/messages/count_tokens?beta=true"],
    ["GET", "/anthropic/v1/models?limit=100"],
    ["GET", "/anthropic/v1/models/claude-opus-5-5"],
  ]) {
    assert.equal(await raw(url, path, secret, method), 200, `${method} ${path}`);
  }
  assert.equal(upstream.requests.length, 4);
});

test("another agent's run, or one without a provider, gets no Claude credential", async (t) => {
  const { url, broker, upstream } = await serveProxy(t);
  for (const provider of ["openai", "google", null]) {
    const res = await ask(url, { authorization: `Bearer ${claudeRun(broker, provider)}` });
    assert.equal(res.status, 503, String(provider));
    assert.match((await res.json()).error.message, /not a run of Claude Code/);
  }
  assert.equal(upstream.requests.length, 0);
});

test("no secret, a wrong one or a finished run's: refused, and Anthropic never asked", async (t) => {
  const { url, broker, upstream } = await serveProxy(t);
  const secret = claudeRun(broker);
  broker.revoke(secret);
  for (const headers of [{}, { authorization: "Bearer guess" }, { "x-api-key": secret }]) {
    const res = await ask(url, headers);
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error.type, "authentication_error");
  }
  assert.equal(upstream.requests.length, 0);
});

test("a run's secret sent from another sandbox's address: 403, and Anthropic never asked", async (t) => {
  const sentFrom = sandboxAt("10.9.0.5");
  const { url, broker, upstream } = await serveProxy(t, { sentFrom });
  const secret = claudeRun(broker);
  for (const headers of [{ authorization: `Bearer ${secret}` }, { "x-api-key": secret }]) {
    const res = await ask(url, headers);
    assert.equal(res.status, 403);
    assert.deepEqual((await res.json()).error, {
      type: "permission_error",
      message: "Deckhand: this run's secret only works from its own sandbox",
    });
  }
  assert.deepEqual(sentFrom.asked, [
    { run: broker.runOf(secret), ip: "127.0.0.1" },
    { run: broker.runOf(secret), ip: "127.0.0.1" },
  ]);
  assert.equal(upstream.requests.length, 0);
  // What the leaked run's reply says is left alone.
  assert.equal(broker.runOf(secret).apiError, null);
});

test("without a credential set, a live run gets an error rather than an empty header", async (t) => {
  const { url, broker, upstream } = await serveProxy(t, { name: null, credential: undefined });
  const res = await ask(url, { authorization: `Bearer ${claudeRun(broker)}` });
  assert.equal(res.status, 503);
  assert.equal(upstream.requests.length, 0);
});

test("Anthropic out of reach: a 502 in Anthropic's error shape", async (t) => {
  const broker = createBroker({ app: () => null, sentFrom: sandboxAt() });
  const proxy = createAnthropicProxy({
    broker,
    name: "ANTHROPIC_API_KEY",
    credential: "k",
    upstream: "http://127.0.0.1:1",
  });
  const { url } = await serve(t, (req, res) => proxy.handle(req, res));
  const res = await ask(url, { "x-api-key": claudeRun(broker) });
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
  const broker = createBroker({ app: () => null, sentFrom: sandboxAt() });
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

  const secret = claudeRun(broker);
  broker.provide(secret, "openrouter");
  const res = await ask(url, { authorization: `Bearer ${secret}` });
  assert.equal(res.status, 200);
  await res.text();
  assert.equal(anthropic.requests.length, 0);
  assert.equal(openrouter.requests[0].url, "/api/v1/messages?beta=true");
  assert.equal(openrouter.requests[0].headers.authorization, "Bearer sk-or-v1-real");
  assert.equal(broker.runOf(secret).apiStatus, 200);

  // A provider without its credential answers so, and Anthropic gets nothing either.
  const other = claudeRun(broker);
  broker.provide(other, "empty");
  const refused = await ask(url, { authorization: `Bearer ${other}` });
  assert.equal(refused.status, 503);
  assert.match((await refused.json()).error.message, /no credential for empty/);
  assert.equal(anthropic.requests.length, 0);
});

test("a provider that can't be reached counts as a 502", async (t) => {
  const broker = createBroker({ app: () => null, sentFrom: sandboxAt() });
  const proxy = createAnthropicProxy({
    broker,
    name: "ANTHROPIC_API_KEY",
    credential: "sk-ant-api03-real",
    upstream: "http://127.0.0.1:1",
  });
  const { url } = await serve(t, (req, res) => proxy.handle(req, res));
  const secret = claudeRun(broker);
  const res = await ask(url, { "x-api-key": secret });
  assert.equal(res.status, 502);
  assert.equal(broker.runOf(secret).apiStatus, 502);
});
