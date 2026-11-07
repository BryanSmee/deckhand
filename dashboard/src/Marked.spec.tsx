// The run pages (#722) write their own texts through the catalog: in a marked one
// (testCatalog.ts), the board, the work queue, a task's detail, its log, a thread and the open
// questions show nothing of the dashboard's own unmarked. What the page was given (the tasks,
// the backlog, the log's lines, a thread's posts) is data, not the dashboard's to translate.
import { act, fireEvent, render, screen, within } from "@testing-library/preact";
import { beforeAll, beforeEach, expect, test, vi } from "vitest";
import type { Backlog, Entry, ReviewFindings, ReviewRound, State, Thread } from "./types";

vi.mock("./locales", async (original) =>
  (await import("./testCatalog")).withMarked(await original()),
);

// Imported after the mock, as Language.spec.tsx does.
let { Dashboard } = {} as typeof import("./App");
let { t } = {} as typeof import("./i18n");
let { setPref } = {} as typeof import("./prefs");
let { CATALOGS } = {} as typeof import("./locales");
let { BACKLOG, FakeSource, makeState, mockApi, transfer } = {} as typeof import("./testUtils");
let { keysShown, strings, unmarked, useMarked } = {} as typeof import("./testCatalog");

beforeAll(async () => {
  vi.resetModules();
  ({ Dashboard } = await import("./App"));
  ({ t } = await import("./i18n"));
  ({ setPref } = await import("./prefs"));
  ({ CATALOGS } = await import("./locales"));
  ({ BACKLOG, FakeSource, makeState, mockApi, transfer } = await import("./testUtils"));
  ({ keysShown, strings, unmarked, useMarked } = await import("./testCatalog"));
});

// Keys and names, what the browser writes of a time, and a build step's status as BuildKit
// writes it ("#1 FROM node · CACHED", "DONE 41s"), on purpose.
const NAMES = [
  ...["Ctrl", "Shift", "Esc", "Space", "Deckhand", "GitHub", "AM", "PM", "Oct"],
  ...["CACHED", "DONE", "ERROR", "41s"],
];

const backlog: Backlog = {
  ...BACKLOG,
  issues: [
    {
      number: 31,
      title: "Rate-limit the API",
      url: "https://github.example.com/acme/app/issues/31",
    },
  ],
};

// Its reviews: one that blocked, then a fix round that made no progress.
const round = (n: number, blocking: number): ReviewRound => ({
  round: n,
  at: n,
  head: `sha-${n}`,
  counts: { critical: 0, high: blocking, medium: 0, low: 1 },
  blocking,
  comments: { blocking: 0, notes: 1 },
  followUps: 1,
});

const post = (id: string, author: string, body: string, deckhand = false) => ({
  id,
  url: `https://github.com/acme/notes/discussions/8#${id}`,
  author,
  deckhand,
  at: new Date(0).toISOString(),
  body,
});
const thread: Thread = {
  number: 8,
  title: "Weekly digest?",
  url: "https://github.com/acme/notes/discussions/8",
  post: post("D_8", "alice", "Should notes send a weekly digest?"),
  comments: [{ ...post("DC_1", "deckhand", "An issue each Monday?", true), replies: [], more: 1 }],
  more: 2,
  readAt: 0,
};

let state: State;
beforeEach(() => {
  // acme/api#131's ready pull request ran out of fix rounds on blocking findings.
  const base = makeState();
  state = {
    ...base,
    tasks: base.tasks.map((t) =>
      t.key === "acme/api#131"
        ? {
            ...t,
            review: {
              loop: "rounds-out",
              round: 1,
              rounds: 1,
              history: [round(0, 2), round(1, 2)],
            },
          }
        : t,
    ),
  };
  mockApi({
    "api/repos/acme/app/issues": () => backlog,
    "api/repos/acme/api/issues": () => BACKLOG,
    "api/repos/acme/notes/discussions/8": () => thread,
  });
  useMarked();
  FakeSource.last = null;
  vi.stubGlobal("EventSource", FakeSource);
});

// A key shown as it is fails first: unmarked() would take it for an identifier.
function left(root: Element, ...more: unknown[]): string[] {
  const keys = keysShown(root, Object.keys(CATALOGS.en));
  if (keys.length) return keys;
  // Unlike Catalog.spec.tsx, data that is also an English text stays data: the run pages show
  // words the catalog has too as they were sent (an effort's "high", a mode's "review").
  return unmarked(root, {
    data: [
      ...strings(state, backlog, BACKLOG, thread, ...more),
      // A repository by its name alone, as the sidebar lists it.
      ...state.tasks.map((task) => task.repo.split("/")[1]),
    ],
    names: NAMES,
  });
}
const checked = (root: Element, ...more: unknown[]) => expect(left(root, ...more)).toEqual([]);

test("the board, in its graph and its lanes, and its work queue", async () => {
  history.replaceState(null, "", "#/acme/app/board");
  render(<Dashboard state={state} error={null} />);
  await screen.findByText("Rate-limit the API");
  checked(document.body);
  // A card dragged over the graph: what letting it go would do.
  const card = screen.getByText("Rate-limit the API").closest("li")!;
  const area = screen.getByRole("list", {
    name: t("graph.issuesOf", { repo: "acme/app" }),
  }).parentElement!;
  const dataTransfer = transfer();
  fireEvent.dragStart(card, { dataTransfer });
  fireEvent.dragOver(area, { dataTransfer });
  expect(screen.getByText(t("drag.start", { ref: "#31" }))).toBeTruthy();
  checked(document.body);
  fireEvent.dragEnd(card, { dataTransfer });
  act(() => screen.getByRole("button", { name: t("board.lanes") }).click());
  checked(document.body);
});

test("an issue waiting for answers on the board: its card's drag, and its questions' dialog", async () => {
  history.replaceState(null, "", "#/acme/api/board");
  render(<Dashboard state={state} error={null} />);
  const work = screen.getByRole("region", { name: t("queue.label") });
  await within(work).findByText(t("queue.backlogEmpty"));
  fireEvent.click(within(work).getByRole("tab", { name: new RegExp(t("queue.answers")) }));
  checked(document.body);
  const list = within(work).getByRole("list", { name: t("queue.answersList") });
  const card = within(list).getAllByRole("listitem")[0];
  const area = screen.getByRole("list", {
    name: t("graph.issuesOf", { repo: "acme/api" }),
  }).parentElement!;
  const dataTransfer = transfer();
  fireEvent.dragStart(card, { dataTransfer });
  fireEvent.dragOver(area, { dataTransfer });
  expect(screen.getByText(t("drag.answerStart", { ref: "#138" }))).toBeTruthy();
  checked(document.body);
  fireEvent.dragEnd(card, { dataTransfer });
  fireEvent.click(
    within(list).getByRole("button", { name: t("queue.answerAria", { number: 138 }) }),
  );
  checked(screen.getByRole("dialog"));
});

test("a task's detail and its log, streamed", async () => {
  history.replaceState(null, "", `#/acme/app?task=${encodeURIComponent("acme/app#22")}`);
  render(<Dashboard state={state} error={null} />);
  const step = { kind: "step", stage: "build 1/2", seconds: null, error: null } as const;
  const entries: Entry[] = [
    { kind: "phase", phase: "setup", at: 0 },
    { kind: "meta", text: "Cloned acme/app" },
    { kind: "phase", phase: "image", at: 6000 },
    { ...step, step: 1, name: "FROM node", status: "cached" },
    { ...step, step: 2, name: "RUN npm ci", status: "done", seconds: 41 },
    { kind: "phase", phase: "work", at: 60000 },
    { kind: "text", text: "I'll add a retry with backoff." },
    { kind: "tool", name: "Bash", text: "node --test" },
    { kind: "output", text: "AssertionError", error: true },
    { kind: "phase", phase: "push", at: 230000 },
    { kind: "result", status: "ok", minutes: 4, text: "Pushed the fix." },
  ];
  act(() => FakeSource.last!.emit("entries", entries));
  await screen.findByText("node --test");
  checked(document.body, entries);
  // Stop asks first.
  fireEvent.click(screen.getByRole("button", { name: t("detail.stop") }));
  checked(screen.getByRole("alertdialog"));
});

test("a discussion's thread", async () => {
  history.replaceState(null, "", `#/?task=${encodeURIComponent("acme/notes#discussion-8")}`);
  render(<Dashboard state={state} error={null} />);
  await screen.findByRole("region", { name: t("thread.label") });
  fireEvent.click(screen.getByRole("button", { name: t("thread.reply") }));
  checked(document.body);
});

test("a task waiting for answers, one whose review loop left findings, and a failed one", () => {
  for (const key of ["acme/api#138", "acme/api#131", "acme/app#16"]) {
    history.replaceState(null, "", `#/tasks?task=${encodeURIComponent(key)}`);
    const view = render(<Dashboard state={state} error={null} />);
    // The review loop's line opens its every review.
    const reviews = screen.queryByText(t("reviewLoop.last"))?.closest("button");
    if (reviews) fireEvent.click(reviews);
    expect(!!reviews).toBe(key === "acme/api#131");
    checked(document.body);
    view.unmount();
  }
});

test("the task page's `a` finds its questions' form by what it is, not by its label", () => {
  setPref("shortcuts", true);
  history.replaceState(null, "", `#/tasks?task=${encodeURIComponent("acme/api#138")}`);
  render(<Dashboard state={state} error={null} />);
  const form = screen.getByRole("form", { name: t("questions.title") });
  fireEvent.keyDown(document.body, { key: "a" });
  expect(form.contains(document.activeElement)).toBe(true);
});

// Not merged; then merged by Deckhand, by someone, by no one known. One test each: each renders
// the dashboard and reads the whole page, and four in one test ran past its 5 s on a busy runner.
const MERGES: [string, (now: number) => ReviewFindings["merged"]][] = [
  ["not merged", () => null],
  ["merged by Deckhand", (now) => ({ at: now - 1000, by: "deckhand-app[bot]", deckhand: true })],
  ["merged by someone", (now) => ({ at: now - 1000, by: "alice", deckhand: false })],
  ["merged by no one known", (now) => ({ at: now - 1000, by: null, deckhand: false })],
];

test.each(MERGES)("a task's Review tab, %s, with each follow-up's filing", async (_, merge) => {
  const head = "aaaaaaa1111111111111111111111111111111";
  const url = "https://github.example.com/acme/app/pull/25";
  const item = { path: "lib/cache.mjs", line: 20, text: "A miss goes out?" };
  const FILINGS: ReviewFindings["followUps"][number]["filing"][] = [
    ...(["after-merge", "failed", "left", "off", "unread", "not-filed", "unknown"] as const),
  ];
  const review: ReviewFindings = {
    url: `${url}#pullrequestreview-7`,
    at: state.now - 60_000,
    verdict: "request-changes",
    rating: 5,
    head,
    round: 1,
    manual: false,
    blob: `https://github.example.com/acme/app/blob/${head}`,
    allowed: "medium",
    findings: [
      { ...item, severity: "high", tolerated: false },
      { ...item, severity: "medium", tolerated: true },
    ],
    followUps: [
      ...FILINGS.map((filing, i) => ({ ...item, title: `Follow-up ${i}`, filing })),
      {
        ...item,
        title: "Filed",
        filing: "issue",
        issue: { number: 40, state: "closed", url: null },
      },
    ],
    comments: [
      { ...item, blocking: true },
      { ...item, blocking: false },
    ],
    merged: merge(state.now),
  };
  const reviewed: State = {
    ...state,
    tasks: state.tasks.map((task) =>
      task.key === "acme/app#22"
        ? {
            ...task,
            state: "done",
            // A commit pushed since: the review's Outdated mark.
            pr: { number: 25, url, state: "ready", readyAt: 1, head: "bbbbbbb" },
            review: { loop: "stopped", round: 1, rounds: 2, history: [{ ...round(1, 1), head }] },
          }
        : task,
    ),
  };
  mockApi({ "api/review": () => review });
  history.replaceState(null, "", `#/tasks?task=${encodeURIComponent("acme/app#22")}`);
  render(<Dashboard state={reviewed} error={null} />);
  fireEvent.click(screen.getByRole("tab", { name: t("detail.reviewTab") }));
  await screen.findByRole("region", { name: t("reviewTab.comments") });
  // Only what the tab shows as it was sent: the review's own texts, not its verdict, filings or
  // issue states, which the catalog writes. `allowed` is the repo's config value, shown so.
  const sent = [
    ...[...review.findings, ...review.followUps, ...review.comments].flatMap((f) => [
      f.text,
      `${f.path}:${f.line}`,
    ]),
    ...review.followUps.map((f) => f.title),
    ...[review.allowed, "@alice", head.slice(0, 7), "bbbbbbb"],
  ];
  checked(document.body, sent);
});
