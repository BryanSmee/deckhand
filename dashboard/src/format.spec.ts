import { describe, expect, test } from "vitest";
import fixture from "./fixture.json";
import { inChip, repoTabs, titleOf, when } from "./format";
import type { State, Task } from "./types";

const state = fixture as State;
const task = (key: string) => state.tasks.find((t) => t.key === key)!;

describe("repo tabs", () => {
  test("most recently active first, repo names alone for one owner", () => {
    expect(repoTabs(state.tasks).map((t) => t.label)).toEqual(["deckhand", "shiny-piece", "notes"]);
  });

  test("owner/repo once there is more than one owner", () => {
    const other = { ...task("BryanSmee/notes#4"), key: "acme/site#1", repo: "acme/site" };
    expect(repoTabs([...state.tasks, other]).map((t) => t.label)).toContain("acme/site");
    expect(repoTabs([...state.tasks, other]).map((t) => t.label)).toContain("BryanSmee/deckhand");
  });
});

test("state chips group states: a waiting brainstorm needs input", () => {
  const states = (chip: Parameters<typeof inChip>[0]) =>
    state.tasks.filter((t) => inChip(chip, t)).map((t) => t.state);
  expect(states("running").sort()).toEqual(["building-image", "queued", "working"]);
  expect(states("input").sort()).toEqual(["brainstorm", "idle-brainstorm", "needs-input"]);
  expect(states("error").sort()).toEqual(["error", "interrupted"]);
  expect(states("all")).toHaveLength(state.tasks.length);
});

test("titles: GitHub's, else the kind and number", () => {
  expect(titleOf(task("BryanSmee/deckhand#22"))).toBe(
    "Dashboard on a frontend framework, built at image build time",
  );
  expect(titleOf(task("BryanSmee/shiny-piece#127"))).toBe("Issue #127");
  const pr: Task = { ...task("BryanSmee/shiny-piece#pr-141"), title: null };
  expect(titleOf(pr)).toBe("Pull request #141");
});

test("what a row says besides its state", () => {
  const now = state.now;
  expect(when(task("BryanSmee/deckhand#22"), now)).toBe("7 min");
  expect(when(task("BryanSmee/deckhand#23"), now)).toBe("reply on #23");
  expect(when(task("BryanSmee/deckhand#20"), now)).toBe("idle in 6 min");
  expect(when(task("BryanSmee/shiny-piece#138"), now)).toBe("3 h ago");
});
