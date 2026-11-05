// The deliveries that move a run's questions (listener/http.mjs deliver()): a close or merge sets
// them aside, a pull request's label taken off or put back too, and a redelivery is handled as
// its issue or pull request is now, or as sent but for the questions when GitHub can't say. The
// orchestrator's own wiring of them is orchestrator-server.test.mjs's.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createDismissals } from "../listener/dismissals.mjs";
import { createHttp } from "../listener/http.mjs";
import { createPicks } from "../listener/picks.mjs";
import { httpCtx, testConfig } from "./helpers.mjs";

const repository = { full_name: "org/repo", default_branch: "main" };
const installation = { id: 7 };
const sender = { login: "bob", type: "User" };
const label = { name: "needs-input" };
const ASKED_AT = Date.parse("2026-11-01T12:00:00Z");
const iso = (minutes) => new Date(ASKED_AT + minutes * 60_000).toISOString();

// A run that stopped to ask, at ASKED_AT.
const asked = (key, more = {}) => ({
  id: `${key.replace(/[/#]/g, "-")}-1000`,
  key,
  repo: "org/repo",
  status: "needs-input",
  startedAt: 1000,
  finishedAt: ASKED_AT,
  ...more,
});

// The orchestrator's state and services a delivery touches: the dismissals and picks real, the
// rest recorded. `answers`: GitHub's answer by path (a value as JSON, a status, or nothing: 404).
function setup(runs, answers = {}) {
  const logs = [];
  const calls = [];
  const record =
    (name, value) =>
    (...args) => (calls.push([name, ...args]), value);
  const ctx = httpCtx({
    config: testConfig({ ALLOWED_USERS: "bob", ALLOWED_REPOS: "org/repo" }),
    log: (line) => logs.push(String(line)),
    skip: (why) => (logs.push(`skip: ${why}`), null),
    runs,
    dismissals: createDismissals({ now: () => ASKED_AT + 3_600_000 }),
    picks: createPicks(),
    titles: { set: () => {}, setClosed: record("closed") },
    waits: {
      closed: async () => {},
      merged: async () => null,
      recheck: async () => null,
      answered: async () => {},
    },
    inputs: { set: record("track"), update: record("update") },
    label: async () => new Response(null),
    repoSettings: async () => ({ settings: { users: ["bob"] }, errors: [] }),
    workApi: { stale: () => {} },
    autoPickup: { soon: () => {} },
    github: async (repo, method, path) => {
      calls.push(["github", method, path]);
      const answer = answers[path];
      if (answer === undefined) return new Response("Not Found", { status: 404 });
      if (typeof answer === "number") return new Response("", { status: answer });
      return Response.json(answer);
    },
  });
  const http = createHttp(ctx);
  const deliver = (event, payload, redelivered = false) =>
    http.deliver({ event, payload: { installation, repository, sender, ...payload }, redelivered });
  const aside = () => ctx.dismissals.list().map((d) => [d.key, d.runId, d.by]);
  // No unexpected throw on the way (admitted() logs one as its stack).
  const clean = () => assert.doesNotMatch(logs.join("\n"), /Error|failed/);
  return { ctx, logs, calls, deliver, aside, clean };
}

test("a close or merge sets the questions aside, ends the pick; a close before they asked, or closed unmerged, doesn't", async () => {
  const runs = [
    asked("org/repo#5", { autoPickup: true }),
    asked("org/repo#9", { autoPickup: true }),
    asked("org/repo#12"),
    asked("org/repo#13"),
  ];
  const s = setup(runs);
  const closed = { number: 5, title: "Five", state: "closed", state_reason: "completed" };
  await s.deliver("issues", { action: "closed", issue: { ...closed, closed_at: iso(5) } });
  // Pull request #19, which closes #9, merged with #9 left open.
  const merged = {
    number: 19,
    title: "Nine",
    state: "closed",
    merged: true,
    merged_at: iso(5),
    body: "Closes #9",
    head: { ref: "issue-9-nine", repo: { full_name: "org/repo" } },
  };
  await s.deliver("pull_request", { action: "closed", pull_request: merged });
  // #22, which would close #12, closed without merging; #13's close from before its run asked.
  const unmerged = {
    ...merged,
    number: 22,
    merged: false,
    merged_at: null,
    closed_at: iso(5),
    body: "Closes #12",
    head: { ref: "issue-12-twelve", repo: { full_name: "org/repo" } },
  };
  await s.deliver("pull_request", { action: "closed", pull_request: unmerged });
  const stale = { number: 13, state: "closed", closed_at: "2000-01-01T00:00:00Z" };
  await s.deliver("issues", { action: "closed", issue: stale });
  s.clean();
  assert.deepEqual(s.aside(), [
    ["org/repo#5", "org-repo-5-1000", null],
    ["org/repo#9", "org-repo-9-1000", null],
  ]);
  assert.deepEqual(
    s.logs.filter((line) => line.includes("set aside")),
    [
      "org/repo#5: closed, its last run's questions set aside",
      "org/repo#9: closed, its last run's questions set aside",
    ],
  );
  // The auto-picked ones' work is over.
  assert.equal(s.ctx.picks.ended("org/repo#5", "org-repo-5-1000"), true);
  assert.equal(s.ctx.picks.ended("org/repo#9", "org-repo-9-1000"), true);
  // Every close recorded, whatever it did to the questions.
  assert.deepEqual(
    s.calls.filter(([what]) => what === "closed").map(([, key, how]) => [key, how]),
    [
      ["org/repo#5", "completed"],
      ["org/repo#pr-19", "completed"],
      ["org/repo#pr-22", "not_planned"],
      ["org/repo#13", "completed"],
    ],
  );
});

test("a pull request's label taken off sets its run's questions aside; put back, they wait again", async () => {
  const s = setup([asked("org/repo#pr-6")]);
  const pull = { number: 6, title: "A change", state: "open", labels: [], updated_at: iso(5) };
  await s.deliver("pull_request", { action: "unlabeled", pull_request: pull, label });
  assert.deepEqual(s.aside(), [["org/repo#pr-6", "org-repo-pr-6-1000", "bob"]]);
  assert.ok(s.logs.includes("org/repo#pr-6: label removed, its last run's questions set aside"));
  // Put back after the set-aside (the dismissals' clock).
  const back = { ...pull, labels: [label], updated_at: iso(120) };
  await s.deliver("pull_request", { action: "labeled", pull_request: back, label });
  s.clean();
  assert.deepEqual(s.aside(), []);
  assert.ok(s.logs.includes("org/repo#pr-6: label put back, its last run's questions wait again"));
});

test("a pull request's unlabeled delivery redelivered after a newer run asked: an edit, nothing set aside", async () => {
  // #7 labelled again since by the run that asked: GitHub has it labelled now.
  const now = { number: 7, state: "open", draft: false, merged: false, updated_at: iso(1) };
  const s = setup([asked("org/repo#pr-7")], {
    "/repos/org/repo/pulls/7": { ...now, labels: [label] },
  });
  const then = { ...now, labels: [], updated_at: iso(-30) };
  await s.deliver("pull_request", { action: "unlabeled", pull_request: then, label }, true);
  s.clean();
  assert.deepEqual(
    s.logs.filter((line) => line.startsWith("Delivery")),
    [
      "Delivery pull_request unlabeled: redelivered, as org/repo#7 is now",
      "Delivery: pull_request edited from bob",
    ],
  );
  assert.deepEqual(s.aside(), []);
  // Still unlabelled on GitHub, and after the run asked: as sent, it sets them aside.
  const still = setup([asked("org/repo#pr-7")], {
    "/repos/org/repo/pulls/7": { ...now, labels: [] },
  });
  const later = { ...then, updated_at: iso(5) };
  await still.deliver("pull_request", { action: "unlabeled", pull_request: later, label }, true);
  assert.ok(still.logs.includes("Delivery: pull_request unlabeled from bob"));
  assert.deepEqual(still.aside(), [["org/repo#pr-7", "org-repo-pr-7-1000", "bob"]]);
});

test("an issue's unlabeled delivery redelivered after the label was put back: an edit, nothing set aside", async () => {
  const now = { number: 5, title: "Five", state: "open", labels: [label], updated_at: iso(2) };
  const s = setup([asked("org/repo#5")], { "/repos/org/repo/issues/5": now });
  // As it was then: after the run asked, before the label came back.
  const then = { ...now, labels: [], updated_at: iso(1) };
  await s.deliver("issues", { action: "unlabeled", issue: then, label }, true);
  s.clean();
  assert.deepEqual(
    s.logs.filter((line) => line.startsWith("Delivery")),
    [
      "Delivery issues unlabeled: redelivered, as org/repo#5 is now",
      "Delivery: issues edited from bob",
    ],
  );
  assert.deepEqual(s.aside(), []);
  assert.doesNotMatch(s.logs.join("\n"), /set aside/);
});

test("an issue's closed or unlabeled delivery redelivered while it can't be looked up: the close recorded, the questions left", async () => {
  const runs = [asked("org/repo#5"), asked("org/repo#6")];
  const s = setup(runs, { "/repos/org/repo/issues/5": 502, "/repos/org/repo/issues/6": 502 });
  const closed = {
    number: 5,
    title: "Five",
    state: "closed",
    state_reason: "completed",
    closed_at: iso(5),
    labels: [],
  };
  await s.deliver("issues", { action: "closed", issue: closed }, true);
  // #6's label taken off after the run asked: as sent, it would set them aside.
  const unlabelled = { number: 6, title: "Six", state: "open", labels: [], updated_at: iso(5) };
  await s.deliver("issues", { action: "unlabeled", issue: unlabelled, label }, true);
  assert.deepEqual(
    s.logs.filter((line) => line.startsWith("Delivery")),
    [
      "Delivery issues closed: redelivered, org/repo#5 not looked up (GitHub GET /repos/org/repo/issues/5: 502): handled as sent, its questions left as they are",
      "Delivery: issues closed from bob",
      "Delivery issues unlabeled: redelivered, org/repo#6 not looked up (GitHub GET /repos/org/repo/issues/6: 502): handled as sent, its questions left as they are",
      "Delivery: issues unlabeled from bob",
    ],
  );
  // The close recorded, for titles, waits and the backlog.
  assert.deepEqual(
    s.calls.filter(([what]) => what === "closed"),
    [["closed", "org/repo#5", "completed"]],
  );
  // But nothing of the questions: not set aside, the list of issues waiting untouched.
  assert.deepEqual(s.aside(), []);
  assert.deepEqual(
    s.calls.filter(([what]) => what === "track" || what === "update"),
    [],
  );
  assert.doesNotMatch(s.logs.join("\n"), /set aside/);
});
