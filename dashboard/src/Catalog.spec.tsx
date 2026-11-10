// Every page of #723 writes its own texts through the catalog: in a marked one (testCatalog.ts),
// nothing of the dashboard's own is left unmarked. What the page was given (the tasks, the
// repositories, what the API answered) is data, not the dashboard's to translate.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { beforeAll, beforeEach, expect, test, vi } from "vitest";
import type { RepoList } from "./api";
import type {
  AccessReport,
  AnalysisPreview,
  AppLinks,
  Health,
  Inboxes,
  Machines,
  McpClient,
  Repo,
  RepoConfig,
  ServerSetup,
} from "./types";

vi.mock("./locales", async (original) =>
  (await import("./testCatalog")).withMarked(await original()),
);

// Imported after the mock, as Language.spec.tsx does.
let { Dashboard } = {} as typeof import("./App");
let { makeCapabilities, makePolicyFile, makeState, makeChat, makeChats, mockApi } =
  {} as typeof import("./testUtils");
let { t } = {} as typeof import("./i18n");
let { english, keysShown, parts, strings, unmarked, useMarked } =
  {} as typeof import("./testCatalog");
let { CATALOGS } = {} as typeof import("./locales");

beforeAll(async () => {
  vi.resetModules();
  ({ Dashboard } = await import("./App"));
  ({ makeCapabilities, makePolicyFile, makeState, makeChat, makeChats, mockApi } =
    await import("./testUtils"));
  ({ t } = await import("./i18n"));
  ({ english, keysShown, parts, strings, unmarked, useMarked } = await import("./testCatalog"));
  ({ CATALOGS } = await import("./locales"));
});

// Keys (they aren't translated), names (the services', the first as the health alert writes it
// at the start of its sentence, a language's own), what the browser
// writes of a date in a language it has no data for (English), and a commit's short sha.
const NAMES = [
  ...["Ctrl", "Shift", "Esc", "Space"],
  ...["Deckhand", "GitHub", "Claude", "English", "Français"],
  ...["edge", "github", "policy", "orchestrator", "models", "broker", "runner", "proxy", "Runner"],
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
  warnings: [{ key: "colour", message: "Xyzzy colour", line: null, fix: null }],
  grantsError: null,
  effective: {
    settings: [
      { key: "users", value: "alice", source: "repo", note: "narrowed", line: 1 },
      { key: "effort", value: "medium", source: "operator", note: null, line: 2 },
    ],
    hosts: [{ host: "pypi.org", source: "operator", note: "grants/acme/app.yaml" }],
    mounts: [],
    contextRepos: [],
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
      allowMachines: false,
      hosts: ["pypi.org"],
      cachedHosts: [],
      contextRepos: [],
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

// Settings › MCP clients' machines: one online, one offline with no labels.
const MACHINES: Machines = {
  machines: [
    {
      id: "m1",
      name: "studio",
      labels: ["gpu"],
      capacity: 2,
      repos: ["acme/app"],
      version: "0.1.0",
      createdAt: Date.now() - 86_400_000,
      seenAt: Date.now() - 10_000,
      online: true,
    },
    {
      id: "m2",
      name: "laptop",
      labels: [],
      capacity: 1,
      repos: ["acme/api"],
      version: null,
      createdAt: Date.now() - 86_400_000,
      seenAt: Date.now() - 3_600_000,
      online: false,
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

// Every kind of request open on acme/app: New request shows each form.
const INBOXES: Record<string, Inboxes> = {
  "acme/app": { ideas: 4, bugs: 5, discussions: "Ideas" },
};

const PREVIEW: AnalysisPreview = {
  runs: ["a"],
  included: 5,
  left: 2,
  bytes: 1,
  tokens: 5000,
  kinds: ["bug", "audit", "work"],
  max: 50,
};

// A service down and one starting: the sidebar's alert shows.
const HEALTH: Health = {
  checkedAt: Date.now(),
  services: [
    {
      name: "runner",
      state: "down",
      startedAt: null,
      version: null,
      checkedAt: Date.now(),
      reason: "connect ECONNREFUSED",
    },
    {
      name: "broker",
      state: "starting",
      startedAt: Date.now(),
      version: "1.2.3",
      checkedAt: Date.now(),
      warnings: ["no Redis yet"],
    },
  ],
};

let config: RepoConfig;
// What the spec's routes answer: written for these pages, all data.
let given: unknown[];
// The fixture's state: its prose ("Done: settings follow…") is data only in the parts no
// English text has ("Done" is the catalog's).
let prose: unknown[];
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
    "api/machines": () => MACHINES,
    "api/health": () => HEALTH,
    "api/repos/acme/app/analyze": () => PREVIEW,
    "api/chats": () => makeChats([makeChat()]),
  };
  mockApi(routes);
  prose = [];
  given = [
    REPOS,
    APP,
    config,
    SETUP,
    CLIENTS,
    ACCESS,
    MACHINES,
    HEALTH,
    PREVIEW,
    makeChats([makeChat()]),
  ];
});

const show = (hash: string) => {
  history.replaceState(null, "", hash);
  // Titles no dashboard text could be mistaken for.
  const fixture = makeState({ inboxes: INBOXES });
  const state = {
    ...fixture,
    tasks: fixture.tasks.map((task) => ({ ...task, title: `Xyzzy ${task.number}` })),
  };
  prose.push(state);
  return render(<Dashboard state={state} error={null} repos={list()} />).container;
};

// A key shown as it is fails first: unmarked() would take it for an identifier.
const left = (root: Element = document.body, more: readonly string[] = []) => {
  const keys = keysShown(root, Object.keys(CATALOGS.en));
  if (keys.length) return keys;
  const own = english(CATALOGS.en);
  return unmarked(root, {
    data: strings([...given, ...prose])
      .flatMap(parts)
      .filter((part) => !own.has(part)),
    names: [...NAMES, ...more],
  });
};

test.each([
  ["Overview", "#/", null],
  ["Settings › Repositories", "#/settings/repositories", "acme/bad"],
  // An effort's value, which the run pages' catalog writes too ("{count} high" findings).
  [
    "a repository's config",
    "#/settings/repositories/acme/app",
    "expected one of low, medium, high",
    ["medium", "high"],
  ],
  // Rego's keywords, and the decisions' names breakable() cuts out of their rules'.
  [
    "its policies",
    "#/settings/repositories/acme/app/policies",
    "size.rego",
    ["allow", "deny", "run", "fix", "link", "branch", "request", "review"],
  ],
  // A capability's name.
  ["its capabilities", "#/settings/repositories/acme/app/capabilities", "work", ["setup"]],
  ["Settings › Preferences", "#/settings/preferences", null],
  ["Settings › MCP clients", "#/settings/clients", "laptop"],
  // The GitHub permissions the App lacks, by GitHub's names.
  // An event's name too ("issues", which a node's waits write).
  ["Settings › Server", "#/settings/server", /alice/, ["actions", "checks", "read", "issues"]],
  ["Settings › Access", "#/settings/access", "@carol"],
  ["Chats", "#/chats", null],
] as [string, string, string | RegExp | null, string[]?][])("%s", async (_, hash, shown, more) => {
  show(hash);
  if (shown) await screen.findAllByText(shown);
  // What loads after (the API's answers) shows too.
  await waitFor(() => expect(document.querySelector("[aria-busy=true]")).toBeNull());
  expect(left(document.body, more)).toEqual([]);
});

test("the health alert", async () => {
  show("#/");
  const alert = await screen.findAllByRole("link", { name: /⟦ down⟧/ });
  expect(alert.flatMap((a) => left(a))).toEqual([]);
});

test("the palette and its shortcuts' help", async () => {
  show("#/");
  fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
  expect(left(screen.getByRole("dialog"))).toEqual([]);
  fireEvent.input(screen.getByRole("combobox"), { target: { value: "zzzz" } });
  given.push("zzzz");
  expect(left(screen.getByRole("dialog"))).toEqual([]);
  fireEvent.keyDown(document.body, { key: "Escape" });

  fireEvent.keyDown(document.body, { key: "?", shiftKey: true });
  expect(left(screen.getByRole("dialog"))).toEqual([]);
});

test("New request: each kind's form", async () => {
  show("#/acme/app");
  fireEvent.keyDown(document.body, { key: "n" });
  const dialog = await screen.findByRole("dialog");
  const kinds = within(within(dialog).getByRole("group", { name: t("request.kind") }));
  // Each kind's own field: the form that shows is that kind's, not the one before it.
  const forms = [
    ["request.kindIdea", "inbox.ideaTitle"],
    ["request.kindBug", "inbox.bugTitle"],
    ["request.kindDiscussion", "inbox.discussionTitle"],
    ["request.kindAnalyze", null],
  ] as const;
  for (const [kind, title] of forms) {
    fireEvent.click(kinds.getByRole("button", { name: t(kind) }));
    if (title) expect(within(dialog).getByPlaceholderText(t(title))).toBeTruthy();
    else await within(dialog).findByText(/⟦ runs? match/);
    expect(left(dialog)).toEqual([]);
  }
});
