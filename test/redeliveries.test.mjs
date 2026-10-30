// Deliveries GitHub couldn't hand over, asked for again once: listed with the App's JWT, the
// failed ones redelivered, the rest left alone.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { createRedeliveries, failedDeliveries, nextCursor } from "../listener/redeliveries.mjs";
import { recordingFetch, tempDir } from "./helpers.mjs";

const NOW = Date.parse("2026-10-21T15:00:00Z");
const MIN = 60_000;
const at = (minutesAgo, now = NOW) => new Date(now - minutesAgo * MIN).toISOString();

function delivery(id, guid, minutesAgo, status_code, more = {}) {
  return {
    id,
    guid,
    delivered_at: at(minutesAgo),
    status_code,
    status: status_code ? `HTTP ${status_code}` : "Couldn't connect",
    event: "issue_comment",
    action: "created",
    ...more,
  };
}

// A fake GitHub serving `pages` of deliveries (by cursor: "" for the first page) and taking
// redeliveries, with an App whose asApp() calls it.
function fakeApp(pages, { attempt = () => new Response(null, { status: 202 }) } = {}) {
  const { fetch, calls } = recordingFetch(({ method, path }) => {
    const url = new URL(path, "https://api.example");
    if (method === "POST") return attempt(path);
    const cursor = url.searchParams.get("cursor") ?? "";
    const page = pages[cursor] ?? [];
    const next = Object.keys(pages)[Object.keys(pages).indexOf(cursor) + 1];
    const headers = next
      ? {
          link: `<https://api.example/app/hook/deliveries?per_page=100&cursor=${next}>; rel="next"`,
        }
      : {};
    return Response.json(page, { headers });
  });
  const asApp = (method, path) => fetch(`https://api.example${path}`, { method });
  const redelivered = () =>
    calls.filter((c) => c.method === "POST").map((c) => c.path.split("/")[4]);
  const listed = () => calls.filter((c) => c.method === "GET").map((c) => c.path);
  return { app: () => ({ asApp }), calls, redelivered, listed };
}

test("failed deliveries: those no attempt succeeded, worth another try, oldest first", () => {
  const list = [
    delivery(6, "fixed", 1, 202, { redelivery: true }),
    delivery(5, "down", 2, 0),
    delivery(4, "ok", 3, 202),
    delivery(3, "fixed", 4, 503),
    delivery(2, "stopping", 5, 503),
    delivery(1, "unsigned", 6, 401),
  ];
  assert.deepEqual(
    failedDeliveries(list).map((d) => d.id),
    [2, 5],
  );
  // A failed redelivery is the one asked for again: the latest attempt.
  const again = [delivery(8, "g", 1, 502, { redelivery: true }), delivery(7, "g", 9, 0)];
  assert.deepEqual(
    failedDeliveries(again).map((d) => d.id),
    [8],
  );
});

test("failed deliveries: never the events nothing reads, a status per state and commit", async () => {
  const list = [
    delivery(4, "status", 1, 0, { event: "status", action: undefined }),
    delivery(3, "suite", 2, 503, { event: "check_suite", action: "completed" }),
    delivery(2, "comment", 3, 0),
    delivery(1, "run", 4, 503, { event: "workflow_run", action: "completed" }),
  ];
  assert.deepEqual(
    failedDeliveries(list).map((d) => d.guid),
    ["run", "comment"],
  );
  // A scan asks GitHub for none of them, nor logs them.
  const github = fakeApp({ "": list });
  const logs = [];
  const redeliveries = createRedeliveries({
    app: github.app,
    now: () => NOW,
    log: (line) => logs.push(line),
  });
  assert.equal(await redeliveries.scan(), 2);
  assert.deepEqual(github.redelivered(), ["1", "2"]);
  assert.ok(!logs.some((line) => /status|check_suite/.test(line)), logs.join("\n"));
});

test("the Link header's next cursor, none on the last page", () => {
  const link =
    '<https://api.github.com/app/hook/deliveries?per_page=100&cursor=v1_9>; rel="next", <https://api.github.com/app/hook/deliveries?per_page=100>; rel="first"';
  assert.equal(nextCursor(link), "v1_9");
  assert.equal(nextCursor('<https://x/y?cursor=a>; rel="first"'), null);
  assert.equal(nextCursor(null), null);
});

test("a failed delivery is redelivered once; one that succeeded or was handled isn't", async (t) => {
  const path = join(tempDir(t), "redeliveries.json");
  const github = fakeApp({
    "": [
      delivery(5, "ok-later", 1, 202, { redelivery: true }),
      delivery(4, "handled", 2, 0),
      delivery(3, "lost", 3, 0),
      delivery(2, "ok-later", 4, 503),
      delivery(1, "refused", 5, 413),
    ],
  });
  const logs = [];
  const make = () =>
    createRedeliveries({
      path,
      app: github.app,
      handled: (guid) => guid === "handled",
      now: () => NOW,
      log: (line) => logs.push(line),
    });
  const first = make();
  assert.equal(await first.scan(), 1);
  assert.deepEqual(github.redelivered(), ["3"]);
  assert.match(logs[0], /^Redelivered lost \(issue_comment created, .*: Couldn't connect\)$/);
  // Again, and after a restart: not twice.
  assert.equal(await first.scan(), 0);
  assert.equal(await make().scan(), 0);
  assert.deepEqual(github.redelivered(), ["3"]);
});

test("a redelivery GitHub refuses is asked again at the next scan", async () => {
  let refuse = true;
  const github = fakeApp(
    { "": [delivery(1, "lost", 1, 0)] },
    { attempt: () => new Response("{}", { status: refuse ? 502 : 202 }) },
  );
  const redeliveries = createRedeliveries({ app: github.app, now: () => NOW });
  assert.equal(await redeliveries.scan(), 0);
  refuse = false;
  assert.equal(await redeliveries.scan(), 1);
  assert.deepEqual(github.redelivered(), ["1", "1"]);
});

test("the scan pages back to the last one (3 days at most), then only as far as that", async (t) => {
  const path = join(tempDir(t), "redeliveries.json");
  let now = NOW;
  const github = fakeApp({
    "": [delivery(3, "c", 1, 0), delivery(2, "b", 60, 0)],
    v1_2: [delivery(1, "a", 2 * 24 * 60, 0)],
    // Past the 3 days: read, the listing stops there, and not asked for.
    v1_3: [delivery(0, "old", 4 * 24 * 60, 0)],
  });
  const redeliveries = createRedeliveries({ path, app: github.app, now: () => now });
  assert.equal(await redeliveries.scan(), 3);
  assert.deepEqual(github.redelivered(), ["1", "2", "3"]);
  assert.deepEqual(github.listed(), [
    "/app/hook/deliveries?per_page=100",
    "/app/hook/deliveries?per_page=100&cursor=v1_2",
    "/app/hook/deliveries?per_page=100&cursor=v1_3",
  ]);
  // Five minutes later: the first page reaches past the last scan, so it is the only one read.
  now += 5 * MIN;
  assert.equal(await redeliveries.scan(), 0);
  assert.equal(github.listed().length, 4);
});

test("no App yet: nothing is asked", async () => {
  const redeliveries = createRedeliveries({ app: () => null });
  assert.equal(await redeliveries.scan(), null);
});

test("a listing that fails throws, and the next scan still looks back as far", async () => {
  let down = true;
  const github = fakeApp({ "": [delivery(1, "lost", 1, 0)] });
  const failing = {
    asApp: async (method, path) =>
      down ? new Response("{}", { status: 503 }) : github.app().asApp(method, path),
  };
  const redeliveries = createRedeliveries({ app: () => failing, now: () => NOW });
  await assert.rejects(redeliveries.scan(), /deliveries: 503/);
  down = false;
  assert.equal(await redeliveries.scan(), 1);
});

test("a redelivery request that fails outright doesn't lose the others asked in that scan", async (t) => {
  const path = join(tempDir(t), "redeliveries.json");
  let down = true;
  const github = fakeApp(
    { "": [delivery(2, "second", 1, 0), delivery(1, "first", 2, 0)] },
    {
      attempt: (path) => {
        if (down && path.includes("/2/")) throw new Error("socket hang up");
        return new Response(null, { status: 202 });
      },
    },
  );
  const logs = [];
  const make = () =>
    createRedeliveries({ path, app: github.app, now: () => NOW, log: (l) => logs.push(l) });
  const first = make();
  assert.equal(await first.scan(), 1);
  assert.ok(logs.includes("Redeliveries: second: socket hang up"));
  // Kept for the next listener: only the failed one is asked again.
  down = false;
  const next = make();
  assert.equal(next.redelivered("first"), true);
  assert.equal(next.redelivered("second"), false);
  assert.equal(await next.scan(), 1);
  assert.deepEqual(github.redelivered(), ["1", "2", "2"]);
});
