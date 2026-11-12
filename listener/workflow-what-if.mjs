// The editor's what-if dry run (#1042, stage 4 of #899): an edited workflow driven through the
// engine itself (workflow-engine.mjs), in memory, on a past pull request. Its recorded history
// (recordedHistory(): the review loop's rounds, fix runs, CI stop and merge in its `reviews`
// entry, and the policies' refusals in its decisions) answers each step for as long as it
// agrees with what the pull request did; at the first step the pull request never took (the
// divergence), the outcomes come from the user's picks instead, one per step, and the next step
// without one is asked. Pure: the facts it reads of GitHub (the files, the labels) are given.
// Nothing is queued, posted or asked of the policies: a step's outcome is the history's, the
// user's, or one the code decides for sure (a fix run with nothing blocking starts nothing).
import { SEVERITIES } from "./severities.mjs";
import { createEngine, facts as factsOf } from "./workflow-engine.mjs";

// What a step of each kind may end with, as the user picks it. `ci`: the CI step passed (or had
// no run, or ran out of time: the steps after it go on), or failed (its CI fix runs out: the
// event stops there). `review`: its most severe finding, `none` for none; refused (deny_review):
// nothing more runs. `fix`: pushed (its review goes on), nothing-pushed (the event stops), none
// (no fix run started: the loop it is in ends). `merge`: merged (the pull request closes), or
// refused (the comment saying why not, and the steps after it go on). `rebase`: rebased, or
// refused (the "No rebase run" comment).
export const OUTCOMES = {
  ci: ["passed", "failed"],
  review: ["none", ...[...SEVERITIES].reverse(), "refused"],
  fix: ["pushed", "nothing-pushed", "none"],
  merge: ["merged", "refused"],
  rebase: ["rebased", "refused"],
};

// The most steps one dry run takes: loops are bounded already, this bounds a bug.
const MAX_STEPS = 200;
const KEY = "what-if";
// Thrown out of a step that needs a pick: the drive stops there.
const ASK = Symbol("ask");

// A review's most severe finding from its counts (review-parse.mjs's), `none` without one.
export const severityOfCounts = (counts = {}) =>
  SEVERITIES.find((s) => (counts?.[s] ?? 0) > 0) ?? "none";

// Whether `severity` is above `tolerance` (`review.max_allowed_severity`): it blocks.
const blocks = (severity, tolerance) =>
  SEVERITIES.includes(severity) &&
  SEVERITIES.indexOf(severity) < SEVERITIES.indexOf(tolerance ?? "low");

// Pull request entry `entry` (reviews.mjs, its `reviews` map) and its task's decisions
// (decisions.mjs, newest first) → the steps the review loop took on it, oldest first:
// { run, outcome, at?, head?, blocking? }, `outcome` null when the step ran and its end isn't
// recorded (a fix run going). Its loop's own reviews (not a maintainer's), a fix run before
// each later round, the last one's after it, the CI step's stop and the merge's decision. CI
// that passed isn't recorded: the replay takes a CI step as passed while the history goes on.
export function recordedHistory(entry, decisions = []) {
  const events = [];
  const rounds = (entry?.rounds ?? []).filter((r) => !r.manual).sort((a, b) => a.at - b.at);
  // A refused fix counts only as the review loop's (`reason: "review"` in the input it kept): a
  // CI fix and a rebase are `fix` decisions too, and an input dropped past MAX_INPUTS says neither.
  const denied = (decision, after = 0) =>
    decisions.find(
      (d) =>
        d.decision === decision &&
        d.denied &&
        (d.at ?? 0) >= after &&
        (decision !== "fix" || d.input?.reason === "review"),
    );
  if (!rounds.length && denied("review")) {
    events.push({ run: "review", outcome: "refused", at: denied("review").at });
  }
  let fixes = 0;
  for (const r of rounds) {
    for (; fixes < r.round; fixes++) events.push({ run: "fix", outcome: "pushed" });
    const outcome = severityOfCounts(r.counts);
    events.push({ run: "review", outcome, at: r.at, head: r.head, blocking: r.blocking > 0 });
  }
  const last = rounds.at(-1);
  const total = entry?.fixes ?? (entry?.fixedAt ? 1 : 0);
  for (; fixes < total; fixes++) {
    // Its push unreviewed by design (`fix: true` alone), or its end not known here.
    events.push({ run: "fix", outcome: entry.unreviewedFix === total ? "pushed" : null });
  }
  if (last?.blocking && total <= last.round && denied("fix", last.at)) {
    events.push({ run: "fix", outcome: "none", at: denied("fix", last.at).at });
  }
  const ci = entry?.ciStopped;
  if (ci && (!last || (ci.at ?? 0) > last.at)) {
    events.push({ run: "ci", outcome: "failed", at: ci.at ?? null });
  }
  if (entry?.mergedAt) events.push({ run: "merge", outcome: "merged", at: entry.mergedAt });
  else if (entry?.mergeAt) events.push({ run: "merge", outcome: "refused", at: entry.mergeAt });
  else if (entry?.waiting) events.push({ run: "merge", outcome: null });
  return events;
}

// One dry run of parsed `workflow` (workflow-format.mjs) on `event`: `history`, the steps the
// pull request took (recordedHistory()); `picks`, the outcomes chosen past the divergence, in
// order; `tolerance`, `review.max_allowed_severity`; `read`, the facts of the pull request
// (workflows.mjs pullFacts()'s files and labels); `maxRounds`, MAX_FIX_ROUNDS. →
// { trail, diverged, ask, end, leftover }: `trail`, each step taken { line, run | comment,
// outcome, source: recorded | assumed | auto | picked }; `diverged`, the first step the pull
// request never took { line, run, index (in the trail), expected (its next recorded step, or
// null where its history ends) }, null while they agree; `ask`, the step waiting for a pick
// { line, run, options }; `end`, done (the steps ran out), merged, stopped, asking; `leftover`,
// the recorded steps the workflow ended before (none once diverged).
export async function whatIf({
  workflow,
  event = workflow.on[0],
  history = [],
  picks = [],
  tolerance = "low",
  read = {},
  maxRounds = Infinity,
}) {
  let clock = 0;
  const engine = createEngine({ instances: new Map(), maxRounds, now: () => ++clock });
  const state = { at: 0, picked: 0, head: 0, ci: "none", severity: null, blocking: false };
  const trail = [];
  let diverged = null;
  let ask = null;
  let merged = false;
  let stopped = false;

  // Read once per dry run: the pull request's files don't change meanwhile.
  let listed = null;
  const files = () => (listed ??= Promise.resolve(read.files ? read.files() : []));
  const io = () => ({
    facts: factsOf({
      files,
      labels: read.labels,
      head: () => `h${state.head}`,
      ci: () => state.ci,
      severity: () => state.severity,
      // A head moved since the flag (a push in the dry run): its files taken as changed.
      changedSince: async (sha) => (sha === `h${state.head}` ? [] : files()),
    }),
    act,
  });

  // The outcome of a step of kind `run`: { outcome, source }, or throws ASK.
  function outcomeOf(step, run) {
    const next = history[state.at];
    if (!diverged) {
      if (next?.run === run) {
        state.at += 1;
        if (next.outcome !== null) {
          if (run === "review" && typeof next.blocking === "boolean") {
            state.recordedBlocking = next.blocking;
          }
          return { outcome: next.outcome, source: "recorded" };
        }
      } else if (run === "ci" && next) {
        return { outcome: "passed", source: "assumed" };
      } else if (run === "fix" && !state.blocking) {
        return { outcome: "none", source: "auto" };
      }
      if (next?.run !== run || next.outcome === null) {
        const expected = next?.run === run ? null : (next ?? null);
        diverged = { line: step.line, run, index: trail.length, expected };
      }
    }
    // Decided for sure: nothing blocking starts no fix run; a blocking review isn't merged.
    if (run === "fix" && !state.blocking) return { outcome: "none", source: "auto" };
    if (run === "merge" && state.blocking) return { outcome: "refused", source: "auto" };
    const options = OUTCOMES[run];
    const pick = picks[state.picked];
    if (!options.includes(pick)) {
      ask = { line: step.line, run, options };
      throw ASK;
    }
    state.picked += 1;
    return { outcome: pick, source: "picked" };
  }

  async function act(step) {
    if (trail.length >= MAX_STEPS) throw new Error(`over ${MAX_STEPS} steps`);
    if (!step.run) {
      // Deckhand's rounds-out comment says something only when the last review still blocks.
      const outcome = step.say === "rounds-out" && !state.blocking ? "nothing" : "posted";
      trail.push({ line: step.line, comment: step.say ?? step.comment, outcome, source: "auto" });
      return "done";
    }
    const { outcome, source } = outcomeOf(step, step.run);
    trail.push({ line: step.line, run: step.run, outcome, source });
    switch (`${step.run}:${outcome}`) {
      case "ci:passed":
        state.ci = "passed";
        return "wait";
      case "ci:failed":
        state.ci = "failed";
        stopped = true;
        return "stop";
      case "fix:pushed":
      case "rebase:rebased":
        state.head += 1;
        state.ci = "running";
        return "wait";
      case "fix:none":
        return "break";
      case "fix:nothing-pushed":
      case "review:refused":
        stopped = true;
        return "stop";
      case "merge:merged":
        merged = true;
        return "stop";
      case "merge:refused":
      case "rebase:refused":
        return "done";
      default:
        // A review: its severity.
        state.severity = outcome;
        state.blocking = state.recordedBlocking ?? blocks(outcome, tolerance);
        state.recordedBlocking = undefined;
        return "wait";
    }
  }

  let end;
  try {
    const head = `h${state.head}`;
    let result = await engine.trigger(KEY, workflow, { name: event, id: KEY, pr: 1, head }, io());
    while (result === "waiting") result = await engine.resume(KEY, event, io(), `h${state.head}`);
    end = merged ? "merged" : stopped || result !== "done" ? "stopped" : "done";
  } catch (error) {
    if (error !== ASK) throw error;
    end = "asking";
  }
  const leftover = diverged || end === "asking" ? [] : history.slice(state.at);
  return { trail, diverged, ask, end, leftover };
}
