// Settings › Server against a fake api/server: the status, the runs and grants, the preview
// hooks, the GitHub App, and Sync now updating the last sync.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { useState } from "preact/hooks";
import { beforeEach, expect, test } from "vitest";
import type { RepoList } from "./api";
import { Dashboard } from "./App";
import { lastSyncLine } from "./Server";
import { makeState, mockApi } from "./testUtils";
import type { AppLinks, ServerSetup, State } from "./types";

const SETUP: ServerSetup = {
  engine: "sysbox",
  proxy: { on: true, hosts: 14 },
  grants: { ok: true, file: null, message: null },
  claude: { set: ["plan", "key"], default: "plan" },
  allowedUsers: ["alice", "bob"],
  allowedRepos: ["acme/*", "bryansmee/deckhand"],
};

const APP: AppLinks = {
  name: "acme-deckhand",
  installUrl: "https://github.com/apps/acme-deckhand/installations/new",
  settingsUrl: "https://github.com/organizations/acme/settings/apps/acme-deckhand",
  installations: [
    { account: "acme", url: "https://github.com/organizations/acme/settings/installations/1" },
    { account: null, url: "https://github.com/settings/installations/2" },
  ],
};

const list = (app: AppLinks | null = APP): RepoList => ({
  repos: [],
  app,
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

let api: ReturnType<typeof mockApi>;
beforeEach(() => {
  history.replaceState(null, "", "#/settings/server");
  api = mockApi({ "api/server": () => SETUP });
});

const card = (name: string) =>
  within(screen.getByRole("heading", { name }).closest("section") as HTMLElement);

// The kv row of a term: its value.
const value = (term: string) =>
  card("GitHub App").getByText(term).closest("div")!.querySelector("dd")!;

test("what this Deckhand is and how it is set up", async () => {
  const state = makeState({
    previews: [
      {
        name: "acme-app-preview-pr-33",
        repo: "acme/app",
        event: "pull_request",
        action: "synchronize",
        state: "running",
        since: 1791990000000 - 4 * 60000,
      },
      {
        name: "acme-site-preview-main",
        repo: "acme/site",
        event: "workflow_run",
        action: null,
        state: "waiting",
        since: 1791990000000 - 60000,
      },
    ],
  });
  render(<Dashboard state={state} error={null} repos={list()} />);
  await screen.findByText("Sysbox");

  // The status: the version linked to its commit, the uptime on the server's clock, Node and
  // the repository it was built from.
  const status = card("The listener is up");
  expect(status.getByRole("link", { name: "edge-1713fa6" }).getAttribute("href")).toBe(
    "https://github.com/acme/deckhand/commit/1713fa6",
  );
  expect(status.getByText(/up 3 d 3 h, since/)).toBeTruthy();
  expect(status.getByText(/Node 26\.1\.0/)).toBeTruthy();
  expect(status.getByRole("link", { name: "acme/deckhand" }).getAttribute("href")).toBe(
    "https://github.com/acme/deckhand",
  );

  const runs = card("Runs");
  expect(runs.getByText("MAX_PARALLEL 4")).toBeTruthy();
  expect(runs.getByRole("img", { name: "2 of 4 run slots in use" })).toBeTruthy();
  expect(runs.getByText("2 running · 1 queued")).toBeTruthy();
  expect(runs.getByText("On · 14 hosts granted")).toBeTruthy();
  expect(runs.getByText("Read, no errors")).toBeTruthy();
  expect(runs.getByText("Plan first, then API key as fallback")).toBeTruthy();
  expect(runs.getByText("CLAUDE_CODE_OAUTH_TOKEN")).toBeTruthy();

  const previews = card("Preview hooks");
  expect(previews.getByText("2 going on")).toBeTruthy();
  const rows = previews.getAllByRole("row").slice(1);
  expect(rows.map((r) => [...r.querySelectorAll("td")].map((td) => td.textContent))).toEqual([
    ["acme-app-preview-pr-33", "acme/app", "pull_request · synchronize", "Running", "4 min"],
    ["acme-site-preview-main", "acme/site", "workflow_run", "Waiting", "1 min"],
  ]);

  const app = card("GitHub App");
  expect(app.getByRole("link", { name: "App settings" }).getAttribute("href")).toBe(
    APP.settingsUrl,
  );
  expect(app.getByRole("link", { name: "Install on another account" }).getAttribute("href")).toBe(
    APP.installUrl,
  );
  expect(value("Name").textContent).toBe("acme-deckhand");
  expect(value("Installed on").textContent).toBe("acme · configure ↗An account · configure ↗");
  expect(
    within(value("Installed on"))
      .getAllByRole("link")
      .map((a) => a.getAttribute("href")),
  ).toEqual(APP.installations.map((i) => i.url));
  // The fixture's last sync, 12 minutes before its `now`.
  expect(value("Webhook deliveries").textContent).toContain(
    "Last sync 12 min ago: 2 missed deliveries asked again, 1 pull request updated, 1 rebase run started.",
  );
  expect(value("Who can sign in").textContent).toBe("alice, bob · ALLOWED_USERS");
  expect(value("Allowed repositories").textContent).toBe(
    "acme/*, bryansmee/deckhand · ALLOWED_REPOS",
  );
});

test("the Claude credential runs use: the key alone, a gateway, none, or a listener from before", async () => {
  const shows = async (claude: ServerSetup["claude"], text: string | null) => {
    api.routes["api/server"] = () => ({ ...SETUP, claude });
    const { unmount } = render(<Dashboard state={makeState()} error={null} repos={list()} />);
    await screen.findByText("Sysbox");
    if (text) expect(card("Runs").getByText(text)).toBeTruthy();
    else expect(card("Runs").queryByText("Claude")).toBeNull();
    unmount();
  };
  await shows({ set: ["key"], default: "key" }, "API key");
  // Behind a gateway's token, the key isn't used.
  await shows({ set: ["key"], default: "gateway" }, "Gateway");
  await shows({ set: [], default: null }, "No credential set");
  await shows(undefined, null);
});

test("a grants folder with errors: the file to fix and the message", async () => {
  api.routes["api/server"] = () => ({
    ...SETUP,
    proxy: { on: true, hosts: null },
    grants: {
      ok: false,
      file: "acme/app.yaml",
      message: "acme/app.yaml has errors (a repository's config panel says what)",
    },
  });
  render(<Dashboard state={makeState()} error={null} repos={list()} />);
  const runs = await waitFor(() => {
    const runs = card("Runs");
    runs.getByText("acme/app.yaml");
    return runs;
  });
  expect(runs.getByText("acme/app.yaml").parentElement!.textContent).toBe(
    "Errors in acme/app.yaml",
  );
  expect(
    runs.getByText("acme/app.yaml has errors (a repository's config panel says what)"),
  ).toBeTruthy();
  expect(runs.getByText("On · hosts not counted")).toBeTruthy();
  expect(runs.queryByText("Read, no errors")).toBeNull();
});

test("no engine, every repository allowed, and no preview hook", async () => {
  api.routes["api/server"] = () => ({ ...SETUP, engine: null, allowedRepos: [] });
  render(<Dashboard state={makeState()} error={null} repos={list()} />);
  await screen.findByText("None");
  expect(card("Preview hooks").getByText("None going on")).toBeTruthy();
  expect(card("Preview hooks").queryByRole("table")).toBeNull();
  expect(value("Allowed repositories").textContent).toBe(
    "Every repository the App is installed on · ALLOWED_REPOS",
  );
});

test("api/server not read, the listener out of reach: both said", async () => {
  api.routes["api/server"] = () => Response.json({ error: "boom" }, { status: 500 });
  render(<Dashboard state={makeState()} error="502" repos={list()} />);
  await screen.findByRole("heading", { name: "Can't reach the listener" });
  await waitFor(() => expect(card("Runs").getAllByText("Couldn't read (boom)")).toHaveLength(4));
});

// The App with its own state: Sync now reads it again, as App.tsx's refresh does.
function Live({ first, next }: { first: State; next: State }) {
  const [state, setState] = useState(first);
  return (
    <Dashboard state={state} error={null} repos={list()} refresh={async () => setState(next)} />
  );
}

test("Sync now asks the listener and the last sync line follows, without a reload", async () => {
  const first = makeState();
  const next = makeState({
    lastSync: { at: first.now, by: "octocat", redelivered: 0, pulls: 3, conflicts: 0 },
  });
  api.answer = () => next.lastSync;
  render(<Live first={first} next={next} />);
  const line = value("Webhook deliveries");
  expect(line.textContent).toContain("Last sync 12 min ago");
  fireEvent.click(within(line).getByRole("button", { name: "Sync now" }));
  await waitFor(() =>
    expect(value("Webhook deliveries").textContent).toContain(
      "Last sync 0s ago: 3 pull requests updated.",
    ),
  );
  expect(api.posted).toEqual([{ url: "api/sync", body: undefined }]);
});

test("a refused Sync now says why", async () => {
  api.answer = () => Response.json({ error: "Synced a moment ago." }, { status: 429 });
  render(<Dashboard state={makeState()} error={null} repos={list()} />);
  fireEvent.click(within(value("Webhook deliveries")).getByRole("button", { name: "Sync now" }));
  await waitFor(() =>
    expect(within(value("Webhook deliveries")).getByRole("status").textContent).toBe(
      "Couldn't sync (Synced a moment ago.)",
    ),
  );
});

test("a Sync now that failed but was recorded: said once, on the line", async () => {
  const first = makeState();
  const next = makeState({
    lastSync: {
      at: first.now,
      by: "octocat",
      redelivered: 0,
      pulls: 0,
      conflicts: 0,
      error: "GitHub said 502",
    },
  });
  api.answer = () => next.lastSync;
  render(<Live first={first} next={next} />);
  fireEvent.click(within(value("Webhook deliveries")).getByRole("button", { name: "Sync now" }));
  await waitFor(() =>
    expect(value("Webhook deliveries").textContent).toContain(
      "Last sync 0s ago failed: GitHub said 502",
    ),
  );
  expect(within(value("Webhook deliveries")).queryByRole("status")).toBeNull();
  expect(value("Webhook deliveries").textContent).not.toContain("Couldn't sync");
});

test("before api/state's first answer: loading, neutral, no check", () => {
  render(<Dashboard state={null} error={null} repos={list()} />);
  const heading = screen.getByRole("heading", { name: "Loading…" });
  const section = heading.closest("section")!;
  expect(section.classList.contains("s-idle")).toBe(true);
  expect(section.classList.contains("s-done")).toBe(false);
  expect(section.querySelector("svg")).toBeNull();
});

test("the last sync line: none yet, up to date, failed", () => {
  const now = 10 * 60000;
  expect(lastSyncLine(null, now)).toBe("No sync yet.");
  expect(
    lastSyncLine({ at: now - 120000, by: null, redelivered: 0, pulls: 0, conflicts: 0 }, now),
  ).toBe("Last sync 2 min ago: up to date with GitHub.");
  expect(
    lastSyncLine(
      {
        at: now - 60000,
        by: "octocat",
        redelivered: 0,
        pulls: 0,
        conflicts: 0,
        error: "GitHub said 502",
      },
      now,
    ),
  ).toBe("Last sync 1 min ago failed: GitHub said 502");
});
