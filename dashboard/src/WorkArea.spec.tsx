// The graph's work area against a fake API: the backlog, and each drag's button.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Dashboard } from "./App";
import fixture from "./fixture.json";
import type { Backlog, State } from "./types";

const state = fixture as State;

const BACKLOG: Backlog = {
  issues: [
    {
      number: 31,
      title: "Export the run log",
      url: "https://github.example.com/acme/app/issues/31",
    },
    {
      number: 30,
      title: "Keyboard shortcuts",
      url: "https://github.example.com/acme/app/issues/30",
    },
  ],
  modes: ["work", "brainstorm", "review"],
  errors: false,
  readAt: 0,
};

let posted: unknown[];
let backlog: Backlog;
// Holds the work POST's answer until the test lets it go.
let hold: Promise<void> | null;
beforeEach(() => {
  posted = [];
  hold = null;
  backlog = BACKLOG;
  history.replaceState(null, "", "/");
  Object.assign(globalThis, {
    matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
  });
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (url === "api/repos/acme/app/issues") return Response.json(backlog);
    if (url === "api/repos/acme/app/work" && init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      posted.push(body);
      await hold;
      if (body.number === 30) return Response.json({ error: "#30 is closed." }, { status: 409 });
      return Response.json({ message: `#${body.number} done.` });
    }
    return new Response("{}", { status: 404 });
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

const open = (hash: string) => {
  history.replaceState(null, "", hash);
  render(<Dashboard state={state} error={null} />);
};

test("the All tab has no work area: a repo's tab has", () => {
  open("#/graph");
  expect(screen.queryByRole("region", { name: "Work area" })).toBeNull();
  expect(screen.getByText(/Open a repository's tab to start or queue/)).toBeTruthy();
});

test("the backlog lists the repo's open issues; Start sends the mode picked", async () => {
  open("#/graph/acme/app");
  const area = screen.getByRole("region", { name: "Work area" });
  await within(area).findByText("Export the run log");
  fireEvent.change(within(area).getByRole("combobox", { name: /Start in/ }), {
    target: { value: "brainstorm" },
  });
  fireEvent.click(within(area).getByRole("button", { name: "Start #31" }));
  await waitFor(() =>
    expect(posted).toEqual([{ action: "start", number: 31, mode: "brainstorm" }]),
  );
  expect(await within(area).findByRole("status")).toHaveProperty("textContent", "#31 done.");
  // A refusal is shown as the listener says it.
  fireEvent.click(within(area).getByRole("button", { name: "Start #30" }));
  expect(await within(area).findByText("#30 is closed.")).toBeTruthy();
});

test("Queue after…: the graph's issues to pick from", async () => {
  open("#/graph/acme/app");
  const area = screen.getByRole("region", { name: "Work area" });
  await within(area).findByText("Export the run log");
  const item = within(area).getByText("Export the run log").closest("li")!;
  fireEvent.click(within(item).getByRole("button", { name: "After…" }));
  const select = within(item).getByRole("combobox", { name: "Queue #31 after" });
  const options = within(select)
    .getAllByRole("option")
    .map((o) => o.textContent);
  expect(options).toContain("#24 Per-repo budgets in the dashboard");
  fireEvent.change(select, { target: { value: "24" } });
  fireEvent.click(within(item).getByRole("button", { name: "Queue" }));
  await waitFor(() => expect(posted).toEqual([{ action: "queue", number: 31, after: 24 }]));
});

test("a waiting issue: Remove cancels its wait, Start now keeps its mode", async () => {
  open("#/graph/acme/app");
  const waiting = screen.getByRole("list", { name: "Waiting issues" });
  expect(within(waiting).getByText("after #23, #22")).toBeTruthy();
  fireEvent.click(within(waiting).getByRole("button", { name: "Remove #24's wait" }));
  await waitFor(() => expect(posted).toEqual([{ action: "dequeue", number: 24 }]));
  fireEvent.click(within(waiting).getByRole("button", { name: "Start #24 now" }));
  await waitFor(() => expect(posted.at(-1)).toEqual({ action: "start", number: 24 }));
});

test("a config with errors: nothing to start", async () => {
  backlog = { ...BACKLOG, modes: [], errors: true };
  open("#/graph/acme/app");
  expect(await screen.findByText(/has errors: nothing starts/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Start #31" })).toHaveProperty("disabled", true);
});

test("a Start shows at once: a pending node, the issue out of the backlog; then the real one", async () => {
  let answer = () => {};
  hold = new Promise((resolve) => (answer = resolve));
  const refresh = vi.fn(async () => {});
  history.replaceState(null, "", "#/graph/acme/app");
  render(<Dashboard state={state} error={null} refresh={refresh} />);
  const area = screen.getByRole("region", { name: "Work area" });
  await within(area).findByText("Export the run log");
  fireEvent.click(within(area).getByRole("button", { name: "Start #31" }));
  // Before the listener answers.
  expect(within(area).queryByText("Export the run log")).toBeNull();
  const graph = screen.getByRole("list", { name: "Issues of acme/app" });
  const node = within(graph).getByRole("listitem", { name: /^#31 Export the run log: Sending…/ });
  expect(refresh).not.toHaveBeenCalled();
  // Answered: api/state is read again at once, and the pending node goes.
  answer();
  await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(node.isConnected).toBe(false));
});

test("a refused action: its pending node goes, the issue comes back, the error shows", async () => {
  let answer = () => {};
  hold = new Promise((resolve) => (answer = resolve));
  const refresh = vi.fn(async () => {});
  history.replaceState(null, "", "#/graph/acme/app");
  render(<Dashboard state={state} error={null} refresh={refresh} />);
  const area = screen.getByRole("region", { name: "Work area" });
  await within(area).findByText("Keyboard shortcuts");
  const item = within(area).getByText("Keyboard shortcuts").closest("li")!;
  fireEvent.click(within(item).getByRole("button", { name: "After…" }));
  fireEvent.change(within(item).getByRole("combobox", { name: "Queue #30 after" }), {
    target: { value: "24" },
  });
  fireEvent.click(within(item).getByRole("button", { name: "Queue" }));
  expect(within(area).queryByText("Keyboard shortcuts")).toBeNull();
  const graph = screen.getByRole("list", { name: "Issues of acme/app" });
  expect(
    within(graph).getByRole("listitem", {
      name: /^#30 Keyboard shortcuts: Sending…, waits for 1 issue$/,
    }),
  ).toBeTruthy();
  answer();
  expect(await within(area).findByText("#30 is closed.")).toBeTruthy();
  expect(within(area).getByText("Keyboard shortcuts")).toBeTruthy();
  expect(within(graph).queryByRole("listitem", { name: /Sending…/ })).toBeNull();
  expect(refresh).not.toHaveBeenCalled();
});
