// A pull request's review-and-fix loop (Task.review): in review between its runs, the round on
// its row, and what the loop left on its ready row, in Detail, the Overview and the
// notification.
import { render, screen, within } from "@testing-library/preact";
import { beforeEach, expect, test, vi } from "vitest";
import { Dashboard } from "./App";
import { findingsLeft, isReady, loopLine, noProgress, roundCounts } from "./format";
import { Overview } from "./Overview";
import { repoParts, waitingOnYou } from "./overview";
import { makeState, makeTask } from "./testUtils";
import type { ReviewLoop, ReviewRound, State, Task } from "./types";

const counts = (over: Partial<ReviewRound["counts"]> = {}) => ({
  critical: 0,
  high: 0,
  medium: 0,
  low: 0,
  ...over,
});
const round = (n: number, c: Partial<ReviewRound["counts"]>, blocking: number): ReviewRound => ({
  round: n,
  at: n,
  head: `sha-${n}`,
  counts: counts(c),
  blocking,
});
// R0 1 critical · 3 high → R1 2 high → R2 2 high, `review.fix: 2`.
const HISTORY = [
  round(0, { critical: 1, high: 3, low: 1 }, 4),
  round(1, { high: 2 }, 2),
  round(2, { high: 2, medium: 1 }, 2),
];
const loop = (over: Partial<ReviewLoop> = {}): ReviewLoop => ({
  loop: "rounds-out",
  round: 2,
  rounds: 2,
  history: HISTORY,
  ...over,
});
const PR = { number: 25, url: "https://github.example.com/acme/app/pull/25", readyAt: 1 };
const ready = (review?: ReviewLoop, over: Partial<Task> = {}) =>
  makeTask({ state: "done", pr: { ...PR, state: "ready" }, review, ...over });

test("a loop's lines: its round while it goes on, what it left once it ended blocking", () => {
  expect(loopLine({ review: loop({ loop: "reviewing", round: 0 }) })).toBe("Review · first review");
  expect(loopLine({ review: loop({ loop: "fixing", round: 2, rounds: 3 }) })).toBe(
    "Review · round 2 of 3",
  );
  expect(loopLine({ review: loop({ loop: "checks" }) })).toBe("Review · waiting for checks");
  expect(loopLine({ review: loop() })).toBeNull();
  // Only the blocking ones, most severe first.
  expect(findingsLeft({ review: loop() })).toBe("2 high findings left after 2 fix rounds");
  const first = [round(0, { critical: 1, high: 1, medium: 2 }, 2)];
  expect(findingsLeft({ review: loop({ loop: "stopped", history: first }) })).toBe(
    "1 critical and 1 high findings left after the review",
  );
  expect(findingsLeft({ review: loop({ loop: "clean" }) })).toBeNull();
  expect(findingsLeft({ review: loop({ loop: "fixing" }) })).toBeNull();
  // Its one fix run unreviewed by design (`review.fix: true`): nothing said to be left.
  expect(findingsLeft({ review: loop({ loop: "fixed", round: 1, history: first }) })).toBeNull();
  expect(roundCounts(HISTORY[0])).toBe("1 critical · 3 high · 1 low");
  expect(roundCounts(round(3, {}, 0))).toBe("no findings");
  expect(HISTORY.map((_, i) => noProgress(HISTORY, i))).toEqual([false, false, true]);
});

test("in review: on its way, not ready nor waiting on you until the loop ends", () => {
  const reviewing = ready(loop({ loop: "fixing", round: 1 }), { state: "in-review" });
  expect(isReady(reviewing)).toBe(false);
  expect(waitingOnYou([reviewing])).toEqual([]);
  // The Overview's bars count it as running.
  expect(repoParts([reviewing], 0)).toEqual([{ tone: "run", count: 1, words: "1 running" }]);
  // While its fix run runs, the task is working, and still not ready.
  const working: Task = { ...reviewing, state: "working" };
  expect(isReady(working)).toBe(false);
  // Ended: ready, clean or not.
  expect(isReady(ready(loop()))).toBe(true);
  expect(isReady(ready(loop({ loop: "clean" })))).toBe(true);
  expect(waitingOnYou([ready(loop())]).map((w) => w.need)).toEqual(["ready"]);
});

const state = makeState();
const KEY = "acme/app#22";
const withReview = (s: State, over: Partial<Task>): State => ({
  ...s,
  tasks: s.tasks.map((t) => (t.key === KEY ? { ...t, ...over } : t)),
});

// All's tasks, #22 open.
beforeEach(() => {
  history.replaceState(null, "", "#/tasks?task=acme%2Fapp%2322");
});

test("its row says the round while in review, then what the loop left", () => {
  const pr = { ...state.tasks.find((t) => t.key === KEY)!.pr!, state: "ready" as const };
  const reviewing = withReview(state, {
    state: "in-review",
    pr,
    review: loop({ loop: "reviewing", round: 1 }),
  });
  const { rerender } = render(<Dashboard state={reviewing} error={null} />);
  const row = () =>
    screen.getByText("Dashboard on a frontend framework, built at image build time", {
      selector: "button span",
    }).parentElement!;
  expect(within(row()).getByText("In review")).toBeTruthy();
  expect(within(row()).getByText("Review · round 1 of 2")).toBeTruthy();
  expect(within(row()).queryByText(/findings left/)).toBeNull();

  rerender(
    <Dashboard state={withReview(state, { state: "done", pr, review: loop() })} error={null} />,
  );
  expect(within(row()).getByText("2 high findings left after 2 fix rounds")).toBeTruthy();
  expect(within(row()).queryByText(/Review · round/)).toBeNull();
  // Detail: each round's counts, the one that didn't lower them marked.
  const rounds = screen.getByRole("region", { name: "Review loop" });
  expect(within(rounds).getByText(/Fix rounds ran out/)).toBeTruthy();
  expect(within(rounds).getByText("2 high findings left after 2 fix rounds")).toBeTruthy();
  expect(
    within(rounds)
      .getAllByRole("listitem")
      .map((li) => li.textContent),
  ).toEqual(["R0 1 critical · 3 high · 1 low", "R1 2 high", "R2 2 high · 1 mediumno progress"]);
});

test("a clean loop: plain Ready for review, its rounds still listed", () => {
  const pr = { ...state.tasks.find((t) => t.key === KEY)!.pr!, state: "ready" as const };
  const clean = loop({ loop: "clean", round: 1, history: [HISTORY[0], round(1, { low: 1 }, 0)] });
  render(
    <Dashboard state={withReview(state, { state: "done", pr, review: clean })} error={null} />,
  );
  expect(screen.queryByText(/findings? left/)).toBeNull();
  const rounds = screen.getByRole("region", { name: "Review loop" });
  expect(within(rounds).getByText(/Nothing blocking/)).toBeTruthy();
  expect(within(rounds).queryByText("no progress")).toBeNull();
});

test("the Overview's ready row carries what the loop left; one in review isn't listed", () => {
  const left = ready(loop(), { key: "acme/app#40", number: 40, title: "Left findings" });
  const inReview = ready(loop({ loop: "fixing", round: 1 }), {
    key: "acme/app#41",
    number: 41,
    title: "Still in review",
    state: "in-review",
  });
  const s = makeState({}, [left, inReview]);
  render(<Overview state={s} github="https://github.example.com" onChip={() => {}} />);
  const region = screen.getByRole("region", { name: "Waiting on you" });
  const row = within(region).getByText("Left findings").closest("li")!;
  expect(within(row).getByText("2 high findings left after 2 fix rounds")).toBeTruthy();
  expect(within(region).queryByText("Still in review")).toBeNull();
});

class FakeNotification {
  static permission: NotificationPermission = "granted";
  static shown: FakeNotification[] = [];
  onclick: (() => void) | null = null;
  close = vi.fn();
  constructor(
    public title: string,
    public options: NotificationOptions,
  ) {
    FakeNotification.shown.push(this);
  }
}

test("the ready notification waits for the loop's end, and says what it left", () => {
  vi.stubGlobal("Notification", FakeNotification);
  FakeNotification.shown = [];
  const pr = {
    ...state.tasks.find((t) => t.key === KEY)!.pr!,
    state: "ready" as const,
    readyAt: state.now + 1000,
  };
  const { rerender } = render(<Dashboard state={state} error={null} />);
  const at = (over: Partial<Task>, now: number) => ({ ...withReview(state, over), now });
  const fixing = { state: "in-review" as const, pr, review: loop({ loop: "fixing", round: 1 }) };
  rerender(<Dashboard state={at(fixing, state.now + 2000)} error={null} />);
  expect(FakeNotification.shown).toHaveLength(0);
  rerender(
    <Dashboard state={at({ state: "done", pr, review: loop() }, state.now + 4000)} error={null} />,
  );
  expect(FakeNotification.shown).toHaveLength(1);
  expect(FakeNotification.shown[0].options.body).toBe(
    "acme/app · pull request #25 · 2 high findings left after 2 fix rounds",
  );
});

test("ready before its loop began (no review yet), the loop's end still notifies", () => {
  vi.stubGlobal("Notification", FakeNotification);
  FakeNotification.shown = [];
  const pr = {
    ...state.tasks.find((t) => t.key === KEY)!.pr!,
    state: "ready" as const,
    readyAt: state.now + 1000,
  };
  const { rerender } = render(<Dashboard state={state} error={null} />);
  const at = (over: Partial<Task>, now: number) => ({ ...withReview(state, over), now });
  rerender(<Dashboard state={at({ state: "done", pr }, state.now + 2000)} error={null} />);
  expect(FakeNotification.shown).toHaveLength(1);
  const fixing = { state: "in-review" as const, pr, review: loop({ loop: "fixing", round: 1 }) };
  rerender(<Dashboard state={at(fixing, state.now + 4000)} error={null} />);
  rerender(
    <Dashboard state={at({ state: "done", pr, review: loop() }, state.now + 6000)} error={null} />,
  );
  expect(FakeNotification.shown.map((n) => n.options.body)).toEqual([
    "acme/app · pull request #25",
    "acme/app · pull request #25 · 2 high findings left after 2 fix rounds",
  ]);
  // The next polls: no third.
  rerender(
    <Dashboard state={at({ state: "done", pr, review: loop() }, state.now + 8000)} error={null} />,
  );
  expect(FakeNotification.shown).toHaveLength(2);
});
