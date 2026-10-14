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
