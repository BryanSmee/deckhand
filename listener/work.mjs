// The graph's work area (the dashboard's Graph page): a repo's backlog, its open issues with
// nothing live (board.mjs isLive()), and what dragging one does: start it, queue it after
// another issue ("/after #n"), move its wait or cancel it, or stop its brainstorm ("/stop").
// Each action is what a comment would do, checked as a comment that waited is (tasks.mjs
// resume()), and written on the issue as the App's comment: bot comments never reach admit(),
// so the listener queues or holds the work itself.
//
//   GET  /api/repos/<owner>/<repo>/issues the backlog and the repo's modes (GitHub asked at
//                                         most once per ISSUES_MS)
//   POST /api/repos/<owner>/<repo>/work   { action: "start", number, mode? }
//                                         { action: "queue", number, after, mode? }
//                                         { action: "dequeue", number }
//                                         { action: "stop", number }: a brainstorm's wrap-up
//   POST /api/repos/<owner>/<repo>/answer { number, pr?, answers: [{ options: [i], text }] }
//                                         { number, pr?, text }
//                                         answers to a task's open questions (answers.mjs);
//                                         with `then: { action, after?, mode? }`, all of
//                                         them, and the issue starts or queues with them
//   POST /api/repos/<owner>/<repo>/rerun  { runId }
//                                         the task's last run, failed or interrupted, again:
//                                         its mode and comments (board.mjs rerunnable())
import { MAX_TEXT, Refused, answersComment, parseAnswers, refuse } from "./answers.mjs";
import { parseQuestions, questionsSection } from "./questions.mjs";
import { issueList } from "./waits.mjs";
import { CONFIG_FILE, modeNames } from "./repo-config.mjs";
import { sameOrigin } from "./repos.mjs";
import { readBody, sendJson } from "./web.mjs";

// How long a repo's open issues are kept: the dashboard polls them.
export const ISSUES_MS = 30_000;
const MAX_BODY = 4096;
// The answers' text, and the JSON around it (escapes, indexes).
const MAX_ANSWER_BODY = 4 * MAX_TEXT;
const ACTIONS = ["start", "queue", "dequeue", "stop"];

const send = (res, status, value) => sendJson(res, value, status);

// The action asked for, checked: { action, number, after, mode }. Throws Refused.
export function parseAction(text) {
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    refuse(400, "Not JSON.");
  }
  return checkAction(body);
}

// An action's fields, checked (a body's, or answers' `then`). Throws Refused.
export function checkAction(body) {
  const { action, number, after = null, mode = null } = body ?? {};
  const issue = (n) => Number.isSafeInteger(n) && n > 0;
  if (!ACTIONS.includes(action)) refuse(400, `The action is one of ${ACTIONS.join(", ")}.`);
  if (!issue(number)) refuse(400, "`number` is an issue number.");
  if (action === "queue" && !issue(after)) refuse(400, "`after` is an issue number.");
  if (mode !== null && (typeof mode !== "string" || !/^[\w-]+$/.test(mode))) {
    refuse(400, "`mode` is a mode's name.");
  }
  return { action, number, after: action === "queue" ? after : null, mode };
}

// Whether the wait of `from` leads, from one blocker to the next, to issue `to`: queueing `to`
// after `from` would then make each wait for the other, and neither would start.
export function leadsTo(get, repo, from, to) {
  const seen = new Set();
  const stack = [from];
  while (stack.length) {
    const n = stack.pop();
    if (n === to) return true;
    if (seen.has(n)) continue;
    seen.add(n);
    stack.push(...(get(`${repo}#${n}`)?.blockers ?? []));
  }
  return false;
}

// `github(repo, method, path, body, expected)`: the App's calls. `repoSettings(repo, base)`:
// the default branch's config. `reply(repo, number, text)`: the App's comment (comments.mjs).
// `waits` (waits.mjs), `accept(item)` (tasks.mjs). `boardKeys()`: the keys of the tasks on the
// dashboard; `liveKeys()`: those with something live, which the backlog leaves out;
// `busy(key)`: a run going or queued, which can't be moved.
// `taskOf(key)`: the dashboard's task (board.mjs, with its `questions`), or null.
// `label(repo, number, on)`: the needs-input label; `inputs` (inputs.mjs), which the backlog
// also fills (seedInputs()).
// `runOf(id)`: a run's record (runs.mjs, with the comments it ran on), or null.
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
  publicUrl = () => null,
  now = Date.now,
  log = () => {},
}) {
  // "owner/repo" → { at, read: Promise<{ issues, modes, errors }> }
  const backlogs = new Map();
  // Issues with open questions whose label was taken off once: answered, or removed by hand.
  const unlabelled = new Set();

  const allowed = (repo) => !config.repos.length || config.repos.includes(repo.toLowerCase());

  // The repo's default branch, or a 404 when the App can't read it.
  async function baseOf(repo) {
    const res = await github(repo, "GET", `/repos/${repo}`, undefined, [404]);
    if (res.status === 404) refuse(404, `The App is not installed on ${repo}.`);
    if (!res.ok) throw new Error(`GitHub GET /repos/${repo}: ${res.status}`);
    return (await res.json()).default_branch || "main";
  }

  // The repo's open issues, newest first (pull requests are issues to this API: left out), and
  // the modes the dashboard offers: onboarding is the listener's own.
  async function readBacklog(repo) {
    const base = await baseOf(repo);
    const { settings, errors } = await repoSettings(repo, base);
    const res = await github(
      repo,
      "GET",
      `/repos/${repo}/issues?state=open&sort=created&direction=desc&per_page=100`,
    );
    const list = res.ok ? await res.json() : null;
    if (!Array.isArray(list)) throw new Error(`GitHub GET issues of ${repo}: ${res.status}`);
    if (!errors.length) await seedInputs(repo, list, settings.users);
    return {
      issues: list
        .filter((i) => !i.pull_request)
        .map((i) => ({ number: i.number, title: i.title ?? null, url: i.html_url })),
      modes: errors.length ? [] : modeNames(settings).filter((m) => m !== "onboarding"),
      errors: errors.length > 0,
      // Who may see it, as for the dashboard's tasks: unknown while the config has errors.
      users: errors.length ? null : settings.users,
    };
  }

  // Open questions in an issue's body that the needs-input label never came for: without the
  // `issues` event, or when the label call failed, only the label's listing (inputs.mjs) knew
  // of them, so the graph's form didn't open and a start went through unanswered. Listed and
  // labelled here, as an `issues opened` delivery would have, unless the label was taken off
  // once (its timeline says): its questions were answered, or someone said they don't hold.
  // An issue on the board had a run, whose start takes the label off: left alone too.
  async function seedInputs(repo, list, users) {
    const name = config.needsInputLabel;
    if (!name) return;
    const keys = boardKeys();
    const author = (u) =>
      u?.type === "Bot"
        ? !!config.bot && u.login?.toLowerCase() === config.bot.toLowerCase()
        : !!u?.login &&
          config.users.includes(u.login.toLowerCase()) &&
          users.includes(u.login.toLowerCase());
    for (const issue of list) {
      const key = `${repo}#${issue.number}`;
      if (issue.pull_request || inputs.has(key) || keys.has(key) || unlabelled.has(key)) continue;
      // Fail closed, as questions.mjs: only an allowed user's issue, or the App's own.
      if (!author(issue.user)) continue;
      const questions = parseQuestions(questionsSection(issue.body));
      if (!questions) continue;
      try {
        const labelled = (issue.labels ?? []).some(
          (l) => (typeof l === "string" ? l : l?.name)?.toLowerCase() === name.toLowerCase(),
        );
        if (!labelled) {
          if (await wasUnlabelled(repo, issue.number, name)) {
            unlabelled.add(key);
            continue;
          }
          const res = await label(repo, issue.number, true);
          if (!res.ok) log(`${key}: label: ${res.status}`);
        }
        log(`${key}: open questions found in the backlog`);
        inputs.set(key, true, questions);
      } catch (error) {
        // The next read tries again.
        log(`${key}: open questions: ${error.message ?? error}`);
      }
    }
  }

  // Whether the label was ever taken off issue `number`.
  async function wasUnlabelled(repo, number, name) {
    for (let page = 1; ; page++) {
      const res = await github(
        repo,
        "GET",
        `/repos/${repo}/issues/${number}/events?per_page=100&page=${page}`,
      );
      const events = res.ok ? await res.json() : null;
      if (!Array.isArray(events)) throw new Error(`GitHub GET events of #${number}: ${res.status}`);
      if (
        events.some(
          (e) => e.event === "unlabeled" && e.label?.name?.toLowerCase() === name.toLowerCase(),
        )
      ) {
        return true;
      }
      if (events.length < 100) return false;
    }
  }

  async function backlog(res, repo, user) {
    let known = backlogs.get(repo.toLowerCase());
    if (!known || now() - known.at >= ISSUES_MS) {
      known = { at: now(), read: readBacklog(repo) };
      backlogs.set(repo.toLowerCase(), known);
      // A failure is not kept: the next poll asks again.
      known.read.catch(
        () => backlogs.get(repo.toLowerCase()) === known && backlogs.delete(repo.toLowerCase()),
      );
    }
    const { issues, modes, errors, users } = await known.read;
    if (users && !users.includes(user.toLowerCase())) {
      refuse(404, `${user} is not among ${repo}'s users.`);
    }
    // The tasks change between two reads: an issue started a moment ago leaves at once. One
    // whose task is over (a run done, a brainstorm stopped) is back.
    const keys = liveKeys();
    send(res, 200, {
      issues: issues.filter((i) => !keys.has(`${repo}#${i.number}`)),
      modes,
      errors,
      readAt: known.at,
    });
  }

  // The checks a comment passes, for the signed-in `user`: the repo's config without errors,
  // the user in both the operator's and the repo's users, an open issue (a pull request when
  // `pr`) with no run going or queued. Returns { settings, base, issue }; throws Refused.
  async function checked(repo, user, number, pr = false) {
    const login = user.toLowerCase();
    if (!config.users.includes(login)) refuse(403, `${user} is not in ALLOWED_USERS.`);
    const base = await baseOf(repo);
    const { settings, errors } = await repoSettings(repo, base);
    if (errors.length) {
      refuse(
        409,
        `${CONFIG_FILE} of ${repo} has errors: no run starts there until they are fixed.`,
      );
    }
    if (!settings.users.includes(login)) refuse(403, `${user} is not among ${repo}'s users.`);
    const res = await github(repo, "GET", `/repos/${repo}/issues/${number}`, undefined, [404, 410]);
    if (res.status === 404 || res.status === 410)
      refuse(404, `#${number} isn't an issue of ${repo}.`);
    if (!res.ok) throw new Error(`GitHub GET #${number}: ${res.status}`);
    const issue = await res.json();
    if (pr && !issue.pull_request) refuse(404, `#${number} isn't a pull request of ${repo}.`);
    if (!pr && issue.pull_request) {
      refuse(422, `#${number} is a pull request: start its issue instead.`);
    }
    if (issue.state !== "open") refuse(409, `#${number} is closed.`);
    if (busy(`${repo}#${number}`)) {
      refuse(409, `#${number} is running or queued: it can't be moved now.`);
    }
    return { settings, base, issue };
  }

  // The App's comment on the issue: the record of who did what, and where the run's reactions
  // go, as on the comment it stands for.
  async function comment(repo, number, text) {
    const res = await reply(repo, number, text);
    if (!res.ok) throw new Error(`GitHub POST a comment on #${number}: ${res.status}`);
    const c = await res.json();
    return { id: c.id, html_url: c.html_url, node_id: c.node_id };
  }

  // What a trigger comment ("Deckhand", with "/mode <name>" unless it is work) would queue.
  function itemOf(repo, issue, mode, user, base, settings) {
    return {
      repo,
      id: String(issue.number),
      kind: "issue",
      number: issue.number,
      title: issue.title ?? null,
      trigger: "work",
      modeLine: mode === "work" ? null : mode,
      text: "",
      replyTo: issue.number,
      author: user,
      base,
      settings,
    };
  }

  const inMode = (mode) => (mode === "work" ? "" : ` in \`${mode}\` mode`);

  // `answers`: the answers to its open questions (answersComment()), sent along from the form
  // the drag opened; they go in the App's comment and are the run's text. Without them, an
  // issue with open questions doesn't move: they are answered first.
  async function act(repo, user, { action, number, after, mode }, answers = null) {
    const key = `${repo}#${number}`;
    const asking = taskOf(key);
    const asks = action === "start" || action === "queue";
    if (!answers && asks && asking?.state === "needs-input" && asking.questions) {
      refuse(409, `#${number} has open questions: answer them first.`);
    }
    const { settings, base, issue } = await checked(repo, user, number);
    const wait = waits.get(key);
    const also = answers ? `\n\n${answers}` : "";
    if (action === "dequeue") {
      if (!wait) refuse(409, `#${number} doesn't wait for anything.`);
      waits.cancel(key, `cancelled from the dashboard by @${user}`);
      await comment(
        repo,
        number,
        `No longer waiting for ${issueList(wait.blockers)}: cancelled from the dashboard by @${user}. Nothing starts until a trigger comment or the dashboard says so.`,
      );
      return `#${number} no longer waits.`;
    }
    if (action === "stop") return stop(repo, user, issue, base, settings);
    // Moving a wait keeps its mode, unless another one is picked.
    const wanted = mode ?? wait?.item.modeLine ?? "work";
    if (!modeNames(settings).includes(wanted)) refuse(422, `${repo} has no mode \`${wanted}\`.`);
    const item = itemOf(repo, issue, wanted, user, base, settings);
    if (answers) item.text = answers;
    if (action === "queue") {
      if (after === number) refuse(422, `#${number} can't wait for itself.`);
      if (leadsTo(waits.get, repo, after, number)) {
        refuse(422, `#${after} waits for #${number}: each would wait for the other.`);
      }
      const state = await waits.stateOf(repo, after);
      if (state === "missing") refuse(422, `#${after} isn't an issue or pull request of ${repo}.`);
      if (state === "not-done") refuse(422, `#${after} was closed without being done.`);
      if (state === "open") {
        if (wait?.blockers.length === 1 && wait.blockers[0] === after && !mode) {
          return `#${number} already waits for #${after}.`;
        }
        const text = wait
          ? `Moved from the dashboard by @${user}: now after #${after}${inMode(wanted)} (it waited for ${issueList(wait.blockers)}).`
          : `Queued from the dashboard by @${user}, after #${after}${inMode(wanted)}.`;
        item.comment = await comment(
          repo,
          number,
          `${text} It starts when #${after} is done (closed as completed, or merged).${also}`,
        );
        await waits.hold(item, [after]);
        return `#${number} waits for #${after}.`;
      }
      // Done already: it starts now, as "/after" would.
    }
    waits.cancel(key, `started from the dashboard by @${user}`);
    const why = action === "queue" ? `: #${after} is done already` : "";
    const was =
      wait && action === "start" ? ` It no longer waits for ${issueList(wait.blockers)}.` : "";
    item.comment = await comment(
      repo,
      number,
      `Started from the dashboard by @${user}${inMode(wanted)}${why}.${was}${also}`,
    );
    await accept(item);
    return `#${number} started.`;
  }

  // What a "/stop" comment does: the brainstorm wraps up (tasks.mjs stopBrainstorm()), in a
  // run that posts its summary and updates the issue. Only an active or idle one: checked()
  // refused a reply on its way.
  async function stop(repo, user, issue, base, settings) {
    const { number } = issue;
    const state = taskOf(`${repo}#${number}`)?.state;
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

  // Answers to the open questions of the task of issue (or pull request) `number`, as one App
  // comment. A run's questions: the comment is the reply that continues its session, as an
  // allowed user's would be. An issue's (its body's section): App comments don't take the
  // label off (questions.mjs), so this does, once every question has an answer.
  async function answer(repo, user, asked) {
    const { number, pr } = asked;
    const key = `${repo}#${pr ? `pr-${number}` : number}`;
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
        id: pr ? `pr-${number}` : String(number),
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
    if (!res.ok && res.status !== 404) throw new Error(`GitHub label of #${number}: ${res.status}`);
    inputs.set(key, false);
    return `Answers sent: #${number} no longer needs input.`;
  }

  // Answers sent from the form a drag on the graph opened, and that drag's action (`then`):
  // every question answered, then the issue starts or queues with them in one App comment.
  // Answered, it no longer waits for input, whoever asked.
  async function answerThen(repo, user, task, asked) {
    const then = checkAction({ ...asked.then, number: asked.number });
    if (asked.pr || then.action === "dequeue" || then.action === "stop") {
      refuse(422, "Only an issue starts or queues once its questions are answered.");
    }
    const { comment: text, open } = answersComment(user, task.questions?.items ?? null, asked);
    if (open.length) refuse(400, "Answer every question before it starts.");
    const message = await act(repo, user, then, text);
    const res = await label(repo, asked.number, false);
    if (!res.ok && res.status !== 404) {
      throw new Error(`GitHub label of #${asked.number}: ${res.status}`);
    }
    inputs.set(task.key, false);
    return `Answers sent: ${message}`;
  }

  // The task's last run again, when it failed or the listener lost it: checked as a comment
  // is, then queued as its comments were, in its mode, with the App's comment for its
  // reactions. The issue's session volume carries what the run had done.
  async function rerun(repo, user, runId) {
    const run = runOf(runId);
    if (run?.repo?.toLowerCase() !== repo.toLowerCase()) refuse(404, `No run ${runId} in ${repo}.`);
    const id = run.key.slice(run.key.lastIndexOf("#") + 1);
    const pr = id.startsWith("pr-");
    const number = Number(pr ? id.slice(3) : id);
    if (!/^(pr-)?\d+$/.test(id)) refuse(409, "Only work on an issue or pull request runs again.");
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
    const ended = run.status === "error" ? "failed" : "was interrupted";
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

  // The request's body; one over `limit` bytes is refused as it is.
  async function bodyOf(req, limit) {
    try {
      return (await readBody(req, limit)).toString("utf8");
    } catch (error) {
      if (/^body over/.test(error.message)) refuse(413, `The request is over ${limit} bytes.`);
      throw error;
    }
  }

  async function answers(req, res, user, repo) {
    const asked = parseAnswers(await bodyOf(req, MAX_ANSWER_BODY));
    log(`Work area: ${user} answers ${repo}#${asked.pr ? "pr-" : ""}${asked.number}`);
    send(res, 200, { message: await answer(repo, user, asked) });
  }

  async function work(req, res, user, repo) {
    const asked = parseAction(await bodyOf(req, MAX_BODY));
    log(
      `Work area: ${user} asks ${asked.action} ${repo}#${asked.number}${asked.after ? ` after #${asked.after}` : ""}`,
    );
    const message = await act(repo, user, asked);
    send(res, 200, { message });
  }

  async function reruns(req, res, user, repo) {
    let body;
    try {
      body = JSON.parse(await bodyOf(req, MAX_BODY));
    } catch (error) {
      if (error instanceof Refused) throw error;
      refuse(400, "Not JSON.");
    }
    const runId = body?.runId;
    if (typeof runId !== "string" || !/^[\w.-]+$/.test(runId))
      refuse(400, "`runId` is a run's id.");
    log(`Work area: ${user} reruns ${repo} ${runId}`);
    send(res, 200, { message: await rerun(repo, user, runId) });
  }

  const POSTS = { work, answer: answers, rerun: reruns };

  // Handles /api/repos/<owner>/<repo>/issues, /work, /answer and /rerun; false for any other
  // path.
  function handle(req, res, user) {
    const { pathname } = new URL(req.url, "http://localhost");
    const one = /^\/api\/repos\/([\w.-]+)\/([\w.-]+)\/(issues|work|answer|rerun)$/.exec(pathname);
    if (!one) return false;
    const repo = `${one[1]}/${one[2]}`;
    const post = one[3] !== "issues";
    const run = async () => {
      if (post && req.method !== "POST") return send(res, 405, { error: "POST only." });
      if (!post && req.method !== "GET") return send(res, 405, { error: "GET only." });
      if (!user) return send(res, 401, { error: "Sign in first." });
      if (!allowed(repo)) return send(res, 404, { error: `${repo} is not in ALLOWED_REPOS.` });
      if (!post) return backlog(res, repo, user);
      if (!sameOrigin(req, publicUrl())) {
        log(`Work area: refused for ${user}: Origin ${req.headers.origin ?? "missing"}`);
        return send(res, 403, { error: "Not from this dashboard." });
      }
      return POSTS[one[3]](req, res, user, repo);
    };
    run().catch((error) => {
      if (error instanceof Refused) {
        log(`Work area: ${repo}: refused for ${user}: ${error.message}`);
        if (!res.headersSent) send(res, error.status, { error: error.message });
        return;
      }
      log(`Work area: ${error.stack ?? error}`);
      if (!res.headersSent) {
        send(res, 502, { error: "GitHub didn't answer: see the listener's logs." });
      }
    });
    return true;
  }

  return { handle };
}
