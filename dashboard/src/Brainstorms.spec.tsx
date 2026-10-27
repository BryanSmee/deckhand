// The work queue's Brainstorm tab: its cards, the drags between it, the Backlog tab and the
// graph, and the buttons that stand for them (fetch mocked).
import { fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { beforeEach, expect, test } from "vitest";
import { Dashboard } from "./App";
import { BACKLOG, makeState, makeTask, mockApi, transfer, queueAfter } from "./testUtils";
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

// The work queue's tabs.
const tab = (name: string) => screen.getByRole("tab", { name: new RegExp(`^${name}`) });

// The board, the Backlog tab open: `work` is its panel, `column` the Brainstorm tab, `cards()`
// opens that tab and lists its cards.
const show = async (tasks: Task[] = []) => {
  render(<Dashboard state={{ ...state, tasks: [...state.tasks, ...tasks] }} error={null} />);
  const queue = screen.getByRole("region", { name: "Work queue" });
  await within(queue).findByText("Backlog issue");
  return {
    work: screen.getByRole("tabpanel"),
    backlog: tab("Backlog"),
    column: tab("Brainstorm"),
    cards: () => {
      if (tab("Brainstorm").getAttribute("aria-selected") !== "true")
        fireEvent.click(tab("Brainstorm"));
      return within(queue).getByRole("list", { name: "Issues being brainstormed" });
    },
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

test("brainstorms are cards of the Brainstorm tab with their state, not nodes of the graph", async () => {
  const { cards } = await show([
    brainstorm(150, "brainstorm"),
    brainstorm(151, "idle-brainstorm"),
    brainstorm(152, "stopping", { kind: "issue" }),
  ]);
  expect(tab("Brainstorm").textContent).toBe("Brainstorm 3");
  const listed = within(cards()).getAllByRole("listitem");
  expect(listed.map((c) => c.querySelector("a")!.textContent)).toEqual([
    "#150 Brainstorm 150",
    "#151 Brainstorm 151",
    "#152 Brainstorm 152",
  ]);
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
  fireEvent.click(tab("Answers"));
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
  fireEvent.click(tab("Brainstorm"));
  expect(
    cardOf(screen.getByRole("list", { name: "Issues being brainstormed" }), "Brainstorm 150"),
  ).toBeTruthy();
});

test("a backlog issue dropped on the Brainstorm tab starts a brainstorm, its card pending at once", async () => {
  const { work, column, cards } = await show();
  const data = drag(cardOf(work, "Backlog issue"), column);
  expect(data.types).not.toContain("application/x-deckhand-brainstorm");
  await waitFor(() =>
    expect(api.bodies()).toEqual([{ action: "start", number: 31, mode: "brainstorm" }]),
  );
  // Out of the backlog meanwhile, and not a node.
  expect(within(work).queryByText("Backlog issue")).toBeNull();
  expect(screen.queryByRole("listitem", { name: /^#31 / })).toBeNull();
  const card = cardOf(cards(), "Backlog issue");
  expect(card.textContent).toMatch(/Starting…/);
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
  const { cards, area } = await show([brainstorm(150, "idle-brainstorm")]);
  fireEvent.change(screen.getByRole("combobox", { name: /Start in/ }), {
    target: { value: "brainstorm" },
  });
  // Over the graph, a node: its number, its state and its title.
  const card = cardOf(cards(), "Brainstorm 150");
  fireEvent.dragStart(card, { dataTransfer: transfer() });
  fireEvent.dragOver(area, { dataTransfer: transfer({ "application/x-deckhand-brainstorm": "" }) });
  expect(area.querySelector('[class*="ghost"]')?.textContent).toMatch(/^#150.+Brainstorm 150$/);
  fireEvent.dragEnd(card);
  const data = drag(card, area);
  expect(data.data["application/x-deckhand-brainstorm"]).toBe("150");
  await waitFor(() => expect(api.bodies()).toEqual([{ action: "start", number: 150 }]));
  // On its way to the graph: Starting… there, gone from the tab.
  expect(screen.getByRole("listitem", { name: /^#150 .*Starting…/ })).toBeTruthy();
  expect(within(cards()).queryByText("Brainstorm 150")).toBeNull();
});

test("After… on a card queues it after a node of the graph", async () => {
  const { cards } = await show([brainstorm(150, "brainstorm")]);
  const card = cardOf(cards(), "Brainstorm 150");
  fireEvent.click(within(card).getByRole("button", { name: "Queue #150 after…" }));
  queueAfter(150, 138);
  await waitFor(() => expect(api.bodies()).toEqual([{ action: "queue", number: 150, after: 138 }]));
});

test("a brainstorm dropped on the Backlog tab stops, and so does Stop", async () => {
  const { backlog, cards } = await show([
    brainstorm(150, "brainstorm"),
    brainstorm(151, "brainstorm"),
  ]);
  drag(cardOf(cards(), "Brainstorm 150"), backlog);
  await waitFor(() => expect(api.bodies()).toEqual([{ action: "stop", number: 150 }]));
  // Still in the tab until it is wrapped up.
  expect(cardOf(cards(), "Brainstorm 150").textContent).toMatch(/Stopping…/);
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

test("a backlog card dropped on the backlog, or a brainstorm on its own tab, does nothing", async () => {
  const { work, backlog, column, cards } = await show([brainstorm(150, "brainstorm")]);
  drag(cardOf(work, "Backlog issue"), work);
  drag(cardOf(work, "Backlog issue"), backlog);
  drag(cardOf(cards(), "Brainstorm 150"), column);
  drag(cardOf(cards(), "Brainstorm 150"), screen.getByRole("tabpanel"));
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

test("an issue with open questions dropped on the Brainstorm tab asks them first", async () => {
  const { column } = await show();
  // acme/api#138 waits for answers in the fixture.
  fireEvent.click(tab("Answers"));
  const list = screen.getByRole("list", { name: "Issues waiting for answers" });
  drag(
    within(list).getByRole("button", { name: "Answer #138 and start it" }).closest("li")!,
    column,
  );
  expect(screen.getByRole("dialog", { name: "3 open questions" })).toBeTruthy();
  expect(api.bodies()).toEqual([]);
});

test("a card's whole title is in its title attribute", async () => {
  const { cards } = await show([brainstorm(150, "brainstorm")]);
  expect(within(cards()).getByText("Brainstorm 150").getAttribute("title")).toBe("Brainstorm 150");
});

test("a card's time follows the listener's clock, not the browser's", () => {
  history.replaceState(null, "", "#/acme/app/board");
  render(<Dashboard state={{ ...state, now: state.now - 3600000 }} error={null} />);
  fireEvent.click(tab("Brainstorm"));
  const cards = screen.getByRole("list", { name: "Issues being brainstormed" });
  // acme/app#20 goes idle 6 minutes after the fixture's `now`: an hour more, an hour earlier.
  expect(
    within(cardOf(cards, "Egress proxy: allow wildcard ports")).getByText(/idle in 66 min/),
  ).toBeTruthy();
});
