// The dashboard's api/state (#1069, from http.mjs): what each signed-in user sees of the tasks,
// the repos' slots and the graph's arrows, and Settings › Access. dashboard/src/types/state.ts is
// its contract.
import { board, runPlaces, STATES } from "./board.mjs";
import { parseKey, prId, taskKey } from "./events.mjs";
import { isApart, kindOf } from "./modes.mjs";
import { LOOP_STEPS } from "./review-loop.mjs";
import { pickedTask, poolOf, SHARED } from "./tasks.mjs";
import { publicRun } from "./runlog.mjs";
import { createPermissions } from "./permissions.mjs";

// The action that shows a repo's tasks (permissions.mjs).
export const TASKS = "tasks:read";
// What the dashboard calls an issue of a repo the user doesn't see.
const HIDDEN = "a hidden issue";

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

// `ctx` (../orchestrator/server.mjs): the orchestrator's state and services, read at call time.
export function createState(ctx) {
  const { config, tasks } = ctx;

  // Without permissions (some tests): whether `user` may see a repo's tasks and logs, the repo's
  // own `users`, where the orchestrator knows them (ctx.usersOf()), narrowing ALLOWED_USERS.
  function sees(user, repo) {
    if (!repo) return false;
    const users = ctx.usersOf(repo);
    return !users || users.includes(user);
  }

  // Which of `repos` (names) `user` may do `action` on (permissions.mjs which(): the access
  // decision, the repos' `users` narrowing it) → a predicate on a repo's name. Tool output in the
  // logs may hold the repo's secrets; a repo with no action is hidden altogether. `listed`: the
  // repos as last listed (which()'s), for what the dashboard shows of them, never the streams.
  async function seeing(user, repos, action = TASKS, listed = false) {
    if (!ctx.permissions) return (repo) => sees(user, repo);
    const seen = await ctx.permissions.which(user, repos, action, { listed });
    return (repo) => !!repo && seen.has(repo.toLowerCase());
  }

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
  // only the repos it says (a signed-in user's: seeing()); all of them without one. Never a task
  // with an owner (a chat: chats.mjs), nor its runs: its owner's alone.
  function shownTasks(shows = null) {
    const mine = (list) => (shows ? list.filter((x) => shows(repoOf(x.key))) : list);
    const runs = ctx.runs.filter((r) => !r.owner);
    const places = runPlaces(ctx.queueOrder?.() ?? [], (repo) => !shows || shows(repo));
    // A running task's comments are queued only when they wait for a follow-up run: the others
    // are on their way to the live session. `waiting`: every repo's, the total (#786).
    const waiting = [...tasks.values()]
      .filter((t) => !t.owner)
      .filter((t) => t.pending.length > (t.running ? ctx.deliverable(t) : 0));
    const queued = waiting
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
      runs: mine(runs),
      queued,
      brainstorms: mine(ctx.brainstorms.list()),
      waits: mine(ctx.waits.list()),
      // Stored before the label was turned off: not listed.
      inputs: config.needsInputLabel ? mine(ctx.inputs.list()) : [],
      dismissals: ctx.dismissals?.list() ?? [],
      pr: (key) => ctx.pulls.get(key),
      decisions: (key) => ctx.decisions?.get(key) ?? [],
      reviewed: (repo, number) => ctx.reviews?.entry(repo, number) ?? null,
      // Routed to a user's machines (claims.mjs): waiting for one, or claimed.
      machines: mine(ctx.claims?.board() ?? []),
    }).slice(0, 200);
    return { shown, queued, waiting: waiting.length };
  }

  // Each repo `shows` with tasks in the shared pool (#639): its runs going and its tasks
  // waiting (queued as the totals count it), and the cap schedule() holds them to (repo-config.mjs
  // startable()): its max_parallel when below MAX_PARALLEL (`own`), else MAX_PARALLEL, which the
  // other repos share. Its settings are the ones read last, by any of its tasks (`settingsAt`:
  // with a comment, tasks.mjs accept(), or as a run began, runs.mjs begin()), queued, running
  // or done: a task kept from an older listener, without it, comes before them.
  function repoSlots(shows) {
    const slots = new Map();
    for (const t of tasks.values()) {
      // The shared pool's, as schedule() counts them against the repo's cap.
      if (poolOf(t) !== SHARED || !shows(t.repo)) continue;
      const name = t.repo.toLowerCase();
      const s = slots.get(name) ?? { repo: t.repo, running: 0, queued: 0, settings: null, at: 0 };
      if (t.running) s.running++;
      if (t.pending.length > (t.running ? ctx.deliverable(t) : 0)) s.queued++;
      const at = t.settingsAt ?? 0;
      if (t.settings && (!s.settings || at >= s.at)) Object.assign(s, { settings: t.settings, at });
      slots.set(name, s);
    }
    return Object.fromEntries(
      [...slots.values()].map(({ repo, running, queued, settings }) => {
        const cap = settings?.maxParallel;
        const own = cap != null && !(cap >= config.maxParallel);
        return [repo, { running, queued, max: own ? cap : config.maxParallel, own }];
      }),
    );
  }

  // What the dashboard shows `user`: the repos they have `tasks:read` on, the totals of all.
  async function state(user) {
    const shows = await seeing(user, namedRepos(), TASKS, true);
    const { shown, waiting } = shownTasks(shows);
    // A wait's blockers are of its own repo (waits.mjs): those of the tasks `user` sees are in a
    // repo they see too.
    const { edges, blockers } = waitEdges(shown, ctx.waits.list());
    const keys = [...shown.map((t) => t.key), ...blockers];
    // A lane named after a parent issue of another repo: in one `user` doesn't see, "a hidden
    // issue", its title never read for them.
    const parentOf = (key) => ctx.lanes?.parentKeys([key])[0] ?? null;
    const parents = keys.map(parentOf).filter(Boolean);
    const parentShows = await seeing(user, parents.map(repoOf), TASKS, true);
    const hiddenParent = (key) => !!parentOf(key) && !parentShows(repoOf(parentOf(key)));
    const lanes =
      ctx.lanes?.labels(keys, { title: ctx.titles.get, inboxes: ctx.inboxes?.() ?? [] }) ?? {};
    for (const [key, lane] of Object.entries(lanes)) {
      if (lane.source === "parent" && hiddenParent(key)) lanes[key] = { ...lane, name: HIDDEN };
    }
    // What `user` may do (#732): server-wide, and on each repo they see that the dashboard may
    // name, those in the state and those the repositories' list has (configured or not: their
    // Onboard and Config), so that it shows only the controls they may use. Without permissions
    // (some tests): left out, everything.
    const access =
      ctx.permissions &&
      (await ctx.permissions.dashboard(user, [...namedRepos(), ...(ctx.repoList?.listed() ?? [])]));
    // How much of each plan the runs used: server-wide.
    const plans = (access ? access.server.includes("server:read") : true)
      ? (ctx.models?.plans?.() ?? [])
      : [];
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
        // A machine task's comments by others, held for its owner (claims.mjs).
        ...(ctx.claims?.heldOf(t.key).length && { held: ctx.claims.heldOf(t.key) }),
        // Its machine run's tool calls waiting for its owner's answer (requests.mjs, #600).
        ...(ctx.requests?.toolRequests(t.key).length && {
          permissions: ctx.requests.toolRequests(t.key),
        }),
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
      // Totals of every repo, like `running`: numbers without names (#731, #786).
      running: ctx.running,
      queued: waiting,
      maxParallel: config.maxParallel,
      // The repos' own, of those `user` sees (repoSlots()).
      repoSlots: repoSlots(shows),
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
      ...(access && { access }),
      now: Date.now(),
    };
  }

  // Settings › Access (#732): each of ALLOWED_USERS's actions, server-wide and on each repo the
  // App's installations list (ALLOWED_REPOS's), with the files that decided them. A listing
  // that fails says so, the server-wide actions still shown.
  async function accessReport() {
    let repos = [];
    let error = null;
    try {
      repos = ((await ctx.repoList?.names()) ?? []).toSorted((a, b) => a.localeCompare(b));
    } catch (e) {
      error = `the repositories can't be listed (${e.message ?? e})`;
    }
    const logins = [...config.users].sort();
    // Without permissions (some tests): every action, the repos' `users` narrowing it.
    const permissions = ctx.permissions ?? createPermissions({ usersOf: ctx.usersOf });
    const users = await permissions.report(logins, repos);
    return { users, repos, error };
  }

  return { seeing, repoOf, namedRepos, shownTasks, state, accessReport };
}
