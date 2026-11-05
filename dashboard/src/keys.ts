// The keyboard shortcuts (docs/design/dashboard-redesign.md › Layout › Keyboard): one table, which
// the `?` sheet lists and the buttons' tooltips name, and one listener that calls what the pages
// bind (useShortcuts()). A key is a chord ("shift+t", "mod+k": Ctrl, ⌘ on a Mac) or a sequence of
// them ("g o"). They never fire while typing in a field, while a dialog or a menu is open, or once
// switched off (Preferences, kept in this browser).
import { useEffect, useRef, useState } from "preact/hooks";
import { t } from "./i18n";
import type { Plain } from "./locales";
import { getPref, setPref, usePref } from "./prefs";

// The sheet's groups: ids, named at render (GROUP_NAMES).
export type Group = "Everywhere" | "Tasks" | "Run log" | "Board";

export interface Shortcut {
  group: Group;
  // Its name, in the language now.
  label: string;
  // Any of them fires it; its handler gets which one.
  keys: readonly string[];
  // How the sheet joins them: "J or K", "1 to 6" (the first and last), or side by side.
  join?: "or" | "to";
  // Held while dragging (Space + drag), not pressed: the board listens itself (useHeldKey()).
  drag?: boolean;
}

// The table, each name a key of the catalog: written when read (SHORTCUTS), as the language
// may change after this module loads.
const TABLE = {
  help: { group: "Everywhere", label: "app.shortcutHelp", keys: ["?"] },
  palette: { group: "Everywhere", label: "app.shortcutPalette", keys: ["mod+k"] },
  request: { group: "Everywhere", label: "app.shortcutRequest", keys: ["n"] },
  overview: { group: "Everywhere", label: "app.shortcutOverview", keys: ["g o"] },
  tasks: { group: "Everywhere", label: "app.shortcutTasks", keys: ["g t"] },
  board: { group: "Everywhere", label: "app.shortcutBoard", keys: ["g b"] },
  settings: { group: "Everywhere", label: "app.shortcutSettings", keys: ["g s"] },
  sidebar: { group: "Everywhere", label: "app.shortcutSidebar", keys: ["\\"] },
  theme: { group: "Everywhere", label: "app.shortcutTheme", keys: ["shift+t"] },
  back: { group: "Everywhere", label: "app.shortcutBack", keys: ["escape"] },

  search: { group: "Tasks", label: "app.shortcutSearch", keys: ["/"] },
  nextTask: { group: "Tasks", label: "app.shortcutNextTask", keys: ["j", "k"], join: "or" },
  filter: {
    group: "Tasks",
    label: "app.shortcutFilter",
    keys: ["1", "2", "3", "4", "5", "6"],
    join: "to",
  },
  github: { group: "Tasks", label: "app.shortcutGithub", keys: ["o"] },
  answer: { group: "Tasks", label: "app.shortcutAnswer", keys: ["a"] },
  rerun: { group: "Tasks", label: "app.shortcutRerun", keys: ["r"] },
  review: { group: "Tasks", label: "app.shortcutReview", keys: ["shift+r"] },
  fix: { group: "Tasks", label: "app.shortcutFix", keys: ["shift+f"] },
  stop: { group: "Tasks", label: "app.shortcutStop", keys: ["shift+s"] },
  nextRun: { group: "Tasks", label: "app.shortcutNextRun", keys: ["]", "["], join: "or" },

  logSearch: { group: "Run log", label: "app.shortcutLogSearch", keys: ["f"] },
  match: {
    group: "Run log",
    label: "app.shortcutMatch",
    keys: ["enter", "shift+enter"],
    join: "or",
  },
  expand: { group: "Run log", label: "app.shortcutExpand", keys: ["e"] },
  collapse: { group: "Run log", label: "app.shortcutCollapse", keys: ["shift+e"] },
  error: { group: "Run log", label: "app.shortcutError", keys: ["x", "shift+x"], join: "or" },
  follow: { group: "Run log", label: "app.shortcutFollow", keys: ["l"] },
  copy: { group: "Run log", label: "app.shortcutCopy", keys: ["mod+shift+c"] },

  move: {
    group: "Board",
    label: "app.shortcutMove",
    keys: ["arrowleft", "arrowup", "arrowright", "arrowdown"],
  },
  open: { group: "Board", label: "app.shortcutOpen", keys: ["enter"] },
  start: { group: "Board", label: "app.shortcutStart", keys: ["s"] },
  queue: { group: "Board", label: "app.shortcutQueue", keys: ["q"] },
  brainstorm: { group: "Board", label: "app.shortcutBrainstorm", keys: ["b"] },
  view: { group: "Board", label: "app.shortcutView", keys: ["v"] },
  closed: { group: "Board", label: "app.shortcutClosed", keys: ["c"] },
  zoom: { group: "Board", label: "app.shortcutZoom", keys: ["+", "-", "0"] },
  pan: { group: "Board", label: "app.shortcutPan", keys: ["space"], drag: true },
} as const satisfies Record<string, Omit<Shortcut, "label"> & { label: Plain }>;

type Table = typeof TABLE;
export const SHORTCUTS = Object.fromEntries(
  Object.entries(TABLE).map(([id, s]) => [
    id,
    Object.defineProperty({ ...s }, "label", { get: () => t(s.label), enumerable: true }),
  ]),
) as unknown as { [K in keyof Table]: Omit<Table[K], "label"> & { readonly label: string } };

export type ShortcutId = keyof typeof SHORTCUTS;

export const GROUPS: readonly Group[] = ["Everywhere", "Tasks", "Run log", "Board"];
export const GROUP_NAMES: Record<Group, Plain> = {
  Everywhere: "app.shortcutsEverywhere",
  Tasks: "app.shortcutsTasks",
  "Run log": "app.shortcutsRunLog",
  Board: "app.shortcutsBoard",
};

// The words between keys.
const JOINS = { or: "app.keysOr", to: "app.keysTo" } as const satisfies Record<string, Plain>;

export const isMac = () => /Mac|iPhone|iPad/.test(navigator.platform);

// One key as the sheet and the tooltips show it.
const NAMES: Record<string, string> = {
  shift: "Shift",
  enter: "↵",
  escape: "Esc",
  arrowleft: "←",
  arrowup: "↑",
  arrowright: "→",
  arrowdown: "↓",
  space: "Space",
  "-": "−",
};
export const keyName = (key: string) =>
  key === "mod" ? (isMac() ? "⌘" : "Ctrl") : (NAMES[key] ?? key.toUpperCase());

// A shortcut as the sheet shows it: its keys, each a sequence of chords, each a list of keys;
// the words between ("then", "or", "to", "+ drag") as strings.
export type Shown = (string[] | string)[];

// `which`: that key alone ("Zoom in (+)").
export function shownKeys(id: ShortcutId, which?: number): Shown {
  const s: Shortcut = SHORTCUTS[id];
  const keys =
    which !== undefined
      ? [s.keys[which]]
      : s.join === "to"
        ? [s.keys[0], s.keys[s.keys.length - 1]]
        : s.keys;
  const out: Shown = [];
  keys.forEach((k, i) => {
    if (i > 0 && s.join) out.push(t(JOINS[s.join]));
    k.split(" ").forEach((chord, j) => {
      if (j > 0) out.push(t("app.keysThen"));
      // "+" alone is the key.
      out.push(chord.split(/\+(?=.)/).map(keyName));
    });
  });
  if (s.drag) out.push(t("app.keysDrag"));
  return out;
}

// "Shift S", "G then O", "J or K": for a tooltip.
export const keyHint = (id: ShortcutId, which?: number) =>
  shownKeys(id, which)
    .map((part) => (typeof part === "string" ? part : part.join(isMac() ? "" : " ")))
    .join(" ");

// A tooltip with the shortcut after it, "Stop the run (Shift S)", while shortcuts are on.
export function withKey(title: string | undefined, id: ShortcutId | undefined, which?: number) {
  if (!id || !shortcutsOn()) return title;
  return title ? t("app.withKey", { title, keys: keyHint(id, which) }) : keyHint(id, which);
}

// On or off: Settings › Preferences' Keyboard shortcuts (prefs.ts).
export const shortcutsOn = () => getPref("shortcuts");
export const setShortcutsOn = (on: boolean) => setPref("shortcuts", on);
export const useShortcutsOn = () => usePref("shortcuts");

// What a key pressed is, as SHORTCUTS writes it, or null (Alt, or Ctrl unasked: the browser's).
// Shift counts for letters and named keys only: a symbol's layout decides it ("?", "+").
export function chordOf(e: KeyboardEvent): string | null {
  if (e.altKey) return null;
  const mac = isMac();
  const mod = mac ? e.metaKey : e.ctrlKey;
  if (mac ? e.ctrlKey : e.metaKey) return null;
  let key = e.key === " " ? "space" : e.key.toLowerCase();
  if (key === "=") key = "+";
  if (key === "−") key = "-";
  const named = /^[a-z]$/.test(key) || key.length > 1;
  return [mod && "mod", e.shiftKey && named && "shift", key].filter(Boolean).join("+");
}

// A key typed in a field is the field's.
export const typing = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

// Enter (and Space) on a button or a link is theirs; arrows in a widget that moves with them.
const PRESSABLE = "a[href], button, summary, [role=button], [role=tab], [role=option]";
const ARROWED = "[role=tablist], [role=radiogroup], [role=listbox], [role=menu]";

function claimed(chord: string, target: EventTarget | null) {
  if (!(target instanceof Element)) return false;
  // Space on a link only scrolls: the board's pan may have it.
  if (/(^|\+)enter$/.test(chord)) return !!target.closest(PRESSABLE);
  if (chord === "space") return !!target.closest(PRESSABLE.replace("a[href], ", ""));
  if (chord.startsWith("arrow")) return !!target.closest(ARROWED);
  return false;
}

// Not now: switched off, a dialog, a menu or a popup list open (theirs are the keys), or typing.
function quiet(e: KeyboardEvent) {
  return (
    e.defaultPrevented ||
    !shortcutsOn() ||
    typing(e.target) ||
    !!document.querySelector('[aria-modal="true"], [role="menu"], [data-popup]')
  );
}

// A handler gets which of its keys fired it; false: not now (the key goes on, unhandled).
export type Handler = (index: number, e: KeyboardEvent) => void | boolean;
export type Handlers = Partial<Record<ShortcutId, Handler>>;

// What is bound now. Each shortcut is bound in one place; the keys two of them share (Enter)
// are on different pages.
const bindings: { current: Handlers }[] = [];
// A sequence's first key ("g"), while the next one may finish it.
let pending: { key: string; at: number } | null = null;
const SEQUENCE_MS = 1500;

function find(chord: string): { handler: Handler; index: number } | null {
  for (const b of bindings) {
    for (const [id, handler] of Object.entries(b.current)) {
      const index = (SHORTCUTS[id as ShortcutId].keys as readonly string[]).indexOf(chord);
      if (index >= 0) return { handler, index };
    }
  }
  return null;
}

const starts = (chord: string) =>
  bindings.some((b) =>
    Object.keys(b.current).some((id) =>
      SHORTCUTS[id as ShortcutId].keys.some((k: string) => k.startsWith(`${chord} `)),
    ),
  );

function onKeyDown(e: KeyboardEvent) {
  if (quiet(e)) return;
  const chord = chordOf(e);
  if (!chord || ["shift", "control", "meta", "alt"].includes(chord.split("+").pop()!)) return;
  if (claimed(chord, e.target)) return;
  const first = pending && Date.now() - pending.at < SEQUENCE_MS ? pending.key : null;
  pending = null;
  if (first) {
    const hit = find(`${first} ${chord}`);
    if (hit && hit.handler(hit.index, e) !== false) return e.preventDefault();
  }
  if (starts(chord)) {
    pending = { key: chord, at: Date.now() };
    return e.preventDefault();
  }
  const hit = find(chord);
  if (hit && hit.handler(hit.index, e) !== false) e.preventDefault();
}

// Binds `handlers` (the latest ones each time) while mounted and `active`.
export function useShortcuts(handlers: Handlers, active = true) {
  const latest = useRef(handlers);
  latest.current = handlers;
  useEffect(() => {
    if (!active) return;
    const binding = {
      get current() {
        return latest.current;
      },
    };
    if (!bindings.length) addEventListener("keydown", onKeyDown);
    bindings.unshift(binding);
    return () => {
      bindings.splice(bindings.indexOf(binding), 1);
      if (!bindings.length) {
        removeEventListener("keydown", onKeyDown);
        pending = null;
      }
    };
  }, [active]);
}

// Whether `key` (a chord of SHORTCUTS, "space") is held, under the same rules as a shortcut.
export function useHeldKey(key: string, active = true): boolean {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (!active) return setHeld(false);
    const down = (e: KeyboardEvent) => {
      if (chordOf(e) !== key || quiet(e) || claimed(key, e.target)) return;
      e.preventDefault();
      setHeld(true);
    };
    const up = (e: KeyboardEvent) => {
      if (chordOf(e) === key) setHeld(false);
    };
    const lost = () => setHeld(false);
    addEventListener("keydown", down);
    addEventListener("keyup", up);
    addEventListener("blur", lost);
    return () => {
      removeEventListener("keydown", down);
      removeEventListener("keyup", up);
      removeEventListener("blur", lost);
    };
  }, [key, active]);
  return held;
}
