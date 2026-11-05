// Machine tasks (#594, #596): an issue routed to its owner's own machines (machines.mjs), which
// claim it through edge's /mcp rather than Deckhand starting a sandbox for it.
//
// Routing. An issue labelled `runs-on:<label>`, or a comment with a `/machine <name or label>`
// line, runs on its owner's machines that carry that label (or have that name) and take the
// repository (machines.mjs takes()); `/machine none` sends it back to sandboxes, whatever its
// labels say. Its owner is whoever asked: the comment's author, or whoever last added the
// label, checked as auto-pickup checks one (an allowed user here, not a bot, who may start work
// runs). Only in a repository whose .deckhand.yaml has a `machines:` block: without it, neither
// routes anything. The route is kept in the store (`routes`, by task), with the machine that
// last claimed the task: it sticks there, as that machine holds the issue's clone and session,
// until its owner moves it with `/machine`.
//
// Pools. A routed task is in the `machines` pool while no machine holds it, then in that
// machine's own (`machine:<id>`, tasks.mjs): never one of MAX_PARALLEL or AUTO_PICKUP_SLOTS,
// which schedule() never starts. A machine claims it within its capacity, counted from its
// claims; the auto-pickup sweep never picks an issue with a `runs-on` label.
//
// Claims. claim() waits up to CLAIM_WAIT_MS for the next task the machine may take, then takes
// its queued comments as a sandbox run would (the task is running from then on) and returns the
// work: repository, issue, branch, mode, prompt and message. The claim holds a lease of LEASE_MS
// that each heartbeat of the machine renews; one that runs out gives the comments back, as a
// sandbox that died does, and the task waits again for that machine, whose next claim resumes
// its session. release() gives a claim back at once; removing the machine ends its claims. The
// claim is saved with the queue (restart.mjs): the copy that takes over has it, with a fresh
// lease.
//
// Only its owner reaches it: a comment by another allowed user on a routed task is held, shown on
// the dashboard, until the owner delivers it (or drops it). Deckhand's own items (a review's fix
// round, a CI fix, a rebase) are delivered as on any task.
import { labeller, labellerRefusal } from "./auto-pickup.mjs";
import { commentsText, taskKey } from "./events.mjs";
import { getJson, paginate } from "./github.mjs";
import { RUNS_ON, runsOn } from "./machines.mjs";
import { customMode } from "./modes.mjs";
import { startAction } from "./permissions.mjs";
import { firstMessage, promptFor } from "./prompts.mjs";
import { CONFIG_FILE } from "./repo-config.mjs";
import { taskId } from "./spelling.mjs";
import { MACHINES, SHARED, isMachinePool, machinePool, poolOf } from "./tasks.mjs";
import { Refused } from "../lib/http.mjs";

// How long a claim waits for work before it answers there is none: under the proxies' idle
// timeouts, and the driver asks again at once.
export const CLAIM_WAIT_MS = 25_000;
// How long a claim lasts without the machine's heartbeat (every 30 s, machines.mjs).
export const LEASE_MS = 2 * 60_000;
// How often the leases are looked at.
const EXPIRE_EVERY_MS = 5000;

// What starting a machine task needs, as a sandbox's work run.
const WORK = startAction("work");

const lower = (s) => String(s ?? "").toLowerCase();

// Whether machine `m` is the one route `route` asks for: the machine it sticks to, else one of
// its owner's with its name or label.
export function fits(route, m) {
  if (m.owner !== route.owner) return false;
  if (route.machine) return route.machine === m.id;
  const want = lower(route.want);
  return lower(m.name) === want || m.labels.includes(want);
}

// "Café : bientôt" → "cafe-bientot", as the sandbox names the issue's branch (draft-pr.sh).
export function branchSlug(title) {
  const slug = String(title ?? "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 50)
    .replace(/-+$/, "");
  return slug || "task";
}

// Whether `item` is a person's that only the task's owner may send its runs: not Deckhand's own
// (a review's fix round, a CI fix, a rebase: their `reason`; onboarding: no author).
const fromSomeoneElse = (item, owner) =>
  !item.reason && !!item.author && lower(item.author) !== owner;

// `ctx` (../orchestrator/server.mjs): the orchestrator's state and services, read at call time
// (tasks, machines, repoSettings, repoFile, github, permissions, reply, settle, received,
// startLater, schedule, saveQueue, titles, order). `routes`: the store's map, task id → route:
//   { owner, want, via: "comment" | "label", label?, machine, ran, at }   routed
//   { none: true, by, at }                                                 `/machine none`
// `machine`: the machine it sticks to (the last to claim it, or the one `/machine` named), null
// while any that fits may take it; `ran`: whether that machine claimed it already (its next claim
// resumes the session).
export function createClaims(
  ctx,
  {
    routes = new Map(),
    now = Date.now,
    waitMs = CLAIM_WAIT_MS,
    leaseMs = LEASE_MS,
    newId = () => null,
    later = (fn, ms) => setTimeout(fn, ms),
    every = (fn, ms) => setInterval(fn, ms),
  } = {},
) {
  const { config, log, tasks } = ctx;
  // The claims waiting for work: each one's wake-up.
  const waiting = new Set();
  // "<key>@<label's time>" of the label routes whose refusal was said already.
  const told = new Set();
  let timer = null;

  const keyOf = (task) => taskKey(task.repo, task.id);
  const routeOf = (key) => routes.get(taskId(key)) ?? null;
  // Task `key` under any spelling of its repo (the board's may be a run's).
  const taskOf = (key) =>
    tasks.get(key) ?? [...tasks.values()].find((t) => taskId(keyOf(t)) === taskId(key)) ?? null;
  const active = (route) => (route && !route.none ? route : null);

  // The task's route, if it is routed, as kept (claims check it again at each claim).
  function routed(task) {
    return isMachinePool(poolOf(task)) ? active(routeOf(keyOf(task))) : null;
  }

  // Task `task` put in the pool `route` (null: none) says: shared again without one. A sandbox
  // that runs for it meanwhile keeps its slot where it started (tasks.mjs countRun()); what
  // queues after it goes by the pool.
  function place(task, route) {
    const before = poolOf(task);
    task.pool = route ? (route.machine ? machinePool(route.machine) : MACHINES) : SHARED;
    if (before !== task.pool) log(`${keyOf(task)}: now in the ${task.pool} pool`);
  }

  // --- Routing -----------------------------------------------------------------------------

  // The route of `item` (an issue's, or its pull request's linked to it) as it is queued
  // (tasks.mjs queue()), its task's route kept or made from its `runs-on` label: → the route, or
  // null (sandboxes), or { refused } when the label's owner may not run it (said once, on the
  // issue). `labels`: the issue's, as the delivery had them (null: asked of GitHub).
  async function routeFor(item, labels = null) {
    if (item.kind !== "issue" || !item.settings?.machines) return null;
    const key = taskKey(item.repo, item.id);
    const kept = routeOf(key);
    if (kept?.none || kept?.via === "comment") return active(kept);
    if (labels === null) {
      const path = `/repos/${item.repo}/issues/${item.number}`;
      const issue = await getJson(ctx.github, item.repo, path, [404, 410]);
      labels = issue?.labels ?? [];
    }
    const asked = runsOn(labels);
    if (!asked) {
      if (kept) routes.delete(taskId(key));
      return null;
    }
    if (kept?.via === "label" && kept.want === asked.label) return kept;
    // Whoever added it, as auto-pickup reads it: the latest labelling.
    const events = await paginate(
      (p) => ctx.github(item.repo, "GET", p),
      `/repos/${item.repo}/issues/${item.number}/events`,
    );
    const by = labeller(events, asked.name);
    if (!by) return { refused: `who added the \`${asked.name}\` label isn't in its events yet` };
    const may = by.bot ? null : await ctx.permissions?.whoMay([by.login], item.repo, WORK);
    const why = labellerRefusal(by, config, item.settings.users, may);
    if (why) {
      const once = `${key}@${by.at}`;
      if (!told.has(once)) {
        told.add(once);
        const text = `Not run: ${why}. A \`${RUNS_ON}<label>\` label runs the issue on the machines of whoever added it; \`/machine none\` sends it back to sandboxes.`;
        await ctx.reply(item.repo, item.number, text).catch((error) => log(`${key}: ${error}`));
      }
      return { refused: why };
    }
    const route = {
      owner: lower(by.login),
      want: asked.label,
      via: "label",
      label: asked.name,
      machine: null,
      ran: false,
      at: now(),
    };
    routes.set(taskId(key), route);
    log(`${key}: runs on ${route.owner}'s machines labelled ${route.want} (${asked.name})`);
    return route;
  }

  // A `/machine` line (item.machine, events.mjs parseMachine()), its author's: the task's route
  // changed, said with a 👍 when the comment asks for nothing else. → whether the comment goes on
  // to the queue (a trigger or a mode line with it).
  async function command(item) {
    const key = taskKey(item.repo, item.id);
    const asked = item.machine;
    const say = (text) =>
      ctx.reply(item.repo, item.replyTo, text).catch((error) => log(`${key}: ${error}`));
    if (asked.error) {
      await say(asked.error);
      return false;
    }
    if (item.kind !== "issue") {
      await say("`/machine` routes an issue: comment it on the issue, or on its pull request.");
      return false;
    }
    if (!item.settings?.machines) {
      await say(
        `\`/machine\`: this repository takes no machines (no \`machines:\` in its \`${CONFIG_FILE}\`).`,
      );
      return false;
    }
    // As a refused start: nothing said (permissions.mjs).
    if (ctx.permissions) {
      const said = await ctx.permissions.decide(item.author, item.repo, WORK);
      if (!said.ok) {
        log(`${key}: /machine refused: ${item.author} may not start work runs`);
        return false;
      }
    }
    const author = lower(item.author);
    const kept = active(routeOf(key));
    // Another's machine task moves only with its owner, unless they are no longer a user here.
    if (kept && kept.owner !== author && config.users.includes(kept.owner)) {
      await say(`#${item.number} runs on @${kept.owner}'s machines: only they can move it.`);
      return false;
    }
    const at = now();
    if (asked.none) {
      routes.set(taskId(key), { none: true, by: author, at });
      log(`${key}: back to sandboxes (/machine none by ${author})`);
    } else {
      // A name of the author's machines sticks to it at once; a label lets any of theirs with it.
      const named = ctx.machines?.list(author).find((m) => lower(m.name) === lower(asked.want));
      routes.set(taskId(key), {
        owner: author,
        want: asked.want,
        via: "comment",
        machine: named?.id ?? null,
        ran: false,
        at,
      });
      log(`${key}: runs on ${author}'s machine(s) ${asked.want} (/machine)`);
    }
    // What waits for a run of its own follows: to the machine's pool, or back to shared.
    const task = taskOf(key);
    if (task) {
      place(task, active(routeOf(key)));
      if (task.pending.length && !task.running) ctx.startLater(task);
    }
    if (item.trigger || item.modeLine) return true;
    await ctx.settle(item, "acknowledged");
    return false;
  }

  // `task` as `item` is queued on it (tasks.mjs queue()), with its route (routeFor()): in its
  // pool. → whether `item` is held for the owner instead (fromSomeoneElse()): then it is.
  function admit(task, item, route) {
    place(task, route);
    if (!route || !fromSomeoneElse(item, route.owner)) return false;
    task.held.push(item);
    log(
      `${keyOf(task)}: ${item.author}'s comment held for ${route.owner}, the machine task's owner`,
    );
    return true;
  }

  // --- Claims ------------------------------------------------------------------------------

  const claimsOf = (id) =>
    [...tasks.values()].filter((t) => t.claim?.machine === id).map((t) => t.claim);

  // The next task the owner's machine `m` may take now, claimed: its work, or null.
  async function next(owner, m) {
    const since = (t) => t.pending[0]?.queuedAt ?? 0;
    const candidates = [...tasks.values()]
      .filter((t) => isMachinePool(poolOf(t)) && !t.running && t.ready && t.pending.length)
      .sort((a, b) => since(a) - since(b));
    for (const task of candidates) {
      if (claimsOf(m.id).length >= m.capacity) return null;
      const route = routed(task);
      if (!route || !fits(route, m)) continue;
      const labels = await ctx.machines.takes(owner, m.id, task.repo).catch(() => null);
      if (!labels) continue;
      // A label route takes the machines with that label for this repository alone.
      const byName = !route.machine && lower(m.name) === lower(route.want);
      if (route.via === "label" && !route.machine && !labels.includes(route.want)) continue;
      if (!route.machine && !byName && !labels.includes(lower(route.want))) continue;
      const items = [...task.pending];
      const work = await workOf(task, items, route, m);
      // Claimed meanwhile (another claim of the machine), or its comments taken.
      if (task.running || !task.ready || task.pending[0] !== items[0]) continue;
      if (claimsOf(m.id).length >= m.capacity) return null;
      take(task, route, m, items, work);
      return work;
    }
    return null;
  }

  // Its queued comments, theirs from now (as runs.mjs runTask() takes them), the route stuck to
  // the machine, the claim saved with the queue.
  function take(task, route, m, items, work) {
    const key = keyOf(task);
    task.pending.splice(0, items.length);
    clearTimeout(task.timer);
    task.ready = false;
    task.running = true;
    const resume = route.machine === m.id && !!route.ran;
    routes.set(taskId(key), { ...route, machine: m.id, ran: true });
    task.pool = machinePool(m.id);
    task.claim = {
      id: work.run,
      machine: m.id,
      name: m.name,
      owner: m.owner,
      items,
      claimedAt: now(),
      leaseUntil: now() + leaseMs,
      resume,
    };
    task.next = {};
    ctx.order?.drop(key);
    ctx.saveQueue?.();
    log(`${key}: claimed by ${m.owner}'s ${m.name} (${m.id}), run ${work.run}`);
  }

  // What a claim returns: the work as a sandbox run gets it (its prompt and first message), for
  // the owner's agent on the machine.
  async function workOf(task, items, route, m) {
    const key = keyOf(task);
    const { settings } = await ctx.repoSettings(task.repo, task.base);
    const mode = items.at(-1).mode;
    const own = customMode(settings, mode);
    // Not on the default branch: the mode's own prompt without them.
    const instructions = own?.instructions
      ? await Promise.resolve(ctx.repoFile?.(task.repo, own.instructions, task.base))
          .then((file) => file?.text ?? null)
          .catch(() => null)
      : null;
    const options = { ...task.next };
    const text = commentsText(items, options);
    const title = ctx.titles?.get(key) ?? items.findLast((i) => i.title)?.title ?? null;
    const branch = `issue-${task.number}-${branchSlug(title)}`;
    const resume = route.machine === m.id && !!route.ran;
    const prompt = promptFor(task, {
      mode,
      text,
      settings,
      own,
      instructions,
      onboardingWork: false,
      config,
      grant: null,
      branches: [branch],
      pull: items.at(-1).replyTo,
    });
    return {
      run: newId() ?? `${task.name}-${now()}`,
      repository: task.repo,
      issue: task.number,
      key,
      title,
      base: task.base,
      branch,
      mode,
      resume,
      prompt,
      message: firstMessage({ mode, text, restored: false, started: resume }),
      options,
      leaseSeconds: leaseMs / 1000,
    };
  }

  // The next work for the owner's machine `id`, waiting up to `wait` ms for one: → its work, or
  // null when none came. Refused (404) for a machine that isn't the owner's.
  async function claim(owner, id, { wait = waitMs } = {}) {
    const until = now() + wait;
    for (;;) {
      // Again at each try: removed, or its owner no longer a user, meanwhile.
      const m = ctx.machines.get(owner, id);
      ctx.machines.heartbeat(owner, id);
      if (ctx.stopping) return null;
      const work = await next(owner, m);
      if (work) return work;
      const left = until - now();
      if (left <= 0) return null;
      await new Promise((resolve) => {
        const done = () => {
          waiting.delete(done);
          clearTimeout(timeout);
          resolve();
        };
        const timeout = later(done, left);
        waiting.add(done);
      });
    }
  }

  // Something may be claimable now (a task ready, a claim given back): the waiting claims look.
  function wake() {
    for (const done of [...waiting]) done();
  }

  // The task of the owner's machine `id`'s claim `run`, or Refused (404).
  function claimed(owner, id, run) {
    ctx.machines.get(owner, id);
    const task = [...tasks.values()].find((t) => t.claim?.id === run && t.claim.machine === id);
    if (!task) throw new Refused(404, `No claim ${String(run).slice(0, 80)} on this machine.`);
    return task;
  }

  // Its claim over: its comments back first in the queue, for that machine (it sticks to it) as
  // soon as it claims again. `why`: the log's.
  function giveBack(task, why) {
    const { claim: c } = task;
    task.claim = null;
    task.running = false;
    task.pending.unshift(...c.items.filter((item) => !task.pending.includes(item)));
    log(`${keyOf(task)}: ${c.name}'s claim ${c.id} given back: ${why}`);
    ctx.saveQueue?.();
    // Its pause over already: they were queued before the claim.
    if (task.pending.length) ctx.startLater(task, 0);
    wake();
  }

  // The machine's heartbeat: its claims' leases renewed (`runs`: those the driver still has; null:
  // all of them). → its claims, [{ run, key, leaseUntil }]: one it doesn't list has ended.
  function renew(owner, id, runs = null) {
    ctx.machines.get(owner, id);
    const until = now() + leaseMs;
    const mine = [...tasks.values()].filter((t) => t.claim?.machine === id);
    for (const task of mine) {
      if (!runs || runs.includes(task.claim.id)) task.claim.leaseUntil = until;
    }
    return mine.map((t) => ({ run: t.claim.id, key: keyOf(t), leaseUntil: t.claim.leaseUntil }));
  }

  // The machine gives its claim `run` back: → the task's key.
  function release(owner, id, run) {
    const task = claimed(owner, id, run);
    giveBack(task, "released by the machine");
    return keyOf(task);
  }

  // The claims whose lease ran out: their runs interrupted, as a sandbox that died, their
  // comments waiting again for that machine. → the keys.
  function expire() {
    const at = now();
    const gone = [...tasks.values()].filter((t) => t.claim && t.claim.leaseUntil <= at);
    for (const task of gone) giveBack(task, "its lease ran out, without the machine's heartbeat");
    return gone.map(keyOf);
  }

  // A `/cancel` or the dashboard's Stop on a claimed task: its claim ends, its comments dropped
  // (their 👀 off). The machine learns it at its next heartbeat. → whether there was one.
  function cancel(task, by) {
    const c = task.claim;
    if (!c) return false;
    task.claim = null;
    task.running = false;
    for (const item of c.items) ctx.track?.(ctx.settle(item, "cancelled"));
    log(`${keyOf(task)}: ${c.name}'s claim ${c.id} cancelled by ${by}`);
    ctx.saveQueue?.();
    if (task.pending.length) ctx.startLater(task);
    return true;
  }

  // A machine removed (machines.mjs): its claims end, its tasks wait again, for whichever of the
  // owner's machines fits their route.
  function machineGone(m) {
    for (const task of [...tasks.values()].filter((t) => t.claim?.machine === m.id)) {
      giveBack(task, `${m.name} was removed`);
    }
    for (const [id, route] of routes) {
      if (route.machine !== m.id) continue;
      routes.set(id, { ...route, machine: null, ran: false });
      const task = taskOf(id);
      if (task) task.pool = MACHINES;
    }
    wake();
  }

  // A claim saved with the queue (restart.mjs loadQueue()), on `task`: running again, with a
  // fresh lease, which the machine renews from this copy on.
  function restore(task, saved) {
    task.claim = { ...saved, leaseUntil: Math.max(saved.leaseUntil ?? 0, now() + leaseMs) };
    task.running = true;
    task.pool = machinePool(saved.machine);
  }

  // --- Held comments -----------------------------------------------------------------------

  // The routed task `key` the owner `user` acts on, or Refused.
  function ownTask(user, key) {
    const task = taskOf(key);
    const route = active(routeOf(key));
    if (!task?.held.length) throw new Refused(404, "No comment is held on this task.");
    if (!route || route.owner !== lower(user)) {
      throw new Refused(403, "Only the machine task's owner delivers or drops its held comments.");
    }
    return task;
  }

  // The owner delivers the held comments: queued for the task's next run, as if they had just
  // come (their 👀 kept). → how many.
  function deliverHeld(user, key) {
    const task = ownTask(user, key);
    const items = task.held.splice(0);
    task.pending.push(...items);
    log(`${key}: ${items.length} held comment(s) delivered by ${user}`);
    ctx.saveQueue?.();
    if (!task.running) ctx.startLater(task);
    return items.length;
  }

  // Or drops them: their 👀 off. → how many.
  function dropHeld(user, key) {
    const task = ownTask(user, key);
    const items = task.held.splice(0);
    for (const item of items) ctx.track?.(ctx.settle(item, "cancelled"));
    log(`${key}: ${items.length} held comment(s) dropped by ${user}`);
    ctx.saveQueue?.();
    return items.length;
  }

  // --- The dashboard -----------------------------------------------------------------------

  // Task `t`'s machine, for the board (board.mjs) and its page: { owner, want, via, machine,
  // claimed, available }, `machine` the name of the one that holds it or it sticks to, `claimed`
  // whether one holds it now, `available` whether one of the owner's machines that fits is
  // online; null for a task that isn't routed.
  function view(t) {
    const route = routed(t);
    if (!route) return null;
    const online = ctx.machines?.onlineOf(route.owner) ?? [];
    const stuck = route.machine ? online.find((m) => m.id === route.machine) : null;
    return {
      owner: route.owner,
      want: route.want,
      via: route.via,
      machine: t.claim?.name ?? stuck?.name ?? null,
      claimed: !!t.claim,
      available: online.some((m) => fits(route, m)),
    };
  }

  // The routed tasks' views, by key, for the board: each with something queued, held or claimed.
  function board() {
    return [...tasks.values()]
      .filter((t) => t.pending.length || t.held.length || t.claim)
      .map((t) => ({ key: keyOf(t), repo: t.repo, ...view(t) }))
      .filter((v) => v.owner);
  }

  // The comments held on task `key`, as the dashboard shows them: [{ author, at, text, url }].
  function heldOf(key) {
    const task = taskOf(key);
    return (task?.held ?? []).map((item) => ({
      author: item.author ?? null,
      at: item.queuedAt ?? null,
      text: String(item.text ?? "").slice(0, 500),
      url: item.comment?.html_url ?? null,
    }));
  }

  function start() {
    if (timer) return;
    timer = every(expire, EXPIRE_EVERY_MS);
    timer?.unref?.();
  }

  function stop() {
    clearInterval(timer);
    timer = null;
    wake();
  }

  return {
    routeFor,
    command,
    admit,
    claim,
    wake,
    renew,
    release,
    expire,
    cancel,
    machineGone,
    restore,
    deliverHeld,
    dropHeld,
    view,
    board,
    heldOf,
    start,
    stop,
  };
}
