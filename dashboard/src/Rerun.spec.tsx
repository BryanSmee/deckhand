// A task whose last run failed or was lost: the Rerun button on its page, for its latest run
// only, and what the listener says once it is pressed (fetch mocked).
import { fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { beforeEach, expect, test, vi } from "vitest";
import { Dashboard } from "./App";
import { makeState, mockApi } from "./testUtils";
import type { Task } from "./types";

const state = makeState();
const FAILED = "acme/api#127";

let api: ReturnType<typeof mockApi>;
let refresh: ReturnType<typeof vi.fn<() => Promise<void>>>;
beforeEach(() => {
  api = mockApi();
  api.answer = () => ({ message: "Rerun of #127 queued." });
  refresh = vi.fn<() => Promise<void>>(async () => {});
});

// The page of task `key`, run `run` picked if given, with the task changed by `change`.
const show = (key: string, change: (t: Task) => Task = (t) => t, run?: string) => {
  const query = `task=${encodeURIComponent(key)}${run ? `&run=${encodeURIComponent(run)}` : ""}`;
  history.replaceState(null, "", `#/?${query}`);
  const tasks = state.tasks.map((t) => (t.key === key ? change(t) : t));
  render(<Dashboard state={{ ...state, tasks }} error={null} refresh={refresh} />);
  return screen.queryByRole("button", { name: "Rerun" });
};

test("a failed task's latest run: Rerun, then the listener's answer and a fresh state", async () => {
  fireEvent.click(show(FAILED)!);
  await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Rerun queued."));
  expect(api.posted).toEqual([
    { url: "api/repos/acme/api/rerun", body: { runId: "acme-api-127-1791882000000" } },
  ]);
  expect(refresh).toHaveBeenCalledOnce();
});

test("a refusal is shown as the listener wrote it, and nothing is read again", async () => {
  api.answer = () => Response.json({ error: "#127 is closed." }, { status: 409 });
  fireEvent.click(show(FAILED)!);
  await waitFor(() => expect(screen.getByRole("status").textContent).toBe("#127 is closed."));
  expect(refresh).not.toHaveBeenCalled();
});

test("no Rerun when the listener says no: done, needs input, running, queued, another kind", () => {
  for (const key of ["acme/api#131", "acme/api#138", "acme/app#22", "acme/app#23", "acme/app#16"]) {
    expect(show(key), key).toBeNull();
    document.body.replaceChildren();
  }
});

const t0 = (key: string) => state.tasks.find((t) => t.key === key)!.runs[0].id;

test("no Rerun on an older run, even a failed one", () => {
  const older = (t: Task): Task => ({
    ...t,
    runs: [
      { ...t.runs[0], id: "acme-api-127-2" },
      { ...t.runs[0], status: "error" },
    ],
  });
  expect(show(FAILED, older, t0(FAILED))).toBeNull();
  document.body.replaceChildren();
  // The latest, picked in the list: it is there.
  expect(show(FAILED, older)).not.toBeNull();
});

const BUGS = "acme/app#16";

test("Dismiss on a failed task's page: posted for its last run, then a fresh state", async () => {
  api.answer = () => ({ message: "#16 dismissed." });
  show(BUGS);
  fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
  await waitFor(() =>
    expect(screen.getByRole("status").textContent).toBe("Dismissed: it no longer waits on you."),
  );
  expect(api.posted).toEqual([{ url: "api/repos/acme/app/dismiss", body: { runId: t0(BUGS) } }]);
  expect(refresh).toHaveBeenCalledOnce();
});

test("dismissed: who did it, and Undo; no Dismiss on a merged pull request's failure", async () => {
  const dismissed = (t: Task): Task => ({
    ...t,
    dismissed: { by: "bob", at: state.now - 120_000 },
  });
  show(BUGS, dismissed);
  expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
  expect(screen.getByText(/Dismissed by/).textContent).toMatch(
    /^Dismissed by @bob 2 min ago(?! ago)/,
  );
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  await waitFor(() =>
    expect(screen.getByRole("status").textContent).toBe("It waits on you again."),
  );
  expect(api.posted).toEqual([
    { url: "api/repos/acme/app/dismiss", body: { runId: t0(BUGS), undo: true } },
  ]);
  document.body.replaceChildren();
  // #127's pull request is merged: it asks for nothing already.
  show(FAILED);
  expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
});
