// The contract with the listener: what GET api/state returns (listener/http.mjs state(),
// listener/board.mjs), what api/runs/<id>/stream sends (runlog.mjs format()), and the
// repositories' api/repos (listener/repos.mjs) and the graph's work area and answers
// (listener/work.mjs, answers.mjs).

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
  | "interrupted"
  | "cancelled";

export type RunStatus = "running" | "ok" | "needs-input" | "error" | "interrupted" | "cancelled";

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
  // What ran it (listener/agents/): "claude", also for runs from before agents had names.
  agent?: string;
  // Where its agent's API calls went (listener/agents/), and why when a fallback picked it:
  // the entry that failed (`from`, "claude@anthropic"), and how ("overloaded (529)").
  provider?: string | null;
  fallback?: { from: string; reason: string; tried?: string[]; sticky?: boolean } | null;
  // Chosen with `/agent` (`sticky`: by a previous run's): such a run doesn't fall back.
  picked?: { sticky?: boolean } | null;
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
  // Its last run failed or was lost, and may run again from its page (listener/board.mjs).
  rerunnable: boolean;
  runs: Run[]; // newest first
  // What a task waiting for input asks (listener/questions.mjs, board.mjs).
  questions?: Questions;
  // With its questions: false when its repo's `wait_for_answers` is off, and Start and Queue
  // go ahead without them (listener/work.mjs act()).
  waitForAnswers?: boolean;
}

// An option of a question; one at most is `recommended` (the agent's pick). One option per
// question, plus a free-text answer.
export interface QuestionOption {
  label: string;
  recommended: boolean;
}

// No options: a free-text question.
export interface Question {
  title: string | null;
  // The question, then its explanation lines.
  text: string;
  options: QuestionOption[];
}

// From the reply of its last run (`runId`) when it stopped to ask, else from its issue's
// "Open questions" section. `items`: null when they aren't in the format (prompts/sandbox.md),
// so only `raw`, the markdown, can be shown.
export interface Questions {
  source: "issue" | "run";
  runId?: string;
  items: Question[] | null;
  raw: string;
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
  // Each repo's inbox issues and discussions category, for the repos whose config the
  // listener has read: the Feedback form offers those it has (listener/work.mjs
  // sendToInbox(), listener/discussions.mjs).
  inboxes?: Record<string, Inboxes>;
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
// folder), or the repo's, refused (a refused host or mount stops every run), or unknown (it
// needs a grant, and the operator's grants have errors: not judged until they're fixed).
export type Source = "repo" | "operator" | "refused" | "unknown";

// One setting a run reads (listener/repo-view.mjs settingRows()); `key` is its YAML key.
// Refused: it needs a grant the operator doesn't give (dockerfile, preview, docker).
export interface SettingRow {
  key: string;
  value: string;
  source: Source;
  note: string | null;
}

export interface HostRow {
  host: string;
  // Only the operator's grants folder lists hosts.
  source: "operator";
  // Where it comes from: "always", or its grants file ("grants/default.yaml").
  note: string | null;
}

// A mount the repo asks for, at `path` in the sandbox.
export interface MountRow {
  path: string;
  source: Exclude<Source, "operator">;
  readOnly: boolean;
  note: string | null;
}

// What the operator grants the repo, and the files of its grants folder it comes from
// (default.yaml, <owner>/<repo>.yaml); none: nothing beyond what every repository gets.
export interface Grant {
  files: string[];
  allowPreview: boolean;
  allowDockerfile: boolean;
  allowBranchDockerImages: boolean;
  allowDocker: boolean;
  hosts: string[];
  // Those whose plain HTTP answers the egress proxy keeps in its cache.
  cachedHosts: string[];
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
  // The operator's grants have errors: no run starts here (or anywhere, everyRepo). `file`:
  // the one to fix in the grants folder, when there is one.
  grantsError: { file: string | null; message: string; everyRepo: boolean } | null;
  effective: {
    settings: SettingRow[];
    hosts: HostRow[];
    mounts: MountRow[];
    grant: Grant | null;
  };
  readAt: number;
}

// An open issue with no task yet, which the graph's work area can start or queue.
export interface BacklogIssue {
  number: number;
  title: string | null;
  url: string;
}

// GET api/repos/<owner>/<repo>/issues
export interface Backlog {
  issues: BacklogIssue[];
  // The modes an issue can start in (work, brainstorm, the repo's own); none when `errors`.
  modes: string[];
  // Its .deckhand.yaml has errors: nothing starts there.
  errors: boolean;
  readAt: number;
}

// POST api/repos/<owner>/<repo>/work: start an issue, queue it after another ("/after"),
// cancel its wait ("/after none"), or stop its brainstorm ("/stop": the wrap-up).
export type WorkAction =
  | { action: "start"; number: number; mode?: string }
  | { action: "queue"; number: number; after: number; mode?: string }
  | { action: "dequeue"; number: number }
  | { action: "stop"; number: number };
// The task page's Stop (not the graph's): its run stops, or what is queued is dropped. `pr`:
// a pull request's task.
export type CancelAction = { action: "cancel"; number: number; pr: boolean };

// POST api/repos/<owner>/<repo>/answer: one answer per parsed question (the options ticked, by
// index, and a note), or one text for questions not in the format. `pr`: a pull request's task.
// `then`: what the graph's drag that opened the form does once they are in (an issue's start
// or queue): every question needs an answer then.
export type Answers = { number: number; pr?: boolean; then?: AnswersThen } & (
  { answers: { options: number[]; text: string }[] } | { text: string }
);

export type AnswersThen =
  { action: "start"; mode?: string } | { action: "queue"; after: number; mode?: string };

export interface WorkResult {
  message?: string;
  error?: string;
}

// A repo's inbox issues and discussions category (.deckhand.yaml's `inbox`, the category's
// name as compared: lowercase): null when it has none of that kind.
export interface Inboxes {
  ideas: number | null;
  bugs: number | null;
  discussions: string | null;
}

// POST api/repos/<owner>/<repo>/inbox: an idea or a bug report for the repo's inbox.
export interface InboxEntry {
  kind: "idea" | "bug";
  text: string;
}

// What it answers: the App's comment on the inbox issue, and the task its run is on.
export interface InboxResult extends WorkResult {
  url?: string;
  task?: string;
}

// POST api/repos/<owner>/<repo>/discussions: a discussion in the repo's discussions category.
export interface DiscussionStart {
  title: string;
  body: string;
}

// What it answers: the discussion on GitHub, and its task.
export interface DiscussionResult extends WorkResult {
  url?: string;
  number?: number;
  task?: string;
}

// POST api/repos/<owner>/<repo>/discussions/<n>/comments: `replyTo`, a comment's node id, for
// its thread; without it, a new comment.
export interface DiscussionComment {
  text: string;
  replyTo?: string;
}

// A post of a discussion (listener/discussions.mjs postOf()): the App's are Deckhand's answers
// (`deckhand`), or a dashboard user's, shown as theirs. `author`: null for a deleted account.
export interface Post {
  id: string;
  url: string | null;
  author: string | null;
  deckhand: boolean;
  at: string | null;
  body: string;
}

export interface ThreadComment extends Post {
  replies: Post[];
  // Older replies, on GitHub only.
  more: number;
}

// GET api/repos/<owner>/<repo>/discussions/<n>: the opening post and the latest comments.
export interface Thread {
  number: number;
  title: string | null;
  url: string | null;
  post: Post;
  comments: ThreadComment[];
  // Older comments, on GitHub only.
  more: number;
  readAt: number;
}

// A run's outcome, as an analysis picks them (listener/analysis.mjs OUTCOMES).
export type Outcome = "ok" | "error" | "needs-input" | "interrupted" | "cancelled";

// POST api/repos/<owner>/<repo>/analyze, and the preview's query (GET, the same path): the
// `count` newest finished runs of these kinds (`taskMode`) and outcomes.
export interface AnalysisSelection {
  count: number;
  kinds: string[];
  outcomes: Outcome[];
}

// GET api/repos/<owner>/<repo>/analyze: what the selection would read. `runs`: the ids that
// match, newest first; `included` of them fit in the digest, `left` don't; `tokens`: about
// what the digest costs to read; `kinds`: those of the repo's finished runs; `max`: the
// largest `count`.
export interface AnalysisPreview extends WorkResult {
  runs?: string[];
  included?: number;
  left?: number;
  bytes?: number;
  tokens?: number;
  kinds?: string[];
  max?: number;
}

// What the POST answers: the analysis's issue and its task.
export interface AnalysisResult extends WorkResult {
  url?: string;
  number?: number;
  task?: string;
}
