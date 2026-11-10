// The orchestrator end to end, a run's GitHub writes and pushes through the gateways
// (orchestrator-harness.mjs has the harness): brainstorms, projects, tokens, branches.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { tempDir } from "./helpers.mjs";
import {
  agentTokenIn,
  brainstormOpa,
  comment,
  exists,
  holding,
  listen,
  liveStates,
  onlyLog,
  options,
  storedMap,
  summary,
  until,
  writeGrant,
  writeGrants,
} from "./orchestrator-harness.mjs";

describe("listener", options, () => {
  // What the running sandbox's secret gets from the git gateway and from opening its pull
  // request through the GitHub gateway (`gh pr create`'s write, over REST).
  async function pushAndOpen({ dir, proxyPort }) {
    const secret = readFileSync(join(dir, "run-token"), "utf8").trim();
    const basic = Buffer.from(`deckhand:${secret}`).toString("base64");
    const push = await fetch(
      `http://127.0.0.1:${proxyPort}/git/org/repo.git/info/refs?service=git-receive-pack`,
      { headers: { authorization: `Basic ${basic}` } },
    );
    const opened = await fetch(
      `http://127.0.0.1:${proxyPort}/relay/127.0.0.1/repos/org/repo/pulls`,
      {
        method: "POST",
        headers: { authorization: `token ${secret}` },
        body: JSON.stringify({ title: "t", head: "issue-12-x", base: "trunk" }),
      },
    );
    return [`${push.status} ${await push.text()}`, `${opened.status} ${await opened.text()}`];
  }

  test("a brainstorm can't push or open a pull request, before or after a restart", async (t) => {
    const ctx = await holding(t, "Deckhand\n/mode brainstorm\nWhat about dark mode?");
    const refused = [
      /^403 Deckhand: this run can't push/,
      // It has no branch: refused before any policy.
      /^403 .*issue-12-x is not this run's branch/,
    ];
    const check = async () => {
      const answers = await pushAndOpen(ctx);
      answers.forEach((answer, i) => assert.match(answer, refused[i]));
    };
    await check();
    assert.match(readFileSync(join(ctx.dir, "run-env"), "utf8"), /^SANDBOX_LIGHT=1$/m);
    await ctx.restart();
    await ctx.listener.until("again");
    await check();
  });

  test("a brainstorm's REST writes: its issue's description, not another issue's, after a restart too", async (t) => {
    const files = {
      "issue:12": JSON.stringify({ number: 12, user: { login: "alice" }, labels: [] }),
      "issue:3": JSON.stringify({ number: 3, user: { login: "bob" }, labels: [] }),
    };
    const ctx = await listen(t, files, (dir) => (writeFileSync(join(dir, "hold"), ""), {}), {
      opa: brainstormOpa(),
    });
    await ctx.send(comment("alice", "Deckhand\n/mode brainstorm\nWhat about dark mode?"));
    await until(() => exists(join(ctx.dir, "egress"))?.trim().split("\n").length === 10, "the run");
    const secret = readFileSync(join(ctx.dir, "run-token"), "utf8").trim();
    const patch = (number) =>
      fetch(`http://127.0.0.1:${ctx.proxyPort}/relay/127.0.0.1/repos/org/repo/issues/${number}`, {
        method: "PATCH",
        headers: { authorization: `token ${secret}` },
        body: JSON.stringify({ body: "Updated." }),
      });
    const check = async () => {
      const own = await patch(12);
      assert.equal(own.status, 200);
      const other = await patch(3);
      assert.equal(other.status, 403);
      assert.match(
        (await other.json()).message,
        /no rule allows `edit` on `other_issue` for a `brainstorm` run/,
      );
    };
    await check();
    const edits = ctx.github.requests.filter((r) => r.method === "PATCH");
    assert.deepEqual(
      edits.map((r) => [r.path, r.auth]),
      [["/repos/org/repo/issues/12", "token repo-token"]],
    );
    // Its kind looked up with the listener's token, not the run's.
    const lookup = ctx.github.requests.find(
      (r) => r.method === "GET" && r.path === "/repos/org/repo/issues/3/parent",
    );
    assert.equal(lookup.auth, "Bearer app-token");
    await ctx.restart();
    await ctx.listener.until("again");
    await check();
  });

  test("a brainstorm's GraphQL: checked from its nodes, printed again, the only call whose token writes", async (t) => {
    const issue = (number) => ({
      __typename: "Issue",
      number,
      databaseId: number,
      repository: { nameWithOwner: "org/repo" },
    });
    const files = {
      "issue:12": JSON.stringify({ number: 12, user: { login: "alice" }, labels: [] }),
      "issue:3": JSON.stringify({ number: 3, user: { login: "bob" }, labels: [] }),
      nodes: JSON.stringify({ data: { nodes: [issue(12), issue(3)] } }),
    };
    const ctx = await listen(t, files, (dir) => (writeFileSync(join(dir, "hold"), ""), {}), {
      opa: brainstormOpa(),
    });
    await ctx.send(comment("alice", "Deckhand\n/mode brainstorm\nWhat about dark mode?"));
    await until(() => exists(join(ctx.dir, "egress"))?.trim().split("\n").length === 10, "the run");
    const secret = readFileSync(join(ctx.dir, "run-token"), "utf8").trim();
    const graphql = (query) =>
      fetch(`http://127.0.0.1:${ctx.proxyPort}/relay/127.0.0.1/graphql`, {
        method: "POST",
        headers: { authorization: `token ${secret}` },
        body: JSON.stringify({ query }),
      });
    const mints = () => ctx.github.requests.filter((r) => r.body.includes("repositories"));
    // Its own issue's description goes on, the other one's refuses the call.
    const both = (second) =>
      `mutation { a: updateIssue(input: {id: "I_12", body: "Hi"}) { clientMutationId } b: updateIssue(input: {id: "${second}", body: "Hi"}) { clientMutationId } }`;
    const refused = await graphql(both("I_3"));
    assert.equal(refused.status, 403);
    assert.match(
      (await refused.json()).message,
      /^Deckhand: b: .*no rule allows `edit` on `other_issue` for a `brainstorm` run/,
    );
    const relayed = () =>
      ctx.github.requests.filter((r) => r.path === "/graphql" && r.auth === "token repo-token");
    assert.deepEqual(relayed(), []);
    files.nodes = JSON.stringify({ data: { nodes: [issue(12)] } });
    const ok = await graphql(both("I_12"));
    assert.equal(ok.status, 200);
    // What GitHub got: the document as the gateway printed it, with a token that writes.
    const sent = relayed();
    assert.equal(sent.length, 1);
    assert.match(JSON.parse(sent[0].body).query, /^mutation \{\n {2}a: updateIssue\(input: \{/);
    assert.equal(JSON.parse(mints().at(-1).body).permissions.issues, "write");
    // Its nodes looked up with the listener's token, not the run's.
    const lookup = ctx.github.requests.find((r) => r.body.includes("nodes(ids:"));
    assert.equal(lookup.auth, "Bearer app-token");
    // A query: its token only reads, as every other call of the run's.
    assert.equal((await graphql("{ viewer { login } }")).status, 200);
    const levels = mints().map((m) => JSON.parse(m.body).permissions.issues);
    assert.deepEqual([...new Set(levels)].sort(), ["read", "write"]);
    assert.equal(levels.filter((l) => l === "write").length, 1);
    // CI's checks and statuses (`gh pr checks`): held to deny_github's read_checks, which
    // Deckhand's defaults allow, then read with a token that has them.
    const rollup =
      '{ repository(owner: "org", name: "repo") { pullRequest(number: 1) { commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } } } }';
    assert.equal((await graphql(rollup)).status, 200);
    await fetch(
      `http://127.0.0.1:${ctx.proxyPort}/relay/127.0.0.1/repos/org/repo/commits/abc/check-runs`,
      {
        headers: { authorization: `token ${secret}` },
      },
    );
    assert.ok(ctx.github.requests.some((r) => r.path === "/repos/org/repo/commits/abc/check-runs"));
    assert.equal(JSON.parse(mints().at(-1).body).permissions.checks, "read");
    // A mutation Deckhand doesn't know: refused before anything is looked up.
    const deleted = await graphql(
      'mutation { deleteIssue(input: {issueId: "I_3"}) { clientMutationId } }',
    );
    assert.equal(deleted.status, 403);
  });

  test("projects: a granted project's item added by the run; the listener moves its issue at start and ready", async (t) => {
    const node = (n) => ({ data: { nodes: n } });
    const files = {
      ".deckhand.yaml":
        "projects:\n  - project: acme/3\n    start: In progress\n    ready: In review\n",
      "issue:12": JSON.stringify({ number: 12, user: { login: "alice" }, labels: [] }),
      "graphql:projectV2(number": JSON.stringify({
        data: {
          organization: {
            projectV2: {
              id: "PV_3",
              field: {
                __typename: "ProjectV2SingleSelectField",
                id: "F_status",
                options: [
                  { id: "O_1", name: "In progress" },
                  { id: "O_2", name: "In review" },
                ],
              },
            },
          },
        },
      }),
      "graphql:issue(number": JSON.stringify({ data: { repository: { issue: { id: "I_12" } } } }),
      "graphql:pullRequest(number": JSON.stringify({
        data: { repository: { pullRequest: { id: "PR_50" } } },
      }),
      "graphql:mutation($project: ID!, $content": JSON.stringify({
        data: { addProjectV2ItemById: { item: { id: "PVTI_12" } } },
      }),
      "graphql:updateProjectV2ItemFieldValue": JSON.stringify({
        data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: "PVTI_12" } } },
      }),
    };
    const ctx = await listen(t, files, (dir) => {
      writeGrant(dir, "allow_projects: [acme/3]\n");
      writeFileSync(join(dir, "hold"), "");
      return {};
    });
    const set = (option) => (r) =>
      r.path === "/graphql" &&
      r.body.includes("updateProjectV2ItemFieldValue") &&
      JSON.parse(r.body).variables.option === option;
    await ctx.send(comment("alice", "Deckhand"));
    // At start: In progress, with the listener's own token.
    const started = await ctx.github.waitFor(set("O_1"));
    assert.equal(started.auth, "Bearer app-token");
    assert.deepEqual(JSON.parse(started.body).variables, {
      project: "PV_3",
      item: "PVTI_12",
      field: "F_status",
      option: "O_1",
    });
    await ctx.listener.until("org/repo#12: projects: acme/3: In progress (start)");
    // The run adds its issue to the granted project, never to another.
    await until(() => exists(join(ctx.dir, "run-token")), "the run");
    const secret = readFileSync(join(ctx.dir, "run-token"), "utf8").trim();
    const add = (project) =>
      fetch(`http://127.0.0.1:${ctx.proxyPort}/relay/127.0.0.1/graphql`, {
        method: "POST",
        headers: { authorization: `token ${secret}` },
        body: JSON.stringify({
          query: `mutation { addProjectV2ItemById(input: {contentId: "I_12", projectId: "${project}"}) { item { id } } }`,
        }),
      });
    const issue = { __typename: "Issue", number: 12, databaseId: 12 };
    const repo = { repository: { nameWithOwner: "org/repo" } };
    const project = (number) => ({
      __typename: "ProjectV2",
      number,
      title: "Roadmap",
      owner: { login: "acme" },
    });
    files.nodes = JSON.stringify(node([{ ...issue, ...repo }, project(9)]));
    const refused = await add("PV_9");
    assert.equal(refused.status, 403);
    assert.match((await refused.json()).message, /write project acme\/9 \(allow_projects\)/);
    files.nodes = JSON.stringify(node([{ ...issue, ...repo }, project(3)]));
    assert.equal((await add("PV_3")).status, 200);
    const mints = ctx.github.requests.filter((r) => r.body.includes("repositories"));
    assert.equal(JSON.parse(mints.at(-1).body).permissions.organization_projects, "write");
    // Its pull request turns ready: In review.
    await ctx.send(
      {
        action: "ready_for_review",
        installation: { id: 7 },
        repository: { full_name: "org/repo", default_branch: "trunk" },
        pull_request: {
          number: 50,
          state: "open",
          draft: false,
          body: "Closes #12",
          html_url: "https://github.com/org/repo/pull/50",
          head: { ref: "issue-12-x", sha: "abc", repo: { full_name: "org/repo" } },
          base: { ref: "trunk" },
          user: { login: "deckhand-x[bot]" },
        },
        sender: { login: "alice" },
      },
      "pull_request",
    );
    // Its issue and itself, the bot's pull request.
    await ctx.listener.until("org/repo#12 and #50: projects: acme/3: In review (ready)");
    const ready = ctx.github.requests.filter(set("O_2"));
    assert.equal(ready.length, 2);
    const added = ctx.github.requests.filter(
      (r) => r.path === "/graphql" && r.body.includes("$content") && r.auth === "Bearer app-token",
    );
    assert.deepEqual(
      added.map((r) => JSON.parse(r.body).variables.content),
      ["I_12", "I_12", "PR_50"],
    );
  });

  test("an installation token the github service used for a run: redacted from its log and reply by its fingerprint", async (t) => {
    // Long enough to fingerprint, and of no GitHub token's shape: only its fingerprint finds it.
    const used = "v1.installationtoken0123456789abcdef";
    const ctx = await listen(t, { repoToken: used }, (dir) => {
      writeFileSync(join(dir, "hold"), "");
      return {};
    });
    await ctx.send(comment("alice"));
    const egress = join(ctx.dir, "egress");
    await until(() => exists(egress)?.trim().split("\n").length === 10, "the sandbox");
    // The run's call, relayed through the listener to the in-process github service, which mints
    // the token and sends its fingerprint to the listener.
    const secret = readFileSync(join(ctx.dir, "run-token"), "utf8").trim();
    const read = await fetch(`http://127.0.0.1:${ctx.proxyPort}/relay/127.0.0.1/repos/org/repo`, {
      headers: { authorization: `token ${secret}` },
    });
    assert.equal(read.status, 200);
    assert.ok(ctx.github.requests.some((r) => r.auth === `token ${used}`));
    // Its fingerprint reaches the listener as an event, once the orchestrator took it.
    await until(() => ctx.githubService.taken("token"), "the token's fingerprint");
    writeFileSync(join(ctx.dir, "result"), `The token is ${used}.`);
    writeFileSync(join(ctx.dir, "go"), "");
    await ctx.listener.until("done (ok)");
    const log = await onlyLog(ctx.dir);
    assert.ok(!log.includes(used), "the token in the log");
    assert.match(log, /The token is \[redacted\]\./);
    const replies = ctx.github.requests.filter(
      (r) => r.path === "/repos/org/repo/issues/12/comments",
    );
    assert.ok(replies.length);
    for (const reply of replies) assert.ok(!reply.body.includes(used), "the token in the reply");
  });

  test("a run's token sent from another address: the egress proxy lets none of it through", async (t) => {
    const ctx = await holding(t, undefined, (dir, github) => ({ GITHUB_URL: github.url }));
    // The sandbox no longer has the address the requests come from; a restarted runner looks
    // its addresses up again.
    writeFileSync(join(ctx.dir, "elsewhere"), "");
    await ctx.restartRunner();
    await ctx.restart();
    await ctx.listener.until("picked up deckhand-org-repo-12-0e9572aae2 again");
    const secret = readFileSync(join(ctx.dir, "run-token"), "utf8").trim();
    const token = await fetch(`http://127.0.0.1:${ctx.proxyPort}/relay/127.0.0.1/repos/org/repo`, {
      headers: { authorization: `token ${secret}` },
    });
    assert.equal(token.status, 403);
    // That address is no running sandbox's: no GitHub, push or ready, refused before any service.
    const [push, opened] = await pushAndOpen(ctx);
    assert.match(push, /^403 [^]*only a running sandbox reaches the github service/);
    assert.match(opened, /^403 /);
  });

  test("a sandbox's models calls go through while the orchestrator hands over and the runner restarts (#936)", async (t) => {
    const ctx = await holding(t, undefined, (dir, github) => ({
      CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-operator",
      ANTHROPIC_BASE_URL: github.url,
    }));
    const secret = readFileSync(join(ctx.dir, "run-token"), "utf8").trim();
    const runEnv = readFileSync(join(ctx.dir, "run-env"), "utf8");
    const agentToken = agentTokenIn(runEnv, "CLAUDE_CODE_OAUTH_TOKEN", secret);
    const call = async () => {
      const res = await fetch(`http://127.0.0.1:${ctx.proxyPort}/anthropic/v1/messages?beta=true`, {
        method: "POST",
        headers: { authorization: `Bearer ${agentToken}` },
        body: "{}",
      });
      return `${res.status} ${await res.text()}`;
    };
    await ctx.handOver();
    await ctx.listener.until("picked up deckhand-org-repo-12-0e9572aae2 again");
    // The next copy has never been asked about the sandbox's address, and the runner is away
    // longer than the proxy waits for one answer: it waits, it isn't told "no run there".
    await ctx.stopRunner();
    const during = call();
    await new Promise((resolve) => setTimeout(resolve, 6000));
    await ctx.startRunner();
    const answered = await during;
    assert.match(answered, /^200 /);
    assert.match(ctx.listener.output(), /Egress: models for \S+ waits for the runner/);
    assert.doesNotMatch(ctx.listener.output(), /Egress: refused models/);
    // The runner restarting again, as long: the copy's last answers stand meanwhile, each of
    // its answers within the proxy's wait for one. Past the second the proxy's addresses are
    // kept, so that each answer asks for them and for where the caller is.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await ctx.stopRunner();
    const restarting = call();
    await new Promise((resolve) => setTimeout(resolve, 6000));
    await ctx.startRunner();
    assert.match(await restarting, /^200 /);
    assert.doesNotMatch(ctx.listener.output(), /Egress: refused models/);
  });

  test("a run token renewed after a takeover: the broker's event has the next copy redact it by value (#617)", async (t) => {
    const ctx = await holding(t);
    await ctx.handOver();
    await ctx.listener.until("picked up deckhand-org-repo-12-0e9572aae2 again");
    // A minute on at the broker: the sandbox's renewal gets a token of its own, not the last one.
    ctx.brokerClock.skewMs = 61_000;
    const secret = readFileSync(join(ctx.dir, "run-token"), "utf8").trim();
    const res = await fetch(`http://127.0.0.1:${ctx.proxyPort}/run/token`, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}` },
    });
    assert.equal(res.status, 200);
    const renewed = (await res.text()).trim();
    assert.notEqual(renewed, secret);
    // The orchestrator handled the broker's `renewed` event (acknowledged it).
    const pending = async () =>
      (await ctx.brokerStore.read("runs", "orchestrator")).some(
        ({ event }) => event.type === "renewed",
      );
    for (let i = 0; await pending(); i++) {
      if (i > 400) throw new Error("timed out waiting for the renewed event's handling");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    // Its signature alone, which no token shape matches: only its value redacts it.
    const signature = renewed.split(".")[2];
    writeFileSync(join(ctx.dir, "leak"), signature);
    writeFileSync(join(ctx.dir, "go"), "");
    const reply = await ctx.github.waitFor((r) => r.path === "/repos/org/repo/issues/12/comments");
    const body = JSON.parse(reply.body).body;
    assert.match(body, /^Leaked \[redacted\] and \[redacted\]\./);
    assert.ok(!body.includes(signature));
  });

  test("a work run still pushes and opens its pull request, before and after a restart", async (t) => {
    const ctx = await holding(t, undefined, (dir, github) => ({ GITHUB_URL: github.url }));
    // Past the run checks: on to GitHub (here, a fake one that knows neither, rather than
    // github.com, which a sandbox without network waits for).
    const check = async () => {
      for (const answer of await pushAndOpen(ctx)) {
        assert.doesNotMatch(answer, /^40[13]|can't push|its ceiling/);
      }
      // Not a fork's run: a fork's pull request's head is refused it (github-forks.mjs).
      const secret = readFileSync(join(ctx.dir, "run-token"), "utf8").trim();
      const archive = await fetch(
        `http://127.0.0.1:${ctx.proxyPort}/relay/127.0.0.1/repos/org/repo/tarball/refs/pull/41/head`,
        { headers: { authorization: `token ${secret}` } },
      );
      assert.equal(archive.status, 403);
      assert.match(
        (await archive.json()).message,
        /pull request #41 is from a fork \(someone\/repo\)/,
      );
    };
    await check();
    await ctx.restart();
    await ctx.listener.until("picked up deckhand-org-repo-12-0e9572aae2 again");
    await check();
  });

  test("a work run on an issue without a branch: the listener creates and links it, TASK_BRANCH", async (t) => {
    const { dir, github, send } = await listen(t, {
      "branches:12": "[]",
      "ref:trunk": "base-sha",
      "issue:12": JSON.stringify({ number: 12, node_id: "I_12", title: "Add a thing", labels: [] }),
    });
    await send(comment("alice"));
    await until(() => exists(join(dir, "run-env")), "the run");
    assert.match(readFileSync(join(dir, "run-env"), "utf8"), /^TASK_BRANCH=issue-12-add-a-thing$/m);
    const link = github.requests.find(
      (r) => r.path === "/graphql" && r.body.includes("createLinkedBranch"),
    );
    // As the listener, at the base's head, before the sandbox started.
    assert.equal(link.auth, "Bearer app-token");
    assert.deepEqual(JSON.parse(link.body).variables.input, {
      issueId: "I_12",
      oid: "base-sha",
      name: "issue-12-add-a-thing",
      repositoryId: "R_1",
    });
    // Deckhand's gh-linked-branch.rego was asked: the task's page keeps its decision.
    const decisions = await storedMap(dir, "decisions");
    assert.deepEqual(
      decisions["org/repo#12"].map((d) => [d.rule, d.denied]),
      [["deny_link_branch", false]],
    );
  });

  // What the git gateway answers a push of `ref` with the run's secret: refused pushes are
  // answered by the gateway itself, the others reach the fake GitHub.
  // A commit over the empty tree, and a pack holding both: a push that carries what its branch
  // reaches, as a work run's must (git-mirror.mjs connect()).
  let carried = null;

  function commitPack() {
    if (carried) return carried;
    const repo = tempDir(null, "pack-");
    execFileSync("git", ["init", "-q", repo]);
    const git = (args, input) =>
      execFileSync("git", ["-C", repo, ...args], {
        input,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "a",
          GIT_AUTHOR_EMAIL: "a@a",
          GIT_COMMITTER_NAME: "a",
          GIT_COMMITTER_EMAIL: "a@a",
        },
      });
    const tree = git(["hash-object", "-t", "tree", "-w", "--stdin"], "").toString().trim();
    const sha = git(["commit-tree", tree, "-m", "c"]).toString().trim();
    return (carried = { sha, pack: git(["pack-objects", "--stdout"], `${sha}\n${tree}\n`) });
  }

  // A push of `ref` by hand: by default with a real commit and its pack; `carries: false`, to a
  // commit nobody has, without one.
  async function pushProbe(proxyPort, secret, ref, { carries = true } = {}) {
    const { sha, pack } = carries ? commitPack() : { sha: "a".repeat(40), pack: Buffer.alloc(0) };
    const line = `${"0".repeat(40)} ${sha} ${ref}\0report-status\n`;
    const body = Buffer.concat([
      Buffer.from(`${(line.length + 4).toString(16).padStart(4, "0")}${line}0000`),
      pack,
    ]);
    const res = await fetch(`http://127.0.0.1:${proxyPort}/git/org/repo.git/git-receive-pack`, {
      method: "POST",
      headers: { authorization: `Basic ${Buffer.from(`deckhand:${secret}`).toString("base64")}` },
      body,
    });
    return res.text();
  }

  // The branches a running run may push, from its saved state.
  async function savedBranches(dir) {
    const live = await until(() => liveStates(dir)[0], "the run's saved state");
    // Its tokens aren't in it (#617).
    assert.equal(live.agentToken, undefined);
    assert.equal(live.runTokens, undefined);
    return live.branches;
  }

  test("a run on an issue pushes issue-<n>-* only, before and after a restart", async (t) => {
    const ctx = await listen(t, {}, (dir, github) => {
      writeFileSync(join(dir, "hold"), "");
      return { GITHUB_URL: github.url };
    });
    const { dir, github, proxyPort } = ctx;
    await ctx.send(comment("alice"));
    await until(() => exists(join(dir, "egress"))?.trim().split("\n").length === 10, "the sandbox");
    assert.deepEqual(await savedBranches(dir), ["issue-12-*"]);
    const secret = readFileSync(join(dir, "run-token"), "utf8").trim();
    const forwarded = () =>
      github.requests.filter((r) => r.path === "/org/repo.git/git-receive-pack").length;

    for (const round of ["before", "after"]) {
      for (const ref of ["refs/heads/issue-13-x", "refs/heads/gh-pages"]) {
        assert.match(
          await pushProbe(proxyPort, secret, ref),
          /ng refs\/heads\/[\w-]+ Deckhand: this run can only push issue-12-\*/,
          `${round}: ${ref}`,
        );
      }
      assert.equal(forwarded(), round === "before" ? 0 : 1);
      await pushProbe(proxyPort, secret, `refs/heads/issue-12-${round}`);
      assert.equal(forwarded(), round === "before" ? 1 : 2);
      // GitHub took it: the run's last push, on its saved record.
      const record = () => liveStates(dir)[0].record;
      await until(() => record().branch === `issue-12-${round}`, "the push");
      assert.ok(record().lastPushAt > 0);
      if (round === "before") {
        await ctx.restart();
        await ctx.listener.until("picked up");
      }
    }
    writeFileSync(join(dir, "go"), "");
    await ctx.listener.until("done (ok)");
    // Kept in its summary once it ended: the dashboard's after it.
    const done = await until(() => summary(dir), "its summary");
    assert.equal(done.branch, "issue-12-after");
  });

  test("the `workflows` grant: pushes are checked against a mirror in the github service's data dir, until the grant goes", async (t) => {
    const ctx = await listen(t, {}, (dir, github) => {
      writeFileSync(join(dir, "hold"), "");
      writeGrants(dir, ["workflows"]);
      return { GITHUB_URL: github.url };
    });
    const { dir, github, proxyPort } = ctx;
    await ctx.send(comment("alice"));
    await until(() => exists(join(dir, "egress"))?.trim().split("\n").length === 10, "the sandbox");
    const secret = readFileSync(join(dir, "run-token"), "utf8").trim();
    // The token each push reached GitHub with.
    const pushedWith = () =>
      github.requests
        .filter((r) => r.path === "/org/repo.git/git-receive-pack")
        .map((r) => Buffer.from(r.auth.split(" ")[1], "base64").toString().split(":")[1]);
    // Read first, against a mirror fetched from GitHub with a token that reads (this fake GitHub
    // serves no git: an empty one): a branch pointed at a commit the push doesn't carry and the
    // repository doesn't have is refused, never forwarded (a work run that isn't a fork's).
    assert.match(
      await pushProbe(proxyPort, secret, "refs/heads/issue-12-x", { carries: false }),
      /ng refs\/heads\/issue-12-x Deckhand: this push points refs\/heads\/issue-12-x at a{12}, which it doesn't carry and org\/repo doesn't have/,
    );
    // The github service's, a cache of its own.
    assert.ok(existsSync(join(dir, "github-service", "mirrors", "org/repo.git")));
    const fetched = github.requests.find((r) => r.path.startsWith("/org/repo.git/info/refs"));
    assert.match(fetched.path, /service=git-upload-pack/);
    assert.equal(
      Buffer.from(fetched.auth.split(" ")[1], "base64").toString(),
      "x-access-token:repo-token",
    );
    assert.deepEqual(pushedWith(), []);
    // Opening its pull request checks the same, merged with its base, against the mirror
    // fetched again. This fake GitHub has no branch there, which runs nothing: it opens.
    const mirrorFetches = () =>
      github.requests.filter((r) => r.path.startsWith("/org/repo.git/info/refs")).length;
    const before = mirrorFetches();
    const opened = await fetch(
      `http://127.0.0.1:${proxyPort}/relay/127.0.0.1/repos/org/repo/pulls`,
      {
        method: "POST",
        headers: { authorization: `token ${secret}` },
        body: JSON.stringify({ title: "t", head: "issue-12-x", base: "trunk" }),
      },
    );
    assert.equal(opened.status, 200);
    assert.equal(mirrorFetches(), before + 1);
    // The push's token writes workflows; the sandbox's own tokens never do. Opening a pull
    // request is the one call whose token writes pull requests.
    const minted = github.requests.filter((r) => r.path.endsWith("/access_tokens"));
    assert.equal(minted.filter((r) => r.body.includes("workflows")).length, 1);
    const pullWrite = (r) => r.body.includes('"pull_requests":"write"');
    assert.equal(minted.filter(pullWrite).length, 1);
    assert.ok(
      github.requests.some((r) => r.method === "POST" && r.path === "/repos/org/repo/pulls"),
    );
    // Taken back: the next push goes through without it, no restart, read for what it carries
    // alone.
    writeGrants(dir, []);
    await pushProbe(proxyPort, secret, "refs/heads/issue-12-x");
    assert.deepEqual(pushedWith(), ["repo-token"]);
    writeFileSync(join(dir, "go"), "");
    await ctx.listener.until("done (ok)");
  });

  test("a run on a pull request pushes its head branch, a maintainer's included, never a fork's", async (t) => {
    const ctx = await listen(t, {}, (dir) => {
      writeFileSync(join(dir, "hold"), "");
      return {};
    });
    const { dir } = ctx;
    const onPull = (number) => {
      const payload = comment("alice");
      payload.issue = { number, pull_request: {} };
      return payload;
    };
    await ctx.send(onPull(40));
    await until(() => exists(join(dir, "egress"))?.trim().split("\n").length === 10, "the sandbox");
    assert.deepEqual(await savedBranches(dir), ["feature/maintainer"]);
    assert.match(
      readFileSync(join(dir, "run-env"), "utf8"),
      /push to its branch, `feature\/maintainer`: Deckhand refuses pushes to any other/,
    );
    writeFileSync(join(dir, "go"), "");
    await ctx.listener.until("done (ok)");
    rmSync(join(dir, "egress"));
    rmSync(join(dir, "go"));

    await ctx.send(onPull(41));
    await until(() => exists(join(dir, "egress"))?.trim().split("\n").length === 10, "the sandbox");
    assert.deepEqual(await savedBranches(dir), []);
    assert.match(readFileSync(join(dir, "run-env"), "utf8"), /its branch is in a fork/);
    writeFileSync(join(dir, "go"), "");
  });

  test("a granted repo's work runs get a container engine, never for a fork's pull request", async (t) => {
    const ctx = await listen(t, { ".deckhand.yaml": "docker:\n  cache: true\n" }, (dir) => {
      writeGrant(dir, "limits: { cpus: 3 }\n");
      writeGrants(dir, ["docker"]);
      writeFileSync(join(dir, "hold"), "");
      return { SANDBOX_ENGINE: "podman" };
    });
    const { dir, github } = ctx;
    // The network its tokens are bound to, from its saved state: what the egress policy finds
    // its sandbox and its engine by (broker-http.mjs taskWhere()).
    const savedSandbox = async () => {
      const state = await until(
        () => liveStates(dir).find((saved) => saved?.sandbox) ?? null,
        "the run's saved state, after its start",
      );
      return state;
    };
    await ctx.send(comment("alice"));
    const saved = await savedSandbox();
    assert.equal(saved.sandbox, `id-${saved.id}`);
    writeFileSync(join(dir, "go"), "");
    await github.waitFor(
      (r) => r.method === "POST" && r.path === "/repos/org/repo/issues/12/comments",
    );
    await ctx.listener.until("done (ok)");
    const joined = readFileSync(join(dir, "engine-args"), "utf8").split("\n").join(" ");
    assert.match(joined, /--network-alias engine /);
    assert.match(joined, /--cpus 3 --memory 4g --memory-swap 4g --pids-limit 2048 /);
    assert.match(joined, /src=deckhand-engine-cache-org-repo-[0-9a-f]+-podman,/);
    assert.match(joined, /--label deckhand\.task=org\/repo#12/);
    assert.doesNotMatch(joined, /--privileged|docker\.sock/);
    const args = readFileSync(join(dir, "run-args"), "utf8").split("\n");
    assert.ok(args.includes("DOCKER_HOST=tcp://engine:2375"));
    assert.ok(args.includes("DOCKER_BUILDKIT=0"));
    // The sandbox keeps its hardening.
    assert.match(
      args.join(" "),
      /--user 1000:1000 --cap-drop ALL --security-opt no-new-privileges/,
    );
    assert.match(readFileSync(join(dir, "run-env"), "utf8"), /^NO_PROXY=.*,engine$/m);
    assert.match(await onlyLog(dir), /Container engine: podman, the repository's cache/);

    // A fork's pull request: no engine.
    rmSync(join(dir, "engine-args"));
    rmSync(join(dir, "go"));
    await until(() => !liveStates(dir).length, "the first run's saved state removed");
    const payload = comment("alice");
    payload.issue = { number: 41, pull_request: {} };
    await ctx.send(payload);
    // Started: its saved state has its network.
    await savedSandbox();
    writeFileSync(join(dir, "go"), "");
    await ctx.listener.until("org/repo#pr-41: done (ok)");
    assert.throws(() => readFileSync(join(dir, "engine-args")));
    assert.doesNotMatch(readFileSync(join(dir, "run-args"), "utf8"), /DOCKER_HOST/);
  });
});
