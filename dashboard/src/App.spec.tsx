// The dashboard from a fixture api/state, with a fake EventSource for the log stream.
import { fireEvent, render, screen, within } from "@testing-library/preact";
import { afterEach, beforeEach, expect, test } from "vitest";
import { Dashboard } from "./App";
import fixture from "./fixture.json";
import type { Entry, State } from "./types";

const state = fixture as State;

class FakeSource {
  static last: FakeSource | null = null;
  listeners = new Map<string, ((e: { data: string }) => void)[]>();
  closed = false;
  constructor(public url: string) {
    FakeSource.last = this;
  }
  addEventListener(type: string, fn: (e: { data: string }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  close() {
    this.closed = true;
  }
  emit(type: string, data: unknown) {
    for (const fn of this.listeners.get(type) ?? []) fn({ data: JSON.stringify(data) });
  }
}

let wide = true;
beforeEach(() => {
  wide = true;
  history.replaceState(null, "", "/");
  localStorage.clear();
  FakeSource.last = null;
  Object.assign(globalThis, {
    EventSource: FakeSource,
    matchMedia: (query: string) => ({
      matches: query.includes("min-width") ? wide : false,
      addEventListener() {},
      removeEventListener() {},
    }),
  });
});
afterEach(() => document.body.replaceChildren());

const rows = () =>
  within(screen.getByRole("list"))
    .getAllByRole("button")
    .map((b) => b.querySelector("span:nth-child(2)")!.textContent);

test("the tasks with their titles, tabs per repo, and the first live one open", () => {
  render(<Dashboard state={state} error={null} />);
  expect(screen.getAllByRole("tab").map((t) => t.firstChild!.textContent)).toEqual([
    "All",
    "app",
    "api",
    "notes",
  ]);
  expect(rows()).toHaveLength(11);
  expect(rows()).toContain("How do runs restart after an update?");
  // No title known yet: the kind and number.
  expect(rows()).toContain("Issue #127");
  expect(screen.getByRole("heading", { level: 1, name: /Dashboard on a frontend/ })).toBeTruthy();
  expect(screen.getByText(/npm installs get a 403/)).toBeTruthy();
  expect(location.hash).toBe("#/all?task=acme%2Fapp%2322");
  expect(screen.getByText(/2 running \(max 4\) · 1 queued/)).toBeTruthy();
});

test("links go to the listener's GitHub", () => {
  render(<Dashboard state={state} error={null} />);
  expect(screen.getByRole("link", { name: "acme/app" }).getAttribute("href")).toBe(
    "https://github.example.com/acme/app",
  );
  expect(screen.getByRole("link", { name: /Dashboard on a frontend/ }).getAttribute("href")).toBe(
    "https://github.example.com/acme/app/issues/25",
  );
});

test("a repo's tab and the state chips filter the list", () => {
  render(<Dashboard state={state} error={null} />);
  fireEvent.click(screen.getByRole("tab", { name: /^api/ }));
  expect(location.hash).toMatch(/^#\/acme\/api/);
  expect(rows()).toEqual([
    "Offline sync for the reading list",
    "Search results flicker when typing fast",
    "Dark mode for the settings page",
    "Issue #127",
  ]);
  fireEvent.click(screen.getByRole("button", { name: /^Needs input/ }));
  expect(rows()).toEqual(["Search results flicker when typing fast"]);
  // Kept on this device.
  expect(localStorage.getItem("deckhand.chip")).toBe("input");
  expect(localStorage.getItem("deckhand.tab")).toBe("acme/api");
  fireEvent.click(screen.getByRole("button", { name: /^Done/ }));
  expect(rows()).toEqual(["Dark mode for the settings page"]);
});

test("a task waiting for other issues links them", () => {
  history.replaceState(null, "", "#/all?task=acme%2Fapp%2324");
  render(<Dashboard state={state} error={null} />);
  expect(
    screen.getByRole("heading", { level: 1, name: /Per-repo budgets in the dashboard/ }),
  ).toBeTruthy();
  expect(screen.getByText("after #23 and #22")).toBeTruthy();
  expect(screen.getByRole("link", { name: "#22" }).getAttribute("href")).toBe(
    "https://github.example.com/acme/app/issues/22",
  );
});

test("old links open their task and run", () => {
  history.replaceState(null, "", "#task=acme%2Fnotes%23discussion-8");
  render(<Dashboard state={state} error={null} />);
  expect(screen.getByRole("heading", { level: 1, name: /How do runs restart/ })).toBeTruthy();
  expect(FakeSource.last!.url).toBe("api/runs/acme-notes-discussion-8-1791896400000/stream");
});

test("on a phone: the list, then the task with a way back", () => {
  wide = false;
  const { container } = render(<Dashboard state={state} error={null} />);
  expect(screen.queryByRole("heading", { level: 1, name: /Dashboard on/ })).toBeNull();
  fireEvent.click(screen.getByText("Bugs"));
  expect(screen.getByRole("heading", { level: 1, name: /Bugs/ })).toBeTruthy();
  expect(container.firstElementChild!.className).toMatch(/reading/);
  fireEvent.click(screen.getByRole("button", { name: "← Back" }));
  expect(container.firstElementChild!.className).not.toMatch(/reading/);
});

test("the log streams in: tool calls with their output, then the result", async () => {
  render(<Dashboard state={state} error={null} />);
  const source = FakeSource.last!;
  expect(source.url).toBe("api/runs/acme-app-22-1791989580000/stream");
  const entries: Entry[] = [
    { kind: "meta", text: "Continuing the session" },
    { kind: "tool", name: "Bash", text: "npm test" },
    { kind: "output", text: "2 failed", error: true },
  ];
  source.emit("entries", entries);
  const log = await screen.findByTestId("log");
  await within(log).findByText("npm test");
  // A failed tool call is open.
  expect(within(log).getByText("2 failed").closest("details")!.open).toBe(true);
  source.emit("entries", [
    { kind: "result", status: "needs-input", minutes: 3, text: "<!-- needs-input -->\nWhich one?" },
  ]);
  await within(log).findByText("Needs input in 3 min");
  expect(log.textContent).not.toContain("<!--");
  source.emit("end", {});
  expect(source.closed).toBe(true);

  // Another run of the task: a new stream, the old one closed.
  fireEvent.click(screen.getByRole("button", { name: /Start · 2 h ago/ }));
  expect(FakeSource.last).not.toBe(source);
  expect(FakeSource.last!.url).toMatch(/acme-app-22-1791984600000/);
  expect(location.hash).toMatch(/run=acme-app-22-1791984600000/);
});

test("signed out of reach: the error instead of the counts", () => {
  render(<Dashboard state={null} error="502" />);
  expect(screen.getByText("Can't reach the listener (502)")).toBeTruthy();
});

test("an issue waiting for answers without a run: listed under Needs input, no log", () => {
  const filed = {
    ...state.tasks.find((t) => t.key === "acme/notes#4")!,
    key: "acme/notes#9",
    number: 9,
    replyTo: 9,
    title: "Tags for notes",
    kind: "issue" as const,
    mode: null,
    state: "needs-input" as const,
    since: state.now - 2 * 3600000,
    pr: null,
    runs: [],
  };
  history.replaceState(null, "", "#/all?task=acme%2Fnotes%239");
  render(<Dashboard state={{ ...state, tasks: [...state.tasks, filed] }} error={null} />);
  fireEvent.click(screen.getByRole("button", { name: /^Needs input/ }));
  expect(rows()).toContain("Tags for notes");
  expect(screen.getByRole("heading", { level: 1, name: /Tags for notes/ })).toBeTruthy();
  expect(screen.getByText(/Waiting for answers to its open questions/)).toBeTruthy();
  const row = screen.getByRole("button", { name: /Tags for notes/ });
  expect(row.textContent).toContain("2 h ago");
});
