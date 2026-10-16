// Codex's endpoint: the run's secret in, the operator's OPENAI_API_KEY out, the answer streamed.
import assert from "node:assert/strict";
import { request } from "node:http";
import { test } from "node:test";
import { createBroker } from "../listener/broker.mjs";
import { createOpenAiProxy } from "../listener/openai.mjs";
import { serve } from "./helpers.mjs";

// A fake OpenAI that records each request and streams two events, the second one only once
// the test lets it (`release`).
async function fakeOpenAi(t) {
  const requests = [];
  let release;
  const released = new Promise((resolve) => (release = resolve));
  const { url } = await serve(t, (req, res) => {
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
  return { url, requests, release };
}

async function serveProxy(t, { credential = "sk-proj-real", path = "/v1" } = {}) {
  const upstream = await fakeOpenAi(t);
  const broker = createBroker({ app: () => null });
  const proxy = createOpenAiProxy({ broker, credential, upstream: `${upstream.url}${path}` });
  const { url } = await serve(t, (req, res) => proxy.handle(req, res));
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
  const { url, broker, upstream } = await serveProxy(t);
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
  const { url, broker, upstream } = await serveProxy(t, { path: "/openai/v1/" });
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
  const { url, broker, upstream } = await serveProxy(t);
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
  const { url, broker, upstream } = await serveProxy(t);
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
  const { url, broker, upstream } = await serveProxy(t, { credential: null });
  const res = await ask(url, { authorization: `Bearer ${broker.register("org/repo")}` });
  assert.equal(res.status, 503);
  assert.equal(upstream.requests.length, 0);
});

test("OpenAI out of reach: a 502 in OpenAI's error shape", async (t) => {
  const broker = createBroker({ app: () => null });
  const proxy = createOpenAiProxy({ broker, credential: "k", upstream: "http://127.0.0.1:1" });
  const { url } = await serve(t, (req, res) => proxy.handle(req, res));
  const res = await ask(url, { authorization: `Bearer ${broker.register("org/repo")}` });
  assert.equal(res.status, 502);
  assert.match((await res.json()).error.message, /OpenAI can't be reached/);
});

// With a ChatGPT plan's login (chatgpt.mjs) instead of a key.
async function servePlan(t, login) {
  const upstream = await fakeOpenAi(t);
  const broker = createBroker({ app: () => null });
  const proxy = createOpenAiProxy({
    broker,
    credential: null,
    login,
    upstream: "http://127.0.0.1:1/v1",
    chatgptUrl: `${upstream.url}/backend-api/codex`,
  });
  const { url } = await serve(t, (req, res) => proxy.handle(req, res));
  return { url, broker, upstream };
}

test("a plan's login: the call goes to ChatGPT's Codex backend with its headers", async (t) => {
  const refused = [];
  const login = {
    headers: async () => ({ authorization: "Bearer plan-access", "chatgpt-account-id": "acct-1" }),
    refused: (authorization) => refused.push(authorization),
  };
  const { url, broker, upstream } = await servePlan(t, login);
  upstream.release();
  const secret = broker.register("org/repo");
  const res = await ask(url, {
    authorization: `Bearer ${secret}`,
    // The sandbox can't pick another workspace of the account.
    "chatgpt-account-id": "acct-other",
    "x-openai-fedramp": "true",
  });
  assert.equal(res.status, 200);
  await res.text();
  const [call] = upstream.requests;
  assert.equal(call.url, "/backend-api/codex/responses");
  assert.equal(call.headers.authorization, "Bearer plan-access");
  assert.equal(call.headers["chatgpt-account-id"], "acct-1");
  assert.equal(call.headers["x-openai-fedramp"], undefined);
  assert.equal(call.headers.originator, "codex_exec");
  assert.deepEqual(refused, []);
});

test("a plan's login the backend refuses is marked, for a refresh before the next call", async (t) => {
  const refused = [];
  const login = {
    headers: async () => ({ authorization: "Bearer plan-access" }),
    refused: (authorization) => refused.push(authorization),
  };
  const { url: upstreamUrl } = await serve(t, (req, res) => {
    res.writeHead(401, { "content-type": "application/json" });
    res.end('{"error":{"message":"token expired"}}');
  });
  const broker = createBroker({ app: () => null });
  const proxy = createOpenAiProxy({ broker, login, chatgptUrl: `${upstreamUrl}/codex` });
  const { url } = await serve(t, (req, res) => proxy.handle(req, res));
  const secret = broker.register("org/repo");
  const res = await ask(url, { authorization: `Bearer ${secret}` });
  assert.equal(res.status, 401);
  assert.deepEqual(refused, ["Bearer plan-access"]);
  assert.equal(broker.runOf(secret).apiStatus, 401);
});

test("a plan's login that can't be used: a 503, and its status for fallbacks", async (t) => {
  const spent = Object.assign(new Error("the ChatGPT login can't be refreshed (401)"), {
    status: 401,
  });
  const login = { headers: async () => Promise.reject(spent), refused: () => {} };
  const { url, broker, upstream } = await servePlan(t, login);
  const secret = broker.register("org/repo");
  const res = await ask(url, { authorization: `Bearer ${secret}` });
  assert.equal(res.status, 503);
  assert.match((await res.json()).error.message, /^Deckhand: the ChatGPT login can't be refreshed/);
  assert.equal(broker.runOf(secret).apiStatus, 401);
  assert.equal(upstream.requests.length, 0);
});
