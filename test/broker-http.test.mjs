// What binds a run's secret to its sandbox (broker-http.mjs runAt()): the run's own task's
// addresses, never another running sandbox's.
import assert from "node:assert/strict";
import { test } from "node:test";
import { runAt } from "../listener/broker-http.mjs";
import { createBroker } from "../listener/broker.mjs";

// Two running tasks, A and B, each with its sandbox's and its engine's addresses.
function twoRuns() {
  const broker = createBroker({ app: () => null });
  const looked = [];
  const addresses = { a: ["10.1.0.2"], b: ["10.2.0.2"] };
  const engines = { a: ["10.1.0.3"], b: null };
  const runner = {
    address: async (name) => (looked.push(name), [...addresses[name], ...(engines[name] ?? [])]),
    engineAddress: async (name) => engines[name],
  };
  const task = (name, repo) => ({
    name,
    repo,
    live: { secret: broker.register(repo), hosts: ["github.com"], ip: null },
  });
  const tasks = new Map([
    ["org/a#1", task("a", "org/a")],
    ["org/b#2", task("b", "org/b")],
  ]);
  const ctx = { broker, runner, tasks };
  const runOf = (key) => broker.runOf(tasks.get(key).live.secret);
  return { ctx, tasks, runOf, looked };
}

test("runAt: a run's record from its own sandbox or engine, not from another sandbox", async () => {
  const { ctx, runOf, looked } = twoRuns();
  const a = runOf("org/a#1");
  assert.equal(await runAt(ctx, a, "10.1.0.2"), true);
  assert.equal(await runAt(ctx, a, "10.1.0.3"), true);
  // A's secret, replayed from B's sandbox (a research run's, say): refused.
  assert.equal(await runAt(ctx, a, "10.2.0.2"), false);
  assert.equal(await runAt(ctx, runOf("org/b#2"), "10.2.0.2"), true);
  assert.equal(await runAt(ctx, runOf("org/b#2"), "10.1.0.2"), false);
  // Looked up once per run.
  assert.deepEqual(looked, ["a", "b"]);
  // A record no running task holds (revoked, unknown): nobody's.
  assert.equal(await runAt(ctx, { repo: "org/a" }, "10.1.0.2"), false);
  assert.equal(await runAt(ctx, undefined, "10.1.0.2"), false);
});

test("runAt: a finished run (finish() cleared its hosts and addresses) is nobody's", async () => {
  const { ctx, tasks, runOf } = twoRuns();
  const a = runOf("org/a#1");
  assert.equal(await runAt(ctx, a, "10.1.0.2"), true);
  const live = tasks.get("org/a#1").live;
  live.hosts = null;
  live.ip = null;
  assert.equal(await runAt(ctx, a, "10.1.0.2"), false);
  assert.equal(live.ip, null, "not looked up again");
});
