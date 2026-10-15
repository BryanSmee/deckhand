import { expect, test } from "vitest";
import { dropTarget, graphOf, issueOfLink, layout, lookOf, SIZES } from "./graph";
import type { Task } from "./types";

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
const wide = { vertical: false, width: 1200 };
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

  // On a phone, top to bottom.
  const phone = layout(keys, [after(1, 2), after(2, 3)], { vertical: true, width: 360 });
  const ys = [1, 2, 3].map((n) => at(phone, n).y);
  expect(ys[0]).toBe(0);
  expect(ys[1]).toBeGreaterThan(ys[0] + SIZES.narrow.h);
  expect(ys[2]).toBeGreaterThan(ys[1] + SIZES.narrow.h);
  expect(new Set([1, 2, 3].map((n) => at(phone, n).x))).toEqual(new Set([0]));
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

test("no relations at all: a grid as wide as the page", () => {
  const keys = [1, 2, 3, 4, 5].map((n) => `org/app#${n}`);
  const l = layout(keys, [], { vertical: false, width: 2 * w + 16 });
  expect(l.gridTop).toBe(0);
  expect(l.arrows).toEqual([]);
  expect(l.boxes.map((b) => [b.x, b.y])).toEqual([
    [0, 0],
    [w + 16, 0],
    [0, h + 16],
    [w + 16, h + 16],
    [0, 2 * (h + 16)],
  ]);
  // Below the linked issues when there are some.
  const mixed = layout(keys, [after(1, 2)], wide);
  expect(mixed.gridTop).toBeGreaterThan(h);
  expect(at(mixed, 3).y).toBe(mixed.gridTop);
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

test("dropTarget: on a node or in the gap after it, else the open", () => {
  const l = layout(["org/app#2", "org/app#1"], [after(1, 2)], wide);
  const one = at(l, 1);
  // On #1, and in the gap to its right: after #1.
  expect(dropTarget(l, false, one.x + 10, one.y + 10)).toBe("org/app#1");
  expect(dropTarget(l, false, one.x + w + layerGap - 1, one.y + h / 2)).toBe("org/app#1");
  // Beyond #2, or below both: in the open.
  expect(dropTarget(l, false, 2 * (w + layerGap) + w + layerGap + 5, 10)).toBe(null);
  expect(dropTarget(l, false, 10, h + 10)).toBe(null);
  // On a phone, the gap is below.
  const v = layout(["org/app#2", "org/app#1"], [after(1, 2)], { vertical: true, width: 390 });
  const n = SIZES.narrow;
  expect(dropTarget(v, true, 10, n.h + n.layerGap - 1)).toBe("org/app#1");
  expect(dropTarget(v, true, n.w + 5, 10)).toBe(null);
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
