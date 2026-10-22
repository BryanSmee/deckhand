// Each issue's conversation state, kept across listener restarts: its brainstorm
// (brainstorms.json) and the repo's own mode its session is in (modes.json).
import { respellMap } from "./spelling.mjs";
import { persistentMap, readJson, writeJsonAtomic } from "./store.mjs";

// Claude's reply keeps a brainstorm active at least this long, so an answer can follow it.
export const REPLY_GRACE_MS = 2 * 60000;

// key → { repo, number, status, deadline, timer }. "active" → "idle" once the deadline passes
// with no comment. One container per reply means nothing is held open meanwhile: idle is what
// the dashboard shows, and the next comment restores the session from its volume and says so
// to Claude. `busy(key)`: a reply is still on its way, and posting it arms the timer again.
export function createBrainstorms({ path, idleMs, busy, log, now = Date.now }) {
  const brainstorms = load();

  function load() {
    const saved = readJson(path, {});
    const map = new Map(Object.entries(saved).map(([key, b]) => [key, { ...b, timer: null }]));
    for (const [key, b] of map) if (b.status === "active") armIdle(key, b);
    return map;
  }

  function save() {
    const plain = Object.fromEntries([...brainstorms].map(([key, { timer, ...b }]) => [key, b]));
    writeJsonAtomic(path, plain);
  }

  function armIdle(key, b) {
    clearTimeout(b.timer);
    b.timer = setTimeout(
      () => {
        if (busy(key) || b.status !== "active") return;
        b.status = "idle";
        save();
        log(`${key}: brainstorm idle`);
      },
      Math.max(0, b.deadline - now()),
    );
  }

  // A comment that starts or continues the brainstorm. True when it was idle: the session
  // is restored.
  function activate(key, { repo, number }) {
    const b = brainstorms.get(key);
    const restored = b?.status === "idle";
    const next = b ?? { repo, number, timer: null };
    Object.assign(next, { status: "active", deadline: now() + idleMs });
    brainstorms.set(key, next);
    armIdle(key, next);
    save();
    return restored;
  }

  // "/stop": comments no longer reach it until a trigger line.
  function stop(key) {
    const b = brainstorms.get(key);
    clearTimeout(b.timer);
    b.status = "stopped";
    save();
  }

  // Work or another mode takes the session over: the brainstorm is over.
  function end(key) {
    const b = brainstorms.get(key);
    if (!b) return;
    clearTimeout(b.timer);
    brainstorms.delete(key);
    save();
  }

  // Claude replied: an answer may follow.
  function replied(key) {
    const b = brainstorms.get(key);
    if (b?.status !== "active") return;
    b.deadline = Math.max(b.deadline, now() + REPLY_GRACE_MS);
    armIdle(key, b);
    save();
  }

  // For the dashboard.
  function list() {
    return [...brainstorms].map(([key, { timer, ...b }]) => ({ key, ...b }));
  }

  // One spelling per repo (spelling.mjs, at a restart): the timers armed for the old keys go.
  function respell(spelled) {
    const fix = (b) => {
      clearTimeout(b.timer);
      return { ...b, repo: spelled(b.repo), timer: null };
    };
    if (!respellMap(brainstorms, spelled, fix)) return;
    for (const [key, b] of brainstorms) if (b.status === "active" && !b.timer) armIdle(key, b);
    save();
  }

  return {
    get: (key) => brainstorms.get(key),
    keys: () => [...brainstorms.keys()],
    respell,
    activate,
    stop,
    end,
    replied,
    list,
  };
}

// key → mode name: a comment without a trigger or "/mode" line goes on in that mode
// (modeOf()). Fresh modes don't change it; work, a brainstorm or another "/mode" do.
export function createIssueModes(path) {
  const modes = persistentMap(path);
  function set(key, mode) {
    if ((modes.get(key) ?? null) === mode) return;
    if (mode) modes.set(key, mode);
    else modes.delete(key);
    modes.save();
  }
  return {
    get: (key) => modes.get(key),
    has: (key) => modes.has(key),
    set,
    keys: () => [...modes.keys()],
    // One spelling per repo (spelling.mjs, at a restart).
    respell: (spelled) => respellMap(modes, spelled) && modes.save(),
  };
}
