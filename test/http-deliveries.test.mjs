// What the orchestrator's deliveries (http.mjs deliver()) pass on: to the waits (waits.mjs),
// the conflicts' watcher (conflicts.mjs) and the dashboard's pull requests (pulls.mjs), an issue
// closed, a pull request merged; to the reviews and reviewers, a pull request's and a workflow
// run's (#808). The waits are waits.mjs's own, with a fake GitHub; the reviews record what they
// were asked, their decisions being reviews.test.mjs's.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createHttp } from "../listener/http.mjs";
import { createWaits } from "../listener/waits.mjs";
import { httpCtx } from "./helpers.mjs";

const repository = { full_name: "org/repo", default_branch: "trunk" };

// A comment on #12 that waits for #77, as workItem() and admit() leave it.
const waiting = (text) => ({
  repo: "org/repo",
  id: "12",
  kind: "issue",
  number: 12,
  trigger: "work",
  modeLine: null,
  after: { numbers: [77] },
  text,
  replyTo: 12,
  comment: { id: 99, user: { login: "alice" } },
  author: "alice",
  base: "trunk",
});

// createHttp() with waits.mjs's waits over `issues` (number → GitHub's issue), and what the
// deliveries asked of the rest: `asked` (GitHub's paths), `replies`, `resumed` (the comments
// started), `moved` (pulls.mjs baseMoved()) and `soon` (conflicts.mjs soon()).
function setup() {
  const s = { issues: { 77: { state: "open" } }, asked: [], replies: [], resumed: [] };
  s.moved = [];
  s.soon = [];
  s.waits = createWaits({
    github: async (repo, method, path) => {
      s.asked.push(path);
      const issue = s.issues[/\/issues\/(\d+)$/.exec(path)?.[1]];
      return issue ? Response.json(issue) : new Response("{}", { status: 404 });
    },
    reply: async (repo, number, text) => s.replies.push([number, text]),
    received: () => {},
    settle: async () => {},
    resume: async (item) => (s.resumed.push(item), true),
    later: () => {},
  });
  const ctx = httpCtx({
    pulls: {
      record: () => false,
      ciChanged: async () => {},
      baseMoved: (repo) => s.moved.push(repo),
    },
    conflicts: { soon: async (repo) => s.soon.push(repo) },
    waits: s.waits,
  });
  s.http = createHttp(ctx);
  return s;
}

const closed = (state_reason) => ({
  event: "issues",
  payload: {
    action: "closed",
    installation: { id: 7 },
    repository,
    issue: { number: 77, state: "closed", state_reason },
    sender: { login: "bob" },
  },
});

// Pull request #90, saying "Closes #77", merged into `base`.
const merged = (base = "trunk") => ({
  event: "pull_request",
  payload: {
    action: "closed",
    installation: { id: 7 },
    repository,
    pull_request: {
      number: 90,
      state: "closed",
      merged: true,
      merged_at: "2026-10-15T00:00:00Z",
      body: "Closes #77",
      base: { ref: base },
      head: { ref: "issue-77-parser", repo: { full_name: "org/repo" } },
    },
    sender: { login: "bob" },
  },
});

test("/after: an issues delivery closing #77 as completed starts the comment; as not planned drops the wait", async () => {
  const s = setup();
  assert.equal(await s.waits.request(waiting("First.")), true);
  await s.http.deliver(closed("not_planned"));
  assert.match(s.replies.at(-1)[1], /^#77 was closed without being done/);
  assert.deepEqual([s.resumed, s.waits.list()], [[], []]);

  await s.waits.request(waiting("Second."));
  await s.http.deliver(closed("completed"));
  assert.deepEqual(
    s.resumed.map((item) => item.text),
    ["Second."],
  );
  assert.match(s.replies.at(-1)[1], /^#77 is done: starting\./);
  assert.deepEqual(s.waits.list(), []);
});

test("/after: a merged pull request that closes #77 asks GitHub about #77, with no issues delivery", async () => {
  const s = setup();
  await s.waits.request(waiting("On top of it."));
  // The merge went to the default branch: GitHub closed #77 as completed.
  s.issues[77] = { state: "closed", state_reason: "completed" };
  s.asked.length = 0;
  await s.http.deliver(merged());
  assert.deepEqual(s.asked, ["/repos/org/repo/issues/77"]);
  assert.deepEqual(
    s.resumed.map((item) => item.text),
    ["On top of it."],
  );
  assert.match(s.replies.at(-1)[1], /^#77 is done: starting\./);
  assert.deepEqual(s.waits.list(), []);
});

test("conflicts: a merge into the default branch checks its pull requests soon, and the dashboard's conflicts again (#747)", async () => {
  const s = setup();
  await s.http.deliver(merged());
  assert.deepEqual(s.soon, ["org/repo"]);
  assert.deepEqual(s.moved, ["org/repo"]);
  // Into another branch: the default branch didn't move.
  await s.http.deliver(merged("release"));
  assert.deepEqual([s.soon, s.moved], [["org/repo"], ["org/repo"]]);
});

// The orchestrator's deliveries, with fake reviews and reviewers recording their calls.
function deliveries() {
  const calls = [];
  const logged = [];
  const record = (name) => async (event, payload) => calls.push([name, event, payload]);
  const ctx = httpCtx({
    log: (line) => logged.push(line),
    reviews: {
      consider: record("consider"),
      pushed: record("pushed"),
      closed: record("closed"),
      checksDone: record("checksDone"),
    },
    reviewers: { ready: record("reviewers.ready") },
  });
  return { http: createHttp(ctx), calls, logged };
}

const base = {
  installation: { id: 1 },
  repository: { full_name: "org/repo", default_branch: "trunk" },
  sender: { login: "deckhand[bot]", type: "Bot" },
};
const pull = {
  number: 13,
  body: "Closes #12",
  state: "open",
  draft: false,
  user: { login: "deckhand[bot]", type: "Bot" },
  head: { sha: "head-1", ref: "issue-12-fix", repo: { full_name: "org/repo" } },
};

test("a pull_request delivery goes to the reviews (ready, pushed, closed) and the reviewers", async () => {
  const { http, calls, logged } = deliveries();
  const ready = { ...base, action: "ready_for_review", pull_request: pull };
  await http.deliver({ event: "pull_request", payload: ready });
  assert.deepEqual(
    calls.map(([name, event, payload]) => [name, event, payload === ready]),
    [
      ["consider", "pull_request", true],
      ["reviewers.ready", "pull_request", true],
      ["pushed", "pull_request", true],
      ["closed", "pull_request", true],
    ],
  );
  // Merged: the follow-ups' closed() has it too.
  calls.length = 0;
  const merged = {
    ...base,
    action: "closed",
    pull_request: { ...pull, state: "closed", merged_at: "2026-11-02T10:00:00Z" },
  };
  await http.deliver({ event: "pull_request", payload: merged });
  assert.ok(calls.some(([name, , payload]) => name === "closed" && payload === merged));
  assert.doesNotMatch(logged.join("\n"), /failed/);
});

test("a workflow_run delivery goes to the reviews' checksDone() alone", async () => {
  const { http, calls } = deliveries();
  const done = {
    ...base,
    sender: { login: "github-actions[bot]", type: "Bot" },
    action: "completed",
    workflow_run: { id: 5, head_sha: "head-1", status: "completed", conclusion: "failure" },
  };
  await http.deliver({ event: "workflow_run", payload: done });
  assert.deepEqual(
    calls.map(([name, event, payload]) => [name, event, payload === done]),
    [["checksDone", "workflow_run", true]],
  );
});

test("a repository out of the installation, deleted or made private: the policies forget it (#855)", async () => {
  const forgotten = [];
  const refreshed = [];
  const ctx = httpCtx({
    policies: { forget: (repo) => forgotten.push(repo) },
    repoList: { refresh: (repo) => refreshed.push(repo ?? "*") },
    onboarding: { onboard: async () => {} },
  });
  const http = createHttp(ctx);
  const sender = { login: "bob" };
  await http.deliver({
    event: "installation_repositories",
    payload: {
      action: "removed",
      installation: { id: 7 },
      repositories_removed: [{ full_name: "org/repo" }, { full_name: "org/lib" }],
      sender,
    },
  });
  assert.deepEqual(forgotten, ["org/repo", "org/lib"]);
  for (const action of ["privatized", "deleted"]) {
    await http.deliver({
      event: "repository",
      payload: { action, installation: { id: 7 }, repository, sender },
    });
  }
  assert.deepEqual(forgotten, ["org/repo", "org/lib", "org/repo", "org/repo"]);
  assert.deepEqual(refreshed, ["*", "*", "*"]);
  // A comment forgets nothing.
  await http.deliver({
    event: "issue_comment",
    payload: { action: "created", installation: { id: 7 }, repository, sender },
  });
  assert.equal(forgotten.length, 4);
});
