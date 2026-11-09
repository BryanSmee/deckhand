// Deliveries GitHub couldn't hand over, asked for again. GitHub never retries a failed webhook
// delivery by itself: one sent while the listener was down or restarting, answered 503 while it
// stopped, or cut by a reverse proxy, is lost unless redelivered. The App's own delivery list
// (its JWT, no permission needed) says which failed: each one whose attempts all failed is
// redelivered once, at start, every few minutes and from the dashboard's Sync. A redelivery
// keeps its GUID, so one edge did take (its store's delivery ids) is ignored again.
//
// Edge's (#506): the last scan's time and the GUIDs asked for are kept in its store, which its
// two copies share. The copy holding the poller's lease scans (../edge/server.mjs); the
// redelivery may reach either, which asks the store whether it was one (redelivered()). The
// next scan, after a restart too, looks back to the last one, within GitHub's 3 days.
import { QUIET_EVENTS } from "./github-app.mjs";
import { openStore } from "../lib/store.mjs";

// How long GitHub keeps deliveries.
export const RETENTION_MS = 3 * 24 * 3600_000;
// A scan looks this far before the last one: a delivery GitHub lists late is still seen.
const OVERLAP_MS = 10 * 60_000;
const CHECK_MS = 5 * 60_000;
const PER_PAGE = 100;

const succeeded = (d) => d.status_code >= 200 && d.status_code < 300;
// Couldn't connect or timed out (0), or a server error: worth another try. A 4xx is the
// listener's own refusal (a bad signature, too large) and would be refused again.
const retryable = (d) => !succeeded(d) && (!d.status_code || d.status_code >= 500);

// The deliveries to redeliver in a list (newest first, as GitHub has it): per GUID whose
// attempts all failed, the latest attempt, when it is worth another. Oldest first, so comments
// queue in the order they were posted. Never the events that only say CI changed
// (github-app.mjs QUIET_EVENTS): a status per state, context and commit would each cost an App call.
export function failedDeliveries(list) {
  const byGuid = new Map();
  for (const d of list) {
    if (QUIET_EVENTS.has(d.event)) continue;
    const attempts = byGuid.get(d.guid) ?? [];
    attempts.push(d);
    byGuid.set(d.guid, attempts);
  }
  const failed = [];
  for (const attempts of byGuid.values()) {
    if (attempts.some(succeeded)) continue;
    const latest = attempts.reduce((a, b) =>
      Date.parse(b.delivered_at) > Date.parse(a.delivered_at) ? b : a,
    );
    if (retryable(latest)) failed.push(latest);
  }
  return failed.sort((a, b) => Date.parse(a.delivered_at) - Date.parse(b.delivered_at));
}

// A delivery list (or one delivery) from its JSON text, each `id` kept as GitHub wrote it, a
// string: delivery IDs are past 2^53 (about 3.85e18 in 2026), which JSON.parse rounds to
// another delivery's, and GitHub answers 404 for that one (#1078). Other numbers stay numbers.
export function parseDeliveries(text) {
  return JSON.parse(text, (key, value, context) =>
    key === "id" && typeof value === "number" ? context.source : value,
  );
}

// The `cursor` of a Link header's next page, or null on the last one.
export function nextCursor(link) {
  const next = /<([^>]+)>;\s*rel="next"/.exec(link ?? "");
  return next ? new URL(next[1]).searchParams.get("cursor") : null;
}

const SCANNED = "redeliveries/scanned";
// A GUID asked for again: never twice, and kept as long as GitHub keeps the delivery.
const askedKey = (guid) => `redeliveries/asked/${guid}`;

// `app()`: the GitHub App (github-app.mjs, its `asApp`), null before /setup. `handled(guid)`:
// whether edge took that delivery already (may be a promise). `store`: edge's.
// `onRedelivered()`: called for each delivery GitHub agreed to send again (../edge/metrics.mjs).
export function createRedeliveries({
  store = openStore("memory:"),
  app,
  handled = () => false,
  onRedelivered = () => {},
  log = () => {},
  now = Date.now,
  checkMs = CHECK_MS,
}) {
  let scanning = null;
  let timer = null;

  // The deliveries since `since`, newest first: pages until one reaches past it.
  async function listSince(github, since) {
    const all = [];
    let cursor = null;
    do {
      const query = `per_page=${PER_PAGE}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const res = await github.asApp("GET", `/app/hook/deliveries?${query}`);
      if (!res.ok) throw new Error(`GitHub GET /app/hook/deliveries: ${res.status}`);
      const page = parseDeliveries(await res.text());
      if (!Array.isArray(page)) throw new Error("GitHub GET /app/hook/deliveries: no list");
      all.push(...page);
      if (page.some((d) => Date.parse(d.delivered_at) < since)) break;
      cursor = page.length ? nextCursor(res.headers.get("link")) : null;
    } while (cursor);
    return all.filter((d) => Date.parse(d.delivered_at) >= since);
  }

  // Lists what failed since the last scan and asks for each again: resolves to how many were
  // redelivered, or null when there is no App yet. One scan at a time: a second call shares it.
  function scan() {
    if (scanning) return scanning;
    const github = app();
    if (!github) return Promise.resolve(null);
    scanning = (async () => {
      const started = now();
      const oldest = started - RETENTION_MS;
      const scannedAt = await store.get(SCANNED);
      const since = Math.max(oldest, (scannedAt ?? oldest) - OVERLAP_MS);
      const list = await listSince(github, since);
      let count = 0;
      for (const d of failedDeliveries(list)) {
        if (await handled(d.guid)) continue;
        // Marked before asking: GitHub may deliver it before it answers (redelivered()), to
        // either copy of edge. Already there: asked before, never twice.
        const kept = Math.max(1, Date.parse(d.delivered_at) + RETENTION_MS - started);
        if (!(await store.setIfAbsent(askedKey(d.guid), started, { ttlMs: kept }))) continue;
        let res = null;
        try {
          res = await github.asApp("POST", `/app/hook/deliveries/${d.id}/attempts`);
        } catch (error) {
          log(`Redeliveries: ${d.guid}: ${error.message ?? error}`);
        }
        // Not asked: the next scan tries again. The others are saved whatever happens.
        if (!res?.ok) {
          if (res) log(`Redeliveries: ${d.guid} (delivery ${d.id}): GitHub answered ${res.status}`);
          await store.delete(askedKey(d.guid));
          continue;
        }
        count++;
        onRedelivered();
        const what = [d.event, d.action].filter(Boolean).join(" ");
        log(`Redelivered ${d.guid} (${what}, ${d.delivered_at}: ${d.status_code || d.status})`);
      }
      await store.set(SCANNED, started);
      return count;
    })().finally(() => (scanning = null));
    return scanning;
  }

  // Nobody awaits these: a failure is logged.
  const scanLogged = () => scan().catch((error) => log(`Redeliveries: ${error.message ?? error}`));

  function start() {
    scanLogged();
    timer = setInterval(scanLogged, checkMs);
    timer.unref?.();
  }

  function stop() {
    clearInterval(timer);
    timer = null;
  }

  // Whether the delivery with this GUID is one edge asked GitHub for again (a promise): its
  // payload is as old as the failed attempt (the orchestrator replays pull requests as they
  // are now, http.mjs).
  const redelivered = async (guid) => !!guid && (await store.get(askedKey(guid))) !== null;

  return { scan, start, stop, redelivered };
}
