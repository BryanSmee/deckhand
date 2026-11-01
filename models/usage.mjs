// How much of each plan the runs have used (#486): the 5-hour and weekly limits of a Claude plan,
// a ChatGPT plan's for Codex, a Google AI plan's for the Antigravity CLI, for the dashboard's
// bars (GET /usage, the orchestrator's api/state `plans`). Only numbers and times: nothing of a
// credential, nor any header's value but those parsed.
//
// Read two ways:
//   passively, from the plans' own answers to the runs' calls (anthropic.mjs, openai.mjs): their
//   rate limit headers, which cost nothing;
//   by asking the plan, while a dashboard is open (GET /usage?poll=1, every POLL_MS at most, for
//   every copy): Claude's OAuth usage call, ChatGPT's and the Antigravity CLI's quota calls. They
//   aren't documented and may change: a poll that fails is only logged, the passive readings
//   stay, and the next one waits FAILED_MS.
//
// A reading parsed here never makes up a value: a header missing or garbled leaves its window out.

// The plans, in the order the dashboard shows them, and their names there.
export const PLANS = { claude: "Claude", codex: "Codex", antigravity: "Antigravity" };

// How often a dashboard's poll asks a plan, for every copy, and how long after a failed one.
export const POLL_MS = 5 * 60_000;
export const FAILED_MS = 30 * 60_000;
// How long a plan's call for its usage may take.
const POLL_TIMEOUT_MS = 10_000;
// How long a reading is kept in the store: past a week's window, nothing of it is still true.
const KEEP_MS = 8 * 24 * 3600_000;

const usageKey = (plan) => `usage:${plan}`;
const pollKey = (plan) => `usage:${plan}:poll`;

// A fraction of the limit used, 0–1, from `value` out of `scale` (1, or 100 for a percentage);
// null when it isn't a number.
function fraction(value, scale) {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value) / scale;
  return Number.isFinite(n) && n >= 0 ? Math.min(n, 1) : null;
}

// A time in ms from seconds since the epoch, or an RFC 3339 text; null when it is neither.
function timeOf(value) {
  if (typeof value === "number" || /^\d+(\.\d+)?$/.test(String(value ?? ""))) {
    const n = Number(value);
    return n > 0 ? Math.round(n * 1000) : null;
  }
  const t = Date.parse(String(value ?? ""));
  return Number.isFinite(t) ? t : null;
}

// A window, or null without a usable fraction. Its reset may be unknown (null).
const windowOf = (name, used, resetsAt, label) =>
  used === null ? null : { name, ...(label && { label }), used, resetsAt: resetsAt ?? null };

// Claude's windows, by the names its headers and its usage call give them, in the order shown:
// the 5-hour and weekly limits first, then the weekly ones of a model.
const CLAUDE_WINDOWS = [
  ["5h", "five_hour"],
  ["7d", "seven_day"],
  ["7d_opus", "seven_day_opus"],
  ["7d_sonnet", "seven_day_sonnet"],
];

// A Claude plan's answer's windows: `anthropic-ratelimit-unified-<5h|7d…>-utilization` (0–1)
// and `…-reset` (seconds since the epoch), what Claude Code's /usage reads.
export function claudeWindows(headers) {
  const h = (name) => headers[`anthropic-ratelimit-unified-${name}`];
  return CLAUDE_WINDOWS.map(([name]) =>
    windowOf(name, fraction(h(`${name}-utilization`), 1), timeOf(h(`${name}-reset`))),
  ).filter(Boolean);
}

// Which of Claude's windows a 429 is about: its representative claim ("five_hour"…), else the
// one whose reset is the limit's.
function claudeLimited(headers, windows, until) {
  const claim = headers["anthropic-ratelimit-unified-representative-claim"];
  const named = CLAUDE_WINDOWS.find(([, long]) => long === claim)?.[0];
  if (named) return named;
  return windows.find((w) => w.resetsAt !== null && Math.abs(w.resetsAt - until) < 1000)?.name;
}

// Claude's OAuth usage call's answer: { five_hour: { utilization: 0–100, resets_at }, … }.
export function claudePolled(json) {
  return CLAUDE_WINDOWS.map(([name, long]) =>
    windowOf(name, fraction(json?.[long]?.utilization, 100), timeOf(json?.[long]?.resets_at)),
  ).filter(Boolean);
}

// A window's name from its length in minutes: 300 → "5h", 10080 → "7d".
function lengthName(minutes) {
  const m = Number(minutes);
  if (!Number.isInteger(m) || m <= 0) return null;
  if (m % 1440 === 0) return `${m / 1440}d`;
  if (m % 60 === 0) return `${m / 60}h`;
  return `${m}m`;
}

// A ChatGPT plan's answer's windows, as Codex reads them: `x-codex-<primary|secondary>-used-
// percent` (0–100), `…-window-minutes`, and `…-reset-at` (seconds since the epoch) or, older,
// `…-reset-after-seconds`. Named by their length when it is given.
export function codexWindows(headers, now = Date.now()) {
  return ["primary", "secondary"]
    .map((which) => {
      const h = (name) => headers[`x-codex-${which}-${name}`];
      const after = Number(h("reset-after-seconds"));
      const resetsAt =
        timeOf(h("reset-at")) ??
        (h("reset-after-seconds") !== undefined && Number.isFinite(after) && after >= 0
          ? now + after * 1000
          : null);
      return windowOf(
        lengthName(h("window-minutes")) ?? which,
        fraction(h("used-percent"), 100),
        resetsAt,
      );
    })
    .filter(Boolean);
}

// ChatGPT's usage call's answer: { rate_limit: { primary_window: { used_percent,
// limit_window_seconds, reset_at, reset_after_seconds }, secondary_window } }.
export function codexPolled(json, now = Date.now()) {
  return ["primary", "secondary"]
    .map((which) => {
      const w = json?.rate_limit?.[`${which}_window`];
      if (!w || typeof w !== "object") return null;
      const seconds = Number(w.limit_window_seconds);
      const after = Number(w.reset_after_seconds);
      const resetsAt =
        timeOf(w.reset_at) ??
        (w.reset_after_seconds != null && Number.isFinite(after) && after >= 0
          ? now + after * 1000
          : null);
      return windowOf(
        (seconds > 0 && seconds % 60 === 0 && lengthName(seconds / 60)) || which,
        fraction(w.used_percent, 100),
        resetsAt,
      );
    })
    .filter(Boolean);
}

// The Antigravity CLI's model list (fetchAvailableModels): { models: { <id>: { displayName,
// quotaInfo: { remainingFraction, resetTime } } } }, a quota per model. Models that share one
// (the same fraction left and reset) are one window, under the first one's name; the most used
// first.
export function antigravityPolled(json) {
  const seen = new Map();
  for (const [id, model] of Object.entries(json?.models ?? {})) {
    const quota = model?.quotaInfo;
    if (!quota || typeof quota !== "object") continue;
    // A quota spent has no remainingFraction (proto3's JSON leaves zeros out), only its reset.
    const left = fraction(quota.remainingFraction ?? (quota.resetTime ? 0 : undefined), 1);
    if (left === null || !/^[\w.-]{1,80}$/.test(id)) continue;
    const resetsAt = timeOf(quota.resetTime);
    const key = `${left}/${resetsAt}`;
    if (seen.has(key)) continue;
    const label = typeof model.displayName === "string" ? model.displayName.slice(0, 60) : null;
    seen.set(key, windowOf(id, 1 - left, resetsAt, label));
  }
  return [...seen.values()].sort((a, b) => b.used - a.used).slice(0, 6);
}

// `fetch(url, init)` → the JSON of a plan's usage call, throwing on anything but a 200.
async function askJson(fetch, url, init) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(POLL_TIMEOUT_MS) });
  if (res.status !== 200) throw new Error(`answered ${res.status}`);
  return res.json();
}

// The plans' usage calls, each `async () → windows`, given what they need: the Claude plan's
// token and Anthropic's address; the ChatGPT and Google AI logins' headers (chatgpt.mjs,
// antigravity-login.mjs headers()), and where their calls go.
export function claudePoll({ token, upstream = "https://api.anthropic.com", fetch }) {
  const url = new URL("api/oauth/usage", `${upstream.replace(/\/+$/, "")}/`);
  return async () =>
    claudePolled(
      await askJson(fetch, url, {
        headers: { authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" },
      }),
    );
}

export function codexPoll({ login, chatgptUrl, fetch, now = Date.now }) {
  // https://chatgpt.com/backend-api/codex → https://chatgpt.com/backend-api/wham/usage
  const url = new URL("wham/usage", `${chatgptUrl.replace(/\/+$/, "").replace(/\/codex$/, "")}/`);
  return async () =>
    codexPolled(await askJson(fetch, url, { headers: await login.headers() }), now());
}

export function antigravityPoll({ login, host, fetch }) {
  const call = async (method, body) =>
    askJson(fetch, `${host}/v1internal:${method}`, {
      method: "POST",
      headers: { ...(await login.headers()), "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  let project = null;
  return async () => {
    // The plan's project, as `agy` asks for it first; without one, the call takes none.
    if (!project) {
      const found = await call("loadCodeAssist", { metadata: { ideType: "ANTIGRAVITY" } }).catch(
        () => null,
      );
      const id = found?.cloudaicompanionProject;
      project = typeof id === "string" ? id : (id?.id ?? null);
    }
    return antigravityPolled(await call("fetchAvailableModels", project ? { project } : {}));
  };
}

// `windows` over `before`'s, by name: a window this reading doesn't give (a model's weekly
// limit, which only the usage call says) stays until it resets. Each its own `at`.
function merged(before = [], windows, at, now) {
  const fresh = new Map(windows.map((w) => [w.name, { ...w, at }]));
  const kept = before.filter(
    (w) => !fresh.has(w.name) && (w.resetsAt === null || w.resetsAt > now),
  );
  // In the reading's order, those kept after.
  return [...fresh.values(), ...kept];
}

// What a copy writes is what changed (a percent's worth of use, a reset, a limit), or how
// recent the reading is, once a minute: the runs' answers come many a minute.
const FRESH_MS = 60_000;
const newest = (windows) => Math.max(0, ...windows.map((w) => w.at ?? 0));
const shape = (entry) =>
  JSON.stringify([
    entry.limitedUntil,
    entry.windows.map((w) => [w.name, Math.round(w.used * 100), w.resetsAt]),
  ]);

// `plans`: { claude, codex, antigravity } → true for a plan the operator set, or its usage call
// (claudePoll()…); absent or false, a plan not set. `store`: the service's, every copy's.
export function createUsage({ plans = {}, store, now = Date.now, log = () => {} }) {
  const set = Object.keys(PLANS).filter((plan) => plans[plan]);
  const polling = new Map(); // plan → the poll under way in this copy
  const saves = new Set(); // the readings being written

  async function save(plan, change) {
    const before = (await store.get(usageKey(plan))) ?? { windows: [], limitedUntil: null };
    const after = change(before);
    const recent = newest(after.windows) - newest(before.windows) < FRESH_MS;
    if (recent && shape(after) === shape(before)) return;
    await store.set(usageKey(plan), after, { ttlMs: KEEP_MS });
  }

  // A reading of `plan`'s windows. `limitedUntil`: a 429's reset, the plan limited till then;
  // undefined, left as it was; null, an answer that got through. `hit`: the window that limit
  // is about, full until then.
  async function seen(plan, windows, { limitedUntil, hit } = {}) {
    if (!set.includes(plan)) return;
    if (!windows.length && limitedUntil === undefined) return;
    const at = now();
    const saving = save(plan, (before) => {
      let after = merged(before.windows, windows, at, at);
      if (hit && limitedUntil) {
        const known = after.some((w) => w.name === hit);
        after = known
          ? after.map((w) => (w.name === hit ? { ...w, used: 1, resetsAt: limitedUntil } : w))
          : [...after, { name: hit, used: 1, resetsAt: limitedUntil, at }];
      }
      return {
        windows: after,
        limitedUntil: limitedUntil === undefined ? (before.limitedUntil ?? null) : limitedUntil,
      };
    })
      .catch((error) => log(`Usage: ${PLANS[plan]}'s (${error.message})`))
      .finally(() => saves.delete(saving));
    saves.add(saving);
    return saving;
  }

  // Answers to the runs' calls (anthropic.mjs, openai.mjs answered()), the plan's only.
  function claudeAnswered(status, headers, reset) {
    const windows = claudeWindows(headers);
    if (status === 429 && reset) {
      return seen("claude", windows, {
        limitedUntil: reset,
        hit: claudeLimited(headers, windows, reset),
      });
    }
    return seen("claude", windows, status < 400 ? { limitedUntil: null } : {});
  }
  function codexAnswered(status, headers) {
    const windows = codexWindows(headers, now());
    if (status === 429) {
      // The window spent, if the answer says which: limited until it resets.
      const full = windows.filter((w) => w.used >= 1 && w.resetsAt !== null);
      const until = full.length ? Math.max(...full.map((w) => w.resetsAt)) : null;
      return seen("codex", windows, until ? { limitedUntil: until } : {});
    }
    return seen("codex", windows, status < 400 ? { limitedUntil: null } : {});
  }

  // One poll of `plan`, for every copy every POLL_MS at most, FAILED_MS after a failure; not
  // when the runs' answers read it lately. Never throws.
  async function poll(plan, entry) {
    const ask = plans[plan];
    if (typeof ask !== "function" || polling.has(plan)) return;
    if (now() - newest(entry?.windows ?? []) < POLL_MS) return;
    const run = (async () => {
      if (!(await store.setIfAbsent(pollKey(plan), now(), { ttlMs: POLL_MS }))) return;
      try {
        await seen(plan, await ask());
      } catch (error) {
        log(
          `Usage: ${PLANS[plan]}'s usage call failed (${error.message}): asked again in ${FAILED_MS / 60_000} minutes`,
        );
        await store.set(pollKey(plan), now(), { ttlMs: FAILED_MS });
      }
    })()
      .catch((error) => log(`Usage: ${PLANS[plan]}'s poll (${error.message})`))
      .finally(() => polling.delete(plan));
    polling.set(plan, run);
    return run;
  }

  // The dashboard's (GET /usage): each plan set, with its windows read so far (none yet: an
  // empty list), `limited` while a 429's reset is ahead. `poll`: a dashboard is open, the plans
  // not read lately are asked, in the background (the next read has their answer).
  async function read({ poll: polled = false } = {}) {
    const plansRead = [];
    for (const plan of set) {
      const entry = await store.get(usageKey(plan));
      if (polled) poll(plan, entry);
      const windows = (entry?.windows ?? []).map(({ name, label, used, resetsAt, at }) => ({
        name,
        ...(label && { label }),
        used,
        resetsAt,
        at,
      }));
      plansRead.push({
        plan,
        label: PLANS[plan],
        windows,
        updatedAt: windows.length ? Math.max(...windows.map((w) => w.at)) : null,
        limited: Boolean(entry?.limitedUntil && entry.limitedUntil > now()),
        limitedUntil: entry?.limitedUntil && entry.limitedUntil > now() ? entry.limitedUntil : null,
      });
    }
    return plansRead;
  }

  // The polls and writes under way, for the tests.
  const settled = async () => {
    await Promise.all(polling.values());
    await Promise.all(saves);
  };

  return { seen, claudeAnswered, codexAnswered, read, settled, plans: set };
}
