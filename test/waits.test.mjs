import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createWaits, issueList } from "../listener/waits.mjs";

const tempPath = () => join(mkdtempSync(join(tmpdir(), "deckhand-")), "waits.json");

// GET /repos/org/repo/issues/{n} as GitHub has them.
const open = { state: "open" };
const completed = { state: "closed", state_reason: "completed" };
const notPlanned = { state: "closed", state_reason: "not_planned" };
const merged = { state: "closed", pull_request: { merged_at: "2026-10-01T00:00:00Z" } };
const unmerged = { state: "closed", pull_request: { merged_at: null } };

// A comment on issue 78, as workItem() and admit() leave it.
function item(after, fields = {}) {
  return {
    repo: "org/repo",
    id: "78",
    kind: "issue",
    number: 78,
    title: "Second",
    trigger: "work",
    modeLine: null,
    after,
    text: "Do it.",
    replyTo: 78,
    comment: { id: 900, user: { login: "alice" } },
    author: "alice",
    base: "main",
    settings: { users: ["alice"] },
    ...fields,
  };
}

// Waits with a fake GitHub (`issues`: number → issue, missing ones 404), a fake clock and
// fake comments. `allowed`: what resume() answers.
function setup({ issues = { 77: open, 80: open }, path = tempPath(), allowed = true } = {}) {
  const w = { issues, replies: [], resumed: [], settled: [], eyes: [], calls: [], path };
  w.waits = createWaits({
    path,
    github: async (repo, method, url) => {
      w.calls.push(url);
      const n = /\/issues\/(\d+)$/.exec(url)?.[1];
      const body = w.issues[n];
      if (body instanceof Error) throw body;
      return body
        ? new Response(JSON.stringify(body), { status: 200 })
        : new Response("{}", { status: 404 });
    },
    reply: async (repo, number, text) => w.replies.push([number, text]),
    received: (i) => {
      w.eyes.push(i.comment.id);
      i.eyes = Promise.resolve(4242);
    },
    settle: async (i, status) => w.settled.push([i.comment.id, status, await i.eyes]),
    resume: async (i) => (w.resumed.push(i), allowed),
    now: () => 1000,
  });
  return w;
}

test("issueList", () => {
  assert.equal(issueList([7]), "#7");
  assert.equal(issueList([7, 8]), "#7 and #8");
  assert.equal(issueList([7, 8, 9]), "#7, #8 and #9");
});

test("a comment waits for open issues, says so, and keeps its 👀", async () => {
  const w = setup();
  assert.equal(await w.waits.request(item({ numbers: [77, 80] })), true);
  assert.deepEqual(w.eyes, [900]);
  assert.equal(w.replies.length, 1);
  assert.match(w.replies[0][1], /^Waiting for #77 and #80: I'll start when they are done/);
  assert.match(w.replies[0][1], /`\/after none` cancels/);
  const saved = JSON.parse(readFileSync(w.path, "utf8"))["org/repo#78"];
  assert.deepEqual(saved.blockers, [77, 80]);
  assert.equal(saved.item.eyes, 4242);
  assert.equal(saved.item.text, "Do it.");
  assert.equal(saved.item.author, "alice");
  // Read again when it starts; not kept.
  assert.equal(saved.item.settings, undefined);
  assert.equal(saved.item.after, undefined);
  assert.deepEqual(w.waits.list(), [
    {
      key: "org/repo#78",
      repo: "org/repo",
      kind: "issue",
      mode: "work",
      replyTo: 78,
      blockers: [77, 80],
      since: 1000,
    },
  ]);
});

test("nothing starts until the last one is done; then the saved comment runs", async () => {
  const w = setup();
  await w.waits.request(item({ numbers: [77, 80] }, { modeLine: "review" }));
  await w.waits.closed("org/repo", 77, "done");
  assert.equal(w.resumed.length, 0);
  assert.deepEqual(w.waits.get("org/repo#78").blockers, [80]);
  // Another repo's #80 is not ours.
  await w.waits.closed("org/other", 80, "done");
  assert.equal(w.resumed.length, 0);
  await w.waits.closed("Org/Repo", 80, "done");
  assert.equal(w.resumed.length, 1);
  const started = w.resumed[0];
  assert.equal(started.text, "Do it.");
  assert.equal(started.modeLine, "review");
  assert.equal(await started.eyes, 4242);
  assert.match(w.replies.at(-1)[1], /^#80 is done: starting\.$/);
  assert.equal(w.waits.get("org/repo#78"), undefined);
  assert.deepEqual(JSON.parse(readFileSync(w.path, "utf8")), {});
});

test("closed without being done: no run, a reply says why, the wait is dropped", async () => {
  const w = setup();
  await w.waits.request(item({ numbers: [77] }));
  await w.waits.closed("org/repo", 77, "not-done");
  assert.equal(w.resumed.length, 0);
  assert.match(w.replies.at(-1)[1], /^#77 was closed without being done: I won't start\./);
  assert.deepEqual(w.settled, [[900, "stopped", 4242]]);
  assert.equal(w.waits.list().length, 0);
});

test("a comment that may no longer run loses its 👀 and says nothing", async () => {
  const w = setup({ allowed: false });
  await w.waits.request(item({ numbers: [77] }));
  await w.waits.closed("org/repo", 77, "done");
  assert.equal(w.resumed.length, 1);
  assert.equal(w.replies.length, 1);
  assert.deepEqual(w.settled, [[900, "stopped", 4242]]);
});

test("already done: it runs now; closed without being done or missing: refused", async () => {
  const w = setup({ issues: { 77: completed, 80: merged, 81: notPlanned, 82: unmerged } });
  assert.equal(await w.waits.request(item({ numbers: [77, 80] })), false);
  assert.equal(w.replies.length, 0);
  assert.equal(w.waits.list().length, 0);
  for (const [n, why] of [
    [81, /^#81 was closed without being done\. Nothing waits\.$/],
    [82, /^#82 was closed without being done/],
    [99, /^#99 isn't an issue or pull request of this repository/],
  ]) {
    assert.equal(await w.waits.request(item({ numbers: [77, n] })), true);
    assert.match(w.replies.at(-1)[1], why);
  }
  assert.equal(w.waits.list().length, 0);
  assert.deepEqual(w.eyes, []);
});

test("refused: no trigger line, its own number, a bad /after; GitHub down is still waiting", async () => {
  const w = setup({ issues: { 77: new Error("timeout") } });
  const refusals = [
    [item({ numbers: [77] }, { trigger: null }), /goes with a trigger line or a `\/mode` line/],
    [item({ numbers: [78] }), /^#78 can't wait for itself/],
    [item({ numbers: [12] }, { replyTo: 12 }), /^#12 can't wait for itself/],
    [
      item({ error: "`/after` takes issues of this repository only." }),
      /this repository only\. Nothing waits\.$/,
    ],
  ];
  for (const [i, why] of refusals) {
    assert.equal(await w.waits.request(i), true);
    assert.match(w.replies.at(-1)[1], why);
  }
  assert.equal(w.waits.list().length, 0);
  // Not knowing isn't done: it waits.
  assert.equal(await w.waits.request(item({ numbers: [77] })), true);
  assert.deepEqual(w.waits.list()[0].blockers, [77]);
});

test("/after again replaces the list; /after none and a new trigger cancel", async () => {
  const w = setup();
  await w.waits.request(item({ numbers: [77] }));
  await w.waits.request(item({ numbers: [80] }, { comment: { id: 901 } }));
  assert.deepEqual(w.waits.list()[0].blockers, [80]);
  // The replaced comment loses its 👀.
  assert.deepEqual(w.settled, [[900, "stopped", 4242]]);
  // "/after none" alone: cancelled, said so.
  assert.equal(await w.waits.request(item({ none: true }, { trigger: null })), true);
  assert.equal(w.replies.at(-1)[1], "No longer waiting for #80.");
  assert.equal(w.waits.list().length, 0);
  assert.equal(await w.waits.request(item({ none: true }, { trigger: null })), true);
  assert.equal(w.replies.at(-1)[1], "Nothing waits here.");
  // With a trigger line: cancelled, and it runs now.
  await w.waits.request(item({ numbers: [77] }));
  assert.equal(await w.waits.request(item({ none: true })), false);
  assert.equal(w.waits.list().length, 0);
  // A trigger comment without "/after" (tasks.mjs admit()).
  await w.waits.request(item({ numbers: [77] }));
  w.waits.cancel("org/repo#78");
  assert.equal(w.waits.list().length, 0);
  await w.waits.closed("org/repo", 77, "done");
  assert.equal(w.resumed.length, 0);
});

test("the waiting issue closed itself: its wait is dropped", async () => {
  const w = setup();
  await w.waits.request(item({ numbers: [77] }));
  await w.waits.closed("org/repo", 78, "not-done");
  assert.equal(w.waits.list().length, 0);
});

test("waits survive a restart; the check catches what closed meanwhile", async () => {
  const path = tempPath();
  const before = setup({ path });
  await before.waits.request(item({ numbers: [77, 80] }));
  await before.waits.request(item({ numbers: [77] }, { id: "79", number: 79, replyTo: 79 }));

  // The next listener: #77 was merged meanwhile, #80 is still open.
  const after = setup({ path, issues: { 77: merged, 80: open } });
  assert.equal(after.waits.list().length, 2);
  await after.waits.check();
  // One call per issue, however many wait for it.
  assert.deepEqual(after.calls.sort(), ["/repos/org/repo/issues/77", "/repos/org/repo/issues/80"]);
  assert.deepEqual(
    after.resumed.map((i) => i.id),
    ["79"],
  );
  assert.equal(await after.resumed[0].eyes, 4242);
  assert.deepEqual(after.waits.get("org/repo#78").blockers, [80]);
  after.issues[80] = completed;
  await after.waits.check();
  assert.deepEqual(
    after.resumed.map((i) => i.id),
    ["79", "78"],
  );
  assert.equal(after.waits.list().length, 0);
});
