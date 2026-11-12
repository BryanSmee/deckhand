// The review loop on the workflow engine (#1041): the built-in loop as the workflow `review:`
// compiles to, a repo's own workflow on `ready` (two reviewers, a security review when
// `policy/**` changes), pull requests already in the loop, and its instances in the store.
// The loop's own cases are reviews.test.mjs's and auto-merge.test.mjs's, unchanged.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { stepSettings } from "../listener/modes.mjs";
import { parseRepoConfig } from "../listener/repo-config.mjs";
import { trustedFile } from "../listener/review-merge.mjs";
import { parseReview } from "../listener/review-parse.mjs";
import { reviewEvent } from "../listener/review-post.mjs";
import { impliedSettings, loopWarnings, stepOf } from "../listener/review-workflow.mjs";
import { createReviews } from "../listener/reviews.mjs";
import { compile } from "../listener/workflow-engine.mjs";
import {
  builtInWorkflow,
  errorText,
  parseWorkflow,
  reviewWorkflow,
} from "../listener/workflow-format.mjs";
import { mapStore, testConfig, until } from "./helpers.mjs";

const config = { ...testConfig(), bot: "deckhand-app[bot]" };
const KEY = "org/repo#pr-5";

const CLEAN = "Reads well.\n\n- **low** `a.mjs:1`: a typo.\n\nRating: 9/10\nVerdict: approve";
const HIGH = "- **high** `a.mjs:1`: a hole.\n\nRating: 4/10\nVerdict: request-changes";

// Two reviewers: the loop's, then a second opinion on another agent once nothing blocks.
const TWO_REVIEWERS = `on: ready
vars:
  fixes: counter
steps:
  - run: review
  - repeat:
      - run: fix
        count: fixes
      - run: review
    max: fixes 2
  - if: severity <= low
    run: review
    agent: codex
    model: best
`;

// A security review when the pull request changes the policies, once per change.
const SECURITY = `on: ready
vars:
  checked: flag
steps:
  - run: review
  - if: changed("policy/**", since checked)
    run: review
    instructions: .deckhand/security-review.md
    set: checked
`;

// The reviewer with the repo's `yaml` and its own workflow on `ready` (`flow`, else the built-in
// one), a fake GitHub whose pull request #5 (Deckhand's, closing #12) is at `gh.head` and
// changes `gh.files`.
function setup({ yaml = "review: true\n", flow = null, errors = [], ...options } = {}) {
  const { instances = new Map(), reviewed = new Map() } = options;
  const gh = { head: "sha-1", files: [], runs: [] };
  const pr = () => ({
    number: 5,
    title: "Add a thing",
    state: "open",
    draft: false,
    body: "Closes #12",
    labels: [],
    user: { login: "deckhand-app[bot]", type: "Bot" },
    head: { sha: gh.head, repo: { full_name: "org/repo" } },
  });
  const github = async (repo, method, path) => {
    if (path === "/repos/org/repo/pulls/5") return Response.json(pr());
    if (path.startsWith("/repos/org/repo/pulls/5/files?")) {
      return Response.json(gh.files.map((filename) => ({ filename })));
    }
    if (path === "/repos/org/repo/issues/12") return Response.json({ labels: [] });
    if (path.startsWith("/repos/org/repo/actions/runs?head_sha=")) {
      return Response.json({ workflow_runs: gh.runs });
    }
    return new Response("{}", { status: 404 });
  };
  const read = parseRepoConfig(yaml, config);
  const own = flow && parseWorkflow("review.yaml", flow).workflow;
  const asked = [];
  const workflows = {
    forEvent: async (repo, ref, settings, event) => {
      asked.push(event);
      if (errors.length) return { workflow: null, errors };
      return { workflow: own ?? builtInWorkflow(event, settings), errors: [] };
    },
  };
  const accepted = [];
  const replies = [];
  const logs = [];
  const reviews = createReviews({
    reviewed,
    instances,
    workflows,
    config,
    github,
    repoSettings: async () => read,
    accept: async (item) => accepted.push(item),
    busy: () => false,
    reply: async (repo, number, text) => replies.push(text),
    grantOf: () => ({ allowAutoMerge: true }),
    log: (line) => logs.push(line),
    sleep: async () => {},
  });
  const run = { repo: "org/repo", number: 5, base: "trunk", settings: read.settings, auto: true };
  const posted = (message) => {
    const review = parseReview(message);
    return { event: reviewEvent(review), review, pr: pr(), head: gh.head };
  };
  const ready = () =>
    reviews.consider("pull_request", {
      action: "ready_for_review",
      installation: { id: 1 },
      repository: { full_name: "org/repo", default_branch: "trunk" },
      pull_request: pr(),
    });
  const settle = (message) => reviews.settle(run, posted(message));
  const fixed = () => reviews.fixed({ repo: "org/repo", number: 5, base: "trunk", status: "ok" });
  const instance = () => instances.get(KEY)?.ready ?? null;
  return { reviews, gh, accepted, replies, logs, asked, ready, settle, fixed, instance };
}

const steps = (accepted) => accepted.map((i) => [i.reason, i.workflowStep ?? null]);

test("two reviewers: the loop's, then a second opinion on another agent before it ends", async () => {
  const s = setup({ flow: TWO_REVIEWERS });
  await s.ready();
  assert.deepEqual(steps(s.accepted), [["review", null]]);
  // Its workflow is the one the instance keeps, the repo's own.
  assert.equal(s.instance().workflow.file, ".deckhand/workflows/review.yaml");
  // Changes requested: a fix run (the workflow's `run: fix` turns `review.fix` on), whose push
  // is reviewed again.
  await s.settle(HIGH);
  assert.deepEqual(steps(s.accepted).at(-1), ["review-fix", null]);
  s.gh.head = "sha-2";
  await s.fixed();
  assert.deepEqual(steps(s.accepted).at(-1), ["review", null]);
  // Nothing blocking: no fix run, so the loop ends, and the second reviewer comes, on its agent.
  await s.settle(CLEAN);
  assert.deepEqual(steps(s.accepted).at(-1), ["review", { agent: "codex", model: "best" }]);
  // Its review over: the workflow is done.
  await s.settle(CLEAN);
  assert.equal(s.accepted.length, 4);
  assert.equal(s.instance().current, null);
  assert.deepEqual(s.instance().vars.counters, { fixes: 1 });
});

test("a security review when the pull request changes the policies, once per change", async () => {
  const s = setup({ flow: SECURITY });
  s.gh.files = ["policy/review.rego", "src/a.mjs"];
  await s.ready();
  await s.settle(CLEAN);
  assert.deepEqual(steps(s.accepted), [
    ["review", null],
    ["review", { instructions: ".deckhand/security-review.md" }],
  ]);
  await s.settle(CLEAN);
  assert.equal(s.instance().vars.flags.checked.head, "sha-1");
  // A pull request that doesn't touch them: its one review.
  const other = setup({ flow: SECURITY });
  other.gh.files = ["docs/a.md"];
  await other.ready();
  await other.settle(CLEAN);
  assert.deepEqual(steps(other.accepted), [["review", null]]);
});

// The docs' example whose paragraph starts with `lead`: the yaml block after it, its file's
// name comment left out.
function docsExample(lead) {
  const text = readFileSync(new URL("../docs/repo-config/workflows.md", import.meta.url), "utf8");
  const match = text.match(
    new RegExp(`^${lead}[\\s\\S]*?^\`\`\`yaml\\n# .*\\n([\\s\\S]*?)^\`\`\`$`, "m"),
  );
  assert.ok(match, `the docs' example after \`${lead}\``);
  return match[1];
}

// The docs' security review alone (#1145): its first review's findings fixed before the
// security review comes, never merged past by a clean one.
const SECURITY_DOCS = docsExample("A security review when the pull request changes the policies,");

test("the docs' security review: the first review's findings fixed before it, the merge last", async () => {
  const SECURE = { instructions: ".deckhand/security-review.md" };
  const s = setup({ flow: SECURITY_DOCS });
  s.gh.files = ["policy/review.rego"];
  await s.ready();
  // The first review blocks: its fix run, not the security review that would replace it.
  await s.settle(HIGH);
  assert.deepEqual(steps(s.accepted).at(-1), ["review-fix", null]);
  s.gh.head = "sha-2";
  await s.fixed();
  assert.deepEqual(steps(s.accepted).at(-1), ["review", null]);
  await s.settle(CLEAN);
  // Nothing blocking: the security review, then the merge decided on it.
  assert.deepEqual(steps(s.accepted).at(-1), ["review", SECURE]);
  await s.settle(CLEAN);
  assert.equal(s.instance().current, null);
  assert.equal(s.accepted.length, 4);
  assert.deepEqual(s.instance().vars.counters, { fixes: 1 });
  assert.equal(s.replies.length, 1);
  assert.match(s.replies[0], /^\*\*Not merged automatically\*\* \(`review\.merge`\)/);

  // The first review still blocking after its fix runs: no security review, no merge, the
  // rounds-out comment instead.
  const out = setup({ flow: SECURITY_DOCS });
  out.gh.files = ["policy/review.rego"];
  await out.ready();
  for (const head of ["sha-2", "sha-3"]) {
    await out.settle(HIGH);
    out.gh.head = head;
    await out.fixed();
  }
  await out.settle(HIGH);
  assert.deepEqual(
    steps(out.accepted).map(([reason]) => reason),
    ["review", "review-fix", "review", "review-fix", "review"],
  );
  assert.equal(out.instance().current, null);
  assert.equal(out.replies.length, 1);
  assert.match(out.replies[0], /fix run/);

  // A security review that blocks: fixed, and its push reviewed for security again.
  const secure = setup({ flow: SECURITY_DOCS });
  secure.gh.files = ["policy/review.rego"];
  await secure.ready();
  await secure.settle(CLEAN);
  await secure.settle(HIGH);
  assert.deepEqual(steps(secure.accepted).at(-1), ["review-fix", null]);
  secure.gh.head = "sha-2";
  await secure.fixed();
  assert.deepEqual(steps(secure.accepted).at(-1), ["review", SECURE]);

  // A pull request that leaves the policies alone: its review, then the merge.
  const other = setup({ flow: SECURITY_DOCS });
  other.gh.files = ["docs/a.md"];
  await other.ready();
  await other.settle(CLEAN);
  assert.deepEqual(steps(other.accepted), [["review", null]]);
  assert.equal(other.instance().current, null);
  assert.match(other.replies[0], /^\*\*Not merged automatically\*\*/);
});

// The docs' workflow with both, what #1047 asked a repository to write with no new key: one
// file, as a repository has one workflow on `ready`.
const BOTH = docsExample("Both at once,");

test("both in one file: each blocking review fixed before the next, the second reviewer last", async () => {
  const SECURE = { instructions: ".deckhand/security-review.md" };
  const s = setup({ flow: BOTH });
  s.gh.files = ["policy/review.rego"];
  await s.ready();
  // The first review blocks: its fix run, before any other review replaces it.
  await s.settle(HIGH);
  assert.deepEqual(steps(s.accepted).at(-1), ["review-fix", null]);
  s.gh.head = "sha-2";
  await s.fixed();
  await s.settle(CLEAN);
  // Nothing blocking: the policies changed, so the security review, whose findings are fixed
  // and the fix's push reviewed for security again.
  assert.deepEqual(steps(s.accepted).at(-1), ["review", SECURE]);
  await s.settle(HIGH);
  assert.deepEqual(steps(s.accepted).at(-1), ["review-fix", null]);
  s.gh.head = "sha-3";
  await s.fixed();
  assert.deepEqual(steps(s.accepted).at(-1), ["review", SECURE]);
  await s.settle(CLEAN);
  // Then the second reviewer, on its agent, and the merge decided on its review.
  assert.deepEqual(steps(s.accepted).at(-1), ["review", { agent: "codex", model: "best" }]);
  await s.settle(CLEAN);
  const { vars, current } = s.instance();
  assert.equal(current, null);
  assert.equal(vars.flags.security.head, "sha-2");
  assert.deepEqual(vars.counters, { fixes: 1, security_fixes: 1 });
  assert.equal(s.accepted.length, 7);
  // The merge step decided (its gates are auto-merge.test.mjs's: this fake GitHub has no repo).
  assert.equal(s.replies.length, 1);
  assert.match(s.replies[0], /^\*\*Not merged automatically\*\* \(`review\.merge`\)/);

  // A first review still blocking after its fix runs: no security review nor second reviewer,
  // the rounds-out comment instead.
  const out = setup({ flow: BOTH });
  out.gh.files = ["policy/review.rego"];
  await out.ready();
  for (const head of ["sha-2", "sha-3"]) {
    await out.settle(HIGH);
    out.gh.head = head;
    await out.fixed();
  }
  await out.settle(HIGH);
  assert.deepEqual(steps(out.accepted), [
    ["review", null],
    ["review-fix", null],
    ["review", null],
    ["review-fix", null],
    ["review", null],
  ]);
  assert.equal(out.instance().current, null);
  assert.equal(out.replies.length, 1);
  assert.match(out.replies[0], /fix run/);

  // A pull request that leaves the policies alone: its review, then the second reviewer.
  const other = setup({ flow: BOTH });
  other.gh.files = ["docs/a.md"];
  await other.ready();
  await other.settle(CLEAN);
  assert.deepEqual(steps(other.accepted), [
    ["review", null],
    ["review", { agent: "codex", model: "best" }],
  ]);
});

test("a repo's workflows with errors: no review starts, said why", async () => {
  const s = setup({ flow: SECURITY, errors: ["`.deckhand/workflows/x.yaml` line 1: bad"] });
  const skipped = [];
  await s.reviews.consider(
    "pull_request",
    {
      action: "ready_for_review",
      installation: { id: 1 },
      repository: { full_name: "org/repo", default_branch: "trunk" },
      pull_request: {
        number: 5,
        state: "open",
        draft: false,
        user: { login: "deckhand-app[bot]", type: "Bot" },
        head: { sha: "sha-1", repo: { full_name: "org/repo" } },
      },
    },
    (why) => skipped.push(why),
  );
  assert.deepEqual(s.accepted, []);
  assert.deepEqual(skipped, [
    "review: org/repo's workflows have errors: `.deckhand/workflows/x.yaml` line 1: bad",
  ]);
});

test("the built-in loop: `review:` compiled, each pull request's instance kept in the store", async () => {
  const yaml = "review:\n  on: ready\n  fix: 2\n";
  const maps = mapStore();
  const reviewed = new Map();
  const first = setup({ yaml, instances: await maps.map("workflows"), reviewed });
  await first.ready();
  assert.equal(first.instance().workflow.name, "built-in");
  assert.equal(
    compile(first.instance().workflow.steps)[first.instance().waiting].step.run,
    "review",
  );
  // The next orchestrator: the review's end goes on from the step the instance waits on.
  const next = setup({ yaml, instances: await maps.again("workflows"), reviewed });
  await next.settle(HIGH);
  assert.deepEqual(steps(next.accepted), [["review-fix", null]]);
  assert.deepEqual(next.instance().vars.counters, { fixes: 1 });
  // Closed: its instance goes.
  await next.reviews.closed("pull_request", {
    action: "closed",
    installation: { id: 1 },
    repository: { full_name: "org/repo" },
    pull_request: { number: 5, merged_at: null },
  });
  assert.equal(next.instance(), null);
});

test("runs in flight: a pull request in the loop before the update goes on from its step", async () => {
  // Its first fix run queued by the code before the engine: an entry, no instance.
  const reviewed = new Map([[KEY, { head: "sha-1", at: 1, fixes: 1, fixedAt: 1 }]]);
  const s = setup({ yaml: "review:\n  on: ready\n  fix: 2\n", reviewed });
  s.gh.head = "sha-2";
  await s.fixed();
  // Placed at the loop's fix step: its push reviewed by the loop's review.
  assert.deepEqual(steps(s.accepted), [["review", null]]);
  const ops = compile(s.instance().workflow.steps);
  assert.equal(s.instance().waiting, stepOf("review", true)(ops));
  // That review requests changes: the second fix run, then the loop's max.
  await s.settle(HIGH);
  assert.deepEqual(steps(s.accepted).at(-1), ["review-fix", null]);
  s.gh.head = "sha-3";
  await s.fixed();
  await s.settle(HIGH);
  assert.equal(s.accepted.length, 3);
  assert.match(s.replies.at(-1), /2 fix runs/);
});

test("impliedSettings: a repo's own workflow turns the loop's keys on, the rest of `review:` kept", () => {
  const { settings } = parseRepoConfig("review:\n  max_allowed_severity: medium\n", config);
  const own = parseWorkflow("r.yaml", TWO_REVIEWERS).workflow;
  const { review } = impliedSettings(settings, own);
  assert.deepEqual(
    [review.on, review.fix, review.fixRounds, review.merge, review.ci, review.maxAllowedSeverity],
    ["ready", true, 2, false, false, "medium"],
  );
  // The built-in one was compiled from them: as they are.
  const built = builtInWorkflow("ready", { review: { ...settings.review, on: "ready" } });
  assert.equal(impliedSettings(settings, built), settings);
});

test("loopWarnings: a workflow file's steps decide merge, ci and fix, not the block (#1140)", () => {
  // What the editor's save leaves: `on: ready` turned to manual, the loop's keys kept.
  const yaml = "review:\n  on: manual\n  merge: true\n  ci: wait\n  ci_fix: 1\n";
  const { settings, warnings } = parseRepoConfig(yaml, config);
  assert.equal(warnings.length, 3);
  const flow = "on: ready\nsteps:\n  - run: ci\n  - run: review\n  - run: fix\n  - run: merge\n";
  const own = parseWorkflow("r.yaml", flow).workflow;
  assert.deepEqual(loopWarnings(warnings, settings, own), []);
  // Without the steps, the keys still do nothing: said so, naming the step.
  const bare = parseWorkflow("r.yaml", "on: ready\nsteps:\n  - run: review\n").workflow;
  assert.deepEqual(loopWarnings(warnings, settings, bare), [
    "review.merge: the workflow on `ready` has no `run: merge` step, nothing is merged",
    "review.ci: the workflow on `ready` has no `run: ci` step, nothing waits for CI",
    "review.ci_fix: the workflow on `ready` has no `run: fix` step, no CI fix run starts",
  ]);
  // No file on `ready`, or the built-in loop: the block's own warnings, as they are.
  assert.equal(loopWarnings(warnings, settings, null), warnings);
  const ready = parseRepoConfig("review:\n  on: ready\n  ci_fix: 1\n", config);
  const built = builtInWorkflow("ready", ready.settings);
  assert.equal(loopWarnings(ready.warnings, ready.settings, built), ready.warnings);
});

test("stepSettings: a step's agent, model, effort and instructions for its run alone", () => {
  const { settings } = parseRepoConfig("review:\n  instructions: docs/review.md\n", config);
  const items = [{ workflowStep: { agent: "codex", model: "best", instructions: "sec.md" } }];
  const review = stepSettings(settings, "review", items).review;
  assert.deepEqual([review.agent, review.model, review.instructions], ["codex", "best", "sec.md"]);
  const work = stepSettings(settings, "work", [{ workflowStep: { effort: "high" } }]);
  assert.deepEqual([work.effort, work.agent], ["high", settings.agent]);
  // Without a step, or in another mode: the repo's.
  assert.equal(stepSettings(settings, "review", [{}]), settings);
  // A maintainer's comment batched after the step's item: the run is theirs, on the repo's.
  assert.equal(
    stepSettings(settings, "work", [{ workflowStep: { effort: "high" } }, {}]),
    settings,
  );
  assert.equal(stepSettings(settings, "brainstorm", items), settings);
});

test("docs/repo-config/workflows.md: its workflows are of the format, the compiled one reviewWorkflow()'s", () => {
  const text = readFileSync(new URL("../docs/repo-config/workflows.md", import.meta.url), "utf8");
  const blocks = [...text.matchAll(/^```yaml\n([\s\S]*?)^```$/gm)].map((m) => m[1]);
  const flows = blocks.filter((b) => /^on: /m.test(b));
  assert.ok(flows.length >= 4);
  for (const flow of flows)
    assert.deepEqual(parseWorkflow("doc.yaml", flow).errors.map(errorText), []);
  const { settings } = parseRepoConfig(
    "review:\n  on: ready\n  ci: wait\n  fix: 3\n  merge: true\n",
    config,
  );
  assert.ok(flows.includes(reviewWorkflow(settings.review)));
});

test("a CI step right after another: decided after the decision that reached it, never in it", async () => {
  const flow =
    "on: ready\nsteps:\n  - run: ci\n  - comment: CI over.\n  - run: ci\n  - run: review\n";
  const s = setup({ flow });
  s.gh.runs = [{ id: 1, name: "CI", status: "completed", conclusion: "success" }];
  // The first CI step decided as the pull request turns ready, the second after it.
  await s.ready();
  await until(() => s.accepted.length === 1, { what: "the review after both CI steps" });
  assert.deepEqual(s.replies, ["CI over."]);
  assert.deepEqual(steps(s.accepted), [["review", null]]);
});

test("a review step's instructions are trusted: a pull request changing them waits for a human", () => {
  const { settings } = parseRepoConfig("review: true\n", config);
  const flow = SECURITY.replace(".deckhand/security-review.md", "docs/security-review.md");
  const own = impliedSettings(settings, parseWorkflow("review.yaml", flow).workflow);
  assert.equal(trustedFile(own, "docs/security-review.md"), true);
  assert.equal(trustedFile(own, "docs/other.md"), false);
  assert.equal(trustedFile(settings, "docs/security-review.md"), false);
});
