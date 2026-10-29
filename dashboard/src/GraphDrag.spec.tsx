// Dragging issues waiting for answers onto the graph: the work queue's cards, and the graph's
// own nodes; and the nodes of stopped or failed issues, which move like their backlog cards
// (fetch mocked). Brainstorms are the Brainstorm tab's: Brainstorms.spec.tsx.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { beforeEach, expect, test } from "vitest";
import { Dashboard } from "./App";
import { ISSUE_TYPE } from "./dnd";
import { BACKLOG, makeState, makeTask, mockApi, transfer } from "./testUtils";
import type { Task } from "./types";

const state = makeState();

// What board.mjs lists for acme/api: an issue as each state and kind has it.
const task = (number: number, kind: Task["kind"], taskState: Task["state"]) =>
  makeTask({
    key: `acme/api#${kind === "pr" ? "pr-" : ""}${number}`,
    repo: "acme/api",
    number,
    kind,
    state: taskState,
    since: 1791979300000,
  });

let api: ReturnType<typeof mockApi>;
beforeEach(() => {
  api = mockApi({ "api/repos/acme/api/issues": () => BACKLOG });
  history.replaceState(null, "", "#/acme/api/board");
});

const show = async (tasks: Task[] = []) => {
  render(<Dashboard state={{ ...state, tasks: [...state.tasks, ...tasks] }} error={null} />);
  const work = screen.getByRole("region", { name: "Work queue" });
  await within(work).findByText("No open issue left to start.");
  fireEvent.click(within(work).getByRole("tab", { name: /^Answers/ }));
  return {
    list: within(work).getByRole("list", { name: "Issues waiting for answers" }),
    // The drop area: the drawing's parent.
    area: screen.getByRole("list", { name: "Issues of acme/api" }).parentElement!,
  };
};

// A card dragged from the work area, let go in the graph's open space.
const dragCard = (card: HTMLElement, area: HTMLElement) => {
  const dataTransfer = transfer();
  fireEvent.dragStart(card, { dataTransfer });
  fireEvent.dragOver(area, { dataTransfer });
  fireEvent.drop(area, { dataTransfer });
  return dataTransfer;
};

// A node pressed and moved past the drag's threshold, let go in the open.
const dragNode = (node: HTMLElement) => {
  fireEvent.pointerDown(node, { button: 0, pointerId: 1, clientX: 5000, clientY: 5000 });
  fireEvent.pointerMove(node, { pointerId: 1, clientX: 5100, clientY: 5100 });
  fireEvent.pointerUp(node, { pointerId: 1, clientX: 5100, clientY: 5100 });
};

const cardOf = (list: HTMLElement, number: number) =>
  within(list)
    .getByRole("button", { name: `Answer #${number} and start it` })
    .closest("li")!;

test("a card waiting for answers carries its issue; dropped, it opens the questions", async () => {
  const { list, area } = await show();
  const card = cardOf(list, 138);
  expect(card.getAttribute("draggable")).toBe("true");
  // Over the graph, it shows as a node: its number, "Answer" and its title.
  fireEvent.dragStart(card, { dataTransfer: transfer() });
  fireEvent.dragOver(area, { dataTransfer: transfer({ [ISSUE_TYPE]: "138" }) });
  expect(area.querySelector('[class*="ghost"]')?.textContent).toMatch(/^#138Answer/);
  fireEvent.dragEnd(card);
  const data = dragCard(card, area);
  expect(data.data).toEqual({
    [ISSUE_TYPE]: "138",
    "text/uri-list": "https://github.example.com/acme/api/issues/138",
  });
  expect(screen.getByRole("dialog", { name: "3 open questions" })).toBeTruthy();
  expect(api.posted).toEqual([]);
});

test("a needs-input node after a brainstorm run can be dragged", async () => {
  await show([task(152, "brainstorm", "needs-input")]);
  dragNode(screen.getByRole("listitem", { name: /^#152 / }));
  await waitFor(() =>
    expect(api.posted.map((p) => p.body)).toEqual([{ action: "start", number: 152 }]),
  );
});

test("a pull request waiting for answers stays where it is", async () => {
  await show([task(153, "pr", "needs-input")]);
  dragNode(screen.getByRole("listitem", { name: /^PR #153 / }));
  expect(screen.queryByRole("list", { name: "Issues waiting for answers" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: /#153/ })).toBeNull();
  await new Promise((r) => setTimeout(r, 10));
  expect(api.posted).toEqual([]);
});

test("an issue's link dragged from another tab draws no ghost, and drops as before", async () => {
  const { area } = await show();
  const link = "https://github.example.com/acme/api/issues/138";
  const dataTransfer = transfer({ "text/uri-list": link, "text/plain": link });
  fireEvent.dragOver(area, { dataTransfer });
  // Nothing known about it before the drop: no ghost, the browser's own image.
  expect(area.querySelector('[class*="ghost"]')).toBeNull();
  expect(screen.getByText("Start the issue")).toBeTruthy();
  fireEvent.drop(area, { dataTransfer });
  expect(screen.getByRole("dialog", { name: "3 open questions" })).toBeTruthy();
});

test("dropped text that isn't an issue's link says to drag its card", async () => {
  const { area } = await show();
  const dataTransfer = transfer({ "text/plain": "Graph: drag issues" });
  fireEvent.dragOver(area, { dataTransfer });
  fireEvent.drop(area, { dataTransfer });
  expect(screen.getByRole("alert").textContent).toMatch(/drag an issue's card/);
  expect(api.posted).toEqual([]);
});

test("a parent issue's card shows its sub-issues; dropped on the graph, it lays them out", async () => {
  const epic = { number: 10, title: "Epic", url: "https://github.example.com/acme/api/issues/10" };
  api = mockApi({
    "api/repos/acme/api/issues": () => ({ ...BACKLOG, issues: [{ ...epic, subIssues: 3 }] }),
  });
  render(<Dashboard state={state} error={null} />);
  const work = screen.getByRole("region", { name: "Work queue" });
  const card = (await within(work).findByText("Epic")).closest("li")!;
  expect(within(card).getByText(/^3 sub-issues/)).toBeTruthy();
  fireEvent.change(screen.getByRole("combobox", { name: /Start in/ }), {
    target: { value: "review" },
  });
  dragCard(card, screen.getByRole("list", { name: "Issues of acme/api" }).parentElement!);
  await waitFor(() =>
    expect(api.posted.map((p) => p.body)).toEqual([{ action: "plan", number: 10, mode: "review" }]),
  );
});

// Issue #160 on the graph as `taskState` has it, its backlog read listing it (`listed`: with
// that many sub-issues, null not at all): the node, once the backlog is read.
const showStopped = async (taskState: Task["state"], listed: number | null = 0) => {
  const issue = {
    number: 160,
    title: "Stopped",
    url: "https://github.example.com/acme/api/issues/160",
  };
  const issues = listed === null ? [] : [{ ...issue, subIssues: listed || undefined }];
  api = mockApi({ "api/repos/acme/api/issues": () => ({ ...BACKLOG, issues }) });
  render(
    <Dashboard
      state={{ ...state, tasks: [...state.tasks, task(160, "issue", taskState)] }}
      error={null}
    />,
  );
  const work = screen.getByRole("region", { name: "Work queue" });
  if (listed === null) await within(work).findByText("No open issue left to start.");
  else await within(work).findByRole("button", { name: "Start #160" });
  return screen.getByRole("listitem", { name: /^#160 / });
};

// A node pressed and moved onto the node at the drawing's corner (jsdom puts the drawing at 0,
// 0), what letting go there says, then let go.
const dragOnto = (node: HTMLElement) => {
  fireEvent.pointerDown(node, { button: 0, pointerId: 1, clientX: 400, clientY: 400 });
  fireEvent.pointerMove(node, { pointerId: 1, clientX: 20, clientY: 20 });
  const label = screen.getByText(/^Queue #\d+ after (PR )?#\d+$/).textContent;
  fireEvent.pointerUp(node, { pointerId: 1, clientX: 20, clientY: 20 });
  return label;
};

test.each(["cancelled", "error", "interrupted"] as const)(
  "a %s issue's node dragged onto another node is queued after it",
  async (ended) => {
    const node = await showStopped(ended);
    expect(node.className).toMatch(/movable/);
    const label = dragOnto(node);
    const after = Number(label!.match(/^Queue #160 after (?:PR )?#(\d+)$/)![1]);
    await waitFor(() =>
      expect(api.posted.map((p) => p.body)).toEqual([{ action: "queue", number: 160, after }]),
    );
    // On its way: dashed, saying so, no longer movable.
    const sent = screen.getByRole("listitem", { name: /^#160 / });
    expect(sent.className).toMatch(/pending/);
    expect(sent.className).not.toMatch(/movable/);
  },
);

test("a stopped issue's node let go in the open starts in the mode picked", async () => {
  const node = await showStopped("cancelled");
  fireEvent.change(screen.getByRole("combobox", { name: /Start in/ }), {
    target: { value: "review" },
  });
  fireEvent.pointerDown(node, { button: 0, pointerId: 1, clientX: 5000, clientY: 5000 });
  fireEvent.pointerMove(node, { pointerId: 1, clientX: 5100, clientY: 5100 });
  expect(screen.getByText("Start #160 in review")).toBeTruthy();
  fireEvent.pointerUp(node, { pointerId: 1, clientX: 5100, clientY: 5100 });
  await waitFor(() =>
    expect(api.posted.map((p) => p.body)).toEqual([
      { action: "start", number: 160, mode: "review" },
    ]),
  );
});

test("a stopped parent issue's node is laid out with its sub-issues", async () => {
  dragNode(await showStopped("cancelled", 2));
  await waitFor(() =>
    expect(api.posted.map((p) => p.body)).toEqual([{ action: "plan", number: 160 }]),
  );
});

// Right after a stop, the listener leaves the issue out of the backlog until a read after it:
// whether it has sub-issues to lay out isn't known yet.
test("a stopped issue's node the backlog doesn't list yet stays where it is", async () => {
  const node = await showStopped("cancelled", null);
  expect(node.className).not.toMatch(/movable/);
  dragNode(node);
  await new Promise((r) => setTimeout(r, 10));
  expect(api.posted).toEqual([]);
});

test("a done issue's node and a stopped pull request's stay where they are", async () => {
  await show([task(161, "issue", "done"), task(163, "pr", "cancelled")]);
  for (const name of [/^#161 /, /^PR #163 /]) {
    const node = screen.getByRole("listitem", { name });
    expect(node.className).not.toMatch(/movable/);
    dragNode(node);
  }
  await new Promise((r) => setTimeout(r, 10));
  expect(api.posted).toEqual([]);
});

test("S on a selected stopped node starts it, as its backlog card's Start", async () => {
  const node = await showStopped("cancelled");
  node.focus();
  fireEvent.keyDown(node, { key: "s" });
  await waitFor(() =>
    expect(api.posted.map((p) => p.body)).toEqual([{ action: "start", number: 160 }]),
  );
});
