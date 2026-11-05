// Every page of #723 writes its own texts through the catalog: in a marked one (testCatalog.ts),
// nothing of the dashboard's own is left unmarked. What the page was given (the tasks, the
// repositories, what the API answered) is data, not the dashboard's to translate.
import { fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { beforeAll, beforeEach, expect, test, vi } from "vitest";
import type { RepoList } from "./api";
import type { AccessReport, AppLinks, McpClient, Repo, RepoConfig, ServerSetup } from "./types";

vi.mock("./locales", async (original) =>
  (await import("./testCatalog")).withMarked(await original()),
);

// Imported after the mock, as Language.spec.tsx does.
let { Dashboard } = {} as typeof import("./App");
let { makeCapabilities, makePolicyFile, makeState, makeChat, makeChats, mockApi } =
  {} as typeof import("./testUtils");
let { unmarked, useMarked } = {} as typeof import("./testCatalog");
let { STATE_NAMES } = {} as typeof import("./format");

beforeAll(async () => {
  vi.resetModules();
  ({ Dashboard } = await import("./App"));
  ({ makeCapabilities, makePolicyFile, makeState, makeChat, makeChats, mockApi } =
    await import("./testUtils"));
  ({ unmarked, useMarked } = await import("./testCatalog"));
  ({ STATE_NAMES } = await import("./format"));
});

// Every string in what the page was given.
function strings(...values: unknown[]): string[] {
  const found = new Set<string>();
  const walk = (v: unknown) => {
    if (typeof v === "string") found.add(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  values.forEach(walk);
  return [...found];
}

// Keys (they aren't translated), names (the services', a policy's decisions', a language's own),
// what the browser writes of a time, and a commit's short sha.
const NAMES = [
  ...["Ctrl", "Shift", "Esc", "Space"],
  ...["Deckhand", "GitHub", "Claude", "English"],
  ...["edge", "github", "policy", "orchestrator", "models", "broker", "runner", "proxy"],
  ...["deny", "fix", "link", "branch", "request"],
  ...["AM", "PM", "Oct"],
  "abcdef1",
];

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
  repo("acme/app", { status: "configured" }),
  repo("acme/api"),
  repo("acme/docs", {
    status: "onboarding",
    issue: { number: 7, url: "https://github.com/acme/docs/issues/7" },
  }),
  repo("acme/wiki", { issues: false }),
  repo("acme/bad", { status: "invalid" }),
];

const APP: AppLinks = {
  name: "acme-deckhand",
  installUrl: "https://github.com/apps/acme-deckhand/installations/new",
  settingsUrl: "https://github.com/organizations/acme/settings/apps/acme-deckhand",
  missingEvents: ["issues"],
  missingPermissions: ["checks: read"],
  installations: [
    {
      account: "acme",
      url: "https://github.com/organizations/acme/settings/installations/1",
      missing: ["actions: read"],
    },
    { account: null, url: "https://github.com/settings/installations/2", missing: [] },
  ],
};

const list = (repos: Repo[] = REPOS): RepoList => ({
  repos,
  app: APP,
  error: null,
  starting: null,
  failed: null,
  onboard: async () => {},
  listedAt: Date.now() - 180000,
  refreshing: false,
  refreshError: null,
  refresh: async () => {},
  update: () => {},
});

const CONFIG: RepoConfig = {
  repo: repo("acme/app", { status: "invalid", readAt: Date.now() }),
  base: "main",
  file: {
    text: "users: [alice]\neffort: loud\n",
    sha: "abcdef1234",
    url: "https://github.com/acme/app/blob/main/.deckhand.yaml",
    editUrl: "https://github.com/acme/app/edit/main/.deckhand.yaml",
  },
  errors: [{ key: "effort", message: "expected one of low, medium, high", line: 2, fix: null }],
  warnings: [{ key: "colour", message: "unknown, ignored", line: null, fix: null }],
  grantsError: null,
  effective: {
    settings: [
      { key: "users", value: "alice", source: "repo", note: "narrowed", line: 1 },
      { key: "effort", value: "medium", source: "operator", note: null, line: 2 },
    ],
    hosts: [{ host: "pypi.org", source: "operator", note: "grants/acme/app.yaml" }],
    mounts: [],
    grant: {
      files: ["acme/app.yaml"],
      grantFiles: [],
      allowDockerfile: false,
      allowBranchDockerImages: false,
      allowDocker: false,
      allowResearch: false,
      allowWorkflows: false,
      allowWorkflowSecrets: false,
      allowAutoMerge: false,
      hosts: ["pypi.org"],
      cachedHosts: [],
      mounts: [],
      allowProjects: [],
      limits: { cpus: "2", memory: "4g", pids: 2048 },
    },
  },
  policies: {
    files: [
      makeFile({ name: "size.rego", source: "operator", rules: ["deny_merge"] }),
      makeFile({ name: "base.rego", source: "repo", rules: ["deny_merge", "deny_review"] }),
    ],
    errors: [
      {
        layer: "repo",
        file: "base.rego",
        row: 4,
        message: "rego_parse_error: unexpected eof token",
        text: "policy error: base.rego:4: rego_parse_error: unexpected eof token",
      },
    ],
    warnings: ["base.rego: deny_merged isn't a rule Deckhand evaluates"],
  },
  capabilities: null as unknown as RepoConfig["capabilities"],
  readAt: Date.now(),
};
// makePolicyFile once the module is loaded.
function makeFile(over: Parameters<typeof makePolicyFile>[0]) {
  return over as ReturnType<typeof makePolicyFile>;
}

const SETUP: ServerSetup = {
  engine: "sysbox",
  proxy: { on: true, hosts: 14 },
  grants: { ok: false, file: "acme.yaml", message: "bad indent" },
  claude: { set: ["plan", "key"], default: "plan", fallbacks: ["key"] },
  allowedUsers: ["alice", "bob"],
  allowedRepos: ["acme/*"],
};

const CLIENTS: { resource: string; clients: McpClient[] } = {
  resource: "https://deck.example.com/mcp",
  clients: [
    {
      id: "a",
      name: "Claude Code",
      client: "c-a",
      redirect: "http://127.0.0.1:33418/callback",
      scopes: ["deckhand:read", "deckhand:work"],
      created: Date.now() - 3 * 3600_000,
      used: Date.now() - 120_000,
    },
  ],
};

const ACCESS: AccessReport = {
  repos: ["acme/api", "acme/app"],
  error: null,
  users: [
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

let config: RepoConfig;
let given: unknown[];
beforeEach(() => {
  useMarked();
  config = {
    ...CONFIG,
    policies: {
      ...CONFIG.policies,
      files: CONFIG.policies.files.map((f) => makePolicyFile(f)),
    },
    capabilities: makeCapabilities(),
  };
  const routes = {
    "api/repos": () => ({ repos: REPOS, app: APP, listedAt: Date.now() }),
    "api/repos/acme/app/config": () => config,
    "api/server": () => SETUP,
    "api/mcp/clients": () => CLIENTS,
    "api/access": () => ACCESS,
    "api/health": () => ({ checkedAt: Date.now(), services: [] }),
    "api/chats": () => makeChats([makeChat()]),
  };
  mockApi(routes);
  given = [REPOS, APP, config, SETUP, CLIENTS, ACCESS, makeChats([makeChat()])];
});

const show = (hash: string) => {
  history.replaceState(null, "", hash);
  const state = makeState();
  given.push(state);
  return render(<Dashboard state={state} error={null} repos={list()} />).container;
};

// A task's state, as format.ts names it, is the run pages' to move (#722).
const left = (root: Element = document.body) =>
  unmarked(root, [...NAMES, ...Object.values(STATE_NAMES), ...strings(given)]);

test.each([
  ["Overview", "#/", null],
  ["Settings › Repositories", "#/settings/repositories", "acme/bad"],
  [
    "a repository's config",
    "#/settings/repositories/acme/app",
    "expected one of low, medium, high",
  ],
  ["its policies", "#/settings/repositories/acme/app/policies", "size.rego"],
  ["its capabilities", "#/settings/repositories/acme/app/capabilities", "work"],
  ["Settings › Preferences", "#/settings/preferences", null],
  ["Settings › MCP clients", "#/settings/clients", "Claude Code"],
  ["Settings › Server", "#/settings/server", /alice/],
  ["Settings › Access", "#/settings/access", "@carol"],
  ["Chats", "#/chats", null],
])("%s", async (_, hash, shown) => {
  show(hash);
  if (shown) await screen.findAllByText(shown);
  // What loads after (the API's answers) shows too.
  await waitFor(() => expect(document.querySelector("[aria-busy=true]")).toBeNull());
  expect(left()).toEqual([]);
});

test("the palette, its shortcuts' help and New request", async () => {
  show("#/");
  fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
  expect(left(screen.getByRole("dialog"))).toEqual([]);
  fireEvent.input(screen.getByRole("combobox"), { target: { value: "zzzz" } });
  given.push("zzzz");
  expect(left(screen.getByRole("dialog"))).toEqual([]);
  fireEvent.keyDown(document.body, { key: "Escape" });

  fireEvent.keyDown(document.body, { key: "?", shiftKey: true });
  expect(left(screen.getByRole("dialog"))).toEqual([]);
  fireEvent.keyDown(document.body, { key: "Escape" });

  fireEvent.keyDown(document.body, { key: "n" });
  expect(left(await screen.findByRole("dialog"))).toEqual([]);
});
