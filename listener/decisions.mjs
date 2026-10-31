// Each task's last policy decisions, for its page on the dashboard (issue #295): what the
// operator's and the repo's policies (policies.mjs) said of its pull request's review, fix run
// and auto-merge (reviews.mjs), by task key ("org/repo#12", the issue a pull request closes,
// else "org/repo#pr-3"). Only decisions a policy was asked for: none anywhere, nothing kept.
// Kept in decisions.json, so a refused merge still shows after a restart. Its last `/mode
// policy` dry run too (issue #324), in a file of its own: a dry run is no decision.
import { redact } from "../lib/redact.mjs";
import { respellMap, sameTask } from "./spelling.mjs";
import { persistentMap } from "../lib/files.mjs";

// A task's newest decisions, and how long a task's are kept after its last one.
export const MAX_DECISIONS = 10;
const KEEP_MS = 90 * 24 * 3600_000;

// The newest decisions that keep the input their rules saw, and its size at most (JSON
// characters): with 10 decisions a task, decisions.json stays small.
export const MAX_INPUTS = 3;
export const MAX_INPUT = 8 * 1024;

// `now`: the clock, for forgetting old tasks; `secrets()`: what redaction hides of an input
// (secrets.mjs); `dryRunPath`: where the last dry runs are kept.
export function createDecisions({ path, dryRunPath, now = Date.now, secrets = () => [] } = {}) {
  const decisions = persistentMap(path);
  const dryRuns = persistentMap(dryRunPath);

  // `entry`: { decision, rule, denied, messages, pr, gates, layers, input }, the newest first
  // (`layers`: what each policy layer said, policies.mjs evaluated()). Its input redacted and
  // capped (keptInput()); the older ones lose theirs past MAX_INPUTS.
  function record(key, entry) {
    forgetOld();
    const before = decisions.get(key) ?? [];
    const { input, ...rest } = entry;
    const kept = input === undefined ? rest : { ...rest, ...keptInput(input, secrets()) };
    decisions.set(key, trim([{ at: now(), ...kept }, ...before]));
    decisions.save();
  }

  // `/mode policy` on the task's pull request: { by, url, denials }, `url` its reply's. The
  // last one only.
  function recordDryRun(key, { by = null, url = null, denials = 0 }) {
    forgetOld();
    dryRuns.set(key, { dryRun: true, by, at: now(), denials, url });
    dryRuns.save();
  }

  function forgetOld() {
    const cutoff = now() - KEEP_MS;
    for (const [k, list] of decisions) if ((list[0]?.at ?? 0) < cutoff) decisions.delete(k);
    for (const [k, run] of dryRuns) if ((run.at ?? 0) < cutoff) dryRuns.delete(k);
  }

  // Under any spelling of its repo: a key spelled otherwise at restart is the same task.
  function get(key) {
    if (decisions.has(key)) return decisions.get(key);
    for (const [k, list] of decisions) if (sameTask(k, key)) return list;
    return [];
  }

  function dryRun(key) {
    if (dryRuns.has(key)) return dryRuns.get(key);
    for (const [k, run] of dryRuns) if (sameTask(k, key)) return run;
    return null;
  }

  // Rekeyed with spelled() (restart.mjs unifySpellings()); two spellings' lists merged, the
  // later dry run kept.
  function respell(spelled) {
    const merge = (a, b) => trim([...a, ...b].sort((x, y) => (y.at ?? 0) - (x.at ?? 0)));
    if (respellMap(decisions, spelled, undefined, merge)) decisions.save();
    const later = (a, b) => ((a.at ?? 0) >= (b.at ?? 0) ? a : b);
    if (respellMap(dryRuns, spelled, undefined, later)) dryRuns.save();
  }

  return { record, recordDryRun, get, dryRun, keys: () => [...decisions.keys()], respell };
}

// At most MAX_DECISIONS, the input on the newest MAX_INPUTS only.
function trim(list) {
  return list.slice(0, MAX_DECISIONS).map((d, i) => {
    if (i < MAX_INPUTS || !("input" in d)) return d;
    const { input, truncated, ...rest } = d;
    return rest;
  });
}

// What a decision keeps of the input its rules saw → { input } or { input, truncated: true }:
// every string redacted of `secrets`, then cut to MAX_INPUT, the changed files first, then the
// review's findings, then the checks. Too big still: none, truncated.
export function keptInput(input, secrets) {
  const doc = redactAll(input, secrets);
  const fits = () => JSON.stringify(doc).length <= MAX_INPUT;
  if (fits()) return { input: doc };
  for (const [owner, field] of [
    [doc?.pr, "files"],
    [doc?.review, "findings"],
    [doc, "checks"],
  ]) {
    const all = owner?.[field];
    if (!Array.isArray(all) || !all.length) continue;
    // The most that fit, searched by halves: a pull request lists up to 3000 files.
    let [lo, hi] = [0, all.length];
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      owner[field] = all.slice(0, mid);
      if (fits()) lo = mid;
      else hi = mid - 1;
    }
    owner[field] = all.slice(0, lo);
    if (fits()) return { input: doc, truncated: true };
  }
  return { input: null, truncated: true };
}

// A copy of `value` with its strings redacted, keys included.
function redactAll(value, secrets) {
  if (typeof value === "string") return redact(value, secrets);
  if (Array.isArray(value)) return value.map((v) => redactAll(v, secrets));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [redact(k, secrets), redactAll(v, secrets)]),
    );
  }
  return value;
}
