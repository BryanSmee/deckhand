// The conflict watcher on the workflow engine (#1040): a repo's own workflow on `conflict`, its
// instance across a handover and a redelivered webhook, and errors that stop it. The built-in
// workflow's behaviour is conflicts.test.mjs's, unchanged.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createConflicts, rebaseMessage } from "../listener/conflicts.mjs";
import { parseRepoConfig } from "../listener/repo-config.mjs";
import { createWorkflows } from "../listener/workflows.mjs";
import { mapStore, testConfig } from "./helpers.mjs";

const MIN = 60_000;
const config = testConfig({ CONFLICT_CHECK_MINUTES: "5" });
const settings = parseRepoConfig("conflicts:\n  check_minutes: 10", config);

const pull = (fields = {}) => ({
  number: 31,
  title: "PR 31",
  state: "open",
  mergeable: false,
  mergeable_state: "dirty",
  labels: [],
  head: { sha: "head-1", repo: { full_name: "org/repo" } },
  base: { ref: "main", sha: "stale" },
  ...fields,
});

const blob = (text) => ({ content: Buffer.from(text).toString("base64"), encoding: "base64" });

// The watcher with fake GitHub, its workflows read from `files` (name → text) on main, its
// attempts and instances in `maps` (a handover: the next one on maps.again()). `policies`: its
// policies' engine (none without); `hang`: accept() queues the item, then never returns.
async function setup(maps, { files = {}, again = false, policies = null, hang = false } = {}) {
  let time = 1_800_000_000_000;
  const w = {
    pr: pull(),
    baseSha: "base-1",
    files,
    accepted: [],
    replies: [],
    logged: [],
    calls: [],
    advance: (ms) => (time += ms),
  };
  const routes = {
    "/repos/org/repo": () => ({ default_branch: "main" }),
    "/repos/org/repo/git/ref/heads/main": () => ({ object: { sha: w.baseSha } }),
    "/repos/org/repo/issues/30": () => ({ labels: [] }),
    "/repos/org/repo/pulls/31": () => w.pr,
    "/repos/org/repo/pulls/31/files?per_page=100&page=1": () => [{ filename: "db/1.sql" }],
    "/repos/org/repo/contents/.deckhand/workflows?ref=main": () =>
      Object.keys(w.files).length
        ? Object.keys(w.files).map((name) => ({
            type: "file",
            name,
            sha: `sha-${name}-${w.files[name].length}`,
          }))
        : null,
  };
  const github = async (repo, method, url) => {
    w.calls.push(url);
    const blobbed = /\/git\/blobs\/sha-(.+)-\d+$/.exec(url);
    const body = blobbed ? blob(w.files[blobbed[1]]) : routes[url]?.();
    return body
      ? new Response(JSON.stringify(body), { status: 200 })
      : new Response("{}", { status: 404 });
  };
  const map = again ? maps.again : maps.map;
  w.attempts = await map("conflicts");
  w.workflows = createWorkflows({ github, now: () => time });
  w.conflicts = createConflicts({
    attempts: w.attempts,
    instances: await map("workflows"),
    workflows: w.workflows,
    config,
    pulls: { open: () => [["org/repo#30", { number: 31, state: "draft" }]] },
    github,
    repoSettings: async () => settings,
    busy: () => false,
    accept: async (item) => {
      w.accepted.push(item);
      if (hang) await new Promise(() => {});
    },
    policies,
    reply: async (repo, number, text) => w.replies.push(text),
    log: (line) => w.logged.push(line),
    now: () => time,
    sleep: async () => {},
  });
  return w;
}

const OWN = `on: conflict
vars:
  rebases: counter
steps:
  - if: label("hold")
    comment: On hold, no rebase.
    else:
      - if: rebases < 1
        run: rebase
        count: rebases
        else:
          - comment: Rebased once already, over to a maintainer.
  - if: paths("db/**")
    comment: Check the migrations after the rebase.
`;

test("without a workflow of its own, the repo runs the built-in one: one rebase run", async () => {
  const w = await setup(mapStore());
  await w.conflicts.tick();
  assert.equal(w.accepted.length, 1);
  assert.equal(w.accepted[0].text, rebaseMessage("main"));
  assert.equal(w.conflicts.instance("org/repo#30").workflow.name, "built-in");
  assert.equal(w.conflicts.instance("org/repo#30").waiting, 0);
});

test("the repo's own workflow: its conditions, its counter, its comments after the run", async () => {
  const maps = mapStore();
  const w = await setup(maps, { files: { "conflicts.yaml": OWN } });
  await w.conflicts.tick();
  assert.equal(w.accepted.length, 1);
  assert.deepEqual(w.replies, []);
  // The run's end: the next step, its condition read from the pull request's files.
  assert.equal(
    await w.conflicts.ended({ key: "org/repo#30", repo: "org/repo", number: 31, base: "main" }),
    "done",
  );
  assert.deepEqual(w.replies, ["Check the migrations after the rebase."]);
  // Still in conflict at a new head: rebased once already, so no second run.
  w.pr = pull({ head: { sha: "head-2", repo: { full_name: "org/repo" } } });
  w.advance(10 * MIN);
  await w.conflicts.tick();
  assert.equal(w.accepted.length, 1);
  assert.deepEqual(w.replies.slice(1), [
    "Rebased once already, over to a maintainer.",
    "Check the migrations after the rebase.",
  ]);
  // Labelled hold, at a new base: the hold's comment alone.
  w.pr = pull({ labels: [{ name: "hold" }] });
  w.baseSha = "base-2";
  w.advance(10 * MIN);
  await w.conflicts.tick();
  assert.equal(w.replies.at(-2), "On hold, no rebase.");
});

test("an instance survives a handover and a redelivered webhook: no second run", async () => {
  const maps = mapStore();
  const first = await setup(maps, { files: { "conflicts.yaml": OWN } });
  await first.conflicts.tick();
  assert.equal(first.accepted.length, 1);

  // The next orchestrator, then the push that moved main delivered again (soon()): the same
  // pair, already its workflow's, starts nothing, even with its attempt lost.
  const next = await setup(maps, { files: { "conflicts.yaml": OWN }, again: true });
  next.attempts.delete("org/repo#30");
  await next.conflicts.soon("org/repo");
  assert.equal(next.accepted.length, 0);
  // Waiting at its rebase step for the run's end.
  assert.equal(next.conflicts.instance("org/repo#30").waiting, 4);

  // The rebase run ends under the next orchestrator: the workflow goes on there, once.
  const after = { key: "org/repo#30", repo: "org/repo", number: 31, base: "main" };
  assert.equal(await next.conflicts.ended(after), "done");
  assert.equal(await next.conflicts.ended(after), "idle");
  assert.deepEqual(next.replies, ["Check the migrations after the rebase."]);
});

test("a repo whose workflows have errors gets no conflict run, and the pass says why", async () => {
  const w = await setup(mapStore(), {
    files: {
      "a.yaml": "on: conflict\nsteps:\n  - run: rebase\n",
      "b.yaml": "on: conflict\nsteps:\n  - if: sevrity < low\n    run: rebase\n",
    },
  });
  const { started, errors } = await w.conflicts.tick();
  assert.equal(started, 0);
  assert.deepEqual(w.accepted, []);
  assert.match(
    errors[0],
    /^org\/repo: its workflows have errors: `.deckhand\/workflows\/b.yaml` line 3: `if`: unknown condition `sevrity`/,
  );
  // Fixed on the default branch, whose push forgets the listing: the run starts.
  w.files = { "b.yaml": "on: conflict\nsteps:\n  - run: rebase\n" };
  w.workflows.forget("org/repo");
  w.advance(10 * MIN);
  assert.equal((await w.conflicts.tick()).started, 1);
});

// A watcher cut off in the middle of its rebase step (`cut`: setup()'s options for it), and
// the next one on the same store.
async function handedOver(cut) {
  const maps = mapStore();
  const first = await setup(maps, { files: { "conflicts.yaml": OWN }, ...cut });
  first.conflicts.tick().catch(() => {});
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
  const next = await setup(maps, { files: { "conflicts.yaml": OWN }, again: true });
  return { first, next };
}

const after = { key: "org/repo#30", repo: "org/repo", number: 31, base: "main" };

test("a handover during the policies' answer: the next orchestrator starts the rebase run", async () => {
  const hanging = { decide: () => new Promise(() => {}) };
  const { first, next } = await handedOver({ policies: hanging });
  assert.deepEqual([first.accepted, [...first.attempts.keys()]], [[], []]);
  assert.equal((await next.conflicts.tick()).started, 1);
  assert.equal(next.accepted.length, 1);
  assert.equal(next.conflicts.instance("org/repo#30").vars.counters.rebases, 1);
  // Its end goes on with the workflow, once.
  assert.equal(await next.conflicts.ended(after), "done");
  assert.deepEqual(next.replies, ["Check the migrations after the rebase."]);
});

test("a handover after the run was queued: no second run, and its end goes on", async () => {
  const { first, next } = await handedOver({ hang: true });
  assert.equal(first.accepted.length, 1);
  await next.conflicts.tick();
  assert.equal(next.accepted.length, 0);
  assert.equal(await next.conflicts.ended(after), "done");
  assert.deepEqual(next.replies, ["Check the migrations after the rebase."]);
  assert.equal(next.conflicts.instance("org/repo#30").vars.counters.rebases, 1);
  assert.equal(await next.conflicts.ended(after), "idle");
});

test("a rebase after a run's end while GitHub computes mergeable takes nothing", async () => {
  const twice = `on: conflict
vars:
  n: counter
steps:
  - repeat:
      - run: rebase
        count: n
    max: n 2
  - comment: done
`;
  const w = await setup(mapStore(), { files: { "conflicts.yaml": twice } });
  await w.conflicts.tick();
  w.pr = pull({
    mergeable: null,
    mergeable_state: "unknown",
    head: { sha: "head-2", repo: { full_name: "org/repo" } },
  });
  assert.equal(await w.conflicts.ended(after), "skipped");
  assert.deepEqual([w.accepted.length, w.replies], [1, []]);
});
