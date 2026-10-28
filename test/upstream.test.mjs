// What every API endpoint shares (upstream.mjs): a cap on each run's calls in flight, a
// provider that stops sending cut off, and refused calls noted a bounded number of times.
import assert from "node:assert/strict";
import { request } from "node:http";
import { test } from "node:test";
import { createBroker } from "../listener/broker.mjs";
import { baseOf, createApiProxy, MAX_IN_FLIGHT, MAX_NOTED } from "../listener/upstream.mjs";
import { sandboxAt, serve } from "./helpers.mjs";

// A provider that answers each call's headers and a first event, then holds the rest until
// the test lets it (`release`), or forever (`stall`).
async function slowProvider(t, { headers = true } = {}) {
  const requests = [];
  const held = new Set();
  const { url } = await serve(t, (req, res) => {
    requests.push(req.url);
    req.resume();
    req.on("end", () => {
      if (headers) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("data: first\n\n");
      }
      held.add(res);
    });
  });
  const release = () => {
    for (const res of held) {
      if (!res.headersSent) res.writeHead(200);
      res.end("data: last\n\n");
    }
    held.clear();
  };
  return { url, requests, release, held };
}

// Timers the test fires itself.
function fakeClock() {
  const timers = new Set();
  return {
    timers,
    setTimeout: (fn, ms) => {
      const timer = { fn, ms };
      timers.add(timer);
      return timer;
    },
    clearTimeout: (timer) => timers.delete(timer),
    fire: () => [...timers].forEach((timer) => (timers.delete(timer), timer.fn())),
  };
}

async function proxyTo(t, upstream, options = {}) {
  const broker = createBroker({ sentFrom: sandboxAt() });
  const logs = [];
  const proxy = createApiProxy({
    broker,
    pathRe: /^\/api\/([a-z]+)$/,
    routes: [["POST", /^call$/]],
    errorShape: {
      body: (type, message) => ({ error: { type, message } }),
      auth: "auth",
      unavailable: "unavailable",
      notFound: "not_found",
      forbidden: "forbidden",
      busy: "busy",
    },
    notApi: "not an API path",
    secretOf: (req) => req.headers["x-key"],
    routeOf: () => ({ base: baseOf(upstream.url), what: "Provider" }),
    drop: ["x-key"],
    authHeaders: async () => ({ "x-key": "operator" }),
    log: (line) => logs.push(line),
    ...options,
  });
  const { url } = await serve(t, (req, res) => proxy.handle(req, res));
  const call = (secret) =>
    fetch(`${url}/api/call`, { method: "POST", headers: { "x-key": secret }, body: "{}" });
  return { url, broker, call, logs };
}

const until = async (check) => {
  while (!check()) await new Promise((resolve) => setTimeout(resolve, 5));
};

test(`a run's call past ${MAX_IN_FLIGHT} in flight answers 429; other runs aren't held`, async (t) => {
  const upstream = await slowProvider(t);
  const { broker, call } = await proxyTo(t, upstream);
  const secret = broker.register("org/repo");
  const open = await Promise.all(Array.from({ length: MAX_IN_FLIGHT }, () => call(secret)));
  assert.ok(open.every((res) => res.status === 200));
  await until(() => upstream.held.size === MAX_IN_FLIGHT);

  const refused = await call(secret);
  assert.equal(refused.status, 429);
  assert.deepEqual(await refused.json(), {
    error: { type: "busy", message: `Deckhand: more than ${MAX_IN_FLIGHT} calls at once` },
  });
  assert.equal(upstream.requests.length, MAX_IN_FLIGHT);
  // Another run's calls still go on.
  const other = await call(broker.register("org/other"));
  assert.equal(other.status, 200);

  // Once its calls end, the run may call again.
  upstream.release();
  await Promise.all([...open, other].map((res) => res.text()));
  const again = await call(secret);
  assert.equal(again.status, 200);
  upstream.release();
  await again.text();
});

test("a provider that stops sending is cut off once the idle timer fires", async (t) => {
  const upstream = await slowProvider(t);
  const clock = fakeClock();
  const { broker, call, logs } = await proxyTo(t, upstream, { clock, idleMs: 600_000 });
  const res = await call(broker.register("org/repo"));
  assert.equal(res.status, 200);
  const reader = res.body.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /first/);
  // Restarted by each chunk: one timer, of 10 minutes.
  assert.equal(clock.timers.size, 1);
  assert.equal([...clock.timers][0].ms, 600_000);
  clock.fire();
  await assert.rejects(async () => {
    while (!(await reader.read()).done);
  });
  assert.match(logs.join("\n"), /Provider: POST \/call: no bytes for 600 s/);
  await until(() => [...upstream.held].every((r) => r.destroyed || r.socket?.destroyed));
});

test("a provider that never answers: a 502 once the idle timer fires", async (t) => {
  const upstream = await slowProvider(t, { headers: false });
  const clock = fakeClock();
  const { broker, call } = await proxyTo(t, upstream, { clock });
  const secret = broker.register("org/repo");
  const pending = call(secret);
  await until(() => upstream.held.size === 1);
  clock.fire();
  const res = await pending;
  assert.equal(res.status, 502);
  assert.match((await res.json()).error.message, /Provider can't be reached/);
  assert.equal(broker.runOf(secret).apiStatus, 502);
  assert.equal(clock.timers.size, 0);
});

test("refused calls: each noted once in the run's log, and only so many", async (t) => {
  const upstream = await slowProvider(t);
  const { url, broker, logs } = await proxyTo(t, upstream);
  const notes = [];
  const secret = broker.register("org/repo");
  broker.provide(secret, "test", (message) => notes.push(message));
  const refuse = async (path) => {
    const res = await fetch(`${url}/api/${path}`, { headers: { "x-key": secret } });
    assert.equal(res.status, 404);
    await res.text();
  };
  // A sandbox looping on one refused path: one line.
  for (let i = 0; i < 50; i++) await refuse("files");
  assert.deepEqual(notes, ["Deckhand refused the agent's call GET /api/files: not an API path"]);
  // Many paths: the first MAX_NOTED, then one line saying the rest aren't noted.
  for (let i = 1; i <= 3 * MAX_NOTED; i++) await refuse("x".repeat(i));
  await refuse("files");
  assert.equal(notes.length, MAX_NOTED + 1);
  assert.match(notes.at(-1), new RegExp(`only the first ${MAX_NOTED} are noted`));
  assert.equal(logs.filter((line) => /refused/.test(line)).length, MAX_NOTED);
  assert.equal(upstream.requests.length, 0);
});

test("a request still uploading after the provider answered starts no timer", async (t) => {
  // Answers at once, without reading the body: a 413, say.
  const { url: early } = await serve(t, (req, res) => res.writeHead(413).end());
  const clock = fakeClock();
  const { url, broker } = await proxyTo(t, { url: early }, { clock });
  const secret = broker.register("org/repo");
  const req = request(`${url}/api/call`, { method: "POST", headers: { "x-key": secret } });
  req.on("error", () => {});
  req.write("first");
  const res = await new Promise((resolve) => req.on("response", resolve));
  assert.equal(res.statusCode, 413);
  await new Promise((resolve) => res.resume().on("end", resolve));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(clock.timers.size, 0);
  req.write("late");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(clock.timers.size, 0);
  req.destroy();
});

test("a refused call's path is redacted, and doesn't hide a provider's failure", async (t) => {
  const upstream = await slowProvider(t);
  const { url, broker, logs } = await proxyTo(t, upstream, {
    pathRe: /^\/api\/([A-Za-z0-9_]+)$/,
  });
  const notes = [];
  const secret = broker.register("org/repo", undefined, { secret: "s".repeat(40) });
  broker.provide(secret, "test", (message) => notes.push(message));
  const token = `ghs_${"A".repeat(36)}`;
  broker.runOf(secret).apiError = "Provider answered 529";
  for (const path of [secret, token, `x/${secret}`]) {
    const res = await fetch(`${url}/api/${path}`, { headers: { "x-key": secret } });
    assert.equal(res.status, 404);
    await res.text();
  }
  // The secret's and the token's paths read the same once redacted: noted once.
  assert.equal(notes.length, 2);
  for (const line of [...notes, ...logs]) {
    assert.ok(!line.includes(secret) && !line.includes(token), line);
  }
  assert.match(notes[0], /GET \/api\/\[redacted\]/);
  // The reply still quotes the provider's failure; the refusal is in the run's log.
  assert.equal(broker.runOf(secret).apiError, "Provider answered 529");
});
