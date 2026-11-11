// The fake API the docs' screenshots are taken against (../screenshots.mjs): the specs' fixture
// (fixture.json) for api/state, and what the pages shot read beside it. Fake data only, on
// github.example.com: no real repository, user or host ever shows in the docs. Typed against
// types/, so `npm run build` fails here when the contract changes, not the screenshots
// silently. Read by Node as it is (type stripping): type-only imports, nothing else of src/.
import fixture from "./fixture.json" with { type: "json" };
import type {
  Capabilities,
  Chats,
  DryRun,
  Entry,
  Health,
  Repo,
  RepoConfig,
  Repos,
  ServiceName,
  SettingRow,
  State,
  Workflow,
  WorkflowCheck,
  WorkflowFiles,
  WorkflowNode,
} from "./types";

const FIXTURE = fixture as State;
const NOW = FIXTURE.now;
const MIN = 60_000;
const GITHUB = FIXTURE.githubUrl;

// The fixture, with the inboxes New request sends ideas and bug reports to.
export const STATE: State = {
  ...FIXTURE,
  inboxes: {
    "acme/app": { ideas: 3, bugs: 4, discussions: null },
    "acme/api": { ideas: 7, bugs: 8, discussions: null },
  },
};

// The live run the log screenshot follows: acme/app#22's, started 7 minutes before NOW.
export const LIVE_TASK = "acme/app#22";
export const LIVE_RUN = "acme-app-22-1791989580000";
const START = NOW - 7 * MIN;
const at = (seconds: number) => START + seconds * 1000;

export const LOG: Entry[] = [
  { kind: "phase", phase: "setup", at: at(0) },
  { kind: "meta", text: "Sandbox started: acme/app on issue-22-dashboard-on-a-frontend-framework" },
  { kind: "raw", text: "added 214 packages in 9s", at: at(14) },
  { kind: "phase", phase: "work", at: at(20) },
  {
    kind: "message",
    text: "Deckhand\nnpm is allowed now: carry on.",
    at: at(20),
  },
  {
    kind: "text",
    text: "The egress proxy lets registry.npmjs.org through now. I'll install the dashboard's packages and build it.",
    at: at(31),
  },
  { kind: "tool", name: "Bash", text: "cd dashboard && npm ci", id: "t1", at: at(34) },
  { kind: "output", text: "added 96 packages, audited 97 packages in 6s", error: false, id: "t1" },
  { kind: "tool", name: "Read", text: "dashboard/vite.config.ts", id: "t2", at: at(48) },
  { kind: "output", text: "export default defineConfig({ … })", error: false, id: "t2" },
  { kind: "tool", name: "Edit", text: "listener/static.mjs", id: "t3", at: at(95) },
  { kind: "output", text: "The file has been updated.", error: false, id: "t3" },
  {
    kind: "text",
    text: "The listener serves dashboard/dist/ now. Running the tests before pushing.",
    at: at(160),
  },
  { kind: "tool", name: "Bash", text: "node --test", id: "t4", at: at(171) },
  { kind: "output", text: "# tests 412\n# pass 412\n# fail 0", error: false, id: "t4" },
  { kind: "phase", phase: "push", at: at(400) },
  {
    kind: "tool",
    name: "Bash",
    text: "git push origin issue-22-dashboard-on-a-frontend-framework",
    id: "t5",
    at: at(402),
  },
  { kind: "output", text: "3 commits pushed", error: false, id: "t5" },
];

const repo = (name: string, over: Partial<Repo> = {}): Repo => ({
  repo: name,
  url: `${GITHUB}/${name}`,
  private: true,
  issues: true,
  status: "configured",
  issue: null,
  readAt: NOW - 2 * MIN,
  autoMerge: false,
  ...over,
});

export const REPOS: Repos = {
  repos: [
    repo("acme/api", { backlog: { count: 12, more: false, readAt: NOW - 2 * MIN } }),
    repo("acme/app", { backlog: { count: 7, more: false, readAt: NOW - 2 * MIN } }),
    repo("acme/notes", { private: false, backlog: { count: 2, more: false, readAt: NOW } }),
    repo("acme/site", {
      status: "not-onboarded",
      issue: null,
      readAt: null,
    }),
  ],
  listedAt: NOW - 2 * MIN,
  app: {
    name: "acme-deckhand",
    installUrl: `${GITHUB}/apps/acme-deckhand/installations/new`,
    settingsUrl: `${GITHUB}/settings/apps/acme-deckhand`,
    missingEvents: [],
    missingPermissions: [],
    installations: [
      {
        account: "acme",
        url: `${GITHUB}/organizations/acme/settings/installations/1`,
        missing: [],
      },
    ],
  },
};

const CONFIG_TEXT = `# acme/app
users: [octocat, hubot]
max_parallel: 2
model: opus
effort: high
setup: npm ci
caches: [~/.npm]
review: true
`;

const row = (key: string, value: string, over: Partial<SettingRow> = {}): SettingRow => ({
  key,
  value,
  source: "operator",
  note: null,
  line: null,
  ...over,
});

// Each mode's capabilities, as listener/capabilities.mjs gives them.
const CATALOGUE: Capabilities["catalogue"] = (
  [
    ["pull", "a clone of the repository: its code and history", [], []],
    ["push", "its branches pushed, its issue's branch and draft pull request", ["pull"], []],
    ["setup", "the repository's setup command, and its caches", ["pull"], ["setup", "caches"]],
    ["read:issues", "the repository's issues", [], []],
  ] as const
).map(([name, what, needs, config]) => ({
  name,
  what,
  needs: [...needs],
  config: [...config],
  grant: null,
  enforcedBy: "the listener at start",
}));

const mode = (name: string, used: string[]): Capabilities["modes"][number] => ({
  mode: name,
  custom: false,
  capabilities: CATALOGUE.map((c) =>
    used.includes(c.name)
      ? {
          name: c.name,
          status: "used",
          used: true,
          files: [{ layer: "operator", file: `mode-${name}.rego` }],
          reason: null,
        }
      : {
          name: c.name,
          status: "not-allowed",
          used: false,
          files: [],
          reason: "no allow rule of the operator's policies gives it",
        },
  ),
  used,
  errors: [],
  warnings: [],
});

// The lifecycle of a repo with every step but the conflict watcher on: its merge refused
// without the operator's auto_merge grant, its review left to Deckhand's review.rego.
const node = (
  id: WorkflowNode["id"],
  rank: number,
  lane: number,
  settings: WorkflowNode["settings"] = {},
  more: Partial<WorkflowNode> = {},
): WorkflowNode => ({ id, rank, lane, state: "on", key: "review", settings, reasons: [], ...more });

export const WORKFLOW: Workflow = {
  sample: true,
  nodes: [
    node("ready", 0, 0, {}, { key: "review.on" }),
    node("ci", 1, 0, { minutes: 30 }, { key: "review.ci" }),
    node("ci-fix", 1, 1, { rounds: 2 }, { key: "review.ci_fix", decision: "fix" }),
    node(
      "review",
      2,
      0,
      { severity: "medium" },
      {
        decision: "review",
        state: "depends",
        reasons: [{ layer: "operator", file: "review.rego", rule: "deny_review" }],
      },
    ),
    node("fix", 2, 1, { rounds: 3 }, { key: "review.fix", decision: "fix" }),
    node(
      "merge",
      3,
      0,
      { method: "squash", minutes: 30 },
      {
        key: "review.merge",
        decision: "merge",
        grant: "auto_merge",
        state: "refused",
        reasons: [
          {
            message: "review.merge: not granted (auto_merge), nothing is merged",
            grant: "auto_merge",
          },
        ],
      },
    ),
    node("rebase", 3, 1, { minutes: null }, { key: "conflicts", state: "off", decision: "fix" }),
    node("done", 4, 0),
  ],
  edges: [
    { from: "ready", to: "ci", when: ["ready"], back: false },
    { from: "ci", to: "review", when: ["passed", "no-ci-fix"], back: false },
    { from: "ci", to: "ci-fix", when: ["failed"], back: false },
    { from: "ci", to: "done", when: ["ci-stopped"], back: false },
    { from: "ci-fix", to: "ci", when: ["pushed"], back: true },
    { from: "ci-fix", to: "done", when: ["nothing-pushed"], back: false },
    { from: "review", to: "fix", when: ["blocking"], back: false },
    { from: "review", to: "merge", when: ["clean"], back: false },
    { from: "review", to: "done", when: ["clean", "rounds-out", "no-fix"], back: false },
    { from: "fix", to: "ci", when: ["pushed"], back: true },
    { from: "fix", to: "done", when: ["nothing-pushed"], back: false },
    { from: "merge", to: "done", when: ["merged"], back: false },
  ],
  source: {
    file: null,
    url: null,
    text: `# Deckhand's built-in review loop, compiled from the repository's \`review:\` block.
on: ready
vars:
  fixes: counter
steps:
  - run: ci # review.ci: wait, ci_wait: 30, ci_fix: 2
  - run: review
  - repeat:
      - run: fix # ends the loop when no fix run starts
        count: fixes
      - run: ci # review.ci: wait, ci_wait: 30, ci_fix: 2
      - run: review
    max: fixes 3 # review.fix
  - run: merge # review.merge, with the operator's auto_merge grant
`,
    errors: [],
  },
};

export const CONFIG: RepoConfig = {
  repo: repo("acme/app"),
  base: "main",
  file: {
    text: CONFIG_TEXT,
    sha: "5d41402abc",
    url: `${GITHUB}/acme/app/blob/main/.deckhand.yaml`,
    editUrl: `${GITHUB}/acme/app/edit/main/.deckhand.yaml`,
  },
  errors: [],
  warnings: [],
  grantsError: null,
  effective: {
    settings: [
      row("users", "octocat, hubot", {
        source: "repo",
        note: "narrowed from ALLOWED_USERS",
        line: 2,
      }),
      row("trigger", "deckhand"),
      row("model", "opus", { source: "repo", line: 4 }),
      row("effort", "high", { source: "repo", line: 5 }),
      row("max_parallel", "2", { source: "repo", note: "MAX_PARALLEL is 4", line: 3 }),
      row("setup", "npm ci", { source: "repo", line: 6 }),
      row("review", "on", { source: "repo", line: 8 }),
      row("limits", "2 CPUs, 4g memory, 2048 processes", { note: "built in" }),
    ],
    hosts: [
      { host: "github.com", source: "operator", note: "always" },
      { host: "registry.npmjs.org", source: "operator", note: "grants/default.yaml" },
    ],
    mounts: [],
    contextRepos: [],
    grant: {
      files: ["default.yaml"],
      grantFiles: [],
      allowDockerfile: false,
      allowBranchDockerImages: false,
      allowDocker: false,
      allowResearch: true,
      allowWorkflows: false,
      allowWorkflowSecrets: false,
      allowMachines: false,
      allowAutoMerge: false,
      hosts: ["registry.npmjs.org"],
      cachedHosts: [],
      contextRepos: [],
      mounts: [],
      allowProjects: [],
      limits: { cpus: "2", memory: "4g", pids: 2048 },
    },
  },
  policies: { files: [], errors: [], warnings: [] },
  capabilities: {
    catalogue: CATALOGUE,
    modes: [
      mode("work", ["pull", "push", "setup", "read:issues"]),
      mode("brainstorm", ["pull", "read:issues"]),
    ],
    error: null,
  },
  workflow: WORKFLOW,
  readAt: NOW - MIN,
};

const SERVICES: ServiceName[] = [
  "edge",
  "orchestrator",
  "runner",
  "broker",
  "github",
  "models",
  "policy",
  "proxy",
];

export const HEALTH: Health = {
  checkedAt: NOW,
  services: SERVICES.map((name) => ({
    name,
    state: "up",
    startedAt: NOW - 3 * 60 * MIN,
    version: STATE.server?.version ?? null,
    checkedAt: NOW,
  })),
};

export const CHATS: Chats = {
  chats: [],
  limit: 2,
  repos: ["acme/api", "acme/app"],
  agents: [{ name: "claude@anthropic", label: "Claude (anthropic)" }],
  models: ["best", "balanced", "fast"],
  efforts: ["low", "medium", "high", "xhigh", "max"],
};

// The workflow editor's (#1042): a repository's own workflow on `ready`, two reviewers, what it
// parses to, and a dry run on a past pull request that diverged at the second review, a pick
// made, the merge asked.
const REVIEW_YAML = `on: ready
vars:
  fixes: counter
steps:
  - run: ci
  - run: review
  - repeat:
      - run: fix
        count: fixes
      - run: ci
      - run: review
    max: fixes 3
  - if: severity <= low
    then:
      - run: review
        agent: codex
        model: best
      - run: merge
`;

export const WORKFLOW_FILES: WorkflowFiles = {
  base: "main",
  files: [
    {
      name: "review.yaml",
      file: ".deckhand/workflows/review.yaml",
      text: REVIEW_YAML,
      sha: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
      url: `${GITHUB}/acme/app/blob/main/.deckhand/workflows/review.yaml`,
    },
  ],
  builtIn: { ready: null, conflict: "on: conflict\nsteps:\n  - run: rebase\n" },
  running: [{ file: ".deckhand/workflows/review.yaml", event: "ready", current: 3, older: 1 }],
  pulls: [
    { number: 212, at: NOW - 2 * 60 * MIN, reviews: 2, fixes: 1, merged: true },
    { number: 207, at: NOW - 26 * 60 * MIN, reviews: 1, fixes: 0, merged: true },
  ],
};

export const WORKFLOW_CHECK: WorkflowCheck = {
  on: ["ready"],
  errors: [],
  steps: [
    { line: 5, kind: "run", run: "ci" },
    { line: 6, kind: "run", run: "review" },
    {
      line: 7,
      kind: "repeat",
      max: { var: "fixes", rounds: 3 },
      repeat: [
        { line: 8, kind: "run", run: "fix", count: "fixes" },
        { line: 10, kind: "run", run: "ci" },
        { line: 11, kind: "run", run: "review" },
      ],
    },
    {
      line: 13,
      kind: "if",
      if: "severity <= low",
      then: [
        { line: 15, kind: "run", run: "review", agent: "codex", model: "best" },
        { line: 18, kind: "run", run: "merge" },
      ],
    },
  ],
};

export const DRY_RUN: DryRun = {
  pr: { number: 212, title: "Per-repo budgets for runs", url: `${GITHUB}/acme/app/pull/212` },
  event: "ready",
  history: [
    { run: "review", outcome: "medium" },
    { run: "fix", outcome: "pushed" },
    { run: "review", outcome: "low" },
    { run: "merge", outcome: "merged" },
  ],
  trail: [
    { line: 5, run: "ci", outcome: "passed", source: "assumed" },
    { line: 6, run: "review", outcome: "medium", source: "recorded" },
    { line: 8, run: "fix", outcome: "pushed", source: "recorded" },
    { line: 10, run: "ci", outcome: "passed", source: "assumed" },
    { line: 11, run: "review", outcome: "low", source: "recorded" },
    { line: 8, run: "fix", outcome: "none", source: "auto" },
    { line: 15, run: "review", outcome: "none", source: "picked" },
  ],
  diverged: { line: 15, run: "review", index: 6, expected: { run: "merge", outcome: "merged" } },
  ask: { line: 18, run: "merge", options: ["merged", "refused"] },
  end: "asking",
  leftover: [],
};

// POST routes, the same way: their answer whatever the body.
export const POSTS: Record<string, unknown> = {
  "repos/acme/app/workflows/check": WORKFLOW_CHECK,
  "repos/acme/app/workflows/dry-run": DRY_RUN,
};

// GET routes, by path under api/ (the query left out). Any other answers 404.
export const ROUTES: Record<string, unknown> = {
  state: STATE,
  health: HEALTH,
  repos: REPOS,
  "repos/acme/app/config": CONFIG,
  "repos/acme/app/workflows": WORKFLOW_FILES,
  chats: CHATS,
};
