import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { createBroker } from "../listener/broker.mjs";
import { readsGitHub } from "../listener/github-app.mjs";
import { localBroker } from "./helpers.mjs";

test("a run keeps why the listener started it, which deny_github reads", () => {
  const broker = createBroker({});
  const fix = broker.register("org/c", { mode: "work", push: true, reason: "conflict" });
  assert.equal(broker.runOf(fix).reason, "conflict");
  assert.equal(broker.runOf(broker.register("org/c")).reason, null);
});

test("a run's handle names it until the run ends", () => {
  const broker = createBroker({});
  const a = broker.register("Org/A", { mode: "review" });
  const b = broker.register("org/b");
  assert.equal(broker.runOf(a).repo, "org/a");
  assert.equal(broker.runOf(a).mode, "review");
  assert.equal(broker.runOf(b).mode, null);
  assert.equal(broker.runOf("guess"), undefined);
  assert.equal(broker.runOf(undefined), undefined);
  broker.revoke(a);
  assert.equal(broker.runOf(a), undefined);
  assert.equal(broker.size(), 1);
});

test("a research run still names its repo, and pushes nothing", () => {
  const broker = createBroker({});
  const research = broker.register("org/a", { caps: ["internet"] });
  assert.equal(broker.runOf(research).repo, "org/a");
  assert.equal(readsGitHub(broker.runOf(research)), false);
  assert.equal(broker.runOf(research).push, false);
});

test("only runs registered as work push", () => {
  const broker = createBroker({});
  assert.equal(broker.runOf(broker.register("org/a")).push, false);
  assert.equal(broker.runOf(broker.register("org/a")).push, false);
  assert.equal(broker.runOf(broker.register("org/a", { push: "yes" })).push, false);
  assert.equal(broker.runOf(broker.register("org/a", { push: true })).push, true);
});

test("a run's branches: none until allowed, and never for a run that can't push", () => {
  const broker = createBroker({});
  const work = broker.register("org/a", { push: true });
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
  assert.equal(readsGitHub(broker.runOf(light)), true);
  // Without `pull`, nothing from GitHub, whatever its mode writes; restored the same way, and
  // before its capabilities are decided.
  const bare = broker.register("org/a");
  assert.equal(readsGitHub(broker.runOf(bare)), false);
  assert.equal(broker.runOf(bare).decided, false);
  broker.grant(bare, ["read:issues"]);
  assert.equal(readsGitHub(broker.runOf(bare)), false);
  assert.equal(broker.runOf(bare).decided, true);
  const restored = broker.register("org/a", { caps: [] });
  assert.equal(readsGitHub(broker.runOf(restored)), false);
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
  const id = broker.register("Org/A", { id: "run-a", mode: "work", push: true });
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
  other.register("org/a", { id: "run-a" });
  broker.register("org/a", { id: "run-a" });
  const { token } = await other.issue("run-a", "net-a");
  assert.match((await broker.check(token, "10.9.0.5")).message, /unknown key/);
  const mine = (await broker.issue("run-a", "net-b")).token;
  assert.equal((await broker.check(mine, "10.9.0.5")).status, 403);
  assert.equal((await broker.check(mine, "10.9.1.5")).run.id, "run-a");
});

test("a run that ended gets no token", async () => {
  const broker = createBroker({ ...localBroker() });
  broker.register("org/a", { id: "new" });
  broker.revoke("new");
  await assert.rejects(broker.issue("new", "net-a"), /ended/);
});

test("without the broker service, no run gets a token", async () => {
  const broker = createBroker({});
  broker.register("org/a", { id: "run-a" });
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
  broker.register("org/a", { id: "run-a" });
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
  broker.register("org/a", { id: "run-a", mode: "work", push: true });
  broker.allow("run-a", ["issue-1-*"]);
  const { token } = await broker.issue("run-a", "net-a");
  // The broker service lost it meanwhile (its store, say): told again, with its claims.
  await service.runs.end("run-a");
  const again = tokenBroker().broker;
  const restarted = createBroker({ ...service, sandboxOf: async () => "net-a" });
  restarted.register("org/a", {
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
  assert.equal(again.size(), 0);
});
