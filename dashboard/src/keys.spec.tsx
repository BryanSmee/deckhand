// The shortcut registry: what a key press reads as, sequences, the keys a field, a dialog, a
// button or the setting keeps, and how the sheet and the tooltips name the keys.
import { fireEvent, render } from "@testing-library/preact";
import { expect, test, vi } from "vitest";
import {
  chordOf,
  type Handlers,
  keyHint,
  setShortcutsOn,
  SHORTCUTS,
  shownKeys,
  useShortcuts,
  withKey,
} from "./keys";

function Bound({ handlers }: { handlers: Handlers }) {
  useShortcuts(handlers);
  return (
    <div>
      <input aria-label="field" />
      <button type="button">button</button>
    </div>
  );
}

const key = (init: KeyboardEventInit) => new KeyboardEvent("keydown", init);
const press = (key: string, init: KeyboardEventInit = {}, target: Element = document.body) =>
  fireEvent.keyDown(target, { key, ...init });

test("a key press as SHORTCUTS writes it: Shift for letters and named keys only", () => {
  expect(chordOf(key({ key: "T", shiftKey: true }))).toBe("shift+t");
  expect(chordOf(key({ key: "?", shiftKey: true }))).toBe("?");
  expect(chordOf(key({ key: "k", ctrlKey: true }))).toBe("mod+k");
  expect(chordOf(key({ key: "C", ctrlKey: true, shiftKey: true }))).toBe("mod+shift+c");
  expect(chordOf(key({ key: "Enter", shiftKey: true }))).toBe("shift+enter");
  expect(chordOf(key({ key: "=" }))).toBe("+");
  expect(chordOf(key({ key: " " }))).toBe("space");
  // The browser's: Alt, and ⌘ off a Mac.
  expect(chordOf(key({ key: "k", altKey: true }))).toBeNull();
  expect(chordOf(key({ key: "k", metaKey: true }))).toBeNull();
});

test("a key fires its handler with which of its keys it was, and only its own", () => {
  const nextTask = vi.fn();
  const filter = vi.fn();
  render(<Bound handlers={{ nextTask, filter }} />);
  press("k");
  expect(nextTask).toHaveBeenLastCalledWith(1, expect.anything());
  press("3");
  expect(filter).toHaveBeenLastCalledWith(2, expect.anything());
  // Ctrl R is the browser's reload, not R.
  press("j", { ctrlKey: true });
  expect(nextTask).toHaveBeenCalledTimes(1);
});

test("a sequence: G then O; G then anything else is that key", () => {
  const overview = vi.fn();
  const github = vi.fn();
  render(<Bound handlers={{ overview, github }} />);
  press("g");
  expect(overview).not.toHaveBeenCalled();
  press("o");
  expect(overview).toHaveBeenCalledTimes(1);
  expect(github).not.toHaveBeenCalled();
  press("o");
  expect(github).toHaveBeenCalledTimes(1);
  press("g");
  press("x");
  press("o");
  expect(github).toHaveBeenCalledTimes(2);
});

test("never while typing, in a dialog or a menu, or once switched off", () => {
  const nextTask = vi.fn();
  const view = render(<Bound handlers={{ nextTask }} />);
  press("j", {}, view.getByLabelText("field"));
  expect(nextTask).not.toHaveBeenCalled();

  const dialog = document.createElement("div");
  dialog.setAttribute("aria-modal", "true");
  document.body.append(dialog);
  press("j");
  expect(nextTask).not.toHaveBeenCalled();
  dialog.remove();

  setShortcutsOn(false);
  press("j");
  expect(nextTask).not.toHaveBeenCalled();
  expect(withKey("Stop", "stop")).toBe("Stop");
  setShortcutsOn(true);
  press("j");
  expect(nextTask).toHaveBeenCalledTimes(1);
});

test("Enter on a button is the button's; Enter elsewhere is the shortcut's", () => {
  const match = vi.fn();
  const view = render(<Bound handlers={{ match }} />);
  press("Enter", {}, view.getByRole("button"));
  expect(match).not.toHaveBeenCalled();
  press("Enter", { shiftKey: true });
  expect(match).toHaveBeenLastCalledWith(1, expect.anything());
});

test("a handler saying false lets the key go on", () => {
  render(<Bound handlers={{ github: () => false }} />);
  expect(press("o")).toBe(true);
  render(<Bound handlers={{ rerun: () => {} }} />);
  // Handled: its default is prevented.
  expect(press("r")).toBe(false);
});

test("the keys as the sheet and the tooltips name them", () => {
  expect(shownKeys("overview")).toEqual([["G"], "then", ["O"]]);
  expect(shownKeys("filter")).toEqual([["1"], "to", ["6"]]);
  expect(shownKeys("nextTask")).toEqual([["J"], "or", ["K"]]);
  expect(shownKeys("copy")).toEqual([["Ctrl", "Shift", "C"]]);
  expect(shownKeys("zoom")).toEqual([["+"], ["−"], ["0"]]);
  expect(shownKeys("pan")).toEqual([["Space"], "+ drag"]);
  expect(keyHint("stop")).toBe("Shift S");
  expect(keyHint("zoom", 1)).toBe("−");
  expect(withKey("Stop the run", "stop")).toBe("Stop the run (Shift S)");
  // Every shortcut is in one of the sheet's groups.
  expect(Object.values(SHORTCUTS).every((s) => s.label && s.keys.length)).toBe(true);
});
