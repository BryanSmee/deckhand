// The review loop on the workflow engine (#1041): what reviews.mjs needs of a workflow on
// `ready` (workflow-format.mjs) beside its steps' own code. Pure: no state, no I/O.
//
// The built-in loop is the workflow a repo's `review:` block compiles to (reviewWorkflow()); a
// repo's own `.deckhand/workflows/` file on `ready` replaces it, its steps standing for the keys
// they turn on (impliedSettings()), the rest of the `review:` block (tolerance, waits, merge
// method, follow-ups, the reviews' agent) read as before.
import { SEVERITIES } from "./severities.mjs";
import { enclosing } from "./workflow-engine.mjs";

// The event the review loop's workflows run on.
export const READY = "ready";

// Flattened: every step of `steps`, nested ones too.
const flat = (steps) =>
  steps.flatMap((s) => [s, ...flat(s.then ?? []), ...flat(s.else ?? []), ...flat(s.repeat ?? [])]);

// The most rounds a loop around a `fix` step of `steps` allows: the fix runs `review.fix`'s
// number stands for (1 for a fix step outside any loop), 0 without one.
function fixRounds(steps, rounds = 1) {
  let most = 0;
  for (const s of steps) {
    if (s.run === "fix") most = Math.max(most, rounds);
    for (const inner of [s.then, s.else])
      if (inner) most = Math.max(most, fixRounds(inner, rounds));
    if (s.repeat) most = Math.max(most, fixRounds(s.repeat, Math.max(rounds, s.max?.rounds ?? 1)));
  }
  return most;
}

// The repo's settings as the steps of its own workflow on `ready` (`workflow`, a file of the
// repo's) turn the loop's keys on: the review automatic (`on: ready`), `fix` with its rounds
// from a `run: fix` step, `merge` from a `run: merge`, `ci: wait` from a `run: ci`. The built-in
// one (no file) leaves them as they are: it was compiled from them.
export function impliedSettings(settings, workflow) {
  if (!workflow?.file || !settings?.review) return settings;
  const steps = flat(workflow.steps);
  const has = (run) => steps.some((s) => s.run === run);
  const rounds = fixRounds(workflow.steps);
  return {
    ...settings,
    review: {
      ...settings.review,
      on: "ready",
      fix: rounds > 0,
      fixRounds: rounds,
      merge: has("merge"),
      ci: has("ci") ? "wait" : false,
      // Its steps' instructions, trusted as `review.instructions` is: a pull request that
      // changes one waits for a human (review-merge.mjs trustedFile()).
      stepInstructions: steps.map((s) => s.instructions).filter(Boolean),
    },
  };
}

// The config's warnings (parseRepoConfig()'s) with the repo's workflow on `ready`: those saying
// the `review:` block leaves `merge`, `ci` or `ci_fix` off hold only without a file there. With
// one, its steps decide (impliedSettings()): the warning goes when they turn the key on, and
// names the missing step when they don't (#1140). A key the block turns on that the steps turn
// off (`fix: true` without a `run: fix` step) gets that warning too, the parse having none to
// reword (#1143).
const OFF = [
  ["review.merge: needs `review.on: ready`", "merge", "nothing is merged"],
  ["review.ci: needs `review.on: ready`", "ci", "nothing waits for CI"],
  ["review.ci_fix: needs `review.fix`", "fix", "no CI fix run starts"],
];
const DROPPED = [
  ["fix", "no fix run starts"],
  ["merge", "nothing is merged"],
  ["ci", "nothing waits for CI"],
];
const missing = (key, step, what) =>
  `review.${key}: the workflow on \`ready\` has no \`run: ${step}\` step, ${what}`;
export function loopWarnings(warnings, settings, workflow) {
  if (!workflow?.file || !settings?.review) return warnings;
  const review = impliedSettings(settings, workflow).review;
  const kept = warnings.flatMap((w) => {
    const off = OFF.find(([said]) => w.startsWith(said));
    if (!off) return [w];
    const [said, step, what] = off;
    if (review[step]) return [];
    return [missing(said.slice("review.".length, said.indexOf(":")), step, what)];
  });
  const dropped = DROPPED.filter(
    ([key]) =>
      settings.review[key] && !review[key] && !kept.some((w) => w.startsWith(`review.${key}:`)),
  );
  return [...kept, ...dropped.map(([key, what]) => missing(key, key, what))];
}

// What `severity` reads of the last review (review-parse.mjs's): its most severe finding, "none"
// without findings, null without a review.
export function severityOf(review) {
  if (!review) return null;
  return SEVERITIES.find((s) => review.findings?.some((f) => f.severity === s)) ?? "none";
}

// The step of kind `run` an ended run of that kind goes on from, for the engine's place() when
// the instance doesn't wait there: with `afterFix` (the pull request had a fix run) the first
// inside a loop, else the first. → at(ops), giving -1 without one.
export function stepOf(run, afterFix) {
  return (ops) => {
    const all = ops.flatMap((op, i) => (op.op === "act" && op.step.run === run ? [i] : []));
    const looped = all.filter((i) => enclosing(ops, i) !== null);
    return (afterFix && looped.length ? looped[0] : all[0]) ?? -1;
  };
}

// What a step says of its run (workflow-format.mjs STEP_OPTIONS), on the item it queues
// (`workflowStep`, modes.mjs stepSettings()): null when it says nothing.
export function stepRun(step) {
  const keys = ["agent", "model", "effort", "instructions"].filter((k) => step?.[k]);
  return keys.length ? Object.fromEntries(keys.map((k) => [k, step[k]])) : null;
}
