// A commit pushed after the last review (#535): "Outdated" with both shas in the task page's
// Review loop section, a "Review outdated" mark on its rows, and Review still offered for the
// new head. Also a maintainer's reviews alone, without a loop: "Reviews".
import { render, screen, within } from "@testing-library/preact";
import { beforeEach, expect, test } from "vitest";
import { Dashboard } from "./App";
import { reviewOffers, reviewOutdated } from "./format";
import { Overview } from "./Overview";
import { makeState, makeTask, mockApi } from "./testUtils";
import type { PullRequest, ReviewLoop, ReviewRound, State, Task } from "./types";

const REVIEWED = "aaaaaaa1111111111111111111111111111111";
const HEAD = "bbbbbbb2222222222222222222222222222222";
const round = (n: number, head: string | null, blocking = 0): ReviewRound => ({
  round: n,
  at: n,
  head,
  counts: { critical: 0, high: blocking, medium: 0, low: 0 },
  blocking,
});
const loop = (over: Partial<ReviewLoop> = {}): ReviewLoop => ({
  loop: "clean",
  round: 1,
  rounds: 2,
  history: [round(0, "0000000", 1), round(1, REVIEWED)],
  ...over,
});
const URL = "https://github.example.com/acme/app/pull/25";
const pr = (over: Partial<PullRequest> = {}): PullRequest => ({
  number: 25,
  url: URL,
  state: "ready",
  readyAt: 1,
  head: HEAD,
  ...over,
});
const task = (over: Partial<Task> = {}) =>
  makeTask({ state: "done", pr: pr(), review: loop(), ...over });

test("reviewOutdated: the loop over, both heads known and different, the pull request open", () => {
  expect(reviewOutdated(task())).toEqual({ reviewed: REVIEWED, head: HEAD });
  expect(reviewOutdated(task({ pr: pr({ state: "draft" }) }))).not.toBeNull();
  for (const loop of ["stopped", "rounds-out", "fixed", "ci-failed"] as const) {
    expect(reviewOutdated(task({ review: { ...task().review!, loop } }))).not.toBeNull();
  }
  // The same head: up to date.
  expect(reviewOutdated(task({ pr: pr({ head: REVIEWED }) }))).toBeNull();
  // Either one unknown (older entries): never a false alarm.
  expect(reviewOutdated(task({ pr: pr({ head: undefined }) }))).toBeNull();
  expect(reviewOutdated(task({ review: loop({ history: [round(0, null)] }) }))).toBeNull();
  expect(reviewOutdated(task({ review: loop({ history: [] }) }))).toBeNull();
  // The loop going on: a new head is expected.
  for (const l of ["reviewing", "fixing", "checks", "ci", "ci-fix"] as const) {
    expect(reviewOutdated(task({ review: loop({ loop: l }) }))).toBeNull();
  }
  // Merged or closed: nothing to review again.
  expect(reviewOutdated(task({ pr: pr({ state: "merged" }) }))).toBeNull();
  expect(reviewOutdated(task({ pr: pr({ state: "closed" }) }))).toBeNull();
  expect(reviewOutdated(task({ pr: null }))).toBeNull();
  expect(reviewOutdated(task({ review: undefined }))).toBeNull();
  // Review stays offered on it.
  expect(reviewOffers(task()).review).toBe(true);
});

const KEY = "acme/app#22";
const state = makeState();
const withTask = (over: Partial<Task>): State => ({
  ...state,
  tasks: state.tasks.map((t) =>
    t.key === KEY ? { ...t, state: "done", pr: pr(), review: loop(), ...over } : t,
  ),
});

beforeEach(() => {
  history.replaceState(null, "", "#/tasks?task=acme%2Fapp%2322");
  mockApi();
});

test("the task page says Outdated with both shas, the row a mark; a new round clears them", () => {
  const { rerender } = render(<Dashboard state={withTask({})} error={null} />);
  const section = screen.getByRole("region", { name: "Review loop" });
  const heading = within(section).getByRole("heading");
  expect(heading.textContent).toBe(
    "Review loop · Nothing blocking · Outdated: reviewed aaaaaaa, head is now bbbbbbb",
  );
  expect(within(section).getByRole("link", { name: "aaaaaaa" }).getAttribute("href")).toBe(
    `${URL}/commits/${REVIEWED}`,
  );
  // The last round's chip shows its commit.
  expect(within(section).getAllByRole("listitem").at(-1)!.textContent).toContain("aaaaaaa");
  // Review offered, for the new head.
  const review = within(section).getByRole("button", { name: /Review/ });
  expect(review.getAttribute("title")).toContain("new head, bbbbbbb");
  const row = () =>
    screen.getByText("Dashboard on a frontend framework, built at image build time", {
      selector: "button span",
    }).parentElement!;
  expect(within(row()).getByText("Review outdated")).toBeTruthy();

  // Reviewed again at the new head: no mark.
  const again = loop({ round: 1, history: [...loop().history, round(1, HEAD)] });
  rerender(<Dashboard state={withTask({ review: again })} error={null} />);
  const now = screen.getByRole("region", { name: "Review loop" });
  expect(within(now).getByRole("heading").textContent).toBe("Review loop · Nothing blocking");
  expect(within(row()).queryByText("Review outdated")).toBeNull();
  expect(screen.queryByText(/Outdated/)).toBeNull();
});

test("no mark while the loop goes on, or once merged", () => {
  const { rerender } = render(
    <Dashboard
      state={withTask({ state: "in-review", review: loop({ loop: "reviewing" }) })}
      error={null}
    />,
  );
  expect(screen.queryByText(/outdated/i)).toBeNull();
  rerender(<Dashboard state={withTask({ pr: pr({ state: "merged" }) })} error={null} />);
  expect(screen.queryByText(/outdated/i)).toBeNull();
});

test("the Overview's ready row carries the mark, beside the findings left", () => {
  const outdated = task({
    key: "acme/app#40",
    number: 40,
    title: "Pushed since",
    review: loop({ loop: "stopped", round: 0, history: [round(0, REVIEWED, 2)] }),
  });
  render(
    <Overview
      state={makeState({}, [outdated])}
      github="https://github.example.com"
      onChip={() => {}}
    />,
  );
  const region = screen.getByRole("region", { name: "Waiting on you" });
  const row = within(region).getByText("Pushed since").closest("li")!;
  expect(within(row).getByText("2 high findings left after the review")).toBeTruthy();
  expect(within(row).getByText("Review outdated").getAttribute("title")).toBe(
    "Reviewed aaaaaaa, head is now bbbbbbb",
  );
});

test("a maintainer's reviews alone, no loop: Reviews, its state without fix rounds", () => {
  const manual = (over: Partial<ReviewLoop>) =>
    loop({
      manual: true,
      round: 0,
      rounds: 0,
      history: [{ ...round(0, HEAD, 1), manual: true }],
      ...over,
    });
  const { rerender } = render(
    <Dashboard state={withTask({ review: manual({ loop: "rounds-out" }) })} error={null} />,
  );
  const section = screen.getByRole("region", { name: "Reviews" });
  expect(within(section).getByRole("heading").textContent).toBe("Reviews · Blocking findings");
  expect(within(section).getByRole("listitem").getAttribute("title")).toMatch(
    /^A maintainer's review: 1 blocking/,
  );
  rerender(
    <Dashboard
      state={withTask({ review: manual({ loop: "clean", history: [round(0, REVIEWED)] }) })}
      error={null}
    />,
  );
  expect(
    within(screen.getByRole("region", { name: "Reviews" })).getByRole("heading").textContent,
  ).toBe("Reviews · Nothing blocking · Outdated: reviewed aaaaaaa, head is now bbbbbbb");
});
