// The theme: System follows the device, Light and Dark don't; the choice is kept in this
// browser, and public/theme.js puts the same class on the root before the first paint.
import { act, renderHook } from "@testing-library/preact";
import { beforeEach, expect, test, vi } from "vitest";
import early from "../../public/theme.js?raw";
import { applyTheme, followTheme, storedTheme, themeClass, useTheme } from "./theme";

// A device that prefers dark or not, and tells who listens when that changes.
function prefers(dark: boolean) {
  const listeners: (() => void)[] = [];
  const list = {
    matches: dark,
    addEventListener: (_: string, fn: () => void) => listeners.push(fn),
    removeEventListener() {},
  };
  vi.stubGlobal("matchMedia", () => list);
  return (next: boolean) => {
    list.matches = next;
    listeners.forEach((fn) => fn());
  };
}

const root = document.documentElement;
const theme = () => [...root.classList].filter((c) => c.startsWith("t-"));

beforeEach(() => root.classList.remove("t-light", "t-dark"));

test("System follows the device; Light and Dark don't", () => {
  expect(themeClass("system", true)).toBe("t-dark");
  expect(themeClass("system", false)).toBe("t-light");
  expect(themeClass("light", true)).toBe("t-light");
  expect(themeClass("dark", false)).toBe("t-dark");
});

test("nothing kept, or something unknown, is System", () => {
  expect(storedTheme()).toBe("system");
  localStorage.setItem("deckhand.theme", "sepia");
  expect(storedTheme()).toBe("system");
  localStorage.setItem("deckhand.theme", "dark");
  expect(storedTheme()).toBe("dark");
});

test("applying one class takes the other off", () => {
  prefers(false);
  applyTheme("dark");
  expect(theme()).toEqual(["t-dark"]);
  applyTheme("system");
  expect(theme()).toEqual(["t-light"]);
});

test("choosing keeps the choice and applies it at once", () => {
  prefers(true);
  const { result } = renderHook(() => useTheme());
  expect(result.current[0]).toBe("system");
  act(() => result.current[1]("light"));
  expect(result.current[0]).toBe("light");
  expect(localStorage.getItem("deckhand.theme")).toBe("light");
  expect(theme()).toEqual(["t-light"]);
  // System is the default: nothing kept.
  act(() => result.current[1]("system"));
  expect(localStorage.getItem("deckhand.theme")).toBeNull();
  expect(theme()).toEqual(["t-dark"]);
});

test("on System, the device switching scheme switches the page", () => {
  const change = prefers(false);
  followTheme();
  expect(theme()).toEqual(["t-light"]);
  change(true);
  expect(theme()).toEqual(["t-dark"]);
  // A choice of Dark or Light stays put.
  localStorage.setItem("deckhand.theme", "light");
  change(true);
  expect(theme()).toEqual(["t-light"]);
});

test("before the first paint, public/theme.js sets the same class", () => {
  for (const [kept, dark, expected] of [
    [null, true, "t-dark"],
    [null, false, "t-light"],
    ["light", true, "t-light"],
    ["dark", false, "t-dark"],
  ] as const) {
    root.classList.remove("t-light", "t-dark");
    localStorage.clear();
    if (kept) localStorage.setItem("deckhand.theme", kept);
    prefers(dark);
    new Function(early)();
    expect(theme()).toEqual([expected]);
  }
});
