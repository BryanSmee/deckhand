// The graph's work area (the dashboard's Graph page): a repo's backlog, its open issues with
// nothing live (board.mjs isLive()), and what dragging one does: start it, queue it after
// another issue ("/after #n"), move its wait or cancel it, or stop its brainstorm ("/stop"),
// and the task page's Stop ("/cancel").
// Each action is what a comment would do, checked as a comment that waited is (tasks.mjs
// resume()), and written on the issue as the App's comment: bot comments never reach admit(),
// so the listener queues or holds the work itself.
//
//   GET  /api/repos/<owner>/<repo>/issues the backlog and the repo's modes: the last read at
//                                         once, read again in the background after
//                                         ISSUES_MS, at an `issues` delivery or when a
//                                         task ends (`refreshing` while it is going)
//   POST /api/repos/<owner>/<repo>/work   { action: "start", number, mode? }
//                                         { action: "queue", number, after, mode? }: a task
//                                         waiting for a slot too, which then waits instead
//                                         { action: "plan", number, after?, mode? }: a parent
//                                         issue and its sub-issues, laid out from their
//                                         "blocked by" links (plans.mjs)
//                                         { action: "dequeue", number }
//                                         { action: "stop", number }: a brainstorm's wrap-up
//                                         { action: "cancel", number, pr? }: stops the run
//                                         (runs.mjs cancel()), or drops the queued comments
//   POST /api/repos/<owner>/<repo>/answer { number, pr?, answers: [{ options: [i], text }] }
//                                         { number, pr?, text }
//                                         answers to a task's open questions (answers.mjs);
//                                         with `then: { action, after?, mode? }`, all of
//                                         them, and the issue starts or queues with them
//   POST /api/repos/<owner>/<repo>/rerun  { runId }
//                                         the task's last run, failed, interrupted or
//                                         cancelled, again:
//                                         its mode and comments (board.mjs rerunnable())
//   POST /api/repos/<owner>/<repo>/review { number, action: "review" | "fix" }
//                                         the task page's buttons once a pull request's
//                                         review-and-fix loop is over (reviews.mjs): "review", a
//                                         review of its head now, as `/mode review` would
//                                         (no loop round, nothing tolerated); "fix", one fix
//                                         run more on the App's latest review's findings,
//                                         with `review.fix` only (reviews' startFix())
//   POST /api/repos/<owner>/<repo>/dismiss { runId, undo? }
//                                         the task's last run, failed, interrupted or
//                                         cancelled, stops asking for attention until
//                                         another run (dismissals.mjs); `undo`: it asks again
//   POST /api/repos/<owner>/<repo>/inbox  { kind: "idea" | "bug", text }
//                                         an entry for the repo's inbox: the App's comment on
//                                         its inbox issue, and the run a comment there starts
//   POST /api/repos/<owner>/<repo>/lane   { keys: ["owner/repo#12", …], name }
//                                         names the lane of these issues (lanes.mjs), "" takes
//                                         its name off
//   POST /api/repos/<owner>/<repo>/order  { key, before?: key, after?: key, first?: true }
//                                         moves a queued task in the run order (order.mjs):
//                                         right before or after another of the repo's,
//                                         first, or last (none of them)
//   GET  /api/repos/<owner>/<repo>/analyze?count=&kinds=a,b&outcomes=c,d
//                                         what an analysis of these runs would read: how many
//                                         match, the digest's size and tokens, the kinds there
//   POST /api/repos/<owner>/<repo>/analyze { count, kinds, outcomes }
//                                         a run analysis (analysis.mjs): a new issue labelled
//                                         `analysis`, and a run in the `analyze` mode on it
import { researchRefusal } from "./access.mjs";
import {
  DEFAULT_RUNS,
  MAX_RUNS,
  checkSelection,
  createAnalysis,
  startAnalysis,
} from "./analysis.mjs";
import { MAX_TEXT, answersComment, parseAnswers } from "./answers.mjs";
import { labelFailed } from "./comments.mjs";
import { repoAllowed } from "./config.mjs";
import { FAILED } from "./board.mjs";
import { createDismissals } from "./dismissals.mjs";
import { createOrder } from "./order.mjs";
import { startAction } from "./permissions.mjs";
import { tagger } from "./discussions.mjs";
import {
  inboxItem,
  issueItem,
  linkedIssue,
  linkTo,
  MARKER,
  parseKey,
  prId,
  sameRepo,
  taskKey,
  unmarked,
} from "./events.mjs";
import { getJson, paginate } from "./github.mjs";
import { createInputSeeder } from "./inputs.mjs";
import { createRepoCheck } from "./repo-check.mjs";
import { MAX_NAME, createLanes, laneName } from "./lanes.mjs";
import { leadsTo, planSummary, readTree, repoOf, waitsOf } from "./plans.mjs";
import { isApart } from "./modes.mjs";
import { CONFIG_FILE, modeNames } from "./repo-config.mjs";
import { latestReview } from "./reviews.mjs";
import { issueList, waitsFor } from "./waits.mjs";
import { taskId } from "./spelling.mjs";
import { Refused, readJsonBody, refuse, send } from "../lib/http.mjs";
import { apiRoute, mustDo, routeChecks } from "./web.mjs";

// How many parents' sub-issues a backlog read asks GitHub for at once (parentsOf()).
const SUB_ISSUE_READS = 4;

// How long a repo's open issues are served before they are read again (in the background):
// the dashboard polls them.
export const ISSUES_MS = 30_000;
// How old a repo's backlog count on the repository list gets before it is read again (in the
// background, counts()): the list is polled for every repo, the backlog only for the one open.
export const COUNT_MS = 5 * 60000;
const MAX_BODY = 4096;
// The answers' text, and the JSON around it (escapes, indexes).
const MAX_ANSWER_BODY = 4 * MAX_TEXT;
const ACTIONS = ["start", "queue", "plan", "dequeue", "stop", "cancel"];
// The log lines' mark for what an MCP client asked (mcp.mjs).
const MCP = " (MCP)";
// Where a request came from, in the App's comments on GitHub: the dashboard's or an MCP
// client's, so that the issue's readers tell one from the other.
const DASHBOARD = "from the dashboard";
const FROM_MCP = "from an MCP client";
// What the routes need (permissions.mjs), checked before their handler; `work` and `inbox` check
// the mode they start (`runs:start:<mode>`), or `runs:manage` to cancel or dequeue.
const MANAGE = "runs:manage";
const WORK_ACTIONS = {
  issues: "tasks:read",
  analyze: startAction("analyze"),
  answer: MANAGE,
  rerun: MANAGE,
  review: MANAGE,
  dismiss: MANAGE,
  lane: MANAGE,
  order: MANAGE,
};
// The task page's buttons on a pull request whose review loop is over.
const REVIEW_ACTIONS = ["review", "fix"];
// An inbox entry's kind, and the repo config's key for its issue.
const INBOXES = { idea: "ideas", bug: "bugs" };
// An action's fields, checked (a body's, or answers' `then`): { action, number, after, mode,
// pr }. Throws Refused.
export function checkAction(body) {
  const { action, number, after = null, mode = null, pr = false } = body ?? {};
  const issue = (n) => Number.isSafeInteger(n) && n > 0;
  if (!ACTIONS.includes(action)) refuse(400, `The action is one of ${ACTIONS.join(", ")}.`);
  if (!issue(number)) refuse(400, "`number` is an issue number.");
  if (action === "queue" && !issue(after)) refuse(400, "`after` is an issue number.");
  if (action === "plan" && after !== null && !issue(after)) {
    refuse(400, "`after` is an issue number.");
  }
  if (mode !== null && (typeof mode !== "string" || !/^[\w-]+$/.test(mode))) {
    refuse(400, "`mode` is a mode's name.");
  }
  if (typeof pr !== "boolean") refuse(400, "`pr` is true or false.");
  return {
    action,
    number,
    after: action === "queue" || action === "plan" ? after : null,
    mode,
    pr: action === "cancel" && pr,
  };
}

// `github(repo, method, path, body, expected)`: the App's calls. `repoSettings(repo, base)`:
// the default branch's config. `reply(repo, number, text)`: the App's comment, or it throws (comments.mjs).
// `waits` (waits.mjs), `accept(item)` (tasks.mjs). `boardKeys()`: the keys of the tasks on the
// dashboard; `liveKeys()`: those with something live, which the backlog leaves out;
// `busy(key)`: a run going or queued, which can't be moved.
// `taskOf(key)`: the dashboard's task (board.mjs, with its `questions`), or null.
// `label(repo, number, on)`: the needs-input label; `inputs` (inputs.mjs), which the backlog
// also fills (seedInputs()).
// `runOf(id)`: a run's record (runs.mjs, with the comments it ran on), or null.
// `cancel(key, user)`: stops the task's run or drops its queued comments (runs.mjs cancel()):
// "running", "queued", "following" or null. `queuedTask(key)` (its `others` included), `unqueue(key, user, until)`: a task
// waiting for a slot whose newest comment that starts a run can wait for another issue
// instead, with its author's queued comments, and taking it out of the queue for that
// (runs.mjs). `analysis`: run digests (analysis.mjs createAnalysis()).
// `lanes`: the lanes' names (lanes.mjs), which a plan and the dashboard's renaming set.
// `dismissals`: the failed runs dismissed from the dashboard, and the runs whose questions
// were set aside, which the API's undo takes back too (dismissals.mjs).
// `order`: the run order (order.mjs); `queueOrder()`: the tasks waiting for a slot, in the
// order they start (tasks.mjs). `reviews`: the review loop (reviews.mjs createReviews()), for
// the dashboard's Fix.
export function createWorkApi({
  config,
  github,
  repoSettings,
  reply,
  waits,
  accept,
  boardKeys,
  liveKeys = boardKeys,
  busy,
  taskOf = () => null,
  label = async () => new Response(null, { status: 204 }),
  inputs = { set() {}, has: () => false },
  runOf = () => null,
  cancel = () => null,
  queuedTask = () => null,
  unqueue = () => null,
  analysis = createAnalysis({ runs: () => [] }),
  lanes = createLanes(),
  dismissals = createDismissals(),
  order = createOrder(),
  queueOrder = () => [],
  reviews = null,
  // What the operator's policies grant a repo (grants.mjs grantsBy()): research's, for its mode.
  granted = null,
  // Who may do what where (permissions.mjs): each route's action, and a start's mode's.
  permissions = null,
  publicUrl = () => null,
  // The key of the dashboard's "from" lines (discussions.mjs fromKey()), or null; or what tags
  // them, edge's (discussions.mjs tagger() `tags`).
  fromKey = () => null,
  fromTags = null,
  now = Date.now,
  log = () => {},
}) {
  // "owner/repo" → { repo, last: { issues, modes, errors, users, at, seq, version } | null,
  //                 read: Promise | null, again, seq, version, live, ended }
  const backlogs = new Map();
  const { baseOf, checkedRepo, nameOf } = createRepoCheck({ config, github, repoSettings });
  // Open questions in the backlog's issues that never got the label (inputs.mjs).
  const { seed: seedInputs } = createInputSeeder({ config, github, label, inputs, boardKeys, log });

  // The repo's open issues, newest first (pull requests are issues to this API: left out),
  // with their labels, their open sub-issues (subIssues()) and their listed parent
  // (parentsOf()), and the modes the dashboard offers: onboarding
  // is the listener's own, research only with its grant (access.mjs researchRefusal()).
  async function readBacklog(repo) {
    const base = await baseOf(repo);
    const { settings, errors } = await repoSettings(repo, base);
    const path = `/repos/${repo}/issues?state=open&sort=created&direction=desc&per_page=100`;
    const list = await getJson(github, repo, path);
    if (!Array.isArray(list)) throw new Error(`GitHub GET ${path}: no list`);
    if (!errors.length) await seedInputs(repo, list, settings.users);
    const issues = list.filter((i) => !i.pull_request);
    const parents = await parentsOf(repo, issues);
    return {
      // A full page: there may be more open issues than it has (counts()).
      more: list.length === 100,
      issues: issues.map((i) => ({
        number: i.number,
        title: i.title ?? null,
        url: i.html_url,
        labels: (i.labels ?? []).map(labelOf).filter((l) => l.name),
        ...subIssues(i),
        ...(parents.has(i.number) && { parent: parents.get(i.number) }),
      })),
      modes: errors.length ? [] : await offeredModes(repo, settings),
      errors: errors.length > 0,
      // Who may see it, as for the dashboard's tasks: unknown while the config has errors.
      users: errors.length ? null : settings.users,
    };
  }

  // `subIssues`: how many of its sub-issues are open, from the list's own summary, when any
  // are: dropped on the graph, it is laid out with them (plan()).
  function subIssues(issue) {
    const { total = 0, completed = 0 } = issue.sub_issues_summary ?? {};
    return total > completed ? { subIssues: total - completed } : {};
  }

  // A label as the list has it: an object, or its name alone (GitHub's older shape).
  function labelOf(label) {
    if (typeof label === "string") return { name: label, color: null };
    return { name: label?.name ?? "", color: label?.color ?? null };
  }

  // Sub-issue number → its parent's, for those whose parent is listed too: the dashboard can
  // hide them, a drop of their parent laying them out. The list doesn't say an issue's parent
  // (its parent_issue_url is null there), so each listed issue with open sub-issues is asked
  // for them: once per read, which the dashboard's polls share. One that fails only loses its
  // sub-issues' `parent`; a closed parent isn't listed, so its sub-issues have none.
  async function parentsOf(repo, issues) {
    const listed = new Set(issues.map((i) => i.number));
    const parents = new Map();
    const get = (path) => github(repo, "GET", path);
    const pending = issues.filter((i) => subIssues(i).subIssues);
    // A few at a time: GitHub's secondary rate limits penalise many calls at once.
    const reader = async () => {
      for (let i = pending.shift(); i; i = pending.shift()) {
        const path = `/repos/${repo}/issues/${i.number}/sub_issues`;
        try {
          for (const sub of await paginate(get, path)) {
            const here = !repoOf(sub) || sameRepo(repoOf(sub), repo);
            if (here && listed.has(sub.number) && sub.number !== i.number)
              parents.set(sub.number, i.number);
          }
        } catch (error) {
          log(`Work area: ${repo}: #${i.number}'s sub-issues: ${error.message ?? error}`);
        }
      }
    };
    await Promise.all(Array.from({ length: SUB_ISSUE_READS }, reader));
    return parents;
  }

  // Not `policy`: a dry run of a pull request's policies, never an issue's run.
  async function offeredModes(repo, settings) {
    const research = !(await researchRefusal(config, repo, { granted }));
    return modeNames(settings).filter(
      (m) => !["onboarding", "policy"].includes(m) && (m !== "research" || research),
    );
  }

  // A repo's read, one at a time; `at` is when it started, `seq` its number, `version` the
  // stale() calls it saw. One asked for while a read is going (`again`) runs after it: that
  // read started before the change. A failed read is not kept: the next request tries again.
  function refresh(known) {
    const at = now();
    const seq = ++known.seq;
    const version = known.version;
    const next = () => {
      known.read = null;
      if (!known.again) return;
      known.again = false;
      quietly(known, refresh(known));
    };
    known.read = readBacklog(known.repo).then(
      (data) => {
        known.last = { ...data, at, seq, version };
        next();
      },
      (error) => {
        next();
        throw error;
      },
    );
    return known.read;
  }

  // A read nobody waits for: its failure is only logged.
  const quietly = (known, read) =>
    read.catch((error) => log(`Work area: ${known.repo}: backlog: ${error.message ?? error}`));

  // A read now, or one more after the read going.
  function readAgain(known) {
    if (known.read) known.again = true;
    else quietly(known, refresh(known));
  }

  // The repo's tasks with something live, as lowercase keys. Those that were live at the last
  // request and no longer are ended since: in `known.ended`, with the number of the last read
  // started before. Their run may have closed the issue, which that read still has open: a new
  // read starts, and they stay out until one started after them lands.
  function ending(known, name) {
    const live = new Set(
      [...liveKeys()].map((k) => k.toLowerCase()).filter((k) => k.startsWith(`${name}#`)),
    );
    let ended = false;
    for (const key of known.live) {
      if (live.has(key)) continue;
      known.ended.set(key, known.seq);
      ended = true;
    }
    known.live = live;
    if (ended && known.last) {
      known.version++;
      readAgain(known);
    }
    return live;
  }

  // The last read straight away, refreshed in the background once it is older than ISSUES_MS
  // or stale(): only a repo without one waits for GitHub. `refreshing`: a newer read is on its
  // way, which the dashboard asks for again soon. Throws Refused for a user the repo's `users`
  // leave out. Its caller checked the rest (apiRoute(), or the MCP tools: http.mjs).
  async function backlogOf(repo, user) {
    const name = repo.toLowerCase();
    const known = entry(repo);
    const live = ending(known, name);
    const { last } = known;
    const fresh = last && last.version === known.version && now() - last.at < ISSUES_MS;
    if (!fresh && !known.read) {
      const read = refresh(known);
      if (last) quietly(known, read);
    }
    if (!last) await known.read;
    const { modes, errors, users, at } = known.last;
    if (!sees(users, user)) refuse(404, `${user} is not among ${repo}'s users.`);
    return {
      issues: shown(known, name, live),
      modes,
      errors,
      readAt: at,
      refreshing: known.read !== null,
    };
  }

  // The repo's entry in `backlogs`, created without a read.
  function entry(repo) {
    const name = repo.toLowerCase();
    let known = backlogs.get(name);
    if (!known) {
      known = { repo, last: null, read: null, again: false, seq: 0, version: 0 };
      Object.assign(known, { live: new Set(), ended: new Map(), counted: -Infinity });
      backlogs.set(name, known);
    }
    return known;
  }

  // Unknown while the repo's config has errors: anyone the operator allows.
  const sees = (users, user) => !users || users.includes(user.toLowerCase());

  // The last read's issues the backlog lists, `live`: ending()'s. The tasks change between two
  // reads: an issue started a moment ago leaves at once. One whose task is over (a run done, a
  // brainstorm stopped) is back, once a read started after it ended says it is still open.
  function shown(known, name, live) {
    const { issues, seq } = known.last;
    for (const [key, before] of known.ended) if (before < seq) known.ended.delete(key);
    const hidden = (n) => {
      const key = taskKey(name, n);
      return live.has(key) || known.ended.has(key);
    };
    return issues.filter((i) => !hidden(i.number));
  }

  // The repository list's backlog counts: "owner/repo" (lowercase) → { count, more, readAt }
  // from each repo's last read, as GET .../issues would list it for `user`, or null before one
  // (or when `user` isn't among the repo's users). `more`: the read was a full page of issues
  // and pull requests, so there may be more than `count`. Nothing waits for GitHub: a repo
  // whose read is older than COUNT_MS, or that has none, is read in the background, at most
  // once per COUNT_MS (a failing one too), and `issues` deliveries read it again (stale()).
  // Those reads label open questions as the board's do (seedInputs()).
  function counts(repos, user) {
    const out = {};
    for (const repo of repos) {
      const name = repo.toLowerCase();
      const known = entry(repo);
      const live = ending(known, name);
      const old = !known.last || now() - known.last.at >= COUNT_MS;
      if (old && !known.read && now() - known.counted >= COUNT_MS) {
        known.counted = now();
        quietly(known, refresh(known));
      }
      out[name] =
        known.last && sees(known.last.users, user)
          ? {
              count: shown(known, name, live).length,
              more: known.last.more,
              readAt: known.last.at,
            }
          : null;
    }
    return out;
  }

  // The checks a comment passes, for the signed-in `user`: the repo's config without errors,
  // the user in both the operator's and the repo's users, an open issue (a pull request when
  // `pr`) with no run going or queued; `queued`: or one waiting for a slot that can wait
  // instead (queuedTask()). Returns { settings, base, issue }; throws Refused.
  async function checked(repo, user, number, pr = false, queued = false) {
    const { settings, base } = await checkedRepo(repo, user);
    const issue = await getJson(github, repo, `/repos/${repo}/issues/${number}`, [404, 410]);
    if (!issue) refuse(404, `#${number} isn't an issue of ${repo}.`);
    if (pr && !issue.pull_request) refuse(404, `#${number} isn't a pull request of ${repo}.`);
    if (!pr && issue.pull_request) {
      refuse(422, `#${number} is a pull request: start its issue instead.`);
    }
    if (issue.state !== "open") refuse(409, `#${number} is closed.`);
    const key = taskKey(repo, number);
    if (busy(key) && !(queued && queuedTask(key)?.item)) {
      // Queued, but only replies to its last run: nothing that starts a run of its own to wait.
      // Others (an inbox entry, a wrap-up) can't wait either, nor leave for one later.
      if (queued && queuedTask(key)?.replies) {
        refuse(
          409,
          `#${number}'s queued comments only reply to its last run: they can't wait for another issue. Take it out of the queue, then queue it after one.`,
        );
      }
      refuse(409, `#${number} is running or queued: it can't be moved now.`);
    }
    return { settings, base, issue };
  }

  // The App's comment on the issue: the record of who did what, and where the run's reactions
  // go, as on the comment it stands for.
  async function comment(repo, number, text) {
    const res = await reply(repo, number, text);
    const c = await res.json();
    return { id: c.id, html_url: c.html_url, node_id: c.node_id };
  }

  // What a trigger comment ("Deckhand", with "/mode <name>" unless it is work) would queue.
  function itemOf(repo, issue, mode, user, base, settings) {
    return issueItem(repo, issue, {
      trigger: "work",
      modeLine: mode === "work" ? null : mode,
      text: "",
      author: user,
      base,
      settings,
      // For the policies' `input.trigger` (run-policy.mjs).
      dashboard: true,
    });
  }

  // Throws a 403 unless `user` may start a run in `mode` on `repo` (permissions.mjs): checked
  // before anything is posted for it.
  const startable = (repo, user, mode) => mustDo(permissions, user, repo, startAction(mode));

  const inMode = (mode) => (mode === "work" ? "" : ` in \`${mode}\` mode`);

  // accept() → its mode, null when it runs nothing. `key`: the task whose wait it replaces once
  // it runs, held meanwhile (waits.mjs reserve()), `why` for the log. Refused by the policies
  // (run-policy.mjs: `refused`, their reply posted), the App's comment `user` posted for it
  // (item.comment) is edited to say nothing started, keeping what else it said (`also`: the
  // answers typed in the drag's form, which nothing ran with), and the wait stays.
  async function started(
    item,
    { key = null, why = null, user = null, also = "", from = DASHBOARD } = {},
  ) {
    const held = key ? waits.reserve(key) : null;
    let mode = null;
    try {
      mode = await accept(item);
    } finally {
      if (key) await waits.release(key, !!mode, why, held);
    }
    if (item.refused && user && item.comment?.id) {
      const wait = key ? waits.get(key) : null;
      const still = wait ? ` It still waits for ${waitsFor(wait)}.` : "";
      const body = `Asked ${from} by @${user}: not started, the policies refuse it.${still}${also}\n\n${MARKER}`;
      const path = `/repos/${item.repo}/issues/comments/${item.comment.id}`;
      const res = await github(item.repo, "PATCH", path, { body }).catch((error) => {
        log(`Work area: editing comment ${item.comment.id}: ${error.message ?? error}`);
        return null;
      });
      if (res && !res.ok) log(`Work area: editing comment ${item.comment.id}: ${res.status}`);
    }
    return mode;
  }

  // started(), then the policies' refusal as the dashboard's answer: the action didn't start
  // anything.
  async function queued(item, options) {
    await started(item, options);
    if (item.refused) refuse(403, item.refused);
  }

  // `answers`: the answers to its open questions (answersComment()), sent along from the form
  // the drag opened; they go in the App's comment and are the run's text. Without them, an
  // issue with open questions doesn't move: they are answered first, unless the repo's
  // `wait_for_answers` is off.
  // `from`: where it was asked (DASHBOARD, FROM_MCP), which its App comments say.
  async function act(
    repo,
    user,
    { action, number, after, mode, pr },
    answers = null,
    from = DASHBOARD,
  ) {
    if (action === "cancel" || action === "dequeue") await mustDo(permissions, user, repo, MANAGE);
    if (action === "stop") await startable(repo, user, "stop");
    // Whatever the issue's state: a run may go on once it is closed.
    if (action === "cancel") return cancelTask(repo, user, number, pr, from);
    const key = taskKey(repo, number);
    const checks = await checked(repo, user, number, false, action === "queue");
    const { settings, base, issue } = checks;
    if (action === "plan") return plan(repo, user, checks, { after, mode }, answers, from);
    const asks = action === "start" || action === "queue";
    if (!answers && asks && asking(settings, key)) {
      refuse(409, `#${number} has open questions: answer them first.`);
    }
    if (action === "queue" && queuedTask(key)?.item) {
      return requeue(repo, user, { number, after, mode, settings, answers, from });
    }
    const wait = waits.get(key);
    if (action === "dequeue") return dequeue(repo, user, number, wait, from);
    if (action === "stop") return stop(repo, user, issue, base, settings, from);
    // Moving a wait keeps its mode, unless another one is picked.
    const wanted = mode ?? wait?.item.modeLine ?? "work";
    if (!modeNames(settings).includes(wanted)) refuse(422, `${repo} has no mode \`${wanted}\`.`);
    await startable(repo, user, wanted);
    const item = itemOf(repo, issue, wanted, user, base, settings);
    if (answers) item.text = answers;
    const also = answers ? `\n\n${answers}` : "";
    if (action === "queue") {
      const waiting = await queueAfter(repo, user, { item, after, mode, wanted, wait, also, from });
      if (waiting) return waiting;
      // Done already: it starts now, as "/after" would.
    }
    const why = action === "queue" ? `: #${after} is done already` : "";
    const was = wait && action === "start" ? ` It no longer waits for ${waitsFor(wait)}.` : "";
    item.comment = await comment(
      repo,
      number,
      `Started ${from} by @${user}${inMode(wanted)}${why}.${was}${also}`,
    );
    // Its wait goes once it runs: refused by the policies (a 403, after their reply), it stays.
    await queued(item, { key, why: `started ${from} by @${user}`, user, also, from });
    return `#${number} started.`;
  }

  // Whether the task of `key` has open questions that hold its start (`wait_for_answers`).
  function asking(settings, key) {
    const task = taskOf(key);
    return settings.waitForAnswers && task?.state === "needs-input" && !!task.questions;
  }

  // A parent issue dropped on the graph: its whole tree laid out at once (plans.mjs). Each
  // sub-issue with nothing to wait for starts, the others wait for their blockers, the parent
  // for its sub-issues; all in the mode picked. Every issue is checked as checked() checks one
  // before anything is posted: nothing half-done. `after`: the issue it was dropped next to,
  // which the tree's first issues wait for. One without open sub-issues starts or queues.
  async function plan(repo, user, { settings, base, issue }, { after, mode }, answers, from) {
    const { number } = issue;
    const tree = await readTree(github, repo, issue);
    const away = tree.elsewhere.length
      ? ` Left out, in another repository: ${tree.elsewhere.join(", ")}.`
      : "";
    if (tree.nodes.size === 1) {
      const action = after === null ? "start" : "queue";
      const asked = { action, number, after, mode, pr: false };
      return `${await act(repo, user, asked, answers, from)}${away}`;
    }
    let afterDone = "";
    if (after !== null) {
      if (tree.nodes.has(after))
        refuse(422, `#${after} is part of #${number}: it can't wait for it.`);
      const state = await waits.stateOf(repo, after);
      if (state === "missing") refuse(422, `#${after} isn't an issue or pull request of ${repo}.`);
      if (state === "not-done") refuse(422, `#${after} was closed without being done.`);
      if (state !== "open") {
        afterDone = ` #${after} is done already: nothing waits for it.`;
        after = null;
      }
    }
    const order = [...tree.nodes.keys()];
    for (const n of order) {
      const key = taskKey(repo, n);
      if (n !== number && busy(key)) {
        refuse(409, `#${n} is running or queued: it can't be moved now.`);
      }
      if (!(n === number && answers) && asking(settings, key)) {
        refuse(409, `#${n} has open questions: answer them first.`);
      }
      // A waiting one keeps its mode, unless another one is picked.
      const wanted = mode ?? waits.get(key)?.item.modeLine ?? "work";
      if (!modeNames(settings).includes(wanted)) refuse(422, `${repo} has no mode \`${wanted}\`.`);
      await startable(repo, user, wanted);
    }
    const planned = waitsOf(tree, { after, existing: blockersOf(repo) });
    // Those that wait first: the ones that start can't end before their waits are there.
    const waiting = order.filter((n) => planned.get(n).length);
    const steps = [...waiting, ...order.filter((n) => !planned.get(n).length)];
    const laid = [];
    // Those the policies refused to start (their reply on each says why).
    const refusedRuns = [];
    try {
      for (const n of steps) {
        const how = { number, n, tree, planned, mode, base, settings, answers, from };
        if (await layOut(repo, user, how)) {
          refusedRuns.push(n);
        }
        laid.push(n);
      }
    } catch (error) {
      if (laid.length) named(repo, number, laid);
      // Checked, then GitHub failed halfway (an outage, a rate limit): what is done stays.
      log(`Work area: ${taskKey(repo, number)}: plan: ${error.message ?? error}`);
      const left = steps.filter((n) => !laid.includes(n));
      const done = laid.length ? `${issueList(laid)} laid out, ` : "nothing laid out, ";
      refuse(
        502,
        `GitHub failed on #${left[0]}: ${done}${issueList(left)} not. Start or queue those from the backlog.`,
      );
    }
    // Their lane is named after the parent.
    named(repo, number, laid);
    const skipped = tree.done.length ? ` Done already: ${issueList(tree.done)}.` : "";
    const refusals = refusedRuns.length
      ? ` Refused by the policies, not started: ${issueList(refusedRuns)}.`
      : "";
    return `#${number} laid out: ${planSummary(order, planned)}.${refusals}${afterDone}${skipped}${away}`;
  }

  // The issues a plan laid out are the parent's lane. What is on GitHub stays whatever happens
  // to the lanes' names: a failure is logged, not the plan's answer.
  function named(repo, number, laid) {
    try {
      lanes.planned(repo, number, laid);
    } catch (error) {
      log(`Work area: ${taskKey(repo, number)}: the lane's name: ${error.message ?? error}`);
    }
  }

  // What a plan does for issue `n` of the tree: the App's comment, then its wait or its start.
  async function layOut(
    repo,
    user,
    { number, n, tree, planned, mode, base, settings, answers, from },
  ) {
    const key = taskKey(repo, n);
    const wait = waits.get(key);
    const wanted = mode ?? wait?.item.modeLine ?? "work";
    const item = itemOf(repo, tree.nodes.get(n).issue, wanted, user, base, settings);
    const also = n === number && answers ? `\n\n${answers}` : "";
    if (also) item.text = answers;
    const part = n === number ? "" : ` as part of #${number}`;
    const was = wait ? ` It no longer waits for ${waitsFor(wait)}.` : "";
    const blockers = planned.get(n);
    if (blockers.length) {
      const they = blockers.length > 1 ? "they are" : "it is";
      item.comment = await comment(
        repo,
        n,
        `Queued ${from} by @${user}${part}, after ${issueList(blockers)}${inMode(wanted)}.${was} It starts when ${they} done (closed as completed, or merged).${also}`,
      );
      await waits.hold(item, blockers);
      return;
    }
    item.comment = await comment(
      repo,
      n,
      `Started ${from} by @${user}${inMode(wanted)}${part}.${was}`,
    );
    // Refused by the policies (their reply says why, the comment is edited), its wait stays:
    // true, for the plan's answer.
    await started(item, {
      key,
      why: `started ${from} by @${user} as part of #${number}`,
      user,
      from,
    });
    return !!item.refused;
  }

  // What each issue of `repo` waits for already (waits.mjs), by number.
  const blockersOf = (repo) => (n) => waits.get(taskKey(repo, n))?.blockers ?? [];

  // Whether issue `number` may wait for `after`: "open" when it waits, "done" when there is
  // nothing to wait for. Throws Refused.
  async function waitable(repo, number, after) {
    if (after === number) refuse(422, `#${number} can't wait for itself.`);
    // Queueing it after an issue whose waits lead back to it: neither would start.
    if (leadsTo(blockersOf(repo), after, number)) {
      refuse(422, `#${after} waits for #${number}: each would wait for the other.`);
    }
    const state = await waits.stateOf(repo, after);
    if (state === "missing") refuse(422, `#${after} isn't an issue or pull request of ${repo}.`);
    if (state === "not-done") refuse(422, `#${after} was closed without being done.`);
    return state === "open" ? "open" : "done";
  }

  // What "/after #n" does: `item` waits for issue `after`, its wait (`wait`, if any) moved
  // there. Null when `after` is done already: the caller starts it.
  async function queueAfter(repo, user, { item, after, mode, wanted, wait, also, from }) {
    const { number } = item;
    if ((await waitable(repo, number, after)) !== "open") return null;
    if (wait?.blockers.length === 1 && wait.blockers[0] === after && !mode) {
      return `#${number} already waits for #${after}.`;
    }
    const text = wait
      ? `Moved ${from} by @${user}: now after #${after}${inMode(wanted)} (it waited for ${waitsFor(wait)}).`
      : `Queued ${from} by @${user}, after #${after}${inMode(wanted)}.`;
    item.comment = await comment(
      repo,
      number,
      `${text} It starts when #${after} is done (closed as completed, or merged).${also}`,
    );
    await waits.hold(item, [after]);
    return `#${number} waits for #${after}.`;
  }

  // A task waiting for a slot queued after issue `after`: out of the queue, its newest comment
  // that starts a run waits for `after` instead (runs.mjs unqueue()), with the text of its
  // author's queued comments, its author and its mode unless another is picked; the others'
  // comments are dropped, which the App's comment says. `after` done already: it stays
  // queued, as it would start now anyway. `user` needs the start of the mode it waits in, and
  // `runs:manage` to move someone else's comment or drop another author's, as dequeueing needs
  // (mayMove()).
  async function requeue(repo, user, { number, after, mode, settings, answers, from }) {
    const key = taskKey(repo, number);
    const modeOf = (item) => mode ?? item.modeLine ?? "work";
    const known = (wanted) => {
      if (!modeNames(settings).includes(wanted)) refuse(422, `${repo} has no mode \`${wanted}\`.`);
    };
    const mayMove = async ({ item, others }) => {
      known(modeOf(item));
      await startable(repo, user, modeOf(item));
      if (others || item.author?.toLowerCase() !== user.toLowerCase()) {
        await mustDo(permissions, user, repo, MANAGE);
      }
    };
    // Refused before GitHub is read; asked again of the comment held below.
    await mayMove(queuedTask(key));
    if ((await waitable(repo, number, after)) !== "open") {
      return `#${after} is done already: #${number} stays queued.`;
    }
    // The comment that waits, once its 👀 is known and `user` may move it: out of the queue, it
    // is saved as a wait at once, with nothing awaited between (an orchestrator stopping then
    // would lose it). A newer one queued meanwhile is waited for, and decided, in turn. Gone:
    // started meanwhile (a slot freed).
    let held = null;
    for (;;) {
      const task = queuedTask(key);
      held = task?.item;
      if (!held) refuse(409, `#${number} is running or queued: it can't be moved now.`);
      await held.eyes?.catch?.(() => null);
      await mayMove(task);
      // The same comment, and no other author's queued meanwhile.
      const now = queuedTask(key);
      if (now?.item === held && (task.others || !now.others)) break;
    }
    const wanted = modeOf(held);
    // No await from queuedTask() above: unqueue() holds that same comment. One pair: the wait in
    // the store first, then the queue without its comments (`saved`, restart.mjs park()), so an
    // orchestrator killed in between leaves them in both, to the wait (loadQueue()).
    let saved;
    const until = new Promise((resolve) => (saved = resolve));
    const { item, dropped, unqueued } = unqueue(key, user, until) ?? {};
    if (!item) refuse(409, `#${number} is running or queued: it can't be moved now.`);
    // A mode picked starts as a trigger comment with that mode would: a `/mode` comment alone
    // has no trigger, and with work picked, no mode line either.
    if (mode) Object.assign(item, { trigger: "work", modeLine: mode === "work" ? null : mode });
    if (answers) item.text = [item.text, answers].filter(Boolean).join("\n\n---\n\n");
    try {
      await waits.hold(item, [after], { eyes: true, unqueued });
    } finally {
      saved(waits.written(key));
    }
    // It waits already: a failed comment doesn't make it fail.
    const also = answers ? `\n\n${answers}` : "";
    const others = dropped
      ? ` ${dropped === 1 ? "A comment" : `${dropped} comments`} queued by someone else ${dropped === 1 ? "was" : "were"} dropped: only its author's go with it. Post again to add ${dropped === 1 ? "it" : "them"}.`
      : "";
    await comment(
      repo,
      number,
      `Moved ${from} by @${user}: no longer queued, now waits for #${after}${inMode(wanted)}. It starts when #${after} is done (closed as completed, or merged).${others}${also}`,
    ).catch((error) => log(`${key}: ${error.message ?? error}`));
    return `#${number} waits for #${after}.`;
  }

  // Issue `number` no longer waits (`wait`): nothing starts until asked again.
  async function dequeue(repo, user, number, wait, from) {
    if (!wait) refuse(409, `#${number} doesn't wait for anything.`);
    waits.cancel(taskKey(repo, number), `cancelled ${from} by @${user}`);
    await comment(
      repo,
      number,
      `No longer waiting for ${waitsFor(wait)}: cancelled ${from} by @${user}. Nothing starts until a trigger comment or the dashboard says so.`,
    );
    return `#${number} no longer waits.`;
  }

  // What a "/stop" comment does: the brainstorm wraps up (task-modes.mjs stopBrainstorm()), in a
  // run that posts its summary and updates the issue. Only an active or idle one: checked()
  // refused a reply on its way.
  async function stop(repo, user, issue, base, settings, from) {
    const { number } = issue;
    const state = taskOf(taskKey(repo, number))?.state;
    if (state !== "brainstorm" && state !== "idle-brainstorm") {
      refuse(409, `#${number} has no brainstorm to stop.`);
    }
    const item = { ...itemOf(repo, issue, "work", user, base, settings), trigger: "stop" };
    item.comment = await comment(
      repo,
      number,
      `Brainstorm stopped ${from} by @${user}: a summary and the issue's update follow.`,
    );
    await queued(item, { user, from });
    return `#${number}'s brainstorm wraps up.`;
  }

  // What a `/cancel` comment does (tasks.mjs cancelRun()), with the App's comment for the
  // record. The run's own reply follows once its sandbox is gone.
  async function cancelTask(repo, user, number, pr, from) {
    await checkedRepo(repo, user);
    const key = taskKey(repo, pr ? prId(number) : number);
    const replyTo = taskOf(key)?.replyTo ?? number;
    const what = cancel(key, user);
    if (!what) refuse(409, `Nothing is running or queued on #${number}.`);
    // Stopped already: a failed comment doesn't make it fail.
    // Back in the backlog: an issue's task with no run. Behind a run that is ending, or a pull
    // request's, its queued comments are just dropped.
    const backlog = what === "queued" && !pr;
    const text =
      what === "running"
        ? `Stopped ${from} by @${user}.`
        : backlog
          ? `Taken out of the queue ${from} by @${user}: back in the backlog.`
          : `Queued comments dropped ${from} by @${user}.`;
    await comment(repo, replyTo, text).catch((error) => log(`${key}: ${error.message ?? error}`));
    if (what === "running") return `#${number} stops.`;
    return backlog ? `#${number} is back in the backlog.` : `#${number}'s queued comments dropped.`;
  }

  // Answers to the open questions of the task of issue (or pull request) `number`, as one App
  // comment. A run's questions: the comment is the reply that continues its session, as an
  // allowed user's would be. An issue's (its body's section): App comments don't take the
  // label off (questions.mjs), so this does, once every question has an answer.
  async function answer(repo, user, asked, where = DASHBOARD) {
    const { number, pr } = asked;
    const key = taskKey(repo, pr ? prId(number) : number);
    const task = taskOf(key);
    if (task?.state !== "needs-input") refuse(409, `#${number} isn't waiting for answers.`);
    if (asked.then) return answerThen(repo, user, task, asked);
    const { settings, base, issue } = await checked(repo, user, number, pr);
    const questions = task.questions ?? null;
    const { comment: text, open } = answersComment(user, questions?.items ?? null, asked, where);
    // Where the run asked: a pull request's run on an issue's task replies on the pull request.
    const replyTo = task.replyTo ?? number;
    const fromRun = questions
      ? questions.source === "run"
      : task.runs?.[0]?.status === "needs-input";
    // The session goes on in its mode: its start is the user's, before the App's comment, from the
    // dashboard or ticked on GitHub (ticked(), whose caller logs the refusal).
    if (fromRun) await startable(repo, user, task.mode ?? "work");
    const posted = await comment(repo, replyTo, text);
    const left = open.length ? ` ${open.length} still open.` : "";
    if (fromRun) {
      // From the dashboard, a refusal is its answer; ticked on GitHub, the reply there says it.
      await (where === DASHBOARD ? queued : accept)({
        repo,
        id: pr ? prId(number) : String(number),
        kind: pr ? "pr" : "issue",
        number,
        title: issue.title ?? null,
        // No trigger line: it goes on in the session that asked, as a reply on GitHub would.
        trigger: null,
        modeLine: null,
        text,
        replyTo,
        author: user,
        base,
        settings,
        comment: posted,
        // Ticked on GitHub, it is a GitHub action (ticked()): the policies' `input.trigger`.
        dashboard: where === DASHBOARD,
      });
      return `Answers sent: #${number} continues.${left}`;
    }
    if (open.length) return `Answers sent: #${number} still needs input.${left}`;
    const res = await label(repo, number, false);
    if (labelFailed(res)) throw new Error(`GitHub label of #${number}: ${res.status}`);
    inputs.set(key, false);
    return `Answers sent: #${number} no longer needs input.`;
  }

  // The boxes ticked in a run's reply on issue or pull request `number`, `user`'s edit
  // (questions.mjs tickedReply()): `items`, the reply's questions as the edit left them. They go
  // on as the dashboard's answers would, when they are those of the task's latest run still
  // waiting: ticking an older reply's boxes, or one already answered, starts nothing. Only a
  // person's ticks answer: those the run's reply came with (the task's own `checked`, parsed
  // from its text) are the agent's, so each question needs a box ticked since.
  // A pull request's run on an issue's task replied on the pull request (its `replyTo`).
  async function ticked(repo, user, { number, pr, items }) {
    const keys = [taskKey(repo, pr ? prId(number) : number), ...(pr ? boardKeys() : [])];
    const task = keys
      .map((key) => taskOf(key))
      .find(
        (t) =>
          t?.state === "needs-input" &&
          t.questions?.source === "run" &&
          sameRepo(parseKey(t.key)?.repo, repo) &&
          (t.replyTo ?? t.number) === number,
      );
    const asked = task?.questions.items;
    // The same questions, options included: the answers are indexes into the task's.
    const shape = (qs) =>
      JSON.stringify(
        qs.map((q) => ({ title: q.title, text: q.text, options: q.options.map((o) => o.label) })),
      );
    const same = !!asked && shape(asked) === shape(items);
    if (!task || !same) return `#${number}: ticked, but not the questions waiting for answers`;
    const answers = items.map((q, i) => ({
      options: [q.options.findIndex((o, j) => o.checked && !asked[i].options[j].checked)],
      text: "",
    }));
    if (answers.some((a) => a.options[0] < 0)) {
      return `#${number}: ticked, but not a new box in every question`;
    }
    const target = parseKey(task.key);
    const which = { number: target.number, pr: target.kind === "pr" };
    const where = "ticked in the run's questions";
    return answer(repo, user, { ...which, answers, text: null, then: null }, where);
  }

  // Answers sent from the form a drag on the graph opened, and that drag's action (`then`):
  // every question answered, then the issue starts or queues with them in one App comment.
  // Answered, it no longer waits for input, whoever asked.
  async function answerThen(repo, user, task, asked) {
    const then = checkAction({ ...asked.then, number: asked.number });
    if (asked.pr || !["start", "queue", "plan"].includes(then.action)) {
      refuse(422, "Only an issue starts or queues once its questions are answered.");
    }
    const { comment: text, open } = answersComment(user, task.questions?.items ?? null, asked);
    if (open.length) refuse(400, "Answer every question before it starts.");
    const message = await act(repo, user, then, text);
    const res = await label(repo, asked.number, false);
    if (labelFailed(res)) throw new Error(`GitHub label of #${asked.number}: ${res.status}`);
    inputs.set(task.key, false);
    return `Answers sent: ${message}`;
  }

  // The task's last run again, when it failed or the listener lost it: checked as a comment
  // is, then queued as its comments were, in its mode, with the App's comment for its
  // reactions. The issue's session volume carries what the run had done.
  async function rerun(repo, user, runId, from = DASHBOARD) {
    const run = runOf(runId);
    if (!sameRepo(run?.repo, repo)) refuse(404, `No run ${runId} in ${repo}.`);
    const target = parseKey(run.key);
    if (!target || target.kind === "discussion") {
      refuse(409, "Only work on an issue or pull request runs again.");
    }
    const { id, number } = target;
    const pr = target.kind === "pr";
    const { settings, base, issue } = await checked(repo, user, number, pr);
    // A pull request's task isn't checked() by its number.
    if (busy(run.key)) refuse(409, `#${number} is running or queued already.`);
    const task = taskOf(run.key);
    if (task?.runs[0]?.id !== runId) refuse(409, `Only the latest run of #${number} runs again.`);
    if (!task.rerunnable) {
      refuse(409, `#${number}'s last run didn't fail, or isn't work: it doesn't run again.`);
    }
    const mode = run.taskMode;
    if (!modeNames(settings).includes(mode)) refuse(422, `${repo} has no mode \`${mode}\` now.`);
    await startable(repo, user, mode);
    const replyTo = run.replyTo ?? number;
    const ended = { error: "failed", cancelled: "was stopped" }[run.status] ?? "was interrupted";
    const posted = await comment(
      repo,
      replyTo,
      `Rerun ${from} by @${user}${inMode(mode)}: its last run ${ended}.`,
    );
    await queued(
      {
        ...itemOf(repo, issue, mode, user, base, settings),
        id,
        kind: pr ? "pr" : "issue",
        // The comments it ran on, as begin() joins them; "/model" lines and all.
        text: run.items
          .map((i) => i.text)
          .filter(Boolean)
          .join("\n\n---\n\n"),
        replyTo,
        comment: posted,
      },
      { user, from },
    );
    return `Rerun of #${number} queued.`;
  }

  // Pull requests whose dashboard Review or Fix is being started (reviewAgain()).
  const starting = new Set();

  // The dashboard's Review or Fix on pull request `number`, checked as a comment is (the
  // repo's users, the pull request open, nothing running or queued on it or its issue), then
  // the App's comment, the record of who asked and where the run's reactions go, and the run
  // queued here: bot comments never reach admit().
  async function reviewAgain(repo, user, number, action) {
    const { settings, base } = await checkedRepo(repo, user);
    if (!settings.review) refuse(422, `${repo} has no \`review\` in its ${CONFIG_FILE}.`);
    if (action === "fix" && !settings.review.fix) {
      refuse(422, `${repo}'s \`review.fix\` is off: its findings start no fix run.`);
    }
    const pr = await getJson(github, repo, `/repos/${repo}/pulls/${number}`, [404]);
    if (!pr) refuse(404, `#${number} isn't a pull request of ${repo}.`);
    if (pr.state !== "open") refuse(409, `#${number} is closed.`);
    const issue = linkedIssue(pr, repo, config.bot);
    const key = taskKey(repo, prId(number)).toLowerCase();
    if (
      starting.has(key) ||
      busy(taskKey(repo, prId(number))) ||
      (issue && busy(taskKey(repo, String(issue))))
    ) {
      refuse(409, `#${number} has a run going or queued.`);
    }
    // Held until its run is queued: a second request meanwhile (another tab, another
    // maintainer) would pass busy() too, and post and queue a second one.
    starting.add(key);
    try {
      if (action === "fix") return await fixAgain(repo, user, { number, pr, settings, base });
      return await queueReview(repo, user, { number, pr, issue, settings, base });
    } finally {
      starting.delete(key);
    }
  }

  // The dashboard's Review: what `/mode review` on the pull request queues, with the App's
  // comment for its reactions.
  async function queueReview(repo, user, { number, pr, issue, settings, base }) {
    await startable(repo, user, "review");
    const posted = await comment(repo, number, `Review from the dashboard by @${user}.`);
    const item = {
      repo,
      id: prId(number),
      kind: "pr",
      number,
      title: pr.title ?? null,
      // What `/mode review` on the pull request queues.
      trigger: "work",
      modeLine: "review",
      after: null,
      text: "",
      replyTo: number,
      comment: posted,
      author: user,
      base,
      settings,
      dashboard: true,
    };
    await queued(issue ? linkTo(item, issue) : item, { user });
    return `Review of #${number} queued.`;
  }

  // One fix run more on the findings of the App's latest review, read back from GitHub with
  // the repo's tolerance: reviews' startFix() decides, counts the round and queues it.
  async function fixAgain(repo, user, { number, pr, settings, base }) {
    if (!reviews) refuse(503, "Reviews aren't set up on this listener.");
    // Its push is reviewed through the CI step, which drops a draft, and only a ready pull
    // request merges by itself.
    if (pr.draft) refuse(409, `#${number} is a draft: mark it ready for review first.`);
    // A fix run is work that pushes: its start is the user's, before the App's comment.
    await startable(repo, user, "work");
    const allowed = settings.review.maxAllowedSeverity;
    const review = await latestReview(github, config, repo, number, allowed);
    if (!review) refuse(409, `#${number} has no review of Deckhand's to fix.`);
    let announced = null;
    const announce = async (round, rounds, left) => {
      const asked = `Fix round ${round} from the dashboard by @${user}`;
      announced = { asked, ...(await comment(repo, number, `${asked}: ${left} left.`)) };
      return announced;
    };
    let started;
    try {
      started = await reviews.fixAsked(
        { repo, number, base, settings },
        { review, pr },
        { user, announce },
      );
    } catch (error) {
      if (announced) await withdraw(repo, announced, "not started, the listener failed");
      throw error;
    }
    if (!started.item) {
      // Refused after the App's comment (checked again once it was posted): it says so.
      if (announced) await withdraw(repo, announced, `not started, ${started.why}`);
      refuse(409, `No fix run on #${number}: ${started.why}.`);
    }
    return `Fix round ${started.item.round} of #${number} queued.`;
  }

  // The App's comment `posted` ({ id, asked }) edited to say `what` became of it. Failing only
  // leaves it as it was: logged.
  async function withdraw(repo, posted, what) {
    const path = `/repos/${repo}/issues/comments/${posted.id}`;
    const body = `${posted.asked}: ${what}.\n\n${MARKER}`;
    try {
      const res = await github(repo, "PATCH", path, { body });
      if (!res.ok) log(`Work area: editing comment ${posted.id}: ${res.status}`);
    } catch (error) {
      log(`Work area: editing comment ${posted.id}: ${error.message ?? error}`);
    }
  }

  // The task's last run, failed, lost or cancelled, no longer asks for attention: its task
  // leaves Waiting on you and the Error chip until another run (board.mjs). Checked as
  // rerun() is, but nothing is posted or started: the repo's users only, any kind of task.
  // `undo`: it asks again.
  async function dismiss(repo, user, runId, undo) {
    const run = runOf(runId);
    if (!sameRepo(run?.repo, repo)) refuse(404, `No run ${runId} in ${repo}.`);
    await checkedRepo(repo, user);
    const task = taskOf(run.key);
    const name = `#${parseKey(run.key)?.number ?? run.key}`;
    if (undo) {
      if (!dismissals.undo(task?.key ?? run.key, runId)) {
        refuse(409, `That run of ${name} isn't dismissed.`);
      }
      return `${name}'s dismissal is undone.`;
    }
    if (task?.runs[0]?.id !== runId) refuse(409, `Only the latest run of ${name} is dismissed.`);
    if (!FAILED.includes(run.status) || task.state !== run.status) {
      refuse(409, `${name}'s last run didn't fail or stop: there is nothing to dismiss.`);
    }
    dismissals.dismiss(task.key, runId, user);
    return `${name} dismissed.`;
  }

  // An idea or a bug report for the repo's inbox, as a comment there would be: the App's
  // comment on the inbox issue (an entry, not a reply: no marker), then the run it starts,
  // queued here since bot comments never reach admit(). The run reads the entry as the user's.
  async function sendToInbox(repo, user, { kind, text }) {
    await startable(repo, user, kind);
    const { settings, base } = await checkedRepo(repo, user);
    const number = settings.inbox?.[INBOXES[kind]];
    if (!number) {
      refuse(
        409,
        `${repo} has no ${kind} inbox: see \`inbox.${INBOXES[kind]}\` in its ${CONFIG_FILE}.`,
      );
    }
    const issue = await getJson(github, repo, `/repos/${repo}/issues/${number}`, [404, 410]);
    if (!issue) refuse(409, `${repo}'s ${kind} inbox, #${number}, isn't an issue.`);
    const body = await tagger({ tags: fromTags, key: fromKey }).post(user, text);
    const sent = await github(repo, "POST", `/repos/${repo}/issues/${number}/comments`, { body });
    if (!sent.ok) throw new Error(`GitHub POST a comment on #${number}: ${sent.status}`);
    const c = await sent.json();
    const posted = { id: c.id, html_url: c.html_url, node_id: c.node_id };
    await queued({
      ...inboxItem(repo, issue, kind, posted, { login: user }, text),
      author: user,
      base,
      settings,
      dashboard: true,
    });
    return { message: `Sent to #${number}.`, url: posted.html_url, task: taskKey(repo, number) };
  }

  // The form's preview: the same checks, then what the selection would read. Empty kinds or
  // outcomes are no error here: the form starts with none, and learns the kinds there are.
  async function previewAnalysis(req, res, user, repo) {
    const query = new URL(req.url, "http://localhost").searchParams;
    const list = (name) => (query.get(name) ?? "").split(",").filter(Boolean);
    const selection = checkSelection(
      {
        count: query.has("count") ? Number(query.get("count")) : DEFAULT_RUNS,
        kinds: list("kinds"),
        outcomes: list("outcomes"),
      },
      (message) => refuse(400, message),
      { empty: true },
    );
    await checkedRepo(repo, user);
    send(res, 200, { ...(await analysis.preview(repo, selection)), max: MAX_RUNS });
  }

  async function answers(req, res, user, repo) {
    const asked = parseAnswers(await readJsonBody(req, MAX_ANSWER_BODY));
    log(
      `Work area: ${user} answers ${taskKey(repo, asked.pr ? prId(asked.number) : asked.number)}`,
    );
    send(res, 200, { message: await answer(repo, user, asked) });
  }

  async function work(req, res, user, repo) {
    send(res, 200, { message: await asks(repo, user, await readJsonBody(req, MAX_BODY)) });
  }

  // POST …/work's body for `user` on `repo`, from the dashboard or an MCP client (`via`, the
  // log line's mark, MCP for a client's, whose App comments then say so): its answer's message.
  // Throws Refused.
  async function asks(repo, user, body, via = "") {
    const asked = checkAction(body);
    log(
      `Work area: ${user} asks ${asked.action} ${taskKey(repo, asked.number)}${asked.after ? ` after #${asked.after}` : ""}${via}`,
    );
    return act(repo, user, asked, null, via === MCP ? FROM_MCP : DASHBOARD);
  }

  async function reruns(req, res, user, repo) {
    const runId = (await readJsonBody(req, MAX_BODY))?.runId;
    send(res, 200, { message: await rerunAsked(repo, user, runId) });
  }

  // POST …/rerun's body, as asks() is …/work's.
  async function rerunAsked(repo, user, runId, via = "") {
    if (typeof runId !== "string" || !/^[\w.-]+$/.test(runId))
      refuse(400, "`runId` is a run's id.");
    log(`Work area: ${user} reruns ${repo} ${runId}${via}`);
    return rerun(repo, user, runId, via === MCP ? FROM_MCP : DASHBOARD);
  }

  // The MCP tools' (mcp.mjs) way in: the checks the routes make (apiRoute()'s, but the Origin:
  // edge checked the client's), then the same bodies, so that a client posts the same App
  // comments and gets the same refusals. Each throws Refused, as the route would answer.
  const checks = routeChecks({
    name: "Work area",
    allowed: (repo) => repoAllowed(config, repo),
    permissions,
    named: nameOf,
    log,
  });
  async function passed(user, repo, what) {
    const checked = await checks(user, repo, WORK_ACTIONS[what] ?? null);
    if (checked.status) refuse(checked.status, checked.error);
    return checked.repo;
  }
  const mcp = {
    // `body`: …/work's ({ action, number, after?, mode?, pr? }).
    schedule: async (user, repo, body) => asks(await passed(user, repo, "work"), user, body, MCP),
    // A run by its id alone: one the user can't see, in a hidden repo or a chat of someone
    // else's, is one that doesn't exist.
    rerun: async (user, runId) => {
      const run = typeof runId === "string" ? runOf(runId) : null;
      const missing = `No run ${runId} among those you see.`;
      if (!run?.repo || (run.owner && run.owner !== user)) refuse(404, missing);
      const repo = await passed(user, run.repo, "rerun").catch((error) => {
        if (error instanceof Refused && error.status === 404) refuse(404, missing);
        throw error;
      });
      return rerunAsked(repo, user, runId, MCP);
    },
  };

  async function reviewing(req, res, user, repo) {
    const { number, action } = (await readJsonBody(req, MAX_BODY)) ?? {};
    if (!REVIEW_ACTIONS.includes(action)) refuse(400, "`action` is review or fix.");
    if (!Number.isSafeInteger(number) || number <= 0) {
      refuse(400, "`number` is a pull request number.");
    }
    log(`Work area: ${user} asks for a ${action} of ${repo}#${number}`);
    send(res, 200, { message: await reviewAgain(repo, user, number, action) });
  }

  async function dismissal(req, res, user, repo) {
    const { runId, undo } = (await readJsonBody(req, MAX_BODY)) ?? {};
    if (typeof runId !== "string" || !/^[\w.-]+$/.test(runId))
      refuse(400, "`runId` is a run's id.");
    log(`Work area: ${user} ${undo ? "undoes the dismissal of" : "dismisses"} ${repo} ${runId}`);
    send(res, 200, { message: await dismiss(repo, user, runId, undo === true) });
  }

  async function inbox(req, res, user, repo) {
    const { kind, text: sent } = (await readJsonBody(req, MAX_ANSWER_BODY)) ?? {};
    if (!Object.hasOwn(INBOXES, kind)) refuse(400, "`kind` is idea or bug.");
    // Without the App's marks: posted as the App, they would pass for its own.
    const text = typeof sent === "string" ? unmarked(sent) : null;
    if (!text?.trim()) refuse(400, "Write something to send.");
    if (text.length > MAX_TEXT) refuse(413, `The text is over ${MAX_TEXT} characters.`);
    log(`Work area: ${user} sends a ${kind} to ${repo}'s inbox`);
    send(res, 200, await sendToInbox(repo, user, { kind, text }));
  }

  // The lane of the issues `keys` (the dashboard's, connected by their waits) gets the name
  // the user typed, as anyone allowed to start them could.
  async function lane(req, res, user, repo) {
    const { keys, name: typed } = (await readJsonBody(req, MAX_BODY)) ?? {};
    const ours = (key) => {
      const parsed = typeof key === "string" && parseKey(key);
      return !!parsed && sameRepo(parsed.repo, repo) && ["issue", "pr"].includes(parsed.kind);
    };
    if (!Array.isArray(keys) || !keys.length || keys.length > 100 || !keys.every(ours)) {
      refuse(400, `\`keys\` are the task keys of issues of ${repo}.`);
    }
    const name = laneName(typed);
    if (name === null) refuse(400, `\`name\` is one line of at most ${MAX_NAME} characters.`);
    await checkedRepo(repo, user);
    lanes.name(keys, name);
    log(`Work area: ${user} names the lane of ${keys.join(", ")} ${JSON.stringify(name)}`);
    send(res, 200, { message: name ? `Lane named “${name}”.` : "Lane name taken off." });
  }

  // A queued task of the repo moves in the run order, as anyone allowed to start it could:
  // right before `before` or right after `after` (another of the repo's queued tasks), first,
  // or last (none of them). Only a task waiting for a slot, and not a brainstorm: those start
  // first whatever the order. The reply names no place: it would count other repos' tasks,
  // which the user may not see.
  async function reorder(req, res, user, repo) {
    const body = (await readJsonBody(req, MAX_BODY)) ?? {};
    const { key, before = null, after = null, first = false } = body;
    const ours = (k) => {
      const parsed = typeof k === "string" && parseKey(k);
      return !!parsed && sameRepo(parsed.repo, repo);
    };
    if (!ours(key)) refuse(400, `\`key\` is the task key of one of ${repo}'s tasks.`);
    for (const [field, value] of [
      ["before", before],
      ["after", after],
    ]) {
      if (value === null) continue;
      if (!ours(value))
        refuse(400, `\`${field}\` is null or the task key of one of ${repo}'s tasks.`);
      if (taskId(value) === taskId(key)) refuse(400, `\`${field}\` is another task than \`key\`.`);
    }
    if (typeof first !== "boolean") refuse(400, "`first` is true or false.");
    if ([before !== null, after !== null, first].filter(Boolean).length > 1) {
      refuse(400, "One of `before`, `after` and `first` at most.");
    }
    await checkedRepo(repo, user);
    const queue = queueOrder();
    const keys = queue.map((t) => taskKey(t.repo, t.id));
    const find = (k) => keys.findIndex((q) => taskId(q) === taskId(k));
    const at = find(key);
    const name = `#${parseKey(key).number}`;
    if (at < 0) refuse(409, `${name} isn't waiting for a slot: only queued tasks move.`);
    if (isApart(queue[at].pending.at(-1)?.mode)) {
      refuse(409, `${name} is a brainstorm: brainstorms start before work runs anyway.`);
    }
    const other = before ?? after;
    if (other !== null && find(other) < 0) {
      refuse(409, `#${parseKey(other).number} is no longer queued.`);
    }
    order.move(
      keys[at],
      { before: before && keys[find(before)], after: after && keys[find(after)], first },
      keys,
    );
    const where = first
      ? "first"
      : other
        ? `${before ? "before" : "after"} #${parseKey(other).number}`
        : "last";
    log(`Work area: ${user} moves ${keys[at]} ${where} in the run order`);
    send(res, 200, {
      message: `${name} moved ${where === "first" || where === "last" ? `${where} in line` : where}.`,
    });
  }

  async function analyze(req, res, user, repo) {
    const body = await readJsonBody(req, MAX_BODY);
    const selection = checkSelection(body, (message) => refuse(400, message));
    log(`Work area: ${user} analyzes ${selection.count} run(s) of ${repo}`);
    send(
      res,
      200,
      await startAnalysis({ github, checkedRepo, analysis, accept, log }, repo, user, selection),
    );
  }

  // Handles /api/repos/<owner>/<repo>/issues, /work, /answer, /rerun, /review, /dismiss, /inbox,
  // /lane, /order and /analyze; false for any other path.
  const handle = apiRoute({
    name: "Work area",
    route: (pathname) => {
      const one =
        /^\/api\/repos\/([\w.-]+)\/([\w.-]+)\/(issues|work|answer|rerun|review|dismiss|inbox|lane|order|analyze)$/.exec(
          pathname,
        );
      return one && { repo: `${one[1]}/${one[2]}`, what: one[3] };
    },
    posts: {
      work,
      answer: answers,
      rerun: reruns,
      review: reviewing,
      dismiss: dismissal,
      inbox,
      lane,
      order: reorder,
      analyze,
    },
    gets: {
      issues: async (req, res, user, repo) => send(res, 200, await backlogOf(repo, user)),
      analyze: previewAnalysis,
    },
    allowed: (repo) => repoAllowed(config, repo),
    permissions,
    action: ({ what }) => WORK_ACTIONS[what] ?? null,
    named: nameOf,
    publicUrl,
    log,
  });

  // An `issues` delivery for `repo`: its backlog is read again now, for a repo read before,
  // so that the next request gets the change; or after the read going, which started before
  // it. Until then, requests get the last read.
  function stale(repo) {
    const known = backlogs.get(repo.toLowerCase());
    if (!known) return;
    known.version++;
    if (known.last || known.read) readAgain(known);
  }

  return { handle, stale, counts, ticked, backlog: backlogOf, mcp };
}

// Which deliveries make a repo's backlog stale: an issue opened, closed, edited, moved or
// deleted. Calls stale(repo) for those and returns whether it did.
export function staleFor(event, p, stale) {
  const repo = p.repository?.full_name;
  if (event !== "issues" || !repo) return false;
  if (!["opened", "closed", "reopened", "edited", "transferred", "deleted"].includes(p.action)) {
    return false;
  }
  stale(repo);
  return true;
}
