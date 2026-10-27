// Settings › Preferences: the choices kept in this browser (localStorage, `deckhand.<key>`),
// not on the server. Each is read where it's used through usePref(), which every setter
// tells: a change from Preferences, the sidebar's theme switch or another tab shows at once.
// Theme, Density and Motion are classes on the root (public/theme.js sets them before the
// first paint, applyPrefs() afterwards): .t-light or .t-dark, .d-compact, .m-reduced.
import { useEffect, useReducer } from "preact/hooks";

export type Theme = "system" | "light" | "dark";
export type Density = "comfortable" | "compact";
export type Motion = "system" | "full" | "reduced";
export type OpenOn = "last" | "overview";
export type PhoneBoard = "lanes" | "graph";

interface Pref<T> {
  key: string;
  default: T;
  values?: readonly T[];
}

const one = <T extends string>(key: string, values: readonly T[]): Pref<T> => ({
  key,
  default: values[0],
  values,
});
const flag = (key: string, on: boolean): Pref<boolean> => ({ key, default: on });

// The keys of the choices that were kept before this page (graphClosed) stay theirs.
export const PREFS = {
  theme: one<Theme>("theme", ["system", "light", "dark"]),
  density: one<Density>("density", ["comfortable", "compact"]),
  motion: one<Motion>("motion", ["system", "full", "reduced"]),
  openOn: one<OpenOn>("openOn", ["last", "overview"]),
  notifyReady: flag("notify.ready", true),
  notifyInput: flag("notify.input", true),
  notifyFailed: flag("notify.failed", false),
  phoneBoard: one<PhoneBoard>("phoneBoard", ["lanes", "graph"]),
  showClosed: flag("graphClosed", false),
  logFollow: flag("log.follow", true),
  logErrors: flag("log.errors", true),
  logWrap: flag("log.wrap", false),
  shortcuts: flag("shortcuts", true),
};

export type Prefs = { [K in keyof typeof PREFS]: (typeof PREFS)[K]["default"] };
export type PrefName = keyof Prefs;

// The theme after `theme`, as Shift T goes: System, Light, Dark, then System again.
export const THEMES: readonly Theme[] = ["system", "light", "dark"];
export const nextTheme = (theme: Theme): Theme =>
  THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];

// The choices storage refused (private mode, a full quota): kept on this page, for its life.
const unkept = new Map<string, string | null>();

export function getPref<K extends PrefName>(name: K): Prefs[K] {
  const pref = PREFS[name] as Pref<Prefs[K]>;
  const key = `deckhand.${pref.key}`;
  let kept: string | null = null;
  if (unkept.has(key)) kept = unkept.get(key)!;
  else
    try {
      kept = localStorage.getItem(key);
    } catch {
      // Storage blocked: the default.
    }
  if (kept === null) return pref.default;
  if (typeof pref.default === "boolean") return (kept === "1") as Prefs[K];
  return pref.values?.includes(kept as Prefs[K]) ? (kept as Prefs[K]) : pref.default;
}

const listeners = new Set<() => void>();
const tell = () => listeners.forEach((fn) => fn());

// The default isn't kept: a choice nobody made follows a later default.
export function setPref<K extends PrefName>(name: K, value: Prefs[K]) {
  const pref = PREFS[name] as Pref<Prefs[K]>;
  const key = `deckhand.${pref.key}`;
  const kept: string | null =
    value === pref.default
      ? null
      : typeof value === "boolean"
        ? value
          ? "1"
          : "0"
        : String(value);
  try {
    if (kept === null) localStorage.removeItem(key);
    else localStorage.setItem(key, kept);
    unkept.delete(key);
  } catch {
    unkept.set(key, kept);
  }
  if (name === "theme" || name === "density" || name === "motion") applyPrefs();
  tell();
}

export function usePref<K extends PrefName>(name: K): [Prefs[K], (value: Prefs[K]) => void] {
  const [, render] = useReducer((n: number, _: void) => n + 1, 0);
  useEffect(() => {
    listeners.add(render);
    return () => void listeners.delete(render);
  }, []);
  return [getPref(name), (value) => setPref(name, value)];
}

const DARK = "(prefers-color-scheme: dark)";
const REDUCE = "(prefers-reduced-motion: reduce)";

// The class a theme comes to, given whether the system prefers dark.
export const themeClass = (theme: Theme, systemDark: boolean) =>
  theme === "dark" || (theme === "system" && systemDark) ? "t-dark" : "t-light";

export const reducedMotion = (motion: Motion, systemReduces: boolean) =>
  motion === "reduced" || (motion === "system" && systemReduces);

export function applyPrefs(root = document.documentElement) {
  const theme = themeClass(getPref("theme"), matchMedia(DARK).matches);
  root.classList.remove(theme === "t-dark" ? "t-light" : "t-dark");
  root.classList.add(theme);
  root.classList.toggle("d-compact", getPref("density") === "compact");
  root.classList.toggle("m-reduced", reducedMotion(getPref("motion"), matchMedia(REDUCE).matches));
}

// Once, at start: the classes for the kept choices, again when the system's scheme or motion
// setting changes (it only matters on System), and every choice again when another tab
// changes one. Returns what stops it (the specs').
export function followPrefs() {
  const dark = matchMedia(DARK);
  const reduce = matchMedia(REDUCE);
  const apply = () => applyPrefs();
  const other = (e: StorageEvent) => {
    if (e.key !== null && !e.key.startsWith("deckhand.")) return;
    applyPrefs();
    tell();
  };
  applyPrefs();
  dark.addEventListener("change", apply);
  reduce.addEventListener("change", apply);
  addEventListener("storage", other);
  return () => {
    dark.removeEventListener("change", apply);
    reduce.removeEventListener("change", apply);
    removeEventListener("storage", other);
  };
}
