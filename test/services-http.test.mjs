// The listener's port for the runner (listener/services-http.mjs): a run's first tokens only
// while it starts, for the runner alone, its service tokens checked with the broker service's
// keys. The repos' tarballs and blobs are the github service's (github-service.test.mjs).
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import { networkCallers, signServiceToken } from "../lib/service-token.mjs";
import { keyId } from "../lib/tokens.mjs";
import { createServicesHttp } from "../listener/services-http.mjs";
import { listening } from "./helpers.mjs";

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
