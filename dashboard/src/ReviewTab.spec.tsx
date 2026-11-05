// A task's Review tab (#625): only once Deckhand reviewed its pull request, after Policies; the
// last review's sections read from api/review, its text shown literally, its places linked at
// the reviewed commit, the follow-ups' filing, the merge's banner, and [ / ] going through it.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { beforeEach, expect, test, vi } from "vitest";
import { Dashboard } from "./App";
import { makeState, mockApi } from "./testUtils";
import type { PolicyDecision, PullRequest, ReviewFindings, ReviewLoop, State, Task } from "./types";

const KEY = "acme/app#22";
const state = makeState();
const HEAD = "aaaaaaa1111111111111111111111111111111";
const URL = "https://github.example.com/acme/app/pull/25";
const BLOB = `https://github.example.com/acme/app/blob/${HEAD}`;
const pr = (over: Partial<PullRequest> = {}): PullRequest => ({
  number: 25,
  url: URL,
  state: "ready",
  readyAt: 1,
  head: HEAD,
  ...over,
});
const loop: ReviewLoop = {
  loop: "stopped",
  round: 1,
  rounds: 2,
  history: [
    {
      round: 1,
      at: 5,
      head: HEAD,
      counts: { critical: 0, high: 1, medium: 1, low: 0 },
      blocking: 2,
    },
  ],
};
const withTask = (over: Partial<Task>): State => ({
  ...state,
  tasks: state.tasks.map((t) =>
    t.key === KEY ? { ...t, state: "done", pr: pr(), review: loop, ...over } : t,
  ),
});

const REVIEW: ReviewFindings = {
  url: `${URL}#pullrequestreview-7`,
  at: state.now - 60_000,
  verdict: "request-changes",
  rating: 5,
  head: HEAD,
  round: 1,
  manual: false,
  blob: BLOB,
  allowed: "medium",
  findings: [
    {
      severity: "high",
      path: "app/(shop)/cart.ts",
      line: 42,
      text: 'Unescaped <img src=x onerror="alert(1)"> and [a link](https://evil.example)',
      tolerated: false,
    },
    { severity: "medium", path: null, line: null, text: "No test.", tolerated: true },
  ],
  followUps: [
    {
      title: "Share the retry helper",
      path: "lib/upload.mjs",
      line: 30,
      text: "Twice.",
      filing: "after-merge",
    },
    { title: "Docs: the limits", path: null, line: null, text: "", filing: "after-merge" },
  ],
  comments: [
    { blocking: true, path: "lib/cache.mjs", line: 20, text: "A miss goes out?" },
    { blocking: false, path: null, line: null, text: "`store` reads better." },
  ],
  merged: null,
};

let asked: string[] = [];
let answer: () => unknown = () => REVIEW;

beforeEach(() => {
  history.replaceState(null, "", "#/tasks?task=acme%2Fapp%2322");
  asked = [];
  answer = () => REVIEW;
  mockApi({
    "api/review": ({ url }) => {
      asked.push(url);
      return answer();
    },
  });
});

const tabNames = () => screen.getAllByRole("tab").map((t) => t.textContent!.replace(/\s*\d+$/, ""));
const openReview = () => fireEvent.click(screen.getByRole("tab", { name: "Review" }));

test("no review of Deckhand's: no Review tab, nothing asked", () => {
  render(<Dashboard state={withTask({ review: undefined })} error={null} />);
  expect(screen.queryByRole("tab", { name: "Review" })).toBeNull();
  expect(screen.getByRole("tablist").getAttribute("aria-label")).toBe("Runs");
  expect(asked).toEqual([]);
});

test("after Policies, named in the tab list; [ and ] go through it", async () => {
  const decision: PolicyDecision = {
    decision: "merge",
    rule: "deny_merge",
    denied: false,
    messages: [],
    pr: 25,
    at: state.now - 60_000,
  };
  render(<Dashboard state={withTask({ decisions: [decision] })} error={null} />);
  const list = screen.getByRole("tablist");
  expect(list.getAttribute("aria-label")).toBe("Runs, policies and review");
  expect(tabNames().slice(-2)).toEqual(["Policies", "Review"]);
  // From the last run: ] to Policies, ] to Review, ] nowhere further, [ back to Policies.
  const selected = () => screen.getByRole("tab", { selected: true }).textContent;
  const runs = screen.getAllByRole("tab").length - 2;
  for (let i = 1; i < runs; i++) fireEvent.keyDown(document.body, { key: "]" });
  fireEvent.keyDown(document.body, { key: "]" });
  expect(selected()).toMatch(/^Policies/);
  fireEvent.keyDown(document.body, { key: "]" });
  expect(selected()).toBe("Review");
  await screen.findByRole("region", { name: "Must fix" });
  fireEvent.keyDown(document.body, { key: "]" });
  expect(selected()).toBe("Review");
  fireEvent.keyDown(document.body, { key: "[" });
  expect(selected()).toMatch(/^Policies/);
});

test("the last review's sections, its text literal, its places at the reviewed commit", async () => {
  render(<Dashboard state={withTask({})} error={null} />);
  openReview();
  const must = await screen.findByRole("region", { name: "Must fix" });
  expect(asked).toEqual(["api/review?repo=acme%2Fapp&number=25"]);
  // The head: verdict, round, rating, commit, the review on GitHub.
  expect(screen.getByText("Requests changes")).toBeTruthy();
  expect(screen.getByText("R1")).toBeTruthy();
  expect(screen.getByRole("link", { name: "aaaaaaa" }).getAttribute("href")).toBe(
    `${URL}/commits/${HEAD}`,
  );
  expect(screen.getByRole("link", { name: /On GitHub/ }).getAttribute("href")).toBe(
    `${URL}#pullrequestreview-7`,
  );
  // By severity, each with its mark.
  expect(
    within(must)
      .getAllByRole("heading", { level: 4 })
      .map((h) => h.textContent),
  ).toEqual(["High 1", "Medium 1"]);
  expect(within(must).getByText("to fix")).toBeTruthy();
  expect(within(must).getByText("tolerated")).toBeTruthy();
  const place = within(must).getByRole("link", { name: "app/(shop)/cart.ts:42" });
  expect(place.getAttribute("href")).toBe(`${BLOB}/app/(shop)/cart.ts#L42`);
  // HTML and markdown stay text: no image, no link of the model's.
  expect(
    within(must).getByText(
      'Unescaped <img src=x onerror="alert(1)"> and [a link](https://evil.example)',
    ),
  ).toBeTruthy();
  expect(document.querySelector("img[src=x]")).toBeNull();
  expect(screen.queryByRole("link", { name: "a link" })).toBeNull();
  // Follow-ups to be filed after the merge, comments blocking or a note.
  const follow = screen.getByRole("region", { name: "Follow-ups" });
  expect(within(follow).getAllByText("filed after merge")).toHaveLength(2);
  const comments = screen.getByRole("region", { name: "Comments" });
  expect(within(comments).getByText("blocking")).toBeTruthy();
  expect(within(comments).getByText("note")).toBeTruthy();
  // Must fix first, before the merge.
  const order = screen.getAllByRole("region").map((r) => r.getAttribute("aria-label"));
  expect(order.indexOf("Must fix")).toBeLessThan(order.indexOf("Follow-ups"));
});

test("merged: a banner by whom, the follow-ups first with their issues, the findings merged with", async () => {
  answer = () => ({
    ...REVIEW,
    merged: { at: state.now - 1000, by: "deckhand-app[bot]", deckhand: true },
    followUps: [
      {
        ...REVIEW.followUps[0],
        filing: "issue",
        issue: { number: 40, state: "open", url: "https://x/issues/40" },
      },
      { ...REVIEW.followUps[1], filing: "failed" },
    ],
  });
  const { rerender } = render(<Dashboard state={withTask({})} error={null} />);
  openReview();
  await screen.findByRole("region", { name: "Must fix" });
  // The pull request merged since: read again.
  rerender(<Dashboard state={withTask({ pr: pr({ state: "merged" }) })} error={null} />);
  await waitFor(() => expect(asked).toHaveLength(2));
  expect(await screen.findByText(/^Merged #25 by Deckhand/)).toBeTruthy();
  const order = screen.getAllByRole("region").map((r) => r.getAttribute("aria-label"));
  expect(order.indexOf("Follow-ups")).toBeLessThan(order.indexOf("Must fix"));
  const follow = screen.getByRole("region", { name: "Follow-ups" });
  expect(within(follow).getByRole("link", { name: "#40" }).getAttribute("href")).toBe(
    "https://x/issues/40",
  );
  expect(within(follow).getByText("open")).toBeTruthy();
  expect(within(follow).getByText(/filing failed/)).toBeTruthy();
  const must = screen.getByRole("region", { name: "Must fix" });
  expect(within(must).getAllByText("merged with")).toHaveLength(2);
  expect(within(must).queryByText("to fix")).toBeNull();
});

test("a review from before the sections: its findings as must fix, no other section", async () => {
  answer = () => ({ ...REVIEW, followUps: [], comments: [] });
  render(<Dashboard state={withTask({})} error={null} />);
  openReview();
  await screen.findByRole("region", { name: "Must fix" });
  expect(screen.queryByRole("region", { name: "Follow-ups" })).toBeNull();
  expect(screen.queryByRole("region", { name: "Comments" })).toBeNull();
});

test("GitHub failing: said, and tried again on asking", async () => {
  answer = () => Response.json({ error: "GitHub couldn't be read: try again." }, { status: 502 });
  render(<Dashboard state={withTask({})} error={null} />);
  openReview();
  expect(await screen.findByText(/Couldn't read the last review/)).toBeTruthy();
  answer = () => REVIEW;
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByRole("region", { name: "Must fix" })).toBeTruthy();
});

test("GitHub failing: one period, and a re-read that fails keeps the review shown", async () => {
  answer = () => Response.json({ error: "GitHub couldn't be read: try again." }, { status: 502 });
  const { rerender } = render(<Dashboard state={withTask({})} error={null} />);
  openReview();
  expect(
    await screen.findByText("Couldn't read the last review: GitHub couldn't be read: try again."),
  ).toBeTruthy();
  answer = () => REVIEW;
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await screen.findByRole("region", { name: "Must fix" });
  // A new round, read again, and GitHub failing: the review stays, the error beside it.
  answer = () => new Response("{}", { status: 502 });
  const next = { ...loop, history: [...loop.history, { ...loop.history[0], round: 2, at: 9 }] };
  rerender(<Dashboard state={withTask({ review: next })} error={null} />);
  expect(await screen.findByText("Couldn't read it again: 502.")).toBeTruthy();
  expect(screen.getByRole("region", { name: "Must fix" })).toBeTruthy();
});

test("no review in Deckhand's format (a 404): said, nothing to try again", async () => {
  answer = () => Response.json({ error: "No review of Deckhand's on it." }, { status: 404 });
  render(<Dashboard state={withTask({})} error={null} />);
  openReview();
  expect(await screen.findByText(/No review of Deckhand's to show here/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
});

test("a maintainer's review: no R0; a place with .. stays at the reviewed commit", async () => {
  answer = () => ({
    ...REVIEW,
    round: 0,
    manual: true,
    findings: [{ ...REVIEW.findings[0], path: "../../../settings/x.ts", line: 3 }],
  });
  render(<Dashboard state={withTask({})} error={null} />);
  openReview();
  const must = await screen.findByRole("region", { name: "Must fix" });
  expect(screen.queryByText("R0")).toBeNull();
  expect(screen.getByText("A maintainer's review")).toBeTruthy();
  expect(
    within(must).getByRole("link", { name: "../../../settings/x.ts:3" }).getAttribute("href"),
  ).toBe(`${BLOB}/settings/x.ts#L3`);
});

test("merged, a follow-up's filing on its way: read again until it is done", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    const merged = { at: state.now, by: "alice", deckhand: false };
    answer = () => ({ ...REVIEW, merged });
    render(<Dashboard state={withTask({ pr: pr({ state: "merged" }) })} error={null} />);
    openReview();
    await screen.findByRole("region", { name: "Follow-ups" });
    answer = () => ({
      ...REVIEW,
      merged,
      followUps: REVIEW.followUps.map((f) => ({ ...f, filing: "not-filed" })),
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await screen.findAllByText("not filed: nothing filed it at the merge")).toHaveLength(2);
    const reads = asked.length;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(asked).toHaveLength(reads);
  } finally {
    vi.useRealTimers();
  }
});
