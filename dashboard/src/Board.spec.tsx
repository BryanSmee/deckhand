// The board's page against a fake API: its toolbar (views, zoom), the lanes and their names,
// what a drag says it will do, and the phone's lanes and work queue sheet.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { beforeEach, expect, test, vi } from "vitest";
import { Dashboard } from "./App";
import { lanesOf } from "./lanes";
import { BACKLOG, makeState, mockApi, transfer } from "./testUtils";
import type { Backlog } from "./types";

const state = makeState();

const backlog: Backlog = {
  ...BACKLOG,
  issues: [
    {
      number: 31,
      title: "Rate-limit the API",
      url: "https://github.example.com/acme/app/issues/31",
    },
    {
      number: 29,
      title: "Setup cache",
      url: "https://github.example.com/acme/app/issues/29",
      subIssues: 2,
    },
  ],
};

let api: ReturnType<typeof mockApi>;
beforeEach(() => {
  api = mockApi({
    "api/repos/acme/app/issues": () => backlog,
    "POST api/repos/acme/app/lane": () => ({ message: "Named." }),
  });
  history.replaceState(null, "", "#/acme/app/board");
});

// The phone's media query, for the tests that need one.
let phone = false;
beforeEach(() => {
  phone = false;
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("min-width") ? !phone : false,
    addEventListener() {},
    removeEventListener() {},
  }));
});

const views = () => within(screen.getByRole("group", { name: "Board view" }));

test("Graph | Lanes: the lanes name each chain, its nodes in the order they run; kept here", async () => {
  const view = render(<Dashboard state={state} error={null} />);
  expect(views().getByRole("button", { name: "Graph" }).getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(views().getByRole("button", { name: "Lanes" }));
  expect(localStorage.getItem("deckhand.boardView")).toBe("lanes");
  const lane = screen.getByRole("region", { name: "Lane #22 and 2 more" });
  expect(
    within(lane)
      .getAllByRole("link")
      .map((a) => a.getAttribute("aria-label")),
  ).toEqual([
    "#22 Dashboard on a frontend framework, built at image build time: Working",
    "#23 Per-repo budgets for runs: Queued",
    "#24 Per-repo budgets in the dashboard: Waiting, waits for 2 issues",
  ]);
  // The zoom is the graph's.
  expect(screen.queryByRole("button", { name: "Zoom in" })).toBeNull();
  view.unmount();
  render(<Dashboard state={state} error={null} />);
  expect(views().getByRole("button", { name: "Lanes" }).getAttribute("aria-pressed")).toBe("true");
});

test("a lane's name comes from the listener, and its header renames it", async () => {
  const refresh = vi.fn(async () => {});
  localStorage.setItem("deckhand.boardView", "lanes");
  const named = {
    ...state,
    lanes: { "acme/app#24": { name: "Budgets", source: "parent" as const } },
  };
  render(<Dashboard state={named} error={null} refresh={refresh} />);
  const lane = screen.getByRole("region", { name: "Lane Budgets" });
  fireEvent.click(within(lane).getByRole("button", { name: "Rename the lane Budgets" }));
  const field = within(lane).getByRole("textbox", { name: "Lane name" });
  expect((field as HTMLInputElement).value).toBe("Budgets");
  fireEvent.input(field, { target: { value: "Run budgets " } });
  fireEvent.click(within(lane).getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(api.posted).toEqual([
      {
        url: "api/repos/acme/app/lane",
        body: { keys: ["acme/app#22", "acme/app#23", "acme/app#24"], name: "Run budgets" },
      },
    ]),
  );
  await waitFor(() => expect(refresh).toHaveBeenCalled());
  // Escape leaves the field without sending.
  fireEvent.click(screen.getByRole("button", { name: /^Rename the lane/ }));
  fireEvent.keyDown(screen.getByRole("textbox", { name: "Lane name" }), { key: "Escape" });
  expect(screen.queryByRole("textbox", { name: "Lane name" })).toBeNull();
  expect(api.posted).toHaveLength(1);
});

test("zoom out, in, back to 100%, and Fit", () => {
  render(<Dashboard state={state} error={null} />);
  const percent = () => screen.getByRole("button", { name: /^Zoom \d+%/ });
  fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
  fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
  expect(percent().textContent).toBe("80%");
  const drawing = screen.getByRole("list", { name: "Issues of acme/app" });
  expect(drawing.style.transform).toBe("scale(0.8)");
  fireEvent.click(percent());
  expect(percent().textContent).toBe("100%");
  fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
  expect(percent().textContent).toBe("110%");
  // jsdom has no layout: Fit falls back to 100%.
  fireEvent.click(screen.getByRole("button", { name: "Fit" }));
  expect(percent().textContent).toBe("100%");
});

test("a drag over the graph says what letting go does, and the card being dragged is dimmed", async () => {
  render(<Dashboard state={state} error={null} />);
  const queue = screen.getByRole("region", { name: "Work queue" });
  const card = (await within(queue).findByText("Rate-limit the API")).closest("li")!;
  const area = screen.getByRole("list", { name: "Issues of acme/app" }).parentElement!;
  const dataTransfer = transfer();
  fireEvent.dragStart(card, { dataTransfer });
  expect(card.className).toMatch(/ghosted/);
  // jsdom's drags have no place: in the open.
  fireEvent.dragOver(area, { dataTransfer });
  expect(screen.getByText("Start #31")).toBeTruthy();
  // The browser's image of the row is hidden: the graph draws the card as a node instead.
  expect((dataTransfer.image as HTMLImageElement | null)?.src).toMatch(/^data:image\/gif/);
  const ghost = () => area.querySelector<HTMLElement>('[class*="ghost"]');
  expect(ghost()?.textContent).toBe("#31BacklogRate-limit the API");
  expect(ghost()?.className).toMatch(/moving/);
  expect(ghost()?.getAttribute("aria-hidden")).toBe("true");
  fireEvent.dragLeave(area, { dataTransfer });
  expect(screen.queryByText("Start #31")).toBeNull();
  expect(ghost()).toBeNull();
  // Escape ends the drag where it is: the ghost goes too.
  fireEvent.dragOver(area, { dataTransfer });
  expect(ghost()).not.toBeNull();
  fireEvent.dragEnd(card, { dataTransfer });
  expect(card.className).not.toMatch(/ghosted/);
  expect(ghost()).toBeNull();

  // A waiting node dragged by the pointer: onto the node at the drawing's corner (jsdom puts the
  // drawing at 0, 0), then in the open.
  const node = screen.getByRole("listitem", { name: /^#24 / });
  fireEvent.pointerDown(node, { button: 0, pointerId: 1, clientX: 400, clientY: 400 });
  fireEvent.pointerMove(node, { pointerId: 1, clientX: 20, clientY: 20 });
  expect(screen.getByText(/^Queue #24 after #2[23]$/)).toBeTruthy();
  const target = screen.getAllByRole("listitem").find((n) => n.className.includes("target"));
  expect(target?.getAttribute("aria-label")).toMatch(/^#2[23] /);
  expect(node.className).toMatch(/moving/);
  fireEvent.pointerMove(node, { pointerId: 1, clientX: 5000, clientY: 5000 });
  expect(screen.getByText("Remove #24's wait")).toBeTruthy();
  fireEvent.pointerUp(node, { pointerId: 1, clientX: 5000, clientY: 5000 });
  await waitFor(() => expect(api.bodies()).toEqual([{ action: "dequeue", number: 24 }]));
  expect(screen.queryByText("Remove #24's wait")).toBeNull();
});

test("a card dragged over an empty graph shows there too", async () => {
  const empty = makeState({ tasks: state.tasks.filter((t) => t.repo !== "acme/app") });
  render(<Dashboard state={empty} error={null} />);
  const queue = screen.getByRole("region", { name: "Work queue" });
  const card = (await within(queue).findByText("Rate-limit the API")).closest("li")!;
  const area = screen.getByLabelText("What waits for what");
  expect(within(area).getByText(/No issues here yet/)).toBeTruthy();
  const dataTransfer = transfer();
  fireEvent.dragStart(card, { dataTransfer });
  fireEvent.dragOver(area, { dataTransfer });
  expect(area.querySelector('[class*="ghost"]')?.textContent).toBe("#31BacklogRate-limit the API");
  expect(screen.getByText("Start #31")).toBeTruthy();
  fireEvent.drop(area, { dataTransfer });
  expect(area.querySelector('[class*="ghost"]')).toBeNull();
  await waitFor(() => expect(api.bodies()).toEqual([{ action: "start", number: 31 }]));
});

test("a phone: lanes by default, the queue a sheet with Start and a menu for the rest", async () => {
  phone = true;
  render(<Dashboard state={state} error={null} />);
  expect(views().getByRole("button", { name: "Lanes" }).getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByRole("region", { name: "Lane #22 and 2 more" })).toBeTruthy();
  const sheet = screen.getByRole("region", { name: "Work queue" });
  await within(sheet).findByText("Rate-limit the API");
  // Its first action in reach; the others in its menu.
  fireEvent.click(within(sheet).getByRole("button", { name: "Start #31" }));
  await waitFor(() => expect(api.bodies()).toEqual([{ action: "start", number: 31 }]));
  fireEvent.click(
    await within(sheet).findByRole("button", { name: "More for #29: after…, brainstorm" }),
  );
  const menu = screen.getByRole("dialog", { name: "#29 Setup cache" });
  fireEvent.click(within(menu).getByRole("button", { name: "Brainstorm #29" }));
  await waitFor(() =>
    expect(api.bodies().at(-1)).toEqual({ action: "start", number: 29, mode: "brainstorm" }),
  );
  // The handle folds it to its tabs, and a tab opens it again.
  const handle = within(sheet).getByRole("button", { name: "Collapse the work queue" });
  fireEvent.click(handle);
  expect(handle.getAttribute("aria-expanded")).toBe("false");
  expect(within(sheet).queryByRole("list")).toBeNull();
  fireEvent.click(within(sheet).getByRole("tab", { name: /^Waiting/ }));
  expect(within(sheet).getByRole("list", { name: "Waiting issues" })).toBeTruthy();
  // Start in and Show closed are in the board's options.
  fireEvent.click(screen.getByRole("button", { name: "Board options" }));
  const options = screen.getByRole("dialog", { name: "Board options" });
  expect(within(options).getByRole("combobox", { name: "Start in" })).toBeTruthy();
  expect(within(options).getByRole("switch", { name: "Show closed" })).toBeTruthy();
});

test("lanesOf: each linked group in the order it runs, the rest alone", () => {
  const n = (key: string) => ({ key });
  const edge = (from: string, to: string) => ({ from, to });
  const { lanes, alone } = lanesOf(
    [n("d"), n("c"), n("b"), n("a"), n("x")],
    [edge("a", "b"), edge("b", "c"), edge("a", "d"), edge("d", "a")],
  );
  // A cycle (a, d) still ends: each issue once.
  expect(lanes.map((l) => l.map((m) => m.key).sort())).toEqual([["a", "b", "c", "d"]]);
  expect(alone.map((m) => m.key)).toEqual(["x"]);
  const chain = lanesOf([n("c"), n("b"), n("a")], [edge("a", "b"), edge("b", "c")]);
  expect(chain.lanes[0].map((m) => m.key)).toEqual(["a", "b", "c"]);
});
