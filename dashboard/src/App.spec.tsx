// The dashboard from a fixture api/state, with a fake EventSource for the log stream.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { beforeEach, expect, test, vi } from "vitest";
import type { RepoList } from "./api";
import { Dashboard } from "./App";
import { FakeSource, makeState, makeTask } from "./testUtils";
import type { Entry } from "./types";

const state = makeState();

const noRepos: RepoList = {
  repos: [],
  app: null,
  listedAt: null,
  error: null,
  starting: null,
  failed: null,
  onboard: async () => {},
  refreshing: false,
  refreshError: null,
  refresh: async () => {},
  update: () => {},
};

let wide = true;
beforeEach(() => {
  wide = true;
  FakeSource.last = null;
  vi.stubGlobal("EventSource", FakeSource);
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("min-width") ? wide : false,
    addEventListener() {},
    removeEventListener() {},
  }));
});

const rows = () =>
  within(screen.getByRole("list"))
    .getAllByRole("button")
    .map((b) => b.querySelector("span:nth-child(2)")!.textContent);

const sidebarRepos = () =>
  within(screen.getByRole("navigation", { name: "Repositories" })).getAllByRole("link");

test("the tasks with their titles, the repos in the sidebar, and the first live one open", () => {
  history.replaceState(null, "", "#/tasks");
  render(<Dashboard state={state} error={null} />);
  expect(sidebarRepos().map((a) => a.textContent)).toEqual([
    "All repositories 3",
    "acme/app 1",
    "acme/api 1",
    "acme/notes 1",
  ]);
  expect(rows()).toHaveLength(11);
  expect(rows()).toContain("How do runs restart after an update?");
  // No title known yet: the kind and number.
  expect(rows()).toContain("Issue #127");
  expect(screen.getByRole("heading", { level: 2, name: /Dashboard on a frontend/ })).toBeTruthy();
  expect(screen.getByText(/npm installs get a 403/)).toBeTruthy();
  expect(location.hash).toBe("#/tasks?task=acme%2Fapp%2322");
  expect(screen.getByText("2 of 4 running")).toBeTruthy();
  expect(screen.getByRole("img", { name: "2 of 4 run slots in use" })).toBeTruthy();
  expect(screen.getByText("1 queued")).toBeTruthy();
});

test("a done task whose pull request is ready shows the ready tone, in the list and open", () => {
  history.replaceState(null, "", `#/?task=${encodeURIComponent("acme/api#131")}`);
  render(<Dashboard state={state} error={null} />);
  // Its row: the title's button (the heading has the title too).
  const row = screen
    .getAllByText("Dark mode for the settings page")
    .map((el) => el.closest("button"))
    .find(Boolean)!;
  expect(within(row).getByText("Done").className).toContain("s-ready");
  const head = screen.getByRole("heading", { level: 2, name: /Dark mode/ }).closest("header")!;
  expect(within(head).getByText("Done").className).toContain("s-ready");
});

test("links go to the listener's GitHub", () => {
  history.replaceState(null, "", "#/tasks");
  render(<Dashboard state={state} error={null} />);
  expect(screen.getByRole("link", { name: "acme/app" }).getAttribute("href")).toBe(
    "https://github.example.com/acme/app",
  );
  expect(screen.getByRole("link", { name: /Dashboard on a frontend/ }).getAttribute("href")).toBe(
    "https://github.example.com/acme/app/issues/25",
  );
});

test("a repo's link and the state chips filter the list", async () => {
  render(<Dashboard state={state} error={null} />);
  const api = sidebarRepos().find((a) => a.textContent!.startsWith("acme/api"))!;
  expect(api.getAttribute("href")).toBe("#/acme/api");
  history.pushState(null, "", "#/acme/api");
  dispatchEvent(new HashChangeEvent("hashchange"));
  await waitFor(() => expect(api.getAttribute("aria-current")).toBe("page"));
  expect(location.hash).toMatch(/^#\/acme\/api/);
  expect(rows()).toEqual([
    "Offline sync for the reading list",
    "Search results flicker when typing fast",
    "Dark mode for the settings page",
    "Issue #127",
  ]);
  fireEvent.click(screen.getByRole("button", { name: /^Needs you/ }));
  expect(rows()).toEqual(["Search results flicker when typing fast"]);
  // Kept on this device.
  expect(localStorage.getItem("deckhand.chip")).toBe("input");
  expect(localStorage.getItem("deckhand.tab")).toBe("acme/api");
  fireEvent.click(screen.getByRole("button", { name: /^Done/ }));
  expect(rows()).toEqual(["Dark mode for the settings page"]);
});

test("a repo's address in another case opens it, under GitHub's spelling", async () => {
  wide = false;
  const repo = "Storywake/storywake";
  const tasks = [makeTask({ repo, number: 1 }), makeTask({ repo, number: 2, since: 5 })];
  history.replaceState(null, "", "#/storywake/storywake");
  render(<Dashboard state={makeState({ tasks })} error={null} />);
  // The phone's top bar says which, under GitHub's spelling.
  await waitFor(() =>
    expect(screen.getByRole("button", { name: `${repo}: switch repository` })).toBeTruthy(),
  );
  expect(rows().sort()).toEqual(["Issue 1", "Issue 2"]);
  await waitFor(() => expect(location.hash).toBe("#/Storywake/storywake"));
});

test("a task waiting for other issues links them", () => {
  history.replaceState(null, "", "#/?task=acme%2Fapp%2324");
  render(<Dashboard state={state} error={null} />);
  expect(
    screen.getByRole("heading", { level: 2, name: /Per-repo budgets in the dashboard/ }),
  ).toBeTruthy();
  expect(screen.getByText("after #23 and #22")).toBeTruthy();
  expect(screen.getByRole("link", { name: "#22" }).getAttribute("href")).toBe(
    "https://github.example.com/acme/app/issues/22",
  );
});

test("old links open their task and run", () => {
  history.replaceState(null, "", "#task=acme%2Fnotes%23discussion-8");
  render(<Dashboard state={state} error={null} />);
  expect(screen.getByRole("heading", { level: 2, name: /How do runs restart/ })).toBeTruthy();
  // A discussion shows its thread first; its run's log is a tab away.
  fireEvent.click(screen.getAllByRole("tab")[1]);
  expect(FakeSource.last!.url).toBe("api/runs/acme-notes-discussion-8-1791896400000/stream");
});

test("on a phone: the list, then the task with a way back", () => {
  history.replaceState(null, "", "#/tasks");
  wide = false;
  const { container } = render(<Dashboard state={state} error={null} />);
  expect(screen.queryByRole("heading", { level: 2, name: /Dashboard on/ })).toBeNull();
  fireEvent.click(screen.getByText("Bugs"));
  expect(screen.getByRole("heading", { level: 2, name: /Bugs/ })).toBeTruthy();
  expect(container.firstElementChild!.className).toMatch(/reading/);
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  expect(container.firstElementChild!.className).not.toMatch(/reading/);
});

test("the log streams in: tool calls with their output, then the result", async () => {
  history.replaceState(null, "", "#/tasks");
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
  fireEvent.click(screen.getByRole("tab", { name: "Start 2 h ago" }));
  expect(FakeSource.last).not.toBe(source);
  expect(FakeSource.last!.url).toMatch(/acme-app-22-1791984600000/);
  expect(location.hash).toMatch(/run=acme-app-22-1791984600000/);
});

test("the log in its sections: the outcome first, a failed build step open", async () => {
  history.replaceState(null, "", "#/tasks");
  render(<Dashboard state={state} error={null} />);
  expect(screen.getByRole("region", { name: "Outcome" }).textContent).toMatch(/Working/);
  const source = FakeSource.last!;
  const step = { kind: "step", step: 7, stage: "build 2/4", name: "RUN npm ci" } as const;
  source.emit("entries", [
    { kind: "phase", phase: "image", at: 1000 },
    { ...step, status: "running", seconds: null, error: null },
    { kind: "raw", step: 7, text: "added 412 packages" },
    { ...step, status: "error", seconds: null, error: "exit code: 1" },
    { kind: "phase", phase: "setup", at: 2000 },
    { kind: "meta", text: "Image built" },
  ] satisfies Entry[]);
  const log = await screen.findByTestId("log");
  await within(log).findByText("Image built");
  // Setup folds; the image's build, which failed, is open, and so is its failed step.
  expect(within(log).getByText("Setup").closest("details")!.open).toBe(false);
  expect(within(log).getByText("Image build").closest("details")!.open).toBe(true);
  const failed = within(log).getByText("RUN npm ci").closest("details")!;
  expect(failed.open).toBe(true);
  expect(failed.textContent).toContain("added 412 packages");
  expect(failed.textContent).toContain("ERROR: exit code: 1");
});

test("an older run's outcome: no pull request, which is the latest run's", () => {
  render(<Dashboard state={state} error={null} />);
  const outcome = () => screen.getByRole("region", { name: "Outcome" });
  expect(within(outcome()).getByRole("link", { name: "Open pull request #25" })).toBeTruthy();
  fireEvent.click(screen.getByRole("tab", { name: "Start 2 h ago" }));
  expect(within(outcome()).queryByRole("link", { name: /pull request/ })).toBeNull();
  expect(outcome().textContent).not.toMatch(/Draft|\+86/);
});

test("on a phone, More: GitHub, then the log copied", async () => {
  wide = false;
  const writeText = vi.fn(async (_text: string) => {});
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  history.replaceState(null, "", "#/?task=acme%2Fapp%2322");
  render(<Dashboard state={state} error={null} />);
  FakeSource.last!.emit("entries", [{ kind: "text", text: "Hello" }] satisfies Entry[]);
  // GitHub is in the menu, not beside the title.
  expect(screen.queryByRole("link", { name: "GitHub" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "More: open on GitHub, copy, download" }));
  const sheet = screen.getByRole("dialog", { name: "Run log" });
  expect(within(sheet).getByRole("link", { name: "Open on GitHub" })).toBeTruthy();
  fireEvent.click(within(sheet).getByRole("button", { name: "Copy the log" }));
  expect(await screen.findByText("Log copied.")).toBeTruthy();
  expect(writeText.mock.calls[0][0]).toBe("== Work ==\nHello\n");
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("signed out of reach: the error instead of the counts", () => {
  render(<Dashboard state={null} error="502" />);
  expect(screen.getByText("Can't reach the listener (502)")).toBeTruthy();
});

test("an issue waiting for answers without a run: listed under Needs you, no log", () => {
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
    rerunnable: false,
    runs: [],
  };
  history.replaceState(null, "", "#/?task=acme%2Fnotes%239");
  render(<Dashboard state={{ ...state, tasks: [...state.tasks, filed] }} error={null} />);
  fireEvent.click(screen.getByRole("button", { name: /^Needs you/ }));
  expect(rows()).toContain("Tags for notes");
  expect(screen.getByRole("heading", { level: 2, name: /Tags for notes/ })).toBeTruthy();
  expect(screen.getByText(/Waiting for answers to its open questions/)).toBeTruthy();
  const row = screen.getByRole("button", { name: /Tags for notes/ });
  expect(row.textContent).toContain("2 h ago");
});

test("the graph: a node per issue, arrows for /after, a node opens its task", () => {
  history.replaceState(null, "", "#/acme/app/board");
  render(<Dashboard state={state} error={null} />);
  const views = within(screen.getByRole("group", { name: "View" }));
  expect(views.getByRole("link", { name: "Board" }).getAttribute("aria-current")).toBe("page");
  expect(views.getByRole("link", { name: "Tasks" }).getAttribute("href")).toBe("#/acme/app");
  const nodes = within(screen.getByRole("list", { name: "Issues of acme/app" })).getAllByRole(
    "listitem",
  );
  expect(nodes.map((n) => n.getAttribute("aria-label"))).toContain(
    "#24 Per-repo budgets in the dashboard: Waiting, waits for 2 issues",
  );
  // Not the bugs inbox's run (#16), nor the brainstorm (#20): it is in the column.
  expect(nodes).toHaveLength(
    state.tasks.filter((t) => t.repo === "acme/app" && t.kind !== "bug" && t.kind !== "brainstorm")
      .length,
  );
  fireEvent.click(screen.getByRole("tab", { name: /^Brainstorm/ }));
  const column = screen.getByRole("list", { name: "Issues being brainstormed" });
  expect(
    within(column)
      .getAllByRole("listitem")
      .map((c) => c.textContent),
  ).toEqual([expect.stringMatching(/^#20 .*Brainstorm · idle in/)]);
  expect(document.querySelectorAll("path[marker-end]")).toHaveLength(2);
  expect(screen.getByRole("list", { name: "Legend" }).textContent).toMatch(/Ready for review/);

  const node = nodes.find((n) => n.getAttribute("aria-label")!.startsWith("#24"))!;
  expect(node.getAttribute("href")).toBe("#/acme/app?task=acme%2Fapp%2324");
  // The sidebar's repos stay on the board; All has the Overview instead.
  expect(sidebarRepos().map((a) => a.getAttribute("href"))).toEqual([
    "#/",
    "#/acme/app/board",
    "#/acme/api/board",
    "#/acme/notes/board",
  ]);
  expect(sidebarRepos()[1].getAttribute("aria-current")).toBe("page");
});

test("the graph hides closed issues until Show closed, which is kept", () => {
  const closed = {
    ...state,
    tasks: state.tasks.map((t) =>
      t.key === "acme/app#23" ? { ...t, state: "done" as const, closed: "completed" as const } : t,
    ),
  };
  history.replaceState(null, "", "#/acme/app/board");
  const view = render(<Dashboard state={closed} error={null} />);
  const labels = () =>
    within(screen.getByRole("list", { name: "Issues of acme/app" }))
      .getAllByRole("listitem")
      .map((n) => n.getAttribute("aria-label"));
  expect(labels().some((l) => l!.startsWith("#23"))).toBe(false);
  expect(labels()).toContain("#24 Per-repo budgets in the dashboard: Waiting, waits for 1 issue");
  expect(document.querySelectorAll("path[marker-end]")).toHaveLength(1);

  fireEvent.click(screen.getByRole("switch", { name: "Show closed" }));
  expect(labels().some((l) => l!.startsWith("#23"))).toBe(true);
  expect(document.querySelectorAll("path[marker-end]")).toHaveLength(2);
  view.unmount();
  render(<Dashboard state={closed} error={null} />);
  expect(screen.getByRole("switch", { name: "Show closed" })).toHaveProperty("checked", true);
});

test("the graph with nothing open says so, and offers the closed ones", () => {
  const done = {
    ...state,
    tasks: state.tasks
      .filter((t) => t.key === "acme/app#23")
      .map((t) => ({ ...t, state: "done" as const, closed: "completed" as const })),
    edges: [],
  };
  history.replaceState(null, "", "#/acme/app/board");
  render(<Dashboard state={done} error={null} />);
  expect(screen.getByText(/Nothing open here/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Show closed issues" }));
  expect(screen.getByRole("list", { name: "Issues of acme/app" })).toBeTruthy();
});

test.each(["#/graph", "#/board"])("every repo's old graph, %s, opens the Overview", (old) => {
  history.replaceState(null, "", old);
  render(<Dashboard state={state} error={null} />);
  expect(location.hash).toBe("#/");
  expect(screen.queryByRole("list", { name: "Issues" })).toBeNull();
  expect(screen.getByRole("heading", { level: 2, name: "Waiting on you" })).toBeTruthy();
  expect(screen.getByRole("heading", { level: 1, name: "All repositories" })).toBeTruthy();
  const views = within(screen.getByRole("group", { name: "View" }));
  expect(views.getByRole("link", { name: "Overview" }).getAttribute("aria-current")).toBe("page");
  expect(views.getByRole("link", { name: "Tasks" }).getAttribute("href")).toBe("#/tasks");
  expect(views.queryByRole("link", { name: "Board" })).toBeNull();
  expect(sidebarRepos()[0].getAttribute("aria-current")).toBe("page");
});

test("All's tasks: the sidebar's All stays on them, and a total opens them under its chip", async () => {
  render(<Dashboard state={state} error={null} />);
  // An empty address with no repo kept: the Overview.
  expect(location.hash).toBe("");
  const tile = screen.getByRole("link", { name: /^Needs you: 2/ });
  expect(tile.getAttribute("href")).toBe("#/tasks");
  fireEvent.click(tile);
  expect(localStorage.getItem("deckhand.chip")).toBe("input");
  history.pushState(null, "", "#/tasks");
  dispatchEvent(new HashChangeEvent("hashchange"));
  await waitFor(() => expect(rows()).toHaveLength(3));
  expect(sidebarRepos()[0].getAttribute("href")).toBe("#/tasks");
  expect(sidebarRepos()[1].getAttribute("href")).toBe("#/acme/app");
  const views = within(screen.getByRole("group", { name: "View" }));
  expect(views.getByRole("link", { name: "Tasks" }).getAttribute("aria-current")).toBe("page");
  expect(views.getByRole("link", { name: "Overview" }).getAttribute("href")).toBe("#/");
});

test("on the board the sidebar is a rail, expanded there without changing the kept choice", () => {
  history.replaceState(null, "", "#/acme/app/board");
  render(<Dashboard state={state} error={null} />);
  fireEvent.click(screen.getByRole("button", { name: "Expand the sidebar" }));
  expect(screen.getByRole("button", { name: "Collapse the sidebar" })).toBeTruthy();
  expect(localStorage.getItem("deckhand.sidebar")).toBeNull();
  // Start in is in the page header.
  const header = screen.getByRole("heading", { level: 1, name: "acme/app" }).closest("header")!;
  expect(within(header).getByRole("combobox", { name: "Start in" })).toBeTruthy();
});

test("the old addresses are rewritten to their new ones, showing the same", () => {
  history.replaceState(null, "", "#/graph/acme/app");
  const view = render(<Dashboard state={state} error={null} />);
  expect(location.hash).toBe("#/acme/app/board");
  expect(screen.getByRole("list", { name: "Issues of acme/app" })).toBeTruthy();
  view.unmount();
  history.replaceState(null, "", "#/repositories");
  render(<Dashboard state={state} error={null} repos={noRepos} />);
  expect(location.hash).toBe("#/settings/repositories");
  expect(
    within(screen.getByRole("main")).getByRole("heading", { name: "Repositories" }),
  ).toBeTruthy();
});

test("the brand goes to All, and an empty address opens the repo last open", async () => {
  localStorage.setItem("deckhand.tab", "acme/api");
  history.replaceState(null, "", "#");
  render(<Dashboard state={state} error={null} />);
  expect(screen.getByRole("link", { name: "Deckhand" }).getAttribute("href")).toBe("#/");
  await waitFor(() => expect(location.hash).toMatch(/^#\/acme\/api\?task=/));
  expect(screen.getByRole("heading", { level: 1, name: "acme/api" })).toBeTruthy();
  expect(screen.getByRole("link", { name: "acme/api on GitHub" }).getAttribute("href")).toBe(
    "https://github.example.com/acme/api",
  );
});

test("the sidebar collapses to a rail, kept on this device", () => {
  const view = render(<Dashboard state={state} error={null} />);
  fireEvent.click(screen.getByRole("button", { name: "Collapse the sidebar" }));
  expect(localStorage.getItem("deckhand.sidebar")).toBe("rail");
  // The rail names its links by their label and count.
  const repos = sidebarRepos().map((a) => a.getAttribute("aria-label"));
  expect(repos).toEqual(["All repositories (3)", "acme/app (1)", "acme/api (1)", "acme/notes (1)"]);
  expect(screen.queryByText("@octocat")).toBeNull();
  view.unmount();
  render(<Dashboard state={state} error={null} />);
  fireEvent.click(screen.getByRole("button", { name: "Expand the sidebar" }));
  expect(localStorage.getItem("deckhand.sidebar")).toBe("");
  expect(screen.getByRole("button", { name: "Collapse the sidebar" })).toBeTruthy();
});

test("New request's menu: arrows move through it, Escape closes it", () => {
  render(<Dashboard state={state} error={null} />);
  const button = screen.getByRole("button", { name: "New request" });
  expect(button.getAttribute("aria-haspopup")).toBe("menu");
  fireEvent.click(button);
  expect(button.getAttribute("aria-expanded")).toBe("true");
  const items = screen.getAllByRole("menuitem");
  expect(items.map((i) => i.textContent)).toEqual(["Idea or bug report", "Analyze runs"]);
  expect(document.activeElement).toBe(items[0]);
  fireEvent.keyDown(document, { key: "ArrowDown" });
  expect(document.activeElement).toBe(items[1]);
  fireEvent.keyDown(document, { key: "ArrowDown" });
  expect(document.activeElement).toBe(items[0]);
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("menu")).toBeNull();
  expect(document.activeElement).toBe(button);
});

test("a dialog from New request gives focus back to New request once closed", async () => {
  render(<Dashboard state={state} error={null} />);
  const button = screen.getByRole("button", { name: "New request" });
  fireEvent.click(button);
  fireEvent.click(screen.getByRole("menuitem", { name: "Idea or bug report" }));
  expect(screen.getByRole("dialog", { name: "Send feedback" })).toBeTruthy();
  fireEvent.keyDown(document, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(document.activeElement).toBe(button);
});

test("on a phone, the listener's error shows under the top bar", () => {
  wide = false;
  render(<Dashboard state={state} error="502" />);
  expect(screen.getByRole("alert").textContent).toBe("Can't reach the listener (502)");
});

test("on a phone, Tasks and Board go back to the repo last open, after Overview", async () => {
  wide = false;
  history.replaceState(null, "", "#/acme/api");
  render(<Dashboard state={state} error={null} />);
  history.pushState(null, "", "#/");
  dispatchEvent(new HashChangeEvent("hashchange"));
  const tabs = () => within(screen.getByRole("navigation", { name: "Pages" }));
  await waitFor(() =>
    expect(
      tabs()
        .getByRole("link", { name: /^Overview/ })
        .getAttribute("aria-current"),
    ).toBe("page"),
  );
  expect(tabs().getByRole("link", { name: "Tasks" }).getAttribute("href")).toBe("#/acme/api");
  expect(tabs().getByRole("link", { name: "Board" }).getAttribute("href")).toBe("#/acme/api/board");
});

test("on a phone: the tab bar marks the page, and the switcher's sheet lists the repos", () => {
  wide = false;
  history.replaceState(null, "", "#/acme/api");
  render(<Dashboard state={state} error={null} />);
  expect(screen.queryByRole("complementary", { name: "Deckhand" })).toBeNull();
  const tabs = within(screen.getByRole("navigation", { name: "Pages" })).getAllByRole("link");
  expect(
    tabs.map((t) => [t.textContent, t.getAttribute("href"), t.getAttribute("aria-current")]),
  ).toEqual([
    ["Overview3", "#/", null],
    ["Tasks", "#/acme/api", "page"],
    ["Board", "#/acme/api/board", null],
    ["Settings", "#/settings/repositories", null],
  ]);
  expect(tabs[0].getAttribute("aria-label")).toBe("Overview (3 waiting on you)");

  fireEvent.click(screen.getByRole("button", { name: "acme/api: switch repository" }));
  const sheet = screen.getByRole("dialog", { name: "Repositories" });
  const links = within(sheet).getAllByRole("link");
  expect(links.map((a) => a.textContent)).toEqual([
    "All repositories 3",
    "acme/app 1",
    "acme/api 1",
    "acme/notes 1",
  ]);
  expect(links[2].getAttribute("aria-current")).toBe("page");
  // The run slots, Sync and Sign out are there too.
  expect(within(sheet).getByText("2 of 4 running")).toBeTruthy();
  expect(within(sheet).getByRole("button", { name: "Sign out" })).toBeTruthy();
  // Following a link closes it.
  fireEvent.click(links[1]);
  expect(screen.queryByRole("dialog")).toBeNull();
});
