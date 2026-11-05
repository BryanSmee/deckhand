// The listener's port for the runner (listener/services-http.mjs): a run's first tokens only
// while it starts, for the runner alone, its service tokens checked with the broker service's
// keys. The repos' tarballs and blobs are the github service's (github-service.test.mjs).
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import { networkCallers, signServiceToken } from "../lib/service-token.mjs";
import { keyId } from "../lib/tokens.mjs";
import { createServicesHttp } from "../listener/services-http.mjs";
import { assertHealth, listening } from "./helpers.mjs";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const signing = { privateKey, kid: keyId(publicKey) };
const keys = new Map([[signing.kid, publicKey]]);

async function services(t, { bound = networkCallers("runner=127.0.0.0/8") } = {}) {
  const pendingTokens = new Map();
  const server = createServicesHttp({ keys, bound, pendingTokens });
  const url = `http://127.0.0.1:${await listening(server)}`;
  server.unref();
  t.after(() => server.close());
  return { url, pendingTokens };
}

const as = (sub, aud) => ({
  authorization: `Bearer ${signServiceToken({ sub, aud }, signing)}`,
});

test("a runner's token from another network: refused", async (t) => {
  const { url, pendingTokens } = await services(t, { bound: networkCallers("runner=10.9.0.0/16") });
  pendingTokens.set("dh-a-1", async () => ({}));
  const res = await fetch(`${url}/runs/dh-a-1/tokens`, {
    method: "POST",
    headers: as("runner", "orchestrator"),
    body: JSON.stringify({ sandbox: "net-1" }),
  });
  assert.equal(res.status, 403);
  // What the broker service serves now, never here.
  assert.equal((await fetch(`${url}/service-keys`)).status, 401);
});

test("a run's first tokens: only while it starts, only for the runner", async (t) => {
  const { url, pendingTokens } = await services(t);
  const ask = (headers) =>
    fetch(`${url}/runs/dh-a-1/tokens`, {
      method: "POST",
      headers,
      body: JSON.stringify({ sandbox: "net-1" }),
    });
  assert.equal((await ask(as("runner", "orchestrator"))).status, 404);
  pendingTokens.set("dh-a-1", async (sandbox) => ({ DECKHAND_RUN_TOKEN: `for ${sandbox}` }));
  assert.deepEqual(await (await ask(as("runner", "orchestrator"))).json(), {
    env: { DECKHAND_RUN_TOKEN: "for net-1" },
  });
  // Edge never: no route takes it; a token for another service (the broker's), nor.
  assert.equal((await ask(as("edge", "orchestrator"))).status, 403);
  assert.equal((await ask(as("runner", "broker"))).status, 401);
  assert.equal((await ask(as("runner", "github"))).status, 401);
  assert.equal((await ask({})).status, 401);
  // The repos' tarballs: the github service's now, never here.
  const tarball = await fetch(`${url}/tarballs/org/repo`, {
    headers: as("runner", "orchestrator"),
  });
  assert.equal(tarball.status, 403);
});

test("edge's requests: the dashboard's API with the user it signed in, from edge's token alone", async (t) => {
  const pendingTokens = new Map();
  const seen = [];
  let ready = null;
  const server = createServicesHttp({
    keys,
    bound: networkCallers("runner+edge=127.0.0.0/8"),
    pendingTokens,
    edge: () => ready,
  });
  const url = `http://127.0.0.1:${await listening(server)}`;
  server.unref();
  t.after(() => server.close());
  const ask = (headers, path = "/edge/api/state") =>
    fetch(`${url}${path}`, {
      headers: {
        "x-deckhand-user": "Alice",
        "x-deckhand-host": "deck.example.com",
        "x-deckhand-origin": "https://deck.example.com",
        ...headers,
      },
    });
  // Not ready yet (the state coming back from the store): 503, which edge asks again.
  assert.equal((await ask(as("edge", "orchestrator"))).status, 503);
  ready = (req, res, who) => {
    seen.push({ url: req.url, host: req.headers.host, origin: req.headers.origin, ...who });
    res.end("ok");
  };
  const res = await ask(as("edge", "orchestrator"));
  assert.equal(res.status, 200);
  assert.deepEqual(seen, [
    {
      url: "/api/state",
      host: "deck.example.com",
      origin: "https://deck.example.com",
      user: "alice",
      local: false,
    },
  ]);
  // The runner's token, none, or another service's: the user header counts for nothing.
  assert.equal((await ask(as("runner", "orchestrator"))).status, 403);
  assert.equal((await ask({})).status, 401);
  assert.equal((await ask(as("edge", "runner"))).status, 401);
  // A name that isn't a login is no user; /status from edge's own container is local.
  await ask({ ...as("edge", "orchestrator"), "x-deckhand-user": "a b" });
  await ask({ ...as("edge", "orchestrator"), "x-deckhand-local": "1" }, "/edge/status");
  assert.deepEqual(
    seen.slice(1).map(({ url, user, local }) => ({ url, user, local })),
    [
      { url: "/api/state", user: null, local: false },
      { url: "/status", user: "alice", local: true },
    ],
  );
  // Edge never gets a run's first tokens.
  pendingTokens.set("dh-a-1", async () => ({}));
  const tokens = await fetch(`${url}/runs/dh-a-1/tokens`, {
    method: "POST",
    headers: as("edge", "orchestrator"),
    body: JSON.stringify({ sandbox: "net-1" }),
  });
  assert.equal(tokens.status, 403);
});

test("a copy waiting for the lease answers its probes, and 503 to every call", async (t) => {
  let acting = false;
  const server = createServicesHttp({
    keys,
    bound: networkCallers("runner+edge=127.0.0.0/8"),
    pendingTokens: new Map([["dh-a-1", async () => ({ A: "1" })]]),
    edge: () => (req, res) => res.end("ok"),
    active: () => acting,
  });
  const url = `http://127.0.0.1:${await listening(server)}`;
  server.unref();
  t.after(() => server.close());
  const health = await fetch(`${url}/health`);
  assert.equal(health.status, 200);
  assertHealth(await health.json());
  assert.equal((await fetch(`${url}/ready`)).status, 503);
  const tokens = () =>
    fetch(`${url}/runs/dh-a-1/tokens`, {
      method: "POST",
      headers: as("runner", "orchestrator"),
      body: JSON.stringify({ sandbox: "net-1" }),
    });
  assert.equal((await tokens()).status, 503);
  assert.equal(
    (await fetch(`${url}/edge/status`, { headers: as("edge", "orchestrator") })).status,
    503,
  );
  acting = true;
  assert.equal((await fetch(`${url}/ready`)).status, 200);
  assert.equal((await tokens()).status, 200);
});

test("a copy that took the lease, the broker's keys not read yet: 503, tried again, never 401", async (t) => {
  // Its keys come after the lease (broker-service.mjs start()): a 401 then would be edge's
  // answer to the dashboard, where a 503 is tried again (lib/service-client.mjs).
  let read = false;
  const server = createServicesHttp({
    keys: new Map(),
    keysRead: () => read,
    bound: networkCallers("edge=127.0.0.0/8"),
    pendingTokens: new Map(),
    edge: () => (req, res) => res.end("ok"),
  });
  const url = `http://127.0.0.1:${await listening(server)}`;
  server.unref();
  t.after(() => server.close());
  const call = () => fetch(`${url}/edge/status`, { headers: as("edge", "orchestrator") });
  assert.equal((await call()).status, 503);
  assert.equal((await fetch(`${url}/ready`)).status, 200);
  read = true;
  // Read, a token signed with a key they don't have is refused as before.
  assert.equal((await call()).status, 401);
});

test("/ready says how many items of the orchestrator's state wait for the store", async (t) => {
  let waiting = 0;
  const server = createServicesHttp({
    keys,
    bound: null,
    pendingTokens: new Map(),
    waiting: () => waiting,
  });
  const url = `http://127.0.0.1:${await listening(server)}`;
  server.unref();
  t.after(() => server.close());
  assert.deepEqual(await (await fetch(`${url}/ready`)).json(), { ok: true, waiting: 0 });
  // The store away: still the copy that acts, its writes waiting.
  waiting = 3;
  const ready = await fetch(`${url}/ready`);
  assert.equal(ready.status, 200);
  assert.deepEqual(await ready.json(), { ok: true, waiting: 3 });
});
