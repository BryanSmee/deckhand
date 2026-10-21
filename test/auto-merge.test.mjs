// Auto-merge (`review.merge`, reviews.mjs): what blocks it, its gates, the review after a fix
// run, and that each pull request gets one decision.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { parseRepoConfig } from "../listener/repo-config.mjs";
import {
  createReviews,
  mergeBlockers,
  mergeRefusal,
  parseReview,
  trustedFile,
} from "../listener/reviews.mjs";
import { tempDir, testConfig } from "./helpers.mjs";

const config = { ...testConfig(), bot: "deckhand-app[bot]", needsInputLabel: "needs-input" };

const CLEAN = "Reads well.\n\n- **low** `a.mjs:1`: a typo.\n\nRating: 9/10\nVerdict: approve";
const MEDIUM = "- **medium** `a.mjs:1`: a missing test.\n\nRating: 7/10\nVerdict: comment";
const HIGH = "- **high** `a.mjs:1`: a hole.\n\nRating: 4/10\nVerdict: request-changes";

const MERGE = "review:\n  on: ready\n  fix: true\n  merge: true\n";

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
};

// A fake GitHub with a mergeable pull request; `over` changes what it answers: `pr` (or
// `pulls`, successive answers), `info` (the repo), `files`, `runs` (Actions), `issueLabels`,
// `merge` (the merge's status).
function fakeGitHub(over = {}) {
  const calls = [];
  const pulls = over.pulls ? [...over.pulls] : null;
  const github = async (repo, method, path, body) => {
    calls.push({ method, path, body });
    const p = path.replace(/[?&]per_page=\d+&page=\d+$/, "");
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
function setup(t, { yaml = MERGE, grant = true, path, busy = () => false, ...over } = {}) {
  let time = 1_800_000_000_000;
  const accepted = [];
  const replies = [];
  const merged = [];
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
    grantOf: () => ({ allowAutoMerge: grant }),
    merged: (repo, pr) => merged.push(pr.number),
    sleep: async () => {},
    now: () => (time += 1000),
  });
  const run = { repo: "org/repo", number: 5, base: "trunk", settings: read.settings, auto: true };
  const posted = (message, pr = {}) => ({
    event: "COMMENT",
    review: parseReview(message),
    pr: { ...PR, ...pr },
  });
  const settle = (message = CLEAN, extra = {}) =>
    reviews.settle({ ...run, ...extra }, posted(message));
  const merges = () => gh.calls.filter((c) => c.method === "PUT");
  return { reviews, accepted, replies, merged, calls: gh.calls, settle, merges, posted, run, read };
}

test("mergeBlockers: critical and high always, medium unless the fix run had it", () => {
  const review = parseReview(`${HIGH}\n- **medium** b: x.\n- **low** c: y.`);
  const severities = (list) => list.map((f) => f.severity);
  assert.deepEqual(severities(mergeBlockers(review)), ["high", "medium"]);
  assert.deepEqual(severities(mergeBlockers(review, { fix: true })), ["high", "medium"]);
  assert.deepEqual(severities(mergeBlockers(review, { fix: true, fixed: true })), ["high"]);
  assert.deepEqual(mergeBlockers(parseReview(MEDIUM), { fix: true, fixed: true }), []);
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
    [{ pr: { mergeable_state: "unstable" } }, /`mergeable_state: unstable`/],
    [
      { runs: [{ name: "CI", status: "in_progress", conclusion: null }] },
      /1 GitHub Actions run on sha-1 hasn't finished/,
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
  // Its review: medium left as it is (review.fix had its turn), merged at the pushed head.
  const done = await again.reviews.settle(again.run, again.posted(MEDIUM, pushed));
  assert.deepEqual(done, { sha: "sha-2", method: "squash" });
  assert.match(again.replies[0].text, /after its fix run and a second review/);
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
