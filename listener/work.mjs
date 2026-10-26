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
//                                         { action: "queue", number, after, mode? }
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
//   POST /api/repos/<owner>/<repo>/inbox  { kind: "idea" | "bug", text }
//                                         an entry for the repo's inbox: the App's comment on
//                                         its inbox issue, and the run a comment there starts
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
import { fromDashboard } from "./discussions.mjs";
import { inboxItem, issueItem, parseKey, prId, sameRepo, taskKey, unmarked } from "./events.mjs";
import { getJson } from "./github.mjs";
import { createInputSeeder } from "./inputs.mjs";
import { createRepoCheck } from "./repo-check.mjs";
import { leadsTo, planSummary, readTree, waitsOf } from "./plans.mjs";
import { CONFIG_FILE, modeNames } from "./repo-config.mjs";
import { issueList, waitsFor } from "./waits.mjs";
import { apiRoute, readJsonBody, refuse, send } from "./web.mjs";

// How long a repo's open issues are served before they are read again (in the background):
// the dashboard polls them.
export const ISSUES_MS = 30_000;
const MAX_BODY = 4096;
// The answers' text, and the JSON around it (escapes, indexes).
const MAX_ANSWER_BODY = 4 * MAX_TEXT;
const ACTIONS = ["start", "queue", "plan", "dequeue", "stop", "cancel"];
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
// "running", "queued" or null. `analysis`: run digests (analysis.mjs createAnalysis()).
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
  analysis = createAnalysis({ runs: () => [] }),
  publicUrl = () => null,
  // The key of the dashboard's "from" lines (discussions.mjs fromKey()), or null.
  fromKey = () => null,
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
  // with their open sub-issues (subIssues()), and the modes the dashboard offers: onboarding
  // is the listener's own, research only with its grant (access.mjs researchRefusal()).
  async function readBacklog(repo) {
    const base = await baseOf(repo);
    const { settings, errors } = await repoSettings(repo, base);
    const path = `/repos/${repo}/issues?state=open&sort=created&direction=desc&per_page=100`;
    const list = await getJson(github, repo, path);
    if (!Array.isArray(list)) throw new Error(`GitHub GET ${path}: no list`);
    if (!errors.length) await seedInputs(repo, list, settings.users);
    return {
      issues: list
        .filter((i) => !i.pull_request)
        .map((i) => ({
          number: i.number,
          title: i.title ?? null,
          url: i.html_url,
          ...subIssues(i),
        })),
      modes: errors.length ? [] : offeredModes(repo, settings),
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

  function offeredModes(repo, settings) {
    const granted = !researchRefusal(config, repo);
    return modeNames(settings).filter((m) => m !== "onboarding" && (m !== "research" || granted));
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
  // way, which the dashboard asks for again soon.
  async function backlog(res, repo, user) {
    const name = repo.toLowerCase();
    let known = backlogs.get(name);
    if (!known) {
      known = { repo, last: null, read: null, again: false, seq: 0, version: 0 };
      Object.assign(known, { live: new Set(), ended: new Map() });
      backlogs.set(name, known);
    }
    const live = ending(known, name);
    const { last } = known;
    const fresh = last && last.version === known.version && now() - last.at < ISSUES_MS;
    if (!fresh && !known.read) {
      const read = refresh(known);
      if (last) quietly(known, read);
    }
    if (!last) await known.read;
    const { issues, modes, errors, users, at, seq } = known.last;
    if (users && !users.includes(user.toLowerCase())) {
      refuse(404, `${user} is not among ${repo}'s users.`);
    }
    // The tasks change between two reads: an issue started a moment ago leaves at once. One
    // whose task is over (a run done, a brainstorm stopped) is back, once a read started after
    // it ended says it is still open.
    for (const [key, before] of known.ended) if (before < seq) known.ended.delete(key);
    const hidden = (n) => {
      const key = taskKey(name, n);
      return live.has(key) || known.ended.has(key);
    };
    send(res, 200, {
      issues: issues.filter((i) => !hidden(i.number)),
      modes,
      errors,
      readAt: at,
      refreshing: known.read !== null,
    });
  }

  // The checks a comment passes, for the signed-in `user`: the repo's config without errors,
  // the user in both the operator's and the repo's users, an open issue (a pull request when
  // `pr`) with no run going or queued. Returns { settings, base, issue }; throws Refused.
  async function checked(repo, user, number, pr = false) {
    const { settings, base } = await checkedRepo(repo, user);
    const issue = await getJson(github, repo, `/repos/${repo}/issues/${number}`, [404, 410]);
    if (!issue) refuse(404, `#${number} isn't an issue of ${repo}.`);
    if (pr && !issue.pull_request) refuse(404, `#${number} isn't a pull request of ${repo}.`);
    if (!pr && issue.pull_request) {
      refuse(422, `#${number} is a pull request: start its issue instead.`);
    }
    if (issue.state !== "open") refuse(409, `#${number} is closed.`);
    if (busy(taskKey(repo, number))) {
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
    });
  }

  const inMode = (mode) => (mode === "work" ? "" : ` in \`${mode}\` mode`);

  // `answers`: the answers to its open questions (answersComment()), sent along from the form
  // the drag opened; they go in the App's comment and are the run's text. Without them, an
  // issue with open questions doesn't move: they are answered first, unless the repo's
  // `wait_for_answers` is off.
  async function act(repo, user, { action, number, after, mode, pr }, answers = null) {
    // Whatever the issue's state: a run may go on once it is closed.
    if (action === "cancel") return cancelTask(repo, user, number, pr);
    const key = taskKey(repo, number);
    const checks = await checked(repo, user, number);
    const { settings, base, issue } = checks;
    if (action === "plan") return plan(repo, user, checks, { after, mode }, answers);
    const asks = action === "start" || action === "queue";
    if (!answers && asks && asking(settings, key)) {
      refuse(409, `#${number} has open questions: answer them first.`);
    }
    const wait = waits.get(key);
    if (action === "dequeue") return dequeue(repo, user, number, wait);
    if (action === "stop") return stop(repo, user, issue, base, settings);
    // Moving a wait keeps its mode, unless another one is picked.
    const wanted = mode ?? wait?.item.modeLine ?? "work";
    if (!modeNames(settings).includes(wanted)) refuse(422, `${repo} has no mode \`${wanted}\`.`);
    const item = itemOf(repo, issue, wanted, user, base, settings);
    if (answers) item.text = answers;
    const also = answers ? `\n\n${answers}` : "";
    if (action === "queue") {
      const queued = await queueAfter(repo, user, { item, after, mode, wanted, wait, also });
      if (queued) return queued;
      // Done already: it starts now, as "/after" would.
    }
    waits.cancel(key, `started from the dashboard by @${user}`);
    const why = action === "queue" ? `: #${after} is done already` : "";
    const was = wait && action === "start" ? ` It no longer waits for ${waitsFor(wait)}.` : "";
    item.comment = await comment(
      repo,
      number,
      `Started from the dashboard by @${user}${inMode(wanted)}${why}.${was}${also}`,
    );
    await accept(item);
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
  async function plan(repo, user, { settings, base, issue }, { after, mode }, answers) {
    const { number } = issue;
    const tree = await readTree(github, repo, issue);
    const away = tree.elsewhere.length
      ? ` Left out, in another repository: ${tree.elsewhere.join(", ")}.`
      : "";
    if (tree.nodes.size === 1) {
      const action = after === null ? "start" : "queue";
      return `${await act(repo, user, { action, number, after, mode, pr: false }, answers)}${away}`;
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
    }
    const planned = waitsOf(tree, { after, existing: blockersOf(repo) });
    // Those that wait first: the ones that start can't end before their waits are there.
    const waiting = order.filter((n) => planned.get(n).length);
    const steps = [...waiting, ...order.filter((n) => !planned.get(n).length)];
    const laid = [];
    try {
      for (const n of steps) {
        await layOut(repo, user, { number, n, tree, planned, mode, base, settings, answers });
        laid.push(n);
      }
    } catch (error) {
      // Checked, then GitHub failed halfway (an outage, a rate limit): what is done stays.
      log(`Work area: ${taskKey(repo, number)}: plan: ${error.message ?? error}`);
      const left = steps.filter((n) => !laid.includes(n));
      const done = laid.length ? `${issueList(laid)} laid out, ` : "nothing laid out, ";
      refuse(
        502,
        `GitHub failed on #${left[0]}: ${done}${issueList(left)} not. Start or queue those from the backlog.`,
      );
    }
    const skipped = tree.done.length ? ` Done already: ${issueList(tree.done)}.` : "";
    return `#${number} laid out: ${planSummary(order, planned)}.${afterDone}${skipped}${away}`;
  }

  // What a plan does for issue `n` of the tree: the App's comment, then its wait or its start.
  async function layOut(repo, user, { number, n, tree, planned, mode, base, settings, answers }) {
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
        `Queued from the dashboard by @${user}${part}, after ${issueList(blockers)}${inMode(wanted)}.${was} It starts when ${they} done (closed as completed, or merged).${also}`,
      );
      await waits.hold(item, blockers);
      return;
    }
    waits.cancel(key, `started from the dashboard by @${user} as part of #${number}`);
    item.comment = await comment(
      repo,
      n,
      `Started from the dashboard by @${user}${inMode(wanted)}${part}.${was}`,
    );
    await accept(item);
  }

  // What each issue of `repo` waits for already (waits.mjs), by number.
  const blockersOf = (repo) => (n) => waits.get(taskKey(repo, n))?.blockers ?? [];

  // What "/after #n" does: `item` waits for issue `after`, its wait (`wait`, if any) moved
  // there. Null when `after` is done already: the caller starts it.
  async function queueAfter(repo, user, { item, after, mode, wanted, wait, also }) {
    const { number } = item;
    if (after === number) refuse(422, `#${number} can't wait for itself.`);
    // Queueing it after an issue whose waits lead back to it: neither would start.
    if (leadsTo(blockersOf(repo), after, number)) {
      refuse(422, `#${after} waits for #${number}: each would wait for the other.`);
    }
    const state = await waits.stateOf(repo, after);
    if (state === "missing") refuse(422, `#${after} isn't an issue or pull request of ${repo}.`);
    if (state === "not-done") refuse(422, `#${after} was closed without being done.`);
    if (state !== "open") return null;
    if (wait?.blockers.length === 1 && wait.blockers[0] === after && !mode) {
      return `#${number} already waits for #${after}.`;
    }
    const text = wait
      ? `Moved from the dashboard by @${user}: now after #${after}${inMode(wanted)} (it waited for ${waitsFor(wait)}).`
      : `Queued from the dashboard by @${user}, after #${after}${inMode(wanted)}.`;
    item.comment = await comment(
      repo,
      number,
      `${text} It starts when #${after} is done (closed as completed, or merged).${also}`,
    );
    await waits.hold(item, [after]);
    return `#${number} waits for #${after}.`;
  }

  // Issue `number` no longer waits (`wait`): nothing starts until asked again.
  async function dequeue(repo, user, number, wait) {
    if (!wait) refuse(409, `#${number} doesn't wait for anything.`);
    waits.cancel(taskKey(repo, number), `cancelled from the dashboard by @${user}`);
    await comment(
      repo,
      number,
      `No longer waiting for ${waitsFor(wait)}: cancelled from the dashboard by @${user}. Nothing starts until a trigger comment or the dashboard says so.`,
    );
    return `#${number} no longer waits.`;
  }

  // What a "/stop" comment does: the brainstorm wraps up (task-modes.mjs stopBrainstorm()), in a
  // run that posts its summary and updates the issue. Only an active or idle one: checked()
  // refused a reply on its way.
  async function stop(repo, user, issue, base, settings) {
    const { number } = issue;
    const state = taskOf(taskKey(repo, number))?.state;
    if (state !== "brainstorm" && state !== "idle-brainstorm") {
      refuse(409, `#${number} has no brainstorm to stop.`);
    }
    const item = { ...itemOf(repo, issue, "work", user, base, settings), trigger: "stop" };
    item.comment = await comment(
      repo,
      number,
      `Brainstorm stopped from the dashboard by @${user}: a summary and the issue's update follow.`,
    );
    await accept(item);
    return `#${number}'s brainstorm wraps up.`;
  }

  // What a `/cancel` comment does (tasks.mjs cancelRun()), with the App's comment for the
  // record. The run's own reply follows once its sandbox is gone.
  async function cancelTask(repo, user, number, pr) {
    await checkedRepo(repo, user);
    const key = taskKey(repo, pr ? prId(number) : number);
    const replyTo = taskOf(key)?.replyTo ?? number;
    const what = cancel(key, user);
    if (!what) refuse(409, `Nothing is running or queued on #${number}.`);
    // Stopped already: a failed comment doesn't make it fail.
    await comment(repo, replyTo, `Stopped from the dashboard by @${user}.`).catch((error) =>
      log(`${key}: ${error.message ?? error}`),
    );
    return what === "running" ? `#${number} stops.` : `#${number}'s queued comments dropped.`;
  }

  // Answers to the open questions of the task of issue (or pull request) `number`, as one App
  // comment. A run's questions: the comment is the reply that continues its session, as an
  // allowed user's would be. An issue's (its body's section): App comments don't take the
  // label off (questions.mjs), so this does, once every question has an answer.
  async function answer(repo, user, asked) {
    const { number, pr } = asked;
    const key = taskKey(repo, pr ? prId(number) : number);
    const task = taskOf(key);
    if (task?.state !== "needs-input") refuse(409, `#${number} isn't waiting for answers.`);
    if (asked.then) return answerThen(repo, user, task, asked);
    const { settings, base, issue } = await checked(repo, user, number, pr);
    const questions = task.questions ?? null;
    const { comment: text, open } = answersComment(user, questions?.items ?? null, asked);
    // Where the run asked: a pull request's run on an issue's task replies on the pull request.
    const replyTo = task.replyTo ?? number;
    const posted = await comment(repo, replyTo, text);
    const left = open.length ? ` ${open.length} still open.` : "";
    const fromRun = questions
      ? questions.source === "run"
      : task.runs?.[0]?.status === "needs-input";
    if (fromRun) {
      await accept({
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
      });
      return `Answers sent: #${number} continues.${left}`;
    }
    if (open.length) return `Answers sent: #${number} still needs input.${left}`;
    const res = await label(repo, number, false);
    if (labelFailed(res)) throw new Error(`GitHub label of #${number}: ${res.status}`);
    inputs.set(key, false);
    return `Answers sent: #${number} no longer needs input.`;
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
  async function rerun(repo, user, runId) {
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
    const replyTo = run.replyTo ?? number;
    const ended = { error: "failed", cancelled: "was stopped" }[run.status] ?? "was interrupted";
    const posted = await comment(
      repo,
      replyTo,
      `Rerun from the dashboard by @${user}${inMode(mode)}: its last run ${ended}.`,
    );
    await accept({
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
    });
    return `Rerun of #${number} queued.`;
  }

  // An idea or a bug report for the repo's inbox, as a comment there would be: the App's
  // comment on the inbox issue (an entry, not a reply: no marker), then the run it starts,
  // queued here since bot comments never reach admit(). The run reads the entry as the user's.
  async function sendToInbox(repo, user, { kind, text }) {
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
    const body = fromDashboard(user, text, fromKey());
    const sent = await github(repo, "POST", `/repos/${repo}/issues/${number}/comments`, { body });
    if (!sent.ok) throw new Error(`GitHub POST a comment on #${number}: ${sent.status}`);
    const c = await sent.json();
    const posted = { id: c.id, html_url: c.html_url, node_id: c.node_id };
    await accept({
      ...inboxItem(repo, issue, kind, posted, { login: user }, text),
      author: user,
      base,
      settings,
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
    send(res, 200, { ...analysis.preview(repo, selection), max: MAX_RUNS });
  }

  async function answers(req, res, user, repo) {
    const asked = parseAnswers(await readJsonBody(req, MAX_ANSWER_BODY));
    log(
      `Work area: ${user} answers ${taskKey(repo, asked.pr ? prId(asked.number) : asked.number)}`,
    );
    send(res, 200, { message: await answer(repo, user, asked) });
  }

  async function work(req, res, user, repo) {
    const asked = checkAction(await readJsonBody(req, MAX_BODY));
    log(
      `Work area: ${user} asks ${asked.action} ${taskKey(repo, asked.number)}${asked.after ? ` after #${asked.after}` : ""}`,
    );
    const message = await act(repo, user, asked);
    send(res, 200, { message });
  }

  async function reruns(req, res, user, repo) {
    const runId = (await readJsonBody(req, MAX_BODY))?.runId;
    if (typeof runId !== "string" || !/^[\w.-]+$/.test(runId))
      refuse(400, "`runId` is a run's id.");
    log(`Work area: ${user} reruns ${repo} ${runId}`);
    send(res, 200, { message: await rerun(repo, user, runId) });
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

  // Handles /api/repos/<owner>/<repo>/issues, /work, /answer, /rerun, /inbox and /analyze;
  // false for any other path.
  const handle = apiRoute({
    name: "Work area",
    route: (pathname) => {
      const one =
        /^\/api\/repos\/([\w.-]+)\/([\w.-]+)\/(issues|work|answer|rerun|inbox|analyze)$/.exec(
          pathname,
        );
      return one && { repo: `${one[1]}/${one[2]}`, what: one[3] };
    },
    posts: { work, answer: answers, rerun: reruns, inbox, analyze },
    gets: {
      issues: (req, res, user, repo) => backlog(res, repo, user),
      analyze: previewAnalysis,
    },
    allowed: (repo) => repoAllowed(config, repo),
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

  return { handle, stale };
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
