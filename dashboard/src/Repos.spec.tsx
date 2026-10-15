// The repositories page against a fake api/repos: statuses, the buttons, the row switching,
// the refreshes and a repository's config panel.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { useState } from "preact/hooks";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { useRepos } from "./api";
import { Dashboard } from "./App";
import { Repos } from "./Repos";
import type { Repo, RepoConfig } from "./types";

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

const CONFIG: RepoConfig = {
  repo: repo("org/api", { status: "invalid", readAt: Date.now() }),
  base: "main",
  file: {
    text: "users: [alice]\nhosts: [pypi.org]\neffort: loud\n",
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
      {
        host: "pypi.org",
        source: "refused",
        note: "the operator doesn't let this repository add hosts",
      },
    ],
    mounts: [],
    grant: {
      files: [],
      allowRepoHosts: false,
      allowPreview: false,
      allowDockerfile: false,
      allowBranchDockerImages: false,
      hosts: [],
      mounts: [],
      limits: { cpus: "2", memory: "4g", pids: 2048 },
    },
  },
  readAt: Date.now(),
};

let calls: { url: string; method: string }[] = [];
beforeEach(() => {
  calls = [];
  history.replaceState(null, "", "/");
  Object.assign(globalThis, {
    matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
  });
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? "GET" });
    if (url === "api/repos") return Response.json({ repos: REPOS, listedAt: Date.now() - 180000 });
    if (url === "api/repos/refresh") {
      return Response.json({ repos: [...REPOS, repo("org/new")], listedAt: Date.now() });
    }
    if (url === "api/repos/org/api/config" || url === "api/repos/org/api/refresh") {
      return Response.json(CONFIG);
    }
    if (url === "api/repos/org/app/config") {
      return Response.json({
        ...CONFIG,
        repo: repo("org/app"),
        file: null,
        errors: [],
        warnings: [],
        effective: { ...CONFIG.effective, settings: [CONFIG.effective.settings[1]], hosts: [] },
      });
    }
    if (url === "api/repos/org/app/onboard") {
      return Response.json({
        opened: true,
        repo: repo("org/app", {
          status: "onboarding",
          issue: { number: 12, url: "https://github.com/org/app/issues/12" },
        }),
      });
    }
    return Response.json({ error: "Its issues are disabled." }, { status: 409 });
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

function Page() {
  const [open, setOpen] = useState<string | null>(null);
  return <Repos list={useRepos()} onBack={() => {}} open={open} onOpen={setOpen} />;
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
  expect(calls).toContainEqual({ url: "api/repos/org/app/onboard", method: "POST" });
});

test("the header counts the repositories not onboarded and opens the page", async () => {
  const list = {
    repos: REPOS,
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
  render(<Dashboard state={null} error={null} repos={list} />);
  const link = screen.getByRole("link", { name: /Repositories/ });
  expect(link.textContent).toBe("Repositories2");
  expect(screen.queryByRole("heading", { name: "Repositories" })).toBeNull();
  history.replaceState(null, "", "#/repositories");
  dispatchEvent(new HashChangeEvent("hashchange"));
  await waitFor(() => screen.getByRole("heading", { name: "Repositories" }));
  expect(screen.queryByRole("tablist")).toBeNull();
});

test("Refresh lists the repositories again, and says when they were", async () => {
  render(<Page />);
  await screen.findByText("Listed 3 min ago");
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await screen.findByRole("button", { name: "org/new" });
  expect(screen.getByText("Listed 0s ago")).toBeTruthy();
  expect(calls).toContainEqual({ url: "api/repos/refresh", method: "POST" });
});

test("a repository's panel: errors first, then what runs get, then the file", async () => {
  render(<Page />);
  fireEvent.click(await screen.findByRole("button", { name: "org/api" }));
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("No run starts until these are fixed");
  expect(alert.textContent).toContain("effort: expected one of low, medium, high");
  // A refused host stops runs too: it is listed with the errors.
  expect(alert.textContent).toContain("pypi.org");
  expect(screen.getByText("colour: unknown, ignored")).toBeTruthy();
  const users = screen.getByText("users").closest("tr")!;
  expect(within(users).getByText("from repo")).toBeTruthy();
  expect(within(users).getByText(/narrowed from ALLOWED_USERS/)).toBeTruthy();
  expect(within(screen.getByText("effort").closest("tr")!).getByText("from operator")).toBeTruthy();
  expect(
    within(screen.getByText("pypi.org", { selector: "th code" }).closest("tr")!).getByText(
      "refused",
    ),
  ).toBeTruthy();
  expect(screen.getByText(/users: \[alice\]/, { selector: "pre" })).toBeTruthy();
  expect(screen.getByRole("link", { name: "on GitHub" }).getAttribute("href")).toBe(
    "https://github.com/org/api/blob/main/.deckhand.yaml",
  );
  expect(screen.getByText(/read 0s ago/)).toBeTruthy();
  // The row read along with it: invalid now.
  expect(screen.getByRole("heading", { name: /org\/api/ }).textContent).toContain("Invalid config");
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await waitFor(() =>
    expect(calls).toContainEqual({ url: "api/repos/org/api/refresh", method: "POST" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "← Repositories" }));
  expect(within(await screen.findByRole("list")).getAllByText("Invalid config")).toHaveLength(2);
});

test("a repository's broken grant: the file to fix, and only this repository stopped", async () => {
  const listed = fetch;
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (url !== "api/repos/org/api/config") return listed(url, init);
    return Response.json({
      ...CONFIG,
      errors: [],
      grantsError: {
        file: "org/api.yaml",
        message: 'hosts: "bad host": not a host name',
        everyRepo: false,
      },
      effective: { ...CONFIG.effective, hosts: [], grant: null },
    });
  });
  render(<Page />);
  fireEvent.click(await screen.findByRole("button", { name: "org/api" }));
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain(
    'org/api.yaml in the operator\'s grants folder has errors, so no run starts in this repository: hosts: "bad host"',
  );
  expect(screen.getByText("Unknown: the operator's grants have errors.")).toBeTruthy();
});

test("a config that parses but asks for what isn't granted: Invalid config, not Configured", async () => {
  const listed = fetch;
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (url !== "api/repos/org/api/config") return listed(url, init);
    return Response.json({
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
