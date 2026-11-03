// The run order (listener/order.mjs): the Queued tab of the board's work queue, its buttons
// and drags, the graph's place badges and a queued node dragged onto another one's edge; and
// what takes a queued issue out of the line: Queue after… (a wait instead) and Back to backlog.
import { createEvent, fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { beforeEach, expect, test, vi } from "vitest";
import { Dashboard } from "./App";
import { inLine, moveOnto, stillInLine } from "./graphModel";
import { BACKLOG, makeRuns, makeState, makeTask, mockApi, queueAfter, transfer } from "./testUtils";

// `canWait`: a comment of its starts a run, which can wait for another issue instead.
const queued = (number: number, position: number, extra = {}) =>
  makeTask({
    number,
    title: `Queued ${number}`,
    state: "queued",
    position,
    canWait: true,
    ...extra,
  });

// #44 a brainstorm's reply (it ran before), which starts first; #41 next, then another repo's task (acme/api#9), then
// #42 and #43.
const LINE = [
  queued(44, 1, {
    startsFirst: true,
    kind: "brainstorm",
    mode: "brainstorm",
    canWait: false,
    runs: makeRuns("acme/app#44", 1),
  }),
  queued(41, 2),
  queued(9, 3, { repo: "acme/api", key: "acme/api#9", title: "Elsewhere" }),
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

test("an auto-picked card's meta line leads with its mark, not a word", () => {
  history.replaceState(null, "", "#/acme/app/board");
  const line = [queued(41, 1, { autoPickup: true }), queued(42, 2)];
  render(<Dashboard state={makeState({}, line)} error={null} />);
  fireEvent.click(screen.getByRole("tab", { name: /^Queued/ }));
  const list = screen.getByRole("list", { name: "Tasks waiting for a slot, in run order" });
  const meta = within(list).getByText("1st in line");
  expect(within(meta).getByRole("img", { name: "Auto-pickup" }).getAttribute("title")).toBe(
    "Auto-pickup",
  );
  expect(within(within(list).getByText("2nd in line")).queryByRole("img")).toBeNull();
  expect(within(list).queryByText(/auto-pickup/)).toBeNull();
});

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
  // On its way: in its new place, the line numbered again as the listener will (acme/api#9
  // moves down one too), every button off.
  await waitFor(() => expect(cards(list)).toEqual(["#44", "#43", "#41", "#42"]));
  expect(within(list).getByText("Queued 43").closest("li")!.textContent).toMatch(/2nd in line/);
  expect(within(list).getByText("Queued 41").closest("li")!.textContent).toMatch(/3rd in line/);
  expect(within(list).getByText("Queued 42").closest("li")!.textContent).toMatch(/5th in line/);
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

test("Back to backlog and Queue after… send cancel and queue; the card leaves the line at once", async () => {
  const list = open();
  const release = api.hold();
  fireEvent.click(within(list).getByRole("button", { name: /^Take #42 out of the queue/ }));
  expect(api.bodies()).toEqual([{ action: "cancel", number: 42 }]);
  // On its way: out of the line already.
  await waitFor(() => expect(cards(list)).toEqual(["#44", "#41", "#43"]));
  release();
  await waitFor(() => expect(cards(list)).toEqual(["#44", "#41", "#42", "#43"]));
  fireEvent.click(within(list).getByRole("button", { name: "Queue #41 after…" }));
  queueAfter(41, 42);
  await waitFor(() =>
    expect(api.bodies().at(-1)).toEqual({ action: "queue", number: 41, after: 42 }),
  );
  // Neither for a reply to a brainstorm going on, nor a pull request's task.
  for (const ref of ["#44", "#43"]) {
    expect(within(list).queryByRole("button", { name: `Queue ${ref} after…` })).toBeNull();
    expect(within(list).queryByRole("button", { name: new RegExp(`^Take ${ref} out`) })).toBeNull();
  }
});

test("a brainstorm queued to start (no run yet) can go back to the backlog, or wait", async () => {
  history.replaceState(null, "", "#/acme/app/board");
  // `/mode brainstorm` on a backlog issue while every slot is busy.
  const start = queued(46, 1, { startsFirst: true, kind: "brainstorm", mode: "brainstorm" });
  render(<Dashboard state={makeState({}, [start, queued(41, 2)])} error={null} />);
  fireEvent.click(screen.getByRole("tab", { name: /^Queued/ }));
  const list = screen.getByRole("list", { name: "Tasks waiting for a slot, in run order" });
  const card = within(list).getByText("Queued 46").closest("li")!;
  expect(within(card).queryByRole("button", { name: "Run #46 next" })).toBeNull();
  expect(within(card).getByRole("button", { name: "Queue #46 after…" })).toBeTruthy();
  const data = transfer();
  fireEvent.dragStart(card, { dataTransfer: data });
  const tab = screen.getByRole("tab", { name: /^Backlog/ });
  fireEvent.dragOver(tab, { dataTransfer: data });
  fireEvent.drop(tab, { dataTransfer: data });
  await waitFor(() => expect(api.bodies()).toEqual([{ action: "cancel", number: 46 }]));
  fireEvent.dragEnd(card);
});

test("a queued task with replies to its last run only: Back to backlog, but no Queue after", async () => {
  history.replaceState(null, "", "#/acme/app/board");
  render(
    <Dashboard
      state={makeState({}, [queued(41, 1, { canWait: false }), queued(42, 2)])}
      error={null}
    />,
  );
  fireEvent.click(screen.getByRole("tab", { name: /^Queued/ }));
  expect(screen.queryByRole("button", { name: "Queue #41 after…" })).toBeNull();
  expect(screen.getByRole("button", { name: /^Take #41 out of the queue/ })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Queue #42 after…" })).toBeTruthy();
  // On the graph, let go on another node's middle: no label, nothing sent.
  const from = screen.getByRole("listitem", { name: /^#41 Queued 41:/ });
  const start = boxOf(from);
  const target = boxOf(screen.getByRole("listitem", { name: /^#42 Queued 42:/ }));
  const middle = { clientX: target.x + target.w / 2, clientY: target.y + target.h / 2 };
  fireEvent.pointerDown(from, {
    button: 0,
    pointerId: 1,
    clientX: start.x + 5,
    clientY: start.y + 5,
  });
  fireEvent.pointerMove(from, { pointerId: 1, ...middle });
  expect(screen.queryByText(/^Queue #41 after/)).toBeNull();
  fireEvent.pointerUp(from, { pointerId: 1, ...middle });
  expect(api.bodies()).toEqual([]);
});

test("a queued issue that starts first (a mode apart from work's) can leave the line, not move in it", async () => {
  history.replaceState(null, "", "#/acme/app/board");
  // An analyze run on #45: kind "issue", before the work runs.
  const first = queued(45, 1, { startsFirst: true, mode: "analyze" });
  render(<Dashboard state={makeState({}, [first, queued(41, 2), queued(42, 3)])} error={null} />);
  fireEvent.click(screen.getByRole("tab", { name: /^Queued/ }));
  const list = screen.getByRole("list", { name: "Tasks waiting for a slot, in run order" });
  const card = () => within(list).getByText("Queued 45").closest("li")!;
  expect(within(card()).queryByRole("button", { name: "Run #45 next" })).toBeNull();
  expect(within(card()).queryByRole("button", { name: "Move #45 down" })).toBeNull();
  expect(within(card()).getByRole("button", { name: "Queue #45 after…" })).toBeTruthy();
  // Dropped on another card: it doesn't move in line.
  const data = transfer();
  fireEvent.dragStart(card(), { dataTransfer: data });
  const other = within(list).getByText("Queued 42").closest("li")!;
  fireEvent.dragOver(other, { dataTransfer: data, clientY: 10 });
  fireEvent.drop(other, { dataTransfer: data, clientY: 10 });
  fireEvent.dragEnd(card());
  expect(api.bodies()).toEqual([]);
  // On the graph, onto another queued node's edge: queued after it, not moved in line.
  const from = screen.getByRole("listitem", { name: /^#45 Queued 45:/ });
  const start = boxOf(from);
  const target = boxOf(screen.getByRole("listitem", { name: /^#42 Queued 42:/ }));
  const edge = { clientX: target.x + target.w * 0.9, clientY: target.y + target.h / 2 };
  fireEvent.pointerDown(from, {
    button: 0,
    pointerId: 1,
    clientX: start.x + 5,
    clientY: start.y + 5,
  });
  fireEvent.pointerMove(from, { pointerId: 1, ...edge });
  expect(screen.getByText("Queue #45 after #42: it leaves the line")).toBeTruthy();
  fireEvent.pointerUp(from, { pointerId: 1, ...edge });
  await waitFor(() => expect(api.bodies()).toEqual([{ action: "queue", number: 45, after: 42 }]));
  // Answered (the fake listener's state doesn't change): back in line. On the Backlog tab, it
  // goes back to the backlog.
  const take = /^Take #45 out of the queue/;
  await waitFor(() =>
    expect(within(list).getByRole<HTMLButtonElement>("button", { name: take }).disabled).toBe(
      false,
    ),
  );
  const again = transfer();
  fireEvent.dragStart(card(), { dataTransfer: again });
  const tab = screen.getByRole("tab", { name: /^Backlog/ });
  fireEvent.dragOver(tab, { dataTransfer: again });
  fireEvent.drop(tab, { dataTransfer: again });
  await waitFor(() => expect(api.bodies().at(-1)).toEqual({ action: "cancel", number: 45 }));
});

test("a Queued card dropped on the Backlog tab goes back to the backlog", async () => {
  const list = open();
  const card = within(list).getByText("Queued 41").closest("li")!;
  const data = transfer();
  fireEvent.dragStart(card, { dataTransfer: data });
  const tab = screen.getByRole("tab", { name: /^Backlog/ });
  fireEvent.dragOver(tab, { dataTransfer: data });
  fireEvent.drop(tab, { dataTransfer: data });
  await waitFor(() => expect(api.bodies()).toEqual([{ action: "cancel", number: 41 }]));
  // A pull request's task doesn't drag there: nothing.
  fireEvent.drop(tab, {
    dataTransfer: transfer({ "application/x-deckhand-queued": "acme/app#pr-43" }),
  });
  expect(api.bodies()).toHaveLength(1);
});

test("stillInLine: an action on its way that takes a task out of the queue", () => {
  const { line } = inLine(LINE, null);
  const keys = (pending: Parameters<typeof stillInLine>[1]) =>
    stillInLine(line, pending).map((t) => t.key);
  const p = { repo: "acme/app", title: null };
  expect(keys([{ ...p, action: "cancel", number: 41 }])).not.toContain("acme/app#41");
  expect(keys([{ ...p, action: "queue", number: 42, after: 7 }])).not.toContain("acme/app#42");
  expect(keys([{ ...p, action: "start", number: 41 }])).toContain("acme/app#41");
});

test("on a phone: Run next, Move up and Move down on each card, 44 px", () => {
  const list = open(true);
  const item = within(list).getByText("Queued 42").closest("li")!;
  for (const name of ["Run #42 next", "Move #42 up", "Move #42 down"]) {
    expect(within(item).getByRole("button", { name }).className).toMatch(/touch/);
  }
  // Queue after… and Back to backlog in its menu.
  fireEvent.click(within(item).getByRole("button", { name: /^More for #42/ }));
  const menu = screen.getByRole("dialog");
  expect(within(menu).getByRole("button", { name: "Queue #42 after…" })).toBeTruthy();
  fireEvent.click(within(menu).getByRole("button", { name: /^Take #42 out of the queue/ }));
  expect(api.bodies()).toEqual([{ action: "cancel", number: 42 }]);
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

test("inLine: a move on its way, the whole line numbered again as the listener moves it", () => {
  const numbers = (moving: Parameters<typeof inLine>[1]) =>
    inLine(LINE, moving).line.map((t) => [t.number, t.position]);
  // Last: behind every repo's tasks.
  expect(numbers({ key: "acme/app#41", before: null })).toEqual([
    [44, 1],
    [9, 2],
    [42, 3],
    [43, 4],
    [41, 5],
  ]);
  expect(inLine(LINE, { key: "acme/app#41" }).tasks.find((t) => t.number === 41)?.position).toBe(5);
  // Down one, right after #42: acme/api#9 comes up to 2nd, as order.mjs writes it.
  expect(numbers({ key: "acme/app#41", after: "acme/app#42" })).toEqual([
    [44, 1],
    [9, 2],
    [42, 3],
    [41, 4],
    [43, 5],
  ]);
  // Up one, right before #42: past acme/api#9.
  expect(numbers({ key: "acme/app#pr-43", before: "acme/app#42" })).toEqual([
    [44, 1],
    [41, 2],
    [9, 3],
    [43, 4],
    [42, 5],
  ]);
  // Run next: ahead of every repo's work runs, after the brainstorms.
  expect(numbers({ key: "acme/app#42", first: true })).toEqual([
    [44, 1],
    [42, 2],
    [41, 3],
    [9, 4],
    [43, 5],
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
  // Where it is already: right before the next, right after the one before it.
  expect(moveOnto(line, "acme/app#42", "acme/app#pr-43", 0.1)).toBeNull();
  expect(moveOnto(line, "acme/app#pr-43", "acme/app#42", 0.9)).toBeNull();
  // Another repo's task between: a move all the same, which it jumps.
  expect(moveOnto(line, "acme/app#41", "acme/app#42", 0.1)).toEqual({
    key: "acme/app#41",
    before: "acme/app#42",
  });
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

// Where a node is drawn (its transform, in drawing units) and its size: jsdom puts the drawing
// at 0, 0, so the pointer's place is these plus the drawing's padding.
const PAD = 8;
const boxOf = (node: HTMLElement) => {
  const [x, y] = /translate\(([-\d.]+)px, ([-\d.]+)px\)/
    .exec(node.style.transform)!
    .slice(1)
    .map(Number);
  return {
    x: x + PAD,
    y: y + PAD,
    w: parseFloat(node.style.width),
    h: parseFloat(node.style.height),
  };
};

test("on the graph: a queued node onto another's right edge goes after it; the open, nothing", async () => {
  open();
  const node = (n: number) =>
    screen.getByRole("listitem", { name: new RegExp(`^#${n} Queued ${n}:`) });
  const from = node(41);
  const start = boxOf(from);
  const drag = (to: { x: number; y: number }) => {
    fireEvent.pointerDown(from, {
      button: 0,
      pointerId: 1,
      clientX: start.x + 5,
      clientY: start.y + 5,
    });
    fireEvent.pointerMove(from, { pointerId: 1, clientX: to.x, clientY: to.y });
  };
  const target = boxOf(node(42));
  const at = (side: number) => ({ x: target.x + target.w * side, y: target.y + target.h / 2 });

  // In the open: nothing.
  drag({ x: 5000, y: 5000 });
  fireEvent.pointerUp(from, { pointerId: 1, clientX: 5000, clientY: 5000 });
  // #42 onto PR #43's left edge: right before it, where #42 is already.
  const second = node(42);
  const s0 = boxOf(second);
  const pr = boxOf(screen.getByRole("listitem", { name: /^PR #43 Queued 43:/ }));
  const edge = { clientX: pr.x + pr.w * 0.1, clientY: pr.y + pr.h / 2 };
  fireEvent.pointerDown(second, { button: 0, pointerId: 3, clientX: s0.x + 5, clientY: s0.y + 5 });
  fireEvent.pointerMove(second, { pointerId: 3, ...edge });
  expect(screen.queryByText(/^Move #/)).toBeNull();
  fireEvent.pointerUp(second, { pointerId: 3, ...edge });
  expect(api.bodies()).toEqual([]);

  // Its middle: queued after it, out of the line, as the label says.
  drag(at(0.5));
  expect(screen.getByText("Queue #41 after #42: it leaves the line")).toBeTruthy();
  fireEvent.pointerUp(from, { pointerId: 1, clientX: at(0.5).x, clientY: at(0.5).y });
  await waitFor(() => expect(api.bodies()).toEqual([{ action: "queue", number: 41, after: 42 }]));
  // Answered: the fake listener's state doesn't change, #41 is back in line.
  await screen.findByRole("listitem", { name: /^#41 Queued 41: Queued/ });
  api.posted.length = 0;

  // Its right edge: after it.
  drag(at(0.9));
  expect(screen.getByText("Move #41 after #42 in line")).toBeTruthy();
  const release = api.hold();
  fireEvent.pointerUp(from, { pointerId: 1, clientX: at(0.9).x, clientY: at(0.9).y });
  await waitFor(() => expect(api.bodies()).toEqual([{ key: "acme/app#41", after: "acme/app#42" }]));
  // Another drag while that move is on its way (#42 then #41, shown at once): #42 onto #41's
  // right edge would move it, but nothing is sent meanwhile.
  const other = node(42);
  const o = boxOf(other);
  const right = { x: start.x + start.w * 0.9, y: start.y + start.h / 2 };
  fireEvent.pointerDown(other, { button: 0, pointerId: 2, clientX: o.x + 5, clientY: o.y + 5 });
  fireEvent.pointerMove(other, { pointerId: 2, clientX: right.x, clientY: right.y });
  expect(screen.queryByText(/^Move #/)).toBeNull();
  fireEvent.pointerUp(other, { pointerId: 2, clientX: right.x, clientY: right.y });
  release();
  await waitFor(() => expect(api.bodies()).toHaveLength(1));
});

test("a Queued card dragged onto a graph node's middle queues after it; onto its edge, it moves in line", async () => {
  const list = open();
  const card = within(list).getByText("Queued 41").closest("li")!;
  const target = boxOf(screen.getByRole("listitem", { name: /^#42 Queued 42:/ }));
  const area = screen.getByRole("list", { name: "Issues of acme/app" }).parentElement!;
  const data = transfer();
  // jsdom's drag events have no pointer position: given here.
  const at = (kind: "dragOver" | "drop", side: number) => {
    const e = createEvent[kind](area, { dataTransfer: data });
    Object.defineProperty(e, "clientX", { value: target.x + target.w * side });
    Object.defineProperty(e, "clientY", { value: target.y + target.h / 2 });
    fireEvent(area, e);
  };
  fireEvent.dragStart(card, { dataTransfer: data });
  at("dragOver", 0.5);
  expect(screen.getByText("Queue #41 after #42: it leaves the line")).toBeTruthy();
  at("dragOver", 0.9);
  expect(screen.getByText("Move #41 after #42 in line")).toBeTruthy();
  at("drop", 0.5);
  await waitFor(() => expect(api.bodies()).toEqual([{ action: "queue", number: 41, after: 42 }]));
  fireEvent.dragEnd(card);
});
