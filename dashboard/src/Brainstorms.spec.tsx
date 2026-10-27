// The Brainstorm column between the backlog and the graph: its cards, the drags between the
// three and the buttons that stand for them (fetch mocked).
import { fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { beforeEach, expect, test } from "vitest";
import { Dashboard } from "./App";
import { BACKLOG, makeState, makeTask, mockApi, transfer } from "./testUtils";
import type { Task } from "./types";

const state = makeState();

// A brainstorm as board.mjs lists it.
const brainstorm = (number: number, taskState: Task["state"], extra: Partial<Task> = {}) =>
  makeTask({
    repo: "acme/api",
    number,
    title: `Brainstorm ${number}`,
    kind: "brainstorm",
    mode: "brainstorm",
    state: taskState,
    since: 1791979300000,
    deadline: 1791979300000,
    ...extra,
  });

let api: ReturnType<typeof mockApi>;
// The POSTs' answers, held until `release()`: what shows while they are on their way.
let release: () => void;
beforeEach(() => {
  const issue = {
    number: 31,
    title: "Backlog issue",
    url: "https://github.example.com/acme/api/issues/31",
  };
  api = mockApi({ "api/repos/acme/api/issues": () => ({ ...BACKLOG, issues: [issue] }) });
  release = api.hold();
  history.replaceState(null, "", "#/acme/api/board");
});

const show = async (tasks: Task[] = []) => {
  render(<Dashboard state={{ ...state, tasks: [...state.tasks, ...tasks] }} error={null} />);
  const work = screen.getByRole("region", { name: "Work area" });
  await within(work).findByText("Backlog issue");
  const column = screen.getByRole("region", { name: "Brainstorms" });
  return {
    work,
    column,
    cards: () => within(column).getByRole("list", { name: "Issues being brainstormed" }),
    area: screen.getByRole("list", { name: "Issues of acme/api" }).parentElement!,
  };
};

// `card` dragged and let go on `onto`.
const drag = (card: HTMLElement, onto: HTMLElement) => {
  const dataTransfer = transfer();
  fireEvent.dragStart(card, { dataTransfer });
  fireEvent.dragOver(onto, { dataTransfer });
  fireEvent.drop(onto, { dataTransfer });
  return dataTransfer;
};

const cardOf = (list: HTMLElement, text: string) => within(list).getByText(text).closest("li")!;

test("brainstorms are cards of the column with their state, not nodes of the graph", async () => {
  const { cards } = await show([
    brainstorm(150, "brainstorm"),
    brainstorm(151, "idle-brainstorm"),
    brainstorm(152, "stopping", { kind: "issue" }),
  ]);
  const listed = within(cards()).getAllByRole("listitem");
  expect(listed.map((c) => c.querySelector("a")!.textContent)).toEqual(["#150", "#151", "#152"]);
  expect(listed[1].textContent).toMatch(/Idle brainstorm/);
  expect(listed[2].textContent).toMatch(/Stopping/);
  for (const n of [150, 151, 152]) {
    expect(screen.queryByRole("listitem", { name: new RegExp(`^#${n} `) })).toBeNull();
  }
  // Wrapping up: nothing to do to it until it is over.
  expect(listed[2].getAttribute("draggable")).toBe("false");
  expect(within(listed[2]).getByRole("button", { name: "Stop #152's brainstorm" })).toHaveProperty(
    "disabled",
    true,
  );
  // Not among the issues waiting for answers either.
  const answering = screen.getByRole("list", { name: "Issues waiting for answers" });
  expect(within(answering).queryByText(/Brainstorm 15/)).toBeNull();
});

test("a brainstorm an arrow touches stays on the graph too", async () => {
  render(
    <Dashboard
      state={{
        ...state,
        tasks: [...state.tasks, brainstorm(150, "brainstorm")],
        edges: [...state.edges, { from: "acme/api#150", to: "acme/api#7", kind: "after" }],
      }}
      error={null}
    />,
  );
  expect(screen.getByRole("listitem", { name: /^#150 / })).toBeTruthy();
  expect(
    cardOf(screen.getByRole("list", { name: "Issues being brainstormed" }), "Brainstorm 150"),
  ).toBeTruthy();
});

test("a backlog issue dropped on the column starts a brainstorm, its card pending at once", async () => {
  const { work, column, cards } = await show();
  const data = drag(cardOf(work, "Backlog issue"), column);
  expect(data.types).not.toContain("application/x-deckhand-brainstorm");
  await waitFor(() =>
    expect(api.bodies()).toEqual([{ action: "start", number: 31, mode: "brainstorm" }]),
  );
  const card = cardOf(cards(), "Backlog issue");
  expect(card.textContent).toMatch(/Sending…/);
  // Out of the backlog meanwhile, and not a node.
  expect(within(work).queryByText("Backlog issue")).toBeNull();
  expect(screen.queryByRole("listitem", { name: /^#31 / })).toBeNull();
  release();
  await waitFor(() => expect(within(cards()).queryByText("Backlog issue")).toBeNull());
});

test("the backlog's Brainstorm button does what the drop does", async () => {
  const { work } = await show();
  fireEvent.click(within(work).getByRole("button", { name: "Brainstorm #31" }));
  await waitFor(() =>
    expect(api.bodies()).toEqual([{ action: "start", number: 31, mode: "brainstorm" }]),
  );
});

test("a brainstorm dropped on the graph starts work, whatever Start in says", async () => {
  const { work, cards, area } = await show([brainstorm(150, "idle-brainstorm")]);
  fireEvent.change(within(work).getByRole("combobox"), { target: { value: "brainstorm" } });
  const data = drag(cardOf(cards(), "Brainstorm 150"), area);
  expect(data.data["application/x-deckhand-brainstorm"]).toBe("150");
  await waitFor(() => expect(api.bodies()).toEqual([{ action: "start", number: 150 }]));
  // On its way to the graph: Sending… there, gone from the column.
  expect(screen.getByRole("listitem", { name: /^#150 .*Sending…/ })).toBeTruthy();
  expect(within(cards()).queryByText("Brainstorm 150")).toBeNull();
});

test("After… on a card queues it after a node of the graph", async () => {
  const { cards } = await show([brainstorm(150, "brainstorm")]);
  const card = cardOf(cards(), "Brainstorm 150");
  fireEvent.click(within(card).getByRole("button", { name: "After…" }));
  const select = within(card).getByRole("combobox", { name: "Queue #150 after" });
  const after = Number((select as HTMLSelectElement).value);
  fireEvent.click(within(card).getByRole("button", { name: "Queue" }));
  await waitFor(() => expect(api.bodies()).toEqual([{ action: "queue", number: 150, after }]));
});

test("a brainstorm dropped on the backlog stops, and so does Stop", async () => {
  const { work, cards } = await show([
    brainstorm(150, "brainstorm"),
    brainstorm(151, "brainstorm"),
  ]);
  drag(cardOf(cards(), "Brainstorm 150"), work);
  await waitFor(() => expect(api.bodies()).toEqual([{ action: "stop", number: 150 }]));
  // Still in the column until it is wrapped up.
  expect(cardOf(cards(), "Brainstorm 150").textContent).toMatch(/Sending…/);
  release();
  await waitFor(() =>
    expect(
      within(cardOf(cards(), "Brainstorm 151")).getByRole("button", {
        name: "Stop #151's brainstorm",
      }),
    ).toHaveProperty("disabled", false),
  );
  fireEvent.click(
    within(cardOf(cards(), "Brainstorm 151")).getByRole("button", {
      name: "Stop #151's brainstorm",
    }),
  );
  await waitFor(() => expect(api.bodies().at(-1)).toEqual({ action: "stop", number: 151 }));
});

test("a backlog card dropped on the backlog, or a brainstorm on the column, does nothing", async () => {
  const { work, column, cards } = await show([brainstorm(150, "brainstorm")]);
  drag(cardOf(work, "Backlog issue"), work);
  drag(cardOf(cards(), "Brainstorm 150"), column);
  await new Promise((r) => setTimeout(r, 10));
  expect(api.bodies()).toEqual([]);
});

test("Start work on a card starts work", async () => {
  const { cards } = await show([brainstorm(150, "brainstorm")]);
  fireEvent.click(
    within(cardOf(cards(), "Brainstorm 150")).getByRole("button", { name: "Start work on #150" }),
  );
  await waitFor(() => expect(api.bodies()).toEqual([{ action: "start", number: 150 }]));
});

test("an issue with open questions dropped on the column asks them first", async () => {
  const { column } = await show();
  // acme/api#138 waits for answers in the fixture.
  const list = screen.getByRole("list", { name: "Issues waiting for answers" });
  drag(within(list).getByRole("button", { name: "Start #138" }).closest("li")!, column);
  expect(screen.getByRole("dialog", { name: "Answer #138's questions" })).toBeTruthy();
  expect(api.bodies()).toEqual([]);
});

test("a card's whole title is in its title attribute", async () => {
  const { cards } = await show([brainstorm(150, "brainstorm")]);
  expect(within(cards()).getByText("Brainstorm 150").getAttribute("title")).toBe("Brainstorm 150");
});

test("a card's time follows the listener's clock, not the browser's", () => {
  history.replaceState(null, "", "#/acme/app/board");
  render(<Dashboard state={{ ...state, now: state.now - 3600000 }} error={null} />);
  const cards = screen.getByRole("list", { name: "Issues being brainstormed" });
  // acme/app#20 goes idle 6 minutes after the fixture's `now`: an hour more, an hour earlier.
  expect(
    within(cardOf(cards, "Egress proxy: allow wildcard ports")).getByText(/idle in 66 min/),
  ).toBeTruthy();
});
