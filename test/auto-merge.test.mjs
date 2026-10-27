// Auto-merge (`review.merge`, reviews.mjs): what blocks it, its gates, the review after a fix
// run, and that each pull request gets one decision; the policies of the reviews and fix runs
// that lead to it (`deny_review`, `deny_fix`).
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { parseRepoConfig } from "../listener/repo-config.mjs";
import {
  createReviews,
  dryRunText,
  mergeBlockers,
  mergeRefusal,
  parseReview,
  reviewEvent,
  trustedFile,
} from "../listener/reviews.mjs";
import { policyEngine, tempDir, testConfig } from "./helpers.mjs";

const config = { ...testConfig(), bot: "deckhand-app[bot]", needsInputLabel: "needs-input" };

const CLEAN = "Reads well.\n\n- **low** `a.mjs:1`: a typo.\n\nRating: 9/10\nVerdict: approve";
const MEDIUM = "- **medium** `a.mjs:1`: a missing test.\n\nRating: 7/10\nVerdict: comment";
const HIGH = "- **high** `a.mjs:1`: a hole.\n\nRating: 4/10\nVerdict: request-changes";
// The model's own "request changes", on low findings only.
const LOW_CHANGES = "- **low** `a.mjs:1`: a typo.\n\nRating: 8/10\nVerdict: request-changes";

const MERGE = "review:\n  on: ready\n  fix: true\n  merge: true\n";
const FIX_ONLY = "review:\n  on: ready\n  fix: true\n";

// Deckhand's own pull request #5, closing #12, at sha-1, as GitHub has it.
const PR = {
  number: 5,
  title: "Add a thing",
  state: "open",
  draft: false,
  body: "Closes #12",
  labels: [],
  html_url: "https://github.com/org/repo/pull/5",
  user: { login: "deckhand-app[bot]", type: "Bot" },
  head: { sha: "sha-1", repo: { full_name: "org/repo" } },
  mergeable_state: "clean",
  changed_files: 1,
};

// A fake GitHub with a mergeable pull request; `over` changes what it answers: `pr` (or
// `pulls`, successive answers), `info` (the repo), `files`, `runs` (Actions), `issueLabels`,
// `merge` (the merge's status), `pullStatus` (GET of the pull request failing).
function fakeGitHub(over = {}) {
  const calls = [];
  const pulls = over.pulls ? [...over.pulls] : null;
  const github = async (repo, method, path, body) => {
    calls.push({ method, path, body });
    const p = path.replace(/[?&]per_page=\d+&page=\d+$/, "");
    if (method === "GET" && p === "/repos/org/repo/pulls/5" && over.pullStatus) {
      return new Response("{}", { status: over.pullStatus });
    }
    if (method === "GET" && p === "/repos/org/repo/pulls/5") {
      return Response.json({
        ...PR,
        ...(pulls ? (pulls.length > 1 ? pulls.shift() : pulls[0]) : over.pr),
      });
    }
    if (method === "GET" && p === "/repos/org/repo") {
      return Response.json({ private: true, allow_squash_merge: true, ...over.info });
    }
    if (method === "GET" && p === "/repos/org/repo/pulls/5/files") {
      return Response.json(over.files ?? [{ filename: "listener/x.mjs" }]);
    }
    if (method === "GET" && p.startsWith("/repos/org/repo/actions/runs?head_sha=")) {
      if (over.runsStatus) return new Response("{}", { status: over.runsStatus });
      const runs = over.runs ?? [{ name: "CI", status: "completed", conclusion: "success" }];
      return Response.json({ workflow_runs: runs });
    }
    if (method === "GET" && p === "/repos/org/repo/issues/12") {
      return Response.json({ labels: over.issueLabels ?? [] });
    }
    if (method === "PUT" && p === "/repos/org/repo/pulls/5/merge") {
      const status = over.merge ?? 200;
      return Response.json(
        { message: status === 409 ? "Head branch was modified" : "ok" },
        { status },
      );
    }
    return new Response("{}", { status: 404 });
  };
  return { github, calls };
}

// The reviewer in auto-merge mode: a temp reviews.json, a fake clock, queue and GitHub, the
// repo's `yaml`, and its grant (`allowAutoMerge`).
function setup(
  t,
  { yaml = MERGE, grant = true, granted = {}, path, busy = () => false, policies, ...over } = {},
) {
  let time = 1_800_000_000_000;
  const advance = (ms) => (time += ms);
  const accepted = [];
  const replies = [];
  const merged = [];
  const decided = [];
  const gh = fakeGitHub(over);
  const read = parseRepoConfig(yaml, config);
  const reviews = createReviews({
    path: path ?? join(tempDir(t), "reviews.json"),
    config,
    repoSettings: async () => read,
    accept: async (item) => accepted.push(item),
    github: gh.github,
    busy,
    reply: async (repo, number, text) => replies.push({ number, text }),
    grantOf: () => ({ allowAutoMerge: grant, ...granted }),
    merged: (repo, pr) => merged.push(pr.number),
    policies,
    decided: (repo, pr, entry) => decided.push({ repo, pr: pr.number, ...entry }),
    sleep: async () => {},
    now: () => (time += 1000),
  });
  const run = { repo: "org/repo", number: 5, base: "trunk", settings: read.settings, auto: true };
  // As postReview() posts it: its event from the review, as parsed with its tolerance.
  const posted = (message, pr = {}, allowed = "low") => {
    const review = parseReview(message, { allowed });
    return { event: reviewEvent(review), review, pr: { ...PR, ...pr } };
  };
  const settle = (message = CLEAN, extra = {}) =>
    reviews.settle({ ...run, ...extra }, posted(message));
  const merges = () => gh.calls.filter((c) => c.method === "PUT");
  return {
    reviews,
    accepted,
    replies,
    merged,
    decided,
    calls: gh.calls,
    settle,
    merges,
    posted,
    run,
    read,
    over,
    advance,
  };
}

test("mergeBlockers: critical and high always, medium unless allowed, low never", () => {
  const review = parseReview(`${HIGH}\n- **medium** b: x.\n- **low** c: y.`);
  const severities = (list) => list.map((f) => f.severity);
  assert.deepEqual(severities(mergeBlockers(review)), ["high", "medium"]);
  assert.deepEqual(severities(mergeBlockers(review, "medium")), ["high"]);
  assert.deepEqual(mergeBlockers(parseReview(MEDIUM), "medium"), []);
  assert.deepEqual(mergeBlockers(parseReview(CLEAN)), []);
});

test("trustedFile: the config, .deckhand/, .github/, CODEOWNERS and the files it names", () => {
  const settings = parseRepoConfig(
    `instructions: docs/agents.md
dockerfile: build/Dockerfile
preview: sh ./deploy/preview.sh --fast
review:
  instructions: docs/review.md
modes:
  docs:
    instructions: docs/mode.md
`,
    config,
  ).settings;
  for (const path of [
    ".deckhand.yaml",
    ".deckhand/Dockerfile",
    ".github/workflows/ci.yml",
    "CODEOWNERS",
    "docs/CODEOWNERS",
    "docs/agents.md",
    "build/Dockerfile",
    "deploy/preview.sh",
    "docs/review.md",
    "docs/mode.md",
  ]) {
    assert.ok(trustedFile(settings, path), path);
  }
  for (const path of ["listener/x.mjs", "docs/other.md", "src/.deckhand.yaml.md", "github/x"]) {
    assert.ok(!trustedFile(settings, path), path);
  }
});

test("auto-merge: a clean review merges at the reviewed head, says so, once", async (t) => {
  const s = setup(t);
  const done = await s.settle();
  assert.deepEqual(done, { sha: "sha-1", method: "squash" });
  assert.deepEqual(
    s.merges().map((c) => [c.path, c.body]),
    [["/repos/org/repo/pulls/5/merge", { sha: "sha-1", merge_method: "squash" }]],
  );
  assert.deepEqual(s.merged, [5]);
  assert.equal(s.replies.length, 1);
  assert.match(s.replies[0].text, /^🤖 \*\*Merged by Deckhand\*\*/);
  assert.match(s.replies[0].text, /No human reviewed this pull request/);
  // A redelivered end, a restart: no second decision.
  assert.equal(await s.settle(), null);
  assert.equal(s.merges().length, 1);
});

test("auto-merge: review.merge_method, checked against what the repository allows", async (t) => {
  const yaml = `${MERGE}  merge_method: rebase\n`;
  const ok = setup(t, { yaml, info: { allow_rebase_merge: true } });
  assert.deepEqual(await ok.settle(), { sha: "sha-1", method: "rebase" });
  const commit = setup(t, {
    yaml: `${MERGE}  merge_method: merge\n`,
    info: { allow_merge_commit: false },
  });
  assert.equal(await commit.settle(), null);
  assert.match(commit.replies[0].text, /doesn't allow the `merge` merge method/);
  const refused = setup(t, { yaml, info: { allow_rebase_merge: false } });
  assert.equal(await refused.settle(), null);
  assert.equal(refused.merges().length, 0);
  assert.match(refused.replies[0].text, /doesn't allow the `rebase` merge method/);
});

test("auto-merge: nothing without the grant, on: ready, review.merge, or from /mode review", async (t) => {
  for (const s of [
    setup(t, { grant: false }),
    setup(t, { yaml: "review:\n  fix: true\n  merge: true\n" }),
    setup(t, { yaml: "review:\n  on: ready\n  fix: true\n" }),
  ]) {
    assert.equal(await s.settle(), null);
    assert.equal(s.merges().length + s.replies.length, 0);
  }
  const manual = setup(t);
  assert.equal(await manual.settle(CLEAN, { auto: false }), null);
  assert.equal(manual.merges().length + manual.replies.length, 0);
  // A public repository needs the grant's `public`.
  const open = setup(t, { info: { private: false } });
  assert.equal(await open.settle(), null);
  assert.match(
    open.replies[0].text,
    /the repository is public.*`allow_auto_merge: true`, not `public`/,
  );
  const granted = setup(t, { grant: "public", info: { private: false } });
  assert.ok(await granted.settle());
});

test("auto-merge: blocking findings leave it to the maintainer, or start the fix run", async (t) => {
  // review.fix: the fix run, no merge, no comment yet.
  const fixing = setup(t);
  const item = await fixing.settle(HIGH);
  assert.equal(item.reason, "review-fix");
  assert.equal(fixing.merges().length + fixing.replies.length, 0);
  // Without it: medium blocks too.
  const noFix = setup(t, { yaml: "review:\n  on: ready\n  merge: true\n" });
  assert.equal(await noFix.settle(MEDIUM), null);
  assert.equal(noFix.merges().length, 0);
  assert.match(
    noFix.replies[0].text,
    /^\*\*Not merged automatically\*\*.*still has medium findings/,
  );
  // The fix run couldn't start (the task is busy): said so.
  const busy = setup(t, { busy: () => true });
  assert.equal(await busy.settle(HIGH), null);
  assert.match(busy.replies[0].text, /high findings and no fix run started/);
  // The model's "request changes" on low findings only: posted as a comment, never merged.
  const lowChanges = setup(t);
  assert.equal(await lowChanges.settle(LOW_CHANGES), null);
  assert.equal(lowChanges.merges().length + lowChanges.accepted.length, 0);
  assert.match(
    lowChanges.replies[0].text,
    /^\*\*Not merged automatically\*\*.*: the review requests changes\./,
  );
  // Posted as REQUEST_CHANGES (the settings changed since, say): never merged either.
  const requested = setup(t, { yaml: "review:\n  on: ready\n  merge: true\n" });
  const clean = { ...requested.posted(CLEAN), event: "REQUEST_CHANGES" };
  assert.equal(await requested.reviews.settle(requested.run, clean), null);
  assert.equal(requested.merges().length, 0);
  assert.match(requested.replies[0].text, /the review requests changes/);
  // Unreadable: never merged.
  const odd = setup(t);
  assert.equal(await odd.settle("LGTM"), null);
  assert.match(odd.replies[0].text, /format couldn't be read/);
});

test("auto-merge: each gate refuses with a comment", async (t) => {
  const cases = [
    [{ pr: { user: { login: "alice", type: "User" } } }, /isn't Deckhand's own pull request/],
    [
      { pr: { head: { sha: "sha-1", repo: { full_name: "someone/fork" } } } },
      /isn't Deckhand's own/,
    ],
    [{ pr: { body: "No issue." } }, /linked to its issue/],
    [{ pr: { draft: true } }, /it is a draft/],
    [{ pr: { labels: [{ name: "needs-input" }] } }, /waits for the maintainer's input/],
    [{ issueLabels: [{ name: "needs-input" }] }, /waits for the maintainer's input/],
    [{ busy: (key) => key === "org/repo#12" }, /#12 has a run going or queued/],
    [{ pr: { mergeable_state: "dirty" } }, /`mergeable_state: dirty`/],
    [{ pr: { mergeable_state: "behind" } }, /`mergeable_state: behind`/],
    [{ pr: { mergeable_state: "blocked" } }, /`mergeable_state: blocked`/],
    [
      { pr: { mergeable_state: "unstable" } },
      /a check or commit status on sha-1 that isn't a GitHub Actions run is pending or failing/,
    ],
    [
      {
        yaml: `${MERGE}  merge_wait: 0\n`,
        runs: [{ name: "CI", status: "in_progress", conclusion: null }],
      },
      /: 1 GitHub Actions run on sha-1 hasn't finished\. It waits/,
    ],
    [
      { runs: [{ name: "CI", status: "completed", conclusion: "failure" }] },
      /failed: CI \(failure\)/,
    ],
    [{ runsStatus: 403 }, /Actions runs can't be read \(403\)/],
    [
      { files: [{ filename: ".deckhand.yaml" }] },
      /changes files Deckhand trusts: `\.deckhand\.yaml`/,
    ],
    [{ files: [{ filename: ".deckhand/review.md" }] }, /`\.deckhand\/review\.md`/],
    [{ files: [{ filename: ".github/workflows/ci.yml" }] }, /`\.github\/workflows\/ci\.yml`/],
    [{ files: [{ filename: "x.md", previous_filename: "CODEOWNERS" }] }, /`CODEOWNERS`/],
    [
      {
        yaml: `${MERGE}preview: ./deploy/preview.sh\n`,
        files: [{ filename: "deploy/preview.sh" }],
      },
      /`deploy\/preview\.sh`/,
    ],
    [
      {
        yaml: MERGE.replace("merge: true", "merge: true\n  instructions: docs/review.md"),
        files: [{ filename: "docs/review.md" }],
      },
      /`docs\/review\.md`/,
    ],
    [{ info: { private: false } }, /the repository is public/],
  ];
  for (const [over, why] of cases) {
    const s = setup(t, over);
    assert.equal(await s.settle(), null, String(why));
    assert.equal(s.merges().length, 0, String(why));
    assert.equal(s.replies.length, 1, String(why));
    assert.match(s.replies[0].text, why);
    assert.match(s.replies[0].text, /It waits for a maintainer's review and merge\.$/);
  }
});

test("auto-merge: mergeable_state asked again while GitHub computes it", async (t) => {
  const s = setup(t, {
    pulls: [
      { mergeable_state: null },
      { mergeable_state: "unknown" },
      { mergeable_state: "clean" },
    ],
  });
  assert.ok(await s.settle());
  const asked = s.calls.filter((c) => c.path === "/repos/org/repo/pulls/5").length;
  assert.equal(asked, 3);
});

test("auto-merge: a push after the review makes the merge fail, said so", async (t) => {
  // Seen before the merge: never asked.
  const moved = setup(t, { pr: { head: { sha: "sha-2", repo: { full_name: "org/repo" } } } });
  assert.equal(await moved.settle(), null);
  assert.equal(moved.merges().length, 0);
  assert.match(moved.replies[0].text, /pushed after the review \(reviewed sha-1, now sha-2\)/);
  // Between the gates and the merge: GitHub refuses the reviewed sha.
  const late = setup(t, { merge: 409 });
  assert.equal(await late.settle(), null);
  assert.equal(late.merges()[0].body.sha, "sha-1");
  assert.deepEqual(late.merged, []);
  assert.match(late.replies[0].text, /GitHub refused the merge \(409: Head branch was modified\)/);
  // The review was queued at another head than the one it was posted on.
  const during = setup(t);
  await during.reviews.consider("pull_request", {
    action: "ready_for_review",
    installation: { id: 1 },
    repository: { full_name: "org/repo", default_branch: "trunk" },
    pull_request: { ...PR, head: { sha: "sha-0", repo: { full_name: "org/repo" } } },
  });
  assert.equal(await during.settle(), null);
  assert.match(during.replies[0].text, /a commit was pushed while the review ran/);
});

test("auto-merge: after the fix run, one review of its push, then the merge", async (t) => {
  const path = join(tempDir(t), "reviews.json");
  const pushed = { head: { sha: "sha-2", repo: { full_name: "org/repo" } } };
  const s = setup(t, { path, pr: pushed });
  const first = await s.reviews.settle(s.run, s.posted(HIGH));
  assert.equal(first.reason, "review-fix");
  const fixedRun = { repo: "org/repo", number: 5, base: "trunk", status: "ok" };
  const review = await s.reviews.fixed(fixedRun);
  assert.deepEqual(
    [review.trigger, review.reason, review.id, review.replyTo],
    ["review", "review", "12", 5],
  );
  // Once: again, or after a restart, no second review.
  assert.equal(await s.reviews.fixed(fixedRun), null);
  const again = setup(t, { path, pr: pushed });
  assert.equal(await again.reviews.fixed(fixedRun), null);
  assert.equal(s.accepted.length + again.accepted.length, 2);
  // Its review, clean: merged at the pushed head.
  const done = await again.reviews.settle(again.run, again.posted(CLEAN, pushed));
  assert.deepEqual(done, { sha: "sha-2", method: "squash" });
  assert.match(again.replies[0].text, /after its fix run and a second review/);
});

// Issue #288: GitHub showed "request changes" on the review after the fix run, and it merged.
test("auto-merge: after the fix run, a medium finding requests changes and blocks", async (t) => {
  const path = join(tempDir(t), "reviews.json");
  const pushed = { head: { sha: "sha-2", repo: { full_name: "org/repo" } } };
  const s = setup(t, { path, pr: pushed });
  await s.reviews.settle(s.run, s.posted(HIGH));
  await s.reviews.fixed({ repo: "org/repo", number: 5, base: "trunk", status: "ok" });
  const at = { repo: "org/repo", number: 5, base: "trunk", auto: true };
  assert.equal(await s.reviews.tolerance(at), "low");
  const second = s.posted(MEDIUM, pushed);
  assert.equal(second.event, "REQUEST_CHANGES");
  assert.equal(await s.reviews.settle(s.run, second), null);
  assert.equal(s.merges().length, 0);
  assert.equal(s.accepted.filter((i) => i.reason === "review-fix").length, 1);
  assert.match(
    s.replies[0].text,
    /^\*\*Not merged automatically\*\*.*the review after the fix run still has medium findings/,
  );
});

test("auto-merge: review.max_allowed_severity medium, the deciding review posted as a comment", async (t) => {
  const yaml = `${MERGE}  max_allowed_severity: medium\n`;
  const path = join(tempDir(t), "reviews.json");
  const pushed = { head: { sha: "sha-2", repo: { full_name: "org/repo" } } };
  const s = setup(t, { yaml, path, pr: pushed });
  const at = { repo: "org/repo", number: 5, base: "trunk", auto: true };
  // The first review, with review.fix: medium still requests changes, for the fix run.
  assert.equal(await s.reviews.tolerance(at), "low");
  assert.equal(await s.reviews.tolerance({ ...at, auto: false }), "low");
  const first = s.posted(MEDIUM);
  assert.equal(first.event, "REQUEST_CHANGES");
  assert.equal((await s.reviews.settle(s.run, first)).reason, "review-fix");
  await s.reviews.fixed({ repo: "org/repo", number: 5, base: "trunk", status: "ok" });
  // The review after it decides the merge: medium allowed, even with the prompt's verdict.
  assert.equal(await s.reviews.tolerance(at), "medium");
  const message = MEDIUM.replace("Verdict: comment", "Verdict: request-changes");
  const second = s.posted(message, pushed, "medium");
  assert.deepEqual([second.event, second.review.verdict], ["COMMENT", "comment"]);
  assert.deepEqual(await s.reviews.settle(s.run, second), { sha: "sha-2", method: "squash" });
  assert.match(s.replies[0].text, /medium findings allowed by `review.max_allowed_severity`/);
  // High still blocks; without review.fix the first review decides; low + "request changes"
  // still blocks.
  const high = setup(t, {
    yaml: "review:\n  on: ready\n  merge: true\n  max_allowed_severity: medium\n",
  });
  assert.equal(await high.reviews.tolerance(at), "medium");
  const posted = high.posted(`${HIGH}\n- **medium** b: x.`, {}, "medium");
  assert.equal(posted.event, "REQUEST_CHANGES");
  assert.equal(await high.reviews.settle(high.run, posted), null);
  assert.match(high.replies[0].text, /the review still has high findings/);
  const low = setup(t, {
    yaml: "review:\n  on: ready\n  merge: true\n  max_allowed_severity: medium\n",
  });
  assert.equal(await low.reviews.settle(low.run, low.posted(LOW_CHANGES, {}, "medium")), null);
  assert.match(low.replies[0].text, /the review requests changes/);
  const plain = setup(t, {
    yaml: "review:\n  on: ready\n  merge: true\n  max_allowed_severity: medium\n",
  });
  assert.ok(await plain.reviews.settle(plain.run, plain.posted(MEDIUM, {}, "medium")));
});

test("auto-merge: a second review that still blocks merges nothing, starts no fix", async (t) => {
  const path = join(tempDir(t), "reviews.json");
  const pushed = { head: { sha: "sha-2", repo: { full_name: "org/repo" } } };
  const s = setup(t, { path, pr: pushed });
  await s.reviews.settle(s.run, s.posted(HIGH));
  await s.reviews.fixed({ repo: "org/repo", number: 5, base: "trunk", status: "ok" });
  // A restart in between: reviews.json keeps it.
  const after = setup(t, { path, pr: pushed });
  assert.equal(await after.reviews.settle(after.run, after.posted(HIGH, pushed)), null);
  assert.equal(after.accepted.length + after.merges().length, 0);
  assert.match(after.replies[0].text, /the review after the fix run still has high findings/);
});

test("auto-merge: a fix run that failed or pushed nothing leaves it to the maintainer", async (t) => {
  const failed = setup(t);
  await failed.reviews.settle(failed.run, failed.posted(HIGH));
  const run = { repo: "org/repo", number: 5, base: "trunk" };
  assert.equal(await failed.reviews.fixed({ ...run, status: "error" }), null);
  assert.match(failed.replies[0].text, /the fix run ended with `error`/);
  const idle = setup(t);
  await idle.reviews.settle(idle.run, idle.posted(HIGH));
  // The head it was reviewed at: nothing pushed.
  await idle.reviews.consider("pull_request", {
    action: "ready_for_review",
    installation: { id: 1 },
    repository: { full_name: "org/repo", default_branch: "trunk" },
    pull_request: PR,
  });
  assert.equal(await idle.reviews.fixed({ ...run, status: "ok" }), null);
  assert.match(idle.replies[0].text, /the fix run pushed nothing/);
  assert.equal(idle.accepted.filter((i) => i.reason === "review").length, 1);
  // Either way, decided: its later reviews merge nothing.
  assert.equal(await idle.settle(), null);
  assert.equal(idle.merges().length, 0);
  // Not in auto-merge mode: a fix run's end does nothing.
  const off = setup(t, { grant: false });
  await off.reviews.settle(off.run, off.posted(HIGH));
  assert.equal(await off.reviews.fixed({ ...run, status: "ok" }), null);
  assert.equal(off.accepted.length, 1);
});

test("mergeRefusal: everything passes, the pull request and method come back", async () => {
  const { github } = fakeGitHub();
  const settings = parseRepoConfig(MERGE, config).settings;
  const gate = await mergeRefusal(
    { github, config, sleep: async () => {} },
    { repo: "org/repo", number: 5, sha: "sha-1", settings, grant: { allowAutoMerge: true } },
  );
  assert.equal(gate.why, null);
  assert.equal(gate.method, "squash");
  assert.equal(gate.pr.number, 5);
});

test("auto-merge: deny_merge refuses with its reasons, after every built-in gate", async (t) => {
  const policy = policyEngine(t, {
    files: { "size.rego": "package deckhand" },
    messages: (input) => (input.pr.files.length >= 1 ? ["a human merges `listener/` changes"] : []),
  });
  const s = setup(t, { policies: policy.engine });
  assert.equal(await s.settle(), null);
  assert.equal(s.merges().length, 0);
  assert.match(
    s.replies[0].text,
    /^\*\*Not merged automatically\*\* \(`review\.merge`\): the policies refuse it \(`deny_merge`\): `a human merges 'listener\/' changes`\. It waits/,
  );
  const [input] = policy.evals;
  assert.equal(input.version, 1);
  assert.equal(input.decision, "merge");
  assert.equal(input.pr.number, 5);
  assert.deepEqual(
    input.pr.files.map((f) => f.path),
    ["listener/x.mjs"],
  );
  assert.equal(input.review.verdict, "approve");
  assert.equal(input.fixed, false);
  assert.deepEqual(input.checks, [{ name: "CI", status: "completed", conclusion: "success" }]);
  // A built-in gate that refuses first: no policy asked.
  const draft = policyEngine(t, { files: { "size.rego": "package deckhand" } });
  const early = setup(t, { policies: draft.engine, pr: { draft: true } });
  assert.equal(await early.settle(), null);
  assert.equal(draft.evals.length, 0);
});

test("auto-merge: a policy error refuses; no policy, no opa call and the merge", async (t) => {
  const broken = policyEngine(t, {
    files: { "bad.rego": "package deckhand" },
    failure: { code: 1, stdout: '{"errors":[{"message":"rego_parse_error: unexpected eof"}]}' },
  });
  const s = setup(t, { policies: broken.engine });
  assert.equal(await s.settle(), null);
  assert.equal(s.merges().length, 0);
  assert.match(s.replies[0].text, /`policy error: rego_parse_error: unexpected eof`/);
  const none = policyEngine(t);
  const clean = setup(t, { policies: none.engine });
  assert.ok(await clean.settle());
  assert.equal(none.evals.length, 0);
  assert.equal(clean.merges().length, 1);
});

test("decisions: each one a policy was asked for is kept for the task's page", async (t) => {
  const policy = policyEngine(t, {
    files: { "size.rego": "package deckhand" },
    messages: () => ["a human merges this one"],
  });
  const s = setup(t, { policies: policy.engine });
  await s.settle();
  const { gates, input, ...decision } = s.decided[0];
  assert.equal(s.decided.length, 1);
  assert.deepEqual(decision, {
    repo: "org/repo",
    pr: 5,
    decision: "merge",
    rule: "deny_merge",
    denied: true,
    messages: ["a human merges this one"],
  });
  // A refused auto-merge lists the built-in gates that passed before the policies.
  assert.deepEqual(gates, [
    { name: "Severity ≤ low", passed: true },
    { name: "Review: nothing blocking", passed: true },
    { name: "At the reviewed commit", passed: true },
    { name: "Deckhand's own pull request", passed: true },
    { name: "Open, not a draft", passed: true },
    { name: "Nobody's input awaited", passed: true },
    { name: "No run going", passed: true },
    { name: "Repository visibility", passed: true },
    { name: "Merge method squash allowed", passed: true },
    { name: "No trusted file changed", passed: true },
    { name: "Cleanly mergeable", passed: true },
    { name: "Checks green", passed: true },
  ]);
  // And the input the rules saw, as evaluated.
  const { rule, ...evaluated } = policy.evals[0];
  assert.deepEqual([input.version, input.decision, input.pr.number], [1, "merge", 5]);
  assert.deepEqual(input, evaluated);
  const allowing = policyEngine(t, { files: { "size.rego": "package deckhand" } });
  const merged = setup(t, { policies: allowing.engine });
  assert.ok(await merged.settle());
  assert.deepEqual(
    merged.decided.map((d) => [d.rule, d.denied, d.messages]),
    [["deny_merge", false, []]],
  );
  // No policy anywhere: nothing to keep.
  const none = setup(t, { policies: policyEngine(t).engine });
  assert.ok(await none.settle());
  assert.deepEqual(none.decided, []);
});

test("/mode policy: every rule on the pull request now, nothing reviewed, fixed or merged", async (t) => {
  const policy = policyEngine(t, {
    files: { "size.rego": 'package deckhand\ndeny_merge contains "x" if true\n' },
    // Replaced by the repo's: not one of the files the dry run evaluates.
    operator: { "size.rego": 'package deckhand\ndeny_review contains "y" if true\n' },
    messages: (input, rule) => (rule === "deny_merge" ? ["a `human` merges this one"] : []),
  });
  const s = setup(t, { policies: policy.engine, pr: { additions: 12 } });
  const { text, denials } = await s.reviews.dryRun({ repo: "org/repo", base: "main", number: 5 });
  assert.equal(denials, 1);
  assert.match(
    text,
    /^\*\*Policy dry run\*\* on #5 at sha-1: nothing was reviewed, fixed or merged\./,
  );
  assert.match(text, /Policies: `size\.rego` \(repo, replaces the operator's\)\./);
  assert.match(text, /- `deny_merge`: \*\*denies\*\*: `a 'human' merges this one`/);
  assert.match(text, /- `deny_review`: allows \(no file defines it\)/);
  assert.match(text, /- `deny_fix`: allows \(no file defines it\)/);
  assert.match(text, /<details><summary>The input/);
  const json = JSON.parse(/```json\n([\s\S]*)\n```/.exec(text)[1]);
  assert.equal(json.version, 1);
  assert.equal(json.decision, "merge");
  assert.equal(json.pr.additions, 12);
  assert.equal(json.review, null);
  assert.deepEqual(json.checks, [{ name: "CI", status: "completed", conclusion: "success" }]);
  // Each rule got its own decision; review and fix without the merge's fields.
  assert.deepEqual(
    policy.evals.map((e) => [e.rule, e.decision, "checks" in e]),
    [
      ["deny_merge", "merge", true],
      ["deny_review", "review", false],
      ["deny_fix", "fix", false],
    ],
  );
  assert.equal(s.accepted.length + s.merges().length + s.replies.length + s.decided.length, 0);
  // Without policies: said, no GitHub call for the pull request.
  const none = setup(t, { policies: policyEngine(t).engine });
  const said = await none.reviews.dryRun({ repo: "org/repo", base: "main", number: 5 });
  assert.match(said.text, /No policy applies here/);
  assert.equal(said.denials, 0);
  assert.equal(none.calls.length, 0);
});

test("dryRunText: an operator file replaced, the check's errors, a long input cut", () => {
  const text = dryRunText({
    number: 5,
    sha: "abcdef123",
    files: [
      { name: "a.rego", source: "operator", replaces: false, rules: [] },
      { name: "b.rego", source: "repo", replaces: true, rules: ["deny_merge"] },
    ],
    errors: ["policy error: b.rego:2: unexpected eof"],
    results: [
      { rule: "deny_merge", defined: true, messages: ["policy error: b.rego:2: unexpected eof"] },
    ],
    input: { pr: { title: "```".repeat(2) + "x".repeat(60_000) } },
  });
  assert.match(text, /`a\.rego` \(operator\), `b\.rego` \(repo, replaces the operator's\)/);
  assert.match(text, /The config check has errors:\n\n- `policy error: b\.rego:2: unexpected eof`/);
  // A fence longer than any backticks of the input, and the input cut under GitHub's limit.
  assert.match(text, /```````json\n/);
  assert.match(text, /… \(cut\)\n```````/);
  assert.ok(text.length < 60_000);
});

// A pull request turned ready, as its webhook says.
const ready = (pr = {}) => ({
  action: "ready_for_review",
  installation: { id: 1 },
  repository: { full_name: "org/repo", default_branch: "trunk" },
  pull_request: { ...PR, ...pr },
});

const REVIEW_ON = "review:\n  on: ready\n";

test("deny_review: a matching rule skips the automatic review, said as a skip, no comment", async (t) => {
  const policy = policyEngine(t, {
    ref: "trunk",
    files: { "wip.rego": "package deckhand" },
    messages: (input, rule) =>
      rule === "deny_review" && input.pr.labels.includes("wip") ? ["work in progress"] : [],
  });
  const skipped = [];
  const s = setup(t, {
    yaml: REVIEW_ON,
    policies: policy.engine,
    issueLabels: [{ name: "area: docs" }],
  });
  const wip = ready({ labels: [{ name: "wip" }] });
  assert.equal(
    await s.reviews.consider("pull_request", wip, (why) => (skipped.push(why), null)),
    null,
  );
  assert.equal(s.accepted.length + s.replies.length, 0);
  assert.deepEqual(skipped, [
    "review: #5, the policies refuse it (`deny_review`): `work in progress`",
  ]);
  const [input] = policy.evals;
  assert.deepEqual(
    [input.version, input.decision, input.rule, input.pr.number, input.pr.labels],
    [1, "review", "deny_review", 5, ["wip"]],
  );
  assert.deepEqual(input.pr.files, [
    { path: "listener/x.mjs", previous_path: null, status: null, additions: 0, deletions: 0 },
  ]);
  assert.deepEqual(input.issue, { number: 12, title: "", labels: ["area: docs"] });
  assert.equal(input.review, null);
  // Kept for the task's page with the gates that passed first.
  assert.deepEqual(
    s.decided[0].gates.map((g) => g.name),
    ["Ready for review", "Deckhand's own pull request", "Not reviewed at this commit"],
  );
  // Not remembered: without the label, the same head commit is reviewed.
  assert.ok(await s.reviews.consider("pull_request", ready()));
  assert.equal(s.accepted.length, 1);
  // A review a maintainer asked for (`/mode review`) settles without asking deny_review.
  const asked = policy.evals.length;
  await s.reviews.settle({ ...s.run, auto: false }, s.posted(CLEAN, { labels: ["wip"] }));
  assert.equal(policy.evals.filter((e) => e.rule === "deny_review").length, asked);
});

test("deny_review: a policy error skips the review; no policy, no extra GitHub call", async (t) => {
  const broken = policyEngine(t, {
    ref: "trunk",
    files: { "bad.rego": "package deckhand" },
    failure: { code: 1, stdout: '{"errors":[{"message":"rego_parse_error: unexpected eof"}]}' },
  });
  const skipped = [];
  const s = setup(t, { yaml: REVIEW_ON, policies: broken.engine });
  await s.reviews.consider("pull_request", ready(), (why) => (skipped.push(why), null));
  assert.equal(s.accepted.length, 0);
  assert.match(skipped[0], /`policy error: rego_parse_error: unexpected eof`/);
  const none = policyEngine(t, { ref: "trunk" });
  const clean = setup(t, { yaml: REVIEW_ON, policies: none.engine });
  assert.ok(await clean.reviews.consider("pull_request", ready()));
  assert.deepEqual([none.evals.length, clean.calls.length], [0, 0]);
});

test("deny_review: the review after a fix run, refused, leaves the merge to the maintainer", async (t) => {
  const policy = policyEngine(t, {
    ref: "trunk",
    files: { "big.rego": "package deckhand" },
    messages: (input, rule) => (rule === "deny_review" ? ["too big for a second look"] : []),
  });
  const pushed = { head: { sha: "sha-2", repo: { full_name: "org/repo" } } };
  const s = setup(t, { pr: pushed, policies: policy.engine });
  assert.equal((await s.reviews.settle(s.run, s.posted(HIGH))).reason, "review-fix");
  const run = { repo: "org/repo", number: 5, base: "trunk", status: "ok" };
  assert.equal(await s.reviews.fixed(run), null);
  assert.equal(s.accepted.filter((i) => i.reason === "review").length, 0);
  assert.match(
    s.replies[0].text,
    /^\*\*Not merged automatically\*\*.*the policies refuse it \(`deny_review`\): `too big for a second look`/,
  );
  assert.equal(s.merges().length, 0);
});

test("deny_fix: a finding's path starts no fix run, a comment quotes why, nothing merged", async (t) => {
  const policy = policyEngine(t, {
    ref: "trunk",
    files: { "paths.rego": "package deckhand" },
    messages: (input, rule) =>
      rule === "deny_fix" && input.review.findings.some((f) => f.path?.startsWith("a."))
        ? ["a finding in `a.mjs`: a human fixes it"]
        : [],
  });
  const s = setup(t, { policies: policy.engine });
  assert.equal(await s.reviews.settle(s.run, s.posted(HIGH)), null);
  assert.equal(s.accepted.length + s.merges().length, 0);
  assert.equal(
    s.replies[0].text,
    "**No fix run** (`review.fix`): the policies refuse it (`deny_fix`): `a finding in 'a.mjs': a human fixes it`. The review's findings wait for a maintainer.",
  );
  assert.match(
    s.replies[1].text,
    /^\*\*Not merged automatically\*\*.*the review has high findings and no fix run started \(the policies refuse it \(`deny_fix`\): `a finding in 'a.mjs': a human fixes it`\)/,
  );
  const [input] = policy.evals;
  assert.deepEqual([input.decision, input.rule, input.issue.number], ["fix", "deny_fix", 12]);
  assert.deepEqual(input.review.findings, [
    { severity: "high", path: "a.mjs", line: 1, text: "a hole." },
  ]);
  assert.equal(input.review.verdict, "request-changes");
  assert.deepEqual(
    [s.decided[0].rule, s.decided[0].gates.every((g) => g.passed), s.decided[0].gates.length],
    ["deny_fix", true, 5],
  );
  // Without auto-merge: the comment alone; the pull request's fix run isn't used up.
  const plain = setup(t, { yaml: FIX_ONLY, policies: policy.engine });
  assert.equal(await plain.reviews.fix(plain.run, plain.posted(HIGH)), null);
  assert.equal(plain.replies.length, 1);
  assert.match(plain.replies[0].text, /^\*\*No fix run\*\*/);
  const elsewhere = "- **high** `b.mjs:1`: a hole.\n\nRating: 4/10\nVerdict: request-changes";
  assert.equal((await plain.reviews.fix(plain.run, plain.posted(elsewhere))).reason, "review-fix");
});

test("deny_fix: a policy error starts no fix run, the comment says so", async (t) => {
  const broken = policyEngine(t, {
    ref: "trunk",
    files: { "bad.rego": "package deckhand" },
    failure: { code: 0, stdout: '{"result":[{"expressions":[{"value":[1]}]}]}' },
  });
  const s = setup(t, { yaml: FIX_ONLY, policies: broken.engine });
  assert.equal(await s.reviews.fix(s.run, s.posted(HIGH)), null);
  assert.equal(s.accepted.length, 0);
  assert.match(s.replies[0].text, /`policy error: 'deny_fix' must be a set of strings`/);
});

test("auto-merge with a granted preview hook: only with the operator's long acknowledgement", async (t) => {
  const yaml = `${MERGE}preview: ./deploy/preview.sh\n`;
  const hook = setup(t, { yaml, granted: { allowPreview: true } });
  assert.equal(await hook.settle(), null);
  assert.equal(hook.merges().length, 0);
  assert.match(
    hook.replies[0].text,
    /preview hook runs its default branch as root on the host.*`acknowledge_automerge_and_preview_is_highly_dangerous: true`/,
  );
  // Asked of nobody: the config alone refuses it.
  assert.equal(hook.calls.length, 0);
  const acknowledged = setup(t, {
    yaml,
    granted: { allowPreview: true, acknowledgeAutoMergePreview: true },
  });
  assert.ok(await acknowledged.settle());
  // The hook's own script still waits for a human.
  const script = setup(t, {
    yaml,
    granted: { allowPreview: true, acknowledgeAutoMergePreview: true },
    files: [{ filename: "deploy/preview.sh" }],
  });
  assert.equal(await script.settle(), null);
  assert.match(script.replies[0].text, /`deploy\/preview\.sh`/);
});

test("auto-merge: more changed files than GitHub lists refuses it", async (t) => {
  const s = setup(t, { pr: { changed_files: 3001 } });
  assert.equal(await s.settle(), null);
  assert.equal(s.merges().length, 0);
  assert.match(s.replies[0].text, /GitHub lists 1 of its 3001 changed files/);
});

test("auto-merge: GitHub failing during the gates or after the fix run is said, decided", async (t) => {
  const s = setup(t, { pullStatus: 502 });
  assert.equal(await s.settle(), null);
  assert.equal(s.merges().length, 0);
  assert.match(s.replies[0].text, /GitHub couldn't be read \(GitHub GET .*: 502\)/);
  assert.equal(await s.settle(), null);
  assert.equal(s.replies.length, 1);
  const fix = setup(t, { pullStatus: 502 });
  await fix.reviews.settle(fix.run, fix.posted(HIGH));
  const run = { repo: "org/repo", number: 5, base: "trunk", status: "ok" };
  assert.equal(await fix.reviews.fixed(run), null);
  assert.match(fix.replies[0].text, /GitHub couldn't be read/);
  assert.equal(fix.accepted.filter((i) => i.reason === "review").length, 0);
  // Decided: a later review merges nothing.
  assert.equal(await fix.settle(), null);
  assert.equal(fix.merges().length, 0);
});

// GitHub Actions' delivery of a run that completed on `sha`.
function completed(sha = "sha-1", repo = "org/repo") {
  return {
    action: "completed",
    installation: { id: 1 },
    repository: { full_name: repo, default_branch: "trunk" },
    workflow_run: { head_sha: sha, status: "completed", conclusion: "success" },
  };
}

const GOING = { name: "CI", status: "in_progress", conclusion: null };
const PASSED = { name: "CI", status: "completed", conclusion: "success" };

// Issue #328: `unstable` while CI ran on the head commit was refused at once.
test("auto-merge: unstable with an Actions run going waits, then merges once it passed", async (t) => {
  const s = setup(t, { pr: { mergeable_state: "unstable" }, runs: [GOING] });
  assert.equal(await s.settle(), null);
  assert.deepEqual([s.replies, s.merges()], [[], []]);
  // A redelivered end of the review decides nothing while it waits.
  assert.equal(await s.settle(), null);
  // Another commit's run, another repo's: still waiting.
  await s.reviews.checksDone("workflow_run", completed("sha-9"));
  await s.reviews.checksDone("workflow_run", completed("sha-1", "org/other"));
  // Not completed yet: nothing asked.
  const before = s.calls.length;
  await s.reviews.checksDone("workflow_run", { ...completed(), action: "in_progress" });
  assert.equal(s.calls.length, before);
  assert.equal(s.merges().length, 0);
  s.over.pr = { mergeable_state: "clean" };
  s.over.runs = [PASSED];
  await s.reviews.checksDone("workflow_run", completed());
  assert.deepEqual(
    s.merges().map((c) => c.body),
    [{ sha: "sha-1", merge_method: "squash" }],
  );
  assert.equal(s.replies.length, 1);
  assert.match(s.replies[0].text, /^🤖 \*\*Merged by Deckhand\*\*/);
  // Decided: neither a later run nor a tick merges twice.
  await s.reviews.checksDone("workflow_run", completed());
  await s.reviews.tick();
  assert.equal(await s.settle(), null);
  assert.equal(s.merges().length, 1);
});

test("auto-merge: two runs completing at once merge once", async (t) => {
  const s = setup(t, { runs: [GOING, GOING] });
  await s.settle();
  s.over.runs = [PASSED, PASSED];
  await Promise.all([
    s.reviews.checksDone("workflow_run", completed()),
    s.reviews.checksDone("workflow_run", completed()),
  ]);
  assert.equal(s.merges().length, 1);
  assert.equal(s.replies.length, 1);
});

test("auto-merge: a pull request waiting for its checks survives a restart", async (t) => {
  const path = join(tempDir(t), "reviews.json");
  const first = setup(t, { path, runs: [GOING] });
  await first.settle();
  assert.equal(first.replies.length, 0);
  const next = setup(t, { path });
  await next.reviews.checksDone("workflow_run", completed());
  assert.equal(next.merges().length, 1);
  assert.match(next.replies[0].text, /Merged by Deckhand/);
});

test("auto-merge: while waiting, a failed run, a push or a close ends it", async (t) => {
  const failed = setup(t, { runs: [GOING] });
  await failed.settle();
  failed.over.runs = [{ name: "Tests", status: "completed", conclusion: "failure" }];
  await failed.reviews.checksDone("workflow_run", completed());
  assert.equal(failed.merges().length, 0);
  assert.match(failed.replies[0].text, /GitHub Actions runs on sha-1 failed: Tests \(failure\)/);
  // One run failed while another goes on: refused at once, without waiting.
  const early = setup(t, {
    runs: [GOING, { name: "Lint", status: "completed", conclusion: "failure" }],
  });
  await early.settle();
  assert.match(early.replies[0].text, /failed: Lint \(failure\)/);
  // A push after the review: the reviewed commit's run completing refuses it.
  const pushed = setup(t, { runs: [GOING] });
  await pushed.settle();
  pushed.over.pr = { head: { sha: "sha-2", repo: { full_name: "org/repo" } } };
  await pushed.reviews.checksDone("workflow_run", completed());
  assert.equal(pushed.merges().length, 0);
  assert.match(pushed.replies[0].text, /pushed after the review \(reviewed sha-1, now sha-2\)/);
  // Closed or merged by the maintainer meanwhile: nothing to say.
  const closed = setup(t, { runs: [GOING] });
  await closed.settle();
  closed.over.pr = { state: "closed", merged: true };
  await closed.reviews.checksDone("workflow_run", completed());
  assert.deepEqual([closed.replies, closed.merges()], [[], []]);
  await closed.reviews.tick();
  assert.equal(closed.replies.length, 0);
});

test("auto-merge: checks still going after review.merge_wait are refused once", async (t) => {
  const s = setup(t, { yaml: `${MERGE}  merge_wait: 30\n`, runs: [GOING] });
  await s.settle();
  // Before the deadline, a tick finds it still waiting.
  s.advance(29 * 60_000);
  await s.reviews.tick();
  assert.equal(s.replies.length, 0);
  s.advance(2 * 60_000);
  await s.reviews.tick();
  assert.equal(s.replies.length, 1);
  assert.match(
    s.replies[0].text,
    /its checks didn't finish in time \(30 minutes, `review\.merge_wait`\): 1 GitHub Actions run on sha-1 hasn't finished/,
  );
  await s.reviews.tick();
  await s.reviews.checksDone("workflow_run", completed());
  assert.equal(s.replies.length, 1);
  assert.equal(s.merges().length, 0);
});

test("auto-merge: a tick merges what a lost workflow_run delivery would have", async (t) => {
  const s = setup(t, { pr: { mergeable_state: "blocked" }, runs: [GOING] });
  await s.settle();
  s.over.pr = { mergeable_state: "clean" };
  s.over.runs = [PASSED];
  await s.reviews.tick();
  assert.equal(s.merges().length, 1);
});

test("auto-merge: GitHub failing while it waits keeps it waiting, until review.merge_wait", async (t) => {
  const path = join(tempDir(t), "reviews.json");
  const s = setup(t, { path, runs: [GOING] });
  await s.settle();
  s.over.pullStatus = 502;
  await s.reviews.checksDone("workflow_run", completed());
  await s.reviews.tick();
  assert.deepEqual([s.replies, s.merges()], [[], []]);
  // Still saved as waiting: a listener stopped during a decision asks again after it.
  const next = setup(t, { path });
  await next.reviews.tick();
  assert.equal(next.merges().length, 1);
  // Past the deadline, the failure is the refusal, once.
  const late = setup(t, { runs: [GOING] });
  await late.settle();
  late.over.pullStatus = 502;
  late.advance(61 * 60_000);
  await late.reviews.tick();
  assert.equal(late.replies.length, 1);
  assert.match(late.replies[0].text, /GitHub couldn't be read/);
  await late.reviews.tick();
  assert.equal(late.replies.length, 1);
});
