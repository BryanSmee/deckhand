// Settings › Preferences: each choice kept in this browser, read at load and applied at once
// (the root's classes, the board, the start page, the shortcuts), public/theme.js setting the
// same classes before the first paint, and the three notifications (Notification stubbed).
import { act, fireEvent, render, screen, within } from "@testing-library/preact";
import { beforeEach, expect, onTestFinished, test, vi } from "vitest";
import early from "../public/theme.js?raw";
import type { RepoList } from "./api";
import { Dashboard } from "./App";
import { applyPrefs, followPrefs, setPref } from "./prefs";
import { makeState } from "./testUtils";
import type { State, Task } from "./types";

const state = makeState();

const repos = (): RepoList => ({
  repos: [],
  app: null,
  error: null,
  starting: null,
  failed: null,
  onboard: async () => {},
  listedAt: null,
  refreshing: false,
  refreshError: null,
  refresh: async () => {},
  update: () => {},
});

class FakeNotification {
  static permission: NotificationPermission = "granted";
  static requestPermission = vi.fn(async () => "granted" as NotificationPermission);
  static shown: FakeNotification[] = [];
  onclick: (() => void) | null = null;
  close = vi.fn();
  constructor(
    public title: string,
    public options: NotificationOptions,
  ) {
    FakeNotification.shown.push(this);
  }
}

// A device whose settings (dark, reduced motion) are `prefers`, telling who listens when
// they change; wide unless `phone`.
function device(prefers: { dark?: boolean; reduce?: boolean; phone?: boolean } = {}) {
  const listeners: (() => void)[] = [];
  const settings = { dark: true, reduce: false, phone: false, ...prefers };
  vi.stubGlobal("matchMedia", (query: string) => ({
    get matches() {
      if (query.includes("min-width")) return !settings.phone;
      if (query.includes("color-scheme")) return settings.dark;
      return settings.reduce;
    },
    addEventListener: (_: string, fn: () => void) => listeners.push(fn),
    removeEventListener() {},
  }));
  return (next: Partial<typeof settings>) => {
    Object.assign(settings, next);
    listeners.forEach((fn) => fn());
  };
}

const root = document.documentElement;
const classes = () => [...root.classList].sort();

beforeEach(() => {
  root.className = "";
  device();
  FakeNotification.permission = "granted";
  FakeNotification.shown = [];
  FakeNotification.requestPermission.mockClear();
  vi.stubGlobal("Notification", FakeNotification);
});

const showPreferences = (s: State = state) => {
  history.replaceState(null, "", "#/settings/preferences");
  return render(<Dashboard state={s} error={null} repos={repos()} />);
};
// The page's, not the sidebar's (its theme switch is a group "Theme" too).
const group = (name: string) => {
  const page = screen.queryByRole("main") ?? document.body;
  return within(within(page).getByRole("group", { name }));
};
const pressed = (name: string) =>
  group(name)
    .getAllByRole("button")
    .find((b) => b.getAttribute("aria-pressed") === "true")?.textContent;

test("four groups, and a note that they're kept in this browser", () => {
  showPreferences();
  const page = within(screen.getByRole("main"));
  expect(page.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual([
    "Appearance",
    "Notifications",
    "Board and run log",
    "Keyboard and account",
  ]);
  expect(screen.getByText(/Kept in this browser, not on the server/)).toBeTruthy();
  const signOut = page.getByRole("button", { name: "Sign out" }).closest("form")!;
  expect(signOut.getAttribute("action")).toBe("auth/logout");
  expect(page.getByText("Signed in as @octocat")).toBeTruthy();
});

test("Theme, Density and Motion: the root's classes at once, kept, and read at load", () => {
  applyPrefs();
  expect(classes()).toEqual(["t-dark"]);
  const view = showPreferences();
  fireEvent.click(group("Theme").getByRole("button", { name: "Light" }));
  fireEvent.click(group("Density").getByRole("button", { name: "Compact" }));
  fireEvent.click(group("Motion").getByRole("button", { name: "Reduced" }));
  expect(classes()).toEqual(["d-compact", "m-reduced", "t-light"]);
  // The sidebar's switch is the same choice.
  const sidebar = within(screen.getByRole("complementary", { name: "Deckhand" }));
  expect(sidebar.getByRole("button", { name: "Light theme" }).getAttribute("aria-pressed")).toBe(
    "true",
  );
  fireEvent.click(sidebar.getByRole("button", { name: "Dark theme" }));
  expect(pressed("Theme")).toBe("Dark");
  expect(localStorage.getItem("deckhand.theme")).toBe("dark");
  expect(localStorage.getItem("deckhand.density")).toBe("compact");
  expect(localStorage.getItem("deckhand.motion")).toBe("reduced");

  view.unmount();
  showPreferences();
  expect([pressed("Theme"), pressed("Density"), pressed("Motion")]).toEqual([
    "Dark",
    "Compact",
    "Reduced",
  ]);
  // Back to the defaults: nothing kept.
  fireEvent.click(group("Density").getByRole("button", { name: "Comfortable" }));
  fireEvent.click(group("Motion").getByRole("button", { name: "System" }));
  expect(localStorage.getItem("deckhand.density")).toBeNull();
  expect(localStorage.getItem("deckhand.motion")).toBeNull();
  expect(classes()).toEqual(["t-dark"]);
});

test("on System, the device's settings switch the page; Full and Light stay put", () => {
  const change = device({ dark: false, reduce: false });
  onTestFinished(followPrefs());
  expect(classes()).toEqual(["t-light"]);
  change({ dark: true, reduce: true });
  expect(classes()).toEqual(["m-reduced", "t-dark"]);
  setPref("motion", "full");
  setPref("theme", "light");
  change({ dark: true, reduce: true });
  expect(classes()).toEqual(["t-light"]);
});

test("another tab's change shows here", () => {
  showPreferences();
  onTestFinished(followPrefs());
  localStorage.setItem("deckhand.density", "compact");
  act(() => {
    dispatchEvent(new StorageEvent("storage", { key: "deckhand.density" }));
  });
  expect(pressed("Density")).toBe("Compact");
  expect(classes()).toContain("d-compact");
});

test("before the first paint, public/theme.js sets the same classes", () => {
  for (const [kept, prefers] of [
    [{}, { dark: true, reduce: true }],
    [{}, { dark: false, reduce: false }],
    [
      { theme: "light", density: "compact", motion: "full" },
      { dark: true, reduce: true },
    ],
    [
      { theme: "dark", motion: "reduced" },
      { dark: false, reduce: false },
    ],
  ] as const) {
    localStorage.clear();
    for (const [name, value] of Object.entries(kept))
      localStorage.setItem(`deckhand.${name}`, value);
    device(prefers);
    root.className = "";
    new Function(early)();
    const before = classes();
    root.className = "";
    applyPrefs();
    expect(before).toEqual(classes());
  }
});

test("Open on: the repository open last, or every repository's", () => {
  localStorage.setItem("deckhand.tab", "acme/api");
  const view = render(<Dashboard state={state} error={null} repos={repos()} />);
  expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("acme/api");
  view.unmount();

  const page = showPreferences();
  const field = screen.getByRole("combobox", { name: "Open on" }) as HTMLSelectElement;
  expect(field.value).toBe("last");
  fireEvent.change(field, { target: { value: "overview" } });
  expect(localStorage.getItem("deckhand.openOn")).toBe("overview");
  leave(page);
  render(<Dashboard state={state} error={null} repos={repos()} />);
  expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("All repositories");
});

// The page left, the address emptied: a later visit.
function leave(view: { unmount: () => void }) {
  view.unmount();
  history.replaceState(null, "", "/");
}

test("Board on a phone: Lanes unless Graph is picked, here or on the board", () => {
  device({ phone: true });
  setPref("phoneBoard", "graph");
  history.replaceState(null, "", "#/acme/app/board");
  const view = render(<Dashboard state={state} error={null} repos={repos()} />);
  expect(pressed("Board view")).toMatch(/Graph/);
  fireEvent.click(group("Board view").getByRole("button", { name: /Lanes/ }));
  expect(localStorage.getItem("deckhand.phoneBoard")).toBeNull();
  view.unmount();
  showPreferences();
  expect(pressed("Board on a phone")).toBe("Lanes");
});

test("the switches: Show closed is the board's, the shortcuts turn / off", () => {
  const page = showPreferences();
  const closed = screen.getByRole("switch", { name: "Show closed issues on the board" });
  expect((closed as HTMLInputElement).checked).toBe(false);
  expect(closed.getAttribute("aria-describedby")).toBeTruthy();
  fireEvent.click(closed);
  expect(localStorage.getItem("deckhand.graphClosed")).toBe("1");
  fireEvent.click(screen.getByRole("switch", { name: "Keyboard shortcuts" }));
  expect(localStorage.getItem("deckhand.shortcuts")).toBe("0");
  leave(page);

  render(<Dashboard state={state} error={null} repos={repos()} />);
  const search = screen.getByRole("searchbox", { name: "Search tasks" });
  fireEvent.keyDown(window, { key: "/" });
  expect(document.activeElement).not.toBe(search);
  act(() => setPref("shortcuts", true));
  fireEvent.keyDown(window, { key: "/" });
  expect(document.activeElement).toBe(search);
});

test("notifications: the browser's permission, asked from here, and a test", async () => {
  FakeNotification.permission = "default";
  showPreferences();
  expect(screen.getByText("Not allowed yet: this browser asks first.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Allow notifications" }));
  expect(FakeNotification.requestPermission).toHaveBeenCalledOnce();
  FakeNotification.permission = "granted";
  await screen.findByText("Allowed in this browser.");
  fireEvent.click(screen.getByRole("button", { name: "Send a test" }));
  expect(FakeNotification.shown.map((n) => n.options.body)).toEqual([
    "Notifications work in this browser.",
  ]);
});

test("notifications: a blocked or missing permission says so", () => {
  FakeNotification.permission = "denied";
  const view = showPreferences();
  expect(screen.getByText("Blocked in this browser's site settings.")).toBeTruthy();
  expect((screen.getByRole("button", { name: "Send a test" }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  view.unmount();
  vi.stubGlobal("Notification", undefined);
  showPreferences();
  expect(screen.getByText("This browser doesn't show them.")).toBeTruthy();
});

// The state a later poll brings: the tasks `changes` names changed.
const later = (s: State, changes: Record<string, Partial<Task>>, by = 3000): State => ({
  ...s,
  now: s.now + by,
  tasks: s.tasks.map((t) => (changes[t.key] ? { ...t, ...changes[t.key] } : t)),
});

test("a run that needs answers notifies and opens its task; one already waiting doesn't", () => {
  const { rerender } = render(<Dashboard state={state} error={null} />);
  // #138 already needed answers, #20's brainstorm already waited: nothing on the next poll.
  const asks = later(state, { "acme/app#22": { state: "needs-input" } });
  rerender(<Dashboard state={asks} error={null} />);
  expect(FakeNotification.shown.map((n) => [n.title, n.options.body])).toEqual([
    [
      "Needs your answers: Dashboard on a frontend framework, built at image build time",
      "acme/app · open questions",
    ],
  ]);
  rerender(<Dashboard state={later(asks, {})} error={null} />);
  expect(FakeNotification.shown).toHaveLength(1);
  const focus = vi.spyOn(window, "focus").mockImplementation(() => {});
  FakeNotification.shown[0].onclick!();
  expect(focus).toHaveBeenCalled();
  expect(location.hash).toBe("#/acme/app?task=acme%2Fapp%2322");
});

test("a failed run notifies once turned on; each event can be turned off", () => {
  const { rerender } = render(<Dashboard state={state} error={null} />);
  // Off by default.
  const failed = later(state, { "acme/app#22": { state: "error" } });
  rerender(<Dashboard state={failed} error={null} />);
  expect(FakeNotification.shown).toHaveLength(0);

  act(() => {
    setPref("notifyFailed", true);
    setPref("notifyReady", false);
    setPref("notifyInput", false);
  });
  const next = later(failed, {
    "acme/app#23": { state: "interrupted" },
    "acme/app#24": { state: "needs-input" },
    "acme/app#22": { pr: { ...failed.tasks[0].pr!, state: "ready", readyAt: failed.now + 1 } },
  });
  rerender(<Dashboard state={next} error={null} />);
  expect(FakeNotification.shown.map((n) => [n.title, n.options.body])).toEqual([
    ["Run failed: Per-repo budgets for runs", "acme/app · Interrupted"],
  ]);
});
