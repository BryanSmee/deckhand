// What the orchestrator's deliveries (http.mjs deliver()) pass on to the waits (waits.mjs),
// the conflicts' watcher (conflicts.mjs) and the dashboard's pull requests (pulls.mjs): an issue
// closed, a pull request merged. The waits are waits.mjs's own, with a fake GitHub.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createHttp } from "../listener/http.mjs";
import { createWaits } from "../listener/waits.mjs";
import { testConfig } from "./helpers.mjs";

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
  const ctx = {
    config: testConfig({ ALLOWED_REPOS: "org/repo" }),
    log: () => {},
    skip: () => null,
    tasks: new Map(),
    runs: [],
    app: { remember: () => {}, identity: () => ({ name: "deckhand[bot]" }) },
    repoList: { refresh: () => {} },
    pulls: {
      record: () => false,
      ciChanged: async () => {},
      baseMoved: (repo) => s.moved.push(repo),
    },
    conflicts: { soon: async (repo) => s.soon.push(repo) },
    titles: { setClosed: () => {} },
    reviews: {
      consider: async () => {},
      pushed: async () => {},
      closed: async () => {},
      checksDone: async () => {},
    },
    waits: s.waits,
    admit: async () => {},
  };
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
