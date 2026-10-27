// A task's Policies tab: shown only with decisions, newest first, policy errors told apart from
// denials, and the "Not merged automatically" badge while a denied auto-merge keeps it open.
import { fireEvent, render, screen, within } from "@testing-library/preact";
import { beforeEach, expect, test } from "vitest";
import { Dashboard } from "./App";
import { makeState } from "./testUtils";
import type { PolicyDecision, State, Task } from "./types";

const state = makeState();
// The task the dashboard opens first, with its draft pull request #25.
const KEY = "acme/app#22";

const decision = (over: Partial<PolicyDecision>): PolicyDecision => ({
  decision: "merge",
  rule: "deny_merge",
  denied: false,
  messages: [],
  pr: 25,
  at: state.now - 60_000,
  ...over,
});

const MERGE = decision({
  denied: true,
  messages: ["more than 400 changed lines", "labelled do-not-merge"],
  gates: [
    { name: "Checks green", passed: true },
    { name: "No trusted file changed", passed: true },
  ],
  input: { version: 1, decision: "merge", pr: { number: 25 } },
  at: state.now - 3_600_000,
});
// The three newest first: REVIEW, MERGE, ERROR.
const REVIEW = decision({ decision: "review", rule: "deny_review", at: state.now - 60_000 });
const ERROR = decision({
  denied: true,
  messages: ["policy error: payments.rego:7 didn't compile"],
  at: state.now - 7_200_000,
});

const withTask = (over: Partial<Task>): State => ({
  ...state,
  tasks: state.tasks.map((t) => (t.key === KEY ? { ...t, ...over } : t)),
});

const openTab = () => fireEvent.click(screen.getByRole("tab", { name: /^Policies/ }));
// The decisions' folds, not the input's inside them.
const decisions = (): HTMLElement[] => [
  ...(screen.getByRole("region", { name: "Policy decisions, newest first" })
    .children as HTMLCollectionOf<HTMLElement>),
];

// All's tasks: their rows and the open one.
beforeEach(() => history.replaceState(null, "", "#/tasks"));

test("no decision: no Policies tab, no badge", () => {
  render(<Dashboard state={state} error={null} />);
  expect(screen.queryByRole("tab", { name: /^Policies/ })).toBeNull();
  expect(screen.queryByText("Not merged automatically")).toBeNull();
});

test("the tab counts the decisions and lists them newest first; the newest denied starts open", () => {
  render(<Dashboard state={withTask({ decisions: [REVIEW, MERGE, ERROR] })} error={null} />);
  expect(screen.getByRole("tab", { name: "Policies 3" })).toBeTruthy();
  openTab();
  const [review, merge, error] = decisions();
  expect(review.textContent).toContain("Automatic review");
  expect(review.textContent).toContain("Allowed");
  expect(review.hasAttribute("open")).toBe(false);

  expect(merge.textContent).toContain("Auto-merge");
  expect(merge.textContent).toContain("Denied");
  expect(merge.textContent).toContain("deny_merge · 2 reasons");
  expect(merge.hasAttribute("open")).toBe(true);
  expect(within(merge).getByText("more than 400 changed lines")).toBeTruthy();
  expect(within(merge).getByText("Checks green")).toBeTruthy();
  expect(within(merge).getByText("The input the rules saw")).toBeTruthy();
  expect(merge.querySelector("pre")!.textContent).toContain('"version": 1');

  // A policy that failed is told apart from a rule's denial.
  expect(error.textContent).toContain("Policy error");
  expect(error.textContent).not.toContain("Denied");
  expect(error.textContent).toContain("payments.rego:7 didn't compile: denied, fail closed");
  expect(error.hasAttribute("open")).toBe(false);

  // The runs' tabs bring the log back.
  fireEvent.click(screen.getAllByRole("tab")[0]);
  expect(screen.queryByRole("region", { name: "Policy decisions, newest first" })).toBeNull();
});

test("the newest auto-merge denied on an open pull request: the badge and the summary", () => {
  render(<Dashboard state={withTask({ decisions: [REVIEW, MERGE] })} error={null} />);
  expect(screen.getByText("Not merged automatically")).toBeTruthy();
  openTab();
  expect(screen.getByText("A policy kept this pull request for a human")).toBeTruthy();
  expect(screen.getByText(/Deckhand's own gates passed .*; then/).textContent).toContain(
    "deny_merge returned 2 reasons.",
  );
  expect(screen.getByRole("link", { name: "Merge on GitHub ↗" }).getAttribute("href")).toBe(
    "https://github.example.com/acme/app/pull/25",
  );
});

test("no badge once the pull request merged, nor when the newest merge decision allowed it", () => {
  const pr = state.tasks.find((t) => t.key === KEY)!.pr!;
  const merged = withTask({ decisions: [MERGE], pr: { ...pr, state: "merged" } });
  const { rerender } = render(<Dashboard state={merged} error={null} />);
  expect(screen.queryByText("Not merged automatically")).toBeNull();

  const allowed = decision({ at: state.now });
  rerender(<Dashboard state={withTask({ decisions: [allowed, MERGE] })} error={null} />);
  expect(screen.queryByText("Not merged automatically")).toBeNull();
  openTab();
  expect(screen.queryByText("A policy kept this pull request for a human")).toBeNull();
});

test("the side cards: the last dry run, and the repository's policies", () => {
  const dryRun = {
    dryRun: true as const,
    by: "octocat",
    at: state.now - 60_000,
    denials: 2,
    url: "https://github.example.com/acme/app/pull/25#issuecomment-1",
  };
  render(<Dashboard state={withTask({ decisions: [REVIEW], dryRun })} error={null} />);
  openTab();
  expect(screen.getByText(/Last one: by @octocat .* · 2 denials/)).toBeTruthy();
  expect(screen.getByRole("link", { name: "its reply ↗" }).getAttribute("href")).toBe(dryRun.url);
  expect(screen.getByRole("link", { name: "acme/app's policies →" }).getAttribute("href")).toBe(
    "#/settings/repositories/acme/app/policies",
  );
  expect(screen.getByText("The last 10 decisions are kept per task, for 90 days.")).toBeTruthy();
});

test("the newest merge decision a policy error: the summary says it failed closed", () => {
  render(<Dashboard state={withTask({ decisions: [ERROR] })} error={null} />);
  expect(screen.getByText("Not merged automatically")).toBeTruthy();
  openTab();
  expect(screen.getByText(/failed, so it was denied: policies fail closed\./)).toBeTruthy();
});

test("a decision about an earlier pull request of the same issue: no badge, and its number", () => {
  // #25 was denied and closed; #30, opened since for the same issue, has no decision yet.
  const pr = state.tasks.find((t) => t.key === KEY)!.pr!;
  const newer = { ...pr, number: 30, url: "https://github.example.com/acme/app/pull/30" };
  render(<Dashboard state={withTask({ decisions: [MERGE], pr: newer })} error={null} />);
  expect(screen.queryByText("Not merged automatically")).toBeNull();
  openTab();
  expect(screen.queryByText("A policy kept this pull request for a human")).toBeNull();
  expect(decisions()[0].textContent).toContain("Auto-merge of #25");
});
