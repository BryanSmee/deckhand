import assert from "node:assert/strict";
import { test } from "node:test";
import { createBroker, RENEW_GRACE_MS } from "../listener/broker.mjs";
import { NO_TOKEN } from "../listener/github-app.mjs";
import { sandboxAt } from "./helpers.mjs";

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
  // A finished run stays finished.
  broker.revoke(work);
  broker.allow(work, ["x"]);
  assert.equal(broker.runOf(work), undefined);
});

// A broker whose runs' networks are at known addresses: address → network ID.
function tokenBroker(networks = { "10.9.0.5": "net-a", "10.9.1.5": "net-b" }) {
  const clock = { now: 1_900_000_000_000 };
  const broker = createBroker({
    sandboxOf: async (ip) => networks[ip] ?? null,
    now: () => clock.now,
  });
  return { broker, clock };
}

test("a run's tokens name it from its own sandbox's network alone", async () => {
  const { broker } = tokenBroker();
  const id = broker.register("Org/A", undefined, { id: "run-a", mode: "work", push: true });
  assert.equal(id, "run-a");
  broker.allow(id, ["issue-1-*"]);
  const { token, agentToken } = broker.issue(id, "net-a");
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
      caps: [],
      aud: "deckhand:broker",
      iat: 0,
      exp: 0,
    },
  );
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
  // Ended: refused, and the network is no longer there to vouch for it anyway.
  broker.revoke(id);
  assert.deepEqual(await broker.check(token, "10.9.0.5"), {
    status: 401,
    message: "unknown or finished run",
  });
});

test("a token from another broker's key is refused, as one signed for another sandbox", async () => {
  const { broker } = tokenBroker();
  const other = tokenBroker().broker;
  other.register("org/a", undefined, { id: "run-a" });
  broker.register("org/a", undefined, { id: "run-a" });
  const { token } = other.issue("run-a", "net-a");
  assert.match((await broker.check(token, "10.9.0.5")).message, /unknown key/);
  const mine = broker.issue("run-a", "net-b").token;
  assert.equal((await broker.check(mine, "10.9.0.5")).status, 403);
  assert.equal((await broker.check(mine, "10.9.1.5")).run.id, "run-a");
});

test("a run longer than its token's lifetime keeps working, renewing every 5 minutes", async () => {
  const { broker, clock } = tokenBroker();
  broker.register("org/a", undefined, { id: "run-a" });
  const first = broker.issue("run-a", "net-a").token;
  let token = first;
  const renewals = [];
  for (let minute = 5; minute <= 60; minute += 5) {
    clock.now += 5 * 60_000;
    const renewed = await broker.renew(token, "10.9.0.5");
    assert.ok(renewed.token, `renewed at ${minute} minutes`);
    token = renewed.token;
    renewals.push(token);
    assert.ok((await broker.check(token, "10.9.0.5")).run);
  }
  // An hour on, the first token expired long ago; the last one works.
  assert.match((await broker.check(first, "10.9.0.5")).message, /expired/);
  // Its last few are kept for redaction, not every one.
  assert.deepEqual(broker.secretsOf("run-a").slice(-4), renewals.slice(-4));
  assert.equal(broker.secretsOf("run-a").length, 5);
  // Never from another sandbox, nor for an ended run.
  assert.equal((await broker.renew(token, "10.9.1.5")).status, 403);
  broker.revoke("run-a");
  assert.deepEqual(await broker.renew(token, "10.9.0.5"), {
    status: 401,
    message: "unknown or finished run",
  });
  assert.equal((await broker.renew("a-secret", "10.9.0.5")).status, 401);
});

test("a run from before tokens keeps its secret, bound to its sandbox's address", async () => {
  const broker = createBroker({ sentFrom: sandboxAt("10.9.0.5") });
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
  assert.throws(() => broker.issue("new", "net-a"), /ended/);
});

test("a token expired while the broker was away still renews, from its sandbox, within the grace", async () => {
  const { broker, clock } = tokenBroker();
  broker.register("org/a", undefined, { id: "run-a" });
  const { token } = broker.issue("run-a", "net-a");
  // The broker unreachable for an hour (a slow update, a host reboot): the token expired.
  clock.now += 60 * 60_000;
  assert.match((await broker.check(token, "10.9.0.5")).message, /expired/);
  // Its calls fail until the broker is back, then the next renewal brings the run back.
  const renewed = await broker.renew(token, "10.9.0.5");
  assert.equal((await broker.check(renewed.token, "10.9.0.5")).run.id, "run-a");
  // Never from another sandbox, never past the grace, never for an ended run.
  assert.equal((await broker.renew(token, "10.9.1.5")).status, 403);
  clock.now += RENEW_GRACE_MS;
  assert.match((await broker.renew(token, "10.9.0.5")).message, /expired/);
  broker.revoke("run-a");
  assert.equal((await broker.renew(renewed.token, "10.9.0.5")).status, 401);
});
