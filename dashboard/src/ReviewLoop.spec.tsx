// A pull request's review-and-fix loop (Task.review): in review between its runs, the round on
// its row, and what the loop left on its ready row, in Detail, the Overview and the
// notification.
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/preact";
import { beforeEach, expect, test, vi } from "vitest";
import { Dashboard } from "./App";
import {
  findingsLeft,
  isReady,
  loopLine,
  noProgress,
  reviewScore,
  reviewTrend,
  roundCounts,
} from "./format";
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
  expect(loopLine({ review: loop({ loop: "ci" }) })).toBe("Review · waiting for CI");
  expect(loopLine({ review: loop({ loop: "ci-fix" }) })).toBe("Review · fixing CI");
  // Both are on its way: not ready yet.
  expect(isReady(ready(loop({ loop: "ci", round: 0, history: [] })))).toBe(false);
  expect(isReady(ready(loop({ loop: "ci-fix" })))).toBe(false);
  // Stopped before any review: the ready row says CI failed, nothing was reviewed.
  const stopped = { review: loop({ loop: "ci-failed", round: 0, history: [] }) };
  expect(loopLine(stopped)).toBeNull();
  expect(findingsLeft(stopped)).toBe("CI failed, not reviewed");
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
  // Detail: the last review's counts, worse than the one before it (10 points, then 13).
  const rounds = screen.getByRole("region", { name: "Review loop" });
  expect(within(rounds).getByText(/Fix rounds ran out/)).toBeTruthy();
  expect(within(rounds).getByText("2 high findings left after 2 fix rounds")).toBeTruthy();
  expect(
    within(rounds).getByRole("button", {
      name: "Last review: 2 high · 1 medium worse than the review before",
    }),
  ).toBeTruthy();
  // No list until it's asked for, nor any point.
  expect(within(rounds).queryByRole("list")).toBeNull();
  expect(rounds.textContent).not.toMatch(/pts|points/);
});

const detail = (review: ReviewLoop) => {
  const pr = { ...state.tasks.find((t) => t.key === KEY)!.pr!, state: "ready" as const };
  render(<Dashboard state={withReview(state, { state: "done", pr, review })} error={null} />);
  return screen.getByRole("region", { name: /^Review/ });
};

test("the last review's arrow: down and green when it weighs less, up and red when more", () => {
  // 24 points, then 10.
  let rounds = detail(loop({ history: HISTORY.slice(0, 2) }));
  expect(
    within(rounds).getByRole("button", {
      name: "Last review: 2 high better than the review before",
    }),
  ).toBeTruthy();
  const better = within(rounds).getByRole("img", { name: "better than the review before" });
  expect(better.className).toMatch(/better/);
  cleanup();

  // 10 points, then 13.
  rounds = detail(loop({ history: HISTORY.slice(1) }));
  const worse = within(rounds).getByRole("img", { name: "worse than the review before" });
  expect(worse.className).toMatch(/worse/);
  cleanup();

  // The same points (2 high, then 1 high and 1 medium and 2 low), or only one review: none.
  rounds = detail(loop({ history: [HISTORY[1], round(2, { high: 1, medium: 1, low: 2 }, 1)] }));
  expect(within(rounds).queryByRole("img")).toBeNull();
  cleanup();
  rounds = detail(loop({ loop: "stopped", history: [HISTORY[0]] }));
  expect(within(rounds).queryByRole("img")).toBeNull();
  expect(within(rounds).getByRole("button", { name: /^Last review:/ }).textContent).toBe(
    "Last review: 1 critical · 3 high · 1 low",
  );
});

test("hovering previews every review; focus or a click pins them, until Escape, Tab, a click", async () => {
  const rounds = detail(loop());
  const line = within(rounds).getByRole("button", { name: /^Last review:/ });
  const box = line.parentElement!;
  const list = () => within(rounds).queryByRole("list", { name: "Every review, oldest first" });
  const rows = () =>
    within(list()!)
      .getAllByRole("listitem")
      .map((li) => li.textContent);
  // A mouse click: the press focuses the line, then the click.
  const click = () => {
    fireEvent.pointerDown(line);
    act(() => line.focus());
    fireEvent.click(line, { detail: 1 });
  };
  // Oldest first, the one that didn't lower the blocking findings marked, each with its commit.
  const ALL = [
    "R0 1 critical · 3 high · 1 low sha-0",
    "R1 2 high sha-1",
    "R2 2 high · 1 mediumno progress sha-2",
  ];

  // Hovered: a preview, which leaves the page's keys and focus alone; Escape closes it.
  fireEvent.mouseEnter(box);
  expect(line.getAttribute("aria-expanded")).toBe("true");
  expect(rows()).toEqual(ALL);
  expect(list()!.hasAttribute("data-popup")).toBe(false);
  const escape = fireEvent.keyDown(document, { key: "Escape" });
  expect(escape).toBe(true); // not prevented
  expect(list()).toBeNull();
  expect(document.activeElement).toBe(document.body);
  fireEvent.mouseLeave(box);
  fireEvent.mouseEnter(box);
  expect(rows()).toEqual(ALL);
  fireEvent.mouseLeave(box);
  expect(list()).toBeNull();

  // Focused: pinned, a popup's; Escape closes it, focus staying on the line.
  act(() => line.focus());
  expect(rows()).toEqual(ALL);
  expect(list()!.hasAttribute("data-popup")).toBe(true);
  act(() => {
    fireEvent.keyDown(document, { key: "Escape" });
  });
  expect(list()).toBeNull();
  expect(document.activeElement).toBe(line);
  // Enter opens it again, and closes it.
  fireEvent.click(line);
  expect(rows()).toEqual(ALL);
  fireEvent.click(line);
  expect(list()).toBeNull();
  act(() => line.blur());

  // Clicked after a hover: it stays once the mouse leaves; a click away closes it.
  fireEvent.mouseEnter(box);
  click();
  fireEvent.mouseLeave(box);
  expect(rows()).toEqual(ALL);
  fireEvent.pointerDown(document.body);
  expect(list()).toBeNull();

  // A second click on the line closes it, the mouse still over it.
  fireEvent.mouseEnter(box);
  click();
  expect(rows()).toEqual(ALL);
  click();
  expect(list()).toBeNull();
  expect(line.getAttribute("aria-expanded")).toBe("false");

  // Closed, focus on the line: the window losing focus and getting it back doesn't open it.
  // (A moment later: the close's own focus guard is over.)
  await act(async () => {});
  const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
  act(() => line.blur());
  hasFocus.mockReturnValue(true);
  act(() => line.focus());
  expect(list()).toBeNull();
  // A focus of the user's after that does.
  act(() => line.blur());
  act(() => line.focus());
  expect(rows()).toEqual(ALL);
  hasFocus.mockRestore();
  fireEvent.keyDown(document, { key: "Escape" });
  expect(list()).toBeNull();

  // Tab closes it too.
  act(() => line.blur());
  click();
  fireEvent.keyDown(document, { key: "Tab" });
  expect(list()).toBeNull();
});

test("a review's points: low 1, medium 3, high 5, critical 8, every finding counted", () => {
  expect(reviewScore(HISTORY[0])).toBe(24);
  expect(reviewScore(HISTORY[2])).toBe(13);
  expect(reviewScore(round(3, {}, 0))).toBe(0);
  expect(reviewTrend(HISTORY)).toBe("worse");
  expect(reviewTrend(HISTORY.slice(0, 2))).toBe("better");
  expect(reviewTrend(HISTORY.slice(0, 1))).toBeNull();
  expect(reviewTrend([HISTORY[1], round(2, { high: 1, medium: 1, low: 2 }, 1)])).toBeNull();
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
  act(() =>
    within(rounds)
      .getByRole("button", { name: /^Last review:/ })
      .focus(),
  );
  expect(
    within(within(rounds).getByRole("list", { name: "Every review, oldest first" }))
      .getAllByRole("listitem")
      .map((li) => li.textContent),
  ).toEqual(["R0 1 critical · 3 high · 1 low sha-0", "R1 1 low sha-1"]);
  expect(within(rounds).queryByText("no progress")).toBeNull();
});

test("the CI step on the task: waiting for CI on its row, fixing CI in Detail's loop", () => {
  const pr = { ...state.tasks.find((t) => t.key === KEY)!.pr!, state: "ready" as const };
  const waiting = loop({ loop: "ci", round: 0, history: [] });
  const { rerender } = render(
    <Dashboard
      state={withReview(state, { state: "in-review", pr, review: waiting })}
      error={null}
    />,
  );
  expect(screen.getAllByText("Review · waiting for CI").length).toBeGreaterThan(0);
  const fixing = loop({ loop: "ci-fix", round: 1, history: [HISTORY[0]] });
  rerender(
    <Dashboard
      state={withReview(state, { state: "in-review", pr, review: fixing })}
      error={null}
    />,
  );
  const rounds = screen.getByRole("region", { name: "Review loop" });
  expect(within(rounds).getByText(/Fixing CI/)).toBeTruthy();
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

test("a maintainer's own review brings no second ready notification", () => {
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
  // Reviewed from the dashboard, no loop: a round of theirs, nothing new to say.
  const theirs = { ...round(0, { high: 1 }, 1), at: state.now + 3000, manual: true };
  const manual = loop({ loop: "rounds-out", round: 0, rounds: 0, history: [theirs], manual: true });
  rerender(
    <Dashboard state={at({ state: "done", pr, review: manual }, state.now + 4000)} error={null} />,
  );
  expect(FakeNotification.shown).toHaveLength(1);
});
