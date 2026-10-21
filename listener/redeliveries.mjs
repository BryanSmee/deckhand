// Deliveries GitHub couldn't hand over, asked for again. GitHub never retries a failed webhook
// delivery by itself: one sent while the listener was down or restarting, answered 503 while it
// stopped, or cut by a reverse proxy, is lost unless redelivered. The App's own delivery list
// (its JWT, no permission needed) says which failed: each one whose attempts all failed is
// redelivered once, at start, every few minutes and from the dashboard's Sync. A redelivery
// keeps its GUID, so one the listener did handle (http.mjs firstTime()) is ignored again.
//
// The last scan's time and the GUIDs asked for are kept in redeliveries.json: the next scan,
// after a restart too, looks back that far, within GitHub's 3 days.
import { readJson, writeJsonAtomic } from "./store.mjs";

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
// queue in the order they were posted.
export function failedDeliveries(list) {
  const byGuid = new Map();
  for (const d of list) {
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

// The `cursor` of a Link header's next page, or null on the last one.
export function nextCursor(link) {
  const next = /<([^>]+)>;\s*rel="next"/.exec(link ?? "");
  return next ? new URL(next[1]).searchParams.get("cursor") : null;
}

// `app()`: the GitHub App (github-app.mjs, its `asApp`), null before /setup. `handled(guid)`:
// whether the listener took that delivery already.
export function createRedeliveries({
  path,
  app,
  handled = () => false,
  log = () => {},
  now = Date.now,
  checkMs = CHECK_MS,
}) {
  const saved = (path && readJson(path, null)) ?? {};
  let scannedAt = saved.scannedAt ?? null;
  // GUID → when it was asked for: never twice.
  const asked = new Map(Object.entries(saved.asked ?? {}));
  let scanning = null;
  let timer = null;

  function save() {
    if (path) writeJsonAtomic(path, { scannedAt, asked: Object.fromEntries(asked) });
  }

  // The deliveries since `since`, newest first: pages until one reaches past it.
  async function listSince(github, since) {
    const all = [];
    let cursor = null;
    do {
      const query = `per_page=${PER_PAGE}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const res = await github.asApp("GET", `/app/hook/deliveries?${query}`);
      if (!res.ok) throw new Error(`GitHub GET /app/hook/deliveries: ${res.status}`);
      const page = await res.json();
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
      const since = Math.max(oldest, (scannedAt ?? oldest) - OVERLAP_MS);
      const list = await listSince(github, since);
      let count = 0;
      for (const d of failedDeliveries(list)) {
        if (asked.has(d.guid) || handled(d.guid)) continue;
        // Marked before asking: GitHub may deliver it before it answers (redelivered()).
        asked.set(d.guid, started);
        let res = null;
        try {
          res = await github.asApp("POST", `/app/hook/deliveries/${d.id}/attempts`);
        } catch (error) {
          log(`Redeliveries: ${d.guid}: ${error.message ?? error}`);
        }
        // Not asked: the next scan tries again. The others are saved whatever happens.
        if (!res?.ok) {
          asked.delete(d.guid);
          continue;
        }
        count++;
        const what = [d.event, d.action].filter(Boolean).join(" ");
        log(`Redelivered ${d.guid} (${what}, ${d.delivered_at}: ${d.status_code || d.status})`);
      }
      for (const [guid, at] of asked) if (at < oldest) asked.delete(guid);
      scannedAt = started;
      save();
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

  // Whether the delivery with this GUID is one the listener asked GitHub for again: its
  // payload is as old as the failed attempt (http.mjs replays pull requests as they are now).
  const redelivered = (guid) => !!guid && asked.has(guid);

  return { scan, start, stop, redelivered };
}
