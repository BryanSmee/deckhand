// The Workflow tab's editor (#1042): the what-if dry run (workflow-what-if.mjs) and the editor's
// routes (workflow-editor.mjs): its checks, its dry runs on a past pull request, and its saves
// as a pull request the App opens.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createWorkflowEditor, stepView, versionCounts } from "../listener/workflow-editor.mjs";
import {
  conditionText,
  parseCondition,
  parseWorkflow,
  reviewWorkflow,
} from "../listener/workflow-format.mjs";
import { recordedHistory, whatIf } from "../listener/workflow-what-if.mjs";
import { MEMBER, permissionsOf, serve, testConfig } from "./helpers.mjs";

const parsed = (text, name = "review.yaml") => {
  const { workflow, errors } = parseWorkflow(name, text);
  assert.deepEqual(errors, []);
  return workflow;
};

const BUILT_IN = reviewWorkflow({ on: "ready", ci: "wait", fix: true, fixRounds: 2, merge: true });

const TWO_REVIEWERS = `on: ready
vars:
  fixes: counter
steps:
  - run: review
  - repeat:
      - run: fix
        count: fixes
      - run: review
    max: fixes 3
  - if: severity <= low
    then:
      - run: review
        agent: codex
      - run: merge
`;

// A pull request reviewed twice, a fix run between, then merged.
const ENTRY = {
  fixes: 1,
  rounds: [
    { round: 0, at: 10, head: "a", counts: { high: 1 }, blocking: 1 },
    { round: 1, at: 20, head: "b", counts: { low: 1 }, blocking: 0 },
    { round: 1, at: 15, head: "b", counts: {}, blocking: 0, manual: true },
  ],
  mergeAt: 30,
  mergedAt: 30,
};

test("recordedHistory: the loop's reviews, its fix runs, the CI stop, the merge and the refusals", () => {
  assert.deepEqual(
    recordedHistory(ENTRY).map(({ run, outcome }) => [run, outcome]),
    [
      ["review", "high"],
      ["fix", "pushed"],
      ["review", "low"],
      ["merge", "merged"],
    ],
  );
  // A review the policies refused; a fix refused after a blocking review; CI stopped after it.
  assert.deepEqual(recordedHistory({}, [{ decision: "review", denied: true, at: 1 }]), [
    { run: "review", outcome: "refused", at: 1 },
  ]);
  const stopped = recordedHistory(
    { rounds: [{ round: 0, at: 5, counts: { medium: 2 }, blocking: 2 }], ciStopped: { at: 9 } },
    [{ decision: "fix", denied: true, at: 6 }],
  );
  assert.deepEqual(
    stopped.map(({ run, outcome }) => [run, outcome]),
    [
      ["review", "medium"],
      ["fix", "none"],
      ["ci", "failed"],
    ],
  );
  // A fix run whose end isn't recorded; an unreviewed one (`fix: true` alone) pushed.
  const going = { fixes: 1, rounds: [{ round: 0, at: 5, counts: { high: 1 }, blocking: 1 }] };
  assert.equal(recordedHistory(going).at(-1).outcome, null);
  assert.equal(recordedHistory({ ...going, unreviewedFix: 1 }).at(-1).outcome, "pushed");
  assert.deepEqual(recordedHistory(null), []);
});

test("whatIf: the workflow the pull request ran replays to its end without diverging", async () => {
  const history = recordedHistory(ENTRY);
  const result = await whatIf({ workflow: parsed(BUILT_IN), history });
  assert.equal(result.diverged, null);
  assert.equal(result.end, "merged");
  assert.deepEqual(
    result.trail.map((s) => [s.run, s.outcome, s.source]),
    [
      ["ci", "passed", "assumed"],
      ["review", "high", "recorded"],
      ["fix", "pushed", "recorded"],
      ["ci", "passed", "assumed"],
      ["review", "low", "recorded"],
      // Nothing blocking: no fix run starts, the loop ends.
      ["fix", "none", "auto"],
      ["merge", "merged", "recorded"],
    ],
  );
});

test("whatIf: stops at the first step the pull request never took, then follows the picks", async () => {
  const history = recordedHistory(ENTRY);
  const workflow = parsed(TWO_REVIEWERS);
  const first = await whatIf({ workflow, history });
  assert.equal(first.end, "asking");
  // The second reviewer: the pull request was merged instead.
  assert.deepEqual(first.diverged, {
    line: 13,
    run: "review",
    index: 4,
    expected: { run: "merge", outcome: "merged", at: 30 },
  });
  assert.equal(first.ask.line, 13);
  assert.ok(first.ask.options.includes("critical"));
  // It finds a high issue: the merge is refused, for sure.
  const high = await whatIf({ workflow, history, picks: ["high"] });
  assert.equal(high.end, "done");
  assert.deepEqual(high.trail.slice(4), [
    { line: 13, run: "review", outcome: "high", source: "picked" },
    { line: 15, run: "merge", outcome: "refused", source: "auto" },
  ]);
  // Its condition held on the first review's `low`: then a clean second one, then the merge asked.
  const clean = await whatIf({ workflow, history, picks: ["none"] });
  assert.deepEqual(clean.ask, { line: 15, run: "merge", options: ["merged", "refused"] });
  const merged = await whatIf({ workflow, history, picks: ["none", "merged"] });
  assert.equal(merged.end, "merged");
  // A pick that isn't one of the step's outcomes is asked again.
  assert.equal((await whatIf({ workflow, history, picks: ["pushed"] })).ask.line, 13);
});

test("whatIf: what the pull request did after the workflow ends, and a history that runs out", async () => {
  const history = recordedHistory(ENTRY);
  const reviewOnly = parsed("on: ready\nsteps:\n  - run: review\n");
  const ended = await whatIf({ workflow: reviewOnly, history });
  assert.equal(ended.end, "done");
  assert.equal(ended.diverged, null);
  assert.deepEqual(
    ended.leftover.map((e) => e.run),
    ["fix", "review", "merge"],
  );
  // No history: the first step is the divergence, asked.
  const fresh = await whatIf({ workflow: reviewOnly, history: [] });
  assert.deepEqual(fresh.diverged, { line: 3, run: "review", index: 0, expected: null });
  // A CI step that failed stops the event.
  const ci = parsed("on: ready\nsteps:\n  - run: ci\n  - run: review\n");
  const failed = await whatIf({ workflow: ci, history: [], picks: ["failed"] });
  assert.equal(failed.end, "stopped");
  assert.equal(failed.trail.length, 1);
});

test("whatIf: conditions read the pull request's files and labels, and the loop's bound holds", async () => {
  const workflow = parsed(`on: ready
vars:
  fixes: counter
  security: flag
steps:
  - if: 'changed("policy/**", since: security) and label("risky")'
    run: review
    set: security
  - repeat:
      - run: fix
        count: fixes
      - run: review
    max: fixes 2
`);
  const read = { files: () => ["policy/a.rego"], labels: () => ["Risky"] };
  // Every review blocks, every fix pushes: two rounds, then the loop's max.
  const picks = ["high", "pushed", "high", "pushed", "high"];
  const result = await whatIf({ workflow, read, picks });
  assert.equal(result.end, "done");
  assert.deepEqual(
    result.trail.map((s) => `${s.run}:${s.outcome}`),
    ["review:high", "fix:pushed", "review:high", "fix:pushed", "review:high"],
  );
  // Without the label, the first review doesn't run: nothing blocks, no fix run starts.
  const skipped = await whatIf({ workflow, read: { ...read, labels: () => [] } });
  assert.deepEqual(
    skipped.trail.map((s) => `${s.run}:${s.outcome}:${s.source}`),
    ["fix:none:auto"],
  );
  // MAX_FIX_ROUNDS caps the loop first.
  const capped = await whatIf({ workflow, read, picks, maxRounds: 1 });
  assert.equal(capped.trail.filter((s) => s.run === "fix").length, 1);
});

test("conditionText: parses back to the same condition", () => {
  const vars = { done: "flag", tries: "counter" };
  for (const text of [
    "severity <= medium",
    "ci == passed and not done",
    '(label("a") or paths("x/**", \'y"z\')) and tries < 3',
    "not (done and tries >= 1)",
    'changed("policy/**", since done) or severity == none',
  ]) {
    const tree = parseCondition(text, vars);
    assert.deepEqual(parseCondition(conditionText(tree), vars), tree, text);
  }
  assert.equal(
    conditionText(parseCondition("a or b and c", { a: "flag", b: "flag", c: "flag" })),
    "a or b and c",
  );
});

test("stepView: each step's kind, line and what it says, nested", () => {
  const steps = parsed(TWO_REVIEWERS).steps.map(stepView);
  assert.deepEqual(steps[0], { line: 5, kind: "run", run: "review" });
  assert.equal(steps[1].kind, "repeat");
  assert.deepEqual(steps[1].max, { var: "fixes", rounds: 3 });
  assert.deepEqual(steps[1].repeat[0], { line: 7, kind: "run", run: "fix", count: "fixes" });
  assert.equal(steps[2].kind, "if");
  assert.equal(steps[2].if, "severity <= low");
  assert.deepEqual(steps[2].then[0], { line: 13, kind: "run", run: "review", agent: "codex" });
  const said = parsed("on: ready\nsteps:\n  - comment: rounds-out\n  - comment: Hi\n").steps;
  assert.deepEqual(said.map(stepView), [
    { line: 3, kind: "comment", say: "rounds-out" },
    { line: 4, kind: "comment", comment: "Hi" },
  ]);
});

test("versionCounts: the open pull requests on the current version and on older ones", () => {
  const inst = (file, event, version) => ({ event, workflow: { file, version } });
  const open = new Map([
    ["org/app#pr-1", { ready: inst(".deckhand/workflows/review.yaml", "ready", "v2") }],
    ["org/app#pr-2", { ready: inst(".deckhand/workflows/review.yaml", "ready", "v1") }],
    ["Org/App#pr-3", { ready: inst(null, "ready", "b1"), conflict: inst(null, "conflict", "c") }],
    ["org/other#pr-1", { ready: inst(null, "ready", "b1") }],
  ]);
  const current = new Map([
    [".deckhand/workflows/review.yaml:ready", "v2"],
    [":conflict", "c"],
  ]);
  assert.deepEqual(versionCounts(open, "org/app", current), [
    { file: ".deckhand/workflows/review.yaml", event: "ready", current: 1, older: 1 },
    // The built-in loop no longer runs there: older.
    { file: null, event: "ready", current: 0, older: 1 },
    { file: null, event: "conflict", current: 1, older: 0 },
  ]);
});

// --- The routes ---------------------------------------------------------------------------------

const REVIEW_FILE = "on: ready\nsteps:\n  - run: review\n";
const blob = (text) => ({ content: Buffer.from(text).toString("base64"), encoding: "base64" });
const json = (value, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

// A fake GitHub for org/app: its default branch, one workflow file, pull request #7, and what
// the save writes (`writes`). `changed`: the file's blob on main differs from the one edited.
function fakeGithub({ files = { "review.yaml": REVIEW_FILE }, refuse = null } = {}) {
  const writes = [];
  const reads = [];
  const shas = Object.fromEntries(Object.keys(files).map((name, i) => [name, `blob${i}`]));
  const github = async (repo, method, path, body) => {
    const url = path.split("?")[0];
    if (method !== "GET") {
      writes.push({ method, path, body });
      if (refuse && url.endsWith(refuse)) return json({ message: "Nope" }, 422);
      if (url.endsWith("/git/refs")) return json({ ref: body.ref }, 201);
      if (url.includes("/contents/")) return json({ content: {} }, 201);
      if (url.endsWith("/pulls")) {
        return json({ number: 42, html_url: "https://github.com/org/app/pull/42" }, 201);
      }
    }
    if (url === "/repos/org/app") {
      return json({
        full_name: "org/app",
        default_branch: "main",
        html_url: "https://github.com/org/app",
      });
    }
    if (url === "/repos/org/app/contents/.deckhand/workflows") {
      return json(Object.keys(files).map((name) => ({ type: "file", name, sha: shas[name] })));
    }
    const file = /^\/repos\/org\/app\/contents\/\.deckhand\/workflows\/(.+)$/.exec(url);
    if (file) return files[file[1]] ? json({ sha: shas[file[1]] }) : json({}, 404);
    const b = /^\/repos\/org\/app\/git\/blobs\/blob(\d+)$/.exec(url);
    if (b) return json(blob(Object.values(files)[Number(b[1])]));
    if (url === "/repos/org/app/git/ref/heads/main") return json({ object: { sha: "c0ffee" } });
    if (url === "/repos/org/app/pulls/7") {
      return json({
        number: 7,
        title: "Add it",
        html_url: "https://github.com/org/app/pull/7",
        head: { sha: "h" },
        labels: [],
        body: "",
      });
    }
    if (url === "/repos/org/app/pulls/7/files") return json([]);
    if (url === "/users/alice") return json({ login: "alice", id: 1234 });
    return json({}, 404);
  };
  return {
    github: (...args) => (args[1] === "GET" && reads.push(args[2]), github(...args)),
    writes,
    reads,
  };
}

async function editorSetup(t, { files, refuse, rules } = {}) {
  const fake = fakeGithub({ files, refuse });
  const admin = [...MEMBER, "repo:config:read", "repo:config:write"];
  const clock = { at: 1_000_000 };
  const ctx = {
    now: () => clock.at,
    config: testConfig({ allowedRepos: ["org/app"] }),
    github: fake.github,
    repoSettings: async () => ({
      settings: { review: { maxAllowedSeverity: "low" } },
      errors: [],
    }),
    permissions: permissionsOf(
      rules ?? {
        alice: { "org/app": admin },
        bob: { "org/app": [...MEMBER, "repo:config:read"] },
      },
    ),
    reviews: {
      keys: () => ["org/app#pr-7", "org/app#12", "org/other#pr-3"],
      entry: (repo, number) => (number === 7 ? ENTRY : null),
    },
    decisions: { get: () => [] },
    workflowInstances: new Map([
      [
        "org/app#pr-9",
        {
          ready: {
            event: "ready",
            workflow: { file: ".deckhand/workflows/review.yaml", version: "old" },
          },
        },
      ],
    ]),
    publicUrl: () => "https://deckhand.example.com",
  };
  const editor = createWorkflowEditor(ctx);
  const { url } = await serve(t, (req, res) => {
    if (!editor.handle(req, res, req.headers["x-user"])) res.writeHead(404).end();
  });
  const call = async (
    method,
    path,
    body,
    { user = "alice", origin = "https://deckhand.example.com" } = {},
  ) => {
    const res = await fetch(url + path, {
      method,
      headers: { "x-user": user, origin, "content-type": "application/json" },
      body: body && JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  return { call, writes: fake.writes, reads: fake.reads, clock };
}

const BASE = "/api/repos/org/app/workflows";
const OWN_AGENT = TWO_REVIEWERS.replace("agent: codex", "agent: claude");

test("GET workflows: the files' texts, the built-in ones, the versions running, the past pull requests", async (t) => {
  const { call } = await editorSetup(t);
  const { status, body } = await call("GET", BASE);
  assert.equal(status, 200);
  assert.equal(body.base, "main");
  assert.deepEqual(body.files, [
    {
      name: "review.yaml",
      file: ".deckhand/workflows/review.yaml",
      text: REVIEW_FILE,
      sha: "blob0",
      url: "https://github.com/org/app/blob/main/.deckhand/workflows/review.yaml",
    },
  ]);
  // No `review.on: ready`: no built-in loop; the conflicts one always.
  assert.equal(body.builtIn.ready, null);
  assert.match(body.builtIn.conflict, /run: rebase/);
  assert.deepEqual(body.running, [
    { file: ".deckhand/workflows/review.yaml", event: "ready", current: 0, older: 1 },
  ]);
  assert.deepEqual(body.pulls, [{ number: 7, at: 20, reviews: 2, fixes: 1, merged: true }]);
});

test("POST check: the steps for the graph, the errors with their lines, the triggers with the other files", async (t) => {
  const { call } = await editorSetup(t);
  // The step's agent among the operator's: codex isn't.
  const codex = await call("POST", `${BASE}/check`, { name: "review.yaml", text: TWO_REVIEWERS });
  assert.equal(codex.status, 200);
  assert.deepEqual(codex.body.errors, [
    {
      file: null,
      line: 14,
      message: "agent: the operator hasn't configured codex (configured: claude)",
    },
  ]);
  const ok = await call("POST", `${BASE}/check`, { name: "review.yaml", text: OWN_AGENT });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.errors, []);
  assert.deepEqual(ok.body.on, ["ready"]);
  assert.equal(ok.body.steps.length, 3);
  const bad = await call("POST", `${BASE}/check`, {
    name: "review.yaml",
    text: "on: ready\nsteps:\n  - run: deploy\n",
  });
  assert.equal(bad.body.errors[0].line, 3);
  assert.equal(bad.body.errors[0].file, null);
  assert.match(bad.body.errors[0].message, /unknown step deploy/);
  // A second file on `ready` beside review.yaml: two triggers.
  const second = await call("POST", `${BASE}/check`, { name: "other.yaml", text: REVIEW_FILE });
  assert.match(second.body.errors.map((e) => e.message).join(), /two triggers for ready/);
  // A name the reader wouldn't take.
  const named = await call("POST", `${BASE}/check`, { name: "../x.yml", text: REVIEW_FILE });
  assert.equal(named.status, 400);
});

test("POST dry-run: the pull request's history replayed, then the step it never took asked", async (t) => {
  const { call } = await editorSetup(t);
  const asked = { name: "review.yaml", text: OWN_AGENT, pr: 7 };
  const first = await call("POST", `${BASE}/dry-run`, asked);
  assert.equal(first.status, 200);
  assert.deepEqual(first.body.pr, {
    number: 7,
    title: "Add it",
    url: "https://github.com/org/app/pull/7",
  });
  assert.equal(first.body.event, "ready");
  assert.equal(first.body.diverged.line, 13);
  assert.equal(first.body.ask.run, "review");
  assert.deepEqual(
    first.body.history.map((h) => h.run),
    ["review", "fix", "review", "merge"],
  );
  const next = await call("POST", `${BASE}/dry-run`, { ...asked, picks: ["none", "merged"] });
  assert.equal(next.body.end, "merged");
  // Errors in the text, or no such pull request.
  const broken = await call("POST", `${BASE}/dry-run`, { ...asked, text: "on: nope\n" });
  assert.equal(broken.status, 422);
  assert.equal((await call("POST", `${BASE}/dry-run`, { ...asked, pr: 8 })).status, 404);
});

test("POST save: a branch, the file committed and a pull request, by the App, saying who saved it", async (t) => {
  const { call, writes } = await editorSetup(t);
  const text = "on: ready\nsteps:\n  - run: review\n  - run: merge\n";
  const { status, body } = await call("POST", `${BASE}/save`, {
    name: "review.yaml",
    text,
    sha: "blob0",
  });
  assert.equal(status, 200);
  assert.equal(body.number, 42);
  assert.equal(body.url, "https://github.com/org/app/pull/42");
  assert.match(body.branch, /^deckhand-workflow-review-[0-9a-f]{8}$/);
  assert.deepEqual(
    writes.map((w) => `${w.method} ${w.path}`),
    [
      "POST /repos/org/app/git/refs",
      "PUT /repos/org/app/contents/.deckhand/workflows/review.yaml",
      "POST /repos/org/app/pulls",
    ],
  );
  assert.deepEqual(writes[0].body, { ref: `refs/heads/${body.branch}`, sha: "c0ffee" });
  const commit = writes[1].body;
  assert.equal(Buffer.from(commit.content, "base64").toString(), text);
  assert.equal(commit.sha, "blob0");
  assert.equal(commit.branch, body.branch);
  assert.match(
    commit.message,
    /^Edit \.deckhand\/workflows\/review\.yaml from Deckhand's dashboard/,
  );
  assert.match(commit.message, /Co-authored-by: alice <1234\+alice@users\.noreply\.github\.com>$/);
  assert.equal(writes[2].body.base, "main");
  assert.equal(writes[2].body.head, body.branch);
  assert.match(writes[2].body.body, /^@alice edited `\.deckhand\/workflows\/review\.yaml`/);
});

test("POST save: refused without repo:config:write, from another site, with errors, or over a newer file", async (t) => {
  const { call, writes } = await editorSetup(t);
  const asked = { name: "review.yaml", text: REVIEW_FILE, sha: "blob0" };
  // bob reads the config, and may dry-run, but not save.
  assert.equal((await call("POST", `${BASE}/check`, asked, { user: "bob" })).status, 200);
  const refused = await call("POST", `${BASE}/save`, asked, { user: "bob" });
  assert.equal(refused.status, 403);
  assert.match(refused.body.error, /repo:config:write/);
  assert.equal(
    (await call("POST", `${BASE}/save`, asked, { origin: "https://evil.example" })).status,
    403,
  );
  // A repo nobody sees there is hidden.
  assert.equal((await call("GET", BASE, null, { user: "carol" })).status, 404);
  const broken = await call("POST", `${BASE}/save`, { ...asked, text: "on: ready\n" });
  assert.equal(broken.status, 422);
  // The file changed on main since it was opened (or exists, for a new one).
  assert.equal((await call("POST", `${BASE}/save`, { ...asked, sha: "older" })).status, 409);
  const exists = await call("POST", `${BASE}/save`, { ...asked, sha: null });
  assert.equal(exists.status, 409);
  assert.match(exists.body.error, /review\.yaml already exists on main/);
  assert.deepEqual(writes, []);
  // A new file: no sha. GitHub refusing the pull request: a 502 saying so.
  const added = await call("POST", `${BASE}/save`, {
    name: "conflicts.yaml",
    text: "on: conflict\nsteps:\n  - run: rebase\n",
    sha: null,
  });
  assert.equal(added.status, 200);
  assert.equal(writes[1].body.sha, undefined);
  assert.match(writes[1].body.message, /^Add /);
});

test("POST save: GitHub's refusal said", async (t) => {
  const { call } = await editorSetup(t, { refuse: "/pulls" });
  const said = await call("POST", `${BASE}/save`, {
    name: "review.yaml",
    text: REVIEW_FILE,
    sha: "blob0",
  });
  assert.equal(said.status, 502);
  assert.match(said.body.error, /GitHub refused it \(422: Nope\)/);
});

test("POST check: what it reads of GitHub is kept a minute, a blob for good; GET reads afresh", async (t) => {
  const { call, reads, clock } = await editorSetup(t);
  const listing = (path) => path.startsWith("/repos/org/app/contents/.deckhand/workflows?");
  const asked = { name: "other.yaml", text: "on: conflict\nsteps:\n  - run: rebase\n" };
  await call("POST", `${BASE}/check`, asked);
  const first = reads.length;
  assert.equal(reads.filter(listing).length, 1);
  assert.equal(reads.filter((p) => p.includes("/git/blobs/")).length, 1);
  // Typing on: nothing read again.
  await call("POST", `${BASE}/check`, { ...asked, text: `${asked.text}# more\n` });
  await call("POST", `${BASE}/dry-run`, { ...asked, pr: 7, text: REVIEW_FILE });
  assert.deepEqual(
    reads
      .slice(first)
      .filter((p) => listing(p) || p.includes("/git/blobs/") || p === "/repos/org/app"),
    [],
  );
  // A minute later the repo and its listing are read again, the unchanged blob not.
  clock.at += 61_000;
  await call("POST", `${BASE}/check`, asked);
  assert.equal(reads.filter(listing).length, 2);
  assert.equal(reads.filter((p) => p.includes("/git/blobs/")).length, 1);
  // The tab's GET lists afresh.
  await call("GET", BASE);
  assert.equal(reads.filter(listing).length, 3);
});

test("POST save: a file name git can't take as a branch's still gives one it can", async (t) => {
  const { call, writes } = await editorSetup(t);
  const saved = await call("POST", `${BASE}/save`, {
    name: "A..b_c.yaml",
    text: "on: conflict\nsteps:\n  - run: rebase\n",
    sha: null,
  });
  assert.equal(saved.status, 200);
  assert.match(saved.body.branch, /^deckhand-workflow-a-b-c-[0-9a-f]{8}$/);
  assert.equal(writes[0].body.ref, `refs/heads/${saved.body.branch}`);
});
