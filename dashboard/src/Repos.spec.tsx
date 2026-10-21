// The repositories page against a fake api/repos: statuses, the buttons, the row switching,
// the refreshes and a repository's config panel.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { useState } from "preact/hooks";
import { beforeEach, expect, test } from "vitest";
import { useRepos } from "./api";
import { Dashboard } from "./App";
import { Repos } from "./Repos";
import { makeState, mockApi } from "./testUtils";
import type { AppLinks, Repo, RepoConfig, ServerInfo } from "./types";

const repo = (name: string, extra: Partial<Repo> = {}): Repo => ({
  repo: name,
  url: `https://github.com/${name}`,
  private: false,
  issues: true,
  status: "not-onboarded",
  issue: null,
  readAt: Date.now() - 120000,
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
      hosts: ["pypi.org"],
      cachedHosts: [],
      mounts: [],
      limits: { cpus: "2", memory: "4g", pids: 2048 },
    },
  },
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

function Page(props: { server?: ServerInfo; serverNow?: number }) {
  const [open, setOpen] = useState<string | null>(null);
  return <Repos list={useRepos()} onBack={() => {}} open={open} onOpen={setOpen} {...props} />;
}

const row = (name: string) => screen.getByRole("button", { name }).closest("li")!;

test("each repository with its status; the ones to onboard first", async () => {
  render(<Page />);
  await screen.findByRole("button", { name: "org/app" });
  expect(
    screen.getAllByRole("listitem").map((li) => li.querySelector("button")!.textContent),
  ).toEqual(["org/bad", "org/app", "org/wiki", "org/docs", "org/api"]);
  expect(within(row("org/api")).getByText("Configured")).toBeTruthy();
  expect(within(row("org/api")).queryByRole("button", { name: /onboarding/ })).toBeNull();
  expect(within(row("org/bad")).getByText("Invalid config")).toBeTruthy();
  expect(within(row("org/bad")).getByText(/No run starts/)).toBeTruthy();
  expect(within(row("org/docs")).getByRole("link", { name: "Issue #7" }).getAttribute("href")).toBe(
    "https://github.com/org/docs/issues/7",
  );
  // Issues off: no button, the reason instead.
  expect(within(row("org/wiki")).queryByRole("button", { name: /onboarding/ })).toBeNull();
  expect(within(row("org/wiki")).getByText(/Issues are disabled/)).toBeTruthy();
  expect(screen.getByText(/2 without a .deckhand.yaml/)).toBeTruthy();
});

test("Start onboarding posts, and the row switches to its issue", async () => {
  render(<Page />);
  await screen.findByRole("button", { name: "org/app" });
  fireEvent.click(within(row("org/app")).getByRole("button", { name: "Start onboarding" }));
  const issue = await within(row("org/app")).findByRole("link", { name: "Issue #12" });
  expect(issue.getAttribute("href")).toBe("https://github.com/org/app/issues/12");
  expect(within(row("org/app")).getByText("Onboarding")).toBeTruthy();
  expect(api.posted).toContainEqual({ url: "api/repos/org/app/onboard", body: undefined });
});

test("the header counts the repositories not onboarded and opens the page", async () => {
  const list = {
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
  };
  // The fixture's server: started 3 days and 3 hours before its `now`.
  render(<Dashboard state={makeState()} error={null} repos={list} />);
  const link = screen.getByRole("link", { name: /Repositories/ });
  expect(link.textContent).toBe("Repositories2");
  expect(screen.queryByRole("heading", { name: "Repositories" })).toBeNull();
  history.replaceState(null, "", "#/repositories");
  dispatchEvent(new HashChangeEvent("hashchange"));
  await waitFor(() => screen.getByRole("heading", { name: "Repositories" }));
  expect(screen.queryByRole("tablist")).toBeNull();
  // App passes the state's server and its clock: the uptime counts on the server's `now`.
  expect(screen.getByRole("link", { name: "edge-1713fa6" }).parentElement!.textContent).toBe(
    "Deckhand edge-1713fa6 · up 3 d 3 h · Node 26.1.0",
  );
});

test("Manage App: links to the App's installations and settings on GitHub, in a new tab", async () => {
  render(<Page />);
  const manage = await screen.findByRole("button", { name: /Manage App/ });
  expect(manage.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByRole("link", { name: /App settings/ })).toBeNull();
  fireEvent.click(manage);
  expect(manage.getAttribute("aria-expanded")).toBe("true");
  // Two installations: GitHub's install page, which lists them both.
  const repos = screen.getByRole("link", { name: /Add or remove repositories/ });
  expect(repos.getAttribute("href")).toBe(APP.installUrl);
  const settings = screen.getByRole("link", { name: /App settings/ });
  expect(settings.getAttribute("href")).toBe(APP.settingsUrl);
  for (const link of [repos, settings]) {
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noreferrer");
  }
  // Escape closes it, and so does a click beside it.
  fireEvent.keyDown(window, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("link", { name: /App settings/ })).toBeNull());
  fireEvent.click(manage);
  screen.getByRole("link", { name: /App settings/ });
  fireEvent.pointerDown(screen.getByRole("heading", { name: "Repositories" }));
  await waitFor(() => expect(screen.queryByRole("link", { name: /App settings/ })).toBeNull());
});

test("Manage App with a single installation: its own page", async () => {
  const one = { ...APP, installations: [APP.installations[1]] };
  api = mockApi({ "api/repos": () => ({ repos: REPOS, app: one, listedAt: Date.now() }) });
  render(<Page />);
  fireEvent.click(await screen.findByRole("button", { name: /Manage App/ }));
  const link = screen.getByRole("link", { name: /Add or remove repositories/ });
  expect(link.getAttribute("href")).toBe("https://github.com/settings/installations/2");
  expect(link.textContent).toContain("The installation on other");
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
  await screen.findByRole("button", { name: "org/new" });
  expect(screen.getByText("Listed 0s ago")).toBeTruthy();
  expect(api.posted).toContainEqual({ url: "api/repos/refresh", body: undefined });
});

test("a repository's panel: errors first, then what runs get, then the file", async () => {
  render(<Page />);
  fireEvent.click(await screen.findByRole("button", { name: "org/api" }));
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
  expect(screen.getByRole("heading", { name: /org\/api/ }).textContent).toContain("Invalid config");
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await waitFor(() =>
    expect(api.posted).toContainEqual({ url: "api/repos/org/api/refresh", body: undefined }),
  );
  fireEvent.click(screen.getByRole("button", { name: "← Repositories" }));
  expect(within(await screen.findByRole("list")).getAllByText("Invalid config")).toHaveLength(2);
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
  fireEvent.click(await screen.findByRole("button", { name: "org/api" }));
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
  fireEvent.click(await screen.findByRole("button", { name: "org/api" }));
  const alert = await screen.findByRole("alert");
  expect(within(alert).getAllByRole("listitem")).toHaveLength(1);
  expect(alert.textContent).toContain("allow_repo_hosts: gone");
  expect(alert.textContent).not.toContain("docker");
  const docker = screen.getByText("docker", { selector: "th code" }).closest("tr")!;
  expect(within(docker).getByText("unknown")).toBeTruthy();
  const mount = screen.getByText("/srv/data", { selector: "th code" }).closest("tr")!;
  expect(within(mount).getByText("unknown")).toBeTruthy();
});

test("a config that parses but asks for what isn't granted: Invalid config, not Configured", async () => {
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
  expect(within(await screen.findByRole("list")).getAllByText("Configured")).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "org/api" }));
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("dockerfile: the operator's grants");
  const heading = screen.getByRole("heading", { name: /org\/api/ }).textContent;
  expect(heading).toContain("Invalid config");
  expect(heading).not.toContain("Configured");
  fireEvent.click(screen.getByRole("button", { name: "← Repositories" }));
  const list = await screen.findByRole("list");
  expect(within(list).getAllByText("Invalid config")).toHaveLength(2);
  expect(within(list).queryByText("Configured")).toBeNull();
});

test("a repository without a config: the operator's defaults, said so", async () => {
  render(<Page />);
  fireEvent.click(await screen.findByRole("button", { name: "org/app" }));
  await screen.findByText(/the operator's defaults/);
  expect(document.body.textContent).toContain("No .deckhand.yaml on main");
  expect(screen.queryByRole("alert")).toBeNull();
  expect(document.querySelector("pre")).toBeNull();
});

test("the toolbar says which Deckhand runs, linked to its code, and since when", async () => {
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
  await screen.findByRole("button", { name: "org/app" });
  const version = screen.getByText(/^Deckhand/);
  expect(version.textContent).toBe("Deckhand edge-1713fa6 · up 3 d 4 h · Node 26.1.0");
  const commit = within(version).getByRole("link", { name: "edge-1713fa6" });
  expect(commit.getAttribute("href")).toBe("https://github.com/acme/deckhand/commit/1713fa6");
  expect(commit.getAttribute("target")).toBe("_blank");
  // A release: its page, under its tag.
  rerender(<Page server={{ ...server, version: "1.2.3" }} serverNow={startedAt + 7 * 60000} />);
  const release = screen.getByRole("link", { name: "1.2.3" });
  expect(release.getAttribute("href")).toBe("https://github.com/acme/deckhand/releases/tag/v1.2.3");
  expect(screen.getByText(/^Deckhand/).textContent).toContain("up 7 min");
  // Built from source, or without the repository it came from: plain text.
  for (const plain of [
    { ...server, version: "dev" },
    { ...server, source: "" },
  ]) {
    rerender(<Page server={plain} serverNow={serverNow} />);
    expect(within(screen.getByText(/^Deckhand/)).queryByRole("link")).toBeNull();
    expect(screen.getByText(/^Deckhand/).textContent).toContain(plain.version);
  }
});
