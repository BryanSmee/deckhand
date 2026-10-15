import { expect, test } from "vitest";
import { dropTarget, graphOf, issueOfLink, layout, lookOf, type Pending, SIZES } from "./graph";
import type { Task, WorkAction } from "./types";

const task = (n: number, extra: Partial<Task> = {}): Task => ({
  key: `org/app#${n}`,
  repo: "org/app",
  project: "org",
  number: n,
  title: `Issue ${n}`,
  kind: "issue",
  mode: "work",
  replyTo: n,
  state: "done",
  since: 0,
  closed: null,
  pr: null,
  rerunnable: false,
  runs: [],
  ...extra,
});
const after = (from: number, to: number) => ({
  from: `org/app#${from}`,
  to: `org/app#${to}`,
  kind: "after" as const,
});
const at = (l: ReturnType<typeof layout>, n: number) =>
  l.boxes.find((b) => b.key === `org/app#${n}`)!;
const wide = { narrow: false };
const phone = { narrow: true };
const { w, h, layerGap } = SIZES.wide;

test("a chain: each issue a column to the right of the one it waits for", () => {
  const keys = [3, 2, 1].map((n) => `org/app#${n}`);
  const l = layout(keys, [after(1, 2), after(2, 3)], wide);
  expect([1, 2, 3].map((n) => at(l, n))).toEqual([
    { key: "org/app#1", x: 0, y: 0 },
    { key: "org/app#2", x: w + layerGap, y: 0 },
    { key: "org/app#3", x: 2 * (w + layerGap), y: 0 },
  ]);
  expect(l.gridTop).toBe(null);
  // An elbow from #1's right side to #2's left side.
  expect(l.arrows[0]).toEqual({
    from: "org/app#1",
    to: "org/app#2",
    d: `M${w} ${h / 2}H${w + layerGap / 2}V${h / 2}H${w + layerGap}`,
  });

  // On a phone too, left to right with the arrows across: wider than 390 px, it scrolls.
  const small = layout(keys, [after(1, 2), after(2, 3)], phone);
  const n = SIZES.narrow;
  expect([1, 2, 3].map((k) => at(small, k))).toEqual([
    { key: "org/app#1", x: 0, y: 0 },
    { key: "org/app#2", x: n.w + n.layerGap, y: 0 },
    { key: "org/app#3", x: 2 * (n.w + n.layerGap), y: 0 },
  ]);
  expect(small.width).toBeGreaterThan(390);
  expect(small.arrows[0].d).toBe(
    `M${n.w} ${n.h / 2}H${n.w + n.layerGap / 2}V${n.h / 2}H${n.w + n.layerGap}`,
  );
  // A two-step chain still fits a 390 px phone: the work area leaves its drawing 324 px.
  expect(layout(keys.slice(1), [after(1, 2)], phone).width).toBeLessThanOrEqual(324);
});

test("a task with two blockers: both in the column before it", () => {
  const l = layout(
    ["org/app#24", "org/app#23", "org/app#22"],
    [after(23, 24), after(22, 24)],
    wide,
  );
  expect(at(l, 23).x).toBe(0);
  expect(at(l, 22).x).toBe(0);
  expect(at(l, 23).y).not.toBe(at(l, 22).y);
  expect(at(l, 24).x).toBe(w + layerGap);
  expect(l.arrows).toHaveLength(2);
});

test("a blocker that failed: red, and what waits for it keeps waiting", () => {
  const tasks = [
    task(2, { state: "waiting", waitingFor: [1] }),
    task(1, { state: "error" }),
    task(3, { state: "waiting", waitingFor: [2] }),
  ];
  const { nodes, edges } = graphOf(tasks, [after(1, 2), after(2, 3)], []);
  expect(nodes.map((n) => [n.number, n.look, n.status])).toEqual([
    [2, "idle", "Waiting"],
    [1, "err", "Error"],
    [3, "idle", "Waiting"],
  ]);
  const l = layout(
    nodes.map((n) => n.key),
    edges,
    wide,
  );
  expect([1, 2, 3].map((n) => at(l, n).x)).toEqual([0, w + layerGap, 2 * (w + layerGap)]);
});

test("no relations at all: one column, top to bottom in the board's order", () => {
  const keys = [5, 4, 3, 2, 1].map((n) => `org/app#${n}`);
  const l = layout(keys, [], wide);
  expect(l.gridTop).toBe(0);
  expect(l.arrows).toEqual([]);
  expect(l.boxes).toEqual(keys.map((key, i) => ({ key, x: 0, y: i * (h + 16) })));
  // The same on a phone.
  const small = layout(keys, [], phone);
  expect(small.boxes.map((b) => b.x)).toEqual([0, 0, 0, 0, 0]);
  expect(small.boxes.map((b) => b.y)).toEqual(keys.map((_, i) => i * (h + 12)));
  // Below the linked issues when there are some.
  const mixed = layout(keys, [after(1, 2)], wide);
  expect(mixed.gridTop).toBeGreaterThan(h);
  expect(at(mixed, 5).y).toBe(mixed.gridTop);
});

test("issues waiting for each other still get a place each", () => {
  const l = layout(["org/app#1", "org/app#2"], [after(1, 2), after(2, 1)], wide);
  expect(l.boxes).toHaveLength(2);
  expect(at(l, 1).x).not.toBe(at(l, 2).x);
});

test("the looks: implemented is green, not a run that ended done", () => {
  expect(lookOf(task(1))).toBe("idle");
  expect(lookOf(task(1, { closed: "completed" }))).toBe("done");
  const pr = (state: "draft" | "ready" | "merged") => ({
    number: 2,
    url: "",
    state,
    readyAt: null,
  });
  expect(lookOf(task(1, { pr: pr("merged") }))).toBe("done");
  expect(lookOf(task(1, { pr: pr("ready") }))).toBe("ready");
  expect(lookOf(task(1, { pr: pr("draft") }))).toBe("idle");
  expect(lookOf(task(1, { state: "needs-input" }))).toBe("input");
  expect(lookOf(task(1, { state: "idle-brainstorm" }))).toBe("input");
  expect(lookOf(task(1, { state: "working", closed: "completed" }))).toBe("run");
  expect(lookOf(task(1, { state: "interrupted" }))).toBe("err");
  expect(lookOf(task(1, { state: "queued" }))).toBe("idle");
});

test("the issues tasks wait for are nodes too, even off the board", () => {
  const blocker = { key: "org/app#9", repo: "org/app", number: 9, title: "Old", closed: null };
  const { nodes, edges } = graphOf(
    [task(10, { state: "waiting" })],
    [after(9, 10), after(10, 11)],
    [blocker],
  );
  expect(nodes.map((n) => [n.key, n.title, n.task?.key ?? null])).toEqual([
    ["org/app#10", "Issue 10", "org/app#10"],
    ["org/app#9", "Old", null],
  ]);
  // Arrows into tasks of another tab aren't drawn.
  expect(edges).toHaveLength(1);
});

test("closed issues are hidden, with their arrows, unless shown", () => {
  const pr = { number: 9, url: "", state: "merged" as const, readyAt: null };
  const tasks = [
    task(1, { closed: "completed" }),
    task(2, { state: "waiting", waitingFor: [1] }),
    task(3, { pr }),
    task(4, { closed: "not_planned" }),
    task(5),
  ];
  const edges = [after(1, 2)];
  const { nodes, edges: drawn, hidden } = graphOf(tasks, edges, []);
  expect(nodes.map((n) => n.number)).toEqual([2, 5]);
  expect(drawn).toEqual([]);
  expect(hidden).toBe(3);
  // #2 no longer waits for anything: it goes in the grid.
  const l = layout(
    nodes.map((n) => n.key),
    drawn,
    wide,
  );
  expect(l.gridTop).toBe(0);

  const all = graphOf(tasks, edges, [], { showClosed: true });
  expect(all.nodes.map((n) => n.number)).toEqual([1, 2, 3, 4, 5]);
  expect(all.edges).toEqual(edges);
  expect(all.hidden).toBe(0);
});

test("a closed issue stays while an issue that waited for it runs", () => {
  const tasks = [task(2, { state: "working", waitingFor: [1] }), task(3, { state: "waiting" })];
  const blockers = [
    { key: "org/app#1", repo: "org/app", number: 1, title: "Done", closed: "completed" as const },
    { key: "org/app#4", repo: "org/app", number: 4, title: "Gone", closed: "completed" as const },
  ];
  const { nodes, edges } = graphOf(tasks, [after(1, 2), after(4, 3)], blockers);
  expect(nodes.map((n) => n.number)).toEqual([2, 3, 1]);
  expect(edges).toEqual([after(1, 2)]);
  // A run on a closed issue is still a run.
  const running = graphOf([task(5, { state: "working", closed: "not_planned" })], [], []);
  expect(running.nodes).toHaveLength(1);
});

test("inbox runs and discussions are never nodes", () => {
  const tasks = [
    task(1, { kind: "idea" }),
    task(2, { kind: "bug" }),
    task(3, { kind: "discussion" }),
    task(4, { kind: "brainstorm" }),
    task(5, { kind: "pr" }),
  ];
  for (const showClosed of [false, true]) {
    const { nodes, hidden } = graphOf(tasks, [], [], { showClosed });
    expect(nodes.map((n) => n.number)).toEqual([4, 5]);
    expect(hidden).toBe(0);
  }
});

test("pending actions: drawn as done already, their nodes Sending…", () => {
  const tasks = [
    task(1, { state: "working" }),
    task(2, { state: "waiting", waitingFor: [1] }),
    task(3, { state: "waiting", waitingFor: [1] }),
  ];
  const edges = [after(1, 2), after(1, 3)];
  const sent = (p: WorkAction): Pending => ({ repo: "org/app", title: "From the backlog", ...p });
  const look = (g: ReturnType<typeof graphOf>) =>
    g.nodes.map((n) => [n.number, n.look, n.status, n.task?.key ?? null]);

  // Queued from the backlog: a new node with an arrow from what it waits for.
  const queued = graphOf(tasks, edges, [], {
    pending: [sent({ action: "queue", number: 9, after: 2 })],
  });
  expect(look(queued).at(-1)).toEqual([9, "pending", "Sending…", null]);
  expect(queued.nodes.at(-1)!.title).toBe("From the backlog");
  expect(queued.edges).toContainEqual(after(2, 9));

  // Started: a lone node.
  const started = graphOf(tasks, edges, [], { pending: [sent({ action: "start", number: 9 })] });
  expect(look(started).at(-1)).toEqual([9, "pending", "Sending…", null]);
  expect(started.edges).toEqual(edges);

  // A wait moved: its arrow from the new blocker only; the node keeps its task.
  const moved = graphOf(tasks, edges, [], {
    pending: [sent({ action: "queue", number: 3, after: 2 })],
  });
  expect(moved.edges).toEqual([after(1, 2), after(2, 3)]);
  expect(look(moved)[2]).toEqual([3, "pending", "Sending…", "org/app#3"]);

  // Dequeued: a wait with no run before leaves; one that ran stays, without its arrows.
  const dequeued = graphOf(tasks, edges, [], { pending: [sent({ action: "dequeue", number: 3 })] });
  expect(dequeued.nodes.map((n) => n.number)).toEqual([1, 2]);
  expect(dequeued.edges).toEqual([after(1, 2)]);
  const ran = [...tasks.slice(0, 2), task(3, { ...tasks[2], runs: [{} as Task["runs"][0]] })];
  const kept = graphOf(ran, edges, [], { pending: [sent({ action: "dequeue", number: 3 })] });
  expect(look(kept)[2]).toEqual([3, "pending", "Sending…", "org/app#3"]);
  expect(kept.edges).toEqual([after(1, 2)]);
});

test("the last drawing's places are kept: a new issue moves no other", () => {
  const keys = [1, 2, 3, 4, 5].map((n) => `org/app#${n}`);
  const edges = [after(1, 2), after(3, 4)];
  const before = layout(keys, edges, wide);
  // Nothing to keep (the drawing before the state came): laid out afresh.
  expect(layout(keys, edges, wide, { boxes: [], gridTop: null })).toEqual(before);
  // #6 queued after #1: next to it, #1's group grows, yet the rest stays where it was.
  const grown = layout([`org/app#6`, ...keys], [...edges, after(1, 6)], wide, before);
  for (const n of [1, 2, 3, 4, 5]) expect(at(grown, n)).toEqual(at(before, n));
  expect(at(grown, 6).x).toBe(at(before, 2).x);
  expect(at(grown, 6).y).not.toBe(at(before, 2).y);
  // No two issues on the same place.
  const clash = grown.boxes.some((a) =>
    grown.boxes.some((b) => a !== b && Math.abs(a.x - b.x) < w && Math.abs(a.y - b.y) < h),
  );
  expect(clash).toBe(false);
  // Without the last drawing, groups are packed again: #3's moves down.
  expect(at(layout([`org/app#6`, ...keys], [...edges, after(1, 6)], wide), 3).y).toBeGreaterThan(
    at(before, 3).y,
  );

  // Started: the next free row of the column; one leaving leaves its row empty.
  const started = layout([...keys, "org/app#7"], edges, wide, before);
  expect(at(started, 7).x).toBe(0);
  expect(at(started, 7).y).toBe(at(before, 5).y + h + 16);
  const filled = layout(
    ["org/app#7", "org/app#1", "org/app#2", "org/app#3", "org/app#4"],
    edges,
    wide,
    before,
  );
  expect(at(filled, 7)).toEqual({ ...at(before, 5), key: "org/app#7" });
  const gone = layout(["org/app#1", "org/app#2", "org/app#5"], [after(1, 2)], wide, before);
  expect(at(gone, 5)).toEqual(at(before, 5));
});

test("a kept place that no longer fits moves: after what it now waits for", () => {
  const keys = ["org/app#1", "org/app#2", "org/app#3"];
  const before = layout(keys, [after(1, 2)], wide);
  // #1 now waits for #3, from the column of the others: #1 can't stay in the first column, so it, and #2
  // after it, move right of #3.
  const l = layout(keys, [after(1, 2), after(3, 1)], wide, before);
  expect(at(l, 3)).toEqual(at(before, 3));
  expect(at(l, 1).x).toBeGreaterThanOrEqual(at(l, 3).x + w + layerGap);
  expect(at(l, 2).x).toBeGreaterThanOrEqual(at(l, 1).x + w + layerGap);
  // What would have to go before the page's edge: the kept one moves after it instead.
  const back = layout(["org/app#2", "org/app#9"], [after(9, 2)], wide, {
    boxes: [{ key: "org/app#2", x: 0, y: 0 }],
    gridTop: null,
  });
  expect(at(back, 9).x).toBe(0);
  expect(at(back, 2)).toEqual({ key: "org/app#2", x: w + layerGap, y: at(back, 9).y });
});

test("dropTarget: on a node or in the gap after it, else the open", () => {
  const l = layout(["org/app#2", "org/app#1"], [after(1, 2)], wide);
  const one = at(l, 1);
  // On #1, and in the gap to its right: after #1.
  expect(dropTarget(l, one.x + 10, one.y + 10)).toBe("org/app#1");
  expect(dropTarget(l, one.x + w + layerGap - 1, one.y + h / 2)).toBe("org/app#1");
  // Beyond #2, or below both: in the open.
  expect(dropTarget(l, 2 * (w + layerGap) + w + layerGap + 5, 10)).toBe(null);
  expect(dropTarget(l, 10, h + 10)).toBe(null);
  // On a phone, the gap is to the right too.
  const v = layout(["org/app#2", "org/app#1"], [after(1, 2)], phone);
  const n = SIZES.narrow;
  expect(dropTarget(v, n.w + n.layerGap - 1, 10)).toBe("org/app#1");
  expect(dropTarget(v, 10, n.h + 5)).toBe(null);
  // In the column of the others: the row dropped on.
  const col = layout(["org/app#1", "org/app#2", "org/app#3"], [], phone);
  expect(dropTarget(col, 10, n.h + n.rowGap + 10)).toBe("org/app#2");
  expect(dropTarget(col, 10, n.h + n.rowGap / 2)).toBe(null);
});

test("issueOfLink: an issue or pull request link of the repo, on the listener's GitHub", () => {
  const gh = "https://github.example.com";
  expect(issueOfLink(`${gh}/org/app/issues/12`, gh, "org/app")).toBe(12);
  expect(issueOfLink(`${gh}/org/app/issues/12#issuecomment-1`, gh, "org/app")).toBe(12);
  expect(issueOfLink(`${gh}/Org/App/pull/7/files`, gh, "org/app")).toBe(7);
  // A uri-list: comments skipped, the first link that fits.
  expect(issueOfLink(`# from a tab\n${gh}/org/app/issues/3\n`, gh, "org/app")).toBe(3);
  expect(issueOfLink(`${gh}/org/other/issues/12`, gh, "org/app")).toBe(null);
  expect(issueOfLink(`https://github.com/org/app/issues/12`, gh, "org/app")).toBe(null);
  expect(issueOfLink(`${gh}/org/app/issues/12x`, gh, "org/app")).toBe(null);
  expect(issueOfLink(`${gh}/org/app-two/issues/12`, gh, "org/app")).toBe(null);
  expect(issueOfLink("#12", gh, "org/app")).toBe(null);
});
