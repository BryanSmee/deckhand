// The graph's layout, drawn by hand: each issue that waits for others ("/after") goes in a
// column after theirs, left to right at every width; issues with no arrow stand alone in one
// column below, top to bottom in the board's order, like the list. The last drawing's places
// are kept (settle()).

// Sizes in SVG units (CSS pixels). A phone's columns are narrower: a short chain still fits
// its width, a longer one scrolls sideways.
export const SIZES = {
  wide: { w: 208, h: 78, layerGap: 48, rowGap: 38 },
  narrow: { w: 148, h: 78, layerGap: 28, rowGap: 24 },
};
// Between two groups of linked issues, and before the column of the others.
const GROUP_GAP = 32;

export interface Box {
  key: string;
  x: number;
  y: number;
}

export interface Layout {
  boxes: Box[];
  // An SVG path per arrow, ending at the waiting issue.
  arrows: { from: string; to: string; d: string }[];
  // Where the column of issues without arrows starts; null when there are none.
  gridTop: number | null;
  width: number;
  height: number;
  w: number;
  h: number;
  // Between two columns: where an arrow runs.
  gap: number;
}

// `keys` in the order they come (the board's: most recent first); `narrow`: a phone's smaller
// nodes. `prev`: the last drawing, whose places are kept where they still fit (settle()):
// adding or moving an issue doesn't move the others.
export function layout(
  keys: string[],
  edges: { from: string; to: string }[],
  { narrow }: { narrow: boolean },
  prev: Pick<Layout, "boxes" | "gridTop"> | null = null,
): Layout {
  const sizes = narrow ? SIZES.narrow : SIZES.wide;
  const { w, h, layerGap, rowGap } = sizes;
  const order = new Map(keys.map((k, i) => [k, i]));
  const preds = new Map<string, string[]>(keys.map((k) => [k, []]));
  const succs = new Map<string, string[]>(keys.map((k) => [k, []]));
  const seen = new Set<string>();
  for (const { from, to } of edges) {
    if (!order.has(from) || !order.has(to) || from === to || seen.has(`${from} ${to}`)) continue;
    seen.add(`${from} ${to}`);
    preds.get(to)!.push(from);
    succs.get(from)!.push(to);
  }
  const linked = keys.filter((k) => preds.get(k)!.length || succs.get(k)!.length);

  let boxes: Box[] = [];
  // Each linked issue's column, which settle() keeps the arrows' direction by.
  const layerOf = new Map<string, number>();
  let top = 0;
  for (const group of components(linked, preds, succs)) {
    const layers = layersOf(group, preds, order);
    // Across a column: the first one in the board's order, then each next column by where
    // what it waits for sits (fewer crossings).
    const at = new Map<string, number>();
    let rows = 0;
    for (const layer of layers) {
      const mid = (k: string) => {
        const placed = preds.get(k)!.filter((p) => at.has(p));
        return placed.length
          ? placed.reduce((s, p) => s + at.get(p)!, 0) / placed.length
          : Infinity;
      };
      layer.sort((a, b) => mid(a) - mid(b) || order.get(a)! - order.get(b)!);
      layer.forEach((k, i) => at.set(k, i));
      rows = Math.max(rows, layer.length);
    }
    layers.forEach((layer, l) => {
      layer.forEach((k, r) => {
        layerOf.set(k, l);
        boxes.push({ key: k, x: l * (w + layerGap), y: top + r * (h + rowGap) });
      });
    });
    // Groups go one under the other.
    top += rows * (h + rowGap) - rowGap + GROUP_GAP;
  }

  const alone = keys.filter((k) => !preds.get(k)!.length && !succs.get(k)!.length);
  let gridTop = alone.length ? top : null;
  alone.forEach((k, i) => boxes.push({ key: k, x: 0, y: top + i * (h + rowGap) }));

  // Nothing kept (the first drawing, another tab): laid out afresh.
  const keeps = prev?.boxes.some((b) => order.has(b.key));
  const kept = keeps && settle(keys, preds, succs, layerOf, prev!, sizes);
  if (kept) {
    boxes = kept.boxes;
    gridTop = alone.length ? kept.gridTop : null;
  }

  const box = new Map(boxes.map((b) => [b.key, b]));
  const arrows = [...seen].map((pair) => {
    const [from, to] = pair.split(" ");
    const a = box.get(from)!;
    const b = box.get(to)!;
    // An elbow: out of the blocker, along the gap before the waiting issue's column, in.
    const x1 = a.x + w;
    const mid = b.x - layerGap / 2;
    return { from, to, d: `M${x1} ${a.y + h / 2}H${mid}V${b.y + h / 2}H${b.x}` };
  });

  const width = Math.max(0, ...boxes.map((b) => b.x + w));
  const height = Math.max(0, ...boxes.map((b) => b.y + h));
  return { boxes, arrows, gridTop, width, height, w, h, gap: layerGap };
}

// The last drawing's places, kept for the issues they still fit: each one a column after what
// it waits for, none on another. The others get a place near theirs: after what they wait
// for, or in a free row of the column of issues without arrows.
function settle(
  keys: string[],
  preds: Map<string, string[]>,
  succs: Map<string, string[]>,
  layerOf: Map<string, number>,
  prev: Pick<Layout, "boxes" | "gridTop">,
  { w, h, layerGap, rowGap }: { w: number; h: number; layerGap: number; rowGap: number },
): { boxes: Box[]; gridTop: number } {
  const step = w + layerGap;
  const row = h + rowGap;
  // An arrow that closes a cycle goes backwards anyway: only the others are kept forward.
  const forward = (from: string, to: string) => layerOf.get(from)! < layerOf.get(to)!;

  const placed = new Map<string, Box>();
  const old = new Map(prev.boxes.map((b) => [b.key, b]));
  for (const k of keys) if (old.has(k)) placed.set(k, { ...old.get(k)!, key: k });
  // What now comes before what it waits for moves; until nothing does.
  for (let changed = true; changed;) {
    changed = false;
    for (const [k, b] of placed) {
      const late = preds
        .get(k)!
        .some((p) => forward(p, k) && placed.has(p) && placed.get(p)!.x + step > b.x);
      if (late) changed = placed.delete(k);
    }
  }
  // Closer than the closest two of a fresh layout: a row apart, or two groups.
  const near = Math.min(rowGap, GROUP_GAP);
  const clash = (a: Box, b: Box) =>
    a.key !== b.key && Math.abs(a.x - b.x) < w + near && Math.abs(a.y - b.y) < h + near;
  const free = (b: Box) => ![...placed.values()].some((o) => clash(o, b));
  // Two on the same place (a phone's smaller nodes, say): the first one in the board's order
  // keeps it.
  for (const k of keys) {
    const b = placed.get(k);
    if (!b) continue;
    placed.delete(k);
    if (free(b)) placed.set(k, b);
  }

  const bottom = Math.max(-GROUP_GAP, ...[...placed.values()].map((b) => b.y + h));
  const gridTop = prev.gridTop ?? bottom + GROUP_GAP;
  // Column by column, in the board's order: what an issue waits for is placed before it. A
  // kept issue that would now come too soon after it moves too, and goes back in the list.
  const rest = keys.filter((k) => !placed.has(k));
  const layer = (k: string) => layerOf.get(k) ?? 0;
  while (rest.length) {
    rest.sort((a, b) => layer(a) - layer(b) || keys.indexOf(a) - keys.indexOf(b));
    const k = rest.shift()!;
    const before = preds.get(k)!.filter((p) => forward(p, k) && placed.has(p));
    const lo = before.length ? Math.max(...before.map((p) => placed.get(p)!.x + step)) : 0;
    let after = succs.get(k)!.filter((n) => forward(k, n) && placed.has(n));
    for (const n of after.filter((n) => placed.get(n)!.x < lo + step)) {
      placed.delete(n);
      rest.push(n);
    }
    after = after.filter((n) => placed.has(n));
    let b: Box | undefined;
    if (before.length || after.length) {
      // Next to what it is linked to: the same row first, then the nearest free one.
      const a = before.length ? lo : Math.min(...after.map((n) => placed.get(n)!.x - step));
      const c = Math.min(...(before.length ? before : after).map((n) => placed.get(n)!.y));
      for (let i = 0; !b; i++) {
        const offset = (i % 2 ? 1 : -1) * Math.ceil(i / 2) * row;
        const at = { key: k, x: a, y: c + offset };
        if (c + offset >= 0 && free(at)) b = at;
      }
    } else {
      // On its own (or the first of new linked ones): the first free row of the column.
      for (let i = 0; !b; i++) {
        const at = { key: k, x: 0, y: gridTop + i * row };
        if (free(at)) b = at;
      }
    }
    placed.set(k, b);
  }
  return { boxes: keys.map((k) => placed.get(k)!), gridTop };
}

// The groups of issues linked to each other, in the board's order of their first issue.
function components(
  keys: string[],
  preds: Map<string, string[]>,
  succs: Map<string, string[]>,
): string[][] {
  const done = new Set<string>();
  const groups: string[][] = [];
  for (const start of keys) {
    if (done.has(start)) continue;
    const group: string[] = [];
    const stack = [start];
    done.add(start);
    while (stack.length) {
      const k = stack.pop()!;
      group.push(k);
      for (const n of [...preds.get(k)!, ...succs.get(k)!]) {
        if (!done.has(n)) {
          done.add(n);
          stack.push(n);
        }
      }
    }
    groups.push(group);
  }
  return groups;
}

// Columns: each issue one after the last of those it waits for (the longest path). Issues
// waiting for each other (a cycle of "/after"s) are placed in the board's order, the arrow
// that closes the cycle going backwards.
function layersOf(group: string[], preds: Map<string, string[]>, order: Map<string, number>) {
  const inGroup = new Set(group);
  const layer = new Map<string, number>();
  const left = [...group].sort((a, b) => order.get(a)! - order.get(b)!);
  while (left.length) {
    // The first issue whose blockers are all placed; else (a cycle) the first one left.
    const i = Math.max(
      0,
      left.findIndex((k) => preds.get(k)!.every((p) => !inGroup.has(p) || layer.has(p))),
    );
    const [k] = left.splice(i, 1);
    const placed = preds.get(k)!.filter((p) => layer.has(p));
    layer.set(k, placed.length ? Math.max(...placed.map((p) => layer.get(p)!)) + 1 : 0);
  }
  const layers: string[][] = [];
  for (const [k, l] of layer) (layers[l] ??= []).push(k);
  return layers.map((l) => l ?? []);
}

// The issue a drop at (x, y) queues after: the one it lands on, or the one whose right side
// it lands in, where what waits for it goes. Null: dropped in the open, it starts (or stops
// waiting).
export function dropTarget(
  l: Pick<Layout, "boxes" | "w" | "h" | "gap">,
  x: number,
  y: number,
): string | null {
  const hit = l.boxes.find((b) => x >= b.x && x <= b.x + l.w + l.gap && y >= b.y && y <= b.y + l.h);
  return hit?.key ?? null;
}
