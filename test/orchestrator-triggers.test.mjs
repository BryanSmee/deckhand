// The orchestrator end to end, what starts a run (orchestrator-harness.mjs has the harness): CI,
// questions answered, inboxes, discussions, /after, conflicts, onboarding, auto-pickup, chats.
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import {
  comment,
  exists,
  followUp,
  listen,
  options,
  pastRun,
  prompts,
  replies,
  settled,
  storedMap,
  until,
} from "./orchestrator-harness.mjs";

describe("listener", options, () => {
  test("CI deliveries: the CI of the pull request at that commit read, not holding the deliveries after them, kept for the dashboard; nothing logged for check_suite and status", async (t) => {
    const statuses = JSON.stringify({
      statuses: [{ context: "ci/jenkins", state: "failure", target_url: "https://ci/1" }],
    });
    const { dir, github, send, listener } = await listen(t, { statuses });
    const ci = {
      installation: { id: 7 },
      repository: { full_name: "org/repo", default_branch: "trunk" },
      sender: { login: "ci-bot[bot]", type: "Bot" },
    };
    const head = { ref: "issue-30-fix", sha: "abc", repo: { full_name: "org/repo" } };
    const pull_request = {
      number: 31,
      html_url: "https://github.com/org/repo/pull/31",
      body: "Closes #30",
      state: "open",
      draft: false,
      head,
    };
    // Its CI read held back: the deliveries after it are handled meanwhile.
    const statusRead = (r) => r.path.startsWith("/repos/org/repo/commits/abc/status?");
    const release = github.hold(statusRead);
    t.after(release);
    const calls = github.requests.length;
    await send({ ...ci, action: "synchronize", pull_request }, "pull_request");
    await listener.until("org/repo#30: pull request #31 ready");
    await github.waitFor(statusRead);
    // Another commit's: nothing read. The same status twice: kept out of the memory of handled
    // deliveries, so not "already handled" either; while the first waits, edge passes on no
    // other for that commit.
    for (const [payload, event, id] of [
      [{ ...ci, state: "pending", context: "ci/jenkins", sha: "old" }, "status", "s-0"],
      [{ ...ci, state: "failure", context: "ci/jenkins", sha: "abc" }, "status", "s-1"],
      [{ ...ci, state: "failure", context: "ci/jenkins", sha: "abc" }, "status", "s-1"],
      [{ ...ci, action: "completed", check_suite: { head_sha: "abc" } }, "check_suite", "c-1"],
    ]) {
      assert.equal((await send(payload, event, id)).status, 202, event);
    }
    await send({ ...ci, action: "opened", issue: { number: 3, labels: [] } }, "issues");
    await listener.until("Delivery: issues opened");
    release();
    await listener.until("org/repo#30: CI of #31 failed");
    const kept = (await storedMap(dir, "pulls"))["org/repo#30"];
    assert.deepEqual(kept.ci, {
      sha: "abc",
      state: "failed",
      runs: [{ name: "ci/jenkins", state: "failed", url: "https://ci/1" }],
    });
    const read = github.requests.slice(calls).map((r) => r.path);
    assert.ok(
      read.some((p) => p.startsWith("/repos/org/repo/commits/abc/status?")),
      read.join("\n"),
    );
    assert.ok(!read.some((p) => p.includes("old")), read.join("\n"));
    // They came before the issue's delivery, and logged nothing.
    assert.doesNotMatch(
      listener.output(),
      /Delivery: (?:status|check_suite)|Passed on: (?:status|check_suite)|Delivery (?:s|c)-1 again/,
    );
    // An Actions run going on that head: its CI read again, Actions runs first among them.
    const since = github.requests.length;
    const workflow_run = { id: 9, name: "CI", head_sha: "abc", status: "in_progress" };
    await send({ ...ci, action: "in_progress", workflow_run }, "workflow_run", "w-1");
    await github.waitFor(
      (r) =>
        github.requests.indexOf(r) >= since &&
        r.path.startsWith("/repos/org/repo/actions/runs?head_sha=abc&"),
    );
  });

  // A comment on issue 12, labelled for the open questions in its body.
  function onAsking(id, body, labelled = true) {
    const payload = followUp(id, body);
    payload.issue = {
      number: 12,
      title: "An idea",
      state: "open",
      body: "Do it.\n\n## Open questions\n\n1. Which one?",
      labels: labelled ? [{ name: "needs-input" }] : [],
    };
    return payload;
  }

  const unlabelled = (github) =>
    github.requests.some(
      (r) => r.method === "DELETE" && r.path === "/repos/org/repo/issues/12/labels/needs-input",
    );

  test("wait_for_answers: a trigger line alone starts nothing on an issue with open questions; an answer does", async (t) => {
    const { dir, github, send, listener } = await listen(t, {});
    await send(onAsking(99, "Deckhand\n/effort high"));
    await until(() => replies(github).length === 1, "the reply");
    const text = JSON.parse(replies(github)[0].body).body;
    assert.match(text, /^#12 has open questions: nothing starts until they are answered\./);
    assert.match(text, /\(https:\/\/hooks\.example\.com\/#\/org\/repo\?task=org%2Frepo%2312\)/);
    const reaction = await github.waitFor(
      (r) => r.method === "POST" && r.path === "/repos/org/repo/issues/comments/99/reactions",
    );
    assert.deepEqual(JSON.parse(reaction.body), { content: "confused" });
    await listener.until("org/repo#12: alice's comment answers nothing, the label stays");
    // A brainstorm still runs, and leaves the label on.
    await send(onAsking(100, "Deckhand /mode brainstorm"));
    await until(() => replies(github).length === 2, "the brainstorm's reply");
    assert.match(lastRun(dir), /^brainstorm/);
    assert.equal(unlabelled(github), false);
    rmSync(join(dir, "run-args"));
    // Text is the answer: the label comes off and work starts.
    await send(onAsking(101, "Deckhand\n1. The first one"));
    await until(() => exists(join(dir, "run-args")), "the work run");
    assert.match(readFileSync(join(dir, "run-env"), "utf8"), /^TASK_MESSAGE=1\. The first one$/m);
    await until(() => unlabelled(github), "the label off");
    // Taken off twice: by the answer (questions.mjs), then by the work run's start (runs.mjs).
    await until(
      () =>
        github.requests.filter(
          (r) => r.method === "DELETE" && r.path === "/repos/org/repo/issues/12/labels/needs-input",
        ).length === 2,
      "the answer's and the work run's label off",
    );
    // The bare trigger never reached Claude.
    assert.doesNotMatch(readFileSync(join(dir, "run-env"), "utf8"), /^SANDBOX_EFFORT=high$/m);
  });

  const tickedBody = (box) =>
    `## Open questions\n\n1. Which one?\n   - [${box}] This one\n   - [ ] That one`;

  test("wait_for_answers: ticking every box of the issue takes the label off and starts what waited", async (t) => {
    const asking = (box) =>
      JSON.stringify({
        number: 12,
        state: "open",
        body: tickedBody(box),
        labels: [{ name: "needs-input" }],
      });
    const files = { "issue:77": JSON.stringify({ state: "open" }), "issue:12": asking(" ") };
    const { dir, github, send, listener } = await listen(t, files);
    await send(onAsking(99, "Deckhand /after #77"));
    await until(() => replies(github).length === 1, "the waiting reply");
    files["issue:77"] = JSON.stringify({ state: "closed", state_reason: "completed" });
    await send(
      {
        action: "closed",
        installation: { id: 7 },
        repository: { full_name: "org/repo", default_branch: "trunk" },
        issue: { number: 77, state: "closed", state_reason: "completed" },
        sender: { login: "bob" },
      },
      "issues",
    );
    await until(() => replies(github).length === 2, "the reply that it waits");
    // bob ticks the box in the issue: GitHub has it ticked, the label still on.
    files["issue:12"] = asking("x");
    const edited = {
      action: "edited",
      installation: { id: 7 },
      repository: { full_name: "org/repo", default_branch: "trunk" },
      issue: {
        number: 12,
        title: "An idea",
        state: "open",
        body: tickedBody("x"),
        user: { login: "alice", type: "User" },
        labels: [{ name: "needs-input" }],
      },
      changes: { body: { from: tickedBody(" ") } },
      sender: { login: "bob", type: "User" },
    };
    await send(edited, "issues");
    await until(() => unlabelled(github), "the label off");
    await listener.until("org/repo#12: answered, label removed");
    await until(() => exists(join(dir, "run-args")), "the run");
    await until(() => replies(github).length >= 3, "the starting reply");
    assert.match(
      JSON.parse(replies(github)[2].body).body,
      /^The open questions are answered: starting\./,
    );
    await listener.until("done (ok)");
  });

  test("ticking every box of a run's reply that stopped to ask continues its session", async (t) => {
    const asked = (box) =>
      `<!-- needs-input -->\n## Needs your input\n\n1. **Name**: which one?\n   - [${box}] A (recommended)\n   - [ ] B`;
    const issue = JSON.stringify({ number: 12, title: "An idea", state: "open" });
    const { dir, github, send, listener } = await listen(t, { "issue:12": issue }, (dir) => {
      writeFileSync(join(dir, "result"), asked(" "));
      return {};
    });
    await send(followUp(99, "Deckhand"));
    await until(() => replies(github).length === 1, "the run's questions");
    await listener.until("done (needs-input)");
    // Its comment's outcome comes once the run is over (runs.mjs cleanUp()): before, the task is
    // still busy, and ticking a box then can't continue it.
    await github.waitFor(
      (r) => r.path === "/repos/org/repo/issues/comments/99/reactions" && /confused/.test(r.body),
    );
    rmSync(join(dir, "result"));
    const posted = JSON.parse(replies(github)[0].body).body;
    // alice ticks A in the App's comment: GitHub's edit, by her, of the bot's comment.
    const edited = (sender) => ({
      action: "edited",
      installation: { id: 7 },
      repository: { full_name: "org/repo", default_branch: "trunk" },
      issue: { number: 12, title: "An idea", state: "open", labels: [{ name: "needs-input" }] },
      comment: {
        id: 500,
        body: posted.replace("[ ] A", "[x] A"),
        user: { login: "deckhand-x[bot]", type: "Bot" },
      },
      changes: { body: { from: posted } },
      sender: { login: sender, type: "User" },
    });
    await send(edited("mallory"));
    await send(edited("alice"));
    await listener.until("org/repo#12: Answers sent: #12 continues.");
    await listener.until("done (ok)");
    const answers = JSON.parse(replies(github)[1].body).body;
    assert.match(
      answers,
      /^Answers from @alice, ticked in the run's questions:\n\n1\. \*\*Name\*\*\n {3}- \[x\] A/,
    );
    assert.match(readFileSync(join(dir, "run-env"), "utf8"), /^TASK_MESSAGE=Answers from @alice/m);
    // mallory's edit started nothing: one answer, one run going on.
    await until(() => replies(github).length === 3, "the run's reply");
  });

  test("a comment on the ideas inbox is a light run with the idea prompt, answered there", async (t) => {
    const { dir, github, send } = await listen(t, {
      ".deckhand.yaml": "inbox: { ideas: 12 }\nsetup: npm ci\n",
    });
    const payload = comment("alice", "A dark mode");
    payload.comment.html_url = "https://github.com/org/repo/issues/12#issuecomment-99";
    assert.equal((await send(payload)).status, 202);
    const reply = await github.waitFor(
      (r) => r.method === "POST" && r.path === "/repos/org/repo/issues/12/comments",
    );
    assert.match(JSON.parse(reply.body).body, /^All done\./);
    const runEnv = readFileSync(join(dir, "run-env"), "utf8");
    assert.match(runEnv, /^TASK_MODE=idea$/m);
    assert.match(runEnv, /^SANDBOX_LIGHT=1$/m);
    // No branch, no setup, and the entry comes with the prompt of a new session.
    assert.match(runEnv, /^TASK_ISSUE=$/m);
    assert.match(runEnv, /^SANDBOX_SETUP=$/m);
    assert.match(runEnv, /^TASK_MESSAGE=$/m);
    assert.match(runEnv, /^TASK_PROMPT=New on the ideas inbox of org\/repo \(issue #12\)/m);
    assert.match(runEnv, /--label idea/);
    assert.match(
      runEnv,
      /From @alice \(https:\/\/github\.com\/org\/repo\/issues\/12#issuecomment-99\):\n\nA dark mode/,
    );
  });

  // An entry on the ideas inbox (issue 12): comment `id`, saying `body`.
  function entry(id, body) {
    const payload = followUp(id, body);
    payload.comment.html_url = `https://github.com/org/repo/issues/12#issuecomment-${id}`;
    return payload;
  }

  test(
    "inbox entries queued when the listener stops: a run each after it starts",
    { timeout: 120_000 },
    async (t) => {
      const ctx = await listen(
        t,
        { ".deckhand.yaml": "inbox: { ideas: 12 }\n" },
        // Their pause outlasts the restart, and its deadline holds after it.
        { BRAINSTORM_DEBOUNCE_MS: "8000" },
      );
      await ctx.send(entry(99, "A dark mode"));
      await ctx.send(entry(100, "Keyboard shortcuts"));
      await ctx.github.waitFor((r) => r.path === "/repos/org/repo/issues/comments/100/reactions");
      const { output } = await ctx.restart({ BRAINSTORM_DEBOUNCE_MS: "0" });
      assert.match(output, /1 task\(s\) with queued comments left to the next copy/);
      await settled(ctx.github, [99, 100]);
      await until(() => prompts(ctx.dir).length === 2, "two runs");
      // Each its own run, side by side: which sandbox starts first is the broker's answers' order.
      const all = prompts(ctx.dir);
      const first = all.find((p) => p.includes("A dark mode"));
      const second = all.find((p) => p.includes("Keyboard shortcuts"));
      assert.match(first, /A dark mode\n$/);
      assert.doesNotMatch(first, /Keyboard shortcuts/);
      assert.match(second, /Keyboard shortcuts\n$/);
      assert.doesNotMatch(second, /A dark mode/);
    },
  );

  function discussion(category, login = "alice") {
    return {
      action: "created",
      installation: { id: 7 },
      repository: { full_name: "org/repo", default_branch: "trunk" },
      discussion: {
        id: 5,
        node_id: "D_5",
        number: 8,
        title: "How do restarts work?",
        body: "Is the queue kept?",
        category: { name: category },
        user: { login, type: "User" },
      },
      sender: { login },
    };
  }

  test("a discussion in the repo's category is answered in it, with a discussions token", async (t) => {
    const { dir, github, listener, send } = await listen(t, {
      ".deckhand.yaml": "inbox:\n  discussions: Ask Claude\n",
      // Its author and labels, for the policies' allow_run (run-policy.mjs).
      "graphql:discussion(number: $number) { author": JSON.stringify({
        data: { repository: { discussion: { author: { login: "alice" }, labels: { nodes: [] } } } },
      }),
    });
    await send(discussion("General"), "discussion");
    await listener.until(`category "General" doesn't call Deckhand`);
    assert.equal((await send(discussion("Ask Claude"), "discussion")).status, 202);
    const graphql = (text) => (r) => r.path === "/graphql" && r.body.includes(text);
    const posted = await github.waitFor(graphql("addDiscussionComment"));
    const { variables } = JSON.parse(posted.body);
    assert.equal(variables.id, "D_5");
    // The discussion itself: a top-level comment.
    assert.equal(variables.thread, null);
    assert.match(variables.body, /^All done\.[\s\S]*reply in this discussion to continue/);
    const eyes = await github.waitFor(graphql("addReaction"));
    assert.deepEqual(JSON.parse(eyes.body).variables, { id: "D_5", content: "EYES" });
    // Nothing is posted to an issue of the same number.
    assert.equal(
      github.requests.some((r) => r.path.endsWith("/issues/8/comments")),
      false,
    );
    // Its sandbox's reads: discussions too, read-only, as everything but a write it checked
    // (github-gateway.mjs).
    const mint = github.requests.find((r) => r.body.includes("repositories"));
    assert.equal(JSON.parse(mint.body).permissions.discussions, "read");
    const runEnv = readFileSync(join(dir, "run-env"), "utf8");
    assert.match(runEnv, /^TASK_MODE=discussion$/m);
    assert.match(runEnv, /^SANDBOX_LIGHT=1$/m);
    assert.match(runEnv, /^TASK_PROMPT=New on discussion #8 of org\/repo/m);
    const args = readFileSync(join(dir, "run-args"), "utf8").split("\n");
    assert.ok(args.includes("deckhand.task=org/repo#discussion-8"));
  });

  // The run's mode and whether it is light, from the fake sandbox's last environment.
  function lastRun(dir) {
    const env = readFileSync(join(dir, "run-env"), "utf8");
    return `${/^TASK_MODE=(.*)$/m.exec(env)[1]} ${/^SANDBOX_LIGHT=(.*)$/m.exec(env)[1] || "full"}`;
  }

  test("/after #77: waits, through a restart, and runs the comment once #77 is done", async (t) => {
    const files = { "issue:77": JSON.stringify({ state: "open" }) };
    const { dir, github, send, restart } = await listen(t, files);
    await send(
      comment("alice", "Deckhand /after #77\n/effort high\nDo it on top of the new parser."),
    );
    await until(() => replies(github).length === 1, "the waiting reply");
    assert.match(
      JSON.parse(replies(github)[0].body).body,
      /^Waiting for #77: I'll start when it is done/,
    );
    // 👀 on the comment, and no run yet.
    assert.ok(
      github.requests.some((r) => r.path === "/repos/org/repo/issues/comments/99/reactions"),
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(exists(join(dir, "run-args")), null);
    assert.deepEqual((await storedMap(dir, "waits"))["org/repo#12"].blockers, [77]);

    // #77 is merged while the listener is down: the next one asks GitHub when it starts.
    files["issue:77"] = JSON.stringify({ state: "closed", pull_request: { merged_at: "2026" } });
    await restart();
    await until(() => exists(join(dir, "run-args")), "the run");
    const env = readFileSync(join(dir, "run-env"), "utf8");
    assert.match(env, /^TASK_MESSAGE=Do it on top of the new parser\.$/m);
    assert.match(env, /^SANDBOX_EFFORT=high$/m);
    await until(() => replies(github).length === 3, "the starting reply and the run's");
    assert.match(JSON.parse(replies(github)[1].body).body, /^#77 is done: starting\./);
    assert.deepEqual(await storedMap(dir, "waits"), {});
  });

  // A pull request closed by a merge into `base`, saying "Closes #77", from the repo's branch.
  const mergedPull = (base = "trunk") => ({
    action: "closed",
    installation: { id: 7 },
    repository: { full_name: "org/repo", default_branch: "trunk" },
    pull_request: {
      number: 90,
      state: "closed",
      merged: true,
      merged_at: "2026-10-15T00:00:00Z",
      body: "Closes #77",
      base: { ref: base },
      head: { ref: "issue-77-parser", repo: { full_name: "org/repo" } },
      html_url: "https://github.com/org/repo/pull/90",
    },
    sender: { login: "bob" },
  });

  test("conflicts: a merge into the default branch checks the open task pull requests soon", async (t) => {
    const conflicted = {
      number: 13,
      state: "open",
      mergeable: false,
      mergeable_state: "dirty",
      labels: [],
      head: { sha: "head-1", ref: "issue-12-fix", repo: { full_name: "org/repo" } },
      base: { ref: "trunk", sha: "old" },
    };
    const files = {
      ".deckhand.yaml": "conflicts:\n  check_minutes: 60\n",
      "pull:13": JSON.stringify(conflicted),
      "ref:trunk": "base-2",
    };
    const { dir, github, send, listener } = await listen(t, files, {
      CONFLICT_MERGE_DELAY_MS: "0",
    });
    // Deckhand's pull request for #12, open.
    await send(
      {
        action: "opened",
        installation: { id: 7 },
        repository: { full_name: "org/repo", default_branch: "trunk" },
        pull_request: { ...conflicted, body: "Closes #12", draft: true },
        sender: { login: "deckhand-x[bot]", type: "Bot" },
      },
      "pull_request",
    );
    await listener.until("org/repo#12: pull request #13 draft");
    // Another one merged into trunk: #13 is asked at once and rebased. Not by the first tick,
    // a minute after start, which would check the repo too: until() gives up after 10 s.
    await send(mergedPull(), "pull_request");
    await until(
      () =>
        github.requests.some((r) => r.method === "GET" && r.path === "/repos/org/repo/pulls/13"),
      "the conflict check",
    );
    await listener.until("org/repo#12: pull request #13 conflicts with trunk");
    await until(() => exists(join(dir, "run-env")), "the rebase run");
    assert.match(
      readFileSync(join(dir, "run-env"), "utf8"),
      /^TASK_MESSAGE=This pull request conflicts with `trunk`/m,
    );
    await listener.until("done (ok)");
  });

  function installed(sender = "alice", repos = ["org/repo"]) {
    return {
      action: "created",
      installation: { id: 7 },
      repositories: repos.map((full_name) => ({ full_name })),
      sender: { login: sender },
    };
  }

  const onIssue30 = (github) =>
    github.requests.filter(
      (r) => r.method === "POST" && r.path === "/repos/org/repo/issues/30/comments",
    );

  function onIssue30Comment(id, body) {
    const payload = followUp(id, body);
    payload.issue = { number: 30 };
    return payload;
  }

  test("installing the App on a repo without a config: an onboarding issue and conversation, then its pull request", async (t) => {
    const ctx = await listen(
      t,
      {
        // The work run's branch: a config with an error, and the Dockerfile it names is missing.
        "issue-30-deckhand-config:.deckhand.yaml":
          "effort: huge\ndockerfile: .deckhand/Dockerfile\n",
      },
      (dir) => {
        mkdirSync(join(dir, "grants"), { recursive: true });
        writeFileSync(join(dir, "grants", "default.yaml"), "hosts: [registry.npmjs.org]\n");
        return {};
      },
    );
    const { dir, github, listener, send, restart } = ctx;
    assert.equal((await send(installed(), "installation")).status, 202);
    const issue = await github.waitFor(
      (r) => r.method === "POST" && r.path === "/repos/org/repo/issues",
    );
    const created = JSON.parse(issue.body);
    assert.equal(created.title, "Set up Deckhand for this repository");
    assert.deepEqual(created.labels, ["deckhand-onboarding"]);
    assert.match(created.body, /^@alice installed Deckhand/);
    assert.ok(github.requests.some((r) => r.path === "/repos/org/repo/labels"));

    // The onboarding run: light, read-only, its prompt with the operator's frame and the reference.
    await until(() => onIssue30(github).length === 1, "the proposal");
    const reply = JSON.parse(onIssue30(github)[0].body).body;
    assert.match(
      reply,
      /onboarding: reply to change the proposal, `Deckhand` opens the pull request/,
    );
    assert.equal(lastRun(dir), "onboarding 1");
    const env = readFileSync(join(dir, "run-env"), "utf8");
    assert.match(env, /^TASK_ISSUE=$/m);
    assert.match(env, /^TASK_PROMPT=Onboard org\/repo with the maintainer, on GitHub issue #30/m);
    assert.match(
      env,
      /Hosts the operator grants this repository \([^)]*\): `registry\.npmjs\.org`/,
    );
    assert.match(env, /Host mount roots granted to this repository: none/);
    assert.match(env, /## Reference: `\.deckhand\.yaml`[\s\S]*# Per-repo config/);
    const mints = () => github.requests.filter((r) => r.body.includes("repositories"));
    assert.equal(JSON.parse(mints().at(-1).body).permissions.contents, "read");
    assert.equal(JSON.parse(mints().at(-1).body).permissions.issues, "read");
    assert.deepEqual((await storedMap(dir, "onboarding"))["org/repo"].issue, 30);
    await listener.until("done (ok)");

    // A comment without a trigger line: the same conversation, nothing pushed.
    await send(onIssue30Comment(100, "Looks good, but run the linter too."));
    await until(() => onIssue30(github).length === 2, "the updated proposal");
    assert.equal(lastRun(dir), "onboarding 1");
    assert.match(
      readFileSync(join(dir, "run-env"), "utf8"),
      /^TASK_MESSAGE=Looks good, but run the linter too\./m,
    );
    assert.equal(JSON.parse(mints().at(-1).body).permissions.contents, "read");

    // The trigger line: a work run with the onboarding prompt, and the branch's config checked.
    await send(onIssue30Comment(101, "Deckhand"));
    await until(() => onIssue30(github).length === 3, "the pull request reply");
    assert.equal(lastRun(dir), "work full");
    const work = readFileSync(join(dir, "run-env"), "utf8");
    assert.match(work, /^TASK_ISSUE=30$/m);
    assert.match(work, /^TASK_PROMPT=The maintainer confirmed the onboarding proposal/m);
    // Its reads' token: a checked write's alone may write (github-gateway.mjs).
    assert.equal(JSON.parse(mints().at(-1).body).permissions.issues, "read");
    assert.equal(JSON.parse(mints().at(-1).body).permissions.pull_requests, "read");
    const done = JSON.parse(onIssue30(github)[2].body).body;
    assert.match(done, /^All done\./);
    assert.match(done, /`\.deckhand\.yaml` on `issue-30-deckhand-config` has errors/);
    assert.match(done, /- ❌ dockerfile: `\.deckhand\/Dockerfile` is not on the branch/);
    await listener.until("done (ok)");

    // A restart, then the App installed again: already onboarded, no second issue.
    await restart();
    await send(installed(), "installation");
    await ctx.listener.until("already onboarded (#30)");
    assert.equal(github.requests.filter((r) => r.path === "/repos/org/repo/issues").length, 1);
  });

  test("auto-pickup: an opted-in repo's labelled issue starts by itself, for whoever added the label", async (t) => {
    const repo = { full_name: "org/repo", html_url: "https://github.com/org/repo" };
    const labelled = {
      number: 12,
      title: "Left in the backlog",
      state: "open",
      created_at: "2026-01-01T00:00:00Z",
      labels: [{ name: "auto-pickup" }],
      issue_dependencies_summary: { total_blocked_by: 0 },
    };
    const { github, listener } = await listen(
      t,
      {
        ".deckhand.yaml": "auto_pickup: true\n",
        installed: JSON.stringify({ repositories: [{ ...repo, default_branch: "trunk" }] }),
        backlog: JSON.stringify([labelled]),
        "events:12": JSON.stringify([
          {
            event: "labeled",
            label: { name: "auto-pickup" },
            actor: { login: "bob", type: "User" },
          },
        ]),
        // Its description never edited since.
        "graphql:userContentEdits": JSON.stringify({
          data: {
            repository: {
              issue: { userContentEdits: { pageInfo: { hasPreviousPage: false }, nodes: [] } },
            },
          },
        }),
      },
      { MAX_PARALLEL: "2", AUTO_PICKUP_SLOTS: "1" },
    );
    // The App's comment, then the label off, then the run, as the dashboard's start queues it.
    const removed = await github.waitFor(
      (r) => r.method === "DELETE" && r.path === "/repos/org/repo/issues/12/labels/auto-pickup",
    );
    const posted = await github.waitFor(
      (r) => r.method === "POST" && r.path === "/repos/org/repo/issues/12/comments",
    );
    assert.ok(github.requests.indexOf(posted) < github.requests.indexOf(removed));
    assert.match(JSON.parse(posted.body).body, /^Picked automatically: .* added by @bob/);
    await listener.until("org/repo#12: queued (work, issue 12, reply on #12)");
    await listener.until("Auto-pickup: org/repo#12: started (label added by bob)");
  });

  test("Work area plan: a parent's sub-issues start or wait from their links, the parent last", async (t) => {
    const repository_url = "https://api.github.com/repos/org/repo";
    const subs = [11, 12].map((number) => ({
      number,
      title: `Sub ${number}`,
      state: "open",
      repository_url,
    }));
    const { dir, github, port } = await listen(
      t,
      {
        "issue:10": JSON.stringify({ number: 10, title: "Epic", state: "open" }),
        "subs:10": JSON.stringify(subs),
        "blocked:11": JSON.stringify([{ number: 12, state: "open", repository_url }]),
        "parent:10": JSON.stringify({ number: 3, title: "Roadmap", repository_url }),
      },
      (dir, github) => {
        writeFileSync(join(dir, "hold"), "");
        return { GITHUB_URL: github.url };
      },
    );
    const base = `http://127.0.0.1:${port}`;
    const get = (path, cookie) =>
      fetch(base + path, { redirect: "manual", headers: cookie ? { cookie } : {} });
    const login = await get("/auth/login");
    const to = new URL(login.headers.get("location"));
    const state = login.headers.getSetCookie()[0].split(";")[0];
    const back = await get(`/auth/callback?code=c&state=${to.searchParams.get("state")}`, state);
    const session = back.headers
      .getSetCookie()
      .find((c) => c.startsWith("deckhand_session="))
      .split(";")[0];
    const res = await fetch(`${base}/api/repos/org/repo/work`, {
      method: "POST",
      headers: {
        cookie: session,
        origin: "https://hooks.example.com",
        "content-type": "application/json",
      },
      body: JSON.stringify({ action: "plan", number: 10 }),
    });
    assert.equal(res.status, 200);
    assert.equal(
      (await res.json()).message,
      "#10 laid out: #12 starts; #10 waits for #11 and #12; #11 waits for #12.",
    );
    const waits = await storedMap(dir, "waits");
    assert.deepEqual(waits["org/repo#10"].blockers, [11, 12]);
    assert.deepEqual(waits["org/repo#11"].blockers, [12]);
    const posted = github.requests.filter(
      (r) => r.method === "POST" && r.path.endsWith("/comments"),
    );
    assert.deepEqual(
      posted.map((r) => r.path),
      [10, 11, 12].map((n) => `/repos/org/repo/issues/${n}/comments`),
    );
    await until(() => exists(join(dir, "run-env")), "#12's run");
    assert.match(readFileSync(join(dir, "run-env"), "utf8"), /^TASK_ISSUE=12$/m);
    // Their lane is the parent's, until a maintainer names it otherwise.
    const named = await fetch(`${base}/api/repos/org/repo/lane`, {
      method: "POST",
      headers: {
        cookie: session,
        origin: "https://hooks.example.com",
        "content-type": "application/json",
      },
      body: JSON.stringify({ keys: ["org/repo#11"], name: "Budgets" }),
    });
    assert.equal(named.status, 200);
    const lanes = async () => (await (await get("/api/state", session)).json()).lanes;
    // The parent's title comes with a later poll.
    let now = await lanes();
    for (let i = 0; i < 200 && now["org/repo#10"]?.name !== "Epic"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      now = await lanes();
    }
    assert.deepEqual(now["org/repo#10"], { name: "Epic", source: "parent" });
    assert.equal(now["org/repo#11"].name, "Budgets");
    assert.equal(now["org/repo#11"].source, "user");
    // GitHub's parents are asked for the board's issues too; the plan's wins.
    const read = () => storedMap(dir, "lanes");
    let kept = await read();
    for (let i = 0; i < 200 && !kept["org/repo#12"]?.parentAt; i++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      kept = await read();
    }
    assert.deepEqual(kept["org/repo#10"].parent, { key: "org/repo#3", title: "Roadmap" });
    assert.equal(kept["org/repo#12"].parent, undefined);
    writeFileSync(join(dir, "go"), "");
  });

  test("a chat (#476): from the dashboard, a chat's sandbox, its messages to its inbox, nothing on GitHub, deleted", async (t) => {
    // Sign-in goes to GITHUB_URL, the fake GitHub, as `files.login`.
    const files = {};
    const listened = await listen(t, files, (dir, github) => ({
      GITHUB_URL: github.url,
      MAX_RUNNING_CHATS: "1",
    }));
    const { dir, github, port, restart } = listened;
    const base = `http://127.0.0.1:${port}`;
    const get = (path, cookie, init = {}) =>
      fetch(base + path, { redirect: "manual", headers: cookie ? { cookie } : {}, ...init });
    const signIn = async (as) => {
      files.login = as;
      const login = await get("/auth/login");
      const to = new URL(login.headers.get("location"));
      const state = login.headers.getSetCookie()[0].split(";")[0];
      const back = await get(`/auth/callback?code=c&state=${to.searchParams.get("state")}`, state);
      return back.headers
        .getSetCookie()
        .find((c) => c.startsWith("deckhand_session="))
        .split(";")[0];
    };
    const session = await signIn("alice");
    const api = (method, path, body) =>
      fetch(base + path, {
        method,
        headers: {
          cookie: session,
          origin: "https://hooks.example.com",
          "content-type": "application/json",
        },
        body: body && JSON.stringify(body),
      });
    const created = await api("POST", "/api/chats", {
      repo: "org/repo",
      message: "What does run() do?",
    });
    assert.equal(created.status, 201);
    const { id } = (await created.json()).chat;
    // run-args last (fixtures/fake-docker.sh): the others are there once it is.
    await until(() => exists(join(dir, "run-args")), "the chat's sandbox");
    const env = readFileSync(join(dir, "run-env"), "utf8");
    assert.match(env, /^TASK_MODE=chat$/m);
    assert.match(env, /^TASK_ISSUE=$/m);
    assert.match(env, /^SANDBOX_LIGHT=1$/m);
    assert.match(env, /^TASK_MESSAGE=What does run\(\) do\?$/m);
    assert.match(env, /^TASK_PROMPT=Chat with a user of Deckhand about org\/repo/m);
    // Its volumes are the chat's own, never the issues'.
    const args = readFileSync(join(dir, "run-args"), "utf8");
    const [, workspace] = args.match(
      new RegExp(
        `^(deckhand-org-repo-chat-${id}-[0-9a-f]{10}-light[\\w-]*-workspace):/workspace$`,
        "m",
      ),
    );
    const chat = async () => (await (await api("GET", `/api/chats/${id}`)).json()).chat;
    let now = await chat();
    for (let i = 0; i < 200 && now.status !== "idle"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      now = await chat();
    }
    assert.equal(now.status, "idle");
    assert.equal(now.runs.length, 1);
    // A restart keeps it, and its sandbox, which waits for the user's next message.
    await restart();
    assert.equal((await chat()).status, "idle");
    // The next message goes to its inbox, the same sandbox.
    assert.equal(
      (await api("POST", `/api/chats/${id}/messages`, { text: "And follow()?" })).status,
      202,
    );
    await until(() => exists(join(dir, "delivered"))?.includes("And follow()?"), "the message");
    // A handover too: the next copy reads the chats from the store once it holds the lease.
    await listened.handOver();
    assert.equal((await chat()).status, "idle");
    assert.equal(
      (await api("POST", `/api/chats/${id}/messages`, { text: "And end()?" })).status,
      202,
    );
    await until(() => exists(join(dir, "delivered"))?.includes("And end()?"), "the next message");
    // The board doesn't show it, and nothing went to GitHub.
    const board = await (await get("/api/state", session)).json();
    assert.deepEqual(board.tasks, []);
    assert.ok(
      !github.requests.some((r) => r.method !== "GET" && /comments|reactions/.test(r.path)),
    );
    // Its owner's alone: bob, allowed with every action on the repo (the fake opa's), doesn't
    // reach it, see it, its run or its log, on the board or in /status.
    const bob = await signIn("bob");
    const [{ id: run }] = (await chat()).runs;
    assert.equal((await get(`/api/runs/${run}/stream`, bob)).status, 404);
    assert.equal((await get(`/api/chats/${id}`, bob)).status, 404);
    assert.deepEqual((await (await get("/api/chats", bob)).json()).chats, []);
    const theirs = await (await get("/api/state", bob)).json();
    assert.deepEqual(theirs.tasks, []);
    assert.ok(!JSON.stringify(theirs).includes(id));
    const forwarded = { headers: { cookie: bob, "x-forwarded-for": "203.0.113.9" } };
    const status = await (await get("/status", null, forwarded)).json();
    assert.doesNotMatch(status.reasons.join("\n"), /chat/);
    assert.equal(status.queued, 0);
    // While its owner reads its log.
    const own = await get(`/api/runs/${run}/stream`, session);
    assert.equal(own.status, 200);
    await own.body.cancel();
    // Deleted: its sandbox stopped, its volumes removed (those the fake docker has), the chat
    // gone.
    writeFileSync(join(dir, "volumes"), `${workspace}\n`);
    const deleted = await api("DELETE", `/api/chats/${id}`);
    assert.equal(deleted.status, 200);
    assert.match(
      readFileSync(join(dir, "docker-calls"), "utf8"),
      new RegExp(`^stop .*-chat-${id}-`, "m"),
    );
    assert.match(
      readFileSync(join(dir, "docker-calls"), "utf8"),
      new RegExp(`^volume rm ${workspace}$`, "m"),
    );
    assert.deepEqual((await (await api("GET", "/api/chats")).json()).chats, []);
    await listened.listener.until(`org/repo#chat-${id}: chat deleted`);
    assert.equal(readdirSync(join(dir, "containers")).length, 0);
  });

  test("Analyze: a new issue, and a light run that reads a digest of the repo's runs only", async (t) => {
    const secret = "sk-ant-api03-0123456789abcdef";
    const { dir, github, port, listener } = await listen(t, {}, (dir, github) => {
      writeFileSync(join(dir, "hold"), "");
      const log = (id, repo, text) =>
        pastRun(dir, id, [
          { type: "listener", key: `${repo}#5`, repo, taskMode: "work", startedAt: 1000 },
          { type: "listener", event: "note", at: 1, message: "Image deckhand-private-note" },
          {
            type: "assistant",
            message: {
              content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "make" } }],
            },
          },
          {
            type: "user",
            message: {
              content: [{ type: "tool_result", content: "private output", is_error: true }],
            },
          },
          { type: "result", is_error: true, result: text, duration_ms: 6000 },
        ]);
      log("org-repo-5-1000", "org/repo", `The tests fail with ${secret}.`);
      log("org-other-5-1000", "org/other", "Another repo's failure.");
      return { ANTHROPIC_API_KEY: secret, GITHUB_URL: github.url };
    });
    const base = `http://127.0.0.1:${port}`;
    const get = (path, cookie) =>
      fetch(base + path, { redirect: "manual", headers: cookie ? { cookie } : {} });
    const login = await get("/auth/login");
    const to = new URL(login.headers.get("location"));
    const state = login.headers.getSetCookie()[0].split(";")[0];
    const back = await get(`/auth/callback?code=c&state=${to.searchParams.get("state")}`, state);
    const session = back.headers
      .getSetCookie()
      .find((c) => c.startsWith("deckhand_session="))
      .split(";")[0];
    const preview = await (
      await get("/api/repos/org/repo/analyze?count=10&kinds=work&outcomes=error", session)
    ).json();
    assert.deepEqual(preview.runs, ["org-repo-5-1000"]);
    const res = await fetch(`${base}/api/repos/org/repo/analyze`, {
      method: "POST",
      headers: {
        cookie: session,
        origin: "https://hooks.example.com",
        "content-type": "application/json",
      },
      body: JSON.stringify({ count: 10, kinds: ["work"], outcomes: ["error"] }),
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).task, "org/repo#30");
    const created = await github.waitFor(
      (r) => r.method === "POST" && r.path === "/repos/org/repo/issues",
    );
    assert.deepEqual(JSON.parse(created.body).labels, ["analysis"]);
    await until(() => exists(join(dir, "run-args")), "the run");
    const runEnv = readFileSync(join(dir, "run-env"), "utf8");
    assert.match(runEnv, /^TASK_MODE=analyze$/m);
    assert.match(runEnv, /^SANDBOX_LIGHT=1$/m);
    assert.match(runEnv, /^TASK_SESSION=fresh$/m);
    assert.match(
      runEnv,
      /^TASK_PROMPT=Analyze recent Deckhand runs of org\/repo, on GitHub issue #30/m,
    );
    assert.match(
      readFileSync(join(dir, "run-args"), "utf8"),
      /^TASK_DIGEST=http:\/\/[^/]+\/run\/digest$/m,
    );
    // In the run's inbox folder: this repo's run, redacted; not the other repo's.
    const [folder] = readdirSync(join(dir, "runs")).filter((f) =>
      exists(join(dir, "runs", f, "digest.md")),
    );
    const digest = readFileSync(join(dir, "runs", folder, "digest.md"), "utf8");
    assert.match(digest, /## Run org-repo-5-1000/);
    assert.match(digest, /The tests fail with \[redacted\]\./);
    assert.ok(!digest.includes(secret));
    assert.doesNotMatch(digest, /org-other|Another repo/);
    // A public repo (GitHub doesn't say it is private): what only the dashboard showed stays
    // out, the failed call itself stays.
    assert.doesNotMatch(digest, /private-note|private output|Listener notes/);
    assert.match(digest, /Bash: make\n→\n\(output left out: public repository\)/);
    writeFileSync(join(dir, "go"), "");
    const reply = await github.waitFor(
      (r) => r.method === "POST" && r.path === "/repos/org/repo/issues/30/comments",
    );
    assert.match(JSON.parse(reply.body).body, /^All done\./);
    await listener.until("done (ok)");
  });
});
