// Settings › Repositories against a fake api/repos: the onboarding card, statuses and each
// row's action, the filters, the row switching, the refreshes and a repository's config panel.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { useEffect, useState } from "preact/hooks";
import { beforeEach, expect, test, vi } from "vitest";
import { type RepoList, useRepos } from "./api";
import { Dashboard } from "./App";
import { Repos } from "./Repos";
import { parseRoute } from "./route";
import { makePolicyFile, makeState, makeTask, mockApi } from "./testUtils";
import type { AppLinks, Repo, RepoConfig, ServerInfo, Task } from "./types";

const repo = (name: string, extra: Partial<Repo> = {}): Repo => ({
  repo: name,
  url: `https://github.com/${name}`,
  private: false,
  issues: true,
  status: "not-onboarded",
  issue: null,
  readAt: Date.now() - 120000,
  autoMerge: false,
  ...extra,
});

const REPOS: Repo[] = [
  repo("org/api", { status: "configured" }),
  repo("org/app"),
  repo("org/docs", {
    status: "onboarding",
    issue: { number: 7, url: "https://github.com/org/docs/issues/7" },
  }),
  repo("org/wiki", { issues: false }),
  repo("org/bad", { status: "invalid" }),
];

const APP: AppLinks = {
  name: "Acme Deckhand",
  installUrl: "https://github.com/apps/acme-deckhand/installations/new",
  settingsUrl: "https://github.com/organizations/acme/settings/apps/acme-deckhand",
  installations: [
    { account: "org", url: "https://github.com/organizations/org/settings/installations/1" },
    { account: "other", url: "https://github.com/settings/installations/2" },
  ],
};

const CONFIG: RepoConfig = {
  repo: repo("org/api", { status: "invalid", readAt: Date.now() }),
  base: "main",
  file: {
    text: "users: [alice]\neffort: loud\n",
    sha: "abcdef1234",
    url: "https://github.com/org/api/blob/main/.deckhand.yaml",
  },
  errors: ["effort: expected one of low, medium, high"],
  warnings: ["colour: unknown, ignored"],
  grantsError: null,
  effective: {
    settings: [
      {
        key: "users",
        value: "alice",
        source: "repo",
        note: "narrowed from ALLOWED_USERS (alice, bob)",
      },
      { key: "effort", value: "medium", source: "operator", note: null },
    ],
    hosts: [
      { host: "api.anthropic.com", source: "operator", note: "always" },
      { host: "pypi.org", source: "operator", note: "grants/org/api.yaml" },
    ],
    mounts: [],
    grant: {
      files: ["org/api.yaml"],
      allowPreview: false,
      allowDockerfile: false,
      allowBranchDockerImages: false,
      allowDocker: false,
      allowResearch: false,
      allowWorkflows: false,
      allowAutoMerge: false,
      acknowledgeAutoMergePreview: false,
      hosts: ["pypi.org"],
      cachedHosts: [],
      mounts: [],
      limits: { cpus: "2", memory: "4g", pids: 2048 },
    },
  },
  policies: { files: [], errors: [], warnings: [] },
  readAt: Date.now(),
};

let api: ReturnType<typeof mockApi>;
beforeEach(() => {
  // Read now, not when the file loaded: "read 0s ago" holds however slow the tests before.
  const config = () => ({ ...CONFIG, readAt: Date.now() });
  api = mockApi({
    "api/repos": () => ({ repos: REPOS, app: APP, listedAt: Date.now() - 180000 }),
    "POST api/repos/refresh": () => ({
      repos: [...REPOS, repo("org/new")],
      app: APP,
      listedAt: Date.now(),
    }),
    "api/repos/org/api/config": config,
    "POST api/repos/org/api/refresh": config,
    "api/repos/org/app/config": () => ({
      ...CONFIG,
      repo: repo("org/app"),
      file: null,
      errors: [],
      warnings: [],
      effective: { ...CONFIG.effective, settings: [CONFIG.effective.settings[1]], hosts: [] },
    }),
    "api/repos/org/auto/config": () => ({
      ...CONFIG,
      repo: repo("org/auto", { status: "configured", autoMerge: true, readAt: Date.now() }),
      errors: [],
      warnings: [],
      readAt: Date.now(),
      effective: {
        ...CONFIG.effective,
        grant: {
          ...CONFIG.effective.grant!,
          allowAutoMerge: "public",
          allowPreview: true,
          acknowledgeAutoMergePreview: true,
        },
      },
    }),
    "api/repos/org/policed/config": () => ({
      ...CONFIG,
      repo: repo("org/policed", { status: "configured", readAt: Date.now() }),
      errors: [],
      warnings: [],
      readAt: Date.now(),
      policies: {
        files: [
          makePolicyFile({ name: "size.rego", source: "operator", rules: ["deny_merge"] }),
          makePolicyFile({ name: "base.rego", source: "operator", active: false }),
          makePolicyFile({
            name: "base.rego",
            source: "repo",
            replaces: true,
            rules: ["deny_merge", "deny_review"],
            url: "https://github.com/org/policed/blob/main/.deckhand/policy/base.rego",
          }),
          makePolicyFile({ name: "lib.rego", source: "repo" }),
        ],
        errors: [
          {
            file: "base.rego",
            row: 4,
            message: "rego_parse_error: unexpected eof token",
            text: "policy error: base.rego:4: rego_parse_error: unexpected eof token",
          },
        ],
        warnings: ["lib.rego: deny_merged isn't a rule Deckhand evaluates"],
      },
    }),
    "POST api/repos/org/app/onboard": () => ({
      opened: true,
      repo: repo("org/app", {
        status: "onboarding",
        issue: { number: 12, url: "https://github.com/org/app/issues/12" },
      }),
    }),
  });
  api.answer = () => Response.json({ error: "Its issues are disabled." }, { status: 409 });
});

// The repository open follows the address, as in App.tsx: a row's links set it.
function Page(props: { server?: ServerInfo; serverNow?: number; tasks?: Task[] }) {
  const config = () => parseRoute(location.hash).config ?? null;
  const [open, setOpen] = useState(config);
  useEffect(() => {
    const onChange = () => setOpen(config());
    addEventListener("hashchange", onChange);
    return () => removeEventListener("hashchange", onChange);
  }, []);
  const onOpen = (repo: string | null) => {
    history.replaceState(null, "", "#/settings/repositories");
    setOpen(repo);
  };
  return <Repos list={useRepos()} open={open} onOpen={onOpen} {...props} />;
}

const list = () => screen.getByRole("list", { name: "Repositories" });
const row = (name: string) => within(list()).getByRole("link", { name }).closest("li")!;
const openRepo = async (name: string) =>
  fireEvent.click(
    await within(await screen.findByRole("list", { name: "Repositories" })).findByRole("link", {
      name,
    }),
  );

test("each repository with its status, detail and one action; the ones to onboard first", async () => {
  render(<Page />);
  await screen.findByRole("list", { name: "Repositories" });
  expect(
    within(list())
      .getAllByRole("listitem")
      .map((li) => li.querySelector("a")!.textContent),
  ).toEqual(["org/bad", "org/app", "org/wiki", "org/docs", "org/api"]);
  // Each name opens its config.
  expect(within(row("org/app")).getByRole("link", { name: "org/app" }).getAttribute("href")).toBe(
    "#/settings/repositories/org/app",
  );
  const api = within(row("org/api"));
  expect(api.getByText("Configured")).toBeTruthy();
  expect(api.getByText("Read 2 min ago")).toBeTruthy();
  expect(api.getByRole("link", { name: "Config" }).getAttribute("href")).toBe(
    "#/settings/repositories/org/api",
  );
  expect(api.queryByRole("button")).toBeNull();
  const bad = within(row("org/bad"));
  expect(bad.getByText("Config has errors")).toBeTruthy();
  expect(bad.getByText(/no run starts until they are fixed/)).toBeTruthy();
  expect(bad.getByRole("link", { name: "Open config" }).getAttribute("href")).toBe(
    "#/settings/repositories/org/bad",
  );
  const docs = within(row("org/docs"));
  expect(docs.getByText(/^Issue #7 · /)).toBeTruthy();
  const issue = docs.getByRole("link", { name: "#7" });
  expect(issue.getAttribute("href")).toBe("https://github.com/org/docs/issues/7");
  expect(issue.getAttribute("target")).toBe("_blank");
  // No questions known: nothing to answer.
  expect(docs.queryByRole("link", { name: "Answer" })).toBeNull();
  expect(within(row("org/app")).getByRole("button", { name: "Start onboarding" })).toBeTruthy();
  // Issues off: no button, the reason and where to turn them on instead.
  const wiki = within(row("org/wiki"));
  expect(wiki.queryByRole("button")).toBeNull();
  expect(wiki.getByText(/issues are disabled on GitHub/)).toBeTruthy();
  expect(wiki.getByRole("link", { name: "Enable issues" }).getAttribute("href")).toBe(
    "https://github.com/org/wiki/settings",
  );
});

test("the onboarding card: three steps, and the first repository that can be onboarded", async () => {
  render(<Page />);
  const card = within(
    (await screen.findByRole("heading", { name: "2 repositories aren't onboarded" })).closest(
      "section",
    )!,
  );
  expect(card.getAllByRole("listitem").map((li) => li.querySelector("b")!.textContent)).toEqual([
    "Start onboarding",
    "Answer its questions",
    "Merge its pull request",
  ]);
  // org/wiki can't be: its issues are off.
  fireEvent.click(card.getByRole("button", { name: "Onboard org/app" }));
  // Pending at once, in the card and in the row.
  expect(card.getByRole("button", { name: /Onboard org\/app/ }).getAttribute("aria-busy")).toBe(
    "true",
  );
  expect(
    within(row("org/app"))
      .getByRole("button", { name: /Start onboarding/ })
      .getAttribute("aria-busy"),
  ).toBe("true");
  await within(row("org/app")).findByRole("link", { name: "#12" });
  expect(api.posted).toContainEqual({ url: "api/repos/org/app/onboard", body: undefined });
  // Only org/wiki left, which can't be: the card says so, with no button.
  expect(screen.getByRole("heading", { name: "1 repository isn't onboarded" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: /^Onboard / })).toBeNull();
});

test("no repository to onboard: no card", async () => {
  api.routes["api/repos"] = () => ({
    repos: [repo("org/api", { status: "configured" })],
    app: APP,
    listedAt: Date.now(),
  });
  render(<Page />);
  await screen.findByRole("list", { name: "Repositories" });
  expect(screen.queryByRole("heading", { name: /onboarded/ })).toBeNull();
});

test("an onboarding run's questions: Answer opens its task, and the repository needs you", async () => {
  const task = makeTask({
    key: "org/docs#7",
    repo: "org/docs",
    number: 7,
    state: "needs-input",
    questions: {
      source: "run",
      items: [
        { title: "Setup", text: "Which setup?", options: [] },
        { title: "Tests", text: "Which tests?", options: [] },
      ],
      raw: "",
    },
  });
  render(<Page tasks={[task]} />);
  await screen.findByRole("list", { name: "Repositories" });
  const docs = within(row("org/docs"));
  expect(docs.getByText("Issue #7 · 2 questions are waiting for your answers")).toBeTruthy();
  expect(docs.getByRole("link", { name: "Answer" }).getAttribute("href")).toBe(
    "#/org/docs?task=org%2Fdocs%237",
  );
  // Needs you: the config with errors, the one to onboard, and this one.
  const needs = screen.getByRole("button", { name: /Needs you/ });
  expect(needs.textContent).toBe("Needs you3");
  fireEvent.click(needs);
  expect(
    within(list())
      .getAllByRole("listitem")
      .map((li) => li.querySelector("a")!.textContent),
  ).toEqual(["org/bad", "org/app", "org/docs"]);
});

test("the filters: by name, and All / Needs you / Configured", async () => {
  render(<Page />);
  await screen.findByRole("list", { name: "Repositories" });
  const names = () =>
    within(list())
      .getAllByRole("listitem")
      .map((li) => li.querySelector("a")!.textContent);
  expect(screen.getByRole("button", { name: /^All/ }).getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: /Configured/ }));
  expect(names()).toEqual(["org/api"]);
  fireEvent.click(screen.getByRole("button", { name: /^All/ }));
  fireEvent.input(screen.getByRole("textbox", { name: "Filter repositories" }), {
    target: { value: "W" },
  });
  expect(names()).toEqual(["org/wiki"]);
  fireEvent.input(screen.getByRole("textbox", { name: "Filter repositories" }), {
    target: { value: "nothing" },
  });
  expect(screen.queryByRole("list", { name: "Repositories" })).toBeNull();
  expect(screen.getByText("No repository here matches the filter.")).toBeTruthy();
});

test("Start onboarding posts, and the row switches to its issue", async () => {
  render(<Page />);
  await screen.findByRole("list", { name: "Repositories" });
  fireEvent.click(within(row("org/app")).getByRole("button", { name: "Start onboarding" }));
  const issue = await within(row("org/app")).findByRole("link", { name: "#12" });
  expect(issue.getAttribute("href")).toBe("https://github.com/org/app/issues/12");
  expect(within(row("org/app")).getByText("Onboarding")).toBeTruthy();
  expect(api.posted).toContainEqual({ url: "api/repos/org/app/onboard", body: undefined });
});

const fixedList = (): RepoList => ({
  repos: REPOS,
  app: null,
  error: null,
  starting: null,
  failed: null,
  onboard: async () => {},
  listedAt: null,
  refreshing: false,
  refreshError: null,
  refresh: async () => {},
  update: () => {},
});

// org/docs's onboarding run asks: with org/bad's errors and org/app to onboard, 3 need you.
// org/wiki doesn't (its issues are off), though it isn't onboarded either.
const asking = () =>
  makeTask({
    key: "org/docs#7",
    repo: "org/docs",
    number: 7,
    state: "needs-input",
    questions: { source: "run", items: null, raw: "Which tests?" },
  });

const tabs = () => within(screen.getByRole("navigation", { name: "Settings" }));

test("Settings counts the repositories that need you and opens the page", async () => {
  // The fixture's server: started 3 days and 3 hours before its `now`.
  history.replaceState(null, "", "#/tasks");
  render(<Dashboard state={makeState({}, [asking()])} error={null} repos={fixedList()} />);
  const link = screen.getByRole("link", { name: /Settings/ });
  expect(link.textContent).toBe("Settings 3");
  expect(link.getAttribute("href")).toBe("#/settings/repositories");
  expect(link.getAttribute("aria-current")).toBeNull();
  expect(
    within(screen.getByRole("main")).queryByRole("heading", { name: "Repositories" }),
  ).toBeNull();
  history.replaceState(null, "", "#/settings/repositories");
  dispatchEvent(new HashChangeEvent("hashchange"));
  await waitFor(() =>
    within(screen.getByRole("main")).getByRole("heading", { name: "Repositories" }),
  );
  expect(screen.getByRole("link", { name: /Settings/ }).getAttribute("aria-current")).toBe("page");
  // App passes the state's server and its clock: the uptime counts on the server's `now`.
  expect(screen.getByRole("link", { name: "edge-1713fa6" }).parentElement!.textContent).toBe(
    "Deckhand edge-1713fa6 · up 3 d 3 h · Node 26.1.0",
  );
});

test("Settings' tabs: in the header, current with the address", async () => {
  render(<Dashboard state={makeState({}, [asking()])} error={null} repos={fixedList()} />);
  history.replaceState(null, "", "#/settings/repositories");
  dispatchEvent(new HashChangeEvent("hashchange"));
  await screen.findByRole("navigation", { name: "Settings" });
  // A wide screen: the page header has them, not the page.
  expect(screen.getByRole("navigation", { name: "Settings" }).closest("header")).toBeTruthy();
  const repos = tabs().getByRole("link", { name: /Repositories/ });
  expect(repos.textContent).toBe("Repositories3");
  expect(repos.getAttribute("aria-current")).toBe("page");
  const server = tabs().getByRole("link", { name: "Server" });
  expect(server.getAttribute("href")).toBe("#/settings/server");
  expect(server.getAttribute("aria-current")).toBeNull();
  history.replaceState(null, "", "#/settings/server");
  dispatchEvent(new HashChangeEvent("hashchange"));
  await screen.findByRole("heading", { name: "The listener is up" });
  expect(tabs().getByRole("link", { name: "Server" }).getAttribute("aria-current")).toBe("page");
  expect(
    tabs()
      .getByRole("link", { name: /Repositories/ })
      .getAttribute("aria-current"),
  ).toBeNull();
  expect(screen.queryByRole("list", { name: "Repositories" })).toBeNull();
  history.replaceState(null, "", "#/settings/repositories");
  dispatchEvent(new HashChangeEvent("hashchange"));
  await screen.findByRole("list", { name: "Repositories" });
  expect(screen.queryByText(/coming soon/)).toBeNull();
});

test("Settings' tabs on a phone: atop the page", async () => {
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  history.replaceState(null, "", "#/settings/preferences");
  render(<Dashboard state={makeState()} error={null} repos={fixedList()} />);
  const nav = await screen.findByRole("navigation", { name: "Settings" });
  expect(nav.closest("main")).toBeTruthy();
  expect(within(nav).getByRole("link", { name: "Preferences" }).getAttribute("aria-current")).toBe(
    "page",
  );
  expect(screen.getByRole("heading", { name: "Appearance" })).toBeTruthy();
});

test("an onboarding run that failed or stopped: said so, its task linked, and it needs you", async () => {
  const failed = makeTask({ key: "org/docs#7", repo: "org/docs", number: 7, state: "error" });
  render(<Page tasks={[failed]} />);
  await screen.findByRole("list", { name: "Repositories" });
  const docs = within(row("org/docs"));
  expect(docs.getByText("Issue #7 · Its run failed: open it to run it again")).toBeTruthy();
  expect(docs.getByRole("link", { name: "Open run" }).getAttribute("href")).toBe(
    "#/org/docs?task=org%2Fdocs%237",
  );
  expect(screen.getByRole("button", { name: /Needs you/ }).textContent).toBe("Needs you3");
  cleanup();
  render(<Page tasks={[{ ...failed, state: "cancelled" }]} />);
  await screen.findByRole("list", { name: "Repositories" });
  expect(within(row("org/docs")).getByText(/Its run was stopped/)).toBeTruthy();
  cleanup();
  // At work: nothing to do but wait.
  render(<Page tasks={[{ ...failed, state: "working" }]} />);
  await screen.findByRole("list", { name: "Repositories" });
  expect(within(row("org/docs")).getByText(/Its run reads the code/)).toBeTruthy();
  expect(within(row("org/docs")).queryByRole("link", { name: "Open run" })).toBeNull();
  expect(screen.getByRole("button", { name: /Needs you/ }).textContent).toBe("Needs you2");
});

test("onboarding from the card fails: the card says why, even with the row filtered out", async () => {
  delete api.routes["POST api/repos/org/app/onboard"];
  render(<Page />);
  await screen.findByRole("list", { name: "Repositories" });
  fireEvent.click(screen.getByRole("button", { name: /Configured/ }));
  const card = (await screen.findByRole("heading", { name: /aren't onboarded/ })).closest(
    "section",
  )!;
  fireEvent.click(within(card).getByRole("button", { name: "Onboard org/app" }));
  const alert = await within(card).findByRole("alert");
  expect(alert.textContent).toBe("Couldn't onboard org/app: Its issues are disabled.");
  // Once, by the button that was clicked.
  fireEvent.click(screen.getByRole("button", { name: /^All/ }));
  expect(screen.getAllByRole("alert")).toHaveLength(1);
  // From the row: the row says it, not the card.
  fireEvent.click(within(row("org/app")).getByRole("button", { name: "Start onboarding" }));
  await waitFor(() => expect(within(row("org/app")).getByRole("alert")).toBeTruthy());
  expect(within(card).queryByRole("alert")).toBeNull();
});

test("Manage the App: GitHub's install page, or the single installation's own", async () => {
  render(<Page />);
  // Two installations: GitHub's install page, which lists them both.
  const manage = await screen.findByRole("link", { name: "Manage the App" });
  expect(manage.getAttribute("href")).toBe(APP.installUrl);
  expect(manage.getAttribute("target")).toBe("_blank");
  expect(manage.getAttribute("rel")).toBe("noreferrer");
  cleanup();
  const one = { ...APP, installations: [APP.installations[1]] };
  api = mockApi({ "api/repos": () => ({ repos: REPOS, app: one, listedAt: Date.now() }) });
  render(<Page />);
  expect((await screen.findByRole("link", { name: "Manage the App" })).getAttribute("href")).toBe(
    "https://github.com/settings/installations/2",
  );
});

test("no repository yet: a link that installs the App", async () => {
  api = mockApi({ "api/repos": () => ({ repos: [], app: APP, listedAt: Date.now() }) });
  render(<Page />);
  await screen.findByText(/isn't installed on any allowed repository yet/);
  const link = screen.getByRole("link", { name: "Install the App on a repository" });
  expect(link.getAttribute("href")).toBe(APP.installUrl);
  expect(link.getAttribute("target")).toBe("_blank");
});

test("Refresh lists the repositories again, and says when they were", async () => {
  render(<Page />);
  await screen.findByText("Listed 3 min ago");
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await within(list()).findByRole("link", { name: "org/new" });
  expect(screen.getByText("Listed 0s ago")).toBeTruthy();
  expect(api.posted).toContainEqual({ url: "api/repos/refresh", body: undefined });
});

test("a repository's panel: errors first, then what runs get, then the file", async () => {
  render(<Page />);
  await openRepo("org/api");
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("No run starts until these are fixed");
  expect(alert.textContent).toContain("effort: expected one of low, medium, high");
  expect(screen.getByText("colour: unknown, ignored")).toBeTruthy();
  const users = screen.getByText("users").closest("tr")!;
  expect(within(users).getByText("from repo")).toBeTruthy();
  expect(within(users).getByText(/narrowed from ALLOWED_USERS/)).toBeTruthy();
  expect(within(screen.getByText("effort").closest("tr")!).getByText("from operator")).toBeTruthy();
  // Each host names the grants file it comes from.
  const pypi = screen.getByText("pypi.org", { selector: "th code" }).closest("tr")!;
  expect(within(pypi).getByText("grants/org/api.yaml")).toBeTruthy();
  expect(within(pypi).getByText("from operator")).toBeTruthy();
  // What the operator grants, workflow pushes included.
  const workflows = screen.getByText("allow_workflows", { selector: "th code" }).closest("tr")!;
  expect(within(workflows).getByText("false")).toBeTruthy();
  expect(screen.getByText(/users: \[alice\]/, { selector: "pre" })).toBeTruthy();
  expect(screen.getByRole("link", { name: "on GitHub" }).getAttribute("href")).toBe(
    "https://github.com/org/api/blob/main/.deckhand.yaml",
  );
  expect(screen.getByText(/read 0s ago/)).toBeTruthy();
  // The row read along with it: invalid now.
  expect(screen.getByRole("heading", { name: /org\/api/ }).textContent).toContain(
    "Config has errors",
  );
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await waitFor(() =>
    expect(api.posted).toContainEqual({ url: "api/repos/org/api/refresh", body: undefined }),
  );
  fireEvent.click(screen.getByRole("button", { name: "← Repositories" }));
  expect(
    within(await screen.findByRole("list", { name: "Repositories" })).getAllByText(
      "Config has errors",
    ),
  ).toHaveLength(2);
});

test("auto-merge: a red badge in the list, a red risk box and its grant in the panel", async () => {
  const auto = repo("org/auto", { status: "configured", autoMerge: true });
  api.routes["api/repos"] = () => ({ repos: [...REPOS, auto], app: APP, listedAt: Date.now() });
  render(<Page />);
  await screen.findByRole("list", { name: "Repositories" });
  const badge = within(row("org/auto")).getByText("Auto-merge, no human review");
  expect(badge.title).toMatch(/nobody reads them before they reach the default branch/);
  expect(within(row("org/api")).queryByText("Auto-merge, no human review")).toBeNull();
  await openRepo("org/auto");
  const box = await screen.findByRole("note");
  expect(box.textContent).toContain("Auto-merge: no human review");
  expect(box.textContent).toContain(
    "Model output reaches the default branch with nobody reading it",
  );
  // Public: said too.
  expect(box.textContent).toContain("This repository is public");
  expect(box.textContent).toContain("Its preview hook runs the default branch as root on the host");
  expect(within(box).getByRole("link").getAttribute("href")).toBe(
    "https://github.com/BryanSmee/deckhand/blob/main/docs/security.md#auto-merge",
  );
  const grant = screen.getByText("allow_auto_merge", { selector: "th code" }).closest("tr")!;
  expect(within(grant).getByText("public")).toBeTruthy();
});

test("a repository's broken grant: the file to fix, and only this repository stopped", async () => {
  api.routes["api/repos/org/api/config"] = () => ({
    ...CONFIG,
    errors: [],
    grantsError: {
      file: "org/api.yaml",
      message: 'hosts: "bad host": not a host name',
      everyRepo: false,
    },
    effective: { ...CONFIG.effective, hosts: [], grant: null },
  });
  render(<Page />);
  await openRepo("org/api");
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain(
    'org/api.yaml in the operator\'s grants folder has errors, so no run starts in this repository: hosts: "bad host"',
  );
  expect(screen.getByText("Unknown: the operator's grants have errors.")).toBeTruthy();
});

test("a broken grant: what needs a grant is unknown, and only the grants error is listed", async () => {
  api.routes["api/repos/org/api/config"] = () => {
    const note = "depends on the operator's grants, which have errors";
    return {
      ...CONFIG,
      errors: [],
      grantsError: {
        file: "org/api.yaml",
        message: "allow_repo_hosts: gone",
        everyRepo: false,
      },
      effective: {
        ...CONFIG.effective,
        settings: [{ key: "docker", value: "a container engine", source: "unknown", note }],
        hosts: [],
        mounts: [{ path: "/srv/data", source: "unknown", readOnly: true, note }],
        grant: null,
      },
    };
  };
  render(<Page />);
  await openRepo("org/api");
  const alert = await screen.findByRole("alert");
  expect(within(alert).getAllByRole("listitem")).toHaveLength(1);
  expect(alert.textContent).toContain("allow_repo_hosts: gone");
  expect(alert.textContent).not.toContain("docker");
  const docker = screen.getByText("docker", { selector: "th code" }).closest("tr")!;
  expect(within(docker).getByText("unknown")).toBeTruthy();
  const mount = screen.getByText("/srv/data", { selector: "th code" }).closest("tr")!;
  expect(within(mount).getByText("unknown")).toBeTruthy();
});

test("a config that parses but asks for what isn't granted: Config has errors, not Configured", async () => {
  api.routes["api/repos/org/api/config"] = () => ({
    ...CONFIG,
    // The server's verdict: no run starts.
    repo: repo("org/api", { status: "invalid", readAt: Date.now() }),
    errors: [],
    effective: {
      ...CONFIG.effective,
      settings: [
        {
          key: "dockerfile",
          value: ".deckhand/Dockerfile",
          source: "refused",
          note: "the operator's grants don't set allow_dockerfile: true for this repository",
        },
      ],
      hosts: [],
    },
  });
  render(<Page />);
  expect(
    within(await screen.findByRole("list", { name: "Repositories" })).getAllByText("Configured"),
  ).toHaveLength(1);
  await openRepo("org/api");
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("dockerfile: the operator's grants");
  const heading = screen.getByRole("heading", { name: /org\/api/ }).textContent;
  expect(heading).toContain("Config has errors");
  expect(heading).not.toContain("Configured");
  fireEvent.click(screen.getByRole("button", { name: "← Repositories" }));
  const rows = await screen.findByRole("list", { name: "Repositories" });
  expect(within(rows).getAllByText("Config has errors")).toHaveLength(2);
  expect(within(rows).queryByText("Configured")).toBeNull();
});

test("its policies: each file with its rules and source, and the check's errors", async () => {
  const policed = repo("org/policed", { status: "configured" });
  api.routes["api/repos"] = () => ({ repos: [...REPOS, policed], app: APP, listedAt: Date.now() });
  render(<Page />);
  await openRepo("org/policed");
  await screen.findByRole("heading", { name: "Policies" });
  const alert = screen.getByRole("alert");
  expect(alert.textContent).toContain("Every decision a policy is asked for refuses");
  expect(alert.textContent).toContain("base.rego:4: rego_parse_error");
  expect(screen.getByText(/deny_merged/).textContent).toContain("isn't a rule Deckhand evaluates");
  const size = screen.getByText("size.rego").closest("tr")!;
  expect(within(size).getByText("deny_merge")).toBeTruthy();
  expect(within(size).getByText("from operator")).toBeTruthy();
  const [replaced, base] = screen.getAllByText("base.rego").map((n) => n.closest("tr")!);
  expect(within(replaced).getByText(/replaced by the repo's/)).toBeTruthy();
  expect(replaced.querySelector("s")).toBeTruthy();
  expect(within(base).getByText("deny_merge, deny_review")).toBeTruthy();
  expect(within(base).getByText(/replaces the operator's file/)).toBeTruthy();
  expect(within(base).getByText("from repo")).toBeTruthy();
  expect(within(base).getByRole("link").getAttribute("href")).toBe(
    "https://github.com/org/policed/blob/main/.deckhand/policy/base.rego",
  );
  const lib = screen.getByText("lib.rego").closest("tr")!;
  expect(within(lib).getByText("no deny_* rule")).toBeTruthy();
});

test("a repository without a config: the operator's defaults, said so", async () => {
  render(<Page />);
  await openRepo("org/app");
  await screen.findByText(/the operator's defaults/);
  expect(screen.getByText(/Only the built-in gates decide/)).toBeTruthy();
  expect(document.body.textContent).toContain("No .deckhand.yaml on main");
  expect(screen.queryByRole("alert")).toBeNull();
  expect(document.querySelector("pre")).toBeNull();
});

test("the footer says which Deckhand runs, linked to its code, and since when", async () => {
  const startedAt = Date.UTC(2026, 9, 18, 8);
  // The server's clock, 3 days, 4 hours and 5 minutes later: not the browser's.
  const serverNow = startedAt + ((3 * 24 + 4) * 60 + 5) * 60000;
  const server = {
    version: "edge-1713fa6",
    startedAt,
    node: "v26.1.0",
    source: "https://github.com/acme/deckhand",
  };
  const { rerender } = render(<Page server={server} serverNow={serverNow} />);
  await screen.findByRole("list", { name: "Repositories" });
  const version = screen.getByText(/^Deckhand/, { selector: "p" });
  expect(version.textContent).toBe("Deckhand edge-1713fa6 · up 3 d 4 h · Node 26.1.0");
  const commit = within(version).getByRole("link", { name: "edge-1713fa6" });
  expect(commit.getAttribute("href")).toBe("https://github.com/acme/deckhand/commit/1713fa6");
  expect(commit.getAttribute("target")).toBe("_blank");
  // A release: its page, under its tag.
  rerender(<Page server={{ ...server, version: "1.2.3" }} serverNow={startedAt + 7 * 60000} />);
  const release = screen.getByRole("link", { name: "1.2.3" });
  expect(release.getAttribute("href")).toBe("https://github.com/acme/deckhand/releases/tag/v1.2.3");
  expect(screen.getByText(/^Deckhand/, { selector: "p" }).textContent).toContain("up 7 min");
  // Built from source, or without the repository it came from: plain text.
  for (const plain of [
    { ...server, version: "dev" },
    { ...server, source: "" },
  ]) {
    rerender(<Page server={plain} serverNow={serverNow} />);
    expect(within(screen.getByText(/^Deckhand/, { selector: "p" })).queryByRole("link")).toBeNull();
    expect(screen.getByText(/^Deckhand/, { selector: "p" }).textContent).toContain(plain.version);
  }
});
