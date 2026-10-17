import { describe, expect, test } from "vitest";
import fixture from "./fixture.json";
import {
  inChip,
  isPrTask,
  kindName,
  ownMode,
  plural,
  repoTabs,
  runKindName,
  runName,
  shortRepo,
  titleOf,
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
