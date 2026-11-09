import { fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { expect, test, vi } from "vitest";
import { RunDataPanel, RunDataSteps } from "./RunData";
import { parseRoute, formatRoute } from "./route";
import type { RunData, RunMetrics } from "./types";
const metrics: RunMetrics = {
  runs: 3,
  issues: 2,
  needsInput: 1,
  tokens: 400,
  usageRuns: 2,
  usageIssues: 2,
  fixes: 1,
  ciFixes: 0,
  findings: 2,
  reviewedPulls: 1,
  pullRequests: 2,
  merged: 2,
  unchanged: 1,
  changed: 0,
  unknownMerge: 1,
  mergedAfterFixes: 1,
  closed: 0,
};
const data: RunData = {
  options: {
    repo: ["acme/app", "acme/api"],
    agent: ["codex", "claude"],
    model: ["m"],
    effort: ["high", "xhigh"],
    user: ["alice", "unknown"],
  },
  total: metrics,
  groups: [],
  steps: [{ step: "work", ...metrics }],
};

test("filters reach the API and broad and strict success stay side by side", async () => {
  const fetcher = vi.fn(
    async (_url: string) => new Response(JSON.stringify(data), { status: 200 }),
  );
  vi.stubGlobal("fetch", fetcher);
  render(<RunDataPanel repo="acme/app" />);
  await screen.findByText("Merged unchanged / PRs");
  expect(screen.getByText("Merged / PRs")).toBeTruthy();
  expect(screen.getByText("2/2 (100%)")).toBeTruthy();
  expect(screen.getByText("1/2 (50%)")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Agent"), { target: { value: "codex" } });
  await waitFor(() => expect(String(fetcher.mock.calls.at(-1)?.[0])).toContain("agent=codex"));
  fireEvent.change(screen.getByLabelText("Period"), { target: { value: "all" } });
  await waitFor(() => expect(String(fetcher.mock.calls.at(-1)?.[0])).not.toContain("from="));
});

test("step details load only when opened, and report errors and empty periods", async () => {
  const fetcher = vi.fn(
    async () => new Response(JSON.stringify({ error: "Unavailable" }), { status: 503 }),
  );
  vi.stubGlobal("fetch", fetcher);
  const { container } = render(<RunDataSteps repo="acme/app" task="acme/app#1" />);
  expect(fetcher).not.toHaveBeenCalled();
  const details = container.querySelector("details")!;
  details.open = true;
  fireEvent(details, new Event("toggle"));
  expect((await screen.findByRole("alert")).textContent).toBe("Unavailable");
  fetcher.mockImplementation(
    async () =>
      new Response(JSON.stringify({ ...data, total: { ...metrics, runs: 0 } }), { status: 200 }),
  );
  fireEvent.click(screen.getByText("Refresh"));
  await screen.findByText("No recorded runs match these filters.");
});

test("run data's repository tab has a stable address", () => {
  const hash = "#/settings/repositories/acme/app/run-data";
  expect(formatRoute(parseRoute(hash))).toBe(hash);
});

test("a PR's step selector names its steps and shows that step's metrics", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ...data,
            steps: [
              {
                step: "review-fix",
                ...metrics,
                tokens: 20,
                runs: 1,
                issues: 1,
                usageRuns: 1,
                usageIssues: 1,
              },
            ],
          }),
          { status: 200 },
        ),
    ),
  );
  render(<RunDataPanel repo="acme/app" task="acme/app#1" />);
  await screen.findByText("Merged unchanged / PRs");
  // Named as the run history names it, in the interface's language.
  expect(screen.getByRole("option", { name: "Review fix" })).toBeTruthy();
  expect(screen.getByRole("rowheader", { name: "Review fix" })).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Step"), { target: { value: "review-fix" } });
  expect(screen.getByText("1 (1/1)")).toBeTruthy();
});
