// The pull request lifecycle's graph (listener/review-graph.mjs, #899): the steps and edges a
// repo's settings give, the grant's and the policies' states, every loop state placed, and the
// docs' Mermaid block held to it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  DOCS_SETTINGS,
  judged,
  lifecycleGraph,
  lifecycleMermaid,
  NODES,
  sampleDecisions,
  sampleInputs,
  STATE_NODES,
  STEP_NODES,
  unconditional,
} from "../listener/review-graph.mjs";
import { LOOP_STATES, LOOP_STEPS, reviewLoop } from "../listener/review-loop.mjs";

const states = (graph) => Object.fromEntries(graph.nodes.map((n) => [n.id, n.state]));
const edges = (graph) =>
  graph.edges.map((e) => `${e.from}>${e.to}:${e.when.join("+")}${e.back ? " back" : ""}`);
const review = (extra = {}) => ({
  review: {
    on: "ready",
    fix: false,
    fixRounds: 0,
    merge: false,
    mergeMethod: "squash",
    maxAllowedSeverity: "low",
    mergeWait: 30,
    ci: false,
    ciWait: 30,
    ciFix: 1,
    ...extra,
  },
});

test("lifecycleGraph: every step on, its loops going back", () => {
  const graph = lifecycleGraph(DOCS_SETTINGS);
  assert.ok(graph.nodes.every((n) => n.state === "on"));
  assert.deepEqual(edges(graph), [
    "ready>ci:ready",
    "ci>review:passed+no-ci-fix",
    "ci>ci-fix:failed",
    "ci>done:ci-stopped",
    "ci-fix>ci:pushed back",
    "ci-fix>done:nothing-pushed",
    "review>fix:blocking",
    "review>merge:clean",
    "review>done:rounds-out",
    "fix>ci:pushed back",
    "fix>done:nothing-pushed",
    "merge>done:merged",
    "merge>rebase:conflict",
    "rebase>ci:rebased back",
  ]);
  const fix = graph.nodes.find((n) => n.id === "fix");
  assert.deepEqual(fix.settings, { rounds: 3 });
  assert.equal(fix.decision, "fix");
  assert.deepEqual(graph.nodes.find((n) => n.id === "merge").settings, {
    method: "squash",
    minutes: 30,
  });
});

test("lifecycleGraph: the settings turn steps off, the edges going around them", () => {
  // No review: nothing but the end, every step off, and no edge.
  const none = lifecycleGraph({});
  assert.ok(none.nodes.every((n) => n.state === "off"));
  assert.deepEqual(none.edges, []);
  assert.equal(none.nodes.find((n) => n.id === "ci").key, "review.ci");
  // `review: true`: "/mode review" only, one review and done.
  const manual = lifecycleGraph(review({ on: "manual", ci: "wait", merge: true }));
  assert.equal(states(manual).ready, "off");
  // The CI step and the merge need `on: ready`.
  assert.equal(states(manual).ci, "off");
  assert.equal(states(manual).merge, "off");
  assert.deepEqual(edges(manual), ["review>done:clean+blocking"]);
  // One fix run, without merge: nothing reviews it.
  const once = lifecycleGraph(review({ fix: true, fixRounds: 1 }));
  assert.deepEqual(edges(once), [
    "ready>review:ready",
    "review>fix:blocking",
    "review>done:clean+rounds-out",
    "fix>done:fixed",
  ]);
  // More rounds: its push is reviewed again, straight (no CI step).
  const rounds = lifecycleGraph(review({ fix: true, fixRounds: 2 }));
  assert.ok(edges(rounds).includes("fix>review:pushed back"));
  // CI without a fix: the review comes whatever CI said, no CI fix run.
  const ci = lifecycleGraph(review({ ci: "wait" }));
  assert.equal(states(ci)["ci-fix"], "off");
  assert.ok(edges(ci).includes("ci>review:ci-over"));
  // `ci_fix: 0` turns it off too.
  assert.equal(
    states(lifecycleGraph(review({ ci: "wait", fix: true, ciFix: 0 })))["ci-fix"],
    "off",
  );
  // The conflict watcher without a merge: from the review.
  const rebase = lifecycleGraph({ ...review(), conflicts: { checkMinutes: 30 } });
  assert.ok(edges(rebase).includes("review>rebase:conflict"));
  assert.ok(edges(rebase).includes("rebase>review:rebased back"));
  // The watcher on its own, no review: its runs happen, nothing reviews them.
  const alone = lifecycleGraph({ conflicts: { checkMinutes: 30 } });
  assert.deepEqual(
    [states(alone).rebase, states(alone).done, states(alone).review],
    ["on", "on", "off"],
  );
  assert.deepEqual(edges(alone), ["rebase>done:rebased"]);
  // "/mode review" only: a rebased head isn't reviewed again (afterRebase()).
  const asked = lifecycleGraph({ ...review({ on: "manual" }), conflicts: { checkMinutes: 30 } });
  assert.ok(edges(asked).includes("review>rebase:conflict"));
  assert.ok(edges(asked).includes("rebase>done:rebased"));
  assert.ok(!edges(asked).some((e) => e.startsWith("rebase>review")));
});

test("lifecycleGraph: the merge refused without the operator's grant, or when it can't be read", () => {
  const settings = review({ merge: true });
  // The docs check no grant.
  assert.equal(states(lifecycleGraph(settings)).merge, "on");
  const missing = lifecycleGraph(settings, { grant: {} });
  const merge = missing.nodes.find((n) => n.id === "merge");
  assert.equal(merge.state, "refused");
  assert.equal(merge.grant, "auto_merge");
  assert.match(merge.reasons[0].message, /auto_merge/);
  // Marked as the grant's: no policy decision on a task replaces it.
  assert.equal(merge.reasons[0].grant, "auto_merge");
  // The edges still say where it would go.
  assert.ok(edges(missing).includes("review>merge:clean"));
  const unread = lifecycleGraph(settings, { grant: null }).nodes.find((n) => n.id === "merge");
  assert.deepEqual(unread.reasons, [
    { message: "the operator's grants can't be read", grant: "auto_merge" },
  ]);
  // A public repository needs auto_merge_public.
  const pub = lifecycleGraph(settings, { grant: { allowAutoMerge: true }, isPrivate: false });
  assert.equal(states(pub).merge, "refused");
  const granted = { grant: { allowAutoMerge: true }, isPrivate: true };
  assert.equal(states(lifecycleGraph(settings, granted)).merge, "on");
  // One fix run, and no merge mode without the grant: nothing reviews its push (reviewFix()).
  const once = review({ merge: true, fix: true, fixRounds: 1 });
  assert.ok(edges(lifecycleGraph(once, { grant: {} })).includes("fix>done:fixed"));
  assert.ok(edges(lifecycleGraph(once, { grant: null })).includes("fix>done:fixed"));
  assert.ok(edges(lifecycleGraph(once, granted)).includes("fix>review:pushed back"));
  // No merge mode: a clean review ends there too, beside the refused merge.
  assert.ok(edges(lifecycleGraph(once, { grant: {} })).includes("review>done:clean+rounds-out"));
  assert.ok(edges(lifecycleGraph(once, granted)).includes("review>done:rounds-out"));
});

test("lifecycleGraph: the policies' states on the sample, a step off staying off", () => {
  const decisions = {
    review: { state: "depends", reasons: [{ layer: "operator", file: "review.rego" }] },
    fix: { state: "refused", reasons: [{ message: "no", layer: "repo" }] },
    merge: { state: "allowed", reasons: [] },
    "ci-fix": { state: "refused", reasons: [{ message: "no" }] },
  };
  const graph = lifecycleGraph(review({ fix: true, fixRounds: 1, merge: true }), { decisions });
  assert.deepEqual(states(graph), {
    ready: "on",
    ci: "off",
    "ci-fix": "off",
    review: "depends",
    fix: "refused",
    merge: "on",
    rebase: "off",
    done: "on",
  });
  assert.deepEqual(graph.nodes.find((n) => n.id === "fix").reasons, [
    { message: "no", layer: "repo" },
  ]);
});

test("every state reviewLoop() gives and every step of the loop has its node", () => {
  const ids = new Set(NODES.map((n) => n.id));
  for (const state of LOOP_STATES) assert.ok(ids.has(STATE_NODES[state]), state);
  assert.deepEqual(Object.keys(STATE_NODES).sort(), [...LOOP_STATES].sort());
  for (const step of LOOP_STEPS) assert.ok(ids.has(STEP_NODES[step]), step);
  // The dashboard's STATE_NODES (workflowLayout.ts) places each state as this one does.
  const layout = readFileSync(
    new URL("../dashboard/src/workflowLayout.ts", import.meta.url),
    "utf8",
  );
  const map = /export const STATE_NODES[^{]*\{([^}]+)\}/.exec(layout)[1];
  const theirs = Object.fromEntries(
    [...map.matchAll(/"?([a-z-]+)"?: "([a-z-]+)"/g)].map((m) => [m[1], m[2]]),
  );
  assert.deepEqual(theirs, STATE_NODES);
  // The dashboard's LoopState is the same list (its STATE_NODES is typed from it).
  const types = readFileSync(new URL("../dashboard/src/types/state.ts", import.meta.url), "utf8");
  const union = /export type LoopState =([^;]+);/.exec(types)[1];
  assert.deepEqual(
    [...union.matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort(),
    [...LOOP_STATES].sort(),
  );
  // And the states reviewLoop()'s source returns are among them.
  const source = readFileSync(new URL("../listener/review-loop.mjs", import.meta.url), "utf8");
  const returned = [...source.matchAll(/loop: (?:out \? )?"([a-z-]+)"(?: : "([a-z-]+)")?/g)]
    .flatMap((m) => m.slice(1))
    .filter(Boolean);
  assert.ok(returned.length >= LOOP_STATES.length - 1, returned.join());
  for (const state of returned) assert.ok(LOOP_STATES.includes(state), state);
  assert.equal(reviewLoop({}, "review").loop, "reviewing");
});

test("the docs' Mermaid block is lifecycleMermaid()'s, every step on", () => {
  const docs = readFileSync(new URL("../docs/repo-config/reviews.md", import.meta.url), "utf8");
  const block = /<!-- lifecycle: generated[^\n]*-->\n+```mermaid\n([\s\S]*?)\n```/.exec(docs);
  assert.ok(block, "docs/repo-config/reviews.md has no generated lifecycle block");
  const expected = lifecycleMermaid(lifecycleGraph(DOCS_SETTINGS));
  assert.equal(block[1], expected, `Replace the block with:\n\n${expected}\n`);
});

test("lifecycleMermaid: the steps turned off left out, the loops dotted", () => {
  const text = lifecycleMermaid(lifecycleGraph(review({ fix: true, fixRounds: 2 })));
  assert.equal(
    text,
    [
      "flowchart LR",
      "  ready([Ready for review])",
      "  review[Review]",
      "  fix[Fix]",
      "  done([Done])",
      "  ready -- ready --> review",
      "  review -- blocking --> fix",
      "  review -- nothing blocking or rounds out --> done",
      "  fix -. pushed .-> review",
      "  fix -- nothing pushed --> done",
    ].join("\n"),
  );
});

test("judged: refused with its messages, depends on a deny or a conditional allow, else allowed", () => {
  const texts = {
    operator: new Map([
      ["allow.rego", "package deckhand\n\nallow_merge := true\n"],
      ["mine.rego", "package deckhand\n\nallow_merge if input.pr.deckhand\n"],
    ]),
  };
  const allowing = { layer: "operator", allow: true, denies: [], allowFiles: ["allow.rego"] };
  assert.deepEqual(judged("merge", [], [allowing], texts), { state: "allowed", reasons: [] });
  // Deckhand's machines.rego: a deny rule that may match another pull request.
  const denying = { ...allowing, denyFiles: ["machines.rego"] };
  assert.deepEqual(judged("merge", [], [denying], texts), {
    state: "depends",
    reasons: [{ layer: "operator", file: "machines.rego", rule: "deny_merge" }],
  });
  const conditional = { ...allowing, allowFiles: ["mine.rego"] };
  assert.deepEqual(judged("merge", [], [conditional], texts).reasons, [
    { layer: "operator", file: "mine.rego", rule: "allow_merge" },
  ]);
  // Refused: the layer whose deny said so.
  const repo = { layer: "repo", allow: null, denies: ["not on Fridays"], denyFiles: ["f.rego"] };
  assert.deepEqual(judged("merge", ["not on Fridays"], [allowing, repo], texts), {
    state: "refused",
    reasons: [{ message: "not on Fridays", layer: "repo" }],
  });
});

test("unconditional: only an allow rule that matches whatever the input", () => {
  assert.ok(unconditional("allow_fix := true", "fix"));
  assert.ok(unconditional("x\nallow_fix if true # always\n", "fix"));
  assert.ok(unconditional("allow_fix if { true }", "fix"));
  assert.ok(!unconditional("allow_fix if input.pr.deckhand", "fix"));
  assert.ok(unconditional("allow_fix if {\n  true\n}", "fix"));
  assert.ok(!unconditional("allow_merge := true", "fix"));
});

test("sampleDecisions: each step's decision on the sample's input, the policies described once", async () => {
  const asked = [];
  let described = 0;
  const policies = {
    describe: async () => {
      described++;
      return { policies: { operator: new Map([["allow.rego", "allow_fix := true"]]) } };
    },
    evaluated: async (decision, repo, texts, input) => {
      asked.push([decision, (await input()).reason ?? null]);
      return {
        messages: [],
        layers: [{ layer: "operator", allow: true, denies: [], allowFiles: ["allow.rego"] }],
      };
    },
  };
  const said = await sampleDecisions(policies, {
    repo: "org/app",
    base: "main",
    settings: DOCS_SETTINGS,
    bot: "deckhand[bot]",
  });
  assert.equal(described, 1);
  assert.deepEqual(asked, [
    ["fix", "ci"],
    ["review", null],
    ["fix", "review"],
    ["merge", null],
    ["fix", "conflict"],
  ]);
  assert.deepEqual(said.fix, { state: "allowed", reasons: [] });
  // The merge's allow, `allow_merge`, defined nowhere unconditional here: it depends.
  assert.equal(said.merge.state, "depends");
  // A describe() the caller has is used as it is.
  await sampleDecisions(policies, {
    repo: "org/app",
    base: "main",
    described: policies.describe(),
  });
  assert.equal(described, 2);
});

test("sampleInputs: Deckhand's own pull request, CI passed, its review clean", () => {
  const inputs = sampleInputs({
    repo: "org/app",
    base: "main",
    isPrivate: true,
    settings: DOCS_SETTINGS,
    bot: "deckhand[bot]",
    now: () => 0,
  });
  assert.equal(inputs.merge.decision, "merge");
  assert.equal(inputs.merge.pr.deckhand, true);
  assert.equal(inputs.merge.pr.author_type, "Bot");
  assert.deepEqual(inputs.merge.repo, { name: "org/app", private: true, default_branch: "main" });
  assert.deepEqual(inputs.merge.checks, [
    { name: "CI", status: "completed", conclusion: "success" },
  ]);
  assert.deepEqual(inputs.merge.review.findings, []);
  assert.equal(inputs.merge.review.allowed, "medium");
  assert.equal(inputs.review.checks, undefined);
  assert.deepEqual([inputs.fix.round, inputs.fix.rounds, inputs.fix.ci], [1, 3, false]);
  assert.deepEqual([inputs["ci-fix"].reason, inputs["ci-fix"].rounds], ["ci", 2]);
  assert.equal(inputs.rebase.reason, "conflict");
});
