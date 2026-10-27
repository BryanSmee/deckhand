// The board's work queue and an issue waiting for answers: starting or queueing it opens its
// open questions first, and every one needs an answer before it goes (fetch mocked).
import { fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { beforeEach, expect, test } from "vitest";
import { Dashboard } from "./App";
import { BACKLOG, makeState, mockApi, queueAfter } from "./testUtils";
import type { State } from "./types";

const state = makeState();

let api: ReturnType<typeof mockApi>;
// The answers' POST: what the listener says to them (a test changes it).
let answer: () => unknown;
beforeEach(() => {
  answer = () => ({ message: "Answers sent: #138 started." });
  api = mockApi({
    "api/repos/acme/api/issues": () => BACKLOG,
    "POST api/repos/acme/api/answer": () => answer(),
  });
  history.replaceState(null, "", "#/acme/api/board");
});

const area = async (shown: State = state) => {
  render(<Dashboard state={shown} error={null} />);
  const work = screen.getByRole("region", { name: "Work queue" });
  await within(work).findByText("No open issue left to start.");
  fireEvent.click(within(work).getByRole("tab", { name: /^Answers/ }));
  return within(work).getByRole("list", { name: "Issues waiting for answers" });
};

// The open questions' dialog, and what its context line says (the issue).
const questions = (count: string) => {
  const name = `${count} open question${count === "1" ? "" : "s"}`;
  const dialog = screen.getByRole("dialog", { name });
  const sub = document.getElementById(dialog.getAttribute("aria-describedby")!)!;
  return { dialog, sub: sub.textContent };
};

// Every question of the fixture's #138 answered: its two picks are ticked in advance, the
// free-text one is left.
const answerAll = (dialog: HTMLElement) =>
  fireEvent.input(within(dialog).getByRole("textbox", { name: "Answer to question 3" }), {
    target: { value: "No results" },
  });

test("Start on an issue waiting for answers opens its questions; it starts with them", async () => {
  const list = await area();
  fireEvent.click(within(list).getByRole("button", { name: "Answer #138 and start it" }));
  const { dialog, sub } = questions("3");
  expect(sub).toMatch(/^#138 Search results flicker/);
  expect(
    (within(dialog).getByRole("checkbox", { name: "Then start it" }) as HTMLInputElement).checked,
  ).toBe(true);
  const send = within(dialog).getByRole("button", { name: "Send answers" });
  // Nothing went yet, and a partial answer can't go: the picks ticked in advance answer two.
  expect(api.posted).toEqual([]);
  expect((send as HTMLButtonElement).disabled).toBe(true);
  expect(within(dialog).getByText("Answer every question to start it (1 left).")).toBeTruthy();
  answerAll(dialog);
  expect((send as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(send);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(api.posted).toEqual([
    {
      url: "api/repos/acme/api/answer",
      body: {
        number: 138,
        answers: [
          { options: [1], text: "" },
          { options: [0], text: "" },
          { options: [], text: "No results" },
        ],
        then: { action: "start" },
      },
    },
  ]);
  expect(await screen.findByRole("status")).toHaveProperty(
    "textContent",
    "Answers sent: #138 started.",
  );
});

test('"Then start it" unticked: the answers go alone, partial ones too, and it doesn\'t start', async () => {
  const list = await area();
  fireEvent.click(within(list).getByRole("button", { name: "Answer #138 and start it" }));
  const { dialog } = questions("3");
  fireEvent.click(within(dialog).getByRole("checkbox", { name: "Then start it" }));
  fireEvent.keyDown(document.activeElement!, { key: "Enter", ctrlKey: true });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(api.posted).toEqual([
    {
      url: "api/repos/acme/api/answer",
      body: {
        number: 138,
        answers: [
          { options: [1], text: "" },
          { options: [0], text: "" },
          { options: [], text: "" },
        ],
      },
    },
  ]);
});

test("Queue after… sends the queue along; a refusal stays in the form", async () => {
  answer = () => Response.json({ error: "#141 was closed without being done." }, { status: 422 });
  const list = await area();
  fireEvent.click(within(list).getByRole("button", { name: "Answer #138 then queue it after…" }));
  queueAfter(138, 141);
  const { dialog } = questions("3");
  expect(within(dialog).getByRole("checkbox", { name: "Then queue it after #141" })).toBeTruthy();
  answerAll(dialog);
  fireEvent.click(within(dialog).getByRole("button", { name: "Send answers" }));
  expect(await within(dialog).findByRole("alert")).toHaveProperty(
    "textContent",
    "#141 was closed without being done.",
  );
  expect(api.posted[0].body).toMatchObject({ number: 138, then: { action: "queue", after: 141 } });
});

test("An issue the backlog found open questions in, with no run, opens its form too", async () => {
  // As board.mjs lists an issue inputs.mjs knows of (the backlog's seeding): no run, its
  // body's questions.
  const seeded = {
    key: "acme/api#144",
    repo: "acme/api",
    project: "acme",
    number: 144,
    title: "Graph: open questions without the label",
    kind: "issue",
    mode: null,
    replyTo: 144,
    state: "needs-input",
    since: 1791979300000,
    closed: null,
    pr: null,
    runs: [],
    questions: {
      source: "issue",
      items: [
        {
          title: "Label",
          text: "Should the listener add the label?",
          options: [
            { label: "Yes", recommended: true },
            { label: "No", recommended: false },
          ],
        },
      ],
      raw: "1. **Label**: Should the listener add the label?",
    },
  } as unknown as State["tasks"][number];
  answer = () => Response.json({ message: "Answers sent: #144 started." });
  render(<Dashboard state={{ ...state, tasks: [...state.tasks, seeded] }} error={null} />);
  const work = screen.getByRole("region", { name: "Work queue" });
  await within(work).findByText("No open issue left to start.");
  fireEvent.click(within(work).getByRole("tab", { name: /^Answers/ }));
  const list = within(work).getByRole("list", { name: "Issues waiting for answers" });
  fireEvent.click(within(list).getByRole("button", { name: "Answer #144 and start it" }));
  const { dialog } = questions("1");
  fireEvent.click(within(dialog).getByRole("button", { name: "Send answers" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(api.posted).toEqual([
    {
      url: "api/repos/acme/api/answer",
      body: { number: 144, answers: [{ options: [0], text: "" }], then: { action: "start" } },
    },
  ]);
  expect(await screen.findByRole("status")).toHaveProperty(
    "textContent",
    "Answers sent: #144 started.",
  );
});

test("Cancel or Escape closes the questions: nothing is sent", async () => {
  const list = await area();
  fireEvent.click(within(list).getByRole("button", { name: "Answer #138 and start it" }));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(within(list).getByRole("button", { name: "Answer #138 and start it" }));
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(api.posted).toEqual([]);
});

test("a repo that doesn't wait for answers: Start goes without the questions", async () => {
  const off = {
    ...state,
    tasks: state.tasks.map((t) => (t.key === "acme/api#138" ? { ...t, waitForAnswers: false } : t)),
  };
  const list = await area(off);
  fireEvent.click(within(list).getByRole("button", { name: "Answer #138 and start it" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  await waitFor(() =>
    expect(api.posted).toEqual([
      { url: "api/repos/acme/api/work", body: { action: "start", number: 138 } },
    ]),
  );
});

test("an issue waiting for answers has its whole title in its title attribute", async () => {
  const list = await area();
  const title = within(list).getByText("Search results flicker when typing fast");
  expect(title.getAttribute("title")).toBe("Search results flicker when typing fast");
});

// A click on a node waiting for answers: its questions on the graph, sent on their own.
const node = (name: RegExp) => screen.getByRole("listitem", { name });

test("a click on a node waiting for answers opens them; they go, Sending… until it runs", async () => {
  answer = () => Response.json({ message: "Answers sent: #138 continues." });
  let rerun!: () => void;
  const refresh = () => new Promise<void>((done) => (rerun = done));
  render(<Dashboard state={state} error={null} refresh={refresh} />);
  const item = node(/^#138 .*: Needs input, 3 questions$/);
  expect(item.textContent).toContain("?3");
  fireEvent.click(item);
  const { dialog, sub } = questions("3");
  expect(sub).toMatch(/^#138 Search results flicker/);
  // Nothing to start or queue: no "Then…".
  expect(within(dialog).queryByRole("checkbox")).toBeNull();
  // The detail page the node's link opens.
  const details = within(dialog).getByRole("link", { name: "Open details" });
  expect(details.getAttribute("href")).toBe(item.getAttribute("href"));
  // No start or queue: a partial answer goes too.
  fireEvent.click(within(dialog).getByRole("button", { name: "Send answers" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(api.posted).toEqual([
    {
      url: "api/repos/acme/api/answer",
      body: {
        number: 138,
        answers: [
          { options: [1], text: "" },
          { options: [0], text: "" },
          { options: [], text: "" },
        ],
      },
    },
  ]);
  expect(screen.getByText("Answers sent: #138 continues.")).toBeTruthy();
  expect(node(/^#138 .*: Sending…/)).toBeTruthy();
  rerun();
  await waitFor(() => expect(node(/^#138 .*: Needs input/)).toBeTruthy());
});

test("Escape and the backdrop close a node's questions without sending", async () => {
  render(<Dashboard state={state} error={null} />);
  fireEvent.click(node(/#138 .*: Needs input/));
  expect(questions("3").dialog).toBeTruthy();
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  fireEvent.click(node(/#138 .*: Needs input/));
  // A press and its release on the scrim.
  const backdrop = screen.getByRole("dialog").parentElement!;
  fireEvent.pointerDown(backdrop);
  fireEvent.click(backdrop);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(api.posted).toEqual([]);
});

test("a modifier click, or a node without parsed questions, follows its link", () => {
  const labelled = {
    ...state,
    tasks: state.tasks.map((t) => (t.key === "acme/api#138" ? { ...t, questions: undefined } : t)),
  };
  const { unmount } = render(<Dashboard state={state} error={null} />);
  const ctrl = fireEvent.click(node(/^#138 /), { ctrlKey: true });
  expect(ctrl).toBe(true);
  expect(screen.queryByRole("dialog")).toBeNull();
  unmount();
  render(<Dashboard state={labelled} error={null} />);
  const item = node(/^#138 .*: Needs input$/);
  expect(item.textContent).not.toContain("?");
  expect(fireEvent.click(item)).toBe(true);
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("a run that asked on a ready pull request: Needs input, answered where it asked", async () => {
  // A pull request's own task ("#pr-141"), its run waiting for answers on it.
  const asked = {
    ...state,
    tasks: state.tasks.map((t) =>
      t.key === "acme/api#pr-141"
        ? {
            ...t,
            state: "needs-input" as const,
            questions: {
              source: "run" as const,
              items: [{ title: null, text: "Rename it?", options: [] }],
              raw: "1. Rename it?",
            },
          }
        : t,
    ),
  };
  answer = () => Response.json({ message: "Answers sent: #141 continues." });
  render(<Dashboard state={asked} error={null} />);
  const item = node(/^PR #141 .*: Needs input, PR ready, 1 question$/);
  expect(item.textContent).toContain("?1");
  fireEvent.click(item);
  const { dialog, sub } = questions("1");
  expect(sub).toMatch(/^PR #141 /);
  fireEvent.input(within(dialog).getByRole("textbox", { name: "Answer to question 1" }), {
    target: { value: "Yes" },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Send answers" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(api.posted).toEqual([
    {
      url: "api/repos/acme/api/answer",
      body: { number: 141, pr: true, answers: [{ options: [], text: "Yes" }] },
    },
  ]);
});
