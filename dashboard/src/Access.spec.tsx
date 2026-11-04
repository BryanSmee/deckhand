// Access (#732): the controls follow api/state's `access`, for a viewer (tasks:read only), a
// member (runs started and managed, no server view) and an operator (everything, and Settings ›
// Access, which lists who has what).
import { fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { beforeEach, expect, test, vi } from "vitest";
import { AccessContext, canFrom } from "./access";
import type { RepoList } from "./api";
import { Dashboard } from "./App";
import { Overview } from "./Overview";
import { BACKLOG as EMPTY, FakeSource, makeState, mockApi } from "./testUtils";
import type { Access, AccessReport, Backlog, Repo, RepoAccess } from "./types";

const REPOS = ["acme/app", "acme/api", "acme/notes"];
const on = (repo: RepoAccess): Record<string, RepoAccess> =>
  Object.fromEntries(REPOS.map((r) => [r, repo]));

const VIEWER: Access = {
  server: [],
  repos: on({ actions: ["tasks:read"], starts: [], startsDenied: [] }),
};
const MEMBER: Access = {
  server: [],
  repos: on({
    actions: ["tasks:read", "logs:read", "runs:manage"],
    starts: ["*"],
    startsDenied: ["brainstorm"],
  }),
};
const OPERATOR: Access = {
  server: ["server:read", "server:sync"],
  repos: on({
    actions: ["tasks:read", "logs:read", "runs:manage", "repo:config:read"],
    starts: ["*"],
    startsDenied: [],
  }),
};

const BACKLOG: Backlog = {
  ...EMPTY,
  issues: [
    { number: 31, title: "Export the run log", url: "https://github.com/acme/app/issues/31" },
  ],
};

const REPORT: AccessReport = {
  repos: ["acme/api", "acme/app"],
  error: null,
  users: [
    {
      login: "alice",
      server: { actions: [], denied: [], error: null, outside: false },
      repos: [
        {
          repo: "acme/api",
          actions: [{ action: "tasks:read", files: ["access.rego"] }],
          denied: [],
          error: null,
          outside: false,
        },
        { repo: "acme/app", actions: [], denied: [], error: null, outside: false },
      ],
    },
    {
      login: "carol",
      server: {
        actions: [{ action: "server:*", files: ["access.rego"] }],
        denied: [],
        error: null,
        outside: false,
      },
      repos: [
        {
          repo: "acme/api",
          actions: [{ action: "*", files: ["access.rego"] }],
          denied: [
            { action: "runs:start:work", reason: "frozen", file: "audit.rego", layer: "repo" },
          ],
          error: null,
          outside: false,
        },
        { repo: "acme/app", actions: [], denied: [], error: null, outside: true },
      ],
    },
  ],
};

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

let api: ReturnType<typeof mockApi>;
// The GET paths asked.
let asked: string[];
beforeEach(() => {
  asked = [];
  FakeSource.last = null;
  vi.stubGlobal("EventSource", FakeSource);
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("min-width"),
    addEventListener() {},
    removeEventListener() {},
  }));
  api = mockApi({
    "api/repos/acme/app/issues": () => BACKLOG,
    "api/access": () => {
      asked.push("api/access");
      return REPORT;
    },
    "api/health": () => {
      asked.push("api/health");
      return { services: [] };
    },
  });
});

const open = (hash: string, access: Access) => {
  history.replaceState(null, "", hash);
  render(<Dashboard state={makeState({ access })} error={null} repos={noRepos} />);
};

test("canFrom: an action where it is given, a mode's start unless denied, a repo it doesn't name nothing", () => {
  const can = canFrom({
    server: ["server:read"],
    repos: {
      "acme/app": { actions: ["tasks:read"], starts: ["re*", "work"], startsDenied: ["review"] },
    },
  });
  expect(can.repo("Acme/App", "tasks:read")).toBe(true);
  expect(can.repo("acme/app", "runs:manage")).toBe(false);
  expect(can.start("acme/app", "work")).toBe(true);
  expect(can.start("acme/app", "research")).toBe(true);
  expect(can.start("acme/app", "review")).toBe(false);
  expect(can.start("acme/app", "brainstorm")).toBe(false);
  expect(can.repo("acme/other", "tasks:read")).toBe(false);
  expect(can.start("acme/other", "work")).toBe(false);
  expect(can.server("server:read")).toBe(true);
  expect(can.server("server:sync")).toBe(false);
  expect(can.anywhere("work")).toBe(true);
  expect(can.anywhere("idea")).toBe(false);
  // A listener from before access: everything.
  expect(canFrom(undefined).start("acme/other", "anything")).toBe(true);
});

test("a viewer: no Stop, no log asked for, no Rerun, a read-only board, no Sync, New request or server tabs", async () => {
  open(`#/?task=${encodeURIComponent("acme/app#22")}`, VIEWER);
  expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
  // Its log isn't asked for: the stream would be refused.
  expect(FakeSource.last).toBeNull();
  expect(screen.getByText(/Its log isn't yours to read/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Sync with GitHub" })).toBeNull();
  expect(screen.queryByRole("button", { name: "New request" })).toBeNull();
  // Nor the services' health, server:read's.
  expect(asked).not.toContain("api/health");
});

test("a viewer's failed run has no Rerun; their board lists the backlog without its buttons", async () => {
  open(`#/?task=${encodeURIComponent("acme/api#127")}`, VIEWER);
  expect(screen.queryByRole("button", { name: /Rerun/ })).toBeNull();
  history.replaceState(null, "", "#/acme/app/board");
  window.dispatchEvent(new HashChangeEvent("hashchange"));
  const area = await screen.findByRole("region", { name: "Work queue" });
  const item = (await within(area).findByText("Export the run log")).closest("li")!;
  expect(within(item).queryAllByRole("button")).toEqual([]);
  expect(item.getAttribute("draggable")).toBe("false");
  expect(screen.queryByRole("combobox", { name: /Start in/ })).toBeNull();
});

test("a viewer's settings: no Server or Access tab, and their address says why", () => {
  open("#/settings/access", VIEWER);
  const tabs = screen.getByRole("navigation", { name: "Settings" });
  expect(within(tabs).queryByRole("link", { name: "Server" })).toBeNull();
  expect(within(tabs).queryByRole("link", { name: "Access" })).toBeNull();
  expect(screen.getByText(/This page isn't yours to see/)).toBeTruthy();
  expect(asked).not.toContain("api/access");
});

test("a member: Stop and the log; Start in the modes they may start, no brainstorm", async () => {
  open(`#/?task=${encodeURIComponent("acme/app#22")}`, MEMBER);
  expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
  expect(FakeSource.last?.url).toMatch(/^api\/runs\/.+\/stream$/);
  expect(screen.queryByRole("button", { name: "Sync with GitHub" })).toBeNull();
  history.replaceState(null, "", "#/acme/app/board");
  window.dispatchEvent(new HashChangeEvent("hashchange"));
  const area = await screen.findByRole("region", { name: "Work queue" });
  await within(area).findByText("Export the run log");
  expect(within(area).getByRole("button", { name: "Start #31" })).toBeTruthy();
  expect(within(area).queryByRole("button", { name: "Brainstorm #31" })).toBeNull();
  const modes = within(screen.getByRole("combobox", { name: /Start in/ }))
    .getAllByRole("option")
    .map((o) => o.textContent);
  expect(modes).toEqual(["work", "review"]);
  fireEvent.click(within(area).getByRole("button", { name: "Start #31" }));
  await waitFor(() => expect(api.bodies()).toEqual([{ action: "start", number: 31 }]));
});

test("an operator: Sync, the server's tabs, and Settings › Access lists who has what", async () => {
  open("#/settings/access", OPERATOR);
  expect(screen.getByRole("button", { name: "Sync with GitHub" })).toBeTruthy();
  const tabs = screen.getByRole("navigation", { name: "Settings" });
  expect(within(tabs).getByRole("link", { name: "Server" })).toBeTruthy();
  expect(within(tabs).getByRole("link", { name: "Access" })).toBeTruthy();
  const carol = await screen.findByRole("region", { name: "@carol" });
  const rows = within(carol).getByRole("list", { name: "@carol's actions" });
  expect(within(rows).getByText("server:*")).toBeTruthy();
  const denied = within(rows).getByText("runs:start:work");
  expect(denied.getAttribute("title")).toBe("Denied by repo: audit.rego: frozen");
  expect(within(rows).getByText("*").getAttribute("title")).toBe(
    "every action · allowed by access.rego",
  );
  expect(within(carol).getByText(/Not in the/).textContent).toContain("acme/app");
  const alice = screen.getByRole("region", { name: "@alice" });
  expect(within(alice).getByText("tasks:read")).toBeTruthy();
  expect(within(alice).getByText(/No action on/).textContent).toContain("acme/app");
  // The filter: a login, or a repository.
  fireEvent.input(screen.getByRole("textbox", { name: "Filter by login or repository" }), {
    target: { value: "carol" },
  });
  expect(screen.queryByRole("region", { name: "@alice" })).toBeNull();
  expect(screen.getByRole("region", { name: "@carol" })).toBeTruthy();
});

test("Onboard on the Overview: a not-onboarded repo access names gets it, one it doesn't, not", () => {
  const infra: Repo = {
    repo: "acme/infra",
    url: "https://github.com/acme/infra",
    private: false,
    issues: true,
    status: "not-onboarded",
    issue: null,
    readAt: null,
    autoMerge: false,
  };
  const card = (access: Access) =>
    render(
      <AccessContext.Provider value={canFrom(access)}>
        <Overview
          state={makeState({ access })}
          repos={{ ...noRepos, repos: [infra] }}
          github="https://github.com"
          onChip={() => {}}
        />
      </AccessContext.Provider>,
    );
  const everything = {
    actions: OPERATOR.repos["acme/app"].actions,
    starts: ["*"],
    startsDenied: [],
  };
  const { unmount } = card({ ...OPERATOR, repos: { ...OPERATOR.repos, "acme/infra": everything } });
  expect(screen.getByRole("button", { name: "Onboard" })).toBeTruthy();
  unmount();
  card(OPERATOR);
  expect(screen.queryByRole("button", { name: "Onboard" })).toBeNull();
});

test("open questions: a run's need its mode's start, an issue's runs:manage alone", () => {
  // A member who may not start review runs, acme/api#138's mode.
  const access: Access = {
    server: [],
    repos: on({
      actions: ["tasks:read", "logs:read", "runs:manage"],
      starts: ["work"],
      startsDenied: [],
    }),
  };
  const show = (source: "run" | "issue") => {
    history.replaceState(null, "", `#/?task=${encodeURIComponent("acme/api#138")}`);
    const state = makeState({ access });
    const tasks = state.tasks.map((t) =>
      t.key === "acme/api#138" ? { ...t, questions: { ...t.questions!, source } } : t,
    );
    return render(<Dashboard state={{ ...state, tasks }} error={null} repos={noRepos} />);
  };
  const { unmount } = show("run");
  expect(screen.queryByRole("form", { name: "Open questions" })).toBeNull();
  unmount();
  show("issue");
  expect(screen.getByRole("form", { name: "Open questions" })).toBeTruthy();
});
