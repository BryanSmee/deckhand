// The theme: System (the scheme the device prefers), Light or Dark, kept in this browser like
// the other per-browser choices. public/theme.js applies it before the first paint; this keeps
// the root's class in step when the choice or the system's scheme changes.
import { useState } from "preact/hooks";

export type Theme = "system" | "light" | "dark";

export const THEMES: readonly Theme[] = ["system", "light", "dark"];
const KEY = "deckhand.theme";
const DARK = "(prefers-color-scheme: dark)";

export function storedTheme(): Theme {
  try {
    const value = localStorage.getItem(KEY);
    return THEMES.includes(value as Theme) ? (value as Theme) : "system";
  } catch {
    return "system";
  }
}

// The class a choice comes to, given whether the system prefers dark.
export const themeClass = (theme: Theme, systemDark: boolean) =>
  theme === "dark" || (theme === "system" && systemDark) ? "t-dark" : "t-light";

export function applyTheme(theme: Theme, root = document.documentElement) {
  const next = themeClass(theme, matchMedia(DARK).matches);
  root.classList.remove(next === "t-dark" ? "t-light" : "t-dark");
  root.classList.add(next);
}

// Once, at start: the class for the stored choice, again whenever the system's scheme changes
// (it only matters on System, and applying it again is harmless otherwise).
export function followTheme() {
  applyTheme(storedTheme());
  matchMedia(DARK).addEventListener("change", () => applyTheme(storedTheme()));
}

// The choice and its setter: setting it keeps it and applies it at once.
export function useTheme(): [Theme, (theme: Theme) => void] {
  const [theme, setTheme] = useState(storedTheme);
  const choose = (next: Theme) => {
    try {
      if (next === "system") localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, next);
    } catch {
      // Private mode: for this page only.
    }
    applyTheme(next);
    setTheme(next);
  };
  return [theme, choose];
}
