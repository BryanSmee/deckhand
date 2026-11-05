// Settings › Preferences: the choices kept in this browser (localStorage, `deckhand.<key>`),
// not on the server. Each is read where it's used through usePref(), which every setter
// tells: a change from Preferences, the sidebar's theme switch or another tab shows at once.
// Theme, Density and Motion are classes on the root (public/theme.js sets them before the
// first paint, applyPrefs() afterwards): .t-light or .t-dark, .d-compact, .m-reduced; Language
// is the root's `lang` (i18n.ts writes the page in it).
import { useEffect, useReducer } from "preact/hooks";
import { browserLanguages, type Language, LANGUAGES, resolveLanguage } from "./locales";

export type Theme = "system" | "light" | "dark";
export type Density = "comfortable" | "compact";
export type Motion = "system" | "full" | "reduced";
export type OpenOn = "last" | "overview";
export type PhoneBoard = "lanes" | "graph";
export type LanguageChoice = "system" | Language;

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
  language: one<LanguageChoice>("language", ["system", ...LANGUAGES]),
  notifyReady: flag("notify.ready", true),
  notifyInput: flag("notify.input", true),
  notifyFailed: flag("notify.failed", false),
  phoneBoard: one<PhoneBoard>("phoneBoard", ["lanes", "graph"]),
  showClosed: flag("graphClosed", false),
  logFollow: flag("log.follow", true),
  logErrors: flag("log.errors", true),
  logWrap: flag("log.wrap", false),
  logTimes: flag("log.times", false),
  shortcuts: flag("shortcuts", true),
  // The board's Backlog: sub-issues whose parent is listed left out (WorkQueue.tsx).
  hideSubIssues: flag("backlog.hideSubIssues", false),
};

export type Prefs = { [K in keyof typeof PREFS]: (typeof PREFS)[K]["default"] };
export type PrefName = keyof Prefs;

// The theme after `theme`, as Shift T goes: System, Light, Dark, then System again.
export const THEMES: readonly Theme[] = ["system", "light", "dark"];
export const nextTheme = (theme: Theme): Theme =>
  THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];

// The choices storage refused (private mode, a full quota): kept on this page, for its life.
const unkept = new Map<string, string | null>();

// What `key` keeps, or null: storage blocked, the default.
function readKept(key: string): string | null {
  if (unkept.has(key)) return unkept.get(key)!;
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

// Null: nothing kept, the default.
function writeKept(key: string, kept: string | null) {
  try {
    if (kept === null) localStorage.removeItem(key);
    else localStorage.setItem(key, kept);
    unkept.delete(key);
  } catch {
    unkept.set(key, kept);
  }
}

export function getPref<K extends PrefName>(name: K): Prefs[K] {
  const pref = PREFS[name] as Pref<Prefs[K]>;
  const kept = readKept(`deckhand.${pref.key}`);
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
  writeKept(key, kept);
  if (name === "theme" || name === "density" || name === "motion" || name === "language")
    applyPrefs();
  tell();
}

// Renders the component again when a choice changes.
function useChoices() {
  const [, render] = useReducer((n: number, _: void) => n + 1, 0);
  useEffect(() => {
    listeners.add(render);
    return () => void listeners.delete(render);
  }, []);
}

export function usePref<K extends PrefName>(name: K): [Prefs[K], (value: Prefs[K]) => void] {
  useChoices();
  return [getPref(name), (value) => setPref(name, value)];
}

// The board's Backlog's label filter, per repository (WorkQueue.tsx): the labels ticked, ""
// for "No label", in `deckhand.backlog.labels.<owner/repo>` as JSON. None ticked isn't kept.
const labelsKey = (repo: string) => `deckhand.backlog.labels.${repo.toLowerCase()}`;

export function getBacklogLabels(repo: string): string[] {
  try {
    const kept: unknown = JSON.parse(readKept(labelsKey(repo)) ?? "[]");
    return Array.isArray(kept) ? kept.filter((l): l is string => typeof l === "string") : [];
  } catch {
    return [];
  }
}

export function setBacklogLabels(repo: string, labels: readonly string[]) {
  writeKept(labelsKey(repo), labels.length ? JSON.stringify([...new Set(labels)]) : null);
  tell();
}

export function useBacklogLabels(repo: string): [string[], (labels: readonly string[]) => void] {
  useChoices();
  return [getBacklogLabels(repo), (labels) => setBacklogLabels(repo, labels)];
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
  root.lang = resolveLanguage(getPref("language"), browserLanguages()).locale;
}

// Once, at start: the classes for the kept choices, again when the system's scheme, motion
// setting or languages change (it only matters on System: a language change re-renders the
// page too), and every choice again when another tab changes one. Returns what stops it (the
// specs').
export function followPrefs() {
  const dark = matchMedia(DARK);
  const reduce = matchMedia(REDUCE);
  const apply = () => applyPrefs();
  const languages = () => {
    applyPrefs();
    tell();
  };
  const other = (e: StorageEvent) => {
    if (e.key !== null && !e.key.startsWith("deckhand.")) return;
    applyPrefs();
    tell();
  };
  applyPrefs();
  dark.addEventListener("change", apply);
  reduce.addEventListener("change", apply);
  addEventListener("storage", other);
  addEventListener("languagechange", languages);
  return () => {
    dark.removeEventListener("change", apply);
    reduce.removeEventListener("change", apply);
    removeEventListener("storage", other);
    removeEventListener("languagechange", languages);
  };
}
