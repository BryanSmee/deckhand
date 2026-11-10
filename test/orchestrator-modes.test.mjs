// The orchestrator end to end, reviews and modes (orchestrator-harness.mjs has the harness):
// review.on, review.merge, /mode audit, /mode research.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import {
  allowedHosts,
  comment,
  egressAnswers,
  exists,
  followUp,
  listen,
  onlyLog,
  options,
  replies,
  storedMap,
  until,
  writeGrant,
  writeGrants,
} from "./orchestrator-harness.mjs";

describe("listener", options, () => {
  // The repo's allow rule for its mode audit: without it, the mode doesn't run.
  const AUDIT_RUNS = 'package deckhand\n\nallow_run if input.mode == "audit"\n';

  const MODES = `setup: npm ci
model: opus
modes:
  audit:
    instructions: .deckhand/audit.md
    model: sonnet
    effort: high
`;

  // What the audit mode gets, as the repo's own modes need its allow rules (capabilities.mjs):
  // what a brainstorm gets, no branch nor setup; and that it runs.
  const AUDIT_POLICY = `${AUDIT_RUNS}
allow_capabilities contains "pull"
allow_capabilities contains "image:repo"
allow_capabilities contains "read:issues"
allow_capabilities contains "read:pulls"
`;

  test("review.on: a ready pull request gets one review run, posted as a GitHub review", async (t) => {
    // Deckhand's own pull request, which closes #12, turns ready.
    const ready = {
      action: "ready_for_review",
      installation: { id: 7 },
      repository: { full_name: "org/repo", default_branch: "trunk" },
      pull_request: {
        number: 13,
        body: "Closes #12",
        state: "open",
        draft: false,
        user: { login: "deckhand-x[bot]", type: "Bot" },
        head: { sha: "head-1", ref: "issue-12-fix", repo: { full_name: "org/repo" } },
      },
      sender: { login: "deckhand-x[bot]", type: "Bot" },
    };
    const { dir, github, listener, send } = await listen(
      t,
      (dir) => ({
        ".deckhand.yaml":
          "brainstorm_model: sonnet\nwait_for_answers: false\nreview:\n  on: ready\n  effort: high\n",
        // A commit pushed while the review runs (its sandbox started: run-args): head-2.
        get "pull:13"() {
          const sha = existsSync(join(dir, "run-args")) ? "head-2" : "head-1";
          return JSON.stringify({
            ...ready.pull_request,
            head: { ...ready.pull_request.head, sha },
            base: { ref: "trunk" },
          });
        },
      }),
      (dir) => {
        writeFileSync(
          join(dir, "result"),
          "Fine overall.\n\n## Findings\n\n- **high** `a.mjs:3`: no test. Fix: add one.\n\nRating: 6/10\nVerdict: request-changes\n",
        );
        return {};
      },
    );
    await send(ready, "pull_request");
    const review = await github.waitFor(
      (r) => r.method === "POST" && r.path === "/repos/org/repo/pulls/13/reviews",
    );
    const posted = JSON.parse(review.body);
    assert.equal(posted.event, "REQUEST_CHANGES");
    // Posted on the commit the run started from, not the one pushed meanwhile (#535).
    assert.equal(posted.commit_id, "head-1");
    // The model's 6/10, capped by its high finding.
    assert.match(
      posted.body,
      /^\*\*Verdict: request changes\*\* · Rating: 5\/10\n\nFine overall\./,
    );
    assert.match(posted.body, /### 🟠 High \(1\)\n\n- `a\.mjs:3`: no test\. Fix: add one\./);
    const runEnv = readFileSync(join(dir, "run-env"), "utf8");
    assert.match(runEnv, /^TASK_MODE=review$/m);
    assert.match(runEnv, /^SANDBOX_LIGHT=1$/m);
    assert.match(runEnv, /^SANDBOX_MODEL=sonnet$/m);
    assert.match(runEnv, /^SANDBOX_EFFORT=high$/m);
    assert.match(runEnv, /^TASK_PROMPT=Review pull request #13 of org\/repo\./m);
    // Pinned to the commit it is posted on, whatever the head is when the agent reads it.
    assert.match(runEnv, /Review commit `head-1`/);
    assert.match(runEnv, /git diff origin\/trunk\.\.\.head-1/);
    // No auto-merge to decide: medium findings request changes, as the prompt says.
    assert.match(
      runEnv,
      /when there is a\s+blocking comment or a critical, high or medium finding/,
    );
    assert.doesNotMatch(runEnv, /This review tolerates/);
    // Its thread from the listener (review-post.mjs reviewThread(), unit-tested in reviews.test.mjs).
    const args = readFileSync(join(dir, "run-args"), "utf8");
    assert.match(args, /^TASK_DIGEST=http:\/\/[^/]+\/run\/digest$/m);
    for (const path of ["/issues/13/comments?", "/pulls/13/reviews?"]) {
      assert.ok(
        github.requests.some((r) => r.path.startsWith(`/repos/org/repo${path}`)),
        path,
      );
    }
    // Its token only reads: the listener posted the review.
    const mint = github.requests.find((r) => r.body.includes("repositories"));
    assert.equal(JSON.parse(mint.body).permissions.pull_requests, "read");
    // The issue's task, with no comment of its own on the pull request. It answers nothing:
    // the issue's needs-input label stays.
    await listener.until("org/repo#12: done (ok)");
    assert.equal(replies(github).length, 0);
    assert.ok(!github.requests.some((r) => r.method === "DELETE" && r.path.includes("/labels/")));
    // The same head again (a redelivery): no second review.
    await send(ready, "pull_request");
    await listener.until("was reviewed already");
    assert.equal(github.requests.filter((r) => r.path.endsWith("/pulls/13/reviews")).length, 1);
  });

  test("review.merge: a clean review of Deckhand's pull request merges it once its checks pass, with the listener's token", async (t) => {
    const pr = {
      number: 13,
      title: "Fix the thing",
      body: "Closes #12",
      state: "open",
      draft: false,
      labels: [],
      mergeable_state: "clean",
      changed_files: 0,
      html_url: "https://github.com/org/repo/pull/13",
      user: { login: "deckhand-x[bot]", type: "Bot" },
      head: { sha: "head-1", ref: "issue-12-fix", repo: { full_name: "org/repo" } },
      base: { ref: "trunk", repo: { full_name: "org/repo", default_branch: "trunk" } },
    };
    // Another task's pull request, clean when it opened: the merge makes it conflict, and no
    // delivery says so (#747).
    const other = {
      number: 20,
      body: "Closes #18",
      state: "open",
      draft: true,
      labels: [],
      mergeable: true,
      mergeable_state: "clean",
      head: { sha: "head-9", ref: "issue-18-other", repo: { full_name: "org/repo" } },
    };
    // CI still going when the review ends: the merge waits for it. No review.fix: this review
    // decides the merge, and may have medium findings.
    const files = {
      ".deckhand.yaml": "review:\n  on: ready\n  merge: true\n  max_allowed_severity: medium\n",
      "pull:13": JSON.stringify(pr),
      "pull:20": JSON.stringify({ ...other, mergeable: false, mergeable_state: "dirty" }),
      runs: JSON.stringify({
        workflow_runs: [{ name: "CI", status: "in_progress", conclusion: null }],
      }),
    };
    const { dir, github, listener, send } = await listen(t, files, (dir) => {
      // The fake repository says nothing of its visibility: public, so `public`.
      writeGrants(dir, ["auto_merge_public"]);
      writeFileSync(join(dir, "result"), "Fine.\n\nRating: 9/10\nVerdict: approve\n");
      return { CONFLICT_MERGE_DELAY_MS: "0" };
    });
    await listener.until(/WARN policy\/grants\.rego in the grants folder grants auto-merge/);
    await send(
      {
        action: "opened",
        installation: { id: 7 },
        repository: { full_name: "org/repo", default_branch: "trunk" },
        pull_request: other,
        sender: { login: "deckhand-x[bot]", type: "Bot" },
      },
      "pull_request",
    );
    await listener.until("org/repo#18: pull request #20 draft");
    assert.equal((await storedMap(dir, "pulls"))["org/repo#18"].conflict, false);
    await send(
      {
        action: "ready_for_review",
        installation: { id: 7 },
        repository: { full_name: "org/repo", default_branch: "trunk" },
        pull_request: pr,
        sender: { login: "deckhand-x[bot]", type: "Bot" },
      },
      "pull_request",
    );
    await listener.until("org/repo#pr-13: waiting for its checks, 1 GitHub Actions run on head-1");
    assert.ok(!github.requests.some((r) => r.method === "PUT"));
    // The prompt was told the tolerance worked out for the run (reviews' tolerance()).
    const runEnv = readFileSync(join(dir, "run-env"), "utf8");
    assert.match(runEnv, /when there is a\s+blocking comment or a critical or high finding/);
    assert.match(runEnv, /This review tolerates medium findings/);
    // The run completes: its delivery decides again.
    files.runs = JSON.stringify({
      workflow_runs: [{ name: "CI", status: "completed", conclusion: "success" }],
    });
    await send(
      {
        action: "completed",
        installation: { id: 7 },
        repository: { full_name: "org/repo", default_branch: "trunk" },
        workflow_run: { id: 99, head_sha: "head-1", status: "completed", conclusion: "success" },
        sender: { login: "github-actions[bot]", type: "Bot" },
      },
      "workflow_run",
    );
    const merge = await github.waitFor(
      (r) => r.method === "PUT" && r.path === "/repos/org/repo/pulls/13/merge",
    );
    assert.deepEqual(JSON.parse(merge.body), { sha: "head-1", merge_method: "squash" });
    // The listener's own token, never a sandbox's.
    assert.equal(merge.auth, "Bearer app-token");
    const said = await github.waitFor(
      (r) =>
        r.method === "POST" &&
        r.path === "/repos/org/repo/issues/13/comments" &&
        r.body.includes("Merged by Deckhand"),
    );
    assert.match(JSON.parse(said.body).body, /No human reviewed this pull request/);
    await listener.until("org/repo#pr-13: merged at head-1 (squash), auto-merge");
    // Merged into the default branch: the other one's conflict read again.
    await until(
      async () => (await storedMap(dir, "pulls"))["org/repo#18"].conflict === true,
      "the other pull request's conflict read again",
    );
  });

  test("/mode audit: the repo's mode without `push`, its instructions and model, the repo's grants", async (t) => {
    const { dir, github, listener, send } = await listen(
      t,
      {
        // Its runs write in French (#919): the line reaches the sandbox, for the entrypoint too.
        ".deckhand.yaml": `${MODES}language: French\n`,
        ".deckhand/audit.md": "Read the diff and list the risks.",
        // Its own mode runs once it allows it (allow_run, run-policy.mjs).
        "policy:modes.rego": AUDIT_POLICY,
      },
      (dir) => {
        writeGrant(dir, "hosts: [registry.npmjs.org, pypi.org]\n");
        return {};
      },
    );
    await send(comment("alice", "Deckhand\n/mode audit\nMind the tests."));
    const reply = await github.waitFor(
      (r) => r.method === "POST" && r.path === "/repos/org/repo/issues/12/comments",
    );
    assert.match(JSON.parse(reply.body).body, /audit mode: replies go on in it, `\/mode work`/);
    const runEnv = readFileSync(join(dir, "run-env"), "utf8");
    assert.match(runEnv, /^TASK_MODE=audit$/m);
    assert.match(runEnv, /^SANDBOX_LIGHT=1$/m);
    assert.match(runEnv, /^TASK_SESSION=$/m);
    assert.match(runEnv, /^SANDBOX_MODEL=sonnet$/m);
    assert.match(runEnv, /^SANDBOX_EFFORT=high$/m);
    // Like a brainstorm: no branch, no setup.
    assert.match(runEnv, /^TASK_ISSUE=$/m);
    assert.match(runEnv, /^SANDBOX_SETUP=$/m);
    assert.match(runEnv, /^TASK_PROMPT=You are in the "audit" mode of this repository/m);
    assert.match(runEnv, /You can't push, create a branch or open a pull request/);
    assert.match(runEnv, /Read the diff and list the risks\.\n\nWrite in French everything/);
    assert.match(runEnv, /^TASK_LANGUAGE=Write in French everything this run produces for people/m);
    assert.match(runEnv, /^TASK_MESSAGE=Mind the tests\.$/m);
    // Comments only: its token reads, what its capabilities give (no `read:actions` here).
    const mint = github.requests.find((r) => r.body.includes("repositories"));
    assert.deepEqual(JSON.parse(mint.body).permissions, {
      contents: "read",
      issues: "read",
      pull_requests: "read",
      metadata: "read",
    });
    // The same hosts as any run of the repo: the mandatory ones and its grant's.
    assert.deepEqual(allowedHosts(egressAnswers(dir)), [
      "api.anthropic.com",
      "github.com",
      "objects.githubusercontent.com",
      "raw.githubusercontent.com",
      "registry.npmjs.org",
      "pypi.org",
    ]);
    // A run without `push`, `setup` or `docker` isn't checked for a fork's code
    // (github-forks.mjs): GitHub's file hosts stay
    // plain hosts for it, GitHub's own relayed as for any run.
    const answers = egressAnswers(dir);
    assert.equal(answers["raw.githubusercontent.com"].relay, false);
    assert.equal(answers["github.com"].relay, true);
    // The run's record names the mode.
    const meta = JSON.parse((await onlyLog(dir)).split("\n")[0]);
    assert.equal(meta.taskMode, "audit");
    assert.equal(meta.kind, "issue");
    await listener.until("done (ok)");

    // A comment without a trigger line goes on in the mode; "/mode work" moves to work.
    await send(followUp(100, "And the docs?"));
    await until(() => replies(github).length === 2, "the second reply");
    assert.match(readFileSync(join(dir, "run-env"), "utf8"), /^TASK_MODE=audit$/m);
    await send(followUp(101, "/mode work\nFix them."));
    await until(() => replies(github).length === 3, "the third reply");
    const work = readFileSync(join(dir, "run-env"), "utf8");
    assert.match(work, /^TASK_MODE=work$/m);
    assert.match(work, /^SANDBOX_LIGHT=$/m);
    assert.match(work, /^SANDBOX_SETUP=npm ci$/m);
    assert.match(work, /^SANDBOX_MODEL=opus$/m);
    assert.match(work, /^TASK_ISSUE=12$/m);
    const mints = github.requests.filter((r) => r.body.includes("repositories"));
    // A work run's reads get a token that only reads, its checked writes one that writes issues
    // (github-gateway.mjs); it pushes through the git gateway and has the listener change its
    // pull requests: its token only reads both.
    assert.equal(JSON.parse(mints.at(-1).body).permissions.issues, "read");
    assert.equal(JSON.parse(mints.at(-1).body).permissions.pull_requests, "read");
    assert.equal(JSON.parse(mints.at(-1).body).permissions.contents, "read");
    assert.deepEqual(await storedMap(dir, "modes"), {});
  });

  test("/mode research: the grant, any public host, no clone or token, the thread in, the reply out", async (t) => {
    const issue = {
      title: "Which queue?",
      body: "Compare BullMQ and pg-boss.",
      user: { login: "alice" },
    };
    const thread = [{ user: { login: "alice" }, body: "Mind the licences." }];
    const { dir, github, listener, send } = await listen(
      t,
      {
        ".deckhand.yaml": "setup: npm ci\ninstructions: AGENTS.md\n",
        "issue:12": JSON.stringify(issue),
        "comments:12": JSON.stringify(thread),
      },
      (dir) => {
        writeGrant(dir, "hosts: [registry.npmjs.org]\n");
        // Held, so its digest is read before the run ends and teardown removes its folder.
        writeFileSync(join(dir, "hold"), "");
        return {};
      },
    );
    // Without the grant: a reply naming it, and no sandbox.
    await send(comment("alice", "Deckhand\n/mode research\nWhich one?"));
    const refused = await github.waitFor(
      (r) => r.method === "POST" && r.path === "/repos/org/repo/issues/12/comments",
    );
    assert.match(
      JSON.parse(refused.body).body,
      /^Research can't run here: .*don't grant `research`/,
    );
    assert.ok(!exists(join(dir, "run-args")));

    writeGrant(dir, "hosts: [registry.npmjs.org]\n");
    writeGrants(dir, ["research"]);
    await send(followUp(100, "Deckhand\n/mode research\nWhich one?"));
    const egress = join(dir, "egress");
    await until(() => exists(egress)?.trim().split("\n").length === 10, "the sandbox");
    const runEnv = readFileSync(join(dir, "run-env"), "utf8");
    assert.match(runEnv, /^TASK_MODE=research$/m);
    assert.match(runEnv, /^SANDBOX_NO_CLONE=1$/m);
    assert.match(runEnv, /^SANDBOX_SETUP=$/m);
    assert.match(runEnv, /^SANDBOX_INSTRUCTIONS=$/m);
    assert.match(runEnv, /^TASK_PROMPT=Research what GitHub issue #12 of org\/repo asks/m);
    assert.match(runEnv, /^TASK_MESSAGE=Which one\?$/m);
    const args = readFileSync(join(dir, "run-args"), "utf8");
    assert.match(args, /-research-workspace:\/workspace/);
    assert.doesNotMatch(args, /screenshots/);
    assert.match(args, /^TASK_DIGEST=http:\/\/[^/]+\/run\/digest$/m);
    // Nothing from GitHub: the gateway refused the sandbox's call, and no token was minted.
    assert.equal(readFileSync(join(dir, "broker-answer"), "utf8"), "");
    assert.equal(github.requests.filter((r) => r.body.includes("repositories")).length, 0);
    // The listener reads the repository's visibility once for its capabilities' input, and once
    // for its author's access (policies.mjs access(), kept ACCESS_MS); the sandbox's call adds
    // none.
    assert.equal(github.requests.filter((r) => r.path === "/repos/org/repo").length, 2);
    // No CA either: GitHub's hosts aren't relayed for it (below).
    assert.doesNotMatch(args, /DECKHAND_CA/);
    // Any public host, the operator's named ones no longer private.
    const answers = egressAnswers(dir);
    assert.deepEqual(answers["evil.example"], {
      allowed: true,
      private: false,
      cache: false,
      decrypt: false,
      relay: false,
      source: "sandbox",
    });
    assert.equal(answers["registry.npmjs.org"].private, false);
    assert.equal(answers["github.com"].private, true);
    // Public GitHub, anonymously, through a tunnel: it has no token for the gateway to add.
    assert.equal(answers["github.com"].allowed, true);
    assert.equal(answers["github.com"].relay, false);
    assert.equal(answers["github.com"].decrypt, false);
    // The thread, in the run's inbox folder.
    const [folder] = readdirSync(join(dir, "runs")).filter((f) =>
      exists(join(dir, "runs", f, "digest.md")),
    );
    const digest = readFileSync(join(dir, "runs", folder, "digest.md"), "utf8");
    assert.match(digest, /^# Which queue\?\n/);
    // The sandbox fetched it from the broker, with its run's secret.
    assert.equal(readFileSync(join(dir, "digest-fetched"), "utf8"), digest);
    assert.match(digest, /Compare BullMQ and pg-boss\./);
    assert.match(digest, /### @alice, .*\n\nMind the licences\./);
    writeFileSync(join(dir, "go"), "");
    await until(() => replies(github).length === 2, "the research reply");
    assert.match(JSON.parse(replies(github)[1].body).body, /🔎 research: replies go on in it/);
    const meta = JSON.parse((await onlyLog(dir)).split("\n")[0]);
    assert.equal(meta.kind, "research");
    await listener.until("done (ok)");
  });
});
