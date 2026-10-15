import assert from "node:assert/strict";
import { test } from "node:test";
import { board } from "../listener/board.mjs";

const run = (key, startedAt, extra = {}) => ({
  id: `${key}-${startedAt}`,
  key,
  repo: key.split("#")[0],
  kind: "issue",
  replyTo: Number(key.split("#")[1]),
  mode: "start",
  startedAt,
  status: "ok",
  ...extra,
});

test("each issue's state reflects the listener's", () => {
  const tasks = board({
    runs: [
      run("acme/api#1", 90, { status: "running", phase: "building image" }),
      run("acme/api#2", 80, { status: "running" }),
      run("acme/web#3", 70, { status: "running", kind: "brainstorm", mode: "wrap-up" }),
      run("acme/web#4", 60, { status: "needs-input" }),
      run("solo/tool#5", 50, { kind: "brainstorm" }),
      run("solo/tool#6", 40, { kind: "brainstorm" }),
      run("solo/tool#7", 30, { status: "error" }),
      run("solo/tool#8", 20, { status: "interrupted" }),
      run("solo/tool#9", 10),
      run("acme/web#4", 5),
    ],
    queued: [{ key: "acme/api#10", kind: "issue", repo: "acme/api", replyTo: 11 }],
    brainstorms: [
      { key: "solo/tool#5", repo: "solo/tool", number: 5, status: "active", deadline: 55 },
      { key: "solo/tool#6", repo: "solo/tool", number: 6, status: "idle", deadline: 45 },
    ],
  });
  const states = Object.fromEntries(tasks.map((t) => [t.key, t.state]));
  assert.deepEqual(states, {
    "acme/api#1": "building-image",
    "acme/api#2": "working",
    "acme/web#3": "stopping",
    "acme/api#10": "queued",
    "solo/tool#5": "brainstorm",
    "acme/web#4": "needs-input",
    "solo/tool#6": "idle-brainstorm",
    "solo/tool#7": "error",
    "solo/tool#8": "interrupted",
    "solo/tool#9": "done",
  });
  // Live ones first, then by latest activity; grouped by owner and repo.
  assert.deepEqual(
    tasks.slice(0, 4).map((t) => t.key),
    ["acme/api#1", "acme/api#2", "acme/web#3", "acme/api#10"],
  );
  const queued = tasks.find((t) => t.key === "acme/api#10");
  assert.deepEqual(
    [queued.project, queued.repo, queued.number, queued.replyTo, queued.runs],
    ["acme", "acme/api", 10, 11, []],
  );
  const four = tasks.find((t) => t.key === "acme/web#4");
  assert.deepEqual(
    four.runs.map((r) => r.startedAt),
    [60, 5],
  );
  assert.equal(tasks.find((t) => t.key === "solo/tool#5").kind, "brainstorm");
});

test("a running run wins over comments queued for the next one", () => {
  const [task] = board({
    runs: [run("acme/api#1", 10, { status: "running" })],
    queued: [{ key: "acme/api#1", kind: "issue", repo: "acme/api", replyTo: 1 }],
    brainstorms: [],
  });
  assert.equal(task.state, "working");
});

test("a comment waiting for other issues: its state and what it waits for", () => {
  const wait = (key, fields = {}) => ({
    key,
    repo: "acme/api",
    kind: "issue",
    mode: "work",
    replyTo: Number(key.split("#")[1]),
    blockers: [77, 80],
    since: 50,
    ...fields,
  });
  const tasks = board({
    runs: [
      run("acme/api#1", 10, { status: "running" }),
      run("acme/api#2", 20),
      run("acme/api#3", 30),
    ],
    queued: [{ key: "acme/api#3", kind: "issue", repo: "acme/api", replyTo: 3 }],
    brainstorms: [],
    waits: [
      wait("acme/api#1"),
      wait("acme/api#2"),
      wait("acme/api#3"),
      wait("acme/api#4", { mode: "review" }),
    ],
  });
  const byKey = Object.fromEntries(tasks.map((t) => [t.key, t]));
  // Its run goes on, or its queued comments go first: the wait is for the run after.
  assert.equal(byKey["acme/api#1"].state, "working");
  assert.equal(byKey["acme/api#3"].state, "queued");
  assert.equal(byKey["acme/api#2"].state, "waiting");
  assert.equal(byKey["acme/api#2"].since, 50);
  assert.deepEqual(byKey["acme/api#1"].waitingFor, [77, 80]);
  // Only a wait: a task of its own.
  assert.equal(byKey["acme/api#4"].state, "waiting");
  assert.equal(byKey["acme/api#4"].mode, "review");
  assert.equal(byKey["acme/api#4"].kind, "issue");
  assert.equal(byKey["acme/api#4"].replyTo, 4);
});

test("a stopped brainstorm shows how its last run ended", () => {
  const [task] = board({
    runs: [run("acme/api#1", 10, { kind: "brainstorm", mode: "wrap-up" })],
    queued: [],
    brainstorms: [{ key: "acme/api#1", repo: "acme/api", status: "stopped", deadline: 5 }],
  });
  assert.equal(task.state, "done");
});

test("pull requests and discussions keep their number and kind", () => {
  const tasks = board({
    runs: [
      run("acme/api#pr-14", 20, { kind: "pr", replyTo: 14 }),
      run("acme/api#discussion-8", 10, { kind: "discussion", replyTo: 8 }),
    ],
    queued: [],
    brainstorms: [],
  });
  assert.deepEqual(
    tasks.map((t) => [t.number, t.kind]),
    [
      [14, "pr"],
      [8, "discussion"],
    ],
  );
});

test("each entry names its mode, the repo's own ones included", () => {
  const tasks = board({
    runs: [
      run("acme/api#1", 30, { taskMode: "review" }),
      run("acme/api#2", 20, { taskMode: "work" }),
      run("acme/api#3", 10, { taskMode: "review" }),
    ],
    queued: [{ key: "acme/api#3", kind: "issue", mode: "triage", repo: "acme/api", replyTo: 3 }],
    brainstorms: [{ key: "acme/api#4", repo: "acme/api", number: 4, status: "active" }],
  });
  const modes = Object.fromEntries(tasks.map((t) => [t.key, t.mode]));
  // A queued comment says what the next run will be.
  assert.deepEqual(modes, {
    "acme/api#1": "review",
    "acme/api#2": "work",
    "acme/api#3": "triage",
    "acme/api#4": "brainstorm",
  });
});

test("issues labelled needs-input show as such, with or without a run, unless one is live", () => {
  const tasks = board({
    runs: [
      run("acme/api#1", 30),
      run("acme/api#2", 20, { status: "running" }),
      run("acme/api#3", 10, { status: "error" }),
    ],
    queued: [{ key: "acme/api#4", kind: "issue", repo: "acme/api", replyTo: 4 }],
    brainstorms: [{ key: "acme/api#5", repo: "acme/api", number: 5, status: "active" }],
    inputs: [
      "acme/api#1",
      "acme/api#2",
      "acme/api#3",
      "acme/api#4",
      "acme/api#5",
      "solo/tool#9",
    ].map((key) => ({ key, repo: key.split("#")[0], since: 40 })),
  });
  const states = Object.fromEntries(tasks.map((t) => [t.key, t.state]));
  assert.deepEqual(states, {
    "acme/api#1": "needs-input",
    "acme/api#2": "working",
    "acme/api#3": "needs-input",
    "acme/api#4": "queued",
    "acme/api#5": "brainstorm",
    "solo/tool#9": "needs-input",
  });
  // Filed by an inbox run: no run of its own.
  const filed = tasks.find((t) => t.key === "solo/tool#9");
  assert.deepEqual(
    [filed.project, filed.repo, filed.number, filed.kind, filed.replyTo, filed.since, filed.runs],
    ["solo", "solo/tool", 9, "issue", 9, 40, []],
  );
});
