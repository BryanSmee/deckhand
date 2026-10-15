import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { createAnthropicProxy, credentialName } from "../listener/anthropic.mjs";
import { createBroker } from "../listener/broker.mjs";
import { redact } from "../listener/secrets.mjs";

const listen = (server) =>
  new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`)),
  );

// A fake Anthropic that records each request and streams two events, the second one only
// once the test lets it (`release`), so streaming shows: the first arrives before.
async function fakeAnthropic(t) {
  const requests = [];
  let release;
  const released = new Promise((resolve) => (release = resolve));
  const server = createServer((req, res) => {
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
  const url = await listen(server);
  t.after(() => server.close());
  return { url, requests, release };
}

async function serve(
  t,
  { name = "CLAUDE_CODE_OAUTH_TOKEN", credential = "sk-ant-oat01-real" } = {},
) {
  const upstream = await fakeAnthropic(t);
  const broker = createBroker({ app: () => null });
  const proxy = createAnthropicProxy({ broker, name, credential, upstream: upstream.url });
  const server = createServer((req, res) => proxy.handle(req, res));
  const url = await listen(server);
  t.after(() => server.close());
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

test("an OAuth run's secret is swapped for the token, and the answer streams back", async (t) => {
  const { url, broker, upstream } = await serve(t);
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
  const { url, broker, upstream } = await serve(t, {
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
  const server = createServer((req, res) => proxy.handle(req, res));
  const url = await listen(server);
  t.after(() => server.close());
  const res = await ask(url, { authorization: `Bearer ${broker.register("org/repo")}` });
  assert.equal(res.status, 200);
  await res.text();
  const [sent] = upstream.requests;
  assert.equal(sent.url, "/api/v1/messages?beta=true");
  assert.equal(sent.headers.authorization, "Bearer sk-or-v1-real");
  assert.equal(sent.headers["x-api-key"], undefined);
});

test("no secret, a wrong one or a finished run's: refused, and Anthropic never asked", async (t) => {
  const { url, broker, upstream } = await serve(t);
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
  const { url, broker, upstream } = await serve(t, { name: null, credential: undefined });
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
  const server = createServer((req, res) => proxy.handle(req, res));
  const url = await listen(server);
  t.after(() => server.close());
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
