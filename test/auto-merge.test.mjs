// Auto-merge (`review.merge`, reviews.mjs): what blocks it, its gates, the review after a fix
// run, and that each pull request gets one decision; the policies of the reviews and fix runs
// that lead to it (`deny_review`, `deny_fix`).
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parseRepoConfig } from "../listener/repo-config.mjs";
import { createPolicies } from "../listener/policies.mjs";
import {
  createReviews,
  dryRunText,
  githubSamples,
  mergeBlockers,
  mergeRefusal,
  parseReview,
  reviewEvent,
  reviewLoop,
  trustedFile,
} from "../listener/reviews.mjs";
import { allowOnly, builtInPolicies } from "../policy-service/engine.mjs";
import { opaBinary } from "../policy-service/opa.mjs";
import {
  hasOpa,
  localService,
  policyEngine,
  policyEngineOf,
  tempDir,
  testConfig,
  fileMap,
} from "./helpers.mjs";

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
  base: { ref: "main" },
  mergeable_state: "clean",
  changed_files: 1,
};

// A fake GitHub with a mergeable pull request; `over` changes what it answers: `pr` (or
// `pulls`, successive answers), `info` (the repo), `files`, `runs` (Actions), `issueLabels`,
// `merge` (the merge's status), `behind` (the commits `main` has that the head doesn't; a status
// when GitHub can't compare them, `compareStatus`), `pullStatus` (GET of the pull request failing), `filesStatus`
// (GET of its files failing), `filesFail` (the next reads of its files failing, a count).
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
    if (method === "GET" && p === "/repos/org/repo/pulls/5/files" && over.filesStatus) {
      return new Response("{}", { status: over.filesStatus });
    }
    if (method === "GET" && p === "/repos/org/repo/pulls/5/files" && over.filesFail > 0) {
      over.filesFail--;
      return new Response("{}", { status: 502 });
    }
    if (method === "GET" && p === "/repos/org/repo/pulls/5/files") {
      return Response.json(over.files ?? [{ filename: "listener/x.mjs" }]);
    }
    if (method === "GET" && p.startsWith("/repos/org/repo/actions/runs?head_sha=")) {
      if (over.runsStatus) return new Response("{}", { status: over.runsStatus });
      const runs = over.runs ?? [{ name: "CI", status: "completed", conclusion: "success" }];
      return Response.json({ workflow_runs: runs });
    }
    if (method === "GET" && /^\/repos\/org\/repo\/compare\/main\.\.\.[^/?]+\?per_page=1$/.test(p)) {
      if (over.compareStatus) return new Response("{}", { status: over.compareStatus });
      return Response.json({ status: "ahead", behind_by: over.behind ?? 0 });
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
  {
    yaml = MERGE,
    grant = true,
    granted = {},
    path,
    busy = () => false,
    policies,
    runOf,
    externalOf,
    ...over
  } = {},
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
    reviewed: fileMap(path ?? join(tempDir(t), "reviews.json")),
    config,
    repoSettings: async () => read,
    accept: async (item) => accepted.push(item),
    github: gh.github,
    busy,
    reply: async (repo, number, text) => replies.push({ number, text }),
    grantOf: () => ({ allowAutoMerge: grant, ...granted }),
    merged: (repo, pr) => merged.push(pr.number),
    policies,
    runOf,
    externalOf,
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

test("mergeBlockers: critical and high always, medium unless allowed, low never, blocking comments always", () => {
  const review = parseReview(`${HIGH}\n- **medium** b: x.\n- **low** c: y.`);
  const severities = (list) => list.map((f) => f.severity);
  assert.deepEqual(severities(mergeBlockers(review)), ["high", "medium"]);
  assert.deepEqual(severities(mergeBlockers(review, "medium")), ["high"]);
  assert.deepEqual(mergeBlockers(parseReview(MEDIUM), "medium"), []);
  assert.deepEqual(mergeBlockers(parseReview(CLEAN)), []);
  const comments = parseReview(
    `${MEDIUM.split("\n\n")[0]}\n\n## Comments\n\n- **blocking** why?\n- **note** fine.\n\nRating: 7/10\nVerdict: comment`,
  );
  assert.deepEqual(
    mergeBlockers(comments, "medium").map((b) => [b.blocking, b.text]),
    [[true, "why?"]],
  );
});

test("trustedFile: the config, .deckhand/, .github/, CODEOWNERS and the files it names", () => {
  const settings = parseRepoConfig(
    `instructions: docs/agents.md
dockerfile: build/Dockerfile
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
    // Any case: the git gateway reads workflow folders without it (#700).
    ".GitHub/Workflows/deploy.yml",
    "CODEOWNERS",
    "docs/CODEOWNERS",
    "docs/agents.md",
    "build/Dockerfile",
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
    /the repository is public.*grant it `auto_merge`, not `auto_merge_public`/,
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
    // Behind its base with GitHub still saying `clean` (no branch protection, #778).
    [
      { behind: 3 },
      /its branch is 3 commits behind `main`, which its checks didn't run with: update the branch\./,
    ],
    [{ behind: 1 }, /its branch is 1 commit behind `main`/],
    // At once, its checks still going: none finishing brings the base's commits in.
    [
      { behind: 2, runs: [{ name: "CI", status: "in_progress", conclusion: null }] },
      /its branch is 2 commits behind `main`/,
    ],
    [{ compareStatus: 404 }, /it can't be compared with `main`/],
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
    // A workflow `workflow_secrets` let through (#700): its secrets wait for a person's review.
    [
      { files: [{ filename: ".github/workflows/deploy.yml" }] },
      /`\.github\/workflows\/deploy\.yml` \(a workflow on the default branch runs with the repository's secrets: a person reviews it first\)/,
    ],
    [{ files: [{ filename: "x.md", previous_filename: "CODEOWNERS" }] }, /`CODEOWNERS`/],
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
  const at = { repo: "org/repo", number: 5, base: "trunk", auto: true };
  // With review.fix, every automatic review stops the loop at the threshold: medium findings
  // alone start no fix run, and the first review decides the merge. Not "/mode review"'s.
  const s = setup(t, { yaml });
  assert.equal(await s.reviews.tolerance(at), "medium");
  assert.equal(await s.reviews.tolerance({ ...at, auto: false }), "low");
  const message = MEDIUM.replace("Verdict: comment", "Verdict: request-changes");
  const first = s.posted(message, {}, "medium");
  assert.deepEqual([first.event, first.review.verdict], ["COMMENT", "comment"]);
  assert.deepEqual(await s.reviews.settle(s.run, first), { sha: "sha-1", method: "squash" });
  assert.equal(s.accepted.length, 0);
  assert.match(s.replies[0].text, /medium findings allowed by `review.max_allowed_severity`/);
  // High still requests changes, for the fix run; the review after it tolerates medium too.
  const path = join(tempDir(t), "reviews.json");
  const pushed = { head: { sha: "sha-2", repo: { full_name: "org/repo" } } };
  const fixing = setup(t, { yaml, path, pr: pushed });
  const high = fixing.posted(`${HIGH}\n- **medium** b: x.`, {}, "medium");
  assert.equal(high.event, "REQUEST_CHANGES");
  assert.equal((await fixing.reviews.settle(fixing.run, high)).reason, "review-fix");
  await fixing.reviews.fixed({ repo: "org/repo", number: 5, base: "trunk", status: "ok" });
  assert.equal(await fixing.reviews.tolerance(at), "medium");
  const second = fixing.posted(message, pushed, "medium");
  assert.deepEqual(await fixing.reviews.settle(fixing.run, second), {
    sha: "sha-2",
    method: "squash",
  });
  // Without review.fix the first review decides; low + "request changes" still blocks.
  const plainYaml = "review:\n  on: ready\n  merge: true\n  max_allowed_severity: medium\n";
  const noFix = setup(t, { yaml: plainYaml });
  assert.equal(await noFix.reviews.tolerance(at), "medium");
  const posted = noFix.posted(`${HIGH}\n- **medium** b: x.`, {}, "medium");
  assert.equal(posted.event, "REQUEST_CHANGES");
  assert.equal(await noFix.reviews.settle(noFix.run, posted), null);
  assert.match(noFix.replies[0].text, /the review still has high findings/);
  const low = setup(t, { yaml: plainYaml });
  assert.equal(await low.reviews.settle(low.run, low.posted(LOW_CHANGES, {}, "medium")), null);
  assert.match(low.replies[0].text, /the review requests changes/);
  const plain = setup(t, { yaml: plainYaml });
  assert.ok(await plain.reviews.settle(plain.run, plain.posted(MEDIUM, {}, "medium")));
  // Without review.merge, the fix loop's threshold alone.
  const fixOnly = setup(t, { yaml: `${FIX_ONLY}  max_allowed_severity: medium\n` });
  assert.equal(await fixOnly.reviews.tolerance(at), "medium");
  assert.equal(
    await fixOnly.reviews.settle(fixOnly.run, fixOnly.posted(MEDIUM, {}, "medium")),
    null,
  );
  assert.equal(fixOnly.accepted.length + fixOnly.replies.length, 0);
});

test("auto-merge: a blocking comment blocks with medium allowed; follow-ups and notes don't", async (t) => {
  const yaml = "review:\n  on: ready\n  merge: true\n  max_allowed_severity: medium\n";
  const comments = (kind) =>
    `${MEDIUM.split("\n\n")[0]}\n\n## Follow-ups\n\n- **Elsewhere**: later.\n\n## Comments\n\n- **${kind}** \`a.mjs:2\`: why this?\n\nRating: 7/10\nVerdict: comment`;
  const blocked = setup(t, { yaml });
  const posted = blocked.posted(comments("blocking"), {}, "medium");
  assert.equal(posted.event, "REQUEST_CHANGES");
  assert.equal(await blocked.reviews.settle(blocked.run, posted), null);
  assert.equal(blocked.merges().length, 0);
  assert.match(blocked.replies[0].text, /the review still has 1 blocking comment\./);
  const noted = setup(t, { yaml });
  const note = noted.posted(comments("note"), {}, "medium");
  assert.equal(note.event, "COMMENT");
  assert.deepEqual(await noted.reviews.settle(noted.run, note), { sha: "sha-1", method: "squash" });
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
  assert.deepEqual([input.fixed, input.fixes], [false, 0]);
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
  const { gates, input, layers, ...decision } = s.decided[0];
  assert.equal(s.decided.length, 1);
  assert.deepEqual(decision, {
    repo: "org/repo",
    pr: 5,
    decision: "merge",
    rule: "deny_merge",
    denied: true,
    messages: ["a human merges this one"],
  });
  // What each layer said: Deckhand's allow.rego allows (no opa: it allows whatever the input),
  // the repo's rule denies; its allow isn't asked, a merge is no mode of its own.
  assert.deepEqual(layers, [
    {
      layer: "operator",
      allow: true,
      denies: [],
      error: null,
      allowFiles: ["allow.rego"],
      denyFiles: [],
    },
    {
      layer: "repo",
      allow: null,
      denies: ["a human merges this one"],
      error: null,
      allowFiles: [],
      denyFiles: [],
    },
  ]);
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
    { name: "Up to date with main", passed: true },
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

test("/mode policy: every decision on the pull request now, nothing reviewed, fixed or merged", async (t) => {
  const policy = policyEngine(t, {
    files: { "size.rego": 'package deckhand\ndeny_merge contains "x" if true\n' },
    // The operator's, evaluated on its own, beside the repo's.
    operator: { "own.rego": "package deckhand\n" },
    messages: (input, rule, names) => {
      if (rule === "deny_merge" && names.includes("size.rego"))
        return ["a `human` merges this one"];
      if (rule === "deny_github" && input.mode === "brainstorm" && names.includes("own.rego")) {
        return ["not on pull requests"];
      }
      return [];
    },
  });
  const s = setup(t, {
    policies: policy.engine,
    pr: { additions: 12 },
    yaml: `${MERGE}  request: [alice]\n`,
    // The run that opened it: a repository mode's.
    runOf: (key, pr) => (key === "org/repo#12" && pr.number === 5 ? { taskMode: "plan" } : null),
  });
  const { text, denials } = await s.reviews.dryRun({
    repo: "org/repo",
    base: "main",
    number: 5,
    by: "alice",
  });
  // The brainstorm sample's denial is no decision: not counted.
  assert.equal(denials, 1);
  assert.match(
    text,
    /^\*\*Policy dry run\*\* on #5 at sha-1: nothing was reviewed, fixed or merged\./,
  );
  assert.match(
    text,
    /Policies: `allow\.rego` \(Deckhand's default\), `own\.rego` \(operator\), `size\.rego` \(repo\)\./,
  );
  // Each decision, then what each layer said: the repo's allow isn't asked on a built-in mode's.
  assert.match(
    text,
    /- `merge`: \*\*refused\*\*: `a 'human' merges this one`\n {2}- operator: `allow_merge` allows \(`allow\.rego`\); `deny_merge` denies nothing \(no file defines it\)\n {2}- repository: `allow_merge` not asked \(not one of its modes\); `deny_merge` denies \(1\) \(`size\.rego`\)\n/,
  );
  assert.match(text, /- `review`: allowed\n {2}- operator: `allow_review` allows/);
  assert.match(text, /- `fix`: allowed\n/);
  // The run that opened it is the repo's mode plan: the repo's allow is asked.
  assert.match(
    text,
    /- `request_review`: allowed\n {2}- operator: [^\n]*\n {2}- repository: `allow_request_review` allows/,
  );
  // github on sample writes: a comment on the pull request by its work run, and by a
  // brainstorm.
  assert.match(text, /- `github` \(sample: a work run's comment on its pull request\): allowed\n/);
  assert.match(
    text,
    /- `github` \(sample: a brainstorm's comment on it\): \*\*refused\*\*: `not on pull requests`\n {2}- operator: `allow_github` allows \(no file defines it\); `deny_github` denies \(1\)/,
  );
  assert.match(text, /The sample lines .* are not decisions on this pull request/);
  // run on sample comments: a trigger comment on it, and /mode brainstorm there.
  assert.match(
    text,
    /- `run` \(sample: a trigger comment on it starting a work run\): allowed\n {2}- operator: `allow_run` allows/,
  );
  assert.match(text, /- `run` \(sample: `\/mode brainstorm` on it\): allowed\n/);
  // link_branch on the branch its work run would have had linked.
  assert.match(text, /- `link_branch` \(sample: a work run's branch linked to #12\): allowed\n/);
  // push on its branch, by the work run of the issue it closes.
  assert.match(text, /- `push` \(sample: a work run's push to its branch\): allowed\n/);
  assert.match(text, /<details><summary>The input/);
  const [json, samples] = [...text.matchAll(/```json\n([\s\S]*?)\n```/g)].map((m) =>
    JSON.parse(m[1]),
  );
  // The samples' inputs, in a block of their own.
  assert.match(text, /<details><summary>The samples' inputs/);
  assert.deepEqual(
    samples.map((x) => [x.sample, x.input.version, x.input.mode, x.input.target?.kind]),
    [
      ["a trigger comment on it starting a work run", 1, "work", "pr"],
      ["`/mode brainstorm` on it", 1, "brainstorm", "pr"],
      ["a work run's branch linked to #12", 1, "work", undefined],
      ["a work run's comment on its pull request", 1, "work", "own_pr"],
      ["a brainstorm's comment on it", 1, "brainstorm", "pr"],
      ["a work run's read of CI's checks", 1, "work", undefined],
      ["a work run's push to its branch", 1, "work", undefined],
    ],
  );
  // The issue the pull request closes, and who asked.
  assert.deepEqual([samples[0].input.issue, samples[0].input.sender], [12, "alice"]);
  // With its time, as the real decision has it ("no runs on Fridays").
  assert.match(samples[0].input.time, /^\d{4}-\d\d-\d\dT/);
  // Built as the real decision's input (run-policy.mjs runInput()): its traits, the target.
  assert.deepEqual(
    [samples[1].input.fresh, samples[1].input.continues, samples[1].input.trigger],
    [false, false, "comment"],
  );
  assert.deepEqual(samples[1].input.target.kind, "pr");
  assert.equal(samples[2].input.issue, 12);
  assert.equal(json.version, 1);
  assert.equal(json.decision, "merge");
  assert.equal(json.pr.additions, 12);
  assert.equal(json.review, null);
  assert.deepEqual(json.checks, [{ name: "CI", status: "completed", conclusion: "success" }]);
  // Each decision got its own input, evaluated by each layer; review and fix without the
  // merge's fields.
  const repo = policy.evals.filter((e, i) => policy.layers[i].includes("size.rego"));
  const operator = policy.evals.filter((e, i) => policy.layers[i].includes("own.rego"));
  assert.deepEqual(repo, operator);
  assert.deepEqual(
    operator.map((e) => [e.rule, e.decision, "checks" in e]),
    [
      ["deny_run", "run", false],
      ["deny_run", "run", false],
      ["deny_merge", "merge", true],
      ["deny_review", "review", false],
      ["deny_fix", "fix", false],
      ["deny_link_branch", undefined, false],
      ["deny_request_review", "request_review", false],
      ["deny_github", undefined, false],
      ["deny_github", undefined, false],
      ["deny_github", undefined, false],
      ["deny_push", undefined, false],
    ],
  );
  // The reviewers as when it turns ready, by the run that opened it, as the listener would ask.
  const request = operator[6];
  assert.deepEqual(
    [request.reviewers, request.when, request.mode, request.custom_mode, "fixes" in request],
    [["alice"], "ready", "plan", true, false],
  );
  assert.deepEqual(
    operator.slice(7).map((e) => [e.mode, e.action, e.target?.kind, e.target?.number]),
    [
      ["work", "comment", "own_pr", 5],
      ["brainstorm", "comment", "pr", 5],
      ["work", "read_checks", undefined, undefined],
      ["work", "push", undefined, undefined],
    ],
  );
  // The push: the branch its work run would push, the default branch never pushed.
  assert.deepEqual(
    [operator[10].issue, operator[10].created, operator[10].deleted],
    [12, false, false],
  );
  // A rule written for writes would refuse the read too: the dry run shows it.
  assert.match(text, /- `github` \(sample: a work run's read of CI's checks\): allowed\n/);
  assert.equal(s.accepted.length + s.merges().length + s.replies.length + s.decided.length, 0);
  // Nobody to request, or not Deckhand's ready pull request: its "allowed" says the listener
  // wouldn't ask.
  const none = setup(t, { policies: policy.engine });
  const nobody = await none.reviews.dryRun({ repo: "org/repo", base: "main", number: 5 });
  assert.match(
    nobody.text,
    /- `request_review`: allowed, but nobody would be requested: `review\.request` names no allowed user/,
  );
  const draft = setup(t, {
    policies: policy.engine,
    pr: { draft: true },
    yaml: `${MERGE}  request: [alice]\n`,
  });
  const drafted = await draft.reviews.dryRun({ repo: "org/repo", base: "main", number: 5 });
  assert.match(
    drafted.text,
    /but nobody would be requested: not Deckhand's own ready pull request/,
  );
  // Without policies: said, no GitHub call for the pull request.
  const empty = setup(t, {
    policies: createPolicies({
      config: {},
      github: async () => new Response("{}", { status: 404 }),
      service: localService(policyEngineOf(t, { builtIn: {} })),
    }),
  });
  const said = await empty.reviews.dryRun({ repo: "org/repo", base: "main", number: 5 });
  assert.match(said.text, /No policy applies here/);
  assert.equal(said.denials, 0);
  assert.equal(empty.calls.length, 0);
});

test("githubSamples: a work run's comment, a brainstorm's, and one in the repo's own mode", () => {
  const pr = { number: 5, labels: [{ name: "ui" }], user: { login: "bob" } };
  const traits = (samples) =>
    samples.map((x) => [x.input.mode, x.input.custom_mode, x.input.reason]);
  assert.deepEqual(traits(githubSamples("Org/Repo", pr)), [
    ["work", false, null],
    ["brainstorm", false, null],
    ["work", false, null],
  ]);
  // The repo's first mode: what its policies allow it is theirs to say.
  const own = githubSamples("Org/Repo", pr, { plan: {}, ask: {} });
  assert.deepEqual(traits(own)[2], ["plan", true, null]);
  assert.equal(own.length, 4);
  assert.equal(own[2].what, "a comment on it in the repository's mode plan");
  assert.ok(own.every((x) => !("light" in x.input)));
  // The work run reading CI's checks: the run's fields, no target or change.
  assert.deepEqual(own[3], {
    what: "a work run's read of CI's checks",
    input: {
      repo: "org/repo",
      mode: "work",
      custom_mode: false,
      reason: null,
      issue: 5,
      action: "read_checks",
      actions: ["read_checks"],
    },
  });
  assert.deepEqual(own[2].input.target, {
    kind: "own_pr",
    number: 5,
    labels: ["ui"],
    author: "bob",
  });
});

test("dryRunText: the files replaced, the check's errors, a long input cut", () => {
  const text = dryRunText({
    number: 5,
    sha: "abcdef123",
    files: [
      { name: "github.rego", source: "deckhand", replaces: null, rules: ["deny_github"] },
      { name: "gh-x.rego", source: "operator", replaces: "deckhand", rules: [] },
      { name: "a.rego", source: "operator", replaces: null, rules: [] },
      { name: "b.rego", source: "repo", replaces: null, rules: ["deny_merge"] },
    ],
    errors: ["policy error: b.rego:2: unexpected eof"],
    results: [
      {
        decision: "merge",
        messages: ["policy error: b.rego:2: unexpected eof"],
        layers: [
          {
            layer: "operator",
            allow: true,
            denies: [],
            error: null,
            allowFiles: ["allow.rego"],
            denyFiles: [],
          },
          {
            layer: "repo",
            allow: null,
            denies: [],
            error: "policy error: b.rego:2: unexpected eof",
            allowFiles: [],
            denyFiles: ["b.rego"],
          },
        ],
      },
    ],
    input: { pr: { title: "```".repeat(2) + "x".repeat(60_000) } },
  });
  assert.match(
    text,
    /Policies: `github\.rego` \(Deckhand's default\), `gh-x\.rego` \(operator, replaces Deckhand's\), `a\.rego` \(operator\), `b\.rego` \(repo\)\./,
  );
  assert.match(
    text,
    /- `merge`: \*\*refused\*\*: `policy error: b\.rego:2: unexpected eof`\n {2}- operator: `allow_merge` allows \(`allow\.rego`\); `deny_merge` denies nothing \(no file defines it\)\n {2}- repository: `policy error: b\.rego:2: unexpected eof`\n/,
  );
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

test("deny_review: another bot's pull request is left to the policies, its gate says so", async (t) => {
  const policy = policyEngine(t, { ref: "trunk", files: { "a.rego": "package deckhand" } });
  const s = setup(t, { yaml: REVIEW_ON, policies: policy.engine });
  const user = { login: "dependabot[bot]", type: "Bot" };
  assert.ok(await s.reviews.consider("pull_request", ready({ user, body: "" })));
  assert.deepEqual(
    s.decided[0].gates.map((g) => g.name),
    ["Ready for review", "Opened by a bot (left to deny_review)", "Not reviewed at this commit"],
  );
  const [input] = policy.evals;
  assert.deepEqual(
    [input.pr.author, input.pr.author_type, input.pr.deckhand],
    ["dependabot[bot]", "Bot", false],
  );
  // No person to check again when it runs.
  assert.equal(s.accepted[0].author, undefined);
});

test("deny_review: a policy error is asked again at the next ticks, a rule's refusal isn't", async (t) => {
  const policy = policyEngine(t, {
    ref: "trunk",
    files: { "a.rego": "package deckhand" },
    messages: (input, rule) =>
      rule === "deny_review" && input.pr.labels.includes("wip") ? ["work in progress"] : [],
  });
  const reads = (s) => s.calls.filter((c) => c.path.startsWith("/repos/org/repo/pulls/5/files"));
  // GitHub can't give the pull request's files: the input can't be built, which refuses it.
  const skipped = [];
  const s = setup(t, { yaml: REVIEW_ON, policies: policy.engine, filesStatus: 502 });
  await s.reviews.consider("pull_request", ready(), (why) => (skipped.push(why), null));
  assert.equal(s.accepted.length, 0);
  assert.match(
    skipped[0],
    /`policy error: its input can't be built .*`; asked again in 5 minutes$/,
  );
  assert.equal(s.decided[0].denied, true);
  // Asked once more at once (asking()), then at each tick, three times, then left to a
  // maintainer: two reads each time.
  assert.equal(reads(s).length, 2);
  for (let i = 0; i < 4; i++) await s.reviews.tick();
  assert.equal(reads(s).length, 8);
  assert.equal(s.accepted.length, 0);
  assert.equal(s.reviews.entry("org/repo", 5).policyRetry, undefined);
  // GitHub answers again by the next tick: reviewed, once.
  const back = setup(t, { yaml: REVIEW_ON, policies: policy.engine, filesStatus: 502 });
  await back.reviews.consider("pull_request", ready());
  delete back.over.filesStatus;
  await back.reviews.tick();
  await back.reviews.tick();
  assert.equal(back.accepted.length, 1);
  assert.equal(back.reviews.entry("org/repo", 5).head, "sha-1");
  // A draft again by then: dropped, nothing reviewed.
  const draft = setup(t, { yaml: REVIEW_ON, policies: policy.engine, filesStatus: 502 });
  await draft.reviews.consider("pull_request", ready());
  draft.over.pr = { draft: true };
  delete draft.over.filesStatus;
  await draft.reviews.tick();
  assert.deepEqual([draft.accepted.length, reads(draft).length], [0, 2]);
  // GitHub can't give the pull request at a tick: that counts as a try, the next one asks.
  const unread = setup(t, { yaml: REVIEW_ON, policies: policy.engine, filesStatus: 502 });
  await unread.reviews.consider("pull_request", ready());
  unread.over.pullStatus = 502;
  await unread.reviews.tick();
  assert.deepEqual(unread.reviews.entry("org/repo", 5).policyRetry, {
    sha: "sha-1",
    base: "trunk",
    tries: 2,
  });
  delete unread.over.pullStatus;
  delete unread.over.filesStatus;
  await unread.reviews.tick();
  assert.equal(unread.accepted.length, 1);
  // Failing on every tick: given up after as many tries as a failing policy gets.
  const gone = setup(t, { yaml: REVIEW_ON, policies: policy.engine, filesStatus: 502 });
  await gone.reviews.consider("pull_request", ready());
  gone.over.pullStatus = 502;
  for (let i = 0; i < 4; i++) await gone.reviews.tick();
  assert.equal(gone.reviews.entry("org/repo", 5).policyRetry, undefined);
  // A rule's refusal holds at this head: no tick asks again.
  const wip = setup(t, { yaml: REVIEW_ON, policies: policy.engine });
  await wip.reviews.consider("pull_request", ready({ labels: [{ name: "wip" }] }));
  await wip.reviews.tick();
  assert.deepEqual([wip.accepted.length, reads(wip).length], [0, 1]);
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

test("deny_review: after a fix run, a policy error is asked once more before it stops the loop", async (t) => {
  const policy = policyEngine(t, { ref: "trunk", files: { "a.rego": "package deckhand" } });
  const pushed = { head: { sha: "sha-2", repo: { full_name: "org/repo" } } };
  const run = { repo: "org/repo", number: 5, base: "trunk", status: "ok" };
  // GitHub fails to give the files once: asked again, the fix's push is reviewed.
  const once = setup(t, { pr: pushed, policies: policy.engine });
  assert.equal((await once.reviews.settle(once.run, once.posted(HIGH))).reason, "review-fix");
  once.over.filesFail = 1;
  assert.equal((await once.reviews.fixed(run)).reason, "review");
  assert.equal(once.replies.length, 0);
  assert.deepEqual(
    once.decided.filter((d) => d.rule === "deny_review").map((d) => d.denied),
    [false],
  );
  // Twice: the loop stops, said, the merge left to the maintainer.
  const twice = setup(t, { pr: pushed, policies: policy.engine });
  await twice.reviews.settle(twice.run, twice.posted(HIGH));
  twice.over.filesFail = 2;
  assert.equal(await twice.reviews.fixed(run), null);
  assert.match(
    twice.replies[0].text,
    /^\*\*Not merged automatically\*\*.*`deny_review`\): `policy error: its input can't be built/,
  );
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
  assert.deepEqual([input.fixed, input.fixes, input.round, input.rounds], [false, 0, 1, 1]);
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
    failure: {
      code: 0,
      stdout: '{"result":[{"expressions":[{"value":{"repo":{"deny":[[1]]}}}]}]}',
    },
  });
  const s = setup(t, { yaml: FIX_ONLY, policies: broken.engine });
  assert.equal(await s.reviews.fix(s.run, s.posted(HIGH)), null);
  assert.equal(s.accepted.length, 0);
  assert.match(s.replies[0].text, /`policy error: 'deny_fix' must be a set of strings`/);
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

// The fix loop (`review.fix: <n>`): review, fix, review… until a review is within
// `review.max_allowed_severity` or n fix runs have run.
const at = (sha) => ({ head: { sha, repo: { full_name: "org/repo" } } });
const done = { repo: "org/repo", number: 5, base: "trunk", status: "ok" };

// One round of `s`: the fix run `review` starts pushes `sha`, and its review is queued.
async function round(s, message, sha) {
  const fix = await s.reviews.settle(s.run, s.posted(message, s.over.pr));
  if (!fix) return null;
  s.over.pr = at(sha);
  const review = await s.reviews.fixed(done);
  assert.equal(review.reason, "review");
  return fix;
}

test("fix loop: without review.merge, fix and review again until the rounds run out", async (t) => {
  const s = setup(t, { yaml: "review:\n  on: ready\n  fix: 3\n", pr: at("sha-1") });
  const first = await round(s, HIGH, "sha-2");
  assert.deepEqual([first.round, first.rounds], [1, 3]);
  assert.match(first.text, /This is fix run 1 of 3\./);
  const second = await round(s, HIGH, "sha-3");
  assert.deepEqual([second.round, second.rounds], [2, 3]);
  assert.match(second.text, /fix run 2 of 3: the review of what the previous fix run pushed/);
  assert.ok(await round(s, HIGH, "sha-4"));
  // The review after the third: no fourth fix run, a comment instead, once.
  assert.equal(
    await s.reviews.settle(s.run, s.posted(`${HIGH}\n- **medium** b: x.`, at("sha-4"))),
    null,
  );
  assert.equal(s.accepted.filter((i) => i.reason === "review-fix").length, 3);
  assert.equal(s.accepted.filter((i) => i.reason === "review").length, 3);
  assert.deepEqual(
    s.replies.map((r) => r.text),
    [
      "**No more fix runs** (`review.fix`): the review after 3 fix runs still has high, medium findings. They wait for a maintainer.",
    ],
  );
  assert.equal(await s.reviews.settle(s.run, s.posted(HIGH, at("sha-4"))), null);
  assert.equal(s.replies.length + s.merges().length, 1);
});

test("fix loop: a clean review stops it; in merge mode it merges", async (t) => {
  const quiet = setup(t, { yaml: "review:\n  on: ready\n  fix: 3\n", pr: at("sha-1") });
  await round(quiet, HIGH, "sha-2");
  assert.equal(await quiet.reviews.settle(quiet.run, quiet.posted(CLEAN, at("sha-2"))), null);
  assert.equal(quiet.accepted.length + quiet.replies.length, 2);
  assert.equal(quiet.replies.length, 0);
  const s = setup(t, { yaml: `${MERGE.replace("fix: true", "fix: 3")}`, pr: at("sha-1") });
  await round(s, HIGH, "sha-2");
  await round(s, HIGH, "sha-3");
  const merged = await s.reviews.settle(s.run, s.posted(CLEAN, at("sha-3")));
  assert.deepEqual(merged, { sha: "sha-3", method: "squash" });
  assert.match(s.replies[0].text, /after 2 fix runs, each followed by a review/);
});

test("fix loop: in merge mode, rounds run out with findings above the threshold, nothing merges", async (t) => {
  const s = setup(t, { yaml: MERGE.replace("fix: true", "fix: 2"), pr: at("sha-1") });
  await round(s, HIGH, "sha-2");
  await round(s, HIGH, "sha-3");
  assert.equal(await s.reviews.settle(s.run, s.posted(HIGH, at("sha-3"))), null);
  assert.equal(s.merges().length, 0);
  assert.equal(s.accepted.filter((i) => i.reason === "review-fix").length, 2);
  assert.match(
    s.replies[0].text,
    /^\*\*Not merged automatically\*\*.*the review after 2 fix runs still has high findings/,
  );
});

test("fix loop: with medium allowed, a medium-only review in the loop starts no fix and merges", async (t) => {
  const yaml = `${MERGE.replace("fix: true", "fix: 3")}  max_allowed_severity: medium\n`;
  const s = setup(t, { yaml, pr: at("sha-1") });
  await round(s, HIGH, "sha-2");
  const second = s.posted(MEDIUM, at("sha-2"), "medium");
  assert.equal(second.event, "COMMENT");
  assert.deepEqual(await s.reviews.settle(s.run, second), { sha: "sha-2", method: "squash" });
  assert.equal(s.accepted.filter((i) => i.reason === "review-fix").length, 1);
});

test("fix loop: a busy task, needs-input or a failed fix stops it", async (t) => {
  const yaml = "review:\n  on: ready\n  fix: 3\n";
  let busy = false;
  const s = setup(t, { yaml, pr: at("sha-1"), busy: () => busy });
  await round(s, HIGH, "sha-2");
  busy = true;
  assert.equal(await s.reviews.settle(s.run, s.posted(HIGH, at("sha-2"))), null);
  const waits = setup(t, { yaml, pr: at("sha-1") });
  await round(waits, HIGH, "sha-2");
  const labelled = waits.posted(HIGH, { ...at("sha-2"), labels: [{ name: "needs-input" }] });
  assert.equal(await waits.reviews.settle(waits.run, labelled), null);
  const failed = setup(t, { yaml, pr: at("sha-1") });
  await failed.reviews.settle(failed.run, failed.posted(HIGH));
  failed.over.pr = at("sha-2");
  assert.equal(await failed.reviews.fixed({ ...done, status: "error" }), null);
  // None of them a further run, nor a "rounds ran out" comment.
  for (const x of [s, waits, failed]) {
    assert.equal(x.accepted.filter((i) => i.reason === "review-fix").length, 1);
    assert.equal(x.replies.length, 0);
  }
  assert.equal(failed.accepted.length, 1);
});

test("fix loop: the count survives a restart; a fix run's end, redelivered, reviews once", async (t) => {
  const path = join(tempDir(t), "reviews.json");
  const yaml = "review:\n  on: ready\n  fix: 2\n";
  const s = setup(t, { yaml, path, pr: at("sha-1") });
  await round(s, HIGH, "sha-2");
  assert.equal(await s.reviews.fixed(done), null);
  const again = setup(t, { yaml, path, pr: at("sha-2") });
  assert.equal(await again.reviews.fixed(done), null);
  assert.equal((await again.reviews.settle(again.run, again.posted(HIGH, at("sha-2")))).round, 2);
  // After round 2, restarted: no third one.
  const third = setup(t, { yaml, path, pr: at("sha-3") });
  assert.equal((await third.reviews.fixed(done)).reason, "review");
  assert.equal(await third.reviews.fixed(done), null);
  const last = setup(t, { yaml, path, pr: at("sha-3") });
  assert.equal(await last.reviews.settle(last.run, last.posted(HIGH, at("sha-3"))), null);
  assert.equal(last.accepted.length, 0);
  assert.match(last.replies[0].text, /after 2 fix runs still has high findings/);
});

test("fix loop: entries from before the rounds are one round done", async (t) => {
  const old = (entry) => {
    const path = join(tempDir(t), "reviews.json");
    writeFileSync(path, JSON.stringify({ "org/repo#pr-5": { head: "sha-1", at: 1, ...entry } }));
    return path;
  };
  // fixedAt: one fix run; with `fix: 3`, the next is round 2.
  const more = setup(t, {
    yaml: "review:\n  on: ready\n  fix: 3\n",
    path: old({ fixedAt: 2 }),
    pr: at("sha-2"),
  });
  assert.equal((await more.reviews.settle(more.run, more.posted(HIGH, at("sha-2")))).round, 2);
  // With `fix: true`, none.
  const one = setup(t, { yaml: FIX_ONLY, path: old({ fixedAt: 2 }), pr: at("sha-2") });
  assert.equal(await one.reviews.settle(one.run, one.posted(HIGH, at("sha-2"))), null);
  assert.equal(one.accepted.length, 0);
  // rereviewAt too: that round's review was queued, a fix run's end reviews nothing more.
  const over = setup(t, { path: old({ fixedAt: 2, rereviewAt: 3 }), pr: at("sha-2") });
  assert.equal(await over.reviews.fixed(done), null);
  assert.equal(over.accepted.length, 0);
});

// Deckhand's policy/machines.rego, with the real opa, replaced by the operator's `operator`
// (name → text).
function machinePolicies(t, operator = new Map()) {
  return createPolicies({
    config: {},
    github: async () => new Response("{}", { status: 404 }),
    service: localService(
      policyEngineOf(t, {
        opa: opaBinary(),
        readBuiltIn: () =>
          new Map([...allowOnly(), ["machines.rego", builtInPolicies().get("machines.rego")]]),
        readOperator: () => operator,
      }),
    ),
  });
}

test(
  "the real opa: machines.rego refuses to auto-merge a machine's pull request, unless the operator's file drops it",
  { skip: !hasOpa() && "no opa on the PATH" },
  async (t) => {
    // Pushed from alice's machine (#598): every built-in gate passes, Deckhand's policy refuses.
    const machine = setup(t, {
      policies: machinePolicies(t),
      externalOf: (repo, number) => (number === 5 ? "alice" : null),
    });
    assert.equal(await machine.settle(), null);
    assert.equal(machine.merges().length, 0);
    assert.match(
      machine.replies[0].text,
      /the policies refuse it \(`deny_merge`\): `its commits were pushed from alice's machine, not through Deckhand: a person merges it`/,
    );
    // A sandbox run's: merged.
    const sandbox = setup(t, { policies: machinePolicies(t), externalOf: () => null });
    assert.ok(await sandbox.settle());
    assert.equal(sandbox.merges().length, 1);
    // The operator's machines.rego with its package alone: merged as any of Deckhand's own.
    const broad = setup(t, {
      policies: machinePolicies(t, new Map([["machines.rego", "package deckhand\n"]])),
      externalOf: () => "alice",
    });
    assert.ok(await broad.settle());
    assert.equal(broad.merges().length, 1);
  },
);

test("docs/repo-config.md's machines.rego rule is policy/machines.rego's", () => {
  const docs = readFileSync(new URL("../docs/repo-config.md", import.meta.url), "utf8");
  const from = docs.indexOf("#### machines.rego");
  const [, excerpt] = /```rego\n([\s\S]*?)```/.exec(docs.slice(from));
  const rule = excerpt.replace(/^# policy\/machines\.rego.*\n/, "");
  assert.ok(rule.startsWith("deny_merge contains"));
  assert.ok(builtInPolicies().get("machines.rego").includes(rule));
});

test("fix loop: deny_merge sees the fix runs counted", async (t) => {
  const policy = policyEngine(t, { ref: "trunk", files: { "x.rego": "package deckhand" } });
  const s = setup(t, {
    yaml: MERGE.replace("fix: true", "fix: 3"),
    pr: at("sha-1"),
    info: { default_branch: "trunk" },
    policies: policy.engine,
  });
  await round(s, HIGH, "sha-2");
  const fixInput = policy.evals.find((e) => e.rule === "deny_fix");
  assert.deepEqual([fixInput.fixes, fixInput.round, fixInput.rounds], [0, 1, 3]);
  const reviewInput = policy.evals.find((e) => e.rule === "deny_review");
  assert.deepEqual([reviewInput.fixed, reviewInput.fixes], [true, 1]);
  await round(s, HIGH, "sha-3");
  assert.ok(await s.reviews.settle(s.run, s.posted(CLEAN, at("sha-3"))));
  const merge = policy.evals.find((e) => e.rule === "deny_merge");
  assert.deepEqual([merge.fixed, merge.fixes], [true, 2]);
});

test("fix loop: without review.merge, a fix that pushed nothing or a deny_review stops it", async (t) => {
  const yaml = "review:\n  on: ready\n  fix: 3\n";
  // Pushed nothing: the head the fix run started from.
  const idle = setup(t, { yaml, pr: at("sha-1") });
  await round(idle, HIGH, "sha-2");
  assert.equal((await idle.reviews.settle(idle.run, idle.posted(HIGH, at("sha-2")))).round, 2);
  assert.equal(await idle.reviews.fixed(done), null);
  // deny_review of the review after fix 1.
  const policy = policyEngine(t, {
    ref: "trunk",
    files: { "x.rego": "package deckhand" },
    messages: (input, rule) => (rule === "deny_review" ? ["no second look"] : []),
  });
  const denied = setup(t, { yaml, pr: at("sha-1"), policies: policy.engine });
  await denied.reviews.settle(denied.run, denied.posted(HIGH));
  denied.over.pr = at("sha-2");
  assert.equal(await denied.reviews.fixed(done), null);
  for (const [s, fixes, reviews] of [
    [idle, 2, 1],
    [denied, 1, 0],
  ]) {
    assert.equal(s.accepted.filter((i) => i.reason === "review-fix").length, fixes);
    assert.equal(s.accepted.filter((i) => i.reason === "review").length, reviews);
    assert.equal(s.replies.length + s.merges().length, 0);
  }
});

test("fix loop: deny_fix at round 2 stops it, said once, the round left", async (t) => {
  const policy = policyEngine(t, {
    ref: "trunk",
    files: { "x.rego": "package deckhand" },
    messages: (input, rule) =>
      rule === "deny_fix" && input.round === 2 ? ["a human takes round 2"] : [],
  });
  const s = setup(t, {
    yaml: "review:\n  on: ready\n  fix: 3\n",
    pr: at("sha-1"),
    policies: policy.engine,
  });
  await round(s, HIGH, "sha-2");
  assert.equal(await s.reviews.settle(s.run, s.posted(HIGH, at("sha-2"))), null);
  assert.equal(s.accepted.filter((i) => i.reason === "review-fix").length, 1);
  assert.deepEqual(
    s.replies.map((r) => r.text),
    [
      "**No fix run** (`review.fix`): the policies refuse it (`deny_fix`): `a human takes round 2`. The review's findings wait for a maintainer.",
    ],
  );
  const fix = policy.evals.filter((e) => e.rule === "deny_fix").at(-1);
  assert.deepEqual([fix.fixes, fix.round, fix.rounds], [1, 2, 3]);
});

test("fix loop: fix: true without review.merge reviews nothing after its fix run", async (t) => {
  const s = setup(t, { yaml: FIX_ONLY, pr: at("sha-1") });
  await s.reviews.settle(s.run, s.posted(HIGH));
  s.over.pr = at("sha-2");
  assert.equal(await s.reviews.fixed(done), null);
  assert.equal(s.accepted.length, 1);
  assert.equal(s.replies.length, 0);
});

test("a maintainer's review in merge mode: its findings counted with the loop's tolerance", async (t) => {
  const yaml = "review:\n  on: ready\n  merge: true\n  max_allowed_severity: medium\n";
  const s = setup(t, { yaml, pr: at("sha-1") });
  // The automatic review tolerates its medium finding: the loop ends clean.
  await s.reviews.settle(s.run, s.posted(MEDIUM, at("sha-1"), "medium"));
  const loop = () => reviewLoop(s.reviews.entry("org/repo", 5));
  assert.equal(loop().loop, "clean");
  // `/mode review` or the dashboard's Review finds the same medium one: still clean, with no
  // "findings left" for a finding the repo tolerates.
  const manual = { ...s.run, auto: false };
  await s.reviews.settle(manual, s.posted(MEDIUM, at("sha-1")));
  assert.deepEqual([loop().loop, loop().history.at(-1).blocking], ["clean", 0]);
  // A high one blocks, whatever the tolerance.
  await s.reviews.settle(manual, s.posted(HIGH, at("sha-1")));
  assert.equal(loop().history.at(-1).blocking, 1);
  // Without the operator's grant, merge mode is off: the review's own tolerance counts.
  const off = setup(t, { yaml, grant: false, pr: at("sha-1") });
  await off.reviews.settle(off.run, off.posted(HIGH, at("sha-1")));
  await off.reviews.settle({ ...off.run, auto: false }, off.posted(MEDIUM, at("sha-1")));
  assert.equal(reviewLoop(off.reviews.entry("org/repo", 5)).history.at(-1).blocking, 1);
});

// Issue #896: a conflict run (conflicts.mjs) during the loop, or after its last decision.
const rebaseEnd = (from = "sha-1", status = "ok") => ({ ...done, status, from });

// `s`'s pull request turned ready at sha-1: the loop's review queued (consider()).
async function readyAt(s, sha = "sha-1") {
  await s.reviews.consider("pull_request", {
    action: "ready_for_review",
    installation: { id: 1 },
    repository: { full_name: "org/repo", default_branch: "trunk" },
    pull_request: { ...PR, head: { sha, repo: { full_name: "org/repo" } } },
  });
}

test("rebase: a merge refused for the conflict, the rebased head reviewed, then merged (#896)", async (t) => {
  const path = join(tempDir(t), "reviews.json");
  const s = setup(t, { path, pr: { mergeable_state: "dirty" } });
  await readyAt(s);
  assert.equal(await s.settle(), null);
  assert.match(s.replies[0].text, /`mergeable_state: dirty`/);
  // The conflict watcher's run pushed sha-2, now clean: its review, no fix round used.
  s.over.pr = { ...at("sha-2"), mergeable_state: "clean" };
  const review = await s.reviews.rebased(rebaseEnd());
  assert.deepEqual([review.reason, review.id, review.replyTo], ["review", "12", 5]);
  assert.equal(s.reviews.fixes("org/repo", 5), 0);
  // Its end, redelivered or after a restart: one review only.
  assert.equal(await s.reviews.rebased(rebaseEnd()), null);
  const again = setup(t, { path, pr: { ...at("sha-2"), mergeable_state: "clean" } });
  assert.equal(await again.reviews.rebased(rebaseEnd()), null);
  assert.equal(s.accepted.length + again.accepted.length, 2);
  // Its review, clean: the merge decided again, at the rebased head.
  const merged = await again.reviews.settle(again.run, again.posted(CLEAN, at("sha-2")));
  assert.deepEqual(merged, { sha: "sha-2", method: "squash" });
});

test("rebase: one that failed, stopped to ask or pushed nothing leaves the pull request alone", async (t) => {
  for (const [status, sha, from] of [
    ["error", "sha-2", "sha-1"],
    ["needs-input", "sha-2", "sha-1"],
    ["cancelled", "sha-2", "sha-1"],
    ["ok", "sha-1", "sha-1"],
    // Pushed nothing, on a head pushed after the review.
    ["ok", "sha-3", "sha-3"],
  ]) {
    const s = setup(t, { pr: { mergeable_state: "dirty" } });
    await readyAt(s);
    await s.settle();
    s.over.pr = { ...at(sha), mergeable_state: "clean" };
    assert.equal(await s.reviews.rebased(rebaseEnd(from, status)), null, status);
    assert.deepEqual([s.accepted.length, s.replies.length], [1, 1], status);
    // The merge's decision stands.
    assert.equal(await s.settle(CLEAN, {}), null);
    assert.equal(s.merges().length, 0);
  }
  // Pushed, but its issue waits for the maintainer's input.
  const asks = setup(t, { pr: { mergeable_state: "dirty" } });
  await readyAt(asks);
  await asks.settle();
  asks.over.pr = { ...at("sha-2"), labels: [{ name: "needs-input" }] };
  assert.equal(await asks.reviews.rebased(rebaseEnd()), null);
  assert.equal(asks.accepted.length, 1);
});

test("rebase: only on a pull request the loop reviewed, with review.on: ready still", async (t) => {
  // Never reviewed automatically: no entry, or a maintainer's review alone.
  const none = setup(t, { pr: at("sha-2") });
  assert.equal(await none.reviews.rebased(rebaseEnd()), null);
  await none.reviews.settle({ ...none.run, auto: false }, none.posted(CLEAN));
  assert.equal(await none.reviews.rebased(rebaseEnd()), null);
  assert.deepEqual(none.accepted, []);
  // Turned off since the loop's review.
  const path = join(tempDir(t), "reviews.json");
  await readyAt(setup(t, { path }));
  const off = setup(t, { path, yaml: "review:\n  on: never\n", pr: at("sha-2") });
  assert.equal(await off.reviews.rebased(rebaseEnd()), null);
  assert.deepEqual(off.accepted, []);
});

test("rebase: a fix run skipped for the conflict run starts after the rebased head's review", async (t) => {
  let busy = false;
  const s = setup(t, { busy: () => busy, pr: at("sha-1") });
  await readyAt(s);
  // The conflict watcher queued its run while the review's end was decided.
  busy = true;
  assert.equal(await s.reviews.settle(s.run, s.posted(HIGH)), null);
  assert.match(s.replies[0].text, /no fix run started/);
  busy = false;
  s.over.pr = at("sha-2");
  assert.equal((await s.reviews.rebased(rebaseEnd())).reason, "review");
  // Still blocking at the rebased head: the loop's first fix run, round 1 of 1.
  const fix = await s.reviews.settle(s.run, s.posted(HIGH, at("sha-2")));
  assert.deepEqual([fix.reason, fix.round, fix.rounds], ["review-fix", 1, 1]);
  // Its push reviewed, then merged: the rebase used up no round.
  s.over.pr = at("sha-3");
  assert.equal((await s.reviews.fixed(done)).reason, "review");
  const merged = await s.reviews.settle(s.run, s.posted(CLEAN, at("sha-3")));
  assert.deepEqual(merged, { sha: "sha-3", method: "squash" });
});

test("rebase: a merge waiting for checks, refused for the conflict run going, or still waiting", async (t) => {
  let busy = false;
  const s = setup(t, { busy: () => busy, runs: [GOING] });
  await readyAt(s);
  assert.equal(await s.settle(), null);
  // The conflict run starts while the merge waits; the checks end while it runs.
  busy = true;
  s.over.runs = [{ name: "CI", status: "completed", conclusion: "success" }];
  await s.reviews.checksDone("workflow_run", completed());
  assert.match(s.replies[0].text, /#12 has a run going or queued/);
  busy = false;
  s.over.pr = at("sha-2");
  assert.equal((await s.reviews.rebased(rebaseEnd())).reason, "review");
  assert.deepEqual(await s.reviews.settle(s.run, s.posted(CLEAN, at("sha-2"))), {
    sha: "sha-2",
    method: "squash",
  });
  // Its end before any decision: the old head's wait goes, the rebased head is reviewed.
  const w = setup(t, { runs: [GOING] });
  await readyAt(w);
  await w.settle();
  w.over.pr = at("sha-2");
  assert.equal((await w.reviews.rebased(rebaseEnd())).reason, "review");
  w.over.runs = [{ name: "CI", status: "completed", conclusion: "success" }];
  await w.reviews.checksDone("workflow_run", completed());
  assert.equal(w.merges().length, 0);
  assert.deepEqual(await w.reviews.settle(w.run, w.posted(CLEAN, at("sha-2"))), {
    sha: "sha-2",
    method: "squash",
  });
});

test("rebase: any other merge decision stands, the rebased head reviewed all the same", async (t) => {
  const s = setup(t, { yaml: MERGE, pr: at("sha-1") });
  await readyAt(s);
  await round(s, HIGH, "sha-2");
  // Its one round used: the review after it still blocks, and the merge is refused for it.
  assert.equal(await s.reviews.settle(s.run, s.posted(HIGH, at("sha-2"))), null);
  assert.match(s.replies.at(-1).text, /still has/);
  s.over.pr = at("sha-3");
  assert.equal((await s.reviews.rebased(rebaseEnd("sha-2"))).reason, "review");
  assert.equal(await s.reviews.settle(s.run, s.posted(CLEAN, at("sha-3"))), null);
  assert.equal(s.merges().length, 0);
});

test("rebase: waiting for CI, the CI step follows the rebased head itself", async (t) => {
  const yaml = "review:\n  on: ready\n  fix: true\n  ci: wait\n";
  const s = setup(t, { yaml, runs: [GOING], pr: at("sha-1") });
  await readyAt(s);
  assert.deepEqual(s.accepted, []);
  assert.equal(s.reviews.looping("org/repo", 5), true);
  // The wait moves to the rebased head, whose runs decide: no review of its own besides.
  s.over.pr = at("sha-2");
  assert.equal(await s.reviews.rebased(rebaseEnd()), null);
  assert.equal(s.reviews.entry("org/repo", 5).ciWaiting.sha, "sha-2");
  s.over.runs = [{ name: "CI", status: "completed", conclusion: "success" }];
  await s.reviews.checksDone("workflow_run", completed("sha-2"));
  assert.deepEqual(
    s.accepted.map((i) => i.reason),
    ["review"],
  );
  assert.equal(s.reviews.looping("org/repo", 5), false);
});

test("looping: while what follows a run is decided, not while the merge waits for checks", async (t) => {
  const s = setup(t, { runs: [GOING] });
  await readyAt(s);
  assert.equal(s.reviews.looping("org/repo", 5), false);
  // From the review's end on, synchronously (runs.mjs cleanUp()).
  const settling = s.settle();
  assert.equal(s.reviews.looping("org/repo", 5), true);
  await settling;
  assert.equal(s.reviews.looping("org/repo", 5), false);
  assert.ok(s.reviews.entry("org/repo", 5).waiting);
});

test("review loop: rebasing while a conflict run goes on a pull request the loop reviewed", () => {
  const entry = { head: "sha-1", rounds: [{ round: 0, head: "sha-1", blocking: 0 }] };
  assert.equal(reviewLoop(entry, "conflict").loop, "rebasing");
  assert.equal(reviewLoop({ ...entry, mergeAt: 1 }, "conflict").loop, "rebasing");
  // A maintainer's review alone, or none: not the loop's.
  const manual = { rounds: [{ round: 0, head: "sha-1", blocking: 0, manual: true }] };
  assert.equal(reviewLoop(manual, "conflict").loop, "clean");
  assert.equal(reviewLoop(null, "conflict"), null);
});
