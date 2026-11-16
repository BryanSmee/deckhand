// Pull mode (#1032): edge takes GitHub's deliveries through the App's API instead of receiving
// them, so Deckhand needs no address GitHub can reach (a laptop, a home server behind NAT). The
// App's webhook points at https://deckhand.invalid/webhook (../listener/setup.mjs), which never
// resolves: GitHub records
// each delivery as failed, and keeps it for 3 days (docs/design/webhook-pull-mode.md). Every few
// seconds the copy holding the poller's lease lists the deliveries since its last look
// (`GET /app/hook/deliveries`), reads each one it hasn't taken (`GET /app/hook/deliveries/{id}`)
// and takes its payload as a webhook (take.mjs). No HMAC to check: the payload comes from
// GitHub's API, over the App's own channel (the github service's JWT), never from the internet.
//
// A delivery is taken once: its GUID's mark here (`pulled/<guid>`, for as long as GitHub keeps
// it), and take.mjs's own, which a webhook that did arrive set too.
import { createRedeliveries, listDeliveries } from "../listener/redeliveries.mjs";
import { QUIET_EVENTS } from "../listener/github-app.mjs";
import { createTaker, takenDelivery } from "./take.mjs";

// How often it looks: GitHub lists a delivery 1.4 to 7 s after its event.
const CHECK_MS = 12_000;
// How long GitHub keeps deliveries.
const RETENTION_MS = 3 * 24 * 3600_000;
// Each look starts this far before the last one: a delivery GitHub lists late is still seen.
const OVERLAP_MS = 60_000;
// The first look ever: the App's installation, just after /setup, but not days of deliveries
// webhooks took before pull mode was turned on.
const FIRST_MS = 10 * 60_000;
// A delivery this old when taken is replayed as its issue or pull request is now (redelivered).
const LATE_MS = 60_000;
// A delivery that can't be read is tried again at the next looks while it is this young.
const RETRY_MS = 3600_000;
// No delivery for this long: said in the logs, once a day (an unticked "Active" looks the same).
const SILENT_MS = 24 * 3600_000;

const SCANNED = "pulled/scanned";
const LAST = "pulled/last";
const pulledKey = (guid) => `pulled/${guid}`;

// A mark still `taking` after this was left by a scan that died (edge killed mid-read): free.
const TAKING_MS = 2 * 60_000;

// Whether pull mode took the delivery with this GUID, within the 3 days GitHub keeps it, or is
// taking it now: the redeliveries, once webhooks are back, never ask for one again.
export async function pulledDelivery(store, guid, now = Date.now) {
  const mark = await store.get(pulledKey(guid));
  return !!mark && (mark.kept != null || now() - (mark.taking ?? 0) < TAKING_MS);
}

// Whether edge has a delivery, whichever way it came: what the redeliveries skip.
export async function takenOrPulled(store, guid, now = Date.now) {
  return (await takenDelivery(store, guid, now)) || pulledDelivery(store, guid, now);
}

// Marks it as being read, once: false when it was taken, or another scan is reading it.
async function startPulling(store, guid, at, ttlMs) {
  const key = pulledKey(guid);
  const mark = { taking: at };
  if (await store.setIfAbsent(key, mark, { ttlMs })) return true;
  const found = await store.get(key);
  if (!found || found.kept != null || at - (found.taking ?? 0) < TAKING_MS) return false;
  return store.compareAndSet(key, found, mark, { ttlMs });
}

// Whether pull mode is on: DELIVERIES (`pull` or `webhook`) over what /setup stored in app.json.
export function pullMode(setting, credentials) {
  if (setting) return setting === "pull";
  return credentials?.deliveries === "pull";
}

// What to read of a list (newest first, as GitHub has it): one entry per GUID (a redelivery
// keeps it), oldest first. Of the events that only say CI changed (QUIET_EVENTS), the newest of
// each repository alone: a status per state and context would each cost an App call, and the
// orchestrator reads the commit's whole CI anyway; the dashboard's Sync reads what is left.
export function toRead(list) {
  const byGuid = new Map();
  const quiet = new Set();
  for (const d of list) {
    if (byGuid.has(d.guid) || !/^\d+$/.test(String(d.id))) continue;
    if (QUIET_EVENTS.has(d.event)) {
      const key = `${d.event}/${d.repository_id}`;
      if (quiet.has(key)) continue;
      quiet.add(key);
    }
    byGuid.set(d.guid, d);
  }
  return [...byGuid.values()].sort(
    (a, b) => Date.parse(a.delivered_at) - Date.parse(b.delivered_at),
  );
}

// A delivery GitHub answered with (GET /app/hook/deliveries/{id}) → { event, guid, payload }.
// Parsed as it is: its payload's IDs (an issue's, a comment's) stay numbers, as in a webhook.
export function readDelivery(text, listed) {
  const { request } = JSON.parse(text) ?? {};
  const headers = Object.fromEntries(
    Object.entries(request?.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
  );
  let payload = request?.payload ?? null;
  if (typeof payload === "string") payload = JSON.parse(payload);
  return {
    event: headers["x-github-event"] ?? listed.event,
    guid: headers["x-github-delivery"] ?? listed.guid,
    payload: payload && typeof payload === "object" ? payload : null,
  };
}

// `app()`: the GitHub App (its asApp()) while pull mode is on, else null; `take`: take.mjs's;
// `handled(guid)`: whether edge took that delivery already; `store`: edge's; `onPulled(event,
// result)`: each delivery read (metrics.mjs webhook()); `onSeen(at)`: the newest delivery
// GitHub listed (metrics.mjs).
export function createPull({
  store,
  app,
  take,
  handled = () => false,
  onPulled = () => {},
  onSeen = () => {},
  log = () => {},
  now = Date.now,
  checkMs = CHECK_MS,
}) {
  let scanning = null;
  let timer = null;
  // Set by close(): the scan in flight ends after the delivery it is reading.
  let stopped = false;
  let warnedAt = -Infinity;
  // Whether it was on at its last look (null: not known since it started).
  let on = null;

  // Reads one delivery and takes it: → what became of it (metrics.mjs WEBHOOK_RESULTS).
  async function pull(github, listed, started) {
    const res = await github.asApp("GET", `/app/hook/deliveries/${listed.id}`);
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
    const { event, guid, payload } = readDelivery(await res.text(), listed);
    if (!payload) return { event, result: "ignored" };
    const redelivered = started - Date.parse(listed.delivered_at) > LATE_MS;
    return { event, result: await take({ event, id: guid, payload, redelivered }) };
  }

  // The newest delivery GitHub listed, kept; a long silence said once a day.
  async function seen(list, started, first) {
    const newest = Math.max(0, ...list.map((d) => Date.parse(d.delivered_at) || 0));
    // None yet: counted from the first look.
    const last = Math.max(newest, await store.get(LAST)) || (first ? started : 0);
    if (last > 0) {
      if (newest || first) await store.set(LAST, last);
      onSeen(last);
    }
    if (last > 0 && started - last > SILENT_MS && started - warnedAt > SILENT_MS) {
      warnedAt = started;
      const hours = Math.round((started - last) / 3600_000);
      log(
        `Pull mode: no delivery from GitHub for ${hours} h. If its repositories had activity, check that the App's webhook is still Active (its settings on GitHub, Webhook).`,
      );
    }
  }

  // Lists the deliveries since the last look and takes each new one: resolves to how many went
  // on the stream, or null while pull mode is off (no App). One at a time: a second call shares it.
  function scan() {
    if (scanning) return scanning;
    if (stopped) return Promise.resolve(null);
    const github = app();
    if (!github) {
      // Off: turned on again, it starts from now, not from days of deliveries webhooks took.
      if (on !== false)
        store.delete(SCANNED).then(
          () => (on = false),
          () => {},
        );
      return Promise.resolve(null);
    }
    on = true;
    scanning = (async () => {
      const started = now();
      const scannedAt = await store.get(SCANNED);
      const from = scannedAt ?? started - FIRST_MS;
      const since = Math.max(started - RETENTION_MS, from - OVERLAP_MS);
      const list = await listDeliveries(github, since);
      await seen(list, started, scannedAt == null);
      let count = 0;
      // The next look starts no later than a delivery that couldn't be read.
      let resume = started;
      for (const d of toRead(list)) {
        if (stopped) {
          // Stopping: the rest is the next look's, on whichever copy takes the lease.
          resume = Math.min(resume, Date.parse(d.delivered_at));
          break;
        }
        if (await handled(d.guid)) continue;
        const ttlMs = Math.max(1, Date.parse(d.delivered_at) + RETENTION_MS - started);
        if (!(await startPulling(store, d.guid, started, ttlMs))) continue;
        try {
          const { event, result } = await pull(github, d, started);
          // Kept only once on the stream (or dropped as ignored): a mark left `taking` by a
          // copy killed before is free again in 2 minutes.
          await store.set(pulledKey(d.guid), { kept: now() }, { ttlMs });
          onPulled(event, result);
          if (result === "accepted") count++;
        } catch (error) {
          const at = Date.parse(d.delivered_at);
          const what = `Pull mode: delivery ${d.guid} (${d.event}, ${d.id})`;
          if (started - at < RETRY_MS) {
            await store.delete(pulledKey(d.guid)).catch(() => false);
            resume = Math.min(resume, at);
            log(`${what}: ${error.message ?? error}, read again at the next look`);
          } else {
            log(`${what}: ${error.message ?? error}, dropped (over an hour old)`);
          }
        }
      }
      // Another copy's scan (a Sync) may have written since: the earlier of the two, so neither
      // one's unread delivery falls out of the next look.
      const latest = await store.get(SCANNED);
      await store.set(
        SCANNED,
        latest != null && latest !== scannedAt ? Math.min(latest, resume) : resume,
      );
      return count;
    })().finally(() => (scanning = null));
    return scanning;
  }

  // Nobody awaits these: a failure is logged.
  const scanLogged = () => scan().catch((error) => log(`Pull mode: ${error.message ?? error}`));

  function start() {
    scanLogged();
    timer = setInterval(scanLogged, checkMs);
    timer.unref?.();
  }

  function stop() {
    clearInterval(timer);
    timer = null;
  }

  // Edge stopping: no look after this one, which ends after the delivery it is reading. → once
  // it has (SIGTERM waits for it before closing the store: a read cut there is read again).
  function close() {
    stop();
    stopped = true;
    return (scanning ?? Promise.resolve()).then(
      () => {},
      () => {},
    );
  }

  return { scan, start, stop, close };
}

// Edge's two pollers, as server.mjs runs them on the lease's holder, whichever mode is on at
// each look (`pulling()`): the redeliveries with webhooks, never in pull mode, where every
// delivery fails (its webhook URL never resolves) and the pull reads them all; and back on
// webhooks, never one pull mode took. `app()`: the App's client, null before /setup;
// `taking`: createTaker()'s options but the store and the redeliveries. → { redeliveries, pull,
// sync(): the dashboard's Sync, a look now in pull mode }.
export function createPollers({
  store,
  app,
  pulling,
  taking,
  onRedelivered,
  onPulled,
  onSeen,
  log = () => {},
  now = Date.now,
}) {
  const redeliveries = createRedeliveries({
    store,
    app: () => (pulling() ? null : app()),
    handled: (guid) => takenOrPulled(store, guid, now),
    onRedelivered,
    log,
    now,
  });
  const pull = createPull({
    store,
    app: () => (pulling() ? app() : null),
    take: createTaker({ ...taking, store, redeliveries, log, now }),
    handled: (guid) => takenDelivery(store, guid, now),
    onPulled,
    onSeen,
    log,
    now,
  });
  const sync = async () => (await pull.scan()) ?? redeliveries.scan();
  return { redeliveries, pull, sync };
}
