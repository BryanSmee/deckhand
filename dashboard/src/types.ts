// The contract with the listener: what GET api/state returns (listener/http.mjs state(),
// listener/board.mjs), what api/runs/<id>/stream sends (runlog.mjs format()), and the
// repositories' api/repos (listener/repos.mjs).

export type TaskState =
  | "building-image"
  | "working"
  | "stopping"
  | "queued"
  | "waiting"
  | "brainstorm"
  | "idle-brainstorm"
  | "needs-input"
  | "done"
  | "error"
  | "interrupted";

export type RunStatus = "running" | "ok" | "needs-input" | "error" | "interrupted";

export type Kind = "issue" | "pr" | "discussion" | "brainstorm" | "idea" | "bug";

export interface Run {
  id: string;
  key: string;
  kind: Kind | null;
  title: string | null;
  repo: string | null;
  replyTo: number | null;
  // start, continue, restore or wrap-up
  mode: string | null;
  // work, brainstorm, idea, bug, discussion or one of the repo's own modes
  taskMode: string | null;
  // Why the listener started it itself ("conflict": a pull request to rebase); null for comments.
  reason?: string | null;
  model?: string | null;
  effort?: string | null;
  phase?: string | null;
  startedAt: number;
  finishedAt: number | null;
  status: RunStatus;
  // The first line of its reply.
  summary?: string | null;
  // How many comments reached it while it ran.
  delivered?: number;
}

// draft, ready for review, merged, or closed without merging.
export type PrState = "draft" | "ready" | "merged" | "closed";

// A task's pull request (listener/pulls.mjs): the one that closes its issue, or itself.
export interface PullRequest {
  number: number;
  url: string;
  state: PrState;
  // When a webhook said it turned ready for review; null when looked up, or never ready.
  readyAt: number | null;
}

export interface Task {
  key: string;
  repo: string;
  project: string;
  number: number | null;
  title: string | null;
  kind: Kind | null;
  mode: string | null;
  replyTo: number | null;
  state: TaskState;
  since: number;
  // A brainstorm's: when it goes idle, or went.
  deadline?: number;
  // The issues or pull requests its next run waits for ("/after #77", listener/waits.mjs).
  waitingFor?: number[];
  // Its issue or pull request closed: as completed (merged), not planned (closed without
  // merging), or null while open or not known yet (listener/titles.mjs).
  closed: Closed;
  pr: PullRequest | null;
  runs: Run[]; // newest first
}

export type Closed = "completed" | "not_planned" | null;

// An arrow of the graph: `to` waits for `from` ("/after", listener/waits.mjs).
export interface Edge {
  from: string;
  to: string;
  kind: "after";
}

// An issue a task waits for that isn't on the board.
export interface Blocker {
  key: string;
  repo: string;
  number: number;
  title: string | null;
  closed: Closed;
}

// A preview hook waiting or running (listener/previews.mjs status()).
export interface Preview {
  // Its container's name.
  name: string;
  repo: string;
  // pull_request or workflow_run, and the payload's action.
  event: string;
  action: string | null;
  state: "waiting" | "running";
  since: number;
}

export interface State {
  user: string;
  tasks: Task[];
  edges: Edge[];
  blockers: Blocker[];
  states: TaskState[];
  running: number;
  queued: number;
  maxParallel: number;
  previews?: Preview[];
  // GITHUB_URL, without a trailing slash: where links go.
  githubUrl: string;
  // The server's clock: run times are compared with it.
  now: number;
}

export type Entry =
  | { kind: "text"; text: string }
  | { kind: "meta"; text: string }
  | { kind: "raw"; text: string }
  | { kind: "tool"; name: string; text: string }
  | { kind: "output"; text: string; error: boolean }
  | { kind: "result"; status: "ok" | "needs-input" | "error"; text: string; minutes: number };

// configured: its default branch has .deckhand.yaml; invalid: it has, but no run starts (the
// file has errors, or asks for what the operator's grants refuse); onboarding: its onboarding
// issue is open; unknown: GitHub didn't say.
export type RepoStatus = "configured" | "invalid" | "onboarding" | "not-onboarded" | "unknown";

export interface Repo {
  repo: string;
  url: string;
  private: boolean;
  // false: its issues are disabled, so it can't be onboarded.
  issues: boolean;
  status: RepoStatus;
  issue: { number: number; url: string } | null;
  // When its config was last read from GitHub; null when it couldn't be.
  readAt: number | null;
}

// GET api/repos, and POST api/repos/refresh (429 when refreshed a moment ago).
export interface Repos {
  repos: Repo[];
  // When the installations' repositories were last listed.
  listedAt: number;
}

// POST api/repos/<owner>/<repo>/onboard
export interface Onboarded {
  repo?: Repo;
  opened?: boolean;
  error?: string;
}

// Where a value comes from: the repo's .deckhand.yaml, the operator (environment, grants
// file), or the repo's, refused (a refused host or mount stops every run).
export type Source = "repo" | "operator" | "refused";

// One setting a run reads (listener/repo-view.mjs settingRows()); `key` is its YAML key.
// Refused: it needs a grant the operator doesn't give (dockerfile, preview).
export interface SettingRow {
  key: string;
  value: string;
  source: Source;
  note: string | null;
}

export interface HostRow {
  host: string;
  source: Source;
  note: string | null;
}

// A mount the repo asks for, at `path` in the sandbox.
export interface MountRow {
  path: string;
  source: Exclude<Source, "operator">;
  readOnly: boolean;
  note: string | null;
}

// The repo's entry of the operator's grants file: its own (entry is the repo), "*"'s, or none.
export interface Grant {
  entry: string | null;
  allowRepoHosts: boolean;
  allowPreview: boolean;
  allowDockerfile: boolean;
  allowBranchDockerImages: boolean;
  hosts: string[];
  mounts: { root: string; readOnly: boolean }[];
  limits: { cpus: string; memory: string; pids: number };
}

// GET api/repos/<owner>/<repo>/config, read from GitHub at each request, and POST
// api/repos/<owner>/<repo>/refresh (the same; 429 when refreshed a moment ago).
export interface RepoConfig {
  repo: Repo;
  base: string;
  // null: no .deckhand.yaml on its default branch, the operator's defaults apply.
  file: { text: string; sha: string; url: string } | null;
  errors: string[];
  warnings: string[];
  grantsError: string | null;
  effective: {
    settings: SettingRow[];
    hosts: HostRow[];
    mounts: MountRow[];
    grant: Grant | null;
  };
  readAt: number;
}
