// Comments that wait for other issues ("Deckhand /after #77"): the run they ask for starts
// once the last of those is done (closed as completed, or its pull request merged), as if the
// comment had just been posted. One wait per task, kept in the orchestrator's store (`waits`,
// lib/store-map.mjs) so a restart or a handover forgets none. Anything about an issue waited for (a delivery, a run on it ending) asks GitHub about
// that issue again; and every wait is checked at start and every few minutes, so a webhook
// missed while the listener was down, or never subscribed to, still starts the work. Once
// they are done, an issue whose open questions aren't answered yet (the repo's
// `wait_for_answers`) waits for its answers too: `blockers` empty, `answers` true.
import { issueOutcome, parseKey, sameRepo, taskKey } from "./events.mjs";
import { getJson } from "./github.mjs";
import { plain, queueId, revive } from "./restart.mjs";
import { respellMap } from "./spelling.mjs";

// How often GitHub is asked about what the waits wait for (the operator's WAITS_CHECK_MINUTES).
const CHECK_MS = 5 * 60_000;

// GitHub closes the issue a merged pull request closes on its own, maybe after telling us of
// the merge: still open then, it is asked about once more after this long.
const MERGE_SETTLE_MS = 30_000;

// What a wait is for: "#77", "#77 and #80", "#77, #80 and #81", or the issue's answers.
export function waitsFor(wait) {
  return wait.blockers.length ? issueList(wait.blockers) : "the answers to its open questions";
}

// "#77", "#77 and #80", "#77, #80 and #81".
export function issueList(numbers) {
  const refs = numbers.map((n) => `#${n}`);
  return refs.length > 1 ? `${refs.slice(0, -1).join(", ")} and ${refs.at(-1)}` : refs[0];
}

// `github(repo, method, path, body, expected)`: the App's calls. `reply(repo, number, text)`,
// `received(item)` (👀) and `settle(item, status)`: comments.mjs's. `resume(item)`: checks the
// comment again and queues it (tasks.mjs), resolving to false when it may no longer run, and
// to "answers" when it waits for the issue's open questions to be answered. `waits`: the Map
// they are kept in (storeMap()'s); `queueSaved()`: once the queue is in the store with what was just
// queued (restart.mjs queueWritten()), which a wait's release is written after.
export function createWaits({
  waits = new Map(),
  queueSaved = () => Promise.resolve(),
  github,
  reply,
  received,
  settle,
  resume,
  log = () => {},
  now = Date.now,
  checkMs = CHECK_MS,
  later = (fn, ms) => setTimeout(fn, ms).unref?.(),
  // Each issue asked of GitHub, for the orchestrator's metrics (deckhand_waits_checked_total).
  checked = () => {},
}) {
  // `waits`: task key ("org/repo#78") → { repo, blockers: [77, …], item, since, unqueued? };
  // `item`: the comment as restart.mjs saves it, its queueId the one it is queued with once
  // released; `unqueued`: the queueIds of the comments the dashboard took out of the queue for
  // it (hold()). People's text: the store holds it without a secret (storeMap()'s storable()).
  // A wait from before queueIds (a waits.json moved to the store): one now, kept, so that its
  // release is known by it (dedupe()).
  for (const [key, wait] of [...waits]) {
    if (wait.item && !wait.item.queueId) {
      waits.set(key, { ...wait, item: { ...wait.item, queueId: queueId() } });
    }
  }
  let timer = null;
  let checking = null;
  // Task key → { held, missed }: the wait held while a new comment was being decided
  // (reserve()), and what happened to it meanwhile, the closes and answers to replay if that
  // comment doesn't run.
  const reserved = new Map();
  // "org/repo#77" → recheck() not started yet, and the last one started or queued.
  const queued = new Map();
  const latest = new Map();

  const keyOf = (item) => taskKey(item.repo, item.id);
  const answer = (item, text) =>
    reply(item.repo, item.replyTo, text).catch((error) => log(`${keyOf(item)}: ${error}`));

  // "open", "done", "not-done" or "missing" (deleted, transferred, or never there).
  async function stateOf(repo, number) {
    checked();
    const issue = await getJson(github, repo, `/repos/${repo}/issues/${number}`, [404, 410]);
    return issue ? issueOutcome(issue) : "missing";
  }

  // Drops the task's wait, its comment losing its 👀. Returns the wait, or null.
  function drop(key) {
    const wait = waits.get(key);
    if (!wait) return null;
    waits.delete(key);
    settle(revive(wait.item), "stopped").catch(() => {});
    return wait;
  }

  // A comment with an "/after" line (item.after: events.mjs parseAfter()). Resolves to true when
  // it is handled here (it waits, or is refused), false when it should run now: every issue it
  // names is done already, or "/after none" came with a trigger line. "/after none" drops the
  // task's wait at once; with every issue done, the wait stays, the caller dropping it once the
  // comment runs (tasks.mjs admit(): the policies may refuse it).
  async function request(item) {
    const key = keyOf(item);
    const { after } = item;
    const starts = item.trigger === "work" || !!item.modeLine;
    if (after.error) return answer(item, `${after.error} Nothing waits.`).then(() => true);
    // Cancelled whatever happens to the comment's run (held back, refused by the policies).
    if (after.none) {
      const wait = drop(key);
      if (wait) log(`${key}: no longer waits for ${waitsFor(wait)}`);
      if (starts) return false;
      const text = wait ? `No longer waiting for ${waitsFor(wait)}.` : "Nothing waits here.";
      return answer(item, text).then(() => true);
    }
    if (!starts) {
      const text =
        "`/after` goes with a trigger line or a `/mode` line, which it holds back. Nothing waits.";
      return answer(item, text).then(() => true);
    }
    const self = after.numbers.find((n) => n === item.number || n === item.replyTo);
    if (self)
      return answer(item, `#${self} can't wait for itself. Nothing waits.`).then(() => true);
    const states = await Promise.all(
      after.numbers.map((n) =>
        stateOf(item.repo, n).catch((error) => {
          // Not knowing isn't done: it waits, and the next check asks again.
          log(`${key}: the state of #${n}: ${error.message ?? error}`);
          return "open";
        }),
      ),
    );
    const refused = (state, why) => {
      const n = after.numbers[states.indexOf(state)];
      return n === undefined ? null : `#${n} ${why}. Nothing waits.`;
    };
    const why =
      refused("missing", "isn't an issue or pull request of this repository") ??
      refused("not-done", "was closed without being done");
    if (why) return answer(item, why).then(() => true);
    const blockers = after.numbers.filter((_, i) => states[i] === "open");
    // Every one done: it runs now, and replaces the wait once it does.
    if (!blockers.length) return false;
    await hold(item, blockers);
    const they = blockers.length > 1 ? "they are" : "it is";
    await answer(
      item,
      `Waiting for ${issueList(blockers)}: I'll start when ${they} done (closed as completed, or merged). A new trigger comment starts now instead; \`/after none\` cancels.`,
    );
    return true;
  }

  // Makes the task of `item` wait for `blockers` (open issues of its repo), replacing its wait,
  // without a reply: request()'s, or the dashboard's own comment (work.mjs). `eyes`: the
  // comment has its 👀 already (a queued one, work.mjs requeue()): nothing to wait for before
  // the wait is saved. `unqueued`: the queueIds of the comments taken out of the queue for it
  // (work.mjs requeue()), which a start drops from the queue should both have them (dedupe());
  // the queue is written without them once the wait is in the store (written()).
  async function hold(item, blockers, { eyes = false, unqueued = [] } = {}) {
    const key = keyOf(item);
    if (drop(key)) log(`${key}: its wait is replaced`);
    if (!eyes) received(item);
    const { settings, after: _, ...rest } = item;
    // Its queueId now: queued once released, the same, which tells a start it was (dedupe()).
    const saved = { ...(await plain(rest)), queueId: rest.queueId ?? queueId() };
    waits.set(key, {
      repo: item.repo,
      blockers,
      item: saved,
      since: now(),
      ...(unqueued.length && { unqueued }),
    });
    log(`${key}: waits for ${issueList(blockers)}`);
  }

  // A wait released into the queue: out of memory now, out of the store once `started()`
  // resolves (to whether it was queued; a promise of it). One pair: the queue written first,
  // then the wait deleted (`queueSaved()`), so a copy killed in between finds the comment in both,
  // and keeps the queue's (dedupe()), never in neither. Resolves to what `started()` did.
  async function releasing(key, started) {
    let done;
    waits.delete(key, { after: new Promise((resolve) => (done = resolve)) });
    try {
      const result = await started();
      done(result === true ? queueSaved() : undefined);
      return result;
    } catch (error) {
      done();
      throw error;
    }
  }

  // A trigger comment's run is being decided (tasks.mjs, work.mjs: the policies may refuse it):
  // its task's wait neither starts nor goes meanwhile. → the wait held (null: none), for
  // release(), which then drops that wait only (`replaced`: the comment runs, `why` for the log;
  // a newer one, an "/after" posted meanwhile, stays) or replays what came meanwhile (refused:
  // it still waits).
  function reserve(key) {
    const held = waits.get(key) ?? null;
    if (held && !reserved.has(key)) reserved.set(key, { held, missed: [] });
    return held;
  }

  async function release(key, replaced, why, held) {
    const entry = reserved.get(key);
    const own = !!entry && entry.held === held;
    if (own) reserved.delete(key);
    if (replaced) return held && waits.get(key) === held ? cancel(key, why) : null;
    if (own) for (const replay of entry.missed) await replay();
    return null;
  }

  // A trigger comment without "/after" replaces the wait: it runs now. `why`: who drops it, for
  // the log. Returns the wait dropped, or null.
  function cancel(key, why = "a new comment replaces it") {
    const wait = drop(key);
    if (wait) log(`${key}: no longer waits for ${waitsFor(wait)}, ${why}`);
    return wait;
  }

  // Issue or pull request `number` of `repo` is closed, done or not ("missing": gone).
  async function closed(repo, number, state) {
    if (state === "open") return;
    // A waiting issue closed itself: nothing to start any more.
    const own = taskKey(repo, number);
    if (waits.has(own)) {
      drop(own);
      log(`${own}: closed, its wait is dropped`);
    }
    const waiting = [...waits].filter(
      ([, w]) => sameRepo(w.repo, repo) && w.blockers.includes(number),
    );
    for (const [key, wait] of waiting) {
      // Another delivery or check may have handled it meanwhile.
      if (waits.get(key) !== wait) continue;
      // A new comment is being decided: replayed if it doesn't run (release()).
      if (reserved.has(key)) {
        reserved.get(key).missed.push(() => closed(repo, number, state));
        continue;
      }
      const item = revive(wait.item);
      if (state !== "done") {
        drop(key);
        log(`${key}: #${number} ${state}, its wait is dropped`);
        const why = state === "missing" ? "is gone" : "was closed without being done";
        await answer(item, `#${number} ${why}: I won't start. Comment again to start anyway.`);
        continue;
      }
      // In place: a close of its other issues meanwhile still finds it (above). Set again, for
      // the store.
      wait.blockers = wait.blockers.filter((n) => n !== number);
      if (wait.blockers.length) {
        waits.set(key, wait);
        log(`${key}: #${number} done, still waits for ${issueList(wait.blockers)}`);
        continue;
      }
      log(`${key}: #${number} done, starting`);
      const started = await releasing(key, () => resume(item));
      if (started === "answers") {
        await keep(key, wait);
        await answer(
          item,
          `#${number} is done, but this issue's open questions aren't answered yet: I'll start once they are.`,
        );
      } else if (started) await answer(item, `#${number} is done: starting.`);
      else settle(item, "stopped").catch(() => {});
    }
  }

  // A wait whose issues are done, kept until the issue's questions are answered, unless a
  // new comment replaced it meanwhile.
  async function keep(key, wait) {
    if (waits.has(key)) return;
    waits.set(key, { ...wait, blockers: [], answers: true, since: now() });
    log(`${key}: waits for the answers to its open questions`);
  }

  // Issue `number` of `repo` may have had its questions answered (its label came off): its
  // wait for them, if any, starts the comment, as resume() checks again.
  async function answered(repo, number) {
    const key = [...waits.keys()].find(
      (k) => k.toLowerCase() === taskKey(repo, number).toLowerCase(),
    );
    const wait = key && waits.get(key);
    if (!wait?.answers) return;
    if (reserved.has(key)) return void reserved.get(key).missed.push(() => answered(repo, number));
    const item = revive(wait.item);
    const started = await releasing(key, () => resume(item));
    if (started === "answers") return keep(key, wait);
    log(`${key}: ${started ? "answered, starting" : "answered, not started"}`);
    if (started) await answer(item, "The open questions are answered: starting.");
    else settle(item, "stopped").catch(() => {});
  }

  // Asks GitHub about every issue a wait is for. Overlapping checks share the one under way.
  function check() {
    checking ??= (async () => {
      const seen = new Map();
      for (const w of waits.values()) {
        for (const n of w.blockers) seen.set(`${w.repo.toLowerCase()}#${n}`, [w.repo, n]);
      }
      for (const [repo, n] of seen.values()) {
        try {
          await closed(repo, n, await stateOf(repo, n));
        } catch (error) {
          log(`Waits: ${repo}#${n}: ${error.message ?? error}`);
        }
      }
      // A label taken off while the listener was down.
      for (const [key, w] of [...waits]) {
        if (!w.answers) continue;
        await answered(w.repo, parseKey(key)?.number).catch((error) => {
          log(`Waits: ${key}: ${error.message ?? error}`);
        });
      }
    })().finally(() => (checking = null));
    return checking;
  }

  // Whether a wait of `repo` is for its issue or pull request `number`.
  const waitedFor = (repo, number) =>
    [...waits.values()].some((w) => sameRepo(w.repo, repo) && w.blockers.includes(number));

  // Something happened to `number` of `repo` (a delivery, a run on it ended): GitHub is asked
  // about that one only, and nothing when no wait is for it. Resolves to its state, or null.
  // One that comes while another is under way runs after it, not alongside: that one may
  // have read the state before this change. Those that come before it starts share it.
  function recheck(repo, number) {
    if (!number || !waitedFor(repo, number)) return Promise.resolve(null);
    const id = `${repo.toLowerCase()}#${number}`;
    const once = async () => {
      const state = await stateOf(repo, number);
      await closed(repo, number, state);
      return state;
    };
    if (queued.has(id)) return queued.get(id);
    const run = (latest.get(id) ?? Promise.resolve())
      .catch(() => {})
      .then(() => {
        queued.delete(id);
        return once();
      });
    queued.set(id, run);
    latest.set(id, run);
    run.catch(() => {}).finally(() => latest.get(id) === run && latest.delete(id));
    return run;
  }

  // A pull request that closes issue `number` was merged: GitHub closes the issue when the
  // merge went to the default branch. Asked now, and once more a little later if still open.
  async function merged(repo, number) {
    const state = await recheck(repo, number);
    if (state !== "open") return state;
    later(() => {
      recheck(repo, number).catch((error) =>
        log(`Waits: ${repo}#${number}: ${error.message ?? error}`),
      );
    }, MERGE_SETTLE_MS);
    return state;
  }

  function start() {
    if (timer) return;
    check().catch((error) => log(`Waits: ${error.stack ?? error}`));
    timer = setInterval(() => {
      check().catch((error) => log(`Waits: ${error.stack ?? error}`));
    }, checkMs);
    timer.unref?.();
  }

  function stop() {
    clearInterval(timer);
    timer = null;
  }

  // For the dashboard: what each waiting task waits for.
  function list() {
    return [...waits].map(([key, w]) => ({
      key,
      repo: w.repo,
      kind: w.item.kind,
      mode: w.item.modeLine ?? "work",
      replyTo: w.item.replyTo,
      blockers: [...w.blockers],
      // Its issues are done: it waits for the answers to its open questions.
      answers: !!w.answers,
      since: w.since,
    }));
  }

  // Its task keys, and the same with one spelling per repo (spelling.mjs, at a restart).
  const keys = () => [...waits.keys()];
  function respell(spelled) {
    const fix = (w) => ({
      ...w,
      repo: spelled(w.repo),
      item: { ...w.item, repo: spelled(w.item.repo) },
    });
    respellMap(waits, spelled, fix);
  }

  // At a start, once the queue and the runs going are back: a wait whose comment is queued or
  // running (`queuedIds`, their queueIds) was released by a copy killed before it deleted it
  // (releasing()): dropped, without a word, as the comment goes on.
  function dedupe(queuedIds) {
    for (const [key, wait] of [...waits]) {
      if (!queuedIds.has(wait.item?.queueId)) continue;
      waits.delete(key);
      log(`${key}: its wait was released already, its comment queued`);
    }
  }

  // The queueIds of the comments the dashboard took out of the queue for a wait (hold()): a copy
  // killed before the queue was written without them finds them there too (restart.mjs
  // loadQueue() leaves them to the wait).
  const unqueued = () => new Set([...waits.values()].flatMap((w) => w.unqueued ?? []));

  return {
    keys,
    respell,
    dedupe,
    unqueued,
    request,
    hold,
    cancel,
    reserve,
    release,
    closed,
    answered,
    recheck,
    merged,
    check,
    start,
    stop,
    list,
    stateOf,
    get: (key) => waits.get(key),
    // Once the task's wait, as it is now, is in the store (storeMap()'s written()).
    written: (key) => waits.written?.(key) ?? Promise.resolve(),
  };
}
