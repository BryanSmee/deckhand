// The Overview from the fixture's api/state: the totals, what waits on you and each row's
// action, and a card per repository.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { expect, test, vi } from "vitest";
import type { RepoList } from "./api";
import { Overview } from "./Overview";
import { makeState, mockApi } from "./testUtils";
import type { Repo, Task } from "./types";

// The fixture's, but #127's pull request is still a draft: its interrupted run waits on you (the
// fixture's merged one stops it asking, as the last tests show).
const fixture = makeState();
const OPEN = "acme/api#127";
const state = {
  ...fixture,
  tasks: fixture.tasks.map((t) =>
    t.key === OPEN ? { ...t, pr: { ...t.pr!, state: "draft" as const } } : t,
  ),
};
const github = "https://github.example.com";

const row = (repo: string, over: Partial<Repo> = {}): Repo => ({
  repo,
  url: `${github}/${repo}`,
  private: false,
  issues: true,
  status: "configured",
  issue: null,
  readAt: 0,
  autoMerge: false,
  ...over,
});

const list = (repos: Repo[], over: Partial<RepoList> = {}): RepoList => ({
  repos,
  app: null,
  listedAt: 0,
  error: null,
  starting: null,
  failed: null,
  onboard: async () => {},
  refreshing: false,
  refreshError: null,
  refresh: async () => {},
  update: () => {},
  ...over,
});

const needs = () =>
  within(screen.getByRole("region", { name: "Waiting on you" })).getAllByRole("listitem");

test("the totals count what their chip lists, each a link to All's tasks under it", () => {
  const onChip = vi.fn();
  render(<Overview state={state} github={github} onChip={onChip} />);
  const tiles = ["Running", "Needs you", "Ready for review", "Failed"].map((name) =>
    screen.getByRole("link", { name: new RegExp(`^${name}:`) }),
  );
  expect(tiles.map((t) => t.getAttribute("aria-label"))).toEqual([
    "Running: 2, of 4 slots · 1 queued",
    "Needs you: 3, 1 question · 1 brainstorm turn · 1 idle brainstorm",
    "Ready for review: 2, pull requests #141 and #132",
    "Failed: 2, 1 can be rerun",
  ]);
  expect(tiles.every((t) => t.getAttribute("href") === "#/tasks")).toBe(true);
  tiles.forEach((t) => fireEvent.click(t));
  expect(onChip.mock.calls.map((c) => c[0])).toEqual(["running", "input", "review", "error"]);
});

test("waiting on you: oldest first, each with its state, repo, age and action", () => {
  render(<Overview state={state} github={github} onChip={() => {}} />);
  expect(
    needs().map((li) => [
      li.querySelector("a")!.textContent,
      li.querySelectorAll("span")[0].textContent,
      within(li)
        .getAllByRole(/button|link/)
        .slice(1)
        .map((b) => b.textContent),
    ]),
  ).toEqual([
    // (Rerun and Dismiss have their pending labels too, hidden.)
    // No title: the number once.
    [
      "Issue #127",
      "Interrupted",
      [expect.stringMatching(/^Rerun/), expect.stringMatching(/^Dismiss/)],
    ],
    ["#16 Bugs", "Error", ["Open", expect.stringMatching(/^Dismiss/)]],
    ["#131 Dark mode for the settings page", "Ready for review", ["Review PR"]],
    ["#138 Search results flicker when typing fast", "Needs input", ["Answer"]],
    ["#20 Egress proxy: allow wildcard ports", "Your turn", ["Reply"]],
  ]);
  const [interrupted, failed, ready, , turn] = needs();
  expect(within(interrupted).getByText("acme/api")).toBeTruthy();
  expect(within(failed).getByText("8 h")).toBeTruthy();
  // The title opens the task in its repo's tasks; Open too, when it can't be rerun.
  expect(within(failed).getByRole("link", { name: "Open" }).getAttribute("href")).toBe(
    "#/acme/app?task=acme%2Fapp%2316",
  );
  expect(within(ready).getByRole("link", { name: "Review PR" }).getAttribute("href")).toBe(
    `${github}/acme/api/pull/132`,
  );
  // A brainstorm's turn is a comment on its issue.
  expect(within(turn).getByRole("link", { name: "Reply" }).getAttribute("href")).toBe(
    `${github}/acme/app/issues/20`,
  );
});

test("Answer opens the task's questions, and sends them as its page does", async () => {
  const api = mockApi({});
  api.answer = () => ({ message: "Answers posted on #138." });
  const refresh = vi.fn(async () => {});
  render(<Overview state={state} github={github} onChip={() => {}} refresh={refresh} />);
  fireEvent.click(within(needs()[3]).getByRole("button", { name: "Answer" }));
  const dialog = screen.getByRole("dialog", { name: "Answer #138" });
  fireEvent.click(within(dialog).getByRole("button", { name: /Send/ }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(api.posted[0].url).toBe("api/repos/acme/api/answer");
  expect(api.posted[0].body.number).toBe(138);
  expect(screen.getByText("Answers posted on #138.")).toBeTruthy();
  expect(refresh).toHaveBeenCalled();
});

test("Rerun queues the task's last run again, and says so", async () => {
  const api = mockApi({});
  const release = api.hold();
  render(<Overview state={state} github={github} onChip={() => {}} />);
  const button = within(needs()[0]).getByRole("button", { name: /Rerun/ });
  fireEvent.click(button);
  await waitFor(() => expect(button.getAttribute("aria-busy")).toBe("true"));
  expect(api.posted).toEqual([
    { url: "api/repos/acme/api/rerun", body: { runId: "acme-api-127-1791882000000" } },
  ]);
  release();
  await screen.findByText("Rerun of #127 (acme/api) queued.");
});

test("Dismiss: the row leaves once the listener says so, and the message says where to undo", async () => {
  const api = mockApi({});
  api.answer = () => ({ message: "#16 dismissed." });
  const refresh = vi.fn(async () => {});
  render(<Overview state={state} github={github} onChip={() => {}} refresh={refresh} />);
  fireEvent.click(within(needs()[1]).getByRole("button", { name: /Dismiss/ }));
  await screen.findByText("#16 (acme/app) dismissed: its task page can undo it.");
  expect(api.posted).toEqual([
    {
      url: "api/repos/acme/app/dismiss",
      body: { runId: state.tasks.find((t) => t.key === "acme/app#16")!.runs[0].id },
    },
  ]);
  expect(refresh).toHaveBeenCalled();
});

test("a failure on a merged pull request or closed issue, or dismissed, waits on no one", () => {
  const failed = (t: Task): Task =>
    t.key === "acme/app#16" ? { ...t, dismissed: { by: "alice", at: 1 } } : t;
  // The fixture's #127: its pull request merged since it was interrupted.
  const settled = { ...fixture, tasks: fixture.tasks.map(failed) };
  render(<Overview state={settled} github={github} onChip={() => {}} />);
  expect(needs().map((li) => li.querySelector("a")!.textContent)).not.toContain("Issue #127");
  expect(needs().map((li) => li.querySelector("a")!.textContent)).not.toContain("#16 Bugs");
  expect(screen.getByRole("link", { name: /^Failed:/ }).getAttribute("aria-label")).toBe(
    "Failed: 0, nothing failed",
  );
});

test("nothing waiting says so", () => {
  render(<Overview state={makeState({ tasks: [] })} github={github} onChip={() => {}} />);
  expect(screen.getByText("Nothing waits on you.")).toBeTruthy();
  expect(screen.getByText("No repository yet.")).toBeTruthy();
});

test("a card per repository: its status, tasks by state, backlog and lanes, and its board", () => {
  const repos = list([
    row("acme/api", { backlog: { count: 7, more: false, readAt: 0 } }),
    row("acme/app", { backlog: { count: 100, more: true, readAt: 0 } }),
    row("acme/notes", { status: "invalid" }),
    row("acme/infra", { status: "not-onboarded" }),
  ]);
  render(<Overview state={state} repos={repos} github={github} onChip={() => {}} />);
  const cards = within(screen.getByRole("region", { name: "Repositories" })).getAllByRole(
    "article",
  );
  // The sidebar's order, then the repos without a task.
  expect(cards.map((c) => c.querySelector("h3")!.textContent)).toEqual([
    "acme/app",
    "acme/api",
    "acme/notes",
    "acme/infra",
  ]);
  const [app, api, notes, infra] = cards;
  expect(within(app).getByText("Configured")).toBeTruthy();
  expect(within(app).getByRole("img").getAttribute("aria-label")).toBe(
    "1 running · 1 needs you · 1 failed · 2 queued",
  );
  expect(within(app).getByText("Backlog 100+ · 1 lane")).toBeTruthy();
  expect(within(app).getByRole("link", { name: "Open board" }).getAttribute("href")).toBe(
    "#/acme/app/board",
  );
  expect(within(app).getByRole("link", { name: "acme/app" }).getAttribute("href")).toBe(
    "#/acme/app",
  );
  expect(within(api).getByText("Backlog 7")).toBeTruthy();
  expect(within(notes).getByText("Config has errors")).toBeTruthy();
  expect(within(notes).getByRole("link", { name: "See config" }).getAttribute("href")).toBe(
    "#/settings/repositories/acme/notes",
  );
  expect(within(infra).getByText("No config yet")).toBeTruthy();
  expect(within(infra).getByText(/Onboarding opens a run/)).toBeTruthy();
});

test("Onboard starts a repository's onboarding, and shows it on its way", () => {
  const onboard = vi.fn(async () => {});
  const infra = row("acme/infra", { status: "not-onboarded" });
  const { rerender } = render(
    <Overview state={state} repos={list([infra], { onboard })} github={github} onChip={() => {}} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Onboard" }));
  expect(onboard).toHaveBeenCalledWith("acme/infra");
  rerender(
    <Overview
      state={state}
      repos={list([infra], { onboard, starting: "acme/infra" })}
      github={github}
      onChip={() => {}}
    />,
  );
  expect(screen.getByRole("button", { name: /Onboard/ }).getAttribute("aria-busy")).toBe("true");
  rerender(
    <Overview
      state={state}
      repos={list([infra], { failed: { repo: "acme/infra", error: "Issues are off" } })}
      github={github}
      onChip={() => {}}
    />,
  );
  expect(screen.getByRole("alert").textContent).toBe("Issues are off");
});
