import { expect, test } from "vitest";
import { age, backlogLine, laneCount, repoParts, WEEK_MS, waitingOnYou } from "./overview";
import { makeState, makeTask } from "./testUtils";

const pr = (state: "draft" | "ready", readyAt: number | null = null) => ({
  number: 40,
  url: "https://github.example.com/acme/app/pull/40",
  state,
  readyAt,
});

test("waiting on you: questions, a brainstorm's turn, failures and ready pull requests, oldest first", () => {
  const tasks = [
    makeTask({ number: 1, state: "needs-input", since: 300 }),
    makeTask({ number: 2, state: "brainstorm", kind: "brainstorm", since: 200 }),
    makeTask({ number: 3, state: "error", since: 400, rerunnable: true }),
    makeTask({ number: 4, state: "interrupted", since: 500 }),
    makeTask({ number: 5, state: "done", since: 50, pr: pr("ready", 100) }),
    // Not waiting on you: at work (on a ready pull request too), queued, idle, done, a draft.
    makeTask({ number: 6, state: "working", pr: pr("ready", 10) }),
    makeTask({ number: 7, state: "queued" }),
    makeTask({ number: 8, state: "idle-brainstorm", kind: "brainstorm" }),
    makeTask({ number: 9, state: "done", pr: pr("draft") }),
    makeTask({ number: 10, state: "cancelled" }),
  ];
  expect(waitingOnYou(tasks).map((r) => [r.task.number, r.need, r.at])).toEqual([
    [5, "ready", 100],
    [2, "turn", 200],
    [1, "input", 300],
    [3, "error", 400],
    [4, "error", 500],
  ]);
  // What asks comes first: a failed run with a ready pull request is a failure.
  const failed = makeTask({ state: "error", pr: pr("ready", 1) });
  expect(waitingOnYou([failed])[0].need).toBe("error");
});

test("a failure that no longer asks isn't waiting on you, nor failed on its card", () => {
  const dismissed = { by: "alice", at: 1 };
  const tasks = [
    makeTask({ number: 1, state: "error", dismissed }),
    makeTask({ number: 2, state: "interrupted", closed: "completed" }),
    makeTask({ number: 3, state: "error", pr: { ...pr("draft"), state: "merged" } }),
    makeTask({ number: 4, state: "error", pr: { ...pr("draft"), state: "closed" } }),
    // Dismissed, its pull request still ready: the review waits.
    makeTask({ number: 5, state: "error", dismissed, pr: pr("ready", 7) }),
    makeTask({ number: 6, state: "error" }),
  ];
  expect(waitingOnYou(tasks).map((r) => [r.task.number, r.need])).toEqual([
    [6, "error"],
    [5, "ready"],
  ]);
  expect(repoParts(tasks, 0).map((p) => p.words)).toEqual(["1 failed"]);
});

test("a repository's tasks by tone, ended ones for a week", () => {
  const now = 10 * WEEK_MS;
  const tasks = [
    makeTask({ number: 1, state: "working" }),
    makeTask({ number: 2, state: "working" }),
    makeTask({ number: 3, state: "needs-input" }),
    makeTask({ number: 4, state: "queued" }),
    makeTask({ number: 5, state: "idle-brainstorm" }),
    makeTask({ number: 6, state: "done", since: now - 1000 }),
    makeTask({ number: 7, state: "done", since: now - 2 * WEEK_MS }),
    makeTask({ number: 8, state: "cancelled", since: now - 2 * WEEK_MS }),
    makeTask({ number: 9, state: "done", since: 0, pr: pr("ready", 0) }),
    makeTask({ number: 10, state: "error" }),
  ];
  expect(repoParts(tasks, now).map((p) => [p.tone, p.count, p.words])).toEqual([
    ["run", 2, "2 running"],
    ["input", 1, "1 needs you"],
    ["ready", 1, "1 ready"],
    ["err", 1, "1 failed"],
    ["idle", 1, "1 queued"],
    ["idle", 1, "1 idle"],
    ["done", 1, "1 done this week"],
  ]);
  expect(repoParts([], now)).toEqual([]);
});

test("lanes: each chain of waiting issues, closed ones left out", () => {
  const state = makeState();
  // The fixture: #23 and #22 before #24, one lane.
  expect(laneCount("acme/app", state.tasks, state.edges, state.blockers)).toBe(1);
  expect(laneCount("ACME/APP", state.tasks, state.edges, state.blockers)).toBe(1);
  expect(laneCount("acme/api", state.tasks, state.edges, state.blockers)).toBe(0);
  const tasks = [1, 2, 3, 4, 5].map((n) => makeTask({ number: n, state: "queued" }));
  const edge = (from: number, to: number) => ({
    from: `acme/app#${from}`,
    to: `acme/app#${to}`,
    kind: "after" as const,
  });
  expect(laneCount("acme/app", tasks, [edge(1, 2), edge(3, 4), edge(4, 5)], [])).toBe(2);
  // As the board draws them: an arrow to itself, or twice, is no other lane.
  expect(laneCount("acme/app", tasks, [edge(1, 2), edge(1, 2), edge(3, 3)], [])).toBe(1);
  // One closed in the middle: the chain is cut, as on the board.
  const closed = tasks.map((t) =>
    t.number === 4 ? { ...t, state: "done" as const, closed: "completed" as const } : t,
  );
  expect(laneCount("acme/app", closed, [edge(1, 2), edge(3, 4), edge(4, 5)], [])).toBe(1);
});

test("the backlog line", () => {
  expect(backlogLine({ count: 12, more: false }, 4)).toBe("Backlog 12 · 4 lanes");
  expect(backlogLine({ count: 100, more: true }, 0)).toBe("Backlog 100+");
  expect(backlogLine(null, 1)).toBe("1 lane");
  expect(backlogLine(undefined, 0)).toBeNull();
});

test("how long a row has waited", () => {
  const min = 60000;
  expect(age(0, 30000)).toBe("now");
  expect(age(0, 12 * min)).toBe("12 min");
  expect(age(0, 5 * 60 * min + 59 * min)).toBe("5 h");
  expect(age(0, 3 * 24 * 60 * min)).toBe("3 d");
  expect(age(1000, 0)).toBe("now");
});
