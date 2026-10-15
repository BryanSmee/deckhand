// Each task's pull request: its badge in the list, its link in the detail, the "Ready for
// review" chip, and a notification when one turns ready (Notification mocked).
import { fireEvent, render, screen, within } from "@testing-library/preact";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Dashboard } from "./App";
import fixture from "./fixture.json";
import type { State, Task } from "./types";

const state = fixture as State;

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

beforeEach(() => {
  history.replaceState(null, "", "/");
  localStorage.clear();
  FakeNotification.permission = "granted";
  FakeNotification.shown = [];
  Object.assign(globalThis, {
    Notification: FakeNotification,
    EventSource: class {
      addEventListener() {}
      close() {}
    },
    matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
  });
});
afterEach(() => document.body.replaceChildren());

const KEY = "BryanSmee/deckhand#22";
// The state a later poll brings: #22's pull request turned ready at `readyAt`.
const withPr = (s: State, pr: Partial<NonNullable<Task["pr"]>>, now = s.now + 3000): State => ({
  ...s,
  now,
  tasks: s.tasks.map((t) => (t.key === KEY ? { ...t, pr: { ...t.pr!, ...pr } } : t)),
});

test("rows show their pull request's state; the detail links to it", () => {
  render(<Dashboard state={state} error={null} />);
  const row = screen.getByText("Dark mode for the settings page").closest("button")!;
  expect(within(row).getByText("Ready for review").title).toBe("Pull request #132");
  expect(screen.getAllByText("Merged")).toHaveLength(1);

  // #22 is open: its draft pull request, where it replies.
  const link = screen.getByRole("link", { name: "Pull request #25" });
  expect(link.getAttribute("href")).toBe("https://github.com/BryanSmee/deckhand/pull/25");
  expect(within(link.parentElement!).getByText("Draft")).toBeTruthy();
  expect(screen.queryByRole("link", { name: /Replies on/ })).toBeNull();
});

test("the Ready for review chip lists the pull requests waiting for a review", () => {
  render(<Dashboard state={state} error={null} />);
  fireEvent.click(screen.getByRole("button", { name: /^Ready for review/ }));
  const titles = within(screen.getByRole("list"))
    .getAllByRole("button")
    .map((b) => b.querySelector("span:nth-child(2)")!.textContent);
  expect(titles).toEqual(["Offline sync for the reading list", "Dark mode for the settings page"]);
});

test("the tab's title counts the pull requests ready for review", () => {
  const { rerender } = render(<Dashboard state={state} error={null} />);
  expect(document.title).toBe("(2) Deckhand");
  rerender(<Dashboard state={withPr(state, { state: "ready", readyAt: null })} error={null} />);
  expect(document.title).toBe("(3) Deckhand");
});

test("one notification when a pull request turns ready, none for those ready before", () => {
  const { rerender } = render(<Dashboard state={state} error={null} />);
  // Already ready when the page loaded: nothing.
  expect(FakeNotification.shown).toHaveLength(0);

  const ready = withPr(state, { state: "ready", readyAt: state.now + 1000 });
  rerender(<Dashboard state={ready} error={null} />);
  expect(FakeNotification.shown).toHaveLength(1);
  const [n] = FakeNotification.shown;
  expect(n.title).toBe(
    "Ready for review: Dashboard on a frontend framework, built at image build time",
  );
  expect(n.options.body).toBe("BryanSmee/deckhand · pull request #25");

  // The next polls: no second one.
  rerender(<Dashboard state={{ ...ready, now: ready.now + 3000 }} error={null} />);
  expect(FakeNotification.shown).toHaveLength(1);

  // Clicked: the pull request opens.
  const open = vi.spyOn(window, "open").mockImplementation(() => null);
  n.onclick!();
  expect(open).toHaveBeenCalledWith(
    "https://github.com/BryanSmee/deckhand/pull/25",
    "_blank",
    "noreferrer",
  );
  expect(n.close).toHaveBeenCalled();
});

test("ready before the page loaded, or found without a webhook: no notification", () => {
  const before = withPr(state, { state: "ready", readyAt: state.now - 1000 }, state.now);
  const { rerender } = render(<Dashboard state={before} error={null} />);
  rerender(<Dashboard state={{ ...before, now: before.now + 3000 }} error={null} />);
  rerender(<Dashboard state={withPr(state, { state: "ready", readyAt: null })} error={null} />);
  expect(FakeNotification.shown).toHaveLength(0);
});

test("notifications are asked for from a button, and not shown without permission", async () => {
  FakeNotification.permission = "default";
  const { rerender } = render(<Dashboard state={state} error={null} />);
  expect(FakeNotification.requestPermission).not.toHaveBeenCalled();
  rerender(
    <Dashboard state={withPr(state, { state: "ready", readyAt: state.now + 1 })} error={null} />,
  );
  expect(FakeNotification.shown).toHaveLength(0);

  fireEvent.click(screen.getByRole("button", { name: "Notify me" }));
  expect(FakeNotification.requestPermission).toHaveBeenCalledOnce();
  await vi.waitFor(() => expect(screen.queryByRole("button", { name: "Notify me" })).toBeNull());
});
