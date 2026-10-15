// Dragging issues waiting for answers onto the graph: the work area's cards, and the graph's
// own nodes (fetch mocked). Brainstorms are the column's: Brainstorms.spec.tsx.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Dashboard } from "./App";
import fixture from "./fixture.json";
import type { Backlog, State, Task } from "./types";
import { ISSUE_TYPE } from "./WorkArea";

const state = fixture as State;

const BACKLOG: Backlog = { issues: [], modes: ["work"], errors: false, readAt: 0 };

// What board.mjs lists for acme/api: an issue as each state and kind has it.
const task = (number: number, kind: Task["kind"], taskState: Task["state"]) =>
  ({
    key: `acme/api#${kind === "pr" ? "pr-" : ""}${number}`,
    repo: "acme/api",
    project: "acme",
    number,
    title: `Issue ${number}`,
    kind,
    mode: null,
    replyTo: number,
    state: taskState,
    since: 1791979300000,
    closed: null,
    pr: null,
    runs: [],
  }) as unknown as Task;

let posted: { url: string; body: unknown }[];
beforeEach(() => {
  posted = [];
  history.replaceState(null, "", "#/graph/acme/api");
  Object.assign(globalThis, {
    matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
  });
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (url === "api/repos/acme/api/issues") return Response.json(BACKLOG);
    if (init?.method === "POST") {
      posted.push({ url, body: JSON.parse(String(init.body)) });
      return Response.json({ message: "done" });
    }
    return new Response("{}", { status: 404 });
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

// The browser's DataTransfer, which jsdom doesn't have.
function transfer(data: Record<string, string> = {}) {
  return {
    data,
    get types() {
      return Object.keys(data);
    },
    setData(type: string, value: string) {
      data[type] = value;
    },
    getData: (type: string) => data[type] ?? "",
    effectAllowed: "none",
    dropEffect: "none",
  };
}

const show = async (tasks: Task[] = []) => {
  render(<Dashboard state={{ ...state, tasks: [...state.tasks, ...tasks] }} error={null} />);
  const work = screen.getByRole("region", { name: "Work area" });
  await within(work).findByText("No open issue left to start.");
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
    .getByRole("button", { name: `Start #${number}` })
    .closest("li")!;

test("a card waiting for answers carries its issue; dropped, it opens the questions", async () => {
  const { list, area } = await show();
  const card = cardOf(list, 138);
  expect(card.getAttribute("draggable")).toBe("true");
  const data = dragCard(card, area);
  expect(data.data).toEqual({
    [ISSUE_TYPE]: "138",
    "text/uri-list": "https://github.example.com/acme/api/issues/138",
  });
  expect(screen.getByRole("dialog", { name: "Answer #138's questions" })).toBeTruthy();
  expect(posted).toEqual([]);
});

test("a needs-input node after a brainstorm run can be dragged", async () => {
  await show([task(152, "brainstorm", "needs-input")]);
  dragNode(screen.getByRole("listitem", { name: /^#152 / }));
  await waitFor(() =>
    expect(posted.map((p) => p.body)).toEqual([{ action: "start", number: 152 }]),
  );
});

test("a pull request waiting for answers stays where it is", async () => {
  await show([task(153, "pr", "needs-input")]);
  dragNode(screen.getByRole("listitem", { name: /^PR #153 / }));
  expect(screen.queryByRole("list", { name: "Issues waiting for answers" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Start #153" })).toBeNull();
  await new Promise((r) => setTimeout(r, 10));
  expect(posted).toEqual([]);
});

test("dropped text that isn't an issue's link says to drag its card", async () => {
  const { area } = await show();
  const dataTransfer = transfer({ "text/plain": "Graph: drag issues" });
  fireEvent.dragOver(area, { dataTransfer });
  fireEvent.drop(area, { dataTransfer });
  expect(screen.getByRole("status").textContent).toMatch(/drag an issue's card/);
  expect(posted).toEqual([]);
});
