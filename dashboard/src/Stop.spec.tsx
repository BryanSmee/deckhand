// A task with a run going on: the Stop button on its page, which asks once more before it
// stops the run, and what the listener says once it is pressed (fetch mocked).
import { fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { beforeEach, expect, test, vi } from "vitest";
import { Dashboard } from "./App";
import { makeState, mockApi } from "./testUtils";
import type { Task } from "./types";

const state = makeState();
const WORKING = "acme/app#22";

let api: ReturnType<typeof mockApi>;
let refresh: ReturnType<typeof vi.fn<() => Promise<void>>>;
beforeEach(() => {
  api = mockApi();
  api.answer = () => ({ message: "#22 stops." });
  refresh = vi.fn<() => Promise<void>>(async () => {});
});

// The page of task `key`, with the task changed by `change`; its Stop button, if any.
const show = (key: string, change: (t: Task) => Task = (t) => t) => {
  history.replaceState(null, "", `#/?task=${encodeURIComponent(key)}`);
  const tasks = state.tasks.map((t) => (t.key === key ? change(t) : t));
  render(<Dashboard state={{ ...state, tasks }} error={null} refresh={refresh} />);
  return screen.queryByRole("button", { name: "Stop" });
};

test("Stop asks once more, then stops the run and reads the state again", async () => {
  fireEvent.click(show(WORKING)!);
  // Nothing is sent on the first click.
  expect(api.posted).toEqual([]);
  fireEvent.click(screen.getByRole("button", { name: "Stop it now" }));
  await waitFor(() => expect(screen.getByRole("status").textContent).toBe("#22 stops."));
  expect(api.posted).toEqual([
    { url: "api/repos/acme/app/work", body: { action: "cancel", number: 22, pr: false } },
  ]);
  expect(refresh).toHaveBeenCalledOnce();
});

test("Keep running takes the confirmation back, nothing is sent", () => {
  fireEvent.click(show(WORKING)!);
  fireEvent.click(screen.getByRole("button", { name: "Keep running" }));
  expect(screen.getByRole("button", { name: "Stop" })).not.toBeNull();
  expect(screen.queryByRole("button", { name: "Stop it now" })).toBeNull();
  expect(api.posted).toEqual([]);
});

test("a pull request's task building its image: Stop says it is a pull request", async () => {
  fireEvent.click(show("acme/api#pr-141")!);
  fireEvent.click(screen.getByRole("button", { name: "Stop it now" }));
  await waitFor(() => expect(api.posted.length).toBe(1));
  expect(api.posted[0].body).toEqual({ action: "cancel", number: 141, pr: true });
});

test("a refusal is shown as the listener wrote it, and nothing is read again", async () => {
  api.answer = () =>
    Response.json({ error: "Nothing is running or queued on #22." }, { status: 409 });
  fireEvent.click(show(WORKING)!);
  fireEvent.click(screen.getByRole("button", { name: "Stop it now" }));
  await waitFor(() =>
    expect(screen.getByRole("status").textContent).toBe("Nothing is running or queued on #22."),
  );
  expect(refresh).not.toHaveBeenCalled();
});

test("no Stop when nothing runs: queued, waiting, done, failed, a discussion", () => {
  const keys = ["acme/app#23", "acme/app#24", "acme/api#131", "acme/api#127"];
  for (const key of keys) {
    expect(show(key), key).toBeNull();
    document.body.replaceChildren();
  }
  const working = (t: Task): Task => ({ ...t, state: "working" });
  expect(show("acme/notes#discussion-8", working)).toBeNull();
});

test("a stopped run: its own badge, and Rerun", () => {
  const cancelled = (t: Task): Task => ({
    ...t,
    state: "cancelled",
    rerunnable: true,
    runs: [{ ...t.runs[0], status: "cancelled", summary: "Stopped by @bryan" }],
  });
  expect(show("acme/api#127", cancelled)).toBeNull();
  expect(screen.getAllByText("Stopped").length).toBeGreaterThan(0);
  expect(screen.getByRole("button", { name: "Rerun" })).not.toBeNull();
});
