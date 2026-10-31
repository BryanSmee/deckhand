// The listener's port for the runner (listener/services-http.mjs): a run's first tokens only
// while it starts, and the repos' tarballs and blobs, for the runner alone, its service tokens
// checked with the broker service's keys.
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

async function services(t, { bound = networkCallers("runner=127.0.0.0/8"), repos = [] } = {}) {
  const pendingTokens = new Map();
  const asked = [];
  const github = async (repo, method, path) => {
    asked.push(`${method} ${path}`);
    if (path.includes("missing")) return new Response("{}", { status: 404 });
    if (path.includes("/contents/")) return Response.json({ type: "file", sha: "sha-1" });
    return new Response(`tarball of ${repo}`);
  };
  const server = createServicesHttp({
    config: { repos },
    keys,
    bound,
    github,
    pendingTokens,
  });
  const url = `http://127.0.0.1:${await listening(server)}`;
  server.unref();
  t.after(() => server.close());
  return { url, pendingTokens, asked };
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
});

test("tarballs: the runner's, of an allowed repo, streamed from GitHub; nothing else of it", async (t) => {
  const { url, asked } = await services(t, { repos: ["org/*"] });
  const tarball = (path, headers) => fetch(`${url}/tarballs/${path}`, { headers });
  const res = await tarball(`org/repo/${encodeURIComponent("feature/x")}`, as("runner", "github"));
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "tarball of org/repo");
  assert.deepEqual(asked, ["GET /repos/org/repo/tarball/feature%2Fx"]);
  assert.equal((await tarball("org/missing/main", as("runner", "github"))).status, 404);
  // Without a ref, the default branch's.
  assert.equal((await tarball("org/repo", as("runner", "github"))).status, 200);
  assert.equal(asked.at(-1), "GET /repos/org/repo/tarball");
  // Names that would make the API path another one, decoded or not.
  for (const path of [
    `org/x${encodeURIComponent("/../../../user/repos?")}/HEAD`,
    `org/..%2F..%2Fuser/main`,
    `org/repo/${encodeURIComponent("../../user")}`,
    `org/repo/${encodeURIComponent("main?x=1")}`,
    `org/%E0%A4/main`,
  ]) {
    assert.equal((await tarball(path, as("runner", "github"))).status, 400, path);
  }
  // Another owner's repo, and the broker's audience.
  assert.equal((await tarball("other/repo/main", as("runner", "github"))).status, 403);
  assert.equal((await tarball("org/repo/main", as("runner", "broker"))).status, 401);
  // Anything else of GitHub's: no such endpoint, to anyone.
  const other = await fetch(`${url}/repos/org/repo/contents/x`, {
    headers: as("runner", "github"),
  });
  assert.ok([401, 403].includes(other.status));
  assert.equal(asked.length, 3);
});

test("blobs: a file's blob id for the runner, at a ref or the default branch; plain paths only", async (t) => {
  const { url, asked } = await services(t, { repos: ["org/*"] });
  const blob = (query, headers = as("runner", "github")) =>
    fetch(`${url}/blobs/org/repo?${query}`, { headers });
  assert.deepEqual(await (await blob("path=docker%2FDockerfile")).json(), { sha: "sha-1" });
  assert.deepEqual(await (await blob("path=Dockerfile&ref=abc")).json(), { sha: "sha-1" });
  assert.deepEqual(asked, [
    "GET /repos/org/repo/contents/docker/Dockerfile",
    "GET /repos/org/repo/contents/Dockerfile?ref=abc",
  ]);
  assert.equal((await blob("path=../x")).status, 400);
  assert.equal((await blob("path=Dockerfile&ref=..")).status, 400);
  assert.equal((await blob("path=missing")).status, 404);
  assert.equal((await blob("path=Dockerfile", as("edge", "github"))).status, 403);
});
