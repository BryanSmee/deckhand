// Service tokens (lib/service-token.mjs): signed by the broker, checked offline by the service
// called, bound to the caller's network, and each endpoint open to the callers its table names.
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { request } from "node:http";
import { test } from "node:test";
import { Refused, send } from "../lib/http.mjs";
import { calls, CALLS, SERVICES } from "../lib/services.mjs";
import {
  issueServiceTokens,
  networkCallers,
  SERVICE_TOKEN_TTL_MS,
  serviceGuard,
  serviceTokens,
  signServiceToken,
  verifyServiceToken,
} from "../lib/service-token.mjs";
import { keyId, RUN_AUDIENCE, signToken, TOKEN_VERSION } from "../lib/tokens.mjs";
import { serve } from "./helpers.mjs";

function keyPair() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const kid = keyId(publicKey);
  return { signing: { privateKey, kid }, keys: new Map([[kid, publicKey]]) };
}
const { signing, keys } = keyPair();

// The github service's table, as the issue gives it: edge reads, only the orchestrator writes.
const ROUTES = {
  "GET /repos/:owner/:repo/config": ["edge", "orchestrator"],
  "POST /tokens": ["orchestrator"],
  "GET /tarballs/*": ["runner"],
};

// edge's and the orchestrator's networks to the github service.
const bound = networkCallers("edge=172.30.1.0/24, orchestrator=172.30.2.0/24");
const EDGE_SIDE = "172.30.1.2";
const ORCHESTRATOR_SIDE = "172.30.2.2";

const NOW = 1_800_000_000_000;
const guard = serviceGuard({ service: "github", keys, routes: ROUTES, bound, now: () => NOW });

const call = ({ method = "GET", url, token, local = EDGE_SIDE }) => ({
  method,
  url,
  headers: token ? { authorization: `Bearer ${token}` } : {},
  socket: { localAddress: local },
});
const tokenFor = (sub, aud = "github", now = NOW) =>
  signServiceToken({ sub, aud }, signing, { now });

function refused(fn, status, pattern) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof Refused, error.stack);
    assert.equal(error.status, status);
    assert.match(error.message, pattern);
    return true;
  });
}

test("a caller's token, from its network, on an endpoint its table gives it: through", () => {
  const edge = tokenFor("edge");
  assert.equal(guard(call({ url: "/repos/o/r/config?ref=main", token: edge })), "edge");
  const orchestrator = tokenFor("orchestrator");
  assert.equal(
    guard(call({ method: "POST", url: "/tokens", token: orchestrator, local: ORCHESTRATOR_SIDE })),
    "orchestrator",
  );
  // IPv4-mapped, as a dual-stack socket reports it.
  assert.equal(
    guard(call({ url: "/repos/o/r/config", token: edge, local: `::ffff:${EDGE_SIDE}` })),
    "edge",
  );
});

test("no token, or none in a Bearer header: 401", () => {
  refused(() => guard(call({ url: "/repos/o/r/config" })), 401, /needed/);
  const req = call({ url: "/repos/o/r/config" });
  req.headers.authorization = `Basic ${tokenFor("edge")}`;
  refused(() => guard(req), 401, /needed/);
});

test("a token for another service, or a run token: 401", () => {
  refused(
    () => guard(call({ url: "/repos/o/r/config", token: tokenFor("edge", "orchestrator") })),
    401,
    /not meant for this service/,
  );
  const run = signToken(
    { ver: TOKEN_VERSION, sub: "edge" },
    { ...signing, audience: RUN_AUDIENCE, ttlMs: 60_000, now: NOW },
  );
  refused(() => guard(call({ url: "/repos/o/r/config", token: run })), 401, /not meant/);
});

test("an expired token, or one another key signed: 401", () => {
  const old = tokenFor("edge", "github", NOW - SERVICE_TOKEN_TTL_MS);
  refused(() => guard(call({ url: "/repos/o/r/config", token: old })), 401, /expired/);
  // Still valid a second before its end.
  const almost = tokenFor("edge", "github", NOW - SERVICE_TOKEN_TTL_MS + 1000);
  assert.equal(guard(call({ url: "/repos/o/r/config", token: almost })), "edge");
  const other = keyPair();
  const forged = signServiceToken({ sub: "orchestrator", aud: "github" }, other.signing, {
    now: NOW,
  });
  refused(() => guard(call({ url: "/repos/o/r/config", token: forged })), 401, /unknown key/);
});

test("a caller its table doesn't name on an endpoint: 403, and an endpoint not in it to all", () => {
  // edge, already inside, may read a config but never mint a token.
  refused(
    () => guard(call({ method: "POST", url: "/tokens", token: tokenFor("edge") })),
    403,
    /edge may not POST \/tokens/,
  );
  refused(
    () => guard(call({ method: "DELETE", url: "/repos/o/r/config", token: tokenFor("edge") })),
    403,
    /may not/,
  );
  refused(
    () =>
      guard(call({ url: "/anything", token: tokenFor("orchestrator"), local: ORCHESTRATOR_SIDE })),
    403,
    /may not GET \/anything/,
  );
  // One segment per `:x`: no more.
  refused(
    () => guard(call({ url: "/repos/o/r/x/config", token: tokenFor("edge") })),
    403,
    /may not/,
  );
});

test("a token arriving on another caller's network: 403, wherever it was stolen from", () => {
  // The orchestrator's token, replayed from edge (which reaches the github service only on its
  // own network): refused, though the orchestrator may call the endpoint.
  refused(
    () =>
      guard(
        call({ method: "POST", url: "/tokens", token: tokenFor("orchestrator"), local: EDGE_SIDE }),
      ),
    403,
    /from another service's network/,
  );
  // On a network that is no caller's at all.
  refused(
    () => guard(call({ url: "/repos/o/r/config", token: tokenFor("edge"), local: "10.9.9.9" })),
    403,
    /another service's network/,
  );
});

test("the network check is turned off only by saying so", () => {
  assert.throws(
    () => serviceGuard({ service: "github", keys, routes: ROUTES }),
    /bound: networkCallers\(\), or null/,
  );
  const kube = serviceGuard({
    service: "github",
    keys,
    routes: ROUTES,
    bound: null,
    now: () => NOW,
  });
  assert.equal(
    kube(call({ url: "/repos/o/r/config", token: tokenFor("edge"), local: "10.1.1.1" })),
    "edge",
  );
  assert.throws(
    () => serviceGuard({ service: "github", keys, routes: { "GET /x": ["sandbox"] }, bound: null }),
    /sandbox\?/,
  );
});

test("SERVICE_NETWORKS: service=subnet, nothing else", () => {
  assert.equal(bound("172.30.2.200"), "orchestrator");
  assert.equal(bound("172.30.3.1"), null);
  assert.equal(bound(undefined), null);
  assert.equal(networkCallers("")("172.30.1.1"), null);
  assert.throws(() => networkCallers("sandbox=10.0.0.0/24"), /expected service=subnet/);
  assert.throws(() => networkCallers("edge=10.0.0.1/24"), /expected service=subnet/);
  assert.throws(() => networkCallers("edge"), /expected service=subnet/);
  assert.throws(
    () => networkCallers("edge=172.30.0.0/16,orchestrator=172.30.2.0/24"),
    /orchestrator=172\.30\.2\.0\/24 overlaps edge=172\.30\.0\.0\/16/,
  );
});

test("the broker issues a caller tokens for the services it calls, never others", () => {
  const tokens = issueServiceTokens("edge", ["github", "orchestrator"], signing, { now: NOW });
  const claims = verifyServiceToken(tokens.github, { keys, service: "github", now: NOW });
  assert.equal(claims.sub, "edge");
  assert.equal(claims.exp - claims.iat, SERVICE_TOKEN_TTL_MS / 1000);
  refused(
    () => issueServiceTokens("edge", ["github", "models"], signing),
    403,
    /edge doesn't call models/,
  );
  refused(() => issueServiceTokens("policy", ["github"], signing), 403, /doesn't call/);
  refused(() => issueServiceTokens(null, ["github"], signing), 403, /not from a service/);
  refused(() => issueServiceTokens("edge", [], signing), 403, /anything/);
  assert.throws(() => signServiceToken({ sub: "sandbox", aud: "github" }, signing), /not services/);
});

test("the call graph: services only, and no service calls itself", () => {
  for (const [caller, callees] of Object.entries(CALLS)) {
    assert.ok(SERVICES.includes(caller), caller);
    for (const callee of callees) {
      assert.ok(SERVICES.includes(callee), `${caller} → ${callee}`);
      assert.notEqual(caller, callee);
    }
    // Every service that calls another gets its tokens from the broker.
    if (callees.length && caller !== "broker") assert.ok(calls(caller, "broker"), caller);
  }
  assert.deepEqual(CALLS.policy, []);
});

test("a service's tokens: asked for at start, renewed two thirds in, again after a failure", async () => {
  let at = NOW;
  const timers = [];
  let answers = 0;
  let fail = false;
  const tokens = serviceTokens({
    audiences: ["github", "broker"],
    request: async (audiences) => {
      if (fail) throw new Error("broker away");
      answers++;
      return Object.fromEntries(audiences.map((aud) => [aud, `${aud}-${answers}`]));
    },
    now: () => at,
    setTimer: (fn, ms) => (timers.push({ fn, ms }), { unref() {} }),
    clearTimer: () => {},
  });
  await tokens.start();
  assert.equal(await tokens.header("github"), "Bearer github-1");
  assert.equal(timers.at(-1).ms, (SERVICE_TOKEN_TTL_MS * 2) / 3);
  await assert.rejects(tokens.header("models"), /no service token for models/);

  at += (SERVICE_TOKEN_TTL_MS * 2) / 3;
  await timers.at(-1).fn();
  assert.equal(await tokens.header("broker"), "Bearer broker-2");

  // The broker away: tried again a little later, the tokens held go on being used.
  fail = true;
  at += (SERVICE_TOKEN_TTL_MS * 2) / 3;
  await timers.at(-1).fn();
  assert.equal(timers.at(-1).ms, 5000);
  assert.equal(await tokens.header("github"), "Bearer github-2");
  // Back before they end: renewed.
  fail = false;
  await timers.at(-1).fn();
  assert.equal(await tokens.header("github"), "Bearer github-3");

  // Every renewal failed until their last minute: the call asks for them itself.
  fail = true;
  at += SERVICE_TOKEN_TTL_MS - 30_000;
  await assert.rejects(tokens.header("github"), /broker away/);
  fail = false;
  assert.equal(await tokens.header("github"), "Bearer github-4");
  tokens.stop();
});

test("over HTTP: the callee reads the network a call arrived on from its own socket", async (t) => {
  const loopback = serviceGuard({
    service: "github",
    keys,
    routes: ROUTES,
    // The test's one network is loopback: edge's.
    bound: networkCallers("edge=127.0.0.0/8"),
  });
  const { port } = await serve(t, (req, res) => {
    try {
      send(res, 200, { caller: loopback(req) });
    } catch (error) {
      send(res, error.status ?? 500, { error: error.message });
    }
  });
  const get = (path, token) =>
    new Promise((resolve, reject) => {
      const req = request(
        { host: "127.0.0.1", port, path, headers: { authorization: `Bearer ${token}` } },
        (res) => {
          let body = "";
          res.on("data", (d) => (body += d));
          res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
        },
      );
      req.on("error", reject);
      req.end();
    });
  const edge = signServiceToken({ sub: "edge", aud: "github" }, signing);
  assert.deepEqual(await get("/repos/o/r/config", edge), {
    status: 200,
    body: { caller: "edge" },
  });
  const orchestrator = signServiceToken({ sub: "orchestrator", aud: "github" }, signing);
  const replayed = await get("/repos/o/r/config", orchestrator);
  assert.equal(replayed.status, 403);
});
