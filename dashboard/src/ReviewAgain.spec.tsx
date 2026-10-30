// A pull request whose review-and-fix loop is over: Review and Fix in its task page's Review
// loop section, when they are offered, and what the listener says once one is pressed (fetch
// mocked).
import { fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { beforeEach, expect, test, vi } from "vitest";
import { Dashboard } from "./App";
import { reviewOffers } from "./format";
import { makeState, mockApi } from "./testUtils";
import type { LoopState, ReviewLoop, ReviewRound, State, Task } from "./types";

const round = (n: number, high: number): ReviewRound => ({
  round: n,
  at: n,
  head: `sha-${n}`,
  counts: { critical: 0, high, medium: 0, low: 0 },
  blocking: high,
});
// R0 3 high → R1 2 high → R2 2 high, `review.fix: 2`: the rounds ran out.
const loop = (over: Partial<ReviewLoop> = {}): ReviewLoop => ({
  loop: "rounds-out",
  round: 2,
  rounds: 2,
  history: [round(0, 3), round(1, 2), round(2, 2)],
  ...over,
});

const state = makeState();
const KEY = "acme/app#22";
const PR = { ...state.tasks.find((t) => t.key === KEY)!.pr!, state: "ready" as const };
const withTask = (over: Partial<Task>): State => ({
  ...state,
  tasks: state.tasks.map((t) => (t.key === KEY ? { ...t, state: "done", pr: PR, ...over } : t)),
});

let api: ReturnType<typeof mockApi>;
let refresh: ReturnType<typeof vi.fn<() => Promise<void>>>;
beforeEach(() => {
  history.replaceState(null, "", "#/tasks?task=acme%2Fapp%2322");
  api = mockApi();
  refresh = vi.fn<() => Promise<void>>(async () => {});
});

const show = (over: Partial<Task> = {}) => {
  render(
    <Dashboard state={withTask({ review: loop(), ...over })} error={null} refresh={refresh} />,
  );
  const section = screen.queryByRole("region", { name: "Review loop" });
  const button = (name: string) =>
    section ? within(section).queryByRole("button", { name }) : null;
  return { review: button("Review"), fix: button("Fix") };
};

test("rounds ran out: Fix posts one more round, then the listener's answer and a fresh state", async () => {
  api.answer = () => ({ message: "Fix round 3 of #25 queued." });
  const { review, fix } = show();
  expect(review).not.toBeNull();
  fireEvent.click(fix!);
  await waitFor(() =>
    expect(screen.getByRole("status").textContent).toBe("Fix round 3 of #25 queued."),
  );
  expect(api.posted).toEqual([
    { url: "api/repos/acme/app/review", body: { number: PR.number, action: "fix" } },
  ]);
  expect(refresh).toHaveBeenCalledOnce();
});

test("Review: a review of the head now; Reviewing… while it is on its way", async () => {
  api.answer = () => ({ message: `Review of #${PR.number} queued.` });
  const release = api.hold();
  const { review, fix } = show();
  fireEvent.click(review!);
  await waitFor(() => expect(review!.getAttribute("aria-busy")).toBe("true"));
  expect(review!.textContent).toContain("Reviewing…");
  // The other one waits meanwhile.
  expect((fix as HTMLButtonElement).disabled).toBe(true);
  release();
  await waitFor(() =>
    expect(screen.getByRole("status").textContent).toBe(`Review of #${PR.number} queued.`),
  );
  expect(api.posted).toEqual([
    { url: "api/repos/acme/app/review", body: { number: PR.number, action: "review" } },
  ]);
});

test("a refusal is shown as the listener wrote it, and nothing is read again", async () => {
  api.answer = () =>
    Response.json({ error: "No fix run on #25: the policies refuse it." }, { status: 409 });
  fireEvent.click(show().fix!);
  await waitFor(() =>
    expect(screen.getByRole("status").textContent).toBe(
      "No fix run on #25: the policies refuse it.",
    ),
  );
  expect(refresh).not.toHaveBeenCalled();
});

test("neither while the loop goes on, a run is going or queued, or the pull request is merged", () => {
  for (const going of ["reviewing", "fixing", "ci", "ci-fix", "checks"] as LoopState[]) {
    expect(show({ state: "in-review", review: loop({ loop: going }) }), going).toEqual({
      review: null,
      fix: null,
    });
    document.body.replaceChildren();
  }
  for (const over of [
    { state: "working" as const },
    { state: "queued" as const },
    { pr: { ...PR, state: "merged" as const } },
    { pr: { ...PR, state: "closed" as const } },
  ]) {
    expect(show(over), JSON.stringify(over)).toEqual({ review: null, fix: null });
    document.body.replaceChildren();
  }
});

test("Review only: a clean loop, a fixed one, CI failed, no review.fix, an answer awaited, a draft", () => {
  const cases: Partial<Task>[] = [
    { review: loop({ loop: "clean", history: [round(0, 3), round(1, 0)] }) },
    { review: loop({ loop: "fixed", rounds: 1 }) },
    { review: loop({ loop: "ci-failed" }) },
    // Without `review.fix`, a blocking review is "rounds-out" with no rounds.
    { review: loop({ round: 0, rounds: 0, history: [round(0, 2)] }) },
    { state: "needs-input" },
    // The listener refuses a draft's Fix: its push wouldn't be reviewed.
    { pr: { ...PR, state: "draft" as const } },
  ];
  for (const over of cases) {
    const shown = show(over);
    expect(shown.review, JSON.stringify(over)).not.toBeNull();
    expect(shown.fix, JSON.stringify(over)).toBeNull();
    document.body.replaceChildren();
  }
  // Stopped with blocking findings: Fix too.
  expect(show({ review: loop({ loop: "stopped", round: 1 }) }).fix).not.toBeNull();
});

test("reviewOffers: CI failed before any review still offers Review", () => {
  const t = { state: "done" as const, pr: PR, review: loop({ loop: "ci-failed", history: [] }) };
  expect(reviewOffers(t)).toEqual({ review: true, fix: false });
  expect(reviewOffers({ ...t, review: undefined })).toEqual({ review: false, fix: false });
});

test("Shift F fixes and Shift R reviews, only when offered; the buttons name them", async () => {
  const { review, fix } = show();
  expect(fix!.title).toMatch(/\(Shift F\)$/);
  expect(review!.title).toMatch(/\(Shift R\)$/);
  fireEvent.keyDown(document.body, { key: "F", shiftKey: true });
  await waitFor(() => expect(api.bodies()).toEqual([{ number: PR.number, action: "fix" }]));
  await waitFor(() => expect(screen.getByRole("status")).toBeTruthy());
  document.body.replaceChildren();
  // A clean loop: no Fix to press, Review still.
  show({ review: loop({ loop: "clean", history: [round(0, 0)] }) });
  fireEvent.keyDown(document.body, { key: "F", shiftKey: true });
  fireEvent.keyDown(document.body, { key: "R", shiftKey: true });
  await waitFor(() => expect(api.bodies().at(-1)).toEqual({ number: PR.number, action: "review" }));
  expect(api.bodies()).toHaveLength(2);
});
