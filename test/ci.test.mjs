import assert from "node:assert/strict";
import { test } from "node:test";
import { ciState, ciSummary, commitCi, latestStatuses } from "../listener/ci.mjs";

const check = (status, conclusion = null, more = {}) => ({
  name: "build",
  status,
  conclusion,
  app: { slug: "circleci-checks" },
  ...more,
});
const status = (state, more = {}) => ({ context: "ci/jenkins", state, ...more });

test("ciState: check runs from other Apps decide like Actions runs", () => {
  for (const c of ["success", "skipped", "neutral"]) {
    assert.equal(ciState({ checks: [check("completed", c)] }).state, "passed", c);
  }
  for (const c of ["failure", "cancelled", "timed_out", "action_required", "stale"]) {
    assert.equal(ciState({ checks: [check("completed", c)] }).state, "failed", c);
  }
  for (const s of ["queued", "in_progress", "waiting", "requested", "pending"]) {
    assert.equal(ciState({ checks: [check(s)] }).state, "running", s);
  }
  assert.deepEqual(ciState({}), { state: "none", failed: [], going: [] });
  assert.deepEqual(ciState(), { state: "none", failed: [], going: [] });
});

test("ciState: commit statuses: pending runs, success passes, failure and error fail", () => {
  assert.equal(ciState({ statuses: [status("pending")] }).state, "running");
  assert.equal(ciState({ statuses: [status("success")] }).state, "passed");
  assert.equal(ciState({ statuses: [status("failure")] }).state, "failed");
  assert.equal(ciState({ statuses: [status("error")] }).state, "failed");
  // The newest status of a context decides: `…/statuses` lists its pending one too.
  const later = ciState({
    statuses: [
      status("success", { id: 2, updated_at: "2026-10-30T10:05:00Z" }),
      status("pending", { id: 1, updated_at: "2026-10-30T10:00:00Z" }),
    ],
  });
  assert.equal(later.state, "passed");
  const failed = ciState({
    statuses: [
      status("pending", { id: 1, updated_at: "2026-10-30T10:00:00Z" }),
      status("failure", { id: 2, updated_at: "2026-10-30T10:05:00Z" }),
      status("success", { context: "deploy", id: 3 }),
    ],
  });
  assert.deepEqual(
    [failed.state, failed.failed.map((s) => s.id), failed.going],
    ["failed", [2], []],
  );
  assert.equal(latestStatuses([status("pending"), status("success", { id: 1 })]).length, 1);
});

test("ciState: runs, checks and statuses together; a failure anywhere decides", () => {
  const run = { name: "CI", status: "completed", conclusion: "success" };
  const all = (runs, checks, statuses) => ciState({ runs, checks, statuses }).state;
  assert.equal(all([run], [check("completed", "success")], [status("success")]), "passed");
  assert.equal(all([run], [check("in_progress")], [status("success")]), "running");
  assert.equal(all([run], [check("in_progress")], [status("error")]), "failed");
  assert.equal(all([{ ...run, status: "queued" }], [], [status("success")]), "running");
  assert.equal(all([], [check("completed", "failure")], []), "failed");
  // Actions' own check runs are its jobs: with the runs given, the runs decide.
  const job = check("completed", "failure", { app: { slug: "github-actions" } });
  assert.equal(all([run], [job], []), "passed");
  assert.equal(ciState({ checks: [job] }).state, "failed");
  // Failed and going hold them as GitHub gave them.
  const mixed = ciState({ runs: [run], checks: [check("queued")], statuses: [status("error")] });
  assert.deepEqual(mixed.failed, [status("error")]);
  assert.deepEqual(mixed.going, [check("queued")]);
  // An array alone is Actions runs, as the merge gate and the CI step pass them.
  assert.equal(ciState([run]).state, "passed");
});

test("ciSummary: each run, check run and status that counts, failed ones first", () => {
  const runs = [
    { name: "CI", status: "completed", conclusion: "success", html_url: "https://x/runs/1" },
    { name: "Lint", status: "in_progress", conclusion: null, html_url: "https://x/runs/2" },
    // Replaced by a newer run of its workflow: not listed.
    { name: "Old", workflow_id: 5, run_number: 1, status: "completed", conclusion: "cancelled" },
    { name: "Old", workflow_id: 5, run_number: 2, status: "completed", conclusion: "success" },
  ];
  const checks = [
    check("completed", "failure", { html_url: "https://circleci/1" }),
    // GitHub Actions' own jobs: its runs above decide.
    check("completed", "failure", { name: "job", app: { slug: "github-actions" } }),
  ];
  const statuses = [status("pending", { target_url: "https://jenkins/1" })];
  assert.deepEqual(ciSummary({ runs, checks, statuses }), {
    state: "failed",
    runs: [
      { name: "build", state: "failed", url: "https://circleci/1" },
      { name: "Lint", state: "running", url: "https://x/runs/2" },
      { name: "ci/jenkins", state: "running", url: "https://jenkins/1" },
      { name: "CI", state: "passed", url: "https://x/runs/1" },
      { name: "Old", state: "passed", url: null },
    ],
  });
  assert.deepEqual(ciSummary({}), { state: "none", runs: [] });
  // Only a web page's link: a poster's `javascript:` or junk link is dropped.
  const links = ciSummary({
    statuses: [
      status("failure", { context: "a", target_url: "javascript:alert(1)" }),
      status("failure", { context: "b", target_url: "not a url" }),
      status("failure", { context: "c", target_url: "http://ci.example/1" }),
    ],
  });
  assert.deepEqual(
    links.runs.map((r) => r.url),
    [null, null, "http://ci.example/1"],
  );
  // Without the Actions runs (refused), its check runs stand for them.
  const alone = ciSummary({
    checks: [check("completed", "success", { app: { slug: "github-actions" } })],
  });
  assert.equal(alone.state, "passed");
});

test("commitCi: Actions runs, check runs and statuses read; a refused one left out", async () => {
  const paths = [];
  const reply = (status, body) => new Response(JSON.stringify(body), { status });
  const github = async (repo, method, path, body, expected) => {
    paths.push(path);
    assert.deepEqual([repo, method, expected], ["org/repo", "GET", [403, 404, 422]]);
    if (path.includes("/actions/runs")) {
      return reply(200, {
        workflow_runs: [
          { name: "CI", status: "completed", conclusion: "success", html_url: "https://r" },
        ],
      });
    }
    if (path.includes("/check-runs")) return reply(403, { message: "Resource not accessible" });
    return reply(200, {
      state: "failure",
      statuses: [status("failure", { target_url: "https://s" })],
    });
  };
  assert.deepEqual(await commitCi(github, "org/repo", "abc"), {
    sha: "abc",
    state: "failed",
    runs: [
      { name: "ci/jenkins", state: "failed", url: "https://s" },
      { name: "CI", state: "passed", url: "https://r" },
    ],
  });
  assert.deepEqual(paths.sort(), [
    "/repos/org/repo/actions/runs?head_sha=abc&per_page=100",
    "/repos/org/repo/commits/abc/check-runs?per_page=100",
    "/repos/org/repo/commits/abc/status?per_page=100",
  ]);
  // Nothing GitHub would give: null, the CI known stays.
  const refused = async () => reply(403, {});
  assert.equal(await commitCi(refused, "org/repo", "abc"), null);
});
