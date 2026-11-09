// The listener's calls to the models service (../models/, #504), which alone holds the agents'
// credentials, as the orchestrator: which of them the operator set (names only, for its
// settings), what redacts them from runs' output (their fingerprints), a run's API state at its
// end (its provider's last status, a plan's reset, its last failure: the reply and the
// fallbacks read it), how much of each plan the runs used (the dashboard's bars, plans()) and the
// `models` stream (the calls it refused a run, for its log).
import { serviceClient } from "../lib/service-client.mjs";

// How often the fingerprints are read again (a plan's login refreshed), and how long a set is
// kept: a token refreshed away may still show in a run's output for a while.
const PRINTS_EVERY_MS = 60_000;
const PRINTS_KEPT_MS = 24 * 60 * 60_000;
const RETRY_MS = 5_000;
// How often the plans' usage is read again while a dashboard asks for it (api/state, every few
// seconds): the readings change with the runs' calls, and a poll of the plans is the models
// service's to pace (../models/usage.mjs POLL_MS).
const USAGE_MS = 15_000;

// `before` (a list, or none) with `fresh` last, those of `fresh` taken out of it first (by
// `keyOf`), then the oldest dropped past `max`: `fresh` stays whole.
function newestLast(before = [], fresh = [], keyOf, max) {
  const now = new Set((fresh ?? []).map(keyOf));
  const old = (before ?? []).filter((x) => !now.has(keyOf(x)));
  return [...old.slice(Math.max(0, old.length - Math.max(0, max - now.size))), ...(fresh ?? [])];
}

const num = (n) => (typeof n === "number" && Number.isFinite(n) ? n : null);
const text = (t) => (typeof t === "string" ? t.slice(0, 80) : null);

// A plan's usage as api/state gives it: its numbers, times and names, nothing else.
export function planOf(plan) {
  if (!plan || typeof plan.plan !== "string") return null;
  const windows = (Array.isArray(plan.windows) ? plan.windows : [])
    .filter((w) => typeof w?.name === "string" && num(w.used) !== null)
    .map((w) => ({
      name: text(w.name),
      ...(text(w.label) && { label: text(w.label) }),
      used: Math.min(Math.max(w.used, 0), 1),
      resetsAt: num(w.resetsAt),
      at: num(w.at),
    }));
  return {
    plan: text(plan.plan),
    label: text(plan.label) ?? text(plan.plan),
    windows,
    updatedAt: num(plan.updatedAt),
    limited: plan.limited === true,
    limitedUntil: num(plan.limitedUntil),
  };
}

// `urls`: MODELS_SERVICE_URL (its copies, comma-separated); `token()`: the Authorization
// header for it (the listener's service token, as the orchestrator).
export function createModelsService({
  urls,
  token,
  fetch = globalThis.fetch,
  log = () => {},
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  const client = serviceClient({ service: "models", urls, token, fetch, log });
  let stopped = false;
  const timers = new Set();
  const later = (fn, ms) => {
    if (stopped) return;
    const timer = setTimer(() => (timers.delete(timer), fn()), ms);
    timer.unref?.();
    timers.add(timer);
  };
  const sleep = (ms) => new Promise((resolve) => later(resolve, ms));

  // The names of the credentials it holds, asked until it answers: the listener's settings
  // depend on them.
  async function credentials() {
    for (let delay = 1000; ; delay = Math.min(delay * 2, 30_000)) {
      try {
        const { names } = await client.json("GET", "/credentials");
        return Array.isArray(names) ? names.filter((n) => typeof n === "string") : [];
      } catch (error) {
        log(
          `Models: which credentials it holds, not answered yet (${error.message}), asking again`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  // The fingerprints' sets, the newest last: { at, salt, values, chunk, chunks, rolls }.
  let sets = [];
  // One read: whether it answered.
  async function readPrints() {
    try {
      const answer = await client.json("GET", "/fingerprints", { waitMs: 10_000 });
      const { salt } = answer;
      // One set per salt (a copy of the service, until it restarts), with what it said before
      // too: a token refreshed away may still show in a run's output for a while.
      const before = sets.find((s) => s.salt === salt);
      const fresh = Array.isArray(answer.values) ? answer.values : [];
      // The current answer last, whole: a cap drops the oldest of what is no longer said, never
      // a credential still held (the operator's keys, said at every read).
      const values = newestLast(before?.values, fresh, (v) => v.hash, 200);
      const chunks = newestLast(before?.chunks, answer.chunks, (c) => c, 2000);
      const rolls = newestLast(before?.rolls, answer.rolls, (r) => r, 2000);
      const kept = sets.filter((s) => now() - s.at < PRINTS_KEPT_MS && s.salt !== salt);
      sets = [
        ...kept,
        {
          at: now(),
          salt,
          chunk: answer.chunk,
          values,
          chunks,
          rolls,
        },
      ];
      return true;
    } catch (error) {
      log(`Models: its fingerprints (${error.message}), asking again`);
      return false;
    }
  }

  // The first read, asked until it answers (the runs restored after it have their output
  // redacted with them), then again every minute.
  async function start() {
    for (let delay = 1000; !(await readPrints()); delay = Math.min(delay * 2, 30_000)) {
      if (stopped) return;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    // Again every PRINTS_EVERY_MS, RETRY_MS after a failure.
    const again = async () => later(again, (await readPrints()) ? PRINTS_EVERY_MS : RETRY_MS);
    later(again, PRINTS_EVERY_MS);
  }

  // What lib/redact.mjs takes among the secrets: the fingerprints of the agents' credentials.
  const prints = () => sets.map(({ at, ...set }) => set);

  // The run's API state, once it ended: { apiStatus, apiReset, apiError }, or nulls when the
  // service doesn't answer soon (the reply then says less).
  async function apiOf(id) {
    try {
      return await client.json("GET", `/runs/${encodeURIComponent(id)}/api`, { waitMs: 30_000 });
    } catch (error) {
      log(`Models: run ${id}'s API state (${error.message})`);
      return { apiStatus: null, apiReset: null, apiError: null };
    }
  }

  // The plans' usage as last read, for api/state: [] before a read, or without a plan. Asked again
  // in the background, USAGE_MS after the last read: only while a dashboard asks, so the plans
  // are polled only then (`?poll=1`). A failed read keeps the last one.
  let usage = { at: -Infinity, plans: [], reading: null };
  function plans() {
    if (!usage.reading && now() - usage.at >= USAGE_MS) {
      usage.reading = client
        .json("GET", "/usage?poll=1", { waitMs: 10_000 })
        .then((answer) => {
          if (Array.isArray(answer?.plans)) usage.plans = answer.plans.map(planOf).filter(Boolean);
        })
        .catch((error) => log(`Models: the plans' usage (${error.message})`))
        .finally(() => {
          usage.at = now();
          usage.reading = null;
        });
    }
    return usage.plans;
  }
  // The read under way, for the tests.
  const usageRead = () => usage.reading ?? Promise.resolve();

  // The `models` stream: `note(event)` for each line a run's log gets, acknowledged once
  // handled.
  let consuming = null;
  function consume({ note }) {
    consuming ??= (async () => {
      while (!stopped) {
        try {
          const { events } = await client.json("GET", "/events?wait=20000");
          const done = [];
          for (const { id, event } of events) {
            try {
              if (event?.type === "note") await note(event);
              done.push(id);
            } catch (error) {
              log(`Models: its ${event?.type} event for ${event?.run} (${error.message})`);
              done.push(id);
            }
          }
          if (done.length) await client.json("POST", "/events/ack", { body: { ids: done } });
        } catch (error) {
          if (stopped) break;
          log(`Models: its events (${error.message}), asking again`);
          await sleep(RETRY_MS);
        }
      }
    })();
    return consuming;
  }

  return {
    credentials,
    prints,
    apiOf,
    plans,
    usageRead,
    consume,
    start,
    stop() {
      stopped = true;
      for (const timer of timers) clearTimer(timer);
      timers.clear();
    },
  };
}
