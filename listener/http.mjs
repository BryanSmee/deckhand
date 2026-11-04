// The orchestrator's HTTP (#506): what edge passes on to it (edge/forward.mjs), on its services
// port under /edge/: the dashboard's API and /status, each with the user
// edge signed in; and the verified deliveries edge puts on its stream (deliver()). The public
// server (webhooks, /setup, sign-in, the dashboard's files) is edge's (../edge/http.mjs); the
// egress policy, which the egress proxy asks, is egress-http.mjs.
import { board, isLive, runPlaces, STATES } from "./board.mjs";
import {
  ciDelivery,
  closedItem,
  parseKey,
  prId,
  pullRequest,
  REFUSED,
  replayedIssue,
  replayedPull,
  taskKey,
  touchedItems,
  workItem,
} from "./events.mjs";
import { fetchPull, getJson } from "./github.mjs";
import { QUIET_EVENTS } from "./github-app.mjs";
import { deliveryResult, operatorRefuses } from "./metrics.mjs";
import { isApart, kindOf } from "./modes.mjs";
import { onboardingTargets } from "./onboarding.mjs";
import { LOOP_STEPS } from "./reviews.mjs";
import { applyInput, inputEvent } from "./questions.mjs";
import { refreshFor } from "./repos.mjs";
import { labelAdded } from "./auto-pickup.mjs";
import { pickedTask } from "./tasks.mjs";
import { staleFor } from "./work.mjs";
import { publicRun, stream } from "./runlog.mjs";
import { endPicks } from "./picks.mjs";
import { closedAs } from "./titles.mjs";
import { send, sendJson } from "../lib/http.mjs";
import { apiRoute, needs, undecided } from "./web.mjs";
import { refusal } from "./permissions.mjs";

// The action that shows a repo's tasks (permissions.mjs).
const TASKS = "tasks:read";
// What the dashboard calls an issue of a repo the user doesn't see.
const HIDDEN = "a hidden issue";

// The dashboard's Sync asks GitHub at most this often: each one lists the App's deliveries.
const SYNC_MS = 30_000;

// The graph's arrows, blocker → waiting task, for the waits of the tasks `shown`, and the keys
// of the blockers that aren't shown. A wait names numbers: a pull request on the board is
// "#pr-n", anything else "#n" (pull requests are issues to GitHub's API).
export function waitEdges(shown, waits) {
  const keys = new Set(shown.map((t) => t.key));
  const edges = [];
  const blockers = new Set();
  for (const w of waits) {
    if (!keys.has(w.key)) continue;
    for (const n of w.blockers) {
      const pr = taskKey(w.repo, prId(n));
      const from = keys.has(pr) ? pr : taskKey(w.repo, n);
      edges.push({ from, to: w.key, kind: "after" });
      if (!keys.has(from)) blockers.add(from);
    }
  }
  return { edges, blockers: [...blockers] };
}

// The queued items' fix loop step, for board(): { reason, others }, `reason` the last loop
// item's ("review", "review-fix", "ci-fix") or null, `others` whether any other item waits.
export function loopStep(pending) {
  const steps = pending.filter((i) => LOOP_STEPS.includes(i.reason));
  return { reason: steps.at(-1)?.reason ?? null, others: steps.length < pending.length };
}

// The `issues` actions a redelivery replays as the issue is now (replayIssue()).
const ISSUE_REPLAYS = ["labeled", "unlabeled", "closed", "reopened"];

// `ctx` (../orchestrator/server.mjs): the orchestrator's state and services, read at call time.
export function createHttp(ctx) {
  const { config, log, tasks } = ctx;

  // The delivery being dispatched, for its metric (metrics.mjs deliveryResult()): whether the
  // operator's checks refused it (its installation and repository, operatorRefuses(); its
  // author, their skip()'s REFUSED, events.mjs), whether it made a work item, whether CI
  // changed. Set and cleared by deliver() in one synchronous turn, which the skip() below relies
  // on: no `await` in between. A redelivery's own dispatch comes later, uncounted.
  let verdict = null;
  const skip = (reason, how) => {
    if (how === REFUSED && verdict) verdict.refused = true;
    return ctx.skip(reason);
  };

  // Comments on their way to the queue: an orchestrator that stops saves them too.
  const admitting = new Set();

  // Without permissions (some tests): whether `user` may see a repo's tasks and logs, the repo's
  // own `users`, where the orchestrator knows them (ctx.usersOf()), narrowing ALLOWED_USERS.
  function sees(user, repo) {
    if (!repo) return false;
    const users = ctx.usersOf(repo);
    return !users || users.includes(user);
  }

  // Which of `repos` (names) `user` may do `action` on (permissions.mjs which(): the access
  // decision, the repos' `users` narrowing it) → a predicate on a repo's name. Tool output in the
  // logs may hold the repo's secrets; a repo with no action is hidden altogether.
  async function seeing(user, repos, action = TASKS) {
    if (!ctx.permissions) return (repo) => sees(user, repo);
    const seen = await ctx.permissions.which(user, repos, action);
    return (repo) => !!repo && seen.has(repo.toLowerCase());
  }

  // Whether `user` may do server-wide `action` (Settings › Server, health, plans, Sync).
  const serverWide = async (user, action) =>
    !ctx.permissions || (await ctx.permissions.can(user, null, action));

  const repoOf = (key) => parseKey(key)?.repo ?? null;

  // Every repo the dashboard's state may name: its runs, tasks, brainstorms, waits (their
  // blockers are of the same repo), open questions and inboxes.
  function namedRepos() {
    const repos = new Set();
    const add = (x) => {
      const repo = x?.repo ?? (typeof x?.key === "string" ? repoOf(x.key) : null);
      if (repo) repos.add(repo);
    };
    for (const list of [ctx.runs, [...tasks.values()], ctx.brainstorms.list(), ctx.waits.list()]) {
      list.forEach(add);
    }
    if (config.needsInputLabel) ctx.inputs.list().forEach(add);
    for (const [repo] of ctx.inboxes?.() ?? []) repos.add(repo);
    return [...repos];
  }

  // The dashboard's tasks: each issue and pull request with its state (board.mjs). `shows(repo)`:
  // only the repos it says (a signed-in user's: seeing()); all of them without one.
  function shownTasks(shows = null) {
    const mine = (list) => (shows ? list.filter((x) => shows(repoOf(x.key))) : list);
    const places = runPlaces(ctx.queueOrder?.() ?? [], (repo) => !shows || shows(repo));
    // A running task's comments are queued only when they wait for a follow-up run: the others
    // are on their way to the live session.
    const queued = [...tasks.values()]
      .filter((t) => t.pending.length > (t.running ? ctx.deliverable(t) : 0))
      .filter((t) => !shows || shows(t.repo))
      .map((t) => ({
        key: taskKey(t.repo, t.id),
        kind: kindOf(t.pending.at(-1).mode, t.kind),
        mode: t.pending.at(-1).mode,
        repo: t.repo,
        replyTo: t.pending.at(-1).replyTo,
        // A fix loop's step among them ("review", "review-fix", "ci-fix", the last one's), and whether
        // anything else waits too (a maintainer's comment): then the task is queued, not in
        // review (board.mjs).
        ...loopStep(t.pending),
        position: places.get(taskKey(t.repo, t.id)) ?? null,
        // A brainstorm, or another mode whose runs are apart from work's (modes.mjs `volumes`):
        // before any work run, whatever the order.
        ...(isApart(t.pending.at(-1).mode) && { startsFirst: true }),
        // A comment of its that starts a run can wait for another issue instead (runs.mjs
        // queuedTask(): the dashboard's Queue after…); not when it only replies to its last run.
        ...(ctx.queuedTask?.(taskKey(t.repo, t.id))?.item && { canWait: true }),
        // Picked from its auto-pickup label (auto-pickup.mjs), for one of the reserved slots.
        ...(!t.running && pickedTask(t) && { autoPickup: true }),
      }));
    const shown = board({
      runs: mine(ctx.runs),
      queued,
      brainstorms: mine(ctx.brainstorms.list()),
      waits: mine(ctx.waits.list()),
      // Stored before the label was turned off: not listed.
      inputs: config.needsInputLabel ? mine(ctx.inputs.list()) : [],
      dismissals: ctx.dismissals?.list() ?? [],
      pr: (key) => ctx.pulls.get(key),
      decisions: (key) => ctx.decisions?.get(key) ?? [],
      reviewed: (repo, number) => ctx.reviews?.entry(repo, number) ?? null,
    }).slice(0, 200);
    return { shown, queued };
  }

  // What the dashboard shows `user`: the repos they have `tasks:read` on, the totals of all.
  async function state(user) {
    const shows = await seeing(user, namedRepos());
    const { shown, queued } = shownTasks(shows);
    // A wait's blockers are of its own repo (waits.mjs): those of the tasks `user` sees are in a
    // repo they see too.
    const { edges, blockers } = waitEdges(shown, ctx.waits.list());
    const keys = [...shown.map((t) => t.key), ...blockers];
    // A lane named after a parent issue of another repo: in one `user` doesn't see, "a hidden
    // issue", its title never read for them.
    const parentOf = (key) => ctx.lanes?.parentKeys([key])[0] ?? null;
    const parents = keys.map(parentOf).filter(Boolean);
    const parentShows = await seeing(user, parents.map(repoOf));
    const hiddenParent = (key) => !!parentOf(key) && !parentShows(repoOf(parentOf(key)));
    const lanes =
      ctx.lanes?.labels(keys, { title: ctx.titles.get, inboxes: ctx.inboxes?.() ?? [] }) ?? {};
    for (const [key, lane] of Object.entries(lanes)) {
      if (lane.source === "parent" && hiddenParent(key)) lanes[key] = { ...lane, name: HIDDEN };
    }
    // How much of each plan the runs used: server-wide.
    const plans = (await serverWide(user, "server:read")) ? (ctx.models?.plans?.() ?? []) : [];
    // Titles and parents the orchestrator doesn't have yet show on a later poll; a lane's parent's
    // title names it.
    if (ctx.app) {
      ctx.lanes?.fill(keys);
      ctx.titles.fill([...keys, ...parents.filter((key) => parentShows(repoOf(key)))]);
      ctx.pulls.fill(shown.map((t) => t.key));
    }
    // `now`: the dashboard compares run start times with the server clock, not its own.
    return {
      user,
      tasks: shown.map((t) => ({
        ...t,
        title: ctx.titles.get(t.key),
        closed: ctx.titles.closed(t.key),
        pr: ctx.pulls.get(t.key),
        // Its pull request's last policy decisions (decisions.mjs), newest first.
        ...(ctx.decisions?.get(t.key).length && { decisions: ctx.decisions.get(t.key) }),
        // Its last `/mode policy` dry run.
        ...(ctx.decisions?.dryRun(t.key) && { dryRun: ctx.decisions.dryRun(t.key) }),
        // Closed: the orchestrator would refuse it.
        rerunnable: t.rerunnable && !ctx.titles.closed(t.key),
        // Off: Start and Queue don't open its open questions first (work.mjs act()).
        ...(t.questions && { waitForAnswers: ctx.waitsForAnswers?.(t.repo) ?? true }),
        runs: t.runs.map(publicRun),
      })),
      // The graph's arrows, and the issues they come from that aren't on the board.
      edges,
      blockers: blockers.map((key) => ({
        key,
        repo: parseKey(key)?.repo ?? null,
        number: parseKey(key)?.number ?? null,
        title: ctx.titles.get(key),
        closed: ctx.titles.closed(key),
      })),
      // The names the lanes of these issues can have (lanes.mjs), by key.
      lanes,
      states: STATES,
      running: ctx.running,
      queued: queued.length,
      maxParallel: config.maxParallel,
      // AUTO_PICKUP_SLOTS, within maxParallel, how many auto-picked runs hold them now, and how
      // many slots the picks hold (tasks.mjs pickedCount()): those running, queued, asking or
      // between two loop steps, what the sweep counts; absent while it is off.
      ...(config.autoPickupSlots && {
        autoPickup: {
          slots: config.autoPickupSlots,
          running: [...tasks.values()].filter((t) => t.running && pickedTask(t)).length,
          taken: ctx.pickedCount?.() ?? 0,
        },
      }),
      // Each repo read so far: its inbox issues and discussions category (New request).
      inboxes: Object.fromEntries((ctx.inboxes?.() ?? []).filter(([repo]) => shows(repo))),
      // GitHub Enterprise: the dashboard's links go where the orchestrator's do.
      githubUrl: config.githubUrl,
      // Which Deckhand runs and since when (status.mjs serverInfo()): the Repositories page.
      server: ctx.server,
      // How much of each plan the runs used (models-service.mjs plans()): only with a plan's
      // credential set, and only its numbers and times.
      ...(plans.length && { plans }),
      // The last catch-up with GitHub, at start or from a Sync (sync.mjs); null before one.
      lastSync: ctx.lastSync?.() ?? null,
      now: Date.now(),
    };
  }

  // The dashboard's API that edge passes on (GET), for its signed-in `user`.
  async function serveDashboard(req, res, user) {
    const url = new URL(req.url, "http://localhost");
    if (!ctx.app) return res.writeHead(503).end();
    if (!user) return res.writeHead(401).end();
    res.setHeader("cache-control", "no-store");
    if (url.pathname === "/api/state") return sendJson(res, await state(user));
    // Settings › Server and the services' health: server-wide. A decision that failed says so
    // (a 503), as apiRoute() does; the plans in api/state are just left out then.
    if (url.pathname === "/api/server" || (url.pathname === "/api/health" && ctx.health)) {
      const said = ctx.permissions
        ? await ctx.permissions.decide(user, null, "server:read")
        : { ok: true, error: null };
      if (!said.ok) {
        log(`${url.pathname}: refused: ${refusal(said, user, "server:read")}`);
        if (said.error) return sendJson(res, undecided("server:read"), 503);
        return sendJson(res, needs("server:read", null), 403);
      }
    }
    // Read when Settings › Server opens, not at each poll: it scans the grants folder.
    if (url.pathname === "/api/server") return sendJson(res, ctx.serverSetup());
    // The services' health (health.mjs), probed at most every 10 s whoever asks: no URL in it.
    if (url.pathname === "/api/health" && ctx.health) {
      return ctx.health.check().then(
        (health) => sendJson(res, health),
        (error) => {
          (log.error ?? log)(`api/health: ${error.stack ?? error}`);
          sendJson(res, { message: "couldn't check the services" }, 500);
        },
      );
    }
    const match = /^\/api\/runs\/([\w.-]+)\/stream$/.exec(url.pathname);
    const run = match && ctx.runsById.get(match[1]);
    // Asked again each second while it streams: an access taken away ends it.
    const visible = async () => {
      const repo = run.repo ?? repoOf(run.key);
      return (await seeing(user, [repo].filter(Boolean), "logs:read"))(repo);
    };
    // The log is the runner's: read from it as edge (../runner/client.mjs readLog()).
    if (run && (await visible()))
      return stream(req, res, run, {
        read: async (offset) => {
          await ctx.logMoved?.(run.id);
          return ctx.runLogs.read(run.id, { offset });
        },
        allowed: visible,
        onError: (error) => log(`${match[1]}: its log stream failed: ${error.stack ?? error}`),
      });
    res.statusCode = 404;
    res.end();
  }

  // A verified delivery edge passed on ({ id, event, payload, redelivered }, ../edge/http.mjs):
  // resolves once what it admitted is done (a comment queued, a review considered), so that the
  // orchestrator acknowledges it then, and a copy that stops before reads it again. Its
  // unexpected throw is logged: it never takes the orchestrator down, nor the deliveries after it.
  function deliver({ event, payload, redelivered = false }) {
    const work = [];
    verdict = { event, refused: operatorRefuses(config, event, payload), item: false, ci: false };
    try {
      if (event === "pull_request" && redelivered) replay(event, payload, work);
      else if (event === "issues" && ISSUE_REPLAYS.includes(payload?.action) && redelivered) {
        replayIssue(event, payload, work);
      } else dispatch(event, payload, work);
    } catch (error) {
      (log.error ?? log)(
        `Delivery ${event} ${payload?.action ?? ""} failed: ${error.stack ?? error}`,
      );
    }
    const result = deliveryResult(verdict);
    verdict = null;
    ctx.metrics?.delivery(event, result);
    return Promise.all(work);
  }

  // A redelivered pull request delivery, handled as its pull request is now (events.mjs
  // replayedPull()): its own snapshot may be older than what the orchestrator handled since.
  function replay(event, payload, work) {
    const repo = payload?.repository?.full_name;
    const number = payload?.pull_request?.number;
    if (!repo || !number) return dispatch(event, payload, work);
    work.push(
      admitted(
        fetchPull(ctx.github, repo, number).then((current) => {
          if (!current) {
            return log(`Delivery ${event} ${payload.action}: ${repo}#${number} is gone`);
          }
          log(`Delivery ${event} ${payload.action}: redelivered, as ${repo}#${number} is now`);
          return Promise.all(dispatch(event, replayedPull(payload, current), []));
        }),
      ),
    );
  }

  // An issue or pull request just closed or merged, at `at` (GitHub's time, ms, or null): the
  // questions its task's last run asked before (`keys`: the issue's or pull request's own task,
  // and the one a merged pull request closes) no longer wait (dismissals.mjs). Set aside now,
  // not derived from the closed state later: a comment on a closed issue starts a run, whose
  // questions do wait, and a redelivered `closed` is older than that run.
  function settleQuestions(keys, at) {
    if (!ctx.dismissals) return;
    for (const key of new Set(keys.filter(Boolean))) {
      const aside = ctx.dismissals.setAsideOn(ctx.runs, key, null, at);
      if (aside) log(`${aside}: closed, its last run's questions set aside`);
    }
  }

  // A redelivered `issues` delivery that moves a run's questions or closes something, handled
  // only if the issue still matches it (events.mjs replayedIssue()). One whose issue can't be
  // looked up (a 5xx, a rate limit) is handled as delivered but for the questions: GitHub had
  // its 202 and won't send it again, and a lost `closed` would leave titles, waits and the
  // backlog thinking the issue open. Its questions are left as they are, for a stale delivery
  // must not set aside those of a run that asked since.
  function replayIssue(event, payload, work) {
    const repo = payload?.repository?.full_name;
    const number = payload?.issue?.number;
    if (!repo || !number) return dispatch(event, payload, work);
    const path = `/repos/${repo}/issues/${number}`;
    const said = `Delivery ${event} ${payload.action}`;
    work.push(
      admitted(
        getJson(ctx.github, repo, path, [404, 410]).then(
          (current) => {
            if (!current) return log(`${said}: ${repo}#${number} is gone`);
            const now = replayedIssue(payload, current);
            log(`${said}: redelivered, as ${repo}#${number} is now`);
            return Promise.all(dispatch(event, now, []));
          },
          (error) => {
            log(
              `${said}: redelivered, ${repo}#${number} not looked up (${error.message ?? error}): handled as sent, its questions left as they are`,
            );
            return Promise.all(dispatch(event, payload, [], { questions: false }));
          },
        ),
      ),
    );
  }

  // A verified delivery: onboarding, a pull request's state or a comment. What
  // it admits goes in `work`, returned. `questions: false`: none of the questions' changes
  // (set aside, listed, taken back), for a redelivery whose issue couldn't be looked up.
  function dispatch(event, payload, work, { questions = true } = {}) {
    const admitted = (promise) => work.push(admittedAs(promise));
    const { app } = ctx;
    // CI changed on a commit: the dashboard's CI status of the pull requests at it (pulls.mjs).
    // Not waited for: its GitHub reads would hold the delivery's place, and those behind it (a
    // burst of statuses before a comment); one lost is read again at the next Sync.
    const ci = ciDelivery(config, event, payload);
    if (ci) {
      if (verdict) verdict.ci = true;
      ctx.pulls.ciChanged(ci.repo, ci.sha).catch((error) => log(`CI: ${error.stack ?? error}`));
    }
    // Nothing else to do for them, nor a line each (github-app.mjs QUIET_EVENTS).
    if (QUIET_EVENTS.has(event)) return work;
    log(`Delivery: ${event} ${payload.action ?? ""} from ${payload.sender?.login ?? "?"}`);
    app.remember(payload.repository?.full_name, payload.installation?.id);
    // A default branch that moved: the repository list and the policies read it again, and
    // its open pull requests are asked soon whether they still merge (conflicts.mjs).
    if (refreshFor(event, payload, ctx.repoList.refresh) && payload.repository?.full_name) {
      ctx.policies?.forget(payload.repository.full_name);
      ctx.conflicts?.soon(payload.repository.full_name)?.catch((error) => {
        log(`Conflicts: ${error.stack ?? error}`);
      });
    }
    // Only the repository list's: nothing runs on a push.
    if (event === "push") return work;
    if (event === "installation" || event === "installation_repositories") {
      // Its permissions as they are now: accepting new ones sends `new_permissions_accepted`.
      app.rememberPermissions?.(payload.installation);
      const added = [...(payload.repositories ?? []), ...(payload.repositories_added ?? [])];
      for (const r of added) app.remember(r.full_name, payload.installation?.id);
      const repos = onboardingTargets(config, event, payload, skip);
      if (repos.length) admitted(ctx.onboarding.onboard(repos, payload.sender?.login));
      return work;
    }
    const pr = pullRequest(config, event, payload, Date.now(), skip);
    if (pr && ctx.pulls.record(pr.key, pr.pr))
      log(`${pr.key}: pull request #${pr.pr.number} ${pr.pr.state}`);
    // What comments wait for ("/after #12"): closed issues, merged pull requests.
    const closed = closedItem(config, event, payload, skip);
    if (closed) {
      ctx.titles.setClosed(closed.key, closedAs(closed.state));
      if (closed.state !== "open") {
        // Merged, the issue it closes too; closed without merging, only its own task.
        const target = payload.issue ?? payload.pull_request;
        const at = Date.parse(target?.merged_at ?? target?.closed_at) || null;
        if (questions) settleQuestions([closed.key, closed.state === "done" && pr?.key], at);
        // An auto-picked issue's work is over: a reopen doesn't take its pick back (picks.mjs).
        endPicks(ctx.picks, ctx.runs, [closed.key, pr?.key].filter(Boolean));
      }
      admitted(ctx.waits.closed(closed.repo, closed.number, closed.state));
    }
    // Anything else about what comments wait for, or about the issue a pull request closes,
    // asks GitHub about it again: a merge closes that issue without an `issues` delivery to an
    // App that has no such subscription.
    const touched = touchedItems(config, event, payload);
    for (const n of touched?.numbers ?? []) {
      if (n === closed?.number) continue;
      const { repo } = touched;
      admitted(n === touched.merged ? ctx.waits.merged(repo, n) : ctx.waits.recheck(repo, n));
    }
    // Open questions and answers to them: the needs-input label (questions.mjs).
    const input = questions && inputEvent(config, event, payload, app.identity().name);
    if (input) admitted(applyInput(ctx, input));
    // Nothing runs for an issue being opened, edited, labelled or closed: the graph's backlog
    // is read again now, for its next poll.
    if (event === "issues") {
      staleFor(event, payload, (repo) => ctx.workApi?.stale(repo));
      // Except the auto-pickup label: the next sweep now, rather than within SWEEP_MS.
      if (labelAdded(config, event, payload)) ctx.autoPickup?.soon();
      return work;
    }
    // A pull request that turned ready, in a repo whose `review.on` asks for a review.
    if (event === "pull_request") admitted(ctx.reviews.consider(event, payload, skip));
    // Deckhand's pull request that turned ready: the reviewers its repo's `review.request` names.
    if (event === "pull_request" && ctx.reviewers) admitted(ctx.reviewers.ready(event, payload));
    // One that turned ready or merged moves its issue on the repo's projects (projects.mjs).
    if (event === "pull_request" && ctx.projects) {
      admitted(ctx.projects.pulled(event, payload));
    }
    // A push to a pull request waiting for CI (`review.ci`): the wait moves to its new head.
    if (event === "pull_request") admitted(ctx.reviews.pushed(event, payload));
    // A merged pull request: the follow-ups its reviews listed, filed as issues.
    if (event === "pull_request") admitted(ctx.reviews.closed(event, payload));
    // A GitHub Actions run that completed on a commit an auto-merge or a review waits on.
    if (event === "workflow_run") admitted(ctx.reviews.checksDone(event, payload));
    // The operator's checks first, so only comments that may run cost a config read.
    const item = workItem(config, event, payload, skip);
    if (item) {
      if (verdict) verdict.item = true;
      item.base = payload.repository?.default_branch;
      admitted(ctx.admit(item, event, payload));
    }
    return work;
  }

  // The dashboard's Sync: what GitHub couldn't deliver, asked for again, and the open pull
  // requests' states, then their conflicts in the repos that opted in (sync.mjs).
  let synced = null;
  const syncApi = apiRoute({
    name: "Sync",
    route: (pathname) => (pathname === "/api/sync" ? { what: "sync" } : null),
    // Read at each request: the permissions are set up after this.
    permissions: {
      decide: async (user, repo, action) =>
        ctx.permissions ? ctx.permissions.decide(user, null, action) : { ok: true, error: null },
    },
    action: () => "server:sync",
    posts: {
      sync: async (req, res, user) => {
        if (synced !== null && Date.now() - synced < SYNC_MS) {
          return send(res, 429, { error: "Synced a moment ago." });
        }
        synced = Date.now();
        log(`Sync: asked by ${user}`);
        const done = await ctx.sync(user);
        send(res, done.error ? 502 : 200, done);
      },
    },
    publicUrl: ctx.publicUrl,
    log,
  });

  // `promise`'s end, logged when it fails, waited for by an orchestrator that stops.
  function admittedAs(promise) {
    const done = Promise.resolve(promise).catch((error) => log(error.stack ?? error));
    admitting.add(done);
    done.finally(() => admitting.delete(done));
    return done;
  }
  const admitted = admittedAs;

  // What edge passes on (../edge/forward.mjs), `req.url` without its /edge prefix: `user`, the
  // login edge signed in (null: none); `local`, a caller of /status from inside edge's
  // container. One request's unexpected throw answers 500 and is logged: it never takes the
  // orchestrator down.
  function handle(req, res, { user = null, local = false } = {}) {
    // Async: a throw in it is a rejection too.
    route(req, res, user, local).catch((error) => {
      (log.error ?? log)(`${req.method} ${req.url}: ${error.stack ?? error}`);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  }

  async function route(req, res, user, local) {
    if (req.url === "/status") {
      if (!local && !user) return res.writeHead(401).end();
      // A signed-in user's: only the repos they may see, as in api/state.
      const shows = user ? await seeing(user, namedRepos()) : undefined;
      return sendJson(res, ctx.status(shows));
    }
    if (req.url.startsWith("/api/sync")) {
      if (!ctx.app) return res.writeHead(503).end();
      if (syncApi(req, res, user)) return;
    }
    if (req.url.startsWith("/api/repos")) {
      if (!ctx.app) return res.writeHead(503).end();
      if (ctx.workApi.handle(req, res, user)) return;
      if (ctx.discussionApi?.handle(req, res, user)) return;
      if (ctx.repoApi.handle(req, res, user)) return;
    }
    if (req.method === "GET") return serveDashboard(req, res, user);
    res.statusCode = 404;
    res.end();
  }

  // The keys of the tasks on the dashboard, and of those with something live: the work area's
  // backlog leaves these out.
  const boardKeys = () => new Set(shownTasks().shown.map((t) => t.key));
  const liveKeys = () =>
    new Set(
      shownTasks()
        .shown.filter(isLive)
        .map((t) => t.key),
    );
  // A task as the dashboard has it (questions and all), or null.
  const taskOf = (key) => shownTasks().shown.find((t) => t.key === key) ?? null;

  return { handle, deliver, admitting, boardKeys, liveKeys, taskOf };
}
