// The run order (listener/order.mjs): the Queued tab of the board's work queue, its buttons
// and drags, the graph's place badges and a queued node dragged onto another one's edge.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { beforeEach, expect, test, vi } from "vitest";
import { Dashboard } from "./App";
import { inLine, moveOnto } from "./graphModel";
import { BACKLOG, makeState, makeTask, mockApi, transfer } from "./testUtils";

const queued = (number: number, position: number, extra = {}) =>
  makeTask({ number, title: `Queued ${number}`, state: "queued", position, ...extra });

// #41 next, then another repo's task, then #42 and #43; #44 a brainstorm, which starts first
// but is listed after them here to see it stays put.
const LINE = [
  queued(44, 1, { startsFirst: true, kind: "brainstorm", mode: "brainstorm" }),
  queued(41, 2),
  queued(42, 4),
  queued(43, 5, { kind: "pr", key: "acme/app#pr-43" }),
];

let api: ReturnType<typeof mockApi>;
beforeEach(() => {
  api = mockApi({
    "api/repos/acme/app/issues": () => BACKLOG,
    "POST api/repos/acme/app/order": ({ body }) =>
      body.key === "acme/app#42" && body.first
        ? Response.json({ error: "#42 isn't waiting for a slot." }, { status: 409 })
        : { message: "moved" },
  });
});

const open = (narrow = false) => {
  history.replaceState(null, "", "#/acme/app/board");
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("min-width") ? !narrow : false,
    addEventListener() {},
    removeEventListener() {},
  }));
  render(<Dashboard state={makeState({}, LINE)} error={null} />);
  fireEvent.click(screen.getByRole("tab", { name: /^Queued/ }));
  return screen.getByRole("list", { name: "Tasks waiting for a slot, in run order" });
};

const cards = (list: HTMLElement) =>
  within(list)
    .getAllByRole("listitem")
    .map((li) => li.querySelector("[class*=ref]")?.textContent);

test("the Queued tab lists the repo's queued tasks in run order, with their place", () => {
  const list = open();
  expect(cards(list)).toEqual(["#44", "#41", "#42", "#43"]);
  expect(within(list).getByText("1st in line · brainstorm · starts first")).toBeTruthy();
  expect(within(list).getByText("4th in line")).toBeTruthy();
  // A brainstorm doesn't move; the first work run can't go any higher.
  expect(within(list).queryByRole("button", { name: "Run #44 next" })).toBeNull();
  expect(
    within(list).getByRole<HTMLButtonElement>("button", { name: "Run #41 next" }).disabled,
  ).toBe(true);
  expect(
    within(list).getByRole<HTMLButtonElement>("button", { name: "Move #41 up" }).disabled,
  ).toBe(true);
  expect(
    within(list).getByRole<HTMLButtonElement>("button", { name: "Move #43 down" }).disabled,
  ).toBe(true);
  // Its pull request's link.
  expect(within(list).getByText("Queued 43").closest("a")?.getAttribute("href")).toMatch(
    /\/pull\/43$/,
  );
});

test("Run next, Move up and Move down send the move, which shows at once", async () => {
  const list = open();
  const release = api.hold();
  fireEvent.click(within(list).getByRole("button", { name: "Run #43 next" }));
  expect(api.bodies()).toEqual([{ key: "acme/app#pr-43", first: true }]);
  // On its way: in its new place, the places dealt out again, every button off.
  await waitFor(() => expect(cards(list)).toEqual(["#44", "#43", "#41", "#42"]));
  expect(within(list).getByText("Queued 43").closest("li")!.textContent).toMatch(/2nd in line/);
  expect(
    within(list).getByRole<HTMLButtonElement>("button", { name: "Move #42 up" }).disabled,
  ).toBe(true);
  release();
  // The fake listener's state doesn't change: back where it was once answered.
  await waitFor(() => expect(cards(list)).toEqual(["#44", "#41", "#42", "#43"]));
  fireEvent.click(within(list).getByRole("button", { name: "Move #43 up" }));
  await waitFor(() =>
    expect(
      within(list).getByRole<HTMLButtonElement>("button", { name: "Move #41 down" }).disabled,
    ).toBe(false),
  );
  // Down one: right after the next of the repo's, not to the end of every repo's line.
  fireEvent.click(within(list).getByRole("button", { name: "Move #42 down" }));
  await waitFor(() =>
    expect(api.bodies().slice(1)).toEqual([
      { key: "acme/app#pr-43", before: "acme/app#42" },
      { key: "acme/app#42", after: "acme/app#pr-43" },
    ]),
  );
});

test("a refusal shows as the listener says it", async () => {
  const list = open();
  fireEvent.click(within(list).getByRole("button", { name: "Run #42 next" }));
  expect(await screen.findByText("#42 isn't waiting for a slot.")).toBeTruthy();
});

test("a card dragged onto the bottom half of another goes after it, the top half before it", async () => {
  const list = open();
  const card = (n: string) => within(list).getByText(`Queued ${n}`).closest("li")!;
  const data = transfer();
  fireEvent.dragStart(card("41"), { dataTransfer: data });
  // jsdom's boxes are empty: any point is at or below the middle.
  fireEvent.dragOver(card("43"), { dataTransfer: data, clientY: 10 });
  fireEvent.drop(card("43"), { dataTransfer: data, clientY: 10 });
  await waitFor(() =>
    expect(api.bodies()).toEqual([{ key: "acme/app#41", after: "acme/app#pr-43" }]),
  );
  // Onto the brainstorm: nothing.
  fireEvent.dragStart(card("42"), { dataTransfer: transfer() });
  fireEvent.drop(card("44"), {
    dataTransfer: transfer({ "application/x-deckhand-queued": "acme/app#42" }),
  });
  expect(api.bodies()).toHaveLength(1);
});

test("on a phone: Run next, Move up and Move down on each card, 44 px", () => {
  const list = open(true);
  const item = within(list).getByText("Queued 42").closest("li")!;
  for (const name of ["Run #42 next", "Move #42 up", "Move #42 down"]) {
    expect(within(item).getByRole("button", { name }).className).toMatch(/touch/);
  }
});

test("Run next is off for the first work run of every repo shown, another's brainstorm before it", () => {
  history.replaceState(null, "", "#/acme/app/board");
  // acme/api's brainstorm is 1st, acme/app's first work run 2nd: nothing to pass.
  const other = queued(7, 1, { repo: "acme/api", key: "acme/api#7", startsFirst: true });
  render(<Dashboard state={makeState({}, [other, queued(41, 2), queued(42, 4)])} error={null} />);
  fireEvent.click(screen.getByRole("tab", { name: /^Queued/ }));
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Run #41 next" }).disabled).toBe(
    true,
  );
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Run #42 next" }).disabled).toBe(
    false,
  );
});

test("Run next is on when another repo's work run is before the first of this one's", () => {
  history.replaceState(null, "", "#/acme/app/board");
  const other = queued(7, 1, { repo: "acme/api", key: "acme/api#7" });
  render(<Dashboard state={makeState({}, [other, queued(41, 2)])} error={null} />);
  fireEvent.click(screen.getByRole("tab", { name: /^Queued/ }));
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Run #41 next" }).disabled).toBe(
    false,
  );
});

test("inLine: a move on its way, the repo's places dealt out again", () => {
  const { line, tasks } = inLine(LINE, { key: "acme/app#41", before: null });
  expect(line.map((t) => [t.number, t.position])).toEqual([
    [44, 1],
    [42, 2],
    [43, 4],
    [41, 5],
  ]);
  expect(tasks.find((t) => t.number === 41)?.position).toBe(5);
  // Right after another: the places of the repo's tasks dealt out again.
  expect(
    inLine(LINE, { key: "acme/app#41", after: "acme/app#42" }).line.map((t) => [
      t.number,
      t.position,
    ]),
  ).toEqual([
    [44, 1],
    [42, 2],
    [41, 4],
    [43, 5],
  ]);
  // Run next goes after the brainstorms.
  expect(inLine(LINE, { key: "acme/app#42", first: true }).line.map((t) => t.number)).toEqual([
    44, 42, 41, 43,
  ]);
});

test("moveOnto: a queued node's left edge before it, its right edge after it, its middle nothing", () => {
  const { line } = inLine(LINE, null);
  expect(moveOnto(line, "acme/app#pr-43", "acme/app#41", 0.1)).toEqual({
    key: "acme/app#pr-43",
    before: "acme/app#41",
  });
  expect(moveOnto(line, "acme/app#41", "acme/app#pr-43", 0.9)).toEqual({
    key: "acme/app#41",
    after: "acme/app#pr-43",
  });
  expect(moveOnto(line, "acme/app#41", "acme/app#42", 0.5)).toBeNull();
  // Not onto a brainstorm, nor itself.
  expect(moveOnto(line, "acme/app#41", "acme/app#44", 0.1)).toBeNull();
  expect(moveOnto(line, "acme/app#41", "acme/app#41", 0.1)).toBeNull();
});

test("the graph's queued nodes show their place", async () => {
  history.replaceState(null, "", "#/acme/app/board");
  render(<Dashboard state={makeState({}, LINE)} error={null} />);
  const node = await screen.findByRole("listitem", { name: /^#41 Queued 41: Queued, 2nd in line/ });
  expect(within(node).getByText("2nd")).toBeTruthy();
});
