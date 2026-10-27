// A run in fast mode (listener/agents/select.mjs speedFor()): "fast" by its model on the task's
// page, and in the list of its runs, so the operator sees which runs cost more.
import { render, screen } from "@testing-library/preact";
import { expect, test } from "vitest";
import { Dashboard } from "./App";
import { makeState } from "./testUtils";
import type { Task } from "./types";

const state = makeState();
const KEY = "acme/api#127";

const show = (change: (t: Task) => Task) => {
  history.replaceState(null, "", `#/?task=${encodeURIComponent(KEY)}`);
  const tasks = state.tasks.map((t) => (t.key === KEY ? change(t) : t));
  render(<Dashboard state={{ ...state, tasks }} error={null} refresh={async () => {}} />);
};

test("a fast run says fast by its model and in the list of runs; a normal one doesn't", () => {
  show((t) => ({
    ...t,
    runs: [
      { ...t.runs[0], speed: "fast" },
      { ...t.runs[0], id: "acme-api-127-1", speed: "normal" },
    ],
  }));
  expect(screen.getByText(/, high effort/).textContent).toMatch(/high effort · fast$/);
  const runs = screen.getAllByRole("button", { name: /·/ }).map((b) => b.textContent);
  expect(runs.filter((text) => / · fast · /.test(text ?? ""))).toHaveLength(1);
});

test("a run from before speeds, or a normal one: no fast", () => {
  show((t) => ({ ...t, runs: [{ ...t.runs[0], speed: null }] }));
  expect(screen.queryByText(/· fast/)).toBeNull();
});
