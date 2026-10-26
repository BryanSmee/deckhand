import { describe, expect, test } from "vitest";
import fixture from "./fixture.json";
import {
  inChip,
  isPrTask,
  kindName,
  ownMode,
  plural,
  repoTabs,
  sameRepo,
  runKindName,
  runName,
  shortRepo,
  taskTone,
  titleOf,
  toneOf,
  uptime,
  versionUrl,
  when,
} from "./format";
import type { Run, State, Task } from "./types";

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
  expect(states("input").sort()).toEqual(["brainstorm", "idle-brainstorm", "needs-input"]);
  expect(states("error").sort()).toEqual(["error", "interrupted"]);
  expect(states("all")).toHaveLength(state.tasks.length);
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
          "building-image",
          "working",
          "stopping",
          "running",
          "needs-input",
          "brainstorm",
          "idle-brainstorm",
          "queued",
          "waiting",
          "cancelled",
          "done",
          "ok",
          "error",
          "interrupted",
        ] as const
      ).map((s) => [s, toneOf(s)]),
    );
    expect(tones).toEqual({
      "building-image": "run",
      working: "run",
      stopping: "run",
      running: "run",
      "needs-input": "input",
      brainstorm: "input",
      "idle-brainstorm": "idle",
      queued: "idle",
      waiting: "idle",
      cancelled: "idle",
      done: "done",
      ok: "done",
      error: "err",
      interrupted: "err",
    });
  });

  test("a ready pull request is the task's tone once nothing runs, fails or asks", () => {
    const ready = { number: 1, url: "", state: "ready" as const, readyAt: null };
    expect(taskTone({ state: "done", pr: ready })).toBe("ready");
    expect(taskTone({ state: "queued", pr: ready })).toBe("ready");
    expect(taskTone({ state: "working", pr: ready })).toBe("run");
    expect(taskTone({ state: "needs-input", pr: ready })).toBe("input");
    expect(taskTone({ state: "error", pr: ready })).toBe("err");
    expect(taskTone({ state: "done", pr: null })).toBe("done");
  });
});
