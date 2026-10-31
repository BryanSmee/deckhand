import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createWaits, issueList, waitsFor } from "../listener/waits.mjs";
import { tempDir } from "./helpers.mjs";

// `t` null: removed when the file's tests end.
const tempPath = (t = null) => join(tempDir(t), "waits.json");

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
// fake comments. `allowed`: what resume() answers ("answers": the issue's questions are open),
// changed later through `w.allowed`.
function setup({ issues = { 77: open, 80: open }, path = tempPath(), allowed = true } = {}) {
  const w = {
    issues,
    replies: [],
    resumed: [],
    settled: [],
    eyes: [],
    calls: [],
    timers: [],
    path,
    allowed,
  };
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
    resume: async (i) => (w.resumed.push(i), w.allowed),
    now: () => 1000,
    later: (fn, ms) => w.timers.push([fn, ms]),
  });
  return w;
}

test("issueList", () => {
  assert.equal(issueList([7]), "#7");
  assert.equal(issueList([7, 8]), "#7 and #8");
  assert.equal(issueList([7, 8, 9]), "#7, #8 and #9");
  assert.equal(waitsFor({ blockers: [7] }), "#7");
  assert.equal(waitsFor({ blockers: [], answers: true }), "the answers to its open questions");
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
  assert.equal(statSync(w.path).mode & 0o777, 0o600);
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
      answers: false,
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

test("done, but the issue's questions are open: it waits for the answers, then starts", async () => {
  const w = setup({ allowed: "answers" });
  await w.waits.request(item({ numbers: [77] }));
  await w.waits.closed("org/repo", 77, "done");
  assert.equal(w.resumed.length, 1);
  assert.match(
    w.replies.at(-1)[1],
    /^#77 is done, but this issue's open questions aren't answered/,
  );
  assert.deepEqual(w.settled, []);
  const kept = JSON.parse(readFileSync(w.path, "utf8"))["org/repo#78"];
  assert.deepEqual([kept.blockers, kept.answers, kept.item.text], [[], true, "Do it."]);
  assert.equal(w.waits.list()[0].answers, true);
  // Another issue's label, then a check while still unanswered: it keeps waiting, quietly.
  await w.waits.answered("org/repo", 79);
  await w.waits.check();
  assert.equal(w.resumed.length, 2);
  assert.equal(w.replies.length, 2);
  assert.equal(w.waits.get("org/repo#78").answers, true);
  // Answered: the label came off.
  w.allowed = true;
  await w.waits.answered("Org/Repo", 78);
  assert.equal(w.resumed.length, 3);
  assert.equal(await w.resumed[2].eyes, 4242);
  assert.match(w.replies.at(-1)[1], /^The open questions are answered: starting\.$/);
  assert.equal(w.waits.list().length, 0);
  assert.deepEqual(JSON.parse(readFileSync(w.path, "utf8")), {});
  // Nothing waits any more: nothing to start.
  await w.waits.answered("org/repo", 78);
  assert.equal(w.resumed.length, 3);
});

test("a wait for answers: cancelled by a new comment, dropped when it may no longer run", async () => {
  const w = setup({ allowed: "answers" });
  await w.waits.request(item({ numbers: [77] }));
  await w.waits.closed("org/repo", 77, "done");
  await w.waits.request(item({ none: true }, { trigger: null, text: "" }));
  assert.match(w.replies.at(-1)[1], /^No longer waiting for the answers to its open questions\.$/);
  await w.waits.request(item({ numbers: [77] }, { id: "79", number: 79, replyTo: 79 }));
  w.issues[77] = completed;
  await w.waits.closed("org/repo", 77, "done");
  w.allowed = false;
  await w.waits.answered("org/repo", 79);
  assert.equal(w.waits.list().length, 0);
  assert.deepEqual(w.settled.at(-1), [900, "stopped", 4242]);
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
  // With a trigger line: cancelled whatever happens to the run, and it runs now.
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

test("waits survive a restart; the check catches what closed meanwhile", async (t) => {
  const path = tempPath(t);
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

test("recheck: asks about that one issue only, nothing when no wait is for it", async () => {
  const w = setup();
  await w.waits.request(item({ numbers: [77, 80] }));
  w.calls.length = 0;
  assert.equal(await w.waits.recheck("org/repo", 81), null);
  assert.equal(await w.waits.recheck("org/other", 77), null);
  assert.deepEqual(w.calls, []);
  assert.equal(await w.waits.recheck("org/repo", 77), "open");
  assert.deepEqual(w.calls, ["/repos/org/repo/issues/77"]);
  w.issues[77] = completed;
  assert.equal(await w.waits.recheck("Org/Repo", 77), "done");
  assert.deepEqual(w.waits.get("org/repo#78").blockers, [80]);
  w.issues[80] = merged;
  await w.waits.recheck("org/repo", 80);
  assert.equal(w.resumed.length, 1);
  assert.match(w.replies.at(-1)[1], /^#80 is done: starting\.$/);
});

test("recheck: one coming while another is under way asks again after it", async () => {
  const w = setup();
  await w.waits.request(item({ numbers: [77] }));
  w.calls.length = 0;
  const first = w.waits.recheck("org/repo", 77);
  // Before the first one starts: they share it.
  assert.equal(w.waits.recheck("org/repo", 77), first);
  await Promise.resolve();
  await Promise.resolve();
  // The first one has asked: the state may have changed since, so this one asks again.
  w.issues[77] = completed;
  const second = w.waits.recheck("org/repo", 77);
  assert.notEqual(second, first);
  assert.equal(w.waits.recheck("org/repo", 77), second);
  assert.equal(await first, "open");
  assert.equal(await second, "done");
  assert.equal(w.calls.length, 2);
  assert.equal(w.resumed.length, 1);
});

test("merged: the issue a merged pull request closes, asked again later while still open", async () => {
  const w = setup();
  await w.waits.request(item({ numbers: [77] }));
  // Merged into another branch, or GitHub hasn't closed #77 yet: the wait stays.
  assert.equal(await w.waits.merged("org/repo", 77), "open");
  assert.equal(w.resumed.length, 0);
  assert.equal(w.timers.length, 1);
  assert.equal(w.timers[0][1], 30_000);
  w.issues[77] = completed;
  w.timers[0][0]();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(w.resumed.length, 1);
  // Closed already: no later check.
  await w.waits.request(item({ numbers: [80] }, { id: "79", number: 79, replyTo: 79 }));
  w.issues[80] = completed;
  assert.equal(await w.waits.merged("org/repo", 80), "done");
  assert.equal(w.timers.length, 1);
});

test("respell: a wait saved under another spelling of its repo moves to the one given", async () => {
  const w = setup();
  await w.waits.request(item({ numbers: [77] }));
  assert.deepEqual(w.waits.keys(), ["org/repo#78"]);
  w.waits.respell((repo) => (repo.toLowerCase() === "org/repo" ? "Org/repo" : repo));
  assert.deepEqual(w.waits.keys(), ["Org/repo#78"]);
  const wait = w.waits.get("Org/repo#78");
  assert.equal(wait.repo, "Org/repo");
  assert.equal(wait.item.repo, "Org/repo");
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(w.path, "utf8"))), ["Org/repo#78"]);
});
