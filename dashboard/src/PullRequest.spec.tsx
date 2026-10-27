// Each task's pull request: its badge in the list, its link in the detail, the "Ready for
// review" chip, and a notification when one turns ready (Notification mocked).
import { fireEvent, render, screen, within } from "@testing-library/preact";
import { beforeEach, expect, test, vi } from "vitest";
import { Dashboard } from "./App";
import { makeState } from "./testUtils";
import type { State, Task } from "./types";

const state = makeState();

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
  FakeNotification.permission = "granted";
  FakeNotification.shown = [];
  vi.stubGlobal("Notification", FakeNotification);
});

const KEY = "acme/app#22";
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
  expect(link.getAttribute("href")).toBe("https://github.example.com/acme/app/pull/25");
  expect(within(link.parentElement!).getByText("Draft")).toBeTruthy();
  expect(screen.queryByRole("link", { name: /Replies on/ })).toBeNull();
});

test("a pull request Deckhand merged by itself says so on its row and in the detail", () => {
  const merged = withPr(state, { state: "merged", autoMerged: true });
  render(<Dashboard state={merged} error={null} />);
  const badges = screen.getAllByText("Merged by Deckhand");
  expect(badges.length).toBeGreaterThanOrEqual(1);
  expect(badges[0].title).toBe("Pull request #25, merged by Deckhand with no human review");
  // A maintainer's merge stays "Merged".
  expect(screen.getAllByText("Merged")).toHaveLength(1);
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
  expect(n.options.body).toBe("acme/app · pull request #25");

  // The next polls: no second one.
  rerender(<Dashboard state={{ ...ready, now: ready.now + 3000 }} error={null} />);
  expect(FakeNotification.shown).toHaveLength(1);

  // Clicked: the pull request opens.
  const open = vi.spyOn(window, "open").mockImplementation(() => null);
  n.onclick!();
  expect(open).toHaveBeenCalledWith(
    "https://github.example.com/acme/app/pull/25",
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

  fireEvent.click(screen.getByRole("button", { name: "Notify me when ready" }));
  expect(FakeNotification.requestPermission).toHaveBeenCalledOnce();
  await vi.waitFor(() =>
    expect(screen.queryByRole("button", { name: "Notify me when ready" })).toBeNull(),
  );
});

test("the detail shows what the policies last decided about its pull request", () => {
  const decided: State = {
    ...state,
    tasks: state.tasks.map((t) =>
      t.key === KEY
        ? {
            ...t,
            decisions: [
              {
                decision: "merge",
                rule: "deny_merge",
                denied: true,
                messages: ["more than 400 changed lines", "labelled do-not-merge"],
                pr: 25,
                at: state.now - 60_000,
              },
              {
                decision: "review",
                rule: "deny_review",
                denied: false,
                messages: [],
                pr: 25,
                at: state.now - 3_600_000,
              },
            ],
          }
        : t,
    ),
  };
  render(<Dashboard state={decided} error={null} />);
  const section = screen.getByRole("region", { name: "Policy decisions" });
  const [merge, review] = within(section)
    .getAllByRole("listitem")
    .filter((li) => li.querySelector("span"));
  expect(merge.textContent).toContain("Denied");
  expect(merge.textContent).toContain("Auto-merge of #25");
  expect(within(merge).getByText("more than 400 changed lines")).toBeTruthy();
  expect(within(merge).getByText("labelled do-not-merge")).toBeTruthy();
  expect(review.textContent).toContain("Allowed");
  expect(review.textContent).toContain("Automatic review of #25 (deny_review)");
});

test("no policy decision: no section", () => {
  render(<Dashboard state={state} error={null} />);
  expect(screen.queryByRole("region", { name: "Policy decisions" })).toBeNull();
});
