// The tokens (global.css): both themes define the same ones, and every text colour reads at
// 4.5:1 at least (WCAG AA) on the surfaces it sits on.
import { expect, test } from "vitest";
import css from "./global.css?raw";

// A theme's colours: its block's `--name: #rrggbb` lines.
function theme(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  const block = css.slice(start, css.indexOf("}", start));
  return Object.fromEntries(
    [...block.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})\b/gi)].map((m) => [m[1], m[2]]),
  );
}

const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

const SURFACES = ["bg", "surface", "surface-2", "surface-3"];
const TONES = ["run", "input", "ready", "done", "err", "idle"];
const PAIRS: [string, string][] = [
  ...["text", "text-2", "text-3"].flatMap((fg) => SURFACES.map((bg): [string, string] => [fg, bg])),
  ["on-primary", "primary"],
  ["on-primary", "primary-hover"],
  // Links and the focus colour's text.
  ["focus", "bg"],
  ["focus", "surface"],
  // A tone's text on its own fill (badges, notices) and on the page's surfaces.
  ...TONES.flatMap((t): [string, string][] => [
    [t, `${t}-bg`],
    [t, "surface"],
    [t, "bg"],
  ]),
];

const light = theme(":root,\n.t-light");
const dark = theme(".t-dark");

test("both themes define the same colours", () => {
  expect(Object.keys(light).length).toBeGreaterThan(30);
  expect(Object.keys(dark).sort()).toEqual(Object.keys(light).sort());
});

test.each([
  ["light", light],
  ["dark", dark],
])("text reads at 4.5:1 or more in the %s theme", (_, colours) => {
  const low = PAIRS.map(([fg, bg]) => ({ fg, bg, ratio: contrast(colours[fg], colours[bg]) }))
    .filter((p) => !(p.ratio >= 4.5))
    .map((p) => `${p.fg} on ${p.bg}: ${p.ratio.toFixed(2)}`);
  expect(low).toEqual([]);
});

test("the ratio is WCAG's", () => {
  expect(contrast("#000000", "#ffffff")).toBeCloseTo(21);
  expect(contrast("#777777", "#ffffff")).toBeCloseTo(4.48, 2);
});
