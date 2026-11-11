import type { Access } from "./access";
import type { LaneLabel, ServerInfo, SyncResult } from "./server";
import type { Inboxes } from "./work";

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

// A conversation on its issue: a brainstorm, or a grooming of the backlog (#585).
export type Kind = "issue" | "pr" | "discussion" | Talk | "idea" | "bug" | "research";
type Talk = "brainstorm" | "grooming";

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
  // work, brainstorm, grooming, idea, bug, discussion or one of the repo's own modes
  taskMode: string | null;
  // What its start decided it gets (pull, push, internet…); null before, or before capabilities.
  capabilities?: string[] | null;
  // Why the listener started it itself ("conflict": a pull request to rebase, "review": one
  // that turned ready, "review-fix": one whose review requested changes, "ci-fix": one whose CI
  // failed before its review); null for comments.
  reason?: string | null;
  // A review fix run's round, of how many the repo's `review.fix` allows (a CI fix run's, of
  // `review.ci_fix`); null otherwise.
  round?: number | null;
  rounds?: number | null;
  // Started by the listener from the issue's auto-pickup label; absent otherwise.
  autoPickup?: boolean;
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
  // The name of the user's machine an external run ran on (listener/runs.mjs startExternal(),
  // #597); absent for a sandbox's. Sent, not shown: the task's machine is.
  machine?: string | null;
  // How an external run's agent ran, as its machine reported it at its claim (listener/mcp.mjs
  // setupOf(), #599): never checked by Deckhand. Absent for a sandbox's.
  setup?: RunSetup | null;
  phase?: string | null;
  startedAt: number;
  finishedAt: number | null;
  status: RunStatus;
  // The first line of its reply.
  summary?: string | null;
  // How many comments reached it while it ran. Sent, not shown.
  delivered?: number;
  // The branch of its last push GitHub took, and when (the github service's git gateway); null
  // when it hasn't pushed, absent for runs from before they were recorded.
  branch?: string | null;
  lastPushAt?: number | null;
  lastPushHead?: string | null;
  // Last triggering author; null for automatic runs, absent in older history.
  user?: string | null;
  // Tokens the run used (listener/run-data.mjs recordUsage()); a Codex run's also has its
  // thread, the thread's running total and the total it resumed from.
  usage?: { tokens?: number; thread?: string; total?: number; base?: number };
  // How its sandbox exited, once the runner said (listener/run-events.mjs). Sent, not shown.
  exitCode?: number | null;
}

// What a machine reports of how its agent runs (Run.setup): each null when it didn't say.
export interface RunSetup {
  // The agent's version (Claude Code's).
  version: string | null;
  // Whether the agent's own sandbox is on.
  sandbox: boolean | null;
  // Its permission mode (acceptEdits, dontAsk…).
  permissionMode: string | null;
  // Whether it runs with the driver's suggested settings, or its owner's own alone.
  suggested: boolean | null;
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
  // The login whose machine pushed its branch, the App opening it from there
  // (listener/machine-pulls.mjs, #598); absent for a sandbox run's or a person's.
  external?: string;
  // Its size and commit count, as GitHub last sent them with it; absent until it did (a
  // pull request found in a listing).
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  commits?: number;
  // Its head commit, and what CI says of it (listener/ci.mjs ciSummary()): its GitHub Actions
  // runs, other Apps' check runs and commit statuses, failed ones first. Reset to `none` by a
  // push; the last one known stays once it is merged or closed. Absent until read. `head` is
  // also compared with the last review's (ReviewRound.head) for a commit pushed after it
  // (reviewOutdated()).
  head?: string;
  ci?: Ci;
  // Its head conflicts with its base, as GitHub last computed it (listener/pulls.mjs): absent
  // while unknown (webhooks often send `mergeable: null`) or since a push, counted as no
  // conflict (cleanReady()).
  conflict?: boolean;
  // When GitHub last changed it, as the delivery that recorded it said. Sent, not shown.
  updatedAt?: number;
  // Its last CI read failed (a 5xx, a rate limit): `ci` may be out of date until the next one
  // (listener/pulls.mjs ciStale()). Sent, not shown.
  ciFailed?: boolean;
}

// failed when a run failed, else running while one hasn't finished, else passed; none without any.
export type CiState = "running" | "failed" | "passed" | "none";

export interface Ci {
  sha: string;
  state: CiState;
  runs: CiRun[];
}

// An Actions run (its workflow's name), a check run, or a commit status (its context).
export interface CiRun {
  name: string;
  state: Exclude<CiState, "none">;
  url: string | null;
}

// What a repo's policies (Rego `allow_*` and `deny_*` rules, listener/policies.mjs) decided
// about a task's pull request: its review, fix run or auto-merge (listener/reviews.mjs), or the
// reviewers requested on it (listener/reviewers.mjs); or a run a person asked for that they
// refused (listener/run-policy.mjs: only refusals are kept). `messages`: the reasons, capped and
// redacted (a deny rule's, or which layer no allow rule matched); a failure is one
// "policy error: …". `rule`: its deny rule's name, as before allow rules.
export interface PolicyDecision {
  decision: "run" | "merge" | "review" | "fix" | "link_branch" | "request_review";
  rule: string;
  denied: boolean;
  messages: string[];
  // What each layer said; absent on decisions kept before allow rules (issue #494).
  layers?: PolicyLayer[];
  // The pull request it was about; the issue, for a linked branch (listener/linked-branch.mjs);
  // the issue, pull request or discussion the comment was on, for a run.
  pr: number;
  at: number;
  // The built-in gates checked before the policies, in order ("Checks green"…); absent on
  // decisions kept before they were (listener/decisions.mjs).
  gates?: PolicyGate[];
  // The input the rules saw, redacted (docs/repo-config/policy-inputs.md#the-merge-input): only on the
  // task's newest 3 decisions. Null when it was too big even cut.
  input?: Record<string, unknown> | null;
  // The input was cut to fit: its changed files first, then the review's findings, the checks.
  truncated?: boolean;
}

export interface PolicyGate {
  name: string;
  passed: boolean;
}

// One layer's say on a decision (listener/policies.mjs evaluated()): the operator's (Deckhand's
// defaults and the grants folder's policies) or the repo's (.deckhand/policy/), each evaluated
// apart. `allow`: whether its `allow_<decision>` matched; null when it isn't asked (the repo's,
// on a decision about a built-in mode's run). `denies`: its `deny_<decision>` messages.
// `allowFiles`, `denyFiles`: its files that define each rule, which decided. `error`: why it
// couldn't be evaluated ("policy error: …"), then nothing else counts.
export interface PolicyLayer {
  layer: "operator" | "repo";
  allow: boolean | null;
  denies: string[];
  allowFiles: string[];
  denyFiles: string[];
  error: string | null;
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

// A machine task's route (listener/claims.mjs view()).
export interface TaskMachine {
  // Whose machines take it: who added its label, or commented `/machine`.
  owner: string;
  // The machine's name or label asked for, as written.
  want: string;
  via: "comment" | "label";
  // The machine that holds it, or that it sticks to (it ran it); null while any that fits may.
  machine: string | null;
  // Whether a machine holds it now.
  claimed: boolean;
  // Whether one of the owner's machines that fits is online.
  available: boolean;
}

// A comment held on a machine task for its owner.
export interface HeldComment {
  author: string | null;
  at: number | null;
  // Its start, 500 characters at most.
  text: string;
  url: string | null;
}

// A machine run's agent's tool call, waiting for the run's owner (listener/requests.mjs
// toolRequests(), #600).
export interface ToolRequest {
  id: string;
  // The tool, as the agent names it.
  tool: string;
  // Its input, one line, redacted, 200 characters at most: shown as text.
  input: string;
  // The machine it runs on, and its owner, who alone answers.
  machine: string;
  owner: string;
  state: "pending" | "granted" | "denied" | "refused";
  message: string | null;
  at: number;
  // Past it, no answer denies it.
  expiresAt: number;
}
export type ToolAnswer = "once" | "run" | "deny";

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
  // (listener/tasks.mjs queueOrder(), order.mjs). `startsFirst`: a brainstorm or another mode
  // apart from work (listener/modes.mjs `volumes`), which goes before any work run whatever the
  // order, and doesn't move.
  position?: number;
  startsFirst?: boolean;
  // Queued: it can wait for another issue instead (Queue after…), its queued comments having
  // one that starts a run, not only replies to its last run (listener/runs.mjs queuedTask()).
  canWait?: boolean;
  // Picked by the listener from its auto-pickup label (listener/auto-pickup.mjs): queued so, or
  // its last run was.
  autoPickup?: boolean;
  // Routed to its owner's machines (a `runs-on:<label>` label, a `/machine` comment:
  // listener/claims.mjs): waiting for one, or claimed by one.
  machine?: TaskMachine;
  // Other people's comments on it, held until its machine's owner delivers or drops them.
  held?: HeldComment[];
  // Its machine run's tool calls waiting for its owner's answer.
  permissions?: ToolRequest[];
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
  // Its pull request's review-and-fix loop (listener/review-loop.mjs reviewLoop()), or its
  // maintainers' reviews alone (`manual`); absent when Deckhand never reviewed it.
  review?: ReviewLoop;
}

// Where a pull request's review-and-fix loop is: a review or fix run of it queued or running,
// the auto-merge waiting for checks, the review waiting for CI (ci) or a CI fix run queued or
// running (ci-fix), a conflict run queued or running, whose end reviews the rebased head
// (rebasing), or how it ended (ci-failed: CI failed and no review ran, its CI fix run
// refused, failed or pushing nothing) (clean; rounds-out: the review after the
// last fix run still blocks; fixed: by design nothing reviewed its one fix run, `review.fix:
// true` without `merge`; stopped: it blocks, and no fix run follows).
export type LoopState =
  | "reviewing"
  | "fixing"
  | "checks"
  | "ci"
  | "ci-fix"
  | "rebasing"
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
  // The CI fix runs started so far, of `ciRounds` (`review.ci_fix` when the last one started; 0
  // before any). Absent from listeners before #899.
  ciFixes?: number;
  ciRounds?: number;
  // Each review, oldest first.
  history: ReviewRound[];
  // No loop ran: only maintainers' reviews (`/mode review`, the task page's Review), shown as
  // "Reviews".
  manual?: boolean;
}

export interface ReviewRound {
  // The fix runs before it: 0 for the first review.
  round: number;
  at: number;
  head: string | null;
  // Its must-fix findings by severity; `blocking`: how many of them are above the tolerance
  // (`review.max_allowed_severity`), plus its blocking comments.
  counts: Record<Severity, number>;
  blocking: number;
  // Its follow-ups (for other issues, never blocking) and comments (`blocking` or `notes`);
  // absent from rounds kept before the review's sections (#622).
  followUps?: number;
  comments?: { blocking: number; notes: number };
  // Posted as a plain comment, GitHub having refused the review, and that comment's id.
  comment?: boolean;
  commentId?: number;
  // A maintainer's review, not the loop's own.
  manual?: boolean;
}

export type Severity = "critical" | "high" | "medium" | "low";

// GET /api/review (listener/reviews.mjs findings()): the last review Deckhand posted on a pull
// request, read from GitHub when the task page's Review tab opens, never in api/state. Its text
// is a model's, which read untrusted diffs: shown as text, never as HTML or markdown.
export interface ReviewFindings {
  url: string | null;
  at: number | null;
  verdict: "approve" | "comment" | "request-changes";
  rating: number;
  // The commit it reviewed, and its round (ReviewRound.round) as recorded, null if none was.
  head: string | null;
  round: number | null;
  manual: boolean;
  // The repo's tree at `head` ("https://github.com/o/r/blob/<sha>"), for the items' places.
  blob: string | null;
  // The most severe finding that doesn't block (`review.max_allowed_severity`).
  allowed: Severity;
  // Must fix: `tolerated` when `allowed` lets it through.
  findings: (ReviewItem & { severity: Severity; tolerated: boolean })[];
  followUps: (ReviewItem & {
    title: string;
    // issue: filed (or found) as `issue`; failed: GitHub refused it; left: past the cap per
    // pull request; off: the repo's config files none (`review.follow_ups: false`); unread: that
    // config can't be read now; after-merge: not merged yet, or its filing is on its way;
    // not-filed: merged and nothing filed it (skipped, or stopped midway); unknown: filed before
    // the listener kept which issue each became.
    filing:
      "issue" | "failed" | "left" | "off" | "unread" | "after-merge" | "not-filed" | "unknown";
    issue?: { number: number; state: "open" | "closed" | null; url: string | null };
  })[];
  comments: (ReviewItem & { blocking: boolean })[];
  // The pull request merged: when, by whom (its login), and whether that was Deckhand.
  merged: { at: number; by: string | null; deckhand: boolean } | null;
}

export interface ReviewItem {
  path: string | null;
  line: number | null;
  text: string;
}

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

export interface RepoSlots {
  running: number;
  queued: number;
  max: number;
  own: boolean;
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
  // AUTO_PICKUP_SLOTS, within maxParallel, and how many auto-picked runs hold them now; absent
  // while it is off (or from a listener from before it). `taken`: how many slots the picks
  // hold, running or not (queued, asking, between two loop steps): the sweep picks no issue
  // for those; none from a listener from before it.
  autoPickup?: { slots: number; running: number; taken?: number };
  // Each repo the user sees with tasks (#639): its runs going and its tasks queued, against
  // `max`, its own max_parallel (`own`) or else maxParallel, which it shares with the others. A
  // listener from before it sends none.
  repoSlots?: Record<string, RepoSlots>;
  // Each repo's inbox issues and discussions category, for the repos whose config the
  // listener has read: New request offers those it has (listener/work.mjs
  // sendToInbox(), listener/discussions.mjs).
  inboxes?: Record<string, Inboxes>;
  // GITHUB_URL, without a trailing slash: where links go.
  githubUrl: string;
  server: ServerInfo;
  // The last catch-up with GitHub, null before the first one.
  lastSync: SyncResult | null;
  // How much of each plan the runs used (listener/models-service.mjs plans()): only when a
  // plan's credential is set, absent otherwise (and from a listener from before it).
  plans?: PlanUsage[];
  // What the signed-in user may do (listener/permissions.mjs dashboard(), #732): the controls
  // follow it (access.ts). Absent from a listener from before it: everything, as then.
  access?: Access;
  // The server's clock: run times are compared with it.
  now: number;
}

// A plan's limits as last read (models/usage.mjs): from its answers to the runs' calls, and its
// usage call while a dashboard is open. Numbers and times only.
export interface PlanUsage {
  plan: "claude" | "codex" | "antigravity" | string;
  label: string;
  // The main ones first ("5h", "7d"), then a model's (Claude's "7d_opus", the Antigravity
  // CLI's per model, with its `label`); none before the first reading.
  windows: PlanWindow[];
  updatedAt: number | null;
  // A 429 from the plan, until limitedUntil.
  limited: boolean;
  limitedUntil: number | null;
}

export interface PlanWindow {
  name: string;
  label?: string;
  // 0–1.
  used: number;
  resetsAt: number | null;
  // When this window was read.
  at: number | null;
}
