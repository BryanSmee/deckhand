// Each task's last policy decisions, for its page on the dashboard (issue #295): what the
// operator's and the repo's policies (policies.mjs) said of its pull request's review, fix run
// and auto-merge (reviews.mjs), by task key ("org/repo#12", the issue a pull request closes,
// else "org/repo#pr-3"). Only decisions a policy was asked for: none anywhere, nothing kept.
// Kept in decisions.json, so a refused merge still shows after a restart.
import { respellMap, sameTask } from "./spelling.mjs";
import { persistentMap } from "./store.mjs";

// A task's newest decisions, and how long a task's are kept after its last one.
export const MAX_DECISIONS = 10;
const KEEP_MS = 90 * 24 * 3600_000;

// `now`: the clock, for forgetting old tasks.
export function createDecisions({ path, now = Date.now } = {}) {
  const decisions = persistentMap(path);

  // `entry`: { decision, rule, denied, messages, pr, at }, the newest first.
  function record(key, entry) {
    const cutoff = now() - KEEP_MS;
    for (const [k, list] of decisions) if ((list[0]?.at ?? 0) < cutoff) decisions.delete(k);
    const before = decisions.get(key) ?? [];
    decisions.set(key, [{ at: now(), ...entry }, ...before].slice(0, MAX_DECISIONS));
    decisions.save();
  }

  // Under any spelling of its repo: a key spelled otherwise at restart is the same task.
  function get(key) {
    if (decisions.has(key)) return decisions.get(key);
    for (const [k, list] of decisions) if (sameTask(k, key)) return list;
    return [];
  }

  // Rekeyed with spelled() (restart.mjs unifySpellings()); two spellings' lists merged.
  function respell(spelled) {
    const merge = (a, b) =>
      [...a, ...b].sort((x, y) => (y.at ?? 0) - (x.at ?? 0)).slice(0, MAX_DECISIONS);
    if (respellMap(decisions, spelled, undefined, merge)) decisions.save();
  }

  return { record, get, keys: () => [...decisions.keys()], respell };
}
