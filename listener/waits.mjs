// Comments that wait for other issues ("Deckhand /after #77"): the run they ask for starts
// once the last of those is done (closed as completed, or its pull request merged), as if the
// comment had just been posted. One wait per task, kept in waits.json so a restart forgets
// none. GitHub is asked again at start and every few minutes: a webhook missed while the
// listener was down still starts the work.
import { outcome } from "./events.mjs";
import { plain, revive } from "./restart.mjs";
import { readJson, writeJsonAtomic } from "./store.mjs";

// How often GitHub is asked about what the waits wait for.
export const CHECK_MS = 15 * 60_000;

// "#77", "#77 and #80", "#77, #80 and #81".
export function issueList(numbers) {
  const refs = numbers.map((n) => `#${n}`);
  return refs.length > 1 ? `${refs.slice(0, -1).join(", ")} and ${refs.at(-1)}` : refs[0];
}

// `github(repo, method, path, body, expected)`: the App's calls. `reply(repo, number, text)`,
// `received(item)` (👀) and `settle(item, status)`: comments.mjs's. `resume(item)`: checks the
// comment again and queues it (tasks.mjs), resolving to false when it may no longer run.
export function createWaits({
  path,
  github,
  reply,
  received,
  settle,
  resume,
  log = () => {},
  now = Date.now,
}) {
  // Task key ("org/repo#78") → { repo, blockers: [77, …], item, since }; `item`: the comment
  // as restart.mjs saves it.
  const waits = new Map(Object.entries(readJson(path, {})));
  let timer = null;
  let checking = null;

  function save() {
    writeJsonAtomic(path, Object.fromEntries(waits));
  }

  const keyOf = (item) => `${item.repo}#${item.id}`;
  const answer = (item, text) =>
    reply(item.repo, item.replyTo, text).catch((error) => log(`${keyOf(item)}: ${error}`));

  // "open", "done", "not-done" or "missing" (deleted, transferred, or never there).
  async function stateOf(repo, number) {
    const res = await github(repo, "GET", `/repos/${repo}/issues/${number}`, undefined, [404, 410]);
    if (res.status === 404 || res.status === 410) return "missing";
    if (!res.ok) throw new Error(`#${number}: ${res.status}`);
    return outcome(await res.json());
  }

  // Drops the task's wait, its comment losing its 👀. Returns the wait, or null.
  function drop(key) {
    const wait = waits.get(key);
    if (!wait) return null;
    waits.delete(key);
    save();
    settle(revive(wait.item), "stopped").catch(() => {});
    return wait;
  }

  // A comment with an "/after" line (item.after: events.mjs parseAfter()). Resolves to true when
  // it is handled here (it waits, or is refused), false when it should run now: every issue it
  // names is done already, or "/after none" came with a trigger line.
  async function request(item) {
    const key = keyOf(item);
    const { after } = item;
    const starts = item.trigger === "work" || !!item.modeLine;
    if (after.error) return answer(item, `${after.error} Nothing waits.`).then(() => true);
    if (after.none) {
      const wait = drop(key);
      if (wait) log(`${key}: no longer waits for ${issueList(wait.blockers)}`);
      if (starts) return false;
      const text = wait
        ? `No longer waiting for ${issueList(wait.blockers)}.`
        : "Nothing waits here.";
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
    if (!blockers.length) {
      // A new "/after" replaces the list.
      if (drop(key)) log(`${key}: its wait is replaced`);
      return false;
    }
    await hold(item, blockers);
    const they = blockers.length > 1 ? "they are" : "it is";
    await answer(
      item,
      `Waiting for ${issueList(blockers)}: I'll start when ${they} done (closed as completed, or merged). A new trigger comment starts now instead; \`/after none\` cancels.`,
    );
    return true;
  }

  // Makes the task of `item` wait for `blockers` (open issues of its repo), replacing its wait,
  // without a reply: request()'s, or the dashboard's own comment (work.mjs).
  async function hold(item, blockers) {
    const key = keyOf(item);
    if (drop(key)) log(`${key}: its wait is replaced`);
    received(item);
    const { settings, after: _, ...rest } = item;
    waits.set(key, { repo: item.repo, blockers, item: await plain(rest), since: now() });
    save();
    log(`${key}: waits for ${issueList(blockers)}`);
  }

  // A trigger comment without "/after" replaces the wait: it runs now. `why`: who drops it, for
  // the log. Returns the wait dropped, or null.
  function cancel(key, why = "a new comment replaces it") {
    const wait = drop(key);
    if (wait) log(`${key}: no longer waits for ${issueList(wait.blockers)}, ${why}`);
    return wait;
  }

  // Issue or pull request `number` of `repo` is closed, done or not ("missing": gone).
  async function closed(repo, number, state) {
    if (state === "open") return;
    // A waiting issue closed itself: nothing to start any more.
    const own = `${repo}#${number}`;
    if (waits.has(own)) {
      drop(own);
      log(`${own}: closed, its wait is dropped`);
    }
    const waiting = [...waits].filter(
      ([, w]) => w.repo.toLowerCase() === repo.toLowerCase() && w.blockers.includes(number),
    );
    for (const [key, wait] of waiting) {
      // Another delivery or check may have handled it meanwhile.
      if (waits.get(key) !== wait) continue;
      const item = revive(wait.item);
      if (state !== "done") {
        drop(key);
        log(`${key}: #${number} ${state}, its wait is dropped`);
        const why = state === "missing" ? "is gone" : "was closed without being done";
        await answer(item, `#${number} ${why}: I won't start. Comment again to start anyway.`);
        continue;
      }
      wait.blockers = wait.blockers.filter((n) => n !== number);
      if (wait.blockers.length) {
        save();
        log(`${key}: #${number} done, still waits for ${issueList(wait.blockers)}`);
        continue;
      }
      waits.delete(key);
      save();
      log(`${key}: #${number} done, starting`);
      if (await resume(item)) await answer(item, `#${number} is done: starting.`);
      else settle(item, "stopped").catch(() => {});
    }
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
    })().finally(() => (checking = null));
    return checking;
  }

  function start() {
    if (timer) return;
    check().catch((error) => log(`Waits: ${error.stack ?? error}`));
    timer = setInterval(() => {
      check().catch((error) => log(`Waits: ${error.stack ?? error}`));
    }, CHECK_MS);
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
      since: w.since,
    }));
  }

  return {
    request,
    hold,
    cancel,
    closed,
    check,
    start,
    stop,
    list,
    stateOf,
    get: (key) => waits.get(key),
  };
}
