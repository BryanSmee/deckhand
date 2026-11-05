// What hands the reviews their deliveries and runs (#808): the orchestrator's deliveries
// (http.mjs dispatch()) and a run's end (runs.mjs cleanUp()), each against a fake reviewer that
// records what it was asked. The decisions themselves are reviews.test.mjs's.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { openStore } from "../lib/store.mjs";
import { createHttp } from "../listener/http.mjs";
import { createRuns } from "../listener/runs.mjs";
import { openLog } from "../listener/runlog.mjs";
import { tempDir, testConfig } from "./helpers.mjs";

// The orchestrator's deliveries, with fake reviews and reviewers recording their calls.
function deliveries() {
  const calls = [];
  const logged = [];
  const record = (name) => async (event, payload) => calls.push([name, event, payload]);
  const ctx = {
    config: testConfig({ ALLOWED_REPOS: "org/repo" }),
    log: (line) => logged.push(line),
    skip: () => null,
    tasks: new Map(),
    runs: [],
    app: { remember: () => {}, identity: () => ({ name: "deckhand[bot]" }) },
    repoList: { refresh: () => {} },
    pulls: { record: () => false, ciChanged: async () => {} },
    titles: { setClosed: () => {} },
    waits: { recheck: async () => null, closed: async () => {}, merged: async () => null },
    admit: async () => {},
    reviews: {
      consider: record("consider"),
      pushed: record("pushed"),
      closed: record("closed"),
      checksDone: record("checksDone"),
    },
    reviewers: { ready: record("reviewers.ready") },
  };
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

// A run of #12 that ends at once (runs.mjs cleanUp()), the reviews recording what they hear.
async function endRun(t, handled) {
  const dir = tempDir(t);
  const heard = [];
  let exited;
  const runner = {
    state: async () => "exited",
    follow: (name, { onOut, onCaughtUp }) => {
      onCaughtUp?.();
      onOut(JSON.stringify({ type: "result", result: "Done.", duration_ms: 1000 }));
      return new Promise((resolve) => (exited = resolve));
    },
    kill: async () => exited?.(),
    close: () => exited?.(),
    closed: () => false,
    remove: async () => {},
  };
  const ctx = {
    config: testConfig(),
    log: () => {},
    logDir: dir,
    shotsDir: dir,
    answerGraceMs: 10,
    runner,
    running: 1,
    stopping: false,
    runs: [],
    tasks: new Map(),
    store: openStore("memory:"),
    broker: { runOf: () => ({ tokens: new Set(), scrubs: [] }), secretsOf: () => [], revoke() {} },
    onboarded: { isIssue: () => false },
    brainstorms: { replied: () => {} },
    saveLive: async () => {},
    removeLive: async () => true,
    deliver: () => false,
    answer: async () => {},
    publicUrl: () => "https://deck.example",
    label: async () => {},
    track: () => {},
    settle: () => {},
    startLater: () => {},
    schedule: () => {},
    reviews: {
      runEnded: (repo) => heard.push(["runEnded", repo]),
      fixed: async (run) => heard.push(["fixed", run]),
      ciFixed: async (run) => heard.push(["ciFixed", run]),
    },
  };
  const runs = createRuns(ctx);
  const key = "org/repo#12";
  const logPath = join(dir, "run.log");
  const task = {
    repo: "org/repo",
    id: "12",
    kind: "issue",
    number: 12,
    base: "trunk",
    name: "deckhand-org-repo-12",
    pending: [],
    next: {},
    running: true,
    settings: null,
  };
  task.live = {
    id: "run",
    key,
    mode: "work",
    talk: false,
    light: false,
    record: { id: "run", key, agent: "claude", model: "opus", effort: "medium", startedAt: 0 },
    logFile: openLog(logPath),
    secret: "s3cret",
    replyTo: { kind: "issue", number: 13 },
    asked: { kind: "issue", number: 13 },
    open: true,
    replied: false,
    lines: { out: 0, err: 0 },
    result: null,
    later: {},
    unanswered: [],
    handled,
    cancelled: null,
    answered: false,
  };
  task.live.record.logPath = logPath;
  ctx.tasks.set(key, task);
  const following = runs.follow(task);
  await runner.kill();
  await following;
  return heard;
}

test("a run's end: the CI step told of any run, a review's fix run's outcome to fixed()", async (t) => {
  // An ordinary run: its repo's CI waits decided again (a CI fix run may wait for the task).
  assert.deepEqual(await endRun(t, []), [["runEnded", "org/repo"]]);
  // A review's fix run, replying on #13: its outcome, for the review of what it pushed.
  assert.deepEqual(await endRun(t, [{ reason: "review-fix", replyTo: 13 }]), [
    ["fixed", { repo: "org/repo", number: 13, base: "trunk", status: "ok" }],
    ["runEnded", "org/repo"],
  ]);
});
