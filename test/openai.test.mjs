// Codex's endpoint: the run's secret in, the operator's OPENAI_API_KEY out, the answer streamed.
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { test } from "node:test";
import { createBroker } from "../listener/broker.mjs";
import { createOpenAiProxy } from "../listener/openai.mjs";

const listen = (server) =>
  new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`)),
  );

// A fake OpenAI that records each request and streams two events, the second one only once
// the test lets it (`release`).
async function fakeOpenAi(t) {
  const requests = [];
  let release;
  const released = new Promise((resolve) => (release = resolve));
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", async () => {
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      res.writeHead(200, { "content-type": "text/event-stream", "x-request-id": "req_1" });
      res.write('event: response.created\ndata: {"type":"response.created"}\n\n');
      await released;
      res.end('event: response.completed\ndata: {"type":"response.completed"}\n\n');
    });
  });
  const url = await listen(server);
  t.after(() => server.close());
  return { url, requests, release };
}

async function serve(t, { credential = "sk-proj-real", path = "/v1" } = {}) {
  const upstream = await fakeOpenAi(t);
  const broker = createBroker({ app: () => null });
  const proxy = createOpenAiProxy({ broker, credential, upstream: `${upstream.url}${path}` });
  const server = createServer((req, res) => proxy.handle(req, res));
  const url = await listen(server);
  t.after(() => server.close());
  return { url, broker, upstream };
}

// What Codex sends to its provider's base URL, <broker>/openai.
const ask = (url, headers) =>
  fetch(`${url}/openai/responses`, {
    method: "POST",
    headers: { "content-type": "application/json", originator: "codex_exec", ...headers },
    body: JSON.stringify({ model: "gpt-6.1-sol", stream: true }),
  });

test("a run's secret is swapped for the key, and the answer streams back", async (t) => {
  const { url, broker, upstream } = await serve(t);
  const secret = broker.register("org/repo");
  const res = await ask(url, { authorization: `Bearer ${secret}` });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-request-id"), "req_1");
  const reader = res.body.getReader();
  // The first event, while OpenAI still holds the second.
  assert.match(new TextDecoder().decode((await reader.read()).value), /response\.created/);
  upstream.release();
  let rest = "";
  for (let r = await reader.read(); !r.done; r = await reader.read()) {
    rest += new TextDecoder().decode(r.value);
  }
  assert.match(rest, /response\.completed/);

  const [sent] = upstream.requests;
  assert.equal(sent.method, "POST");
  assert.equal(sent.url, "/v1/responses");
  assert.equal(sent.headers.authorization, "Bearer sk-proj-real");
  assert.equal(sent.headers.originator, "codex_exec");
  assert.deepEqual(JSON.parse(sent.body), { model: "gpt-6.1-sol", stream: true });
  assert.ok(!JSON.stringify(sent).includes(secret));
});

test("the operator's OPENAI_BASE_URL keeps its own path", async (t) => {
  const { url, broker, upstream } = await serve(t, { path: "/openai/v1/" });
  upstream.release();
  const res = await ask(url, { authorization: `Bearer ${broker.register("org/repo")}` });
  assert.equal(res.status, 200);
  await res.text();
  assert.equal(upstream.requests[0].url, "/openai/v1/responses");
});

// A raw request line, since fetch() would normalise these paths before sending them.
const raw = (url, path, secret) =>
  new Promise((resolve, reject) => {
    const headers = { authorization: `Bearer ${secret}` };
    const req = request(`${url}/`, { path, method: "POST", headers });
    req.on("response", (res) => res.resume().on("end", () => resolve(res.statusCode)));
    req.on("error", reject);
    req.end("{}");
  });

test("only paths under the base URL go on: the key never reaches another host", async (t) => {
  const elsewhere = await fakeOpenAi(t);
  elsewhere.release();
  const host = new URL(elsewhere.url).host;
  const { url, broker, upstream } = await serve(t);
  upstream.release();
  const secret = broker.register("org/repo");
  for (const path of [
    `/openai///${host}/steal`,
    `/openai//${host}/steal`,
    `/openai/http://${host}/steal`,
    `/openai/\\${host}/steal`,
    `/openai/../../steal`,
    `/openai/responses/../../steal`,
    `/openai/./responses`,
    `/openai/responses//x`,
    `/openai/`,
  ]) {
    assert.equal(await raw(url, path, secret), 404, path);
  }
  assert.equal(elsewhere.requests.length, 0);
  assert.equal(upstream.requests.length, 0);
  // Codex's own calls, with their query, still go on.
  assert.equal(await raw(url, "/openai/responses/compact?x=1", secret), 200);
  assert.equal(upstream.requests[0].url, "/v1/responses/compact?x=1");
});

test("no secret, a wrong one or a finished run's: refused, and OpenAI never asked", async (t) => {
  const { url, broker, upstream } = await serve(t);
  const secret = broker.register("org/repo");
  broker.revoke(secret);
  for (const headers of [{}, { authorization: "Bearer guess" }, { authorization: secret }]) {
    const res = await ask(url, headers);
    assert.equal(res.status, 401);
    const { error } = await res.json();
    assert.equal(error.type, "invalid_request_error");
    assert.match(error.message, /^Deckhand: unknown or finished run/);
  }
  assert.equal(upstream.requests.length, 0);
});

test("without OPENAI_API_KEY, a live run gets an error rather than an empty header", async (t) => {
  const { url, broker, upstream } = await serve(t, { credential: null });
  const res = await ask(url, { authorization: `Bearer ${broker.register("org/repo")}` });
  assert.equal(res.status, 503);
  assert.equal(upstream.requests.length, 0);
});

test("OpenAI out of reach: a 502 in OpenAI's error shape", async (t) => {
  const broker = createBroker({ app: () => null });
  const proxy = createOpenAiProxy({ broker, credential: "k", upstream: "http://127.0.0.1:1" });
  const server = createServer((req, res) => proxy.handle(req, res));
  const url = await listen(server);
  t.after(() => server.close());
  const res = await ask(url, { authorization: `Bearer ${broker.register("org/repo")}` });
  assert.equal(res.status, 502);
  assert.match((await res.json()).error.message, /OpenAI can't be reached/);
});
