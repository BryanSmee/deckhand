// The tokens (global.css): both themes define the same ones, and every text colour reads at
// 4.5:1 at least (WCAG AA) on the surfaces it sits on, the old names the unmigrated views
// still use included.
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

// The old names (`--ink: var(--text)`, `--accent-soft: color-mix(…)`) in a theme's colours.
function withAliases(colours: Record<string, string>): Record<string, string> {
  const start = css.indexOf(":root,\n.t-light,\n.t-dark {");
  const block = css.slice(start, css.indexOf("}", start));
  const all = { ...colours };
  for (const [, name, value] of block.matchAll(/--([\w-]+):\s*([^;]+);/g)) {
    const alias = /^var\(--([\w-]+)\)$/.exec(value);
    const mixed = /^color-mix\(in srgb, var\(--([\w-]+)\) (\d+)%, var\(--([\w-]+)\)\)$/.exec(value);
    if (alias) all[name] = all[alias[1]];
    else if (mixed) all[name] = mix(all[mixed[1]], all[mixed[3]], Number(mixed[2]) / 100);
    else throw new Error(`--${name}: ${value} isn't a token or a mix of two`);
  }
  return all;
}

// `a` at `share`, the rest `b`, in sRGB: color-mix()'s result.
const mix = (a: string, b: string, share: number) =>
  "#" +
  [1, 3, 5]
    .map((i) => {
      const [x, y] = [a, b].map((c) => parseInt(c.slice(i, i + 2), 16));
      return Math.round(x * share + y * (1 - share))
        .toString(16)
        .padStart(2, "0");
    })
    .join("");

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
  // The confirmed Stop, and its hover.
  ["on-err", "err-solid"],
  ["on-err", "err-solid-hover"],
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

// The unmigrated views' text pairs, by their old names.
const OLD_PAIRS: [string, string][] = [
  ...["ink", "muted", "accent"].flatMap((fg) =>
    ["panel", "raised", "hover", "code", "accent-soft"].map((bg): [string, string] => [fg, bg]),
  ),
  ["run", "run-soft"],
  ["ok", "ok-soft"],
  ["err", "err-soft"],
  ["warn", "warn-soft"],
  ["idle", "idle-soft"],
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
  const all = withAliases(colours);
  const low = [...PAIRS, ...OLD_PAIRS]
    .map(([fg, bg]) => ({ fg, bg, ratio: contrast(all[fg], all[bg]) }))
    .filter((p) => !(p.ratio >= 4.5))
    .map((p) => `${p.fg} on ${p.bg}: ${p.ratio.toFixed(2)}`);
  expect(low).toEqual([]);
});

test("the ratio is WCAG's", () => {
  expect(contrast("#000000", "#ffffff")).toBeCloseTo(21);
  expect(contrast("#777777", "#ffffff")).toBeCloseTo(4.48, 2);
});
