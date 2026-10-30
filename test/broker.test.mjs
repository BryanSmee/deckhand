import assert from "node:assert/strict";
import { test } from "node:test";
import { createBroker } from "../listener/broker.mjs";
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
