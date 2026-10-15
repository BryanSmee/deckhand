// The contract with the listener: what GET api/state returns (listener/server.mjs state(),
// listener/board.mjs), what api/runs/<id>/stream sends (server.mjs format()), and the
// repositories' api/repos (listener/repos.mjs).

export type TaskState =
  | "building-image"
  | "working"
  | "stopping"
  | "queued"
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
  model?: string | null;
  effort?: string | null;
  phase?: string | null;
  startedAt: number;
  finishedAt: number | null;
  status: RunStatus;
  // The first line of its reply.
  summary?: string | null;
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
  pr: PullRequest | null;
  runs: Run[]; // newest first
}

export interface Preview {
  name: string;
}

export interface State {
  user: string;
  tasks: Task[];
  states: TaskState[];
  running: number;
  queued: number;
  maxParallel: number;
  previews?: Preview[];
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

// configured: its default branch has .deckhand.yaml; onboarding: its onboarding issue is open;
// unknown: GitHub didn't say.
export type RepoStatus = "configured" | "onboarding" | "not-onboarded" | "unknown";

export interface Repo {
  repo: string;
  url: string;
  private: boolean;
  // false: its issues are disabled, so it can't be onboarded.
  issues: boolean;
  status: RepoStatus;
  issue: { number: number; url: string } | null;
}

// GET api/repos
export interface Repos {
  repos: Repo[];
}

// POST api/repos/<owner>/<repo>/onboard
export interface Onboarded {
  repo?: Repo;
  opened?: boolean;
  error?: string;
}
