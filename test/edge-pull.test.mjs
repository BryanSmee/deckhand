// Pull mode (edge/pull.mjs, #1032): edge reads GitHub's deliveries through the App's API, each
// taken once (edge/take.mjs) across looks, restarts and webhooks that did arrive.
import assert from "node:assert/strict";
import { test } from "node:test";
import { openStore } from "../lib/store.mjs";
import {
  createPollers,
  createPull,
  pulledDelivery,
  pullMode,
  readDelivery,
  takenOrPulled,
  toRead,
} from "../edge/pull.mjs";
import { createRedeliveries } from "../listener/redeliveries.mjs";
import { DELIVERIES } from "../edge/internal.mjs";
import { createTaker, takenDelivery } from "../edge/take.mjs";
import { recordingFetch, testConfig } from "./helpers.mjs";

const NOW = Date.parse("2026-11-16T12:00:00Z");
const SEC = 1000;
const at = (secondsAgo, now = NOW) => new Date(now - secondsAgo * SEC).toISOString();

// A delivery as GitHub lists it: its ID past 2^53, as a string (parseDeliveries()).
function listed(n, guid, secondsAgo, more = {}) {
  return {
    id: `38531207327960350${String(n).padStart(2, "0")}`,
    guid,
    delivered_at: at(secondsAgo),
    status_code: 502,
    status: "failed to connect to host",
    event: "issue_comment",
    action: "created",
    repository_id: 1,
    ...more,
  };
}

const comment = (id) => ({
  action: "created",
  installation: { id: 7 },
  repository: { full_name: "org/repo", id: 1 },
  issue: { number: 12, id: 4242 },
  comment: { id, body: "Deckhand", user: { login: "alice", type: "User" } },
  sender: { login: "alice" },
});

// A fake GitHub: `list()` the deliveries it lists (newest first), each one's payload a comment
// whose id is its number; `fail(id)`: that delivery answered 500.
function fakeGitHub(list, { fail = () => false } = {}) {
  const { fetch, calls } = recordingFetch(({ path }) => {
    const url = new URL(path, "https://api.example");
    const one = /^\/app\/hook\/deliveries\/(\d+)$/.exec(url.pathname);
    if (!one) {
      // The IDs as GitHub writes them: numbers past 2^53.
      const text = JSON.stringify(list()).replace(/"id":"(\d+)"/g, '"id":$1');
      return new Response(text, { headers: { "content-type": "application/json" } });
    }
    const d = list().find((x) => x.id === one[1]);
    if (!d || fail(d.id)) return new Response("{}", { status: d ? 500 : 404 });
    return Response.json({
      id: Number(d.id),
      guid: d.guid,
      event: d.event,
      request: {
        headers: { "X-GitHub-Event": d.event, "X-GitHub-Delivery": d.guid },
        payload: comment(Number(d.id.slice(-2))),
      },
      response: { headers: null, payload: "" },
    });
  });
  const asApp = (method, path) => fetch(`https://api.example${path}`, { method });
  const read = () =>
    calls.filter((c) => /\/deliveries\/\d+$/.test(c.path)).map((c) => c.path.split("/").pop());
  return { app: () => ({ asApp }), calls, read };
}

function pullOn(github, { store = openStore("memory:"), now = () => NOW, logs = [] } = {}) {
  const take = createTaker({
    config: testConfig(),
    store,
    redeliveries: { redelivered: async () => false },
    secrets: () => [],
    now,
  });
  const pulled = [];
  const seen = [];
  const pull = createPull({
    store,
    app: github.app,
    take,
    handled: (guid) => takenDelivery(store, guid),
    onPulled: (event, result) => pulled.push([event, result]),
    onSeen: (when) => seen.push(when),
    log: (line) => logs.push(line),
    now,
  });
  const stream = async () =>
    (await store.read(DELIVERIES, "orchestrator")).map(({ event }) => event);
  return { pull, store, pulled, seen, stream, logs };
}

test("pull mode: DELIVERIES first, else what /setup stored", () => {
  assert.equal(pullMode("", { deliveries: "pull" }), true);
  assert.equal(pullMode(undefined, {}), false);
  assert.equal(pullMode(undefined, null), false);
  assert.equal(pullMode("webhook", { deliveries: "pull" }), false);
  assert.equal(pullMode("pull", {}), true);
});

test("what to read: one per GUID, oldest first, the newest CI change of each repository alone", () => {
  const list = [
    listed(6, "s3", 1, { event: "status", repository_id: 2 }),
    listed(5, "s2", 2, { event: "status" }),
    listed(4, "a", 3),
    listed(3, "s1", 4, { event: "status" }),
    listed(2, "a", 5),
    listed(1, "b", 6),
    { ...listed(0, "bad", 7), id: "1e18" },
  ];
  assert.deepEqual(
    toRead(list).map((d) => d.guid),
    ["b", "a", "s2", "s3"],
  );
});

test("a delivery read back: its event and GUID from its headers, its payload's IDs numbers", () => {
  const text = `{"id":3853120732796035072,"request":{"headers":{"X-GitHub-Event":"issues","X-GitHub-Delivery":"g"},"payload":{"issue":{"id":12}}}}`;
  assert.deepEqual(readDelivery(text, { event: "x", guid: "y" }), {
    event: "issues",
    guid: "g",
    payload: { issue: { id: 12 } },
  });
  const bare = readDelivery(`{"request":{"payload":"{\\"a\\":1}"}}`, { event: "x", guid: "y" });
  assert.deepEqual(bare, { event: "x", guid: "y", payload: { a: 1 } });
  assert.equal(readDelivery(`{}`, { event: "x", guid: "y" }).payload, null);
});

test("each new delivery goes on the stream once, by its exact ID; the next look takes none again", async () => {
  const list = [listed(2, "g-2", 3), listed(1, "g-1", 5)];
  const github = fakeGitHub(() => list);
  const { pull, stream, pulled, seen } = pullOn(github);
  assert.equal(await pull.scan(), 2);
  assert.deepEqual(github.read(), ["3853120732796035001", "3853120732796035002"]);
  const events = await stream();
  assert.deepEqual(
    events.map((e) => [e.id, e.event, e.payload.comment.id, e.payload.issue.id, e.redelivered]),
    [
      ["g-1", "issue_comment", 1, 4242, false],
      ["g-2", "issue_comment", 2, 4242, false],
    ],
  );
  assert.deepEqual(pulled, [
    ["issue_comment", "accepted"],
    ["issue_comment", "accepted"],
  ]);
  assert.deepEqual(seen, [NOW - 3 * SEC]);
  assert.equal(await pull.scan(), 0);
  assert.equal(github.read().length, 2);
});

test("a delivery a webhook brought, or another copy pulled, isn't read; its GUID is marked pulled", async () => {
  const github = fakeGitHub(() => [listed(2, "g-2", 3), listed(1, "g-1", 5)]);
  const store = openStore("memory:");
  await store.set("deliveries/g-1", { kept: NOW });
  const { pull } = pullOn(github, { store });
  assert.equal(await pull.scan(), 1);
  assert.deepEqual(github.read(), ["3853120732796035002"]);
  assert.equal(await pulledDelivery(store, "g-2"), true);
  assert.equal(await pulledDelivery(store, "g-1"), false);
  // Another copy, on the same store after a handover: nothing read twice.
  const next = pullOn(github, { store });
  assert.equal(await next.pull.scan(), 0);
  assert.equal(github.read().length, 1);
});

test("the first look goes 10 minutes back, the next ones to the last; one listed late is replayed as it is now", async () => {
  let now = NOW;
  let list = [listed(2, "recent", 9 * 60), listed(1, "old", 12 * 60)];
  const github = fakeGitHub(() => list);
  const { pull, stream } = pullOn(github, { now: () => now });
  assert.equal(await pull.scan(), 1);
  assert.deepEqual(
    (await stream()).map((e) => [e.id, e.redelivered]),
    [["recent", true]],
  );
  // Edge was away 2 hours: everything since its last look, within GitHub's 3 days.
  now = NOW + 2 * 3600 * SEC;
  list = [listed(3, "away", 3600, { delivered_at: at(3600, now) }), ...list];
  assert.equal(await pull.scan(), 1);
  assert.deepEqual(
    (await stream()).map((e) => e.id),
    ["recent", "away"],
  );
});

test("a delivery GitHub doesn't hand over is read again at the next look, the others taken", async () => {
  let failing = true;
  const github = fakeGitHub(() => [listed(2, "g-2", 3), listed(1, "g-1", 5)], {
    fail: (id) => failing && id.endsWith("01"),
  });
  const logs = [];
  const { pull, stream } = pullOn(github, { logs });
  assert.equal(await pull.scan(), 1);
  assert.match(logs.join("\n"), /delivery g-1 .*GitHub answered 500, read again/);
  failing = false;
  assert.equal(await pull.scan(), 1);
  assert.deepEqual(
    (await stream()).map((e) => e.id),
    ["g-2", "g-1"],
  );
});

test("pull mode off (no App): nothing listed; turned on again, it starts from now", async () => {
  let on = false;
  const list = [listed(1, "old", 30 * 60)];
  const github = fakeGitHub(() => list);
  const store = openStore("memory:");
  await store.set("pulled/scanned", NOW - 3600 * SEC);
  const { pull } = pullOn({ app: () => (on ? github.app() : null) }, { store });
  assert.equal(await pull.scan(), null);
  assert.equal(github.calls.length, 0);
  await new Promise((resolve) => setImmediate(resolve));
  on = true;
  assert.equal(await pull.scan(), 0);
  assert.deepEqual(github.read(), []);
});

test("a day without a delivery is said in the logs, once a day", async () => {
  let now = NOW;
  const github = fakeGitHub(() => []);
  const logs = [];
  const { pull } = pullOn(github, { now: () => now, logs });
  await pull.scan();
  now += 25 * 3600 * SEC;
  await pull.scan();
  now += 3600 * SEC;
  await pull.scan();
  const said = logs.filter((line) => /no delivery from GitHub for 25 h/.test(line));
  assert.equal(said.length, 1);
  assert.match(said[0], /still Active/);
});

test("a delivery a scan died reading (edge killed) is read again 2 minutes on, not before, the looks in between holding it", async () => {
  let now = NOW;
  // Sent just before the dead scan's look, which marked it and was gone (an OOM kill): the
  // other copy looks every 12 seconds from there, each going back 60 seconds before the last.
  const github = fakeGitHub(() => [listed(1, "g-1", 5)]);
  const store = openStore("memory:");
  await store.set("pulled/scanned", NOW - 12 * SEC);
  await store.set("pulled/g-1", { taking: NOW });
  const { pull, stream } = pullOn(github, { store, now: () => now });
  for (; now < NOW + 2 * 60 * SEC; now += 12 * SEC) {
    assert.equal(await pull.scan(), 0, `${(now - NOW) / SEC} s on`);
    assert.equal(await pulledDelivery(store, "g-1", () => now), true);
  }
  assert.equal(await pull.scan(), 1);
  assert.deepEqual(
    (await stream()).map((e) => e.id),
    ["g-1"],
  );
  assert.deepEqual(await store.get("pulled/g-1"), { kept: now });
  // Taken: the next looks move on.
  now += 12 * SEC;
  assert.equal(await pull.scan(), 0);
  assert.equal(await store.get("pulled/scanned"), now);
});

test("closing: the scan ends after the delivery it is reading, the rest read at the next look", async () => {
  const list = [listed(3, "g-3", 2), listed(2, "g-2", 3), listed(1, "g-1", 5)];
  let release;
  let reached;
  const held = new Promise((resolve) => (release = resolve));
  const reading = new Promise((resolve) => (reached = resolve));
  const github = fakeGitHub(() => list);
  const slow = {
    app: () => ({
      asApp: async (method, path) => {
        if (path.endsWith("01")) {
          reached();
          await held;
        }
        return github.app().asApp(method, path);
      },
    }),
  };
  const store = openStore("memory:");
  const first = pullOn(slow, { store });
  const scanning = first.pull.scan();
  // Closed while it reads the first one.
  await reading;
  const closed = first.pull.close();
  release();
  await closed;
  assert.equal(await scanning, 1);
  assert.equal(await first.pull.scan(), null);
  // The next copy, after the handover: the two left.
  const next = pullOn(github, { store });
  assert.equal(await next.pull.scan(), 2);
  assert.deepEqual(
    (await next.stream()).map((e) => e.id),
    ["g-1", "g-2", "g-3"],
  );
});

test("webhooks back: a delivery pull mode took is never redelivered, one it didn't is", async () => {
  const store = openStore("memory:");
  await store.set("pulled/g-1", { kept: NOW });
  const failed = [
    listed(2, "g-2", 60, { status_code: 0 }),
    listed(1, "g-1", 90, { status_code: 0 }),
  ];
  const asked = [];
  const asApp = async (method, path) => {
    if (method === "POST") {
      asked.push(path.split("/")[4]);
      return new Response(null, { status: 202 });
    }
    return Response.json(failed);
  };
  const redeliveries = createRedeliveries({
    store,
    app: () => ({ asApp }),
    handled: (guid) => takenOrPulled(store, guid),
    now: () => NOW,
  });
  assert.equal(await redeliveries.scan(), 1);
  assert.deepEqual(asked, ["3853120732796035002"]);
});

test("the pollers: pull mode reads and never redelivers; back on webhooks, only what it didn't take is asked again", async () => {
  let pulling = true;
  const list = [listed(2, "g-2", 60, { status_code: 0 }), listed(1, "g-1", 90, { status_code: 0 })];
  // g-2 can't be read: pull mode leaves it, and nothing else may ask for it.
  const github = fakeGitHub(() => list, { fail: (id) => id.endsWith("02") });
  const asked = [];
  const app = () => ({
    asApp: async (method, path) => {
      if (method !== "POST") return github.app().asApp(method, path);
      asked.push(path.split("/")[4]);
      return new Response(null, { status: 202 });
    },
  });
  const store = openStore("memory:");
  const { redeliveries, pull, sync } = createPollers({
    store,
    app,
    pulling: () => pulling,
    taking: { config: testConfig(), secrets: () => [] },
    now: () => NOW,
  });
  assert.equal(await redeliveries.scan(), null);
  assert.equal(await sync(), 1);
  assert.deepEqual(
    (await store.read(DELIVERIES, "orchestrator")).map(({ event }) => event.id),
    ["g-1"],
  );
  assert.deepEqual(asked, []);
  // Webhooks again (DELIVERIES=webhook): the pull is off, the redeliveries skip g-1.
  pulling = false;
  assert.equal(await pull.scan(), null);
  assert.equal(await sync(), 1);
  assert.deepEqual(asked, ["3853120732796035002"]);
});
