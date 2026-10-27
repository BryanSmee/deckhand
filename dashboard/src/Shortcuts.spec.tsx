// The keyboard shortcuts on their pages (keys.ts): everywhere, on the tasks, in a run's log and
// on the board; never while typing; the `?` sheet lists the registry; they can be switched off.
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { beforeEach, expect, test, vi } from "vitest";
import type { RepoList } from "./api";
import { Dashboard } from "./App";
import { SHORTCUTS } from "./keys";
import { Log } from "./Log";
import { BACKLOG, makeState, mockApi } from "./testUtils";
import type { Backlog, Entry, Run } from "./types";

const state = makeState();
const noRepos: RepoList = {
  repos: [],
  app: null,
  listedAt: null,
  error: null,
  starting: null,
  failed: null,
  onboard: async () => {},
  refreshing: false,
  refreshError: null,
  refresh: async () => {},
  update: () => {},
};
const backlog: Backlog = {
  ...BACKLOG,
  issues: [
    {
      number: 31,
      title: "Rate-limit the API",
      url: "https://github.example.com/acme/app/issues/31",
    },
    { number: 33, title: "Retry webhooks", url: "https://github.example.com/acme/app/issues/33" },
  ],
};

let wide = true;
let api: ReturnType<typeof mockApi>;
beforeEach(() => {
  wide = true;
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("min-width") ? wide : false,
    addEventListener() {},
    removeEventListener() {},
  }));
  api = mockApi({
    "api/repos/acme/app/issues": () => backlog,
    "POST api/repos/acme/app/work": () => ({ message: "Started." }),
    "POST api/repos/acme/api/rerun": () => ({ message: "Rerun queued." }),
  });
});

const press = (key: string, init: KeyboardEventInit = {}, target: Element = document.body) =>
  fireEvent.keyDown(target, { key, ...init });
const show = (hash: string) => {
  history.replaceState(null, "", hash);
  return render(<Dashboard state={state} error={null} />);
};

test("?: the sheet lists exactly the registered shortcuts, by group", () => {
  show("#/");
  press("?", { shiftKey: true });
  const sheet = screen.getByRole("dialog", { name: "Keyboard shortcuts" });
  const groups = within(sheet)
    .getAllByRole("heading", { level: 3 })
    .map((h) => h.textContent);
  expect(groups).toEqual(["Everywhere", "Tasks", "Run log", "Board"]);
  const listed = [...sheet.querySelectorAll("dt")].map((dt) => dt.textContent);
  expect(listed).toEqual(Object.values(SHORTCUTS).map((s) => s.label));
  const row = [...sheet.querySelectorAll("dt")].find((dt) => dt.textContent === "Settings")!;
  expect(row.nextElementSibling!.textContent).toBe("GthenS");
  // Its own keys are quiet while it is open; Escape closes it.
  press("g");
  press("t");
  expect(location.hash).toBe("#/");
  press("Escape");
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("everywhere: G then O, T, B, S; N; Ctrl K; the sidebar; the theme", () => {
  show("#/acme/app");
  press("g");
  press("b");
  expect(location.hash).toBe("#/acme/app/board");
  press("g");
  press("t");
  expect(location.hash).toMatch(/^#\/acme\/app(\?|$)/);
  press("g");
  press("s");
  expect(location.hash).toBe("#/settings/repositories");
  press("g");
  press("o");
  expect(location.hash).toBe("#/");
  // All's tasks from the Overview.
  press("g");
  press("t");
  expect(location.hash).toBe("#/tasks?task=acme%2Fapp%2322");

  press("n");
  expect(screen.getByRole("dialog", { name: "New request" })).toBeTruthy();
  press("Escape");
  press("k", { ctrlKey: true });
  expect(screen.getByRole("dialog", { name: "Jump to" })).toBeTruthy();
  press("Escape", {}, screen.getByRole("combobox"));
  expect(screen.queryByRole("dialog")).toBeNull();

  press("T", { shiftKey: true });
  expect(localStorage.getItem("deckhand.theme")).toBe("light");
  expect(screen.getByRole("button", { name: "Light theme" }).getAttribute("aria-pressed")).toBe(
    "true",
  );
  press("T", { shiftKey: true });
  expect(document.documentElement.classList.contains("t-dark")).toBe(true);
  press("T", { shiftKey: true });
  expect(localStorage.getItem("deckhand.theme")).toBeNull();
  press("\\");
  expect(localStorage.getItem("deckhand.sidebar")).toBe("rail");
  expect(screen.getByRole("button", { name: "Expand the sidebar" })).toBeTruthy();
});

test("the sheet's link to Preferences closes it", () => {
  history.replaceState(null, "", "#/");
  render(<Dashboard state={state} error={null} repos={noRepos} />);
  press("?", { shiftKey: true });
  fireEvent.click(screen.getByRole("link", { name: "Turn them off in Preferences" }));
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("Esc: a repository's config goes back to the repositories", () => {
  history.replaceState(null, "", "#/settings/repositories/acme/app");
  render(<Dashboard state={state} error={null} repos={noRepos} />);
  press("Escape");
  expect(location.hash).toBe("#/settings/repositories");
  // Nowhere to go back to: the key goes on.
  expect(press("Escape")).toBe(true);
});

test("Esc: a phone's open task goes back to the list", () => {
  wide = false;
  show("#/acme/app?task=acme%2Fapp%2322");
  expect(screen.getByRole("heading", { level: 2, name: /Dashboard on a frontend/ })).toBeTruthy();
  press("Escape");
  expect(location.hash).toBe("#/acme/app");
});

test("tasks: / searches, J and K move, 1 to 6 filter, never while typing", () => {
  show("#/tasks");
  const current = () =>
    screen.getAllByRole("button", { current: true })[0].querySelector("span:nth-child(2)")!
      .textContent;
  expect(current()).toMatch(/Dashboard on a frontend/);
  press("j");
  expect(current()).toMatch(/Offline sync/);
  press("j");
  press("k");
  expect(current()).toMatch(/Offline sync/);
  press("3");
  expect(screen.getByRole("button", { name: /^Needs you/ }).getAttribute("aria-pressed")).toBe(
    "true",
  );
  press("1");
  press("/", {});
  const box = screen.getByRole("searchbox", { name: "Search tasks" });
  expect(document.activeElement).toBe(box);
  // Typed in the box: the box's.
  press("j", {}, box);
  press("2", {}, box);
  expect(current()).toMatch(/Offline sync/);
  const chips = within(screen.getByRole("group", { name: "State" }));
  expect(chips.getByRole("button", { name: /^All/ }).getAttribute("aria-pressed")).toBe("true");
});

test("tasks: O on GitHub, Shift S asks to stop, [ and ] through the runs", () => {
  const open = vi.spyOn(window, "open").mockReturnValue(null);
  show("#/acme/app?task=acme%2Fapp%2322");
  press("o");
  expect(open).toHaveBeenCalledWith(
    // Where it replies: its pull request's issue.
    "https://github.example.com/acme/app/issues/25",
    "_blank",
    "noreferrer",
  );
  press("]");
  expect(location.hash).toMatch(/&run=/);
  press("[");
  expect(location.hash).toBe("#/acme/app?task=acme%2Fapp%2322");
  press("S", { shiftKey: true });
  expect(screen.getByRole("alertdialog", { name: "Stop the run on #22?" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Stop" }).title).toMatch(/\(Shift S\)$/);
});

test("tasks: A goes to its questions, R reruns a failed run", async () => {
  show("#/acme/api?task=acme%2Fapi%23138");
  press("a");
  expect(
    within(screen.getByRole("form", { name: "Open questions" })).getAllByRole("radio"),
  ).toContain(document.activeElement);
  history.replaceState(null, "", "#/acme/api?task=acme%2Fapi%23127");
  fireEvent(window, new HashChangeEvent("hashchange"));
  await screen.findByRole("heading", { level: 2, name: "Issue #127" });
  press("r");
  await waitFor(() => expect(api.posted.map((p) => p.url)).toContain("api/repos/acme/api/rerun"));
});

test("switched off in Preferences: no key does anything until switched on again", () => {
  history.replaceState(null, "", "#/settings/preferences");
  render(<Dashboard state={state} error={null} repos={noRepos} />);
  const toggle = screen.getByRole("switch", { name: /Keyboard shortcuts/ });
  const settings = () => screen.getByRole("link", { name: "Settings" }).title;
  expect((toggle as HTMLInputElement).checked).toBe(true);
  expect(settings()).toBe("Settings (G then S)");
  fireEvent.click(toggle);
  expect(localStorage.getItem("deckhand.shortcuts")).toBe("0");
  // The tooltips already shown stop naming keys at once.
  expect(settings()).toBe("Settings");
  press("g");
  press("o");
  press("?", { shiftKey: true });
  expect(location.hash).toBe("#/settings/preferences");
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(toggle);
  press("g");
  press("o");
  expect(location.hash).toBe("#/");
});

// The log alone, streamed.
const run: Run = {
  id: "acme-app-19-1",
  key: "acme/app#19",
  kind: "issue",
  title: "Retries",
  repo: "acme/app",
  replyTo: 19,
  mode: "start",
  taskMode: "work",
  startedAt: 0,
  finishedAt: null,
  status: "running",
};
const entries: Entry[] = [
  { kind: "phase", phase: "setup", at: 0 },
  { kind: "meta", text: "Cloned acme/app" },
  { kind: "phase", phase: "work", at: 60000 },
  { kind: "text", text: "I'll add a retry." },
  { kind: "tool", name: "Bash", text: "node --test retry" },
  { kind: "output", text: "✖ retry once", error: true },
  { kind: "tool", name: "Bash", text: "node --test retry" },
  { kind: "output", text: "✖ retry twice", error: true },
];

test("run log: F, Enter and Shift Enter, E and Shift E, X and Shift X, L, Ctrl Shift C", async () => {
  // A page that scrolls, so following the end can be lost and found.
  const page = document.createElement("div");
  Object.defineProperty(document, "scrollingElement", { value: page, configurable: true });
  Object.defineProperties(page, {
    scrollHeight: { value: 1000, configurable: true },
    clientHeight: { value: 100, configurable: true },
  });
  const writeText = vi.fn(async () => {});
  vi.stubGlobal("navigator", { clipboard: { writeText }, platform: "" });
  render(<Log run={run} entries={entries} now={120000} />);

  press("f");
  const box = screen.getByRole("searchbox", { name: "Search this log" });
  expect(document.activeElement).toBe(box);
  fireEvent.input(box, { target: { value: "retry" } });
  box.blur();
  expect(screen.getByText("1 / 5")).toBeTruthy();
  press("Enter");
  expect(screen.getByText("2 / 5")).toBeTruthy();
  press("Enter", { shiftKey: true });
  press("Enter", { shiftKey: true });
  expect(screen.getByText("5 / 5")).toBeTruthy();
  fireEvent.input(box, { target: { value: "" } });
  box.blur();

  const folds = () => [...document.querySelectorAll("details")].map((d) => d.open);
  press("e");
  expect(folds().every(Boolean)).toBe(true);
  press("E", { shiftKey: true });
  expect(folds().some(Boolean)).toBe(false);
  press("x");
  const failed = () =>
    [...document.querySelectorAll<HTMLDetailsElement>("details[data-item]")].map((d) => d.open);
  expect(failed()).toEqual([true, false]);
  press("X", { shiftKey: true });
  expect(failed()[1]).toBe(true);

  page.scrollTop = 0;
  fireEvent.scroll(page);
  expect(screen.getByRole("button", { name: "Latest" })).toBeTruthy();
  press("l");
  expect(page.scrollTop).toBe(1000);
  expect(screen.queryByRole("button", { name: "Latest" })).toBeNull();

  press("C", { ctrlKey: true, shiftKey: true });
  await waitFor(() => expect(writeText).toHaveBeenCalledWith(expect.stringContaining("retry")));
  delete (document as { scrollingElement?: unknown }).scrollingElement;
});

test("board: the arrows move between cards, S starts, Q queues after, B brainstorms", async () => {
  show("#/acme/app/board");
  await screen.findByText("Rate-limit the API");
  press("ArrowDown");
  expect(document.activeElement?.textContent).toMatch(/#31/);
  press("ArrowDown");
  expect(document.activeElement?.textContent).toMatch(/#33/);
  press("ArrowUp");
  expect(document.activeElement?.textContent).toMatch(/#31/);
  press("q", {}, document.activeElement!);
  expect(screen.getByRole("dialog", { name: "Queue #31 after…" })).toBeTruthy();
  press("Escape", {}, within(screen.getByRole("dialog")).getByRole("combobox"));
  press("b", {}, document.activeElement!);
  await waitFor(() =>
    expect(api.bodies().at(-1)).toEqual({ action: "start", number: 31, mode: "brainstorm" }),
  );
  // Once the brainstorm is on its way, the buttons are back.
  await waitFor(() =>
    expect((screen.getByRole("button", { name: "Start #33" }) as HTMLButtonElement).disabled).toBe(
      false,
    ),
  );
  expect(screen.getByRole("button", { name: "Start #33" }).title).toBe("Start (S)");
  // Back in the backlog (no state read again): its card again first.
  press("ArrowDown");
  press("ArrowDown");
  expect(document.activeElement?.textContent).toMatch(/#33/);
  press("s", {}, document.activeElement!);
  await waitFor(() => expect(api.bodies().at(-1)).toEqual({ action: "start", number: 33 }));
});

test("board: Enter opens the selected card's task, else its issue on GitHub", async () => {
  show("#/acme/app/board");
  await screen.findByText("Rate-limit the API");
  // A backlog issue has no task yet: its link, to GitHub.
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  press("ArrowDown");
  press("Enter", {}, document.activeElement!);
  expect(click.mock.contexts[0]).toHaveProperty(
    "href",
    "https://github.example.com/acme/app/issues/31",
  );
  // A waiting issue's card: its task, here.
  fireEvent.click(screen.getByRole("tab", { name: /^Waiting/ }));
  press("ArrowDown");
  expect(document.activeElement?.textContent).toMatch(/#24/);
  press("Enter", {}, document.activeElement!);
  expect(location.hash).toBe("#/acme/app?task=acme%2Fapp%2324");
  click.mockRestore();
});

test("board: V switches the view, C shows closed, + − 0 zoom, Space and a drag pan", async () => {
  show("#/acme/app/board");
  await screen.findByText("Rate-limit the API");
  const zoom = () => screen.getByRole("button", { name: /^Zoom \d+%/ }).textContent;
  press("+", { shiftKey: true });
  press("=");
  expect(zoom()).toBe("120%");
  press("-");
  expect(zoom()).toBe("110%");
  press("0");
  expect(zoom()).toBe("100%");

  const canvas = screen.getByLabelText("What waits for what");
  press(" ");
  fireEvent.pointerDown(canvas, { button: 0, clientX: 200, clientY: 200 });
  act(() => {
    window.dispatchEvent(new PointerEvent("pointermove", { clientX: 150, clientY: 180 }));
  });
  expect(canvas.scrollLeft).toBe(50);
  expect(canvas.scrollTop).toBe(20);
  act(() => {
    window.dispatchEvent(new PointerEvent("pointerup"));
  });
  fireEvent.keyUp(document.body, { key: " " });

  press("c");
  expect((screen.getByRole("switch", { name: "Show closed" }) as HTMLInputElement).checked).toBe(
    true,
  );
  press("v");
  expect(
    within(screen.getByRole("group", { name: "Board view" }))
      .getByRole("button", { name: "Lanes" })
      .getAttribute("aria-pressed"),
  ).toBe("true");
  // No zoom on the lanes.
  expect(screen.queryByRole("button", { name: /^Zoom \d+%/ })).toBeNull();
});
