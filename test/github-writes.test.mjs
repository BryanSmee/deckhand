// A run's REST writes (github-writes.mjs): classified, their target's kind resolved from GitHub,
// held to their mode's ceiling (modes.mjs) and the policies' `deny_github`.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createBroker } from "../listener/broker.mjs";
import { createGithubGateway } from "../listener/github-gateway.mjs";
import { aboveCeiling, classify, createWriteChecks } from "../listener/github-writes.mjs";
import { ceilingOf, MODES } from "../listener/modes.mjs";
import { createPolicies, opaRunner } from "../listener/policies.mjs";
import { policyEngine, sandboxAt, serve, tempDir } from "./helpers.mjs";

const json = (value) => Buffer.from(JSON.stringify(value));

test("classify: a write's actions, its target and what it changes", () => {
  const cases = [
    [
      "POST",
      "repos/Org/Repo/issues",
      { title: "T", body: "B", labels: ["idea", { name: "ui" }] },
      {
        repo: "org/repo",
        actions: ["create"],
        target: { kind: "new_issue" },
        change: {
          fields: ["title", "body", "labels"],
          labels_added: ["idea", "ui"],
          labels_removed: [],
        },
      },
    ],
    [
      "PATCH",
      "repos/org/repo/issues/12",
      { body: "x" },
      { actions: ["edit"], target: { number: 12 }, fields: ["body"] },
    ],
    // A state first, labels next, then the rest.
    [
      "PATCH",
      "repos/org/repo/issues/12",
      { state: "closed", state_reason: "completed" },
      { actions: ["close"], target: { number: 12 } },
    ],
    [
      "PATCH",
      "repos/org/repo/pulls/3",
      { labels: ["a"], title: "t" },
      { actions: ["label", "edit"], target: { number: 3 }, labels_added: ["a"] },
    ],
    ["POST", "repos/org/repo/issues/12/comments", { body: "hi" }, { actions: ["comment"] }],
    ["PUT", "repos/org/repo/issues/12/labels", ["a"], { actions: ["label"], labels_added: ["a"] }],
    [
      "DELETE",
      "repos/org/repo/issues/12/labels/needs input",
      null,
      { actions: ["label"], labels_removed: ["needs input"] },
    ],
    ["DELETE", "repos/org/repo/issues/12/labels", null, { labels_removed: ["*"] }],
    ["POST", "repos/org/repo/issues/12/sub_issues", { sub_issue_id: 9 }, { actions: ["link"] }],
    ["DELETE", "repos/org/repo/issues/12/sub_issue", { sub_issue_id: 9 }, { actions: ["link"] }],
    [
      "POST",
      "repos/org/repo/labels",
      { name: "idea" },
      { target: { kind: "label" }, labels_added: ["idea"] },
    ],
    [
      "PATCH",
      "repos/org/repo/issues/comments/5",
      { body: "x" },
      { actions: ["edit"], target: { kind: "comment" } },
    ],
    ["DELETE", "repos/org/repo/issues/comments/5", null, { actions: ["delete"] }],
    ["POST", "repos/org/repo/pulls/3/reviews", { event: "APPROVE" }, { actions: ["review"] }],
    ["POST", "repos/org/repo/pulls/3/comments/4/replies", { body: "x" }, { actions: ["review"] }],
    ["PUT", "repos/org/repo/pulls/3/merge", null, { actions: ["merge"], target: { number: 3 } }],
    ["POST", "repos/org/repo/pulls", { head: "issue-1-x" }, { target: { kind: "new_pr" } }],
    // Spelled another way: its case, a trailing slash.
    ["POST", "repos/org/repo/Issues/12/Comments/", { body: "hi" }, { actions: ["comment"] }],
  ];
  for (const [method, path, body, want] of cases) {
    const got = classify(method, path, body === null ? Buffer.alloc(0) : json(body));
    const label = `${method} ${path}`;
    if (want.repo) assert.deepEqual(got, want, label);
    if (want.actions) assert.deepEqual(got.actions, want.actions, label);
    if (want.target) assert.deepEqual(got.target, want.target, label);
    if (want.fields) assert.deepEqual(got.change.fields, want.fields, label);
    if (want.labels_added) assert.deepEqual(got.change.labels_added, want.labels_added, label);
    if (want.labels_removed)
      assert.deepEqual(got.change.labels_removed, want.labels_removed, label);
  }
  // Rendering markdown writes nothing.
  assert.deepEqual(classify("POST", "markdown/raw", Buffer.from("# x")), { read: true });
  // What it can't classify: null.
  for (const [method, path, body] of [
    ["PUT", "repos/org/repo/contents/a.txt", "{}"],
    ["POST", "repos/org/repo/git/refs", "{}"],
    ["POST", "repos/org/repo/dispatches", "{}"],
    ["POST", "repositories/42/issues/1/comments", "{}"],
    ["POST", "user/repos", "{}"],
    ["POST", "repos/org/repo/issues/1/comments", "not json"],
    ["PATCH", "repos/org/repo/issues/1", '"a string"'],
    ["POST", "repos/org/repo/issues/x/comments", "{}"],
  ]) {
    assert.equal(classify(method, path, Buffer.from(body)), null, `${method} ${path}`);
  }
});

test("the ceilings: what each mode can ever write", () => {
  const work = ceilingOf("work", false);
  assert.deepEqual(aboveCeiling(work, "own_issue", ["edit", "comment", "label"]), []);
  assert.deepEqual(aboveCeiling(work, "own_pr", ["edit", "label"]), []);
  assert.deepEqual(aboveCeiling(work, "sub_issue", ["link", "edit"]), []);
  assert.deepEqual(aboveCeiling(work, "other_issue", ["comment"]), ["comment"]);
  assert.deepEqual(aboveCeiling(work, "pr", ["comment"]), ["comment"]);
  assert.deepEqual(aboveCeiling(work, "own_issue", ["close"]), ["close"]);
  const brainstorm = ceilingOf("brainstorm", true);
  assert.deepEqual(aboveCeiling(brainstorm, "other_issue", ["comment"]), []);
  assert.deepEqual(aboveCeiling(brainstorm, "own_issue", ["label"]), ["label"]);
  assert.deepEqual(ceilingOf("stop", true), brainstorm);
  assert.deepEqual(aboveCeiling(ceilingOf("idea", true), "new_issue", ["create"]), []);
  assert.deepEqual(aboveCeiling(ceilingOf("bug", true), "own_issue", ["edit"]), ["edit"]);
  assert.deepEqual(ceilingOf("discussion", true), { new_issue: ["create"] });
  // Modes that read write nothing; a repo's light modes neither, its others as work runs.
  for (const mode of ["onboarding", "analyze", "review", "research", "policy"]) {
    assert.deepEqual(ceilingOf(mode, true), {}, mode);
  }
  assert.deepEqual(ceilingOf("triage", true), {});
  assert.deepEqual(ceilingOf("deploy", false), work);
  assert.deepEqual(ceilingOf(null, false), {});
  // No ceiling holds what stays out of every one.
  for (const [mode, { ceiling = {} }] of Object.entries(MODES)) {
    for (const actions of Object.values(ceiling)) {
      for (const out of ["close", "reopen", "delete", "merge", "review", "assign", "lock"]) {
        assert.ok(!actions.includes(out), `${mode}: ${out}`);
      }
    }
  }
});

// A fake GitHub for the look-ups: issues by number (a `pull_request` field for a pull
// request), pull requests' heads, issues' parents.
function fakeLookup({ issues = {}, pulls = {}, parents = {} } = {}) {
  const calls = [];
  const lookup = async (repo, path) => {
    calls.push(path);
    const m = /^\/repos\/org\/repo\/(issues|pulls)\/(\d+)(\/parent)?$/.exec(path);
    if (!m) throw new Error(`unexpected look-up ${path}`);
    const n = +m[2];
    if (m[3]) return parents[n] ? { number: parents[n] } : null;
    if (m[1] === "pulls") return pulls[n] ?? null;
    return issues[n] ?? null;
  };
  return { lookup, calls };
}

const GITHUB = {
  issues: {
    1: { number: 1, user: { login: "alice" }, labels: [{ name: "idea" }] },
    2: { number: 2, user: { login: "bob" }, labels: [] },
    3: { number: 3, user: { login: "bob" }, labels: [] },
    7: { number: 7, pull_request: {}, user: { login: "deckhand[bot]" }, labels: [] },
    8: { number: 8, pull_request: {}, user: { login: "bob" }, labels: [] },
  },
  pulls: {
    7: { head: { ref: "issue-1-thing", repo: { full_name: "Org/Repo" } } },
    // Another branch, and one named like the run's but in a fork.
    8: { head: { ref: "issue-1-thing", repo: { full_name: "mallory/repo" } } },
  },
  parents: { 2: 1 },
};

function run(mode, { push = mode === "work", issue = 1, branches = ["issue-1-*"] } = {}) {
  return { repo: "org/repo", mode, push, issue, base: "main", branches: push ? branches : [] };
}

const write = (method, path, body = {}) => ({ method, path, body: json(body) });

test("a work run writes its issue, its pull requests and its sub-issues, nothing else", async () => {
  const { lookup } = fakeLookup(GITHUB);
  const { check } = createWriteChecks({ lookup });
  const work = run("work");
  const allowed = [
    write("PATCH", "repos/org/repo/issues/1", { body: "x" }),
    write("POST", "repos/org/repo/issues/1/comments", { body: "x" }),
    write("POST", "repos/org/repo/issues/1/labels", { labels: ["a"] }),
    write("POST", "repos/org/repo/issues/1/sub_issues", { sub_issue_id: 9 }),
    write("PATCH", "repos/org/repo/pulls/7", { title: "x" }),
    write("POST", "repos/org/repo/issues/7/comments", { body: "x" }),
    write("PATCH", "repos/org/repo/issues/2", { body: "x" }),
    write("POST", "repos/org/repo/issues", { title: "x" }),
  ];
  for (const w of allowed) assert.equal(await check(work, w), null, `${w.method} ${w.path}`);
  const refused = [
    [
      write("POST", "repos/org/repo/issues/3/comments", { body: "x" }),
      /can't comment on other_issue #3/,
    ],
    [write("PATCH", "repos/org/repo/issues/3", { body: "x" }), /can't edit on other_issue #3/],
    [write("POST", "repos/org/repo/issues/8/comments", { body: "x" }), /can't comment on pr #8/],
    [
      write("POST", "repos/org/repo/issues/2/labels", { labels: ["a"] }),
      /can't label on sub_issue #2/,
    ],
    [write("PATCH", "repos/org/repo/issues/1", { state: "closed" }), /can't close here/],
    [write("PUT", "repos/org/repo/pulls/7/merge"), /can't merge here/],
    [write("POST", "repos/org/repo/pulls/7/reviews", { event: "APPROVE" }), /can't review here/],
    [write("PATCH", "repos/org/repo/issues/comments/5", { body: "x" }), /can't edit here/],
    [write("POST", "repos/other/repo/issues/1/comments", { body: "x" }), /its own repository/],
    [write("PUT", "repos/org/repo/contents/a", {}), /can't tell what this write does/],
    [write("POST", "repos/org/repo/issues/99/comments", { body: "x" }), /#99 isn't there/],
  ];
  for (const [w, why] of refused) {
    const got = await check(work, w);
    assert.ok(got, `${w.method} ${w.path}`);
    assert.match(got.message, why);
    assert.equal(got.status, /isn't there/.test(got.message) ? 404 : 403);
  }
});

test("target kinds come from GitHub, never from the request", async () => {
  const { lookup, calls } = fakeLookup(GITHUB);
  const { check } = createWriteChecks({ lookup });
  // Its pull request is by its branch, in its repo: a fork's of the same name isn't its own,
  // and a pull request's own path doesn't make it one.
  const work = run("work");
  assert.equal(await check(work, write("PATCH", "repos/org/repo/pulls/7", { title: "x" })), null);
  assert.match(
    (await check(work, write("PATCH", "repos/org/repo/pulls/8", { title: "x" }))).message,
    /on pr #8/,
  );
  // An issue path naming a pull request is the pull request.
  assert.match(
    (await check(run("idea"), write("POST", "repos/org/repo/issues/7/sub_issues", {}))).message,
    /can't link on pr #7/,
  );
  // A sub-issue by its parent on GitHub: the body's sub_issue_id says nothing.
  const brainstorm = run("brainstorm");
  assert.equal(
    await check(brainstorm, write("PATCH", "repos/org/repo/issues/2", { body: "x" })),
    null,
  );
  assert.match(
    (await check(brainstorm, write("PATCH", "repos/org/repo/issues/3", { body: "x", parent: 1 })))
      .message,
    /can't edit on other_issue #3/,
  );
  assert.ok(calls.includes("/repos/org/repo/issues/3/parent"));
  // A write no kind could take isn't looked up.
  const before = calls.length;
  await check(run("review"), write("POST", "repos/org/repo/issues/1/comments", { body: "x" }));
  assert.equal(calls.length, before);
  // A look-up that fails refuses.
  const broken = createWriteChecks({
    lookup: async () => {
      throw new Error("down");
    },
  });
  const failed = await broken.check(work, write("POST", "repos/org/repo/issues/1/comments", {}));
  assert.equal(failed.status, 502);
});

test("light runs: brainstorms, inbox entries, discussions and the modes that read", async () => {
  const { check } = createWriteChecks({ lookup: fakeLookup(GITHUB).lookup });
  const ok = async (mode, w) => assert.equal(await check(run(mode), w), null, `${mode} ${w.path}`);
  const no = async (mode, w) => assert.ok(await check(run(mode), w), `${mode} ${w.path}`);
  await ok("brainstorm", write("PATCH", "repos/org/repo/issues/1", { body: "x" }));
  await ok("brainstorm", write("POST", "repos/org/repo/issues/3/comments", { body: "x" }));
  await ok("brainstorm", write("POST", "repos/org/repo/issues/8/comments", { body: "x" }));
  await ok("stop", write("POST", "repos/org/repo/issues", { title: "x", labels: ["idea"] }));
  await ok("stop", write("POST", "repos/org/repo/labels", { name: "idea" }));
  await no("brainstorm", write("PATCH", "repos/org/repo/issues/3", { body: "x" }));
  await no("brainstorm", write("PATCH", "repos/org/repo/issues/1", { labels: ["x"] }));
  await ok("idea", write("POST", "repos/org/repo/issues", { title: "x" }));
  await ok("bug", write("POST", "repos/org/repo/issues/3/sub_issues", { sub_issue_id: 1 }));
  await ok("bug", write("POST", "repos/org/repo/issues/1/comments", { body: "x" }));
  await no("idea", write("PATCH", "repos/org/repo/issues/1", { body: "x" }));
  await ok("discussion", write("POST", "repos/org/repo/issues", { title: "x" }));
  await no("discussion", write("POST", "repos/org/repo/labels", { name: "x" }));
  for (const mode of ["onboarding", "analyze", "review", "triage"]) {
    await no(mode, write("POST", "repos/org/repo/issues/1/comments", { body: "x" }));
    await no(mode, write("POST", "repos/org/repo/issues", { title: "x" }));
  }
});

test("deny_github: its input, and its reasons refusing the write", async (t) => {
  const { engine: policies, evals } = policyEngine(t, {
    operator: { "github.rego": "package deckhand\n" },
    messages: (input) =>
      input.mode === "brainstorm" && input.target.kind !== "own_issue"
        ? ["brainstorms write only their own issue", "ask on #1 instead"]
        : [],
  });
  const { check } = createWriteChecks({ lookup: fakeLookup(GITHUB).lookup, policies });
  const brainstorm = run("brainstorm");
  assert.equal(
    await check(brainstorm, write("PATCH", "repos/org/repo/issues/1", { body: "x" })),
    null,
  );
  const refused = await check(
    brainstorm,
    write("POST", "repos/org/repo/issues/3/comments", { body: "x" }),
  );
  assert.deepEqual(refused, {
    status: 403,
    message:
      "the policies refuse it (deny_github): brainstorms write only their own issue; ask on #1 instead",
  });
  assert.deepEqual(evals.at(-1), {
    rule: "deny_github",
    version: 1,
    repo: "org/repo",
    mode: "brainstorm",
    issue: 1,
    action: "comment",
    actions: ["comment"],
    target: { number: 3, labels: [], author: "bob", kind: "other_issue" },
    change: { fields: ["body"], labels_added: [], labels_removed: [] },
  });
  // Above the ceiling: refused before any policy runs.
  const asked = evals.length;
  await check(brainstorm, write("PATCH", "repos/org/repo/issues/3", { body: "x" }));
  assert.equal(evals.length, asked);
});

test("a policy's refusal reaches the agent through the gateway, in GitHub's error shape", async (t) => {
  const github = await serve(t, (req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  const { engine: policies } = policyEngine(t, {
    operator: { "github.rego": "package deckhand\n" },
    messages: (input) => (input.action === "comment" ? ["no comments today"] : []),
  });
  const broker = createBroker({ sentFrom: sandboxAt() });
  const gw = createGithubGateway({
    broker,
    app: () => ({ repoToken: async () => ({ token: "t-0123456789abcdef" }) }),
    api: github.url,
    web: "https://github.example",
    checkWrite: createWriteChecks({ lookup: fakeLookup(GITHUB).lookup, policies }).check,
  });
  const { url } = await serve(t, (req, res) => gw.handle(req, res));
  const secret = broker.register("org/repo", undefined, { mode: "work", push: true, issue: 1 });
  const notes = [];
  broker.provide(secret, "anthropic", (line) => notes.push(line));
  const post = (path, body) =>
    fetch(`${url}/relay/127.0.0.1${path}`, {
      method: "POST",
      headers: { authorization: `token ${secret}` },
      body: JSON.stringify(body),
    });
  const res = await post("/repos/org/repo/issues/1/comments", { body: "x" });
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), {
    message: "Deckhand: the policies refuse it (deny_github): no comments today",
  });
  assert.match(
    notes[0],
    /refused the run's GitHub write POST \/repos\/org\/repo\/issues\/1\/comments: the policies refuse it/,
  );
  assert.equal((await post("/repos/org/repo/issues/1/labels", { labels: ["a"] })).status, 200);
});

// The real `opa`, when the PATH has it (the listener's image does).
let opa = false;
try {
  execFileSync("opa", ["version"], { stdio: "ignore" });
  opa = true;
} catch {}

test(
  "the real opa: the default policy of docs/repo-config.md narrows the ceilings as it says",
  { skip: !opa && "no opa on the PATH" },
  async (t) => {
    const docs = readFileSync(join(import.meta.dirname, "..", "docs", "repo-config.md"), "utf8");
    const [, template] = /<!-- github\.rego:[^\n]*-->\n\n```rego\n([\s\S]*?)```/.exec(docs);
    const policies = createPolicies({
      config: {},
      github: async () => new Response("{}", { status: 404 }),
      run: opaRunner(),
      readOperator: () => new Map([["github.rego", template]]),
      tmp: tempDir(t),
    });
    const ask = (mode, action, kind, labels_added = []) =>
      policies.deny("deny_github", "org/repo", "main", () => ({
        repo: "org/repo",
        mode,
        issue: 1,
        action,
        actions: [action],
        target: { kind, number: kind.startsWith("new") ? null : 7, labels: [], author: "a" },
        change: { fields: ["body"], labels_added, labels_removed: [] },
      }));
    assert.deepEqual(await ask("brainstorm", "edit", "own_issue"), []);
    assert.deepEqual(await ask("stop", "create", "new_issue", ["idea"]), []);
    assert.deepEqual(await ask("stop", "link", "own_issue"), []);
    assert.deepEqual(await ask("brainstorm", "comment", "other_issue"), [
      "a brainstorm doesn't comment: its final message is posted as its reply",
      "a brainstorm writes only its own issue, not #7",
    ]);
    assert.deepEqual(await ask("brainstorm", "edit", "sub_issue"), [
      "a brainstorm writes only its own issue, not #7",
    ]);
    assert.deepEqual(await ask("idea", "create", "new_issue", ["idea", "ui"]), []);
    assert.deepEqual(await ask("bug", "create", "label", ["bug"]), []);
    assert.deepEqual(await ask("bug", "link", "other_issue"), []);
    assert.deepEqual(await ask("idea", "create", "new_issue", ["ui"]), [
      "idea entries' issues carry the idea label",
    ]);
    assert.deepEqual(await ask("bug", "comment", "own_issue"), ["bug entries only file issues"]);
    // Work runs and discussions: their ceilings, as they are.
    assert.deepEqual(await ask("work", "comment", "own_pr"), []);
    assert.deepEqual(await ask("discussion", "create", "new_issue"), []);
  },
);
