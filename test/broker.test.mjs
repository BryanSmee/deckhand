import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { createBroker } from "../listener/broker.mjs";
import { NO_TOKEN } from "../listener/github-app.mjs";
import { localBroker, sandboxAt } from "./helpers.mjs";

test("a run keeps why the listener started it, which deny_github reads", () => {
  const broker = createBroker({ sentFrom: sandboxAt() });
  const fix = broker.register("org/c", undefined, { mode: "work", push: true, reason: "conflict" });
  assert.equal(broker.runOf(fix).reason, "conflict");
  assert.equal(broker.runOf(broker.register("org/c")).reason, null);
});

test("a run's secret names its run until the run ends, and only from its own sandbox", async () => {
  const sentFrom = sandboxAt("10.9.0.5");
  const broker = createBroker({ sentFrom });
  const a = broker.register("Org/A", undefined, { mode: "review" });
  const b = broker.register("org/b");
  assert.equal(broker.runOf(a).repo, "org/a");
  assert.equal(broker.runOf(a).mode, "review");
  assert.equal(broker.runOf(b).mode, null);
  assert.equal(broker.runOf("guess"), undefined);
  assert.equal(broker.runOf(undefined), undefined);
  // Its source address, or the one the egress proxy named for a call it relayed.
  const req = { socket: { remoteAddress: "::ffff:127.0.0.1" } };
  assert.equal(await broker.sentBy(broker.runOf(a), req), false);
  assert.equal(await broker.sentBy(broker.runOf(a), req, "10.9.0.5"), true);
  assert.deepEqual(sentFrom.asked, [
    { run: broker.runOf(a), ip: "127.0.0.1" },
    { run: broker.runOf(a), ip: "10.9.0.5" },
  ]);
  broker.revoke(a);
  assert.equal(broker.runOf(a), undefined);
  assert.equal(broker.size(), 1);
  // A call the egress proxy forwarded (#511): the sandbox it names (broker-http.mjs
  // clientAddress()), for the git gateway, the agents' APIs and the run's files alike.
  const forwarded = createBroker({
    sentFrom,
    clientOf: async (r) => r.headers?.["x-deckhand-client"] ?? "",
  });
  const c = forwarded.register("org/c");
  const via = (ip) => ({
    socket: { remoteAddress: "10.0.0.9" },
    headers: { "x-deckhand-client": ip },
  });
  assert.equal(await forwarded.sentBy(forwarded.runOf(c), via("10.9.0.5")), true);
  assert.equal(await forwarded.sentBy(forwarded.runOf(c), via("10.9.0.6")), false);
  // Without a `sentFrom`, no request is the run's.
  const none = createBroker({});
  assert.equal(await none.sentBy(none.runOf(none.register("org/a")), req), false);
});

test("a research run's secret still names the run, which pushes nothing", () => {
  const broker = createBroker({});
  const research = broker.register("org/a", NO_TOKEN);
  assert.equal(broker.runOf(research).repo, "org/a");
  assert.equal(broker.runOf(research).extra, NO_TOKEN);
  assert.equal(broker.runOf(research).push, false);
});

test("only runs registered as work push; a restarted run's secret keeps its own", () => {
  const broker = createBroker({});
  assert.equal(broker.runOf(broker.register("org/a")).push, false);
  assert.equal(broker.runOf(broker.register("org/a", { pull_requests: "write" })).push, false);
  assert.equal(broker.runOf(broker.register("org/a", undefined, { push: "yes" })).push, false);
  assert.equal(broker.runOf(broker.register("org/a", undefined, { push: true })).push, true);
  const secret = broker.register("org/a", undefined, { push: true, secret: "kept" });
  assert.equal(secret, "kept");
  assert.equal(broker.runOf("kept").push, true);
});

test("a run's branches: none until allowed, and never for a run that can't push", () => {
  const broker = createBroker({});
  const work = broker.register("org/a", undefined, { push: true });
  assert.deepEqual(broker.runOf(work).branches, []);
  broker.allow(work, ["issue-1-*"]);
  assert.deepEqual(broker.runOf(work).branches, ["issue-1-*"]);
  const light = broker.register("org/a");
  broker.allow(light, ["issue-1-*"]);
  assert.deepEqual(broker.runOf(light).branches, []);
  // Unless its capabilities (capabilities.mjs) give it `push`.
  broker.grant(light, ["pull", "push"]);
  broker.allow(light, ["issue-1-*"]);
  assert.deepEqual(broker.runOf(light).branches, ["issue-1-*"]);
  assert.deepEqual(broker.runOf(light).extra, undefined);
  // Without `pull`, no GitHub token at all, whatever its mode gave it; restored the same way.
  const bare = broker.register("org/a", { pull_requests: "read" });
  broker.grant(bare, ["read:issues"]);
  assert.equal(broker.runOf(bare).extra, NO_TOKEN);
  const restored = broker.register("org/a", { pull_requests: "read" }, { caps: [] });
  assert.equal(broker.runOf(restored).extra, NO_TOKEN);
  // A run saved before capabilities keeps its mode's.
  const older = broker.register("org/a", { pull_requests: "read" }, { caps: null });
  assert.deepEqual(broker.runOf(older).extra, { pull_requests: "read" });
  // A finished run stays finished.
  broker.revoke(work);
  broker.allow(work, ["x"]);
  assert.equal(broker.runOf(work), undefined);
});

// A broker whose runs' networks are at known addresses: address → network ID. Its tokens come
// from the broker service's runs, in memory (`service`).
function tokenBroker(networks = { "10.9.0.5": "net-a", "10.9.1.5": "net-b" }) {
  const clock = { now: 1_900_000_000_000 };
  const service = localBroker({ now: () => clock.now });
  const broker = createBroker({
    ...service,
    sandboxOf: async (ip) => networks[ip] ?? null,
    now: () => clock.now,
  });
  return { broker, clock, service };
}

test("a run's tokens name it from its own sandbox's network alone", async () => {
  const { broker, service } = tokenBroker();
  const id = broker.register("Org/A", undefined, { id: "run-a", mode: "work", push: true });
  assert.equal(id, "run-a");
  broker.grant(id, ["pull", "push"]);
  broker.allow(id, ["issue-1-*"]);
  const { token, agentToken } = await broker.issue(id, "net-a", "0123456789abcdef01234567");
  const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url"));
  assert.deepEqual(
    { ...claims, iat: 0, exp: 0 },
    {
      ver: 1,
      jti: "run-a",
      repo: "org/a",
      mode: "work",
      issue: null,
      fork: false,
      branches: ["issue-1-*"],
      sandbox: "net-a",
      // Its capabilities, as its start decided them.
      caps: ["pull", "push"],
      aud: "deckhand:broker",
      iat: 0,
      exp: 0,
    },
  );
  // The broker service has the run, and its screenshots' folder.
  assert.equal((await service.runs.get("run-a")).shots, "0123456789abcdef01234567");
  assert.equal((await broker.check(token, "10.9.0.5")).run, broker.runOf(id));
  // Another sandbox's network, an address on none, or none at all.
  for (const ip of ["10.9.1.5", "10.9.2.5", "", undefined]) {
    assert.deepEqual(await broker.check(token, ip), {
      status: 403,
      message: "this run's token only works from its own sandbox",
    });
  }
  // Each token for its own service: the agent's for the agents' endpoints alone.
  assert.equal((await broker.check(token, "10.9.0.5", "deckhand:agents")).status, 401);
  assert.equal((await broker.check(agentToken, "10.9.0.5")).status, 401);
  assert.equal((await broker.check(agentToken, "10.9.0.5", "deckhand:agents")).run.id, "run-a");
  // Its id is no secret: it names nothing on its own.
  assert.equal((await broker.check("run-a", "10.9.0.5")).status, 401);
  // Both go in its output's redaction.
  assert.deepEqual(broker.secretsOf(id), [agentToken, token]);
  // Ended: refused here, and ended at the broker service too, which renews it no more.
  await broker.revoke(id);
  assert.deepEqual(await broker.check(token, "10.9.0.5"), {
    status: 401,
    message: "unknown or finished run",
  });
  assert.equal(await service.runs.get("run-a"), null);
  assert.equal((await service.runs.renew(token, "net-a")).status, 401);
});

test("a token from another broker's key is refused, as one signed for another sandbox", async () => {
  const { broker } = tokenBroker();
  const other = tokenBroker().broker;
  other.register("org/a", undefined, { id: "run-a" });
  broker.register("org/a", undefined, { id: "run-a" });
  const { token } = await other.issue("run-a", "net-a");
  assert.match((await broker.check(token, "10.9.0.5")).message, /unknown key/);
  const mine = (await broker.issue("run-a", "net-b")).token;
  assert.equal((await broker.check(mine, "10.9.0.5")).status, 403);
  assert.equal((await broker.check(mine, "10.9.1.5")).run.id, "run-a");
});

test("a run from before tokens keeps its secret, bound to its sandbox's address", async () => {
  const broker = createBroker({ sentFrom: sandboxAt("10.9.0.5"), ...localBroker() });
  const secret = broker.register("org/a", undefined, { id: "old", secret: "kept-secret" });
  assert.equal(secret, "kept-secret");
  assert.equal(broker.runOf("old"), broker.runOf("kept-secret"));
  assert.equal((await broker.check("kept-secret", "10.9.0.5")).run.id, "old");
  assert.equal((await broker.check("kept-secret", "10.9.1.5")).status, 403);
  assert.equal((await broker.check("kept-secret", undefined)).status, 403);
  broker.revoke("old");
  assert.equal((await broker.check("kept-secret", "10.9.0.5")).status, 401);
  // A token run has no secret at all, and can't be issued once ended.
  broker.register("org/a", undefined, { id: "new" });
  assert.equal(broker.runOf("new").secret, undefined);
  broker.revoke("new");
  await assert.rejects(broker.issue("new", "net-a"), /ended/);
});

test("without the broker service, no run gets a token", async () => {
  const broker = createBroker({});
  broker.register("org/a", undefined, { id: "run-a" });
  await assert.rejects(broker.issue("run-a", "net-a"), /no broker service/);
});

test("a run that ends while its tokens are being signed gets none, and ends at the broker service", async () => {
  const service = localBroker();
  const ended = [];
  let release;
  const broker = createBroker({
    ...service,
    issuer: {
      ...service.issuer,
      issue: async (id, fields) => {
        await new Promise((resolve) => (release = resolve));
        return service.issuer.issue(id, fields);
      },
      end: async (id) => (ended.push(id), service.issuer.end(id)),
    },
  });
  broker.register("org/a", undefined, { id: "run-a" });
  const issued = broker.issue("run-a", "net-a");
  await new Promise((resolve) => setImmediate(resolve));
  await broker.revoke("run-a");
  release();
  await assert.rejects(issued, /ended/);
  assert.deepEqual(ended, ["run-a", "run-a"]);
  assert.equal(await service.runs.get("run-a"), null);
});

test("a restarted listener redacts the run tokens saved with the run, and tells the broker service it goes on", async () => {
  const { broker, service } = tokenBroker();
  broker.register("org/a", undefined, { id: "run-a", mode: "work", push: true });
  broker.allow("run-a", ["issue-1-*"]);
  const { token } = await broker.issue("run-a", "net-a");
  // The broker service lost it meanwhile (a run from before it): told again, with its claims.
  await service.runs.end("run-a");
  const again = tokenBroker().broker;
  const restarted = createBroker({ ...service, sandboxOf: async () => "net-a" });
  restarted.register("org/a", undefined, {
    id: "run-a",
    mode: "work",
    push: true,
    sandbox: "net-a",
    issued: broker.issuedOf("run-a"),
  });
  restarted.allow("run-a", ["issue-1-*"]);
  assert.deepEqual(restarted.secretsOf("run-a"), [token]);
  await restarted.restore("run-a", "0123456789abcdef01234567");
  const record = await service.runs.get("run-a");
  assert.equal(record.sandbox, "net-a");
  assert.deepEqual(record.branches, ["issue-1-*"]);
  assert.equal(record.shots, "0123456789abcdef01234567");
  assert.ok((await service.runs.renew(token, "net-a")).token);
  // The hash of the token the sandbox was handed went with it, the first of the run's list: past
  // their expiry, only the newest renews, as before the restart.
  const { issued } = await service.runs.get("run-a");
  assert.equal(issued[0].hash, createHash("sha256").update(token).digest("hex"));
  assert.equal(issued.length, 2);
  // A run from before tokens has nothing there.
  restarted.register("org/a", undefined, { id: "old", secret: "kept" });
  await restarted.restore("old");
  assert.equal(await service.runs.get("old"), null);
  assert.equal(again.size(), 0);
});
