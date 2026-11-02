// A task's pull request's CI (#436): its three states and nothing without runs, in the task
// header (a link to the failed run, else the Checks tab), All's list and the Overview's
// "Ready for review" rows.
import { render, screen, within } from "@testing-library/preact";
import { beforeEach, expect, test } from "vitest";
import { Dashboard } from "./App";
import { CiStatus } from "./CiStatus";
import { Overview } from "./Overview";
import { makeState } from "./testUtils";
import type { Ci, PullRequest, State } from "./types";

const PR: PullRequest = {
  number: 25,
  url: "https://github.example.com/acme/app/pull/25",
  state: "ready",
  readyAt: null,
  head: "abc",
};
const RUN = "https://github.example.com/acme/app/actions/runs/9";
const FAILED: Ci = {
  sha: "abc",
  state: "failed",
  runs: [
    { name: "test", state: "failed", url: RUN },
    { name: "ci/jenkins", state: "failed", url: null },
    { name: "Lint", state: "passed", url: null },
  ],
};
const RUNNING: Ci = {
  sha: "abc",
  state: "running",
  runs: [
    { name: "Lint", state: "running", url: null },
    { name: "CI", state: "passed", url: null },
  ],
};
const PASSED: Ci = {
  sha: "abc",
  state: "passed",
  runs: [{ name: "CI", state: "passed", url: null }],
};

beforeEach(() => history.replaceState(null, "", "#/tasks"));

test("running, failed and passed: an accessible label, the runs in its title", () => {
  const { rerender } = render(<CiStatus pr={{ ...PR, ci: RUNNING }} link />);
  const running = screen.getByRole("link", { name: "CI running" });
  expect(running.title).toBe("CI running\n… Lint\n✓ CI");
  // Nothing failed: the pull request's Checks tab.
  expect(running.getAttribute("href")).toBe(`${PR.url}/checks`);

  rerender(<CiStatus pr={{ ...PR, ci: FAILED }} link />);
  const failed = screen.getByRole("link", { name: "CI failed: test, ci/jenkins" });
  expect(failed.getAttribute("href")).toBe(RUN);
  expect(failed.title).toBe("CI failed: test, ci/jenkins\n✗ test\n✗ ci/jenkins\n✓ Lint");

  rerender(<CiStatus pr={{ ...PR, ci: PASSED }} link />);
  expect(screen.getByRole("link", { name: "CI passed" }).getAttribute("href")).toBe(
    `${PR.url}/checks`,
  );

  // Not a link: an icon with the same label (a row that is a button already).
  rerender(<CiStatus pr={{ ...PR, ci: PASSED }} />);
  expect(screen.queryByRole("link")).toBeNull();
  expect(screen.getByRole("img", { name: "CI passed" })).toBeTruthy();
});

test("a pull request without runs, or not read yet, shows nothing", () => {
  const { container, rerender } = render(
    <CiStatus pr={{ ...PR, ci: { sha: "abc", state: "none", runs: [] } }} link />,
  );
  expect(container.innerHTML).toBe("");
  rerender(<CiStatus pr={PR} link />);
  expect(container.innerHTML).toBe("");
});

// The fixture, with `ci` on task `key`'s pull request.
const withCi = (key: string, ci: Ci): State => {
  const state = makeState();
  return {
    ...state,
    tasks: state.tasks.map((t) => (t.key === key ? { ...t, pr: { ...t.pr!, ci } } : t)),
  };
};

test("the task header links its pull request's CI; All's row shows it too", () => {
  render(<Dashboard state={withCi("acme/app#22", FAILED)} error={null} />);
  const header = screen.getByRole("link", { name: "CI failed: test, ci/jenkins" });
  expect(header.getAttribute("href")).toBe(RUN);
  const row = screen
    .getByText("Dashboard on a frontend framework, built at image build time", {
      selector: "button span",
    })
    .closest("button");
  expect(row && within(row).getByRole("img", { name: "CI failed: test, ci/jenkins" })).toBeTruthy();
});

test("the Overview's Ready for review rows show their pull request's CI", () => {
  render(
    <Overview
      state={withCi("acme/api#131", PASSED)}
      github="https://github.example.com"
      onChip={() => {}}
    />,
  );
  const link = screen.getByRole("link", { name: "CI passed" });
  expect(link.getAttribute("href")).toBe("https://github.example.com/acme/api/pull/132/checks");
});
