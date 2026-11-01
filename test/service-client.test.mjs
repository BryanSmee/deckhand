// Calling another service (lib/service-client.mjs): its token and the orchestrator's epoch on
// each call, a copy that refuses or is away tried again (its other copy next), for a while.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { EPOCH_HEADER, serviceClient, Unavailable } from "../lib/service-client.mjs";
import { listening, serve } from "./helpers.mjs";

const fast = { sleep: async () => {}, retryMs: 1, maxRetryMs: 1 };

// An address nothing listens on: a call there is refused before it is made.
async function nobody() {
  const server = createServer();
  const port = await listening(server);
  await new Promise((resolve) => server.close(resolve));
  return `http://127.0.0.1:${port}`;
}

test("each call carries the caller's token and epoch, JSON both ways", async (t) => {
  const seen = [];
  const { url } = await serve(t, (req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ auth: req.headers.authorization, epoch: req.headers[EPOCH_HEADER], body });
      res.writeHead(req.url === "/bad" ? 409 : 200, { "content-type": "application/json" });
      res.end(JSON.stringify(req.url === "/bad" ? { message: "stale" } : { ok: true }));
    });
  });
  const client = serviceClient({
    service: "runner",
    urls: url,
    token: async () => "Bearer t",
    epoch: () => 7,
    ...fast,
  });
  assert.deepEqual(await client.json("POST", "/x", { body: { a: 1 } }), { ok: true });
  assert.deepEqual(seen[0], { auth: "Bearer t", epoch: "7", body: '{"a":1}' });
  // Another status: an error with the service's own message, not tried again.
  const error = await client.json("GET", "/bad").catch((e) => e);
  assert.equal(error.status, 409);
  assert.equal(error.reason, "stale");
  assert.match(error.message, /^the runner service: 409 stale$/);
  assert.equal(seen.length, 2);
});

test("a copy that is passive or away: the next one, until one answers", async (t) => {
  let calls = 0;
  const passive = await serve(t, (req, res) => (calls++, res.writeHead(503).end("passive")));
  const active = await serve(t, (req, res) => res.end("{}"));
  const said = [];
  const client = serviceClient({
    service: "runner",
    urls: `${await nobody()},${passive.url},${active.url}`,
    log: (line) => said.push(line),
    ...fast,
  });
  assert.deepEqual(await client.json("GET", "/x"), {});
  assert.equal(calls, 1);
  // Said once, not at each try.
  assert.equal(said.length, 1);
  assert.match(said[0], /^The runner service: ECONNREFUSED, trying again$/);
});

test("a service that doesn't come back within its wait: Unavailable", async (t) => {
  const passive = await serve(t, (req, res) => res.writeHead(503).end("draining"));
  let now = 0;
  const client = serviceClient({
    service: "runner",
    urls: passive.url,
    waitMs: 1000,
    now: () => now,
    sleep: async () => (now += 400),
  });
  await assert.rejects(client.json("GET", "/x"), (error) => {
    assert.ok(error instanceof Unavailable);
    assert.match(error.message, /didn't answer \(503 draining\)/);
    return true;
  });
  assert.equal(now, 1200);
  assert.throws(() => serviceClient({ service: "runner", urls: "" }), /no URL/);
});

test("a call cut once made is tried again, unless it mustn't be made twice", async (t) => {
  let calls = 0;
  // The first call reaches it, and its connection breaks before the answer.
  const flaky = await serve(t, (req, res) =>
    ++calls === 1 ? req.socket.destroy() : res.end("{}"),
  );
  const client = serviceClient({ service: "runner", urls: flaky.url, ...fast });
  assert.deepEqual(await client.json("POST", "/caches", { body: {} }), {});
  assert.equal(calls, 2);
  calls = 0;
  await assert.rejects(
    client.json("POST", "/logins/antigravity/refresh", { body: {}, once: true }),
  );
  assert.equal(calls, 1);
  // Refused before it was made: tried again, `once` or not.
  const refused = serviceClient({
    service: "runner",
    urls: `${await nobody()},${flaky.url}`,
    ...fast,
  });
  assert.deepEqual(await refused.json("POST", "/x", { body: {}, once: true }), {});
});

test("a URL fetch() can't call fails at start, and an error of the call's own isn't waited on", async () => {
  for (const urls of ["runner:8080", "ftp://runner", "http://runner:8080,nothing"]) {
    assert.throws(
      () => serviceClient({ service: "runner", urls, ...fast }),
      /runner service's URL/,
    );
  }
  // fetch()'s own TypeError for a call it can't make: thrown at once, not tried for minutes.
  let calls = 0;
  const client = serviceClient({
    service: "runner",
    urls: "http://runner:8080",
    fetch: async () => {
      calls++;
      throw new TypeError("Failed to parse URL from http://runner:8080/x y");
    },
    ...fast,
  });
  await assert.rejects(client.json("GET", "/x"), /Failed to parse URL/);
  assert.equal(calls, 1);
});
