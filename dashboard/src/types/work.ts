// An open issue with no task yet, which the graph's work area can start or queue.
export interface BacklogIssue {
  number: number;
  title: string | null;
  url: string;
  // Its labels, as GitHub lists them (`color`: hex, no "#"; null when GitHub doesn't say);
  // none from a listener older than them.
  labels?: BacklogLabel[];
  // How many of its sub-issues are open, when any are: dropped on the graph, it is laid out
  // with them ("plan").
  subIssues?: number;
  // Its parent's number, when it is a sub-issue of another listed issue: the Backlog can
  // hide it, its parent laying it out.
  parent?: number;
  // Its milestone, when it has one: the Backlog's sections ("Group by milestone").
  milestone?: BacklogMilestone;
}

// `dueOn`: its due date in epoch ms, null without one.
export interface BacklogMilestone {
  number: number;
  title: string;
  dueOn: number | null;
}

export interface BacklogLabel {
  name: string;
  color: string | null;
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
// cancel its wait ("/after none"), stop its brainstorm ("/stop": the wrap-up), or take a
// queued issue out of the queue, back to the backlog ("/cancel"). A queued issue queued after
// another leaves the queue and waits for it instead.
export type WorkAction =
  | { action: "start"; number: number; mode?: string }
  | { action: "queue"; number: number; after: number; mode?: string }
  | { action: "plan"; number: number; after?: number; mode?: string }
  | { action: "dequeue"; number: number }
  | { action: "stop"; number: number }
  | { action: "cancel"; number: number };
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
