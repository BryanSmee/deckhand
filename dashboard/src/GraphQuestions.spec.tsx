// The graph's work area and an issue waiting for answers: starting or queueing it opens its
// open questions first, and every one needs an answer before it goes (fetch mocked).
import { fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { beforeEach, expect, test } from "vitest";
import { Dashboard } from "./App";
import { Graph } from "./Graph";
import { BACKLOG, makeState, mockApi } from "./testUtils";
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
  const work = screen.getByRole("region", { name: "Work area" });
  await within(work).findByText("No open issue left to start.");
  return within(work).getByRole("list", { name: "Issues waiting for answers" });
};

// Every question of the fixture's #138 answered: its two picks are ticked in advance, the
// free-text one is left.
const answerAll = (dialog: HTMLElement) =>
  fireEvent.input(within(dialog).getByRole("textbox", { name: "Answer to question 3" }), {
    target: { value: "No results" },
  });

test("Start on an issue waiting for answers opens its questions; it starts with them", async () => {
  const list = await area();
  fireEvent.click(within(list).getByRole("button", { name: "Start #138" }));
  const dialog = screen.getByRole("dialog", { name: "Answer #138's questions" });
  expect(within(dialog).getByText("Answer them to start #138")).toBeTruthy();
  const send = within(dialog).getByRole("button", { name: "Send answers and start" });
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

test("Queue after… sends the queue along; a refusal stays in the form", async () => {
  answer = () => Response.json({ error: "#141 was closed without being done." }, { status: 422 });
  const list = await area();
  fireEvent.click(within(list).getByRole("button", { name: "After…" }));
  fireEvent.change(within(list).getByRole("combobox", { name: "Queue #138 after" }), {
    target: { value: "141" },
  });
  fireEvent.click(within(list).getByRole("button", { name: "Queue" }));
  const dialog = screen.getByRole("dialog", { name: "Answer #138's questions" });
  expect(within(dialog).getByText("Answer them to queue #138 after #141")).toBeTruthy();
  answerAll(dialog);
  fireEvent.click(within(dialog).getByRole("button", { name: "Send answers and queue" }));
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
  const work = screen.getByRole("region", { name: "Work area" });
  await within(work).findByText("No open issue left to start.");
  const list = within(work).getByRole("list", { name: "Issues waiting for answers" });
  fireEvent.click(within(list).getByRole("button", { name: "Start #144" }));
  const dialog = screen.getByRole("dialog", { name: "Answer #144's questions" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Send answers and start" }));
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
  fireEvent.click(within(list).getByRole("button", { name: "Start #138" }));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(within(list).getByRole("button", { name: "Start #138" }));
  fireEvent.keyDown(window, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(api.posted).toEqual([]);
});

test("a repo that doesn't wait for answers: Start goes without the questions", async () => {
  const off = {
    ...state,
    tasks: state.tasks.map((t) => (t.key === "acme/api#138" ? { ...t, waitForAnswers: false } : t)),
  };
  const list = await area(off);
  fireEvent.click(within(list).getByRole("button", { name: "Start #138" }));
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
  const dialog = screen.getByRole("dialog", { name: "Answer #138's questions" });
  expect(within(dialog).getByText("#138 waits for your answers")).toBeTruthy();
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

test("on every repo's graph too; Escape and the backdrop close it without sending", async () => {
  render(
    <Graph state={state} repo={null} narrow={false} showClosed={false} onShowClosed={() => {}} />,
  );
  fireEvent.click(node(/#138 .*: Needs input/));
  expect(screen.getByRole("dialog", { name: "Answer #138's questions" })).toBeTruthy();
  fireEvent.keyDown(window, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  fireEvent.click(node(/#138 .*: Needs input/));
  const backdrop = screen.getByRole("dialog").parentElement!;
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
  const dialog = screen.getByRole("dialog", { name: "Answer PR #141's questions" });
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
