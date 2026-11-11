// The built-in pull request lifecycle as a graph (#899), for the dashboard's Workflow tab and
// the docs' Mermaid block: its steps (nodes) and what moves a pull request between them (edges),
// with the repo's `review:` and `conflicts:` settings applied (lifecycleGraph()), and whether
// the operator's grants and the policies let each step run (sampleDecisions(), on a sample pull
// request). Read-only: reviews.mjs and conflicts.mjs still run the lifecycle, this describes it.
import { autoMergeProblems } from "./grants.mjs";
import { pullInput } from "./policies.mjs";
import { checksOf, fixInput } from "./review-merge.mjs";

// The steps, placed on a fixed grid: `rank`, the column, left to right; `lane`, the row, the
// loops' second step under its first. `decision`: the policies' decision asked before it runs
// (`deny_fix` with its `reason` for the three kinds of fix run); `grant`: the operator's grant it
// needs (grants.mjs).
export const NODES = [
  { id: "ready", rank: 0, lane: 0 },
  { id: "ci", rank: 1, lane: 0 },
  { id: "ci-fix", rank: 1, lane: 1, decision: "fix", reason: "ci" },
  { id: "review", rank: 2, lane: 0, decision: "review" },
  { id: "fix", rank: 2, lane: 1, decision: "fix", reason: "review" },
  { id: "merge", rank: 3, lane: 0, decision: "merge", grant: "auto_merge" },
  { id: "rebase", rank: 3, lane: 1, decision: "fix", reason: "conflict" },
  { id: "done", rank: 4, lane: 0 },
];

// Where reviewLoop()'s states (review-loop.mjs LOOP_STATES) and its steps (LOOP_STEPS, the
// reasons of the loop's runs) are in the graph: the dashboard highlights a task's node with it.
export const STATE_NODES = {
  reviewing: "review",
  fixing: "fix",
  checks: "merge",
  ci: "ci",
  "ci-fix": "ci-fix",
  rebasing: "rebase",
  "ci-failed": "done",
  clean: "done",
  "rounds-out": "done",
  fixed: "done",
  stopped: "done",
};
export const STEP_NODES = {
  review: "review",
  "review-fix": "fix",
  "ci-fix": "ci-fix",
  conflict: "rebase",
};

// The steps and their conditions as the docs' Mermaid block names them; the dashboard has its
// own words for each (locales' workflow.*).
const LABELS = {
  ready: "Ready for review",
  ci: "Wait for CI",
  "ci-fix": "CI fix",
  review: "Review",
  fix: "Fix",
  merge: "Auto-merge",
  rebase: "Rebase",
  done: "Done",
};
const CONDITIONS = {
  ready: "ready",
  passed: "CI passed",
  "ci-over": "CI over",
  failed: "CI failed",
  "no-ci-fix": "no CI fix",
  "ci-stopped": "CI fix refused",
  pushed: "pushed",
  "nothing-pushed": "nothing pushed",
  blocking: "blocking",
  clean: "nothing blocking",
  "rounds-out": "rounds out",
  fixed: "fixed",
  merged: "merged or refused",
  conflict: "conflicts",
  rebased: "rebased",
};

// The repo's lifecycle → { nodes, edges }. `settings`: its parsed `.deckhand.yaml`
// (repo-config.mjs). `grant`: the operator's grant (grants.mjs grantOf()), null when it can't be
// read, undefined not to check it (the docs); `isPrivate`: the repository's visibility, for
// `auto_merge_public`. `decisions`: what the policies said of each node's step on a sample
// (sampleDecisions()), by node id; null when no policy was asked.
// Each node: { id, rank, lane, state, key, settings, decision?, grant?, reasons[] }. `state`:
//   on        the settings, the grant and the policies let it run
//   off       the settings turn it off (`key`, the setting that would turn it on)
//   refused   the grant is missing (`reasons` with that `grant`) or the policies refused the
//             sample (`reasons`)
//   depends   allowed on the sample, but a deny rule, or an allow rule that isn't
//             unconditional, may refuse another pull request (`reasons`: the files)
// `settings`: the step's own numbers (rounds, minutes, severity, method). Each edge: { from,
// to, when[], back }, `when` the conditions (CONDITIONS' keys) that take it, `back` a loop
// going back to an earlier step. Only between steps that aren't off: off ones stand apart.
export function lifecycleGraph(settings, { grant, isPrivate = null, decisions = null } = {}) {
  const review = settings?.review ?? null;
  const ready = review?.on === "ready";
  const ci = ready && review.ci === "wait";
  const fix = !!review?.fix;
  const ciFix = ci && fix && review.ciFix > 0;
  const merge = ready && !!review?.merge;
  const conflicts = !!settings?.conflicts;
  // What a fix run's push goes back to: a review, in auto-merge mode or with more than one
  // round (reviews.mjs fixed()); `fix: true` without `merge` stops at its fix run.
  const again = merge || (review?.fixRounds ?? 0) > 1;
  const on = {
    ready: [ready, "review.on"],
    ci: [ci, "review.ci"],
    "ci-fix": [ciFix, "review.ci_fix"],
    review: [!!review, "review"],
    fix: [fix, "review.fix"],
    merge: [merge, "review.merge"],
    rebase: [conflicts && !!review, "conflicts"],
    done: [!!review, "review"],
  };
  const numbers = {
    ready: {},
    ci: { minutes: review?.ciWait ?? null },
    "ci-fix": { rounds: review?.ciFix ?? null },
    review: { severity: review?.maxAllowedSeverity ?? null },
    fix: { rounds: review?.fixRounds ?? null },
    merge: { method: review?.mergeMethod ?? null, minutes: review?.mergeWait ?? null },
    rebase: { minutes: settings?.conflicts?.checkMinutes ?? null },
    done: {},
  };
  const nodes = NODES.map(({ id, rank, lane, decision, grant: needs }) => {
    const [enabled, key] = on[id];
    const node = {
      id,
      rank,
      lane,
      key,
      settings: numbers[id],
      ...(decision && { decision }),
      ...(needs && { grant: needs }),
    };
    if (!enabled) return { ...node, state: "off", reasons: [] };
    const missing = needs ? grantProblems(grant, settings, isPrivate) : [];
    if (missing.length) {
      return {
        ...node,
        state: "refused",
        reasons: missing.map((message) => ({ message, grant: needs })),
      };
    }
    const said = decisions?.[id];
    if (!said) return { ...node, state: "on", reasons: [] };
    return { ...node, state: said.state === "allowed" ? "on" : said.state, reasons: said.reasons };
  });
  const live = new Set(nodes.filter((n) => n.state !== "off").map((n) => n.id));
  const at = Object.fromEntries(NODES.map((n) => [n.id, n]));
  // Back: to an earlier column, or up its own.
  const back = (a, b) => b.rank < a.rank || (b.rank === a.rank && b.lane < a.lane);
  const edges = [];
  const edge = (from, to, ...when) => {
    if (live.has(from) && live.has(to)) {
      edges.push({ from, to, when, back: back(at[from], at[to]) });
    }
  };
  // Every automatic review goes through the CI step first, when it is on (reviewAfterCi()).
  const entry = ci ? "ci" : "review";
  edge("ready", entry, "ready");
  if (ciFix) {
    // CI failed and no CI fix run: its rounds ran out or the pull request isn't Deckhand's own,
    // reviewed anyway; or the policies refused it, a task busy or waiting for input: stopped
    // (reviews.mjs ciFailed()).
    edge("ci", "review", "passed", "no-ci-fix");
    edge("ci", "ci-fix", "failed");
    edge("ci", "done", "ci-stopped");
    edge("ci-fix", "ci", "pushed");
    edge("ci-fix", "done", "nothing-pushed");
  } else edge("ci", "review", "ci-over");
  if (fix) edge("review", "fix", "blocking");
  if (merge) edge("review", "merge", "clean");
  edge("review", "done", ...(merge ? [] : ["clean"]), fix ? "rounds-out" : "blocking");
  if (fix && again) {
    edge("fix", entry, "pushed");
    edge("fix", "done", "nothing-pushed");
  } else if (fix) edge("fix", "done", "fixed");
  edge("merge", "done", "merged");
  // The conflict watcher rebases a pull request whose merge (or review) it blocks; the
  // rebased head is reviewed again (reviews.mjs rebased()).
  edge(merge ? "merge" : "review", "rebase", "conflict");
  edge("rebase", entry, "rebased");
  return { nodes, edges };
}

// Why the operator's grant stops the merge (grants.mjs autoMergeProblems()), without what the
// settings say (the node is off then). `grant` undefined: not checked; null: unreadable.
function grantProblems(grant, settings, isPrivate) {
  if (grant === undefined) return [];
  if (grant === null) return ["the operator's grants can't be read"];
  return autoMergeProblems(grant, settings, isPrivate).filter((p) => !p.includes("review.on"));
}

// The graph as a Mermaid flowchart (docs/repo-config/reviews.md, held equal by a test): steps
// left to right, the loops' back edges dotted, steps turned off left out.
export function lifecycleMermaid({ nodes, edges }) {
  const id = (n) => n.replace("-", "_");
  const shown = nodes.filter((n) => n.state !== "off");
  const lines = ["flowchart LR"];
  for (const n of shown) {
    const label = LABELS[n.id];
    lines.push(
      n.id === "ready" || n.id === "done" ? `  ${id(n.id)}([${label}])` : `  ${id(n.id)}[${label}]`,
    );
  }
  for (const e of edges) {
    const when = e.when.map((w) => CONDITIONS[w]).join(" or ");
    lines.push(
      `  ${id(e.from)} ${e.back ? "-." : "--"} ${when} ${e.back ? ".->" : "-->"} ${id(e.to)}`,
    );
  }
  return lines.join("\n");
}

// The settings the docs draw: every step on.
export const DOCS_SETTINGS = {
  review: {
    on: "ready",
    fix: true,
    fixRounds: 3,
    merge: true,
    mergeMethod: "squash",
    maxAllowedSeverity: "medium",
    mergeWait: 30,
    ci: "wait",
    ciWait: 30,
    ciFix: 2,
  },
  conflicts: { checkMinutes: 30 },
};

// A head commit the sample pull request has: any oid but zeros.
const SAMPLE_SHA = "1".repeat(40);

// The inputs a sample pull request gives each node's decision, as reviews.mjs and conflicts.mjs
// build the real ones (docs/repo-config/policy-inputs.md#the-merge-input): Deckhand's own (`bot`,
// the App's login) pull request on `repo`, from a work run's branch into `base`, no file
// changed, its CI passed and its first review clean. → { [node id]: input }
export function sampleInputs({
  repo,
  base,
  isPrivate = null,
  settings,
  bot = null,
  now = Date.now,
}) {
  const info = { full_name: repo, private: isPrivate === true, default_branch: base };
  const pr = {
    number: 1,
    user: { login: bot ?? "octocat", type: bot ? "Bot" : "User" },
    title: "A sample pull request",
    labels: [],
    base: { ref: base },
    head: { ref: "issue-1-sample", sha: SAMPLE_SHA },
    draft: false,
    changed_files: 0,
  };
  const pull = (decision, review = null) =>
    pullInput({ decision, info, pr, files: [], issue: null, review, bot, now });
  const allowed = settings?.review?.maxAllowedSeverity ?? "low";
  const rounds = settings?.review?.fixRounds ?? 0;
  const passed = [{ name: "CI", status: "completed", conclusion: "success" }];
  return {
    review: { ...pull("review"), ...fixInput(0) },
    fix: { ...pull("fix"), ...fixInput(0), ci: false, reason: "review", round: 1, rounds },
    "ci-fix": {
      ...pull("fix"),
      ...fixInput(0),
      ci: true,
      reason: "ci",
      round: 1,
      rounds: settings?.review?.ciFix ?? 0,
      checks: [{ name: "CI", status: "completed", conclusion: "failure" }],
    },
    rebase: {
      ...pull("fix"),
      ...fixInput(0),
      ci: false,
      reason: "conflict",
      round: null,
      rounds: null,
    },
    merge: {
      ...pull("merge", { verdict: "comment", rating: 9, allowed, findings: [] }),
      ...fixInput(0),
      checks: checksOf(passed),
    },
  };
}

// What the policies (policies.mjs createPolicies()) say of each node's step on `repo`'s default
// branch `base`, on sampleInputs() → { [node id]: { state, reasons } } for lifecycleGraph():
// `state` refused (`reasons`: the messages, with their layer), depends (`reasons`: the files
// whose rules may refuse another pull request) or allowed.
// `described`: describe()'s answer for them, when the caller has it already.
export async function sampleDecisions(policies, { repo, base, described = null, ...sample }) {
  const inputs = sampleInputs({ repo, base, ...sample });
  described = (await described) ?? (await policies.describe(repo, base));
  const texts = described.policies;
  const out = {};
  for (const { id, decision } of NODES.filter((n) => n.decision)) {
    const { messages, layers = [] } = await policies.evaluated(
      decision,
      repo,
      texts,
      () => inputs[id],
    );
    out[id] = judged(decision, messages, layers, texts);
  }
  return out;
}

// One decision's state from what evaluated() said: refused with its messages; depends when a
// layer has a deny rule for it, or its operator's allow rules are all conditional; else
// allowed.
export function judged(decision, messages, layers, texts) {
  const layerOf = (l) => (l.layer === "repo" ? "repo" : "operator");
  if (messages.length) {
    // The layer that refused: one with a deny or an error, else one no allow rule matched.
    const by =
      layers.find((l) => l.error || l.denies?.length) ?? layers.find((l) => l.allow === false);
    return {
      state: "refused",
      reasons: messages.map((message) => ({ message, ...(by && { layer: layerOf(by) }) })),
    };
  }
  const reasons = [];
  for (const l of layers) {
    for (const file of l.denyFiles ?? []) {
      reasons.push({ layer: layerOf(l), file, rule: `deny_${decision}` });
    }
  }
  const operator = layers.find((l) => l.layer !== "repo");
  const files = operator?.allowFiles ?? [];
  const always = files.some((f) => unconditional(texts?.operator?.get?.(f) ?? "", decision));
  if (operator?.allow && !always) {
    for (const file of files) reasons.push({ layer: "operator", file, rule: `allow_${decision}` });
  }
  return reasons.length ? { state: "depends", reasons } : { state: "allowed", reasons: [] };
}

// Whether `text` allows `decision` whatever the input: `allow_x := true`, `allow_x if true`…
export function unconditional(text, decision) {
  const rule = `allow_${decision}`;
  return new RegExp(
    `^${rule}\\s*(?:(?::=|=)\\s*true|if\\s+true|if\\s*\\{\\s*true\\s*\\})\\s*(?:#.*)?$`,
    "m",
  ).test(text);
}
