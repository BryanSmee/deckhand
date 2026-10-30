// A task's runs: every run a tab up to 3; past them, the latest and the one shown only, all of
// them in All runs (a popover on a desktop, a Sheet on a phone), numbered from the oldest; [
// and ] through every run; an old run from the URL as the viewed tab.
import { fireEvent, render, screen, within } from "@testing-library/preact";
import { beforeEach, expect, test, vi } from "vitest";
import { Dashboard } from "./App";
import { makeRuns, makeState, makeTask } from "./testUtils";
import type { PolicyDecision, Task } from "./types";

const KEY = "acme/app#70";
const base = makeState();
const ID = (k: number) => `acme-app-70-${k}`;

let wide = true;
beforeEach(() => {
  wide = true;
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("min-width") ? wide : false,
    addEventListener() {},
    removeEventListener() {},
  }));
});

// The task with `n` runs, the latest still going, opened on `run` if given.
const show = (n: number, run?: string, over: Partial<Task> = {}) => {
  const runs = makeRuns(KEY, n, base.now - (n + 1) * 3_600_000);
  const task = makeTask({ number: 70, runs, ...over });
  const q = `?task=${encodeURIComponent(KEY)}${run ? `&run=${run}` : ""}`;
  history.replaceState(null, "", `#/acme/app${q}`);
  const view = render(<Dashboard state={makeState({}, [task])} error={null} />);
  // The same task with a run more, started since.
  return () => {
    const more = makeRuns(KEY, n + 1, base.now - (n + 1) * 3_600_000);
    const next = { ...task, runs: more };
    view.rerender(<Dashboard state={makeState({}, [next])} error={null} />);
  };
};
const tabs = (name = "Runs") =>
  within(screen.getByRole("tablist", { name }))
    .getAllByRole("tab")
    .map((b) => b.textContent!.split(" ")[0]);
const allRuns = () => screen.queryByRole("button", { name: /^All runs/ });
const options = () => screen.getAllByRole("option");

test("1 run: its tab, numbered, no All runs", () => {
  show(1);
  expect(tabs()).toEqual(["#1"]);
  expect(allRuns()).toBeNull();
});

test("3 runs: a tab each, newest first", () => {
  show(3);
  expect(tabs()).toEqual(["#3", "#2", "#1"]);
  expect(allRuns()).toBeNull();
});

test("15 runs: the latest's tab and All runs, which lists them all, the oldest last", () => {
  show(15);
  expect(tabs()).toEqual(["#15"]);
  const button = allRuns()!;
  expect(button.textContent).toMatch(/^All runs 15/);
  expect(button.getAttribute("aria-haspopup")).toBe("listbox");
  fireEvent.click(button);
  expect(button.getAttribute("aria-expanded")).toBe("true");
  const list = screen.getByRole("listbox", { name: "All runs, newest first" });
  expect(options()).toHaveLength(15);
  expect(options()[0].textContent).toMatch(/^#15 +Continue/);
  expect(within(options()[0]).getByRole("img").getAttribute("aria-label")).toBe("Running");
  expect(options()[13].textContent).toMatch(/^#2 +Review fix · Continue .* · 10 min$/);
  expect(options()[14].textContent).toMatch(/^#1 +Start .* · 10 min$/);
  // The run shown is ticked, and focus starts on it.
  expect(options()[0].getAttribute("aria-selected")).toBe("true");
  expect(document.activeElement).toBe(options()[0]);
  expect(list.closest("[role=dialog]")).toBeNull();
});

test("picking the oldest: its tab beside the latest's, in the URL, focus back on All runs", () => {
  show(15);
  fireEvent.click(allRuns()!);
  fireEvent.click(options()[14]);
  expect(screen.queryByRole("listbox")).toBeNull();
  expect(location.hash).toMatch(new RegExp(`run=${ID(1)}$`));
  expect(tabs()).toEqual(["#15", "#1"]);
  expect(screen.getByRole("tab", { selected: true }).textContent).toMatch(/^#1 /);
  expect(document.activeElement).toBe(allRuns());
});

test("the menu's keys: arrows and End move, Enter picks, Escape closes", () => {
  show(15);
  fireEvent.click(allRuns()!);
  const list = screen.getByRole("listbox");
  fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
  expect(document.activeElement).toBe(options()[1]);
  fireEvent.keyDown(document.activeElement!, { key: "End" });
  expect(document.activeElement).toBe(options()[14]);
  fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
  fireEvent.keyDown(document.activeElement!, { key: "Enter" });
  expect(location.hash).toMatch(new RegExp(`run=${ID(2)}$`));
  expect(list.isConnected).toBe(false);
  fireEvent.click(allRuns()!);
  expect(options()[13].getAttribute("aria-selected")).toBe("true");
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  expect(screen.queryByRole("listbox")).toBeNull();
  expect(document.activeElement).toBe(allRuns());
  // Tab too: the popover isn't modal.
  fireEvent.click(allRuns()!);
  fireEvent.keyDown(document.activeElement!, { key: "Tab" });
  expect(screen.queryByRole("listbox")).toBeNull();
  // A click elsewhere closes it too.
  fireEvent.click(allRuns()!);
  fireEvent.pointerDown(document.body);
  expect(screen.queryByRole("listbox")).toBeNull();
});

test("a run starting while the list is open: Enter still picks the row focused", () => {
  const started = show(15);
  fireEvent.click(allRuns()!);
  fireEvent.keyDown(document.activeElement!, { key: "End" });
  fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
  expect(document.activeElement!.textContent).toMatch(/^#2 /);
  started();
  expect(options()).toHaveLength(16);
  expect(document.activeElement!.textContent).toMatch(/^#2 /);
  expect((document.activeElement as HTMLElement).tabIndex).toBe(0);
  fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
  expect(document.activeElement!.textContent).toMatch(/^#1 /);
  fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
  fireEvent.keyDown(document.activeElement!, { key: "Enter" });
  expect(location.hash).toMatch(new RegExp(`run=${ID(2)}$`));
});

test("a scroll that moves All runs (a live log following its end): the list moves with it", () => {
  show(15);
  const button = allRuns()!;
  // The task's page, which scrolls: the box the button is in.
  const page = button.closest("header")!.parentElement!;
  const rect = (top: number, bottom: number, left = 0) =>
    ({ top, bottom, left, right: left + 100, width: 100, height: bottom - top }) as DOMRect;
  page.getBoundingClientRect = () => rect(0, 800);
  button.getBoundingClientRect = () => rect(200, 238, 300);
  fireEvent.click(button);
  const popup = screen.getByRole("listbox").parentElement!;
  expect(popup.style.top).toBe("242px");
  button.getBoundingClientRect = () => rect(180, 218, 300);
  fireEvent.scroll(page);
  expect(screen.getByRole("listbox")).toBeTruthy();
  expect(popup.style.top).toBe("222px");
  // Scrolled out of view: it closes rather than float over the log.
  button.getBoundingClientRect = () => rect(-50, -12, 300);
  fireEvent.scroll(page);
  expect(screen.queryByRole("listbox")).toBeNull();
});

test("a short window: the list fits the room below its button, else opens above it", () => {
  const rect = (top: number, bottom: number) =>
    ({ top, bottom, left: 300, right: 400, width: 100, height: bottom - top }) as DOMRect;
  const open = (innerHeight: number, top: number) => {
    vi.stubGlobal("innerHeight", innerHeight);
    const button = allRuns()!;
    button.getBoundingClientRect = () => rect(top, top + 38);
    fireEvent.click(button);
    return screen.getByRole("listbox").parentElement!;
  };
  show(15);
  // 900 px high, the button at 250: the list's whole 420 px fit below.
  let popup = open(900, 250);
  expect([popup.style.top, popup.style.maxHeight]).toEqual(["292px", "420px"]);
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  // 600 px: 300 px left below, so #1 at the bottom stays on screen.
  popup = open(600, 250);
  expect([popup.style.top, popup.style.maxHeight]).toEqual(["292px", "300px"]);
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  // 450 px: 150 px below, 238 above: above it.
  popup = open(450, 250);
  expect(popup.style.maxHeight).toBe("238px");
  expect(parseFloat(popup.style.top)).toBeLessThanOrEqual(246);
});

test("[ and ] go through every run, those without a tab too", () => {
  show(15);
  fireEvent.keyDown(document.body, { key: "]" });
  expect(location.hash).toMatch(new RegExp(`run=${ID(14)}$`));
  expect(tabs()).toEqual(["#15", "#14"]);
  fireEvent.keyDown(document.body, { key: "]" });
  expect(tabs()).toEqual(["#15", "#13"]);
  fireEvent.keyDown(document.body, { key: "[" });
  fireEvent.keyDown(document.body, { key: "[" });
  expect(location.hash).not.toMatch(/run=/);
  expect(tabs()).toEqual(["#15"]);
});

test("an old run from the URL is the viewed tab", () => {
  show(15, ID(3));
  expect(tabs()).toEqual(["#15", "#3"]);
  expect(screen.getByRole("tab", { selected: true }).textContent).toMatch(/^#3 /);
});

test("on a phone, All runs opens in a Sheet", () => {
  wide = false;
  show(15);
  fireEvent.click(allRuns()!);
  const sheet = screen.getByRole("dialog", { name: "All runs" });
  expect(within(sheet).getAllByRole("option")).toHaveLength(15);
  fireEvent.click(within(sheet).getAllByRole("option")[14]);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(location.hash).toMatch(new RegExp(`run=${ID(1)}$`));
});

test("with a Policies tab: All runs last, outside the tablist; a pick keeps it", () => {
  const decision: PolicyDecision = {
    decision: "merge",
    rule: "deny_merge",
    denied: true,
    messages: ["too big"],
    pr: 71,
    at: base.now - 60_000,
  };
  show(15, undefined, { decisions: [decision] });
  const list = screen.getByRole("tablist", { name: "Runs and policies" });
  expect(tabs("Runs and policies")).toEqual(["#15", "Policies"]);
  const button = allRuns()!;
  expect(list.contains(button)).toBe(false);
  fireEvent.click(button);
  fireEvent.click(options()[14]);
  expect(tabs("Runs and policies")).toEqual(["#15", "#1", "Policies"]);
  // The same button, focused again: not one mounted anew.
  expect(allRuns()).toBe(button);
  expect(document.activeElement).toBe(button);
});
