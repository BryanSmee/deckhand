// GitHub's own status (#681): githubstatus.com's summary, read every few minutes and kept in
// memory, so that the dashboard's Server page tells a problem at GitHub from one in Deckhand. The
// github service reads it (its way out is GitHub's); the dashboard reads it from Deckhand's API,
// never from the browser. A failed read keeps the last one, with when it was read and why the
// next one failed; it never touches the service's health.

export const SUMMARY_URL = "https://www.githubstatus.com/api/v2/summary.json";
export const INCIDENT_URL = "https://www.githubstatus.com/incidents/";
export const INTERVAL_MS = 5 * 60_000;
const TIMEOUT_MS = 10_000;
// A summary is a few tens of kilobytes: anything much larger isn't one.
const MAX_BYTES = 1024 * 1024;

// The components Deckhand depends on, as githubstatus.com names them: shown when they aren't
// operational.
export const COMPONENTS = [
  "API Requests",
  "Webhooks",
  "Git Operations",
  "Pull Requests",
  "Issues",
  "Actions",
];
const INDICATORS = new Set(["none", "minor", "major", "critical", "maintenance"]);
const MAX_INCIDENTS = 10;
const text = (value, max = 300) => (typeof value === "string" ? value.slice(0, max) : "");
const time = (value) => {
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
};

// summary.json → what the dashboard is told of it: the indicator and its description, the
// components above that aren't operational, the open incidents. Throws when it isn't one.
export function summarize(body) {
  const indicator = body?.status?.indicator;
  if (!INDICATORS.has(indicator)) throw new Error("not GitHub's status summary");
  const components = (Array.isArray(body.components) ? body.components : [])
    .filter((c) => COMPONENTS.includes(c?.name) && typeof c.status === "string")
    .filter((c) => c.status !== "operational")
    .map((c) => ({ name: c.name, status: text(c.status, 40) }));
  const incidents = (Array.isArray(body.incidents) ? body.incidents : [])
    .filter((i) => i && i.status !== "resolved" && i.status !== "postmortem")
    .slice(0, MAX_INCIDENTS)
    .map((i) => ({
      name: text(i.name) || "An incident",
      status: text(i.status, 40),
      impact: text(i.impact, 40) || null,
      startedAt: time(i.started_at) ?? time(i.created_at),
      // Its page, built from its id rather than taken as given: a link of githubstatus.com's.
      url: /^[a-z0-9]{1,40}$/i.test(i.id ?? "") ? `${INCIDENT_URL}${i.id}` : null,
    }));
  return { indicator, description: text(body.status.description), components, incidents };
}

// Before the first summary is read.
const NONE = { indicator: null, description: "", components: [], incidents: [] };

// `watched`: false off github.com (an Enterprise Server's status isn't githubstatus.com's).
// `fetch`, `now`, the timers: the tests'.
export function createGithubStatus({
  watched = true,
  url = SUMMARY_URL,
  intervalMs = INTERVAL_MS,
  fetch = globalThis.fetch,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  log = () => {},
}) {
  // The last summary read and when; the last try, and why it failed (null: it didn't).
  let last = null;
  let checkedAt = null;
  let triedAt = null;
  let failed = null;
  let timer = null;
  let stopped = false;

  async function check() {
    triedAt = now();
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { accept: "application/json" },
        redirect: "error",
      });
      if (!res.ok) {
        res.body?.cancel?.().catch(() => {});
        throw new Error(`HTTP ${res.status}`);
      }
      const body = await res.text();
      if (body.length > MAX_BYTES) throw new Error("too large");
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        throw new Error("not JSON");
      }
      last = summarize(parsed);
      checkedAt = triedAt;
      failed = null;
    } catch (failure) {
      const reason =
        failure?.name === "TimeoutError" ? "timed out" : text(failure?.message, 200) || "failed";
      // Said once when it starts failing, not at every try.
      if (failed === null) log(`GitHub's status: ${reason}${last ? ", the last one kept" : ""}`);
      failed = reason;
    }
  }

  function schedule() {
    if (stopped) return;
    timer = setTimer(() => void check().finally(schedule), intervalMs);
    timer.unref?.();
  }

  return {
    // Reads it now, then every `intervalMs`: → the first read, done.
    start() {
      if (!watched || stopped || timer) return Promise.resolve();
      const first = check();
      first.finally(schedule);
      return first;
    },
    stop() {
      stopped = true;
      if (timer) clearTimer(timer);
      timer = null;
    },
    check,
    // GET /status's answer: `failed`, not `error`, which the dashboard takes for a refusal.
    current: () =>
      watched ? { watched, checkedAt, triedAt, failed, ...(last ?? NONE) } : { watched },
  };
}
