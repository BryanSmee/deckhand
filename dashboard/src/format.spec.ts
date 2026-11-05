import { describe, expect, test } from "vitest";
import fixture from "./fixture.json";
import { makeState, makeTask } from "./testUtils";
import {
  canDismiss,
  dayTime,
  inChip,
  isPrTask,
  kindName,
  ownMode,
  plural,
  repoCounts,
  repoTabs,
  reservedText,
  runningText,
  sameRepo,
  runKindName,
  runName,
  shortRepo,
  cleanReady,
  notClean,
  taskStatus,
  taskTone,
  titleOf,
  toneOf,
  uptime,
  versionUrl,
  when,
  whenTitle,
} from "./format";
import type { PrState, PullRequest, ReviewLoop, ReviewRound, Run, State, Task } from "./types";

const state = fixture as State;
const task = (key: string) => state.tasks.find((t) => t.key === key)!;

describe("repo tabs", () => {
  test("most recently active first, repo names alone for one owner", () => {
    expect(repoTabs(state.tasks).map((t) => t.label)).toEqual(["app", "api", "notes"]);
  });

  test("owner/repo once there is more than one owner", () => {
    const other = { ...task("acme/notes#4"), key: "other/site#1", repo: "other/site" };
    expect(repoTabs([...state.tasks, other]).map((t) => t.label)).toContain("other/site");
    expect(repoTabs([...state.tasks, other]).map((t) => t.label)).toContain("acme/app");
  });

  test("a repo spelled in two cases is one tab, under its latest spelling", () => {
    const old = {
      ...task("acme/notes#4"),
      key: "Storywake/storywake#1",
      repo: "Storywake/storywake",
      since: 1,
    };
    const recent = { ...old, key: "storywake/storywake#2", repo: "storywake/storywake", since: 2 };
    expect(repoTabs([old, recent])).toEqual([{ repo: "storywake/storywake", label: "storywake" }]);
    expect(repoTabs([{ ...old, since: 3 }, recent])).toEqual([
      { repo: "Storywake/storywake", label: "storywake" },
    ]);
  });
});

test("repo names compare without case", () => {
  expect(sameRepo("Storywake/storywake", "storywake/StoryWake")).toBe(true);
  expect(sameRepo("acme/app", "acme/api")).toBe(false);
  expect(sameRepo(null, null)).toBe(false);
});

test("state chips group states: a waiting brainstorm needs input", () => {
  const states = (chip: Parameters<typeof inChip>[0]) =>
    state.tasks.filter((t) => inChip(chip, t)).map((t) => t.state);
  expect(states("running").sort()).toEqual(["building-image", "queued", "waiting", "working"]);
  // A run taken from the queue whose agent hasn't started yet is running too.
  expect(inChip("running", makeTask({ state: "scheduled" }))).toBe(true);
  expect(states("input").sort()).toEqual(["brainstorm", "idle-brainstorm", "needs-input"]);
  // #127, interrupted, has its pull request merged since: only All lists it.
  expect(states("error").sort()).toEqual(["error"]);
  expect(states("all")).toHaveLength(state.tasks.length);
});

test("the Error chip leaves out failures that no longer ask: dismissed, closed or merged", () => {
  const failed = makeTask({ state: "interrupted" });
  const pr = (state: PrState) => ({ number: 2, url: "", state, readyAt: null });
  expect(inChip("error", failed)).toBe(true);
  expect(inChip("error", { ...failed, pr: pr("draft") })).toBe(true);
  for (const settled of [
    { ...failed, dismissed: { by: "alice", at: 1 } },
    { ...failed, closed: "completed" as const },
    { ...failed, closed: "not_planned" as const },
    { ...failed, pr: pr("merged") },
    { ...failed, pr: pr("closed") },
  ]) {
    expect(inChip("error", settled)).toBe(false);
    expect(inChip("all", settled)).toBe(true);
  }
});

test("Dismiss: a last run failed, lost or stopped, that still asks", () => {
  const run = (status: Run["status"]) => [{ ...task("acme/app#16").runs[0], status }];
  for (const state of ["error", "interrupted", "cancelled"] as const) {
    expect(canDismiss(makeTask({ state, runs: run(state) })), state).toBe(true);
  }
  // Done, a run going, the needs-input label since, dismissed already, closed.
  expect(canDismiss(makeTask({ state: "done", runs: run("ok") }))).toBe(false);
  expect(canDismiss(makeTask({ state: "working", runs: run("running") }))).toBe(false);
  expect(canDismiss(makeTask({ state: "needs-input", runs: run("error") }))).toBe(false);
  const failed = makeTask({ state: "error", runs: run("error") });
  expect(canDismiss({ ...failed, dismissed: { by: "alice", at: 1 } })).toBe(false);
  expect(canDismiss({ ...failed, closed: "completed" })).toBe(false);
});

test("titles: GitHub's, else the kind and number", () => {
  expect(titleOf(task("acme/app#22"))).toBe(
    "Dashboard on a frontend framework, built at image build time",
  );
  expect(titleOf(task("acme/api#127"))).toBe("Issue #127");
  const pr: Task = { ...task("acme/api#pr-141"), title: null };
  expect(titleOf(pr)).toBe("Pull request #141");
});

test("what a row says besides its state", () => {
  const now = state.now;
  expect(when(task("acme/app#22"), now)).toBe("7 min");
  expect(when(task("acme/app#23"), now)).toBe("reply on #23");
  expect(when(task("acme/app#24"), now)).toBe("after #23 and #22");
  expect(when(task("acme/app#20"), now)).toBe("idle in 6 min");
  expect(when(task("acme/api#138"), now)).toBe("3 h ago");
  // Its run started 5 h ago and ended 10 min ago: when it was last updated.
  expect(when(task("acme/api#131"), now)).toBe("10 min ago");
});

test("the time a row shows in full: its update and its last run's start", () => {
  const now = state.now;
  const t = task("acme/api#131");
  expect(whenTitle(t, now)).toBe(
    `Updated ${dayTime(t.updatedAt, now)} · last run started ${dayTime(t.runs[0].startedAt, now)}`,
  );
  // Labelled without a run.
  const asking = makeTask({ state: "needs-input", since: now - 60000, updatedAt: now - 60000 });
  expect(when(asking, now)).toBe("1 min ago");
  expect(whenTitle(asking, now)).toBe(`Updated ${dayTime(now - 60000, now)}`);
  // The rows that say something else have none.
  for (const key of ["acme/app#22", "acme/app#23", "acme/app#24", "acme/app#20", "acme/notes#4"]) {
    expect(whenTitle(task(key), now)).toBeNull();
  }
});

test("own modes: the repo's, never one of the listener's", () => {
  expect(ownMode("audit")).toBe("audit");
  for (const mode of ["work", "brainstorm", "onboarding", "stop", "idea", "bug", "review"]) {
    expect(ownMode(mode)).toBeNull();
  }
  expect(ownMode(null)).toBeNull();
});

test("run names: why the listener started a run itself", () => {
  const run = { mode: "continue", taskMode: "work", reason: null } as Run;
  expect(runName(run)).toBe("Continue");
  expect(runName({ ...run, reason: "conflict" })).toBe("Conflict · Continue");
  expect(runName({ ...run, reason: "review-fix" })).toBe("Review fix · Continue");
  expect(runName({ ...run, reason: "review-fix", round: 1, rounds: 1 })).toBe(
    "Review fix · Continue",
  );
  expect(runName({ ...run, reason: "review-fix", round: 2, rounds: 3 })).toBe(
    "Review fix 2/3 · Continue",
  );
  expect(runName({ ...run, reason: "ci-fix" })).toBe("CI fix · Continue");
  expect(runName({ ...run, reason: "ci-fix", round: 1, rounds: 2 })).toBe("CI fix 1/2 · Continue");
  expect(runName({ mode: "start", taskMode: "review", reason: "review" } as Run)).toBe(
    "Review · Start",
  );
});

test("plurals, short repo names and pull requests' own tasks", () => {
  expect(plural(1, "run")).toBe("1 run");
  expect(plural(3, "run")).toBe("3 runs");
  expect(plural(2, "earlier reply", "earlier replies")).toBe("2 earlier replies");
  expect(shortRepo("acme/app")).toBe("app");
  expect(isPrTask(task("acme/api#pr-141"))).toBe(true);
  // The issue a pull request closes is the issue's task.
  expect(isPrTask(task("acme/api#138"))).toBe(false);
});

test("run kinds as an analysis names them", () => {
  expect(
    ["work", "brainstorm", "bug", "discussion", "analyze", "research"].map(runKindName),
  ).toEqual(["Work", "Brainstorm", "Bug", "Discussion", "Analysis", "Research"]);
  expect(kindName({ kind: "research" })).toBe("Research");
  expect(runKindName("review")).toBe("Review");
  expect(runKindName("audit")).toBe("audit");
});

test("uptime and where a version's code is", () => {
  const min = 60000;
  expect([0, 12, 4 * 60 + 12, (3 * 24 + 4) * 60 + 59].map((m) => uptime(0, m * min))).toEqual([
    "0 min",
    "12 min",
    "4 h 12 min",
    "3 d 4 h",
  ]);
  // The browser's clock ahead of the server's never shows a negative uptime.
  expect(uptime(5 * min, 0)).toBe("0 min");
  const source = "https://github.com/acme/deckhand";
  expect(versionUrl({ version: "edge-1713fa6", source })).toBe(`${source}/commit/1713fa6`);
  expect(versionUrl({ version: "1.3.0-rc.1", source })).toBe(`${source}/releases/tag/v1.3.0-rc.1`);
  expect(versionUrl({ version: "dev", source })).toBeNull();
  expect(versionUrl({ version: "1.2.3foo", source })).toBeNull();
  expect(versionUrl({ version: "1.2.3", source: "" })).toBeNull();
});

describe("status tones", () => {
  test("each state has one of the six tones", () => {
    const tones = Object.fromEntries(
      (
        [
          "scheduled",
          "building-image",
          "working",
          "stopping",
          "running",
          "needs-input",
          "brainstorm",
          "idle-brainstorm",
          "queued",
          "in-review",
          "waiting",
          "cancelled",
          "done",
          "ok",
          "error",
          "interrupted",
        ] as const
      ).map((s) => [s, toneOf(s)]),
    );
    // Done is grey, still with its word: green is for a merged pull request alone. In review:
    // Deckhand still works on it.
    expect(tones).toEqual({
      scheduled: "run",
      "building-image": "run",
      working: "run",
      stopping: "run",
      running: "run",
      "needs-input": "input",
      brainstorm: "input",
      "idle-brainstorm": "idle",
      queued: "idle",
      "in-review": "run",
      waiting: "idle",
      cancelled: "idle",
      done: "idle",
      ok: "idle",
      error: "err",
      interrupted: "err",
    });
  });

  const pr = (over: Partial<PullRequest> = {}): PullRequest => ({
    number: 1,
    url: "",
    state: "ready",
    readyAt: null,
    head: "b2",
    ci: { sha: "b2", state: "passed", runs: [] },
    ...over,
  });
  const round = (blocking: number, head = "b2"): ReviewRound => ({
    round: 1,
    at: 1,
    head,
    counts: { critical: 0, high: blocking, medium: 0, low: 0 },
    blocking,
  });
  const review = (loop: ReviewLoop["loop"], last = round(0)): ReviewLoop => ({
    loop,
    round: 1,
    rounds: 2,
    history: [last],
  });

  test("a ready pull request is the task's tone once nothing runs, fails or asks", () => {
    const ready = pr();
    expect(taskTone({ state: "done", pr: ready })).toBe("ready");
    expect(taskTone({ state: "working", pr: ready })).toBe("run");
    expect(taskTone({ state: "scheduled", pr: ready })).toBe("run");
    expect(taskTone({ state: "needs-input", pr: ready })).toBe("input");
    expect(taskTone({ state: "error", pr: ready })).toBe("err");
    expect(taskStatus({ state: "done", pr: ready })).toEqual({
      tone: "ready",
      label: "Ready for review",
    });
  });

  test("green only for a merged pull request: a done run or task without one is grey", () => {
    expect(taskStatus({ state: "done", pr: null })).toEqual({ tone: "idle", label: "Done" });
    expect(taskTone({ state: "done", pr: pr({ state: "draft" }) })).toBe("idle");
    expect(taskTone({ state: "done", pr: pr({ state: "closed" }) })).toBe("idle");
    expect(taskStatus({ state: "done", pr: pr({ state: "merged" }) })).toEqual({
      tone: "done",
      label: "Done",
    });
    expect(taskTone({ state: "cancelled", pr: pr({ state: "merged" }) })).toBe("done");
    // What it does now still wins.
    expect(taskTone({ state: "working", pr: pr({ state: "merged" }) })).toBe("run");
    // Queued or waiting: its own tone and word, whatever its pull request (a run is on its way).
    expect(taskStatus({ state: "queued", pr: pr({ state: "merged" }) })).toEqual({
      tone: "idle",
      label: "Queued",
    });
    expect(taskStatus({ state: "queued", pr: pr() })).toEqual({ tone: "idle", label: "Queued" });
    expect(taskStatus({ state: "waiting", pr: pr({ conflict: true }) })).toEqual({
      tone: "idle",
      label: "Waiting",
    });
  });

  test("purple only when clean: CI passed (or none), no conflict, the loop over and clean", () => {
    const status = (over: Partial<PullRequest>, r?: ReviewLoop) =>
      taskStatus({ state: "done", pr: pr(over), review: r });
    expect(cleanReady({ pr: pr(), review: review("clean") })).toBe(true);
    expect(cleanReady({ pr: pr({ ci: { sha: "b2", state: "running", runs: [] } }) })).toBe(false);
    expect(cleanReady({ pr: pr(), review: review("reviewing") })).toBe(false);
    // No CI at all, or not read yet, counts as passed; an unknown conflict as none.
    expect(cleanReady({ pr: pr({ ci: { sha: "b2", state: "none", runs: [] } }) })).toBe(true);
    expect(cleanReady({ pr: pr({ ci: undefined }) })).toBe(true);
    expect(cleanReady({ pr: pr({ conflict: false }) })).toBe(true);
    // Not clean: amber, saying why.
    const failed = { ci: { sha: "b2", state: "failed" as const, runs: [] } };
    expect(status(failed)).toEqual({ tone: "input", label: "CI failed" });
    expect(status({}, review("ci-failed"))).toEqual({ tone: "input", label: "CI failed" });
    expect(status({ conflict: true })).toEqual({ tone: "input", label: "Conflict" });
    expect(status({}, review("rounds-out", round(2)))).toEqual({
      tone: "input",
      label: "Findings left",
    });
    expect(status({}, review("clean", round(0, "a1")))).toEqual({
      tone: "input",
      label: "Reviewed before last push",
    });
    const unclean: [Partial<PullRequest>, ReviewLoop?][] = [
      [failed],
      [{ conflict: true }],
      [{}, review("stopped", round(1))],
    ];
    for (const [over, r] of unclean) {
      expect(cleanReady({ pr: pr(over), review: r })).toBe(false);
      expect(notClean({ pr: pr(over), review: r })).not.toBeNull();
    }
    // CI still going, or the loop: on its way, the running tone.
    expect(status({ ci: { sha: "b2", state: "running", runs: [] } })).toEqual({
      tone: "run",
      label: "Waiting for CI",
    });
    expect(status({}, review("ci"))).toEqual({ tone: "run", label: "In review" });
    expect(taskTone({ state: "in-review", pr: pr(), review: review("reviewing") })).toBe("run");
    // A draft is never ready, nor says why.
    expect(notClean({ pr: pr({ state: "draft", conflict: true }) })).toBeNull();
  });
});

test("the sidebar's counts are the old tabs': running, and waiting on you", () => {
  const { tasks } = makeState();
  // The old tabs' rule, by hand: the Running chip's tasks, and the Needs input chip's.
  const old = (mine: typeof tasks) => ({
    live: mine.filter((t) => inChip("running", t)).length,
    input: mine.filter((t) => inChip("input", t)).length,
  });
  const counts = repoCounts(tasks, null);
  expect(counts.repos.map((c) => c.repo)).toEqual(repoTabs(tasks).map((t) => t.repo));
  expect(counts.all).toMatchObject(old(tasks));
  for (const c of counts.repos)
    expect(c).toMatchObject(old(tasks.filter((t) => sameRepo(t.repo, c.repo))));
  // The fixture's numbers, so a change to the rule shows here.
  expect(counts.repos.map(({ repo, live, input, moving }) => [repo, live, input, moving])).toEqual([
    ["acme/app", 3, 1, true],
    ["acme/api", 1, 1, true],
    ["acme/notes", 0, 1, false],
  ]);
  expect(counts.all).toEqual({ live: 4, input: 3, moving: true });
});

test("a repo from the address without a task still gets its line, counting nothing", () => {
  const { tasks } = makeState();
  const counts = repoCounts(tasks, "acme/new");
  expect(counts.repos.at(-1)).toEqual({ repo: "acme/new", live: 0, input: 0, moving: false });
  // Another spelling of a listed repo is that repo.
  expect(repoCounts(tasks, "ACME/app").repos).toHaveLength(3);
});

test("dayTime: today, yesterday, then the date", () => {
  const now = new Date(2026, 9, 14, 15, 0).getTime();
  const at = (d: number, h: number, m: number) => new Date(2026, 9, d, h, m).getTime();
  const time = (t: number) =>
    new Date(t).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
  expect(dayTime(at(14, 14, 31), now)).toBe(`today ${time(at(14, 14, 31))}`);
  expect(dayTime(at(13, 18, 40), now)).toBe(`yesterday ${time(at(13, 18, 40))}`);
  expect(dayTime(at(12, 9, 30), now)).toMatch(/^Oct 12, /);
});

describe("run slots", () => {
  test("the run count is the same with or without auto-pickup", () => {
    expect(runningText({ running: 2, maxParallel: 4 })).toBe("2 of 4 running");
    const auto = makeState({ running: 3, maxParallel: 4, autoPickup: { slots: 1, running: 1 } });
    expect(runningText(auto)).toBe("3 of 4 running");
  });

  test("the reserved slots say how many auto-picked runs hold them", () => {
    expect(reservedText({})).toBeNull();
    expect(reservedText({ autoPickup: { slots: 1, running: 0 } })).toBe(
      "1 auto-pickup slot (free)",
    );
    expect(reservedText({ autoPickup: { slots: 2, running: 1 } })).toBe(
      "2 auto-pickup slots (1 in use)",
    );
    expect(reservedText({ autoPickup: { slots: 2, running: 1, taken: 2 } })).toBe(
      "2 auto-pickup slots (1 in use, 1 held between runs)",
    );
    expect(reservedText({ autoPickup: { slots: 1, running: 0, taken: 1 } })).toBe(
      "1 auto-pickup slot (1 held between runs)",
    );
  });
});
