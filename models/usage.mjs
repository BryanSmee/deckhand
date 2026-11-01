// How much of each plan the runs have used (#486): the 5-hour and weekly limits of a Claude plan,
// a ChatGPT plan's for Codex, a Google AI plan's for the Antigravity CLI, for the dashboard's
// bars (GET /usage, the orchestrator's api/state `plans`). Only numbers and times: nothing of a
// credential, nor any header's value but those parsed.
//
// Read two ways:
//   passively, from the plans' own answers to the runs' calls (anthropic.mjs, openai.mjs): their
//   rate limit headers, which cost nothing;
//   by asking the plan, while a dashboard is open (GET /usage?poll=1, every POLL_MS at most, for
//   every copy): Claude's OAuth usage call (refused to a `claude setup-token` token: then never
//   again, claudePoll()), ChatGPT's and the Antigravity CLI's quota calls (skipped while their
//   login is due for a refresh). They aren't documented and may change: a poll that fails is
//   only logged, the passive readings stay, and the next one waits FAILED_MS.
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

// `fetch(url, init)` → the JSON of a plan's usage call, throwing on anything but a 200 (the
// error's `status`, the answer's).
async function askJson(fetch, url, init) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(POLL_TIMEOUT_MS) });
  if (res.status !== 200) {
    throw Object.assign(new Error(`answered ${res.status}`), { status: res.status });
  }
  return res.json();
}

// A poll that can't work with this credential, whatever the time: not asked again by this
// copy (a new credential means a restart).
export class LastingRefusal extends Error {}

// The plans' usage calls, each `async () → windows`, or null when it skipped this time, given
// what they need: the Claude plan's token and Anthropic's address; the ChatGPT and Google AI
// logins (chatgpt.mjs, antigravity-login.mjs), and where their calls go.
//
// Claude's needs the token's `user:profile` scope, which a `claude setup-token` token (what
// docs/setup.md has CLAUDE_CODE_OAUTH_TOKEN be) doesn't have: refused (401, 403), it is a
// LastingRefusal, and the Claude plan's bars come from the runs' answers alone.
export function claudePoll({ token, upstream = "https://api.anthropic.com", fetch }) {
  const url = new URL("api/oauth/usage", `${upstream.replace(/\/+$/, "")}/`);
  return async () => {
    let json;
    try {
      json = await askJson(fetch, url, {
        headers: { authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" },
      });
    } catch (error) {
      if (error.status === 401 || error.status === 403) {
        throw new LastingRefusal(
          `${error.message}: the token lacks the user:profile scope, as one from \`claude setup-token\` does, so only the runs' answers say the plan's usage`,
        );
      }
      throw error;
    }
    return claudePolled(json);
  };
}

// A login's headers, unless it is due for a refresh (logins.mjs current()): a poll of an idle
// plan mustn't spend a refresh token, nor start the Antigravity CLI's refresh container. The
// next run's call refreshes it, and the poll after that goes.
async function loginHeaders(login) {
  return login.current ? login.current() : login.headers();
}

export function codexPoll({ login, chatgptUrl, fetch, now = Date.now }) {
  // https://chatgpt.com/backend-api/codex → https://chatgpt.com/backend-api/wham/usage
  const url = new URL("wham/usage", `${chatgptUrl.replace(/\/+$/, "").replace(/\/codex$/, "")}/`);
  return async () => {
    const headers = await loginHeaders(login);
    if (!headers) return null;
    return codexPolled(await askJson(fetch, url, { headers }), now());
  };
}

export function antigravityPoll({ login, host, fetch }) {
  const call = async (method, body, headers) =>
    askJson(fetch, `${host}/v1internal:${method}`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  let project = null;
  return async () => {
    const headers = await loginHeaders(login);
    if (!headers) return null;
    // The plan's project, as `agy` asks for it first; without one, the call takes none.
    if (!project) {
      const found = await call(
        "loadCodeAssist",
        { metadata: { ideType: "ANTIGRAVITY" } },
        headers,
      ).catch(() => null);
      const id = found?.cloudaicompanionProject;
      project = typeof id === "string" ? id : (id?.id ?? null);
    }
    return antigravityPolled(
      await call("fetchAvailableModels", project ? { project } : {}, headers),
    );
  };
}

// The windows' order, whichever reading gave them: the main ones first (the dashboard's header
// shows those), then a model's. Others (the Antigravity CLI's, the most used first) after them,
// in their reading's order.
const ORDER = [
  "5h",
  "7d",
  ...CLAUDE_WINDOWS.slice(2).map(([name]) => name),
  "primary",
  "secondary",
];
const rank = (w) => (ORDER.includes(w.name) ? ORDER.indexOf(w.name) : ORDER.length);

// `windows` over `before`'s, by name: a window this reading doesn't give (a model's weekly
// limit, which only the usage call says) stays until it resets. Each its own `at`. `replace`:
// a usage call's reading, which gives them all: none of `before`'s is kept (the Antigravity
// CLI's models sharing a quota change from one to the next).
function merged(before = [], windows, at, now, replace = false) {
  const fresh = new Map(windows.map((w) => [w.name, { ...w, at }]));
  const kept = replace
    ? []
    : before.filter((w) => !fresh.has(w.name) && (w.resetsAt === null || w.resetsAt > now));
  // A stable sort: those of the same rank in their reading's order, those kept after.
  return [...fresh.values(), ...kept].sort((a, b) => rank(a) - rank(b));
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
  const refused = new Set(); // the plans whose usage call can't work with their credential

  // `change(before)` → the entry to write, over the stored one: written only if no other copy
  // changed it meanwhile (a 429's limit mustn't be lost to another call's answer), else read and
  // changed again.
  async function save(plan, change) {
    for (;;) {
      const raw = await store.get(usageKey(plan));
      const before = raw ?? { windows: [], limitedUntil: null };
      const after = change(before);
      const recent = newest(after.windows) - newest(before.windows) < FRESH_MS;
      if (recent && shape(after) === shape(before)) return;
      if (await store.compareAndSet(usageKey(plan), raw, after, { ttlMs: KEEP_MS })) return;
    }
  }

  // A reading of `plan`'s windows. `limitedUntil`: a 429's reset, the plan limited till then;
  // undefined, left as it was; null, an answer that got through. `hit`: the window that limit
  // is about, full until then. `polled`: a usage call's, the plan's whole list.
  async function seen(plan, windows, { limitedUntil, hit, polled = false } = {}) {
    if (!set.includes(plan)) return;
    if (!windows.length && limitedUntil === undefined) return;
    const at = now();
    const saving = save(plan, (before) => {
      let after = merged(before.windows, windows, at, at, polled);
      if (hit && limitedUntil) {
        const known = after.some((w) => w.name === hit);
        after = known
          ? after.map((w) => (w.name === hit ? { ...w, used: 1, resetsAt: limitedUntil } : w))
          : merged(after, [{ name: hit, used: 1, resetsAt: limitedUntil }], at, at);
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

  // One poll of `plan`, for every copy every POLL_MS at most, FAILED_MS after a failure, never
  // again after a LastingRefusal; not when the runs' answers read it lately. Never throws.
  async function poll(plan, entry) {
    const ask = plans[plan];
    if (typeof ask !== "function" || polling.has(plan) || refused.has(plan)) return;
    if (now() - newest(entry?.windows ?? []) < POLL_MS) return;
    const run = (async () => {
      if (!(await store.setIfAbsent(pollKey(plan), now(), { ttlMs: POLL_MS }))) return;
      try {
        const windows = await ask();
        if (windows) await seen(plan, windows, { polled: true });
      } catch (error) {
        if (error instanceof LastingRefusal) {
          refused.add(plan);
          log(`Usage: ${PLANS[plan]}'s usage call refused (${error.message}): not asked again`);
          return;
        }
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
