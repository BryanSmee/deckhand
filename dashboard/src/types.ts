// The contract with the listener: what GET api/state returns (listener/http.mjs state(),
// listener/board.mjs), what api/runs/<id>/stream sends (runlog.mjs format()), and the
// repositories' api/repos (listener/repos.mjs) and the graph's work area and answers
// (listener/work.mjs, answers.mjs).

export type TaskState =
  | "scheduled"
  | "building-image"
  | "working"
  | "stopping"
  | "queued"
  | "in-review"
  | "waiting"
  | "brainstorm"
  | "idle-brainstorm"
  | "needs-input"
  | "done"
  | "error"
  | "interrupted"
  | "cancelled";

export type RunStatus = "running" | "ok" | "needs-input" | "error" | "interrupted" | "cancelled";

export type Kind = "issue" | "pr" | "discussion" | "brainstorm" | "idea" | "bug" | "research";

export type Auth = "plan" | "key" | "gateway";

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
  // Why the listener started it itself ("conflict": a pull request to rebase, "review": one
  // that turned ready, "review-fix": one whose review requested changes, "ci-fix": one whose CI
  // failed before its review); null for comments.
  reason?: string | null;
  // A review fix run's round, of how many the repo's `review.fix` allows (a CI fix run's, of
  // `review.ci_fix`); null otherwise.
  round?: number | null;
  rounds?: number | null;
  // What ran it (listener/agents/): "claude", "codex" or "antigravity"; "claude" also for runs
  // from before agents had names.
  // Sent, not shown (nor are provider, credential, fallback, picked and phase: `auth` says
  // which credential).
  agent?: string;
  // Where its agent's API calls went (listener/agents/), on which of the provider's credentials
  // when its entry names one ("key" for claude@anthropic:key), and why when a fallback picked
  // it: the entry that failed (`from`, "claude@anthropic:plan"), how ("overloaded (529)"), and
  // until when later runs stay on it (`until`, ms: a plan's limit resets).
  provider?: string | null;
  credential?: string | null;
  // Which of the operator's Claude credentials it ran on, named or the default one
  // (listener/agents/select.mjs authOf()): the plan (CLAUDE_CODE_OAUTH_TOKEN), the API key
  // (ANTHROPIC_API_KEY, billed per token) or a gateway's token (ANTHROPIC_AUTH_TOKEN). null off
  // Anthropic and for runs from before it; shown by the model.
  auth?: Auth | null;
  fallback?: {
    from: string;
    reason: string;
    tried?: string[];
    sticky?: boolean;
    until?: number;
  } | null;
  // Chosen with `/agent` (`sticky`: by a previous run's): such a run doesn't fall back.
  picked?: { sticky?: boolean } | null;
  model?: string | null;
  effort?: string | null;
  // "fast" in Claude Code's fast mode, which costs more; "normal" or null otherwise.
  speed?: string | null;
  // Why it didn't get the speed or model asked for (the operator turned fast mode off…). Sent,
  // not shown: the reply says it.
  speedNote?: string | null;
  phase?: string | null;
  startedAt: number;
  finishedAt: number | null;
  status: RunStatus;
  // The first line of its reply.
  summary?: string | null;
  // How many comments reached it while it ran. Sent, not shown.
  delivered?: number;
  // The branch of its last push GitHub took, and when (listener/git-gateway.mjs); null when
  // it hasn't pushed, absent for runs from before they were recorded.
  branch?: string | null;
  lastPushAt?: number | null;
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
  // Merged by Deckhand itself, with no human review (`review.merge`, listener/reviews.mjs).
  autoMerged?: boolean;
  // Its size and commit count, as GitHub last sent them with it; absent until it did (a
  // pull request found in a listing).
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  commits?: number;
}

// What a repo's policies (Rego `deny_*` rules, listener/policies.mjs) decided about a task's
// pull request: its review, fix run or auto-merge (listener/reviews.mjs), or the reviewers
// requested on it (listener/reviewers.mjs). `messages`: the reasons, capped and redacted; a
// failure is one "policy error: …".
export interface PolicyDecision {
  decision: "merge" | "review" | "fix" | "link_branch" | "request_review";
  rule: string;
  denied: boolean;
  messages: string[];
  // The pull request it was about; the issue, for a linked branch (listener/linked-branch.mjs).
  pr: number;
  at: number;
  // The built-in gates checked before the policies, in order ("Checks green"…); absent on
  // decisions kept before they were (listener/decisions.mjs).
  gates?: PolicyGate[];
  // The input the rules saw, redacted (docs/repo-config.md#the-merge-input): only on the
  // task's newest 3 decisions. Null when it was too big even cut.
  input?: Record<string, unknown> | null;
  // The input was cut to fit: its changed files first, then the review's findings, the checks.
  truncated?: boolean;
}

export interface PolicyGate {
  name: string;
  passed: boolean;
}

// The task's last `/mode policy` dry run (listener/task-modes.mjs): never a decision.
export interface PolicyDryRun {
  dryRun: true;
  // Who commented `/mode policy`; null when not known.
  by: string | null;
  at: number;
  // How many messages its rules denied with.
  denials: number;
  // Its reply on the pull request; null when GitHub didn't say.
  url: string | null;
}

export interface Task {
  key: string;
  repo: string;
  // Sent, not shown.
  project: string;
  number: number | null;
  title: string | null;
  kind: Kind | null;
  mode: string | null;
  replyTo: number | null;
  state: TaskState;
  since: number;
  // When Deckhand last saw something happen to it: a run starting, ending or pushing, its pull
  // request turning ready, a policy decision, a wait, the needs-input label (listener/board.mjs).
  updatedAt: number;
  // A brainstorm's: when it goes idle, or went.
  deadline?: number;
  // The issues or pull requests its next run waits for ("/after #77", listener/waits.mjs).
  waitingFor?: number[];
  // Queued, waiting for a slot: its place in the run order across every repo, 1 next to start
  // (listener/tasks.mjs queueOrder(), order.mjs). `startsFirst`: a brainstorm or a light mode,
  // which goes before any work run whatever the order, and doesn't move.
  position?: number;
  startsFirst?: boolean;
  // Its issue or pull request closed: as completed (merged), not planned (closed without
  // merging), or null while open or not known yet (listener/titles.mjs).
  closed: Closed;
  pr: PullRequest | null;
  // Its pull request's last policy decisions, newest first (listener/decisions.mjs); absent
  // when no policy was ever asked.
  decisions?: PolicyDecision[];
  // Its last policy dry run; absent when none.
  dryRun?: PolicyDryRun;
  // Its last run failed or was lost, and may run again from its page (listener/board.mjs).
  rerunnable: boolean;
  // Someone dismissed its last run's failure: it no longer waits on you, until another run
  // (listener/dismissals.mjs, board.mjs).
  dismissed: { by: string; at: number } | null;
  runs: Run[]; // newest first
  // What a task waiting for input asks (listener/questions.mjs, board.mjs).
  questions?: Questions;
  // With its questions: false when its repo's `wait_for_answers` is off, and Start and Queue
  // go ahead without them (listener/work.mjs act()).
  waitForAnswers?: boolean;
  // Its pull request's automatic review-and-fix loop (listener/reviews.mjs reviewLoop());
  // absent when it had no automatic review.
  review?: ReviewLoop;
}

// Where a pull request's review-and-fix loop is: a review or fix run of it queued or running,
// the auto-merge waiting for checks, the review waiting for CI (ci) or a CI fix run queued or
// running (ci-fix), or how it ended (ci-failed: CI failed and no review ran, its CI fix run
// refused, failed or pushing nothing) (clean; rounds-out: the review after the
// last fix run still blocks; fixed: by design nothing reviewed its one fix run, `review.fix:
// true` without `merge`; stopped: it blocks, and no fix run follows).
export type LoopState =
  | "reviewing"
  | "fixing"
  | "checks"
  | "ci"
  | "ci-fix"
  | "ci-failed"
  | "clean"
  | "rounds-out"
  | "fixed"
  | "stopped";

export interface ReviewLoop {
  loop: LoopState;
  // The fix runs started so far, 0 for the first review; of `rounds` the repo's `review.fix`
  // allows (0 without it, or not known yet).
  round: number;
  rounds: number;
  // Each automatic review, oldest first.
  history: ReviewRound[];
}

export interface ReviewRound {
  // The fix runs before it: 0 for the first review.
  round: number;
  at: number;
  head: string | null;
  // Its findings by severity; `blocking`: how many are above the tolerance
  // (`review.max_allowed_severity`).
  counts: Record<Severity, number>;
  blocking: number;
  // Posted as a plain comment, GitHub having refused the review.
  comment?: boolean;
}

export type Severity = "critical" | "high" | "medium" | "low";

// An option of a question; one at most is `recommended` (the agent's pick). One option per
// question, plus a free-text answer. `checked`: its box is ticked where it was asked ("[x]"):
// in an issue, the maintainer's answer; in a run's reply, the agent's own (no answer). Absent
// from questions a listener kept before it said so.
export interface QuestionOption {
  label: string;
  recommended: boolean;
  checked?: boolean;
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

// A preview hook waiting or running (listener/previews.mjs status()). Sent, not shown: the
// top bar counts them.
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
  // SANDBOX_ENGINE: the container engine of runs granted allow_docker. "auto": Sysbox where
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

export interface State {
  user: string;
  tasks: Task[];
  edges: Edge[];
  blockers: Blocker[];
  // The names the board's lanes can have, by the key of an issue in them; a listener from
  // before them sends none.
  lanes?: Record<string, LaneLabel>;
  // Sent, not shown: the chips group the states themselves (format.ts CHIPS).
  states: TaskState[];
  running: number;
  queued: number;
  maxParallel: number;
  previews?: Preview[];
  // Each repo's inbox issues and discussions category, for the repos whose config the
  // listener has read: New request offers those it has (listener/work.mjs
  // sendToInbox(), listener/discussions.mjs).
  inboxes?: Record<string, Inboxes>;
  // GITHUB_URL, without a trailing slash: where links go.
  githubUrl: string;
  server: ServerInfo;
  // The last catch-up with GitHub, null before the first one.
  lastSync: SyncResult | null;
  // The server's clock: run times are compared with it.
  now: number;
}

// The parts of a run, each its own section of its log (listener/runlog.mjs PHASES). A phase
// may come back: setup after the image's build, work after a push. Logs from before phases
// have none: all of them is work.
export type Phase = "setup" | "image" | "work" | "push" | "wrap-up";

// How a step of an image's build is (`docker build --progress plain`): the latest `step`
// entry of a number says it.
export type StepStatus = "running" | "cached" | "done" | "error" | "cancelled";

// What the log stream sends, in order. Failures: an `output` with `error`, a `step` with
// status "error" (its `error` says why): logModel.ts counts them per section.
export type Entry =
  | { kind: "text"; text: string }
  | { kind: "meta"; text: string }
  // Setup output; with `step`, the output of that image build step, without BuildKit's prefix.
  | { kind: "raw"; text: string; step?: number }
  // `id`: what pairs a call with its outputs, when the agent gives one (a call with one has an
  // output to come); `done`: it came whole, with no output to wait for (Codex's edits);
  // `at`: when it came (ms, listener/runlog.mjs reader()). None in logs from before them.
  | { kind: "tool"; name: string; text: string; id?: string; done?: boolean; at?: number }
  | { kind: "output"; text: string; error: boolean; id?: string; at?: number }
  | { kind: "result"; status: "ok" | "needs-input" | "error"; text: string; minutes: number }
  // The entries after it, up to the next one, are this phase's; `at`: when it started (ms).
  | { kind: "phase"; phase: Phase; at: number }
  // An image build step as it starts, then as its status changes. `stage`: "build 5/9" in
  // "[build 5/9] RUN npm ci", "internal" for BuildKit's own steps, null for those it doesn't
  // name ("exporting to image"); `seconds` once done.
  | {
      kind: "step";
      step: number;
      stage: string | null;
      name: string;
      status: StepStatus;
      seconds: number | null;
      error: string | null;
      // When it started (ms), in logs since steps were timed.
      at?: number;
    };

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
  // When its config was last read from GitHub; null when it couldn't be. Sent, not shown: the
  // config panel says when it read its own.
  readAt: number | null;
  // Its `review.merge` merges Deckhand's pull requests with no human review: on in its config,
  // granted, and allowed for its visibility (listener/grants.mjs autoMergeProblems()).
  autoMerge: boolean;
  // Only with api/repos?backlog=1: a configured repo's open issues with no live task, as its
  // last backlog read had them (listener/work.mjs counts()), and when that read started; null
  // before its first read, or when the signed-in user isn't among its users. Absent on the
  // other rows. `more`: that read was one full page of 100 issues and pull requests, so there
  // may be more than `count` ("100+").
  backlog?: { count: number; more: boolean; readAt: number } | null;
}

// Where the App is managed on GitHub (repos.mjs appLinks()). installUrl: GitHub's page that
// installs it on an account, or configures an installation; settingsUrl: its permissions,
// events and webhook. missingEvents, missingPermissions: what its settings lack of what Deckhand
// asks for (listener/github-app.mjs APP_EVENTS, APP_PERMISSIONS: "actions: read"), as read at
// the listener's start and with each listing of the repositories. installations: each account it is installed on, with that
// installation's own page, where an owner accepts the App's new permissions, and those it has
// yet to accept (`missing`).
export interface AppLinks {
  name: string;
  installUrl: string;
  settingsUrl: string;
  missingEvents: string[];
  missingPermissions: string[];
  installations: { account: string | null; url: string; missing: string[] }[];
}

// GET api/repos, and POST api/repos/refresh (429 when refreshed a moment ago).
export interface Repos {
  repos: Repo[];
  // When the installations' repositories were last listed.
  listedAt: number;
  // Null before the App is set up (the dashboard isn't served then anyway).
  app: AppLinks | null;
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
// `line`: where .deckhand.yaml sets it (null: it doesn't).
export interface SettingRow {
  key: string;
  value: string;
  source: Source;
  note: string | null;
  line: number | null;
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
  line: number | null;
}

// What the operator grants the repo, and the files of its grants folder it comes from
// (default.yaml, <owner>/<repo>.yaml); none: nothing beyond what every repository gets.
export interface Grant {
  files: string[];
  allowPreview: boolean;
  allowDockerfile: boolean;
  allowBranchDockerImages: boolean;
  allowDocker: boolean;
  // `/mode research`: the open internet, without the repository's code or a token.
  allowResearch: boolean;
  // Pushes that change .github/workflows/ (the git gateway's token gets `workflows: write`).
  allowWorkflows: boolean;
  // `review.merge` may merge Deckhand's pull requests; "public": on a public repository too.
  allowAutoMerge: boolean | "public";
  // acknowledge_automerge_and_preview_is_highly_dangerous: auto-merge with a granted preview
  // hook, which runs the default branch as root on the host.
  acknowledgeAutoMergePreview: boolean;
  hosts: string[];
  // Those whose plain HTTP answers the egress proxy keeps in its cache.
  cachedHosts: string[];
  mounts: { root: string; readOnly: boolean }[];
  limits: { cpus: string; memory: string; pids: number };
}

// One of a .deckhand.yaml's errors or warnings (repo-config.mjs fileLines()): the key it is
// about ("modes.review.agent"), and the line of that key, or of the syntax error; null when
// the check doesn't know them. `fix`: how to fix an error (null for a warning).
export interface ConfigProblem {
  key: string | null;
  message: string;
  line: number | null;
  fix: string | null;
}

// GET api/repos/<owner>/<repo>/config, read from GitHub at each request, and POST
// api/repos/<owner>/<repo>/refresh (the same; 429 when refreshed a moment ago).
export interface RepoConfig {
  repo: Repo;
  base: string;
  // null: no .deckhand.yaml on its default branch, the operator's defaults apply.
  // `url`: the file on GitHub; `editUrl`: GitHub's editor for it.
  file: { text: string; sha: string; url: string; editUrl: string } | null;
  errors: ConfigProblem[];
  warnings: ConfigProblem[];
  // The operator's grants have errors: no run starts here (or anywhere, everyRepo). `file`:
  // the one to fix in the grants folder, when there is one.
  grantsError: { file: string | null; message: string; everyRepo: boolean } | null;
  effective: {
    settings: SettingRow[];
    hosts: HostRow[];
    mounts: MountRow[];
    grant: Grant | null;
  };
  // The policy files that apply, from the operator's grants folder and the repo's
  // .deckhand/policy/ on its default branch (listener/policies.mjs describe()).
  policies: Policies;
  readAt: number;
}

// A policy file: Deckhand's own defaults ("deckhand", in its image), the operator's, or the
// repo's, each layer over the one before. `replaces`: the source of the file of a layer below
// with its name, which it replaces (the nearest), null for none. That file is listed too, not
// `active`: no decision evaluates it. `rules`: the
// `deny_*` rules it defines. `url`: the repo's file on GitHub. `text`: its source, redacted, cut
// at 20 KB (`truncated`); sent by the config endpoint only, never in api/state.
export interface PolicyFile {
  name: string;
  source: "deckhand" | "operator" | "repo";
  replaces: "deckhand" | "operator" | null;
  active: boolean;
  rules: string[];
  url: string | null;
  text: string;
  truncated: boolean;
}

// An error of the config check: `file` and `row` where opa placed it (both null when it
// didn't: a timeout, a folder that can't be read). `text`: the whole error on one line.
export interface PolicyError {
  file: string | null;
  row: number | null;
  message: string;
  text: string;
}

// `errors`: the config check's (compile errors, a folder that can't be read): every decision a
// policy is asked for refuses until they are fixed. `warnings`: rules nobody evaluates.
export interface Policies {
  files: PolicyFile[];
  errors: PolicyError[];
  warnings: string[];
}

// An open issue with no task yet, which the graph's work area can start or queue.
export interface BacklogIssue {
  number: number;
  title: string | null;
  url: string;
  // How many of its sub-issues are open, when any are: dropped on the graph, it is laid out
  // with them ("plan").
  subIssues?: number;
}

// GET api/repos/<owner>/<repo>/issues
export interface Backlog {
  issues: BacklogIssue[];
  // The modes an issue can start in (work, brainstorm, the repo's own); none when `errors`.
  modes: string[];
  // Its .deckhand.yaml has errors: nothing starts there.
  errors: boolean;
  // Sent, not shown.
  readAt: number;
  // An old read: a new one is on its way at the listener, read again soon (api.ts).
  refreshing: boolean;
}

// POST api/repos/<owner>/<repo>/work: start an issue, queue it after another ("/after"), lay
// out a parent issue and its sub-issues from their "blocked by" links (after another, too),
// cancel its wait ("/after none"), or stop its brainstorm ("/stop": the wrap-up).
export type WorkAction =
  | { action: "start"; number: number; mode?: string }
  | { action: "queue"; number: number; after: number; mode?: string }
  | { action: "plan"; number: number; after?: number; mode?: string }
  | { action: "dequeue"; number: number }
  | { action: "stop"; number: number };
// A work area action sent and not confirmed yet (api.ts useWorkArea()): the graph shows what
// it will do at once.
export type Pending = WorkAction & { repo: string; title: string | null };
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
  | { action: "start"; mode?: string }
  | { action: "queue"; after: number; mode?: string }
  | { action: "plan"; after?: number; mode?: string };

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
  // Sent, not shown: the task's own title heads the page.
  title: string | null;
  url: string | null;
  post: Post;
  comments: ThreadComment[];
  // Older comments, on GitHub only.
  more: number;
  // Sent, not shown.
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
// largest `count`. `runs` and `bytes`: sent, not shown.
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
