import type { Auth } from "./state";

// What names the lane an issue is part of (listener/lanes.mjs): a name a maintainer gave it
// (`user`, `at` when), the title of the parent a plan laid it out under (`parent`), or the
// repo's inbox it is (`inbox`). Picked per lane by lanes.ts laneName().
export type LaneSource = "user" | "parent" | "inbox";
export interface LaneLabel {
  name: string;
  source: LaneSource;
  at?: number;
}

// POST api/repos/<owner>/<repo>/lane: the lane of these issues (task keys) is called `name`
// from now on; "" takes its name off. One line, at most 60 characters.
export interface LaneNaming {
  keys: string[];
  name: string;
}

// POST api/repos/<owner>/<repo>/order: queued task `key` moves right before `before` or right
// after `after` (another of the repo's queued tasks), first (`first`), or last (none of them)
// in the run order. Move down sends `after`: right after the next of the repo's, not last.
export interface OrderMove {
  key: string;
  before?: string | null;
  after?: string;
  first?: boolean;
}

// A catch-up with GitHub (listener/sync.mjs), the last one in State, the one it did from
// POST api/sync: deliveries GitHub couldn't hand over, asked for again, pull requests whose
// state changed, and, from the dashboard only, the rebase runs its conflict pass started.
export interface SyncResult {
  // When it ended.
  at: number;
  // The user who pressed Sync, null for the listener at start.
  by: string | null;
  redelivered: number;
  pulls: number;
  // Rebase runs started (conflicts.mjs check()); 0 at start, where the watcher does it.
  conflicts: number;
  // Why it failed: the failing part's count is 0, the others are kept.
  error?: string;
}

// Which Deckhand runs and since when (listener/status.mjs serverInfo()).
export interface ServerInfo {
  // DECKHAND_VERSION: a release ("1.2.3"), "edge-<short sha>" for a push to main, or "dev".
  version: string;
  startedAt: number;
  // process.version: "v26.1.0".
  node: string;
  // DECKHAND_SOURCE: the repository the image was built from, "" without one.
  source: string;
}

// How this Deckhand is set up, for Settings › Server: GET api/server (listener/status.mjs
// serverSetup()), read when the page opens. Any signed-in user gets it; nothing in it is secret.
export interface ServerSetup {
  // SANDBOX_ENGINE: the container engine of runs granted `docker`. "auto": Sysbox where
  // the host's Docker has it, else Podman. null: none.
  engine: "sysbox" | "podman" | "auto" | null;
  // The egress proxy, always on: the runs' only way out. `hosts`: how many the grants folder
  // grants in all (default.yaml and every repo's file, each host once); null when the folder
  // or its default.yaml has errors.
  proxy: { on: boolean; hosts: number | null };
  // The grants folder: read without errors, or the file to fix (relative to the folder; null
  // when several have errors, or the folder itself) and which have errors. Never the errors
  // themselves: they quote the files' values (mount roots); a repo's config panel has them.
  grants: { ok: boolean; file: string | null; message: string | null };
  // ALLOWED_USERS, lowercase.
  allowedUsers: string[];
  // The Claude credentials set that a fallback or `/agent` can name ("plan", "key"), the one
  // runs use unless they name one ("gateway" too; null: none set), and those FALLBACKS names
  // (`claude@anthropic:key` → "key"), in its order. Names only, never values. A listener from
  // before it sends none (before `fallbacks`: no fallbacks).
  claude?: { set: Auth[]; default: Auth | null; fallbacks?: Auth[] };
  // ALLOWED_REPOS ("owner/repo" or "owner/*"), lowercase; empty: every repo the App is on.
  allowedRepos: string[];
}

// GitHub's own status (#681): GET api/github-status, githubstatus.com's summary as the github
// service last read it (github/status.mjs), every 5 minutes. `watched`: false off github.com
// (GitHub Enterprise Server), nothing else said then.
export type GithubIndicator = "none" | "minor" | "major" | "critical" | "maintenance";
export interface GithubStatus {
  watched: boolean;
  // When the summary shown was read, and the last try (null: none yet); why that try failed
  // (null: it didn't), the summary before it kept.
  checkedAt?: number | null;
  triedAt?: number | null;
  failed?: string | null;
  // null until a summary is read.
  indicator?: GithubIndicator | null;
  // GitHub's own words for it: "All Systems Operational", "Partial System Outage".
  description?: string;
  // The components Deckhand depends on that aren't operational: "Webhooks", "degraded_performance".
  components?: { name: string; status: string }[];
  // The open incidents, each with its page on githubstatus.com (null: none known).
  incidents?: {
    name: string;
    status: string;
    impact: string | null;
    startedAt: number | null;
    url: string | null;
  }[];
}

// GET api/mcp/clients: `resource`, the URL clients connect to (the public URL's /mcp, which
// may not be the page's own origin), and the clients.
export interface McpClients {
  resource: string;
  clients: McpClient[];
}

// An MCP client signed in as the user, for Settings › MCP clients: GET api/mcp/clients (edge's
// own, edge/oauth.mjs clients()), the newest first. `id`: its sign-in's, what Revoke posts
// (api/mcp/clients/<id>/revoke); `client`: its registration's; `name`: its own claim;
// `created`, `used`: ms, `used` null until its token was first used.
export interface McpClient {
  id: string;
  name: string;
  client: string;
  redirect: string;
  scopes: string[];
  created: number;
  used: number | null;
}

// GET api/machines (listener/http.mjs): the user's own machines (listener/machines.mjs), by
// name. `online`: its last heartbeat under 90 s old; `seenAt`, `createdAt`: ms; `repos`:
// "owner/name" or "owner/*", those it takes; `version`: its driver's, if it said.
export interface Machines {
  machines: Machine[];
}

export interface Machine {
  id: string;
  name: string;
  labels: string[];
  capacity: number;
  repos: string[];
  version: string | null;
  createdAt: number;
  seenAt: number;
  online: boolean;
}

// GET api/health (listener/health.mjs): each service's GET /health, as the orchestrator probed
// it (at most every 10 s, whoever asks), and the orchestrator itself; a service without a URL is
// left out. `up`: answered, started 5 minutes ago or more; `starting`: answered, started less
// than 5 minutes ago (a restart, an update); `down`: no answer, `reason` says why in a word
// ("timeout", "refused", "HTTP 503"). Times in ms, by the orchestrator's clock; `startedAt` and
// `version` null when down, or from a service that doesn't say. `warnings`: what a service said
// of its setup at start (its blobs taking Redis's memory, lib/blobs.mjs), when it said any; the
// orchestrator's own, its runs whose end waits for the store (listener/restart.mjs endWait()).
export type ServiceName =
  "edge" | "orchestrator" | "runner" | "broker" | "github" | "models" | "policy" | "proxy";

export type ServiceState = "up" | "starting" | "down";

export interface ServiceHealth {
  name: ServiceName;
  state: ServiceState;
  startedAt: number | null;
  version: string | null;
  checkedAt: number;
  reason?: string;
  warnings?: string[];
}

export interface Health {
  checkedAt: number;
  services: ServiceHealth[];
}

// GET /api/run-data (listener/http.mjs, listener/run-data.mjs). Runs started in [from, to),
// current recorded PR outcomes; linked issue and PR runs count as one work item.
export type RunDimension = "repo" | "agent" | "model" | "effort" | "user";
export type TokenPart = "input" | "output" | "cacheRead" | "cacheWrite";
export interface RunMetrics {
  runs: number;
  issues: number;
  needsInput: number;
  tokens: number;
  usageRuns: number;
  // Issues with at least one run with token data: tokens per issue is over these.
  usageIssues: number;
  // The tokens by part, each over the runs (and issues) that report it; uncached: input,
  // output and cache writes, over the runs that report input and output.
  parts: Record<TokenPart | "uncached", { tokens: number; runs: number; issues: number }>;
  fixes: number;
  ciFixes: number;
  findings: number;
  reviewedPulls: number;
  pullRequests: number;
  merged: number;
  unchanged: number;
  changed: number;
  unknownMerge: number;
  mergedAfterFixes: number;
  closed: number;
}
export interface RunData {
  options: Record<RunDimension, string[]>;
  total: RunMetrics;
  groups: (RunMetrics & { dimensions: Record<RunDimension, string> })[];
  steps: (RunMetrics & { step: string })[];
}
