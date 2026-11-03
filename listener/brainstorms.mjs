// Each issue's conversation state, kept across restarts and handovers in the orchestrator's
// store (lib/store-map.mjs): its brainstorm (`brainstorms`) and the repo's own mode its session is
// in (`modes`).
import { respellMap } from "./spelling.mjs";

// Claude's reply keeps a brainstorm active at least this long, so an answer can follow it.
export const REPLY_GRACE_MS = 2 * 60000;

// key → { repo, number, status, deadline }. "active" → "idle" once the deadline passes with no
// comment: the deadline is data, its timer armed again from it by the copy that loads the map.
// One container per reply means nothing is held open meanwhile: idle is what the dashboard
// shows, and the next comment restores the session from its volume and says so to Claude.
// `busy(key)`: a reply is still on its way, and posting it arms the timer again. `brainstorms`:
// the Map they are kept in (storeMap()'s); `queueSaved()`: once the queue is in the store with what
// was just queued (restart.mjs queueWritten()), which a brainstorm's end is written after.
export function createBrainstorms({
  brainstorms = new Map(),
  queueSaved = () => Promise.resolve(),
  idleMs,
  busy,
  log,
  now = Date.now,
}) {
  // key → its idle timer, in memory alone.
  const timers = new Map();
  for (const [key, b] of brainstorms) if (b.status === "active") armIdle(key);

  // `b` changed: the store is told (a value changed in place isn't seen, lib/store-map.mjs).
  const save = (key, b) => brainstorms.set(key, b);

  function armIdle(key) {
    clearTimeout(timers.get(key));
    const b = brainstorms.get(key);
    const timer = setTimeout(
      () => {
        timers.delete(key);
        const current = brainstorms.get(key);
        if (busy(key) || current?.status !== "active") return;
        save(key, { ...current, status: "idle" });
        log(`${key}: brainstorm idle`);
      },
      Math.max(0, b.deadline - now()),
    );
    timer.unref?.();
    timers.set(key, timer);
  }

  function disarm(key) {
    clearTimeout(timers.get(key));
    timers.delete(key);
  }

  // A comment that starts or continues the brainstorm. True when it was idle: the session
  // is restored.
  function activate(key, { repo, number }) {
    const b = brainstorms.get(key);
    const restored = b?.status === "idle";
    save(key, { ...(b ?? { repo, number }), status: "active", deadline: now() + idleMs });
    armIdle(key);
    return restored;
  }

  // "/stop": comments no longer reach it until a trigger line.
  function stop(key) {
    disarm(key);
    save(key, { ...brainstorms.get(key), status: "stopped" });
  }

  // Work or another mode takes the session over: the brainstorm is over. One pair: the comment
  // that ends it queued first (tasks.mjs queue(), right after modeOf() returns), then the
  // brainstorm deleted (`queueSaved()`), so an orchestrator killed in between finds the comment
  // queued, the brainstorm still there: never neither.
  function end(key) {
    if (!brainstorms.has(key)) return;
    disarm(key);
    brainstorms.delete(key, { after: queueSaved() });
  }

  // Claude replied: an answer may follow.
  function replied(key) {
    const b = brainstorms.get(key);
    if (b?.status !== "active") return;
    save(key, { ...b, deadline: Math.max(b.deadline, now() + REPLY_GRACE_MS) });
    armIdle(key);
  }

  // For the dashboard.
  function list() {
    return [...brainstorms].map(([key, b]) => ({ key, ...b }));
  }

  // One spelling per repo (spelling.mjs, at a restart): the timers armed for the old keys go.
  function respell(spelled) {
    const fix = (b) => ({ ...b, repo: spelled(b.repo) });
    const before = [...brainstorms.keys()];
    if (!respellMap(brainstorms, spelled, fix)) return;
    for (const key of before) if (!brainstorms.has(key)) disarm(key);
    for (const [key, b] of brainstorms) if (b.status === "active" && !timers.has(key)) armIdle(key);
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
// (modeOf()). Fresh modes don't change it; work, a brainstorm or another "/mode" do. `modes`: the
// Map they are kept in (storeMap()'s).
export function createIssueModes(modes = new Map()) {
  function set(key, mode) {
    if ((modes.get(key) ?? null) === mode) return;
    if (mode) modes.set(key, mode);
    else modes.delete(key);
  }
  return {
    get: (key) => modes.get(key),
    has: (key) => modes.has(key),
    set,
    keys: () => [...modes.keys()],
    // One spelling per repo (spelling.mjs, at a restart).
    respell: (spelled) => respellMap(modes, spelled),
  };
}
