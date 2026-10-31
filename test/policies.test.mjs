import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  createPolicies,
  DECISIONS,
  RULES,
  rulesOf,
  unallowed,
  denyKept,
  MAX_MESSAGE_LENGTH,
  MAX_TEXT,
  pullInput,
} from "../listener/policies.mjs";
import {
  ALLOW,
  allowOnly,
  BUILT_IN_DIR,
  builtInPolicies,
  namespaced,
  namespaceRefusal,
  operatorPolicies,
  REPO_NS,
  restrictedCapabilities,
  TIMEOUT_MS,
} from "../policy-service/engine.mjs";
import { opaBinary, opaRunner } from "../policy-service/opa.mjs";
import { issueServiceTokens, serviceTokens } from "../lib/service-token.mjs";
import { publishKey, signingKey } from "../lib/tokens.mjs";
import { policyClient } from "../listener/policy-client.mjs";
import { mergeInput } from "../listener/reviews.mjs";
import {
  evalResult,
  fakeOpa as sharedFakeOpa,
  hasOpa,
  localService,
  policyEngineOf,
  servePolicies,
  tempDir,
} from "./helpers.mjs";

const CAPABILITIES = {
  builtins: [
    { name: "count" },
    { name: "http.send" },
    { name: "net.cidr_contains" },
    { name: "net.lookup_ip_addr" },
    { name: "opa.runtime" },
    { name: "json.match_schema" },
    { name: "json.verify_schema" },
    { name: "json.marshal" },
    { name: "trace" },
    { name: "time.now_ns" },
  ],
  features: ["rego_v1"],
};

const DENY = 'package deckhand\n\ndeny_merge contains "too big" if input.pr.additions > 400\n';

// The files fixtures/opa-check-errors.json was recorded on.
const NET =
  "package deckhand\n\ndeny_review contains x if { x := http.send({}) }\ndeny_fix contains y if { y := undefined_thing }\n";
const SIZE =
  'package deckhand\n\ndeny_merge contains msg if {\n\tcount(input.pr.title, 2) > 1\n\tmsg := "x"\n}\n';

// A fake GitHub with `files` (name → text) in the repo's .deckhand/policy/, none when null.
function fakeGitHub(files = null, { status = null } = {}) {
  const calls = [];
  const sha = (name) => `sha-${Buffer.from(files[name]).toString("hex").slice(0, 32)}`;
  const github = async (repo, method, path) => {
    calls.push(path);
    if (path === "/repos/org/repo/contents/.deckhand/policy?ref=main") {
      if (status) return new Response("{}", { status });
      if (!files) return new Response("{}", { status: 404 });
      return Response.json([
        ...Object.keys(files).map((name) => ({ type: "file", name, sha: sha(name) })),
        { type: "dir", name: "lib", sha: "sha-dir" },
        { type: "file", name: "README.md", sha: "sha-readme" },
      ]);
    }
    const blob = /^\/repos\/org\/repo\/git\/blobs\/(.+)$/.exec(path);
    const name = blob && Object.keys(files ?? {}).find((n) => sha(n) === blob[1]);
    if (name) {
      return Response.json({
        content: Buffer.from(files[name]).toString("base64"),
        encoding: "base64",
      });
    }
    return new Response("{}", { status: 404 });
  };
  return { github, calls };
}

// A fake `opa` (helpers.mjs fakeOpa()) whose capabilities are CAPABILITIES.
const fakeOpa = (options = {}) => sharedFakeOpa({ capabilities: CAPABILITIES, ...options });

// Deckhand's allow.rego, as the image ships it.
const ALLOWING = Object.fromEntries(allowOnly());

// The policies over a policy service's engine (helpers.mjs policyEngineOf()) with `opa`, Deckhand's
// `builtIn` and the operator's `operator` (name → text, or `readOperator()`), and a fake GitHub
// with the repo's `repoFiles`.
function setup(
  t,
  {
    repoFiles = null,
    operator = {},
    readOperator = undefined,
    builtIn = ALLOWING,
    opa = fakeOpa(),
    secrets = [],
    status,
    now,
  } = {},
) {
  const gh = fakeGitHub(repoFiles, { status });
  const logs = [];
  const engine = policyEngineOf(t, {
    opa,
    operator,
    builtIn,
    ...(readOperator && { readOperator }),
  });
  const policies = createPolicies({
    config: {},
    github: gh.github,
    service: localService(engine),
    secrets: () => secrets,
    log: (line) => logs.push(line),
    ...(now ? { now } : {}),
  });
  return { policies, gh, opa, logs, engine };
}

const input = () => ({ decision: "merge", pr: { additions: 500 } });

test("restrictedCapabilities: no environment, network, files or trace, and no host", () => {
  const caps = restrictedCapabilities(JSON.stringify(CAPABILITIES));
  assert.deepEqual(
    caps.builtins.map((b) => b.name),
    ["count", "json.marshal", "time.now_ns"],
  );
  assert.deepEqual(caps.allow_net, []);
  assert.deepEqual(caps.features, ["rego_v1"]);
  assert.throws(() => restrictedCapabilities("{}"), /no builtins/);
});

test("rulesOf: the allow_* and deny_* rules of package deckhand", () => {
  assert.deepEqual(
    rulesOf(
      `${DENY}allow_merge if true\ndeny_review contains "x" if true\ndeny_merge contains "y" if true\n`,
    ),
    ["deny_merge", "allow_merge", "deny_review"],
  );
  assert.deepEqual(rulesOf('package lib\ndeny_merge contains "x" if true\n'), []);
});

test("namespaced: a repo file's package, and its data references, under REPO_NS", () => {
  assert.equal(
    namespaced("# a policy\n\npackage deckhand\n\nimport data.lib\nx if data.lib.y\n"),
    "# a policy\n\npackage deckhand_repository.deckhand\n\nimport data.deckhand_repository.lib\nx if data.deckhand_repository.lib.y\n",
  );
  assert.equal(namespaced("package lib.util\n"), "package deckhand_repository.lib.util\n");
  // Not in strings, raw strings or comments, nor after a dot or a word: those aren't references.
  const kept = [
    'deny_merge contains "no edits to data.json" if { f.path == "db/data.sql" }',
    'x := "an \\" escape, then data.y"',
    "w := `raw data.x`",
    "y if input.target.data.id",
    "z if metadata.k # see data.q",
  ].join("\n");
  assert.equal(
    namespaced(`package deckhand\n${kept}\n`),
    `package deckhand_repository.deckhand\n${kept}\n`,
  );
  assert.equal(
    namespaced('package a\nv := "s"; u := data.k\n'),
    'package deckhand_repository.a\nv := "s"; u := data.deckhand_repository.k\n',
  );
  // Nowhere else than first: refused rather than guessed.
  for (const odd of [
    "x := 1\npackage deckhand\n",
    "package\ndeckhand\n",
    "\uFEFFpackage a\n",
    "",
  ]) {
    assert.equal(namespaced(odd), null, JSON.stringify(odd));
  }
  // A template string's expressions aren't read: refused, at its line, rather than guessed.
  for (const text of [
    'package deckhand\n\nx := $"{data.lib.dir}/schema.sql"\n',
    "package deckhand\n\nx := $`{data.lib.dir}`\n",
    'package deckhand\n\ny := $"{"a"} data.z"\n',
  ]) {
    assert.equal(namespaced(text), null, text);
    assert.deepEqual(namespaceRefusal("t.rego", text), {
      row: 3,
      message:
        "t.rego: a repository's policies can't use template strings (`$\"…{…}\"`): use sprintf()",
    });
  }
  // But `$` in a string or a comment is no template.
  const priced = 'package deckhand\n\nx := "costs $\"5\"" # $"no"\ny := data.k\n';
  assert.equal(
    namespaced(priced),
    'package deckhand_repository.deckhand\n\nx := "costs $\"5\"" # $"no"\ny := data.deckhand_repository.k\n',
  );
  assert.equal(namespaceRefusal("p.rego", priced), null);
  assert.equal(REPO_NS, "deckhand_repository");
});

test("unallowed: what no allow rule matched, said from the input", () => {
  const github = { mode: "brainstorm", action: "comment", target: { kind: "other_issue" } };
  assert.equal(
    unallowed("github", github, "operator"),
    "no rule allows `comment` on `other_issue` for a `brainstorm` run",
  );
  assert.equal(
    unallowed("github", { mode: "plan", action: "read_checks" }, "repo"),
    "no rule of .deckhand/policy/ allows `read_checks` for a `plan` run",
  );
  assert.equal(unallowed("merge", {}, "operator"), "no rule allows the merge");
  assert.equal(unallowed("fix", { reason: "ci" }, "operator"), "no rule allows a fix run (`ci`)");
  assert.equal(
    unallowed("request_review", { mode: null }, "operator"),
    "no rule allows requesting reviewers for a run Deckhand no longer knows's pull request",
  );
  assert.equal(
    unallowed("run", { mode: "brainstorm", target: { kind: "pr" } }, "operator"),
    "no rule allows a `brainstorm` run on a pull request",
  );
  assert.equal(
    unallowed("run", { mode: "plan", target: { kind: "issue" } }, "repo"),
    "no rule of .deckhand/policy/ allows a `plan` run on an issue",
  );
  assert.deepEqual(RULES.slice(0, 4), ["allow_run", "deny_run", "allow_merge", "deny_merge"]);
  // And the capabilities' two, sets rather than a yes or no (capabilityRules()).
  assert.equal(RULES.length, 2 * DECISIONS.length + 2);
  assert.deepEqual(RULES.slice(-2), ["allow_capabilities", "deny_capabilities"]);
});

test("operatorPolicies: the grants folder's policy/*.rego, symlinks only inside it", (t) => {
  const grants = tempDir(t);
  assert.equal(operatorPolicies(grants).size, 0);
  mkdirSync(join(grants, "policy"));
  writeFileSync(join(grants, "policy", "size.rego"), DENY);
  writeFileSync(join(grants, "policy", "notes.md"), "not a policy");
  writeFileSync(join(grants, "shared.rego"), "package deckhand\n");
  symlinkSync(join(grants, "shared.rego"), join(grants, "policy", "shared.rego"));
  assert.deepEqual(
    [...operatorPolicies(grants)],
    [
      ["shared.rego", "package deckhand\n"],
      ["size.rego", DENY],
    ],
  );
  const outside = join(tempDir(t), "x.rego");
  writeFileSync(outside, "package deckhand\n");
  symlinkSync(outside, join(grants, "policy", "out.rego"));
  assert.throws(() => operatorPolicies(grants), /out\.rego leads outside/);
});

test("builtInPolicies: Deckhand's policy/*.rego, each in package deckhand; no folder, none", (t) => {
  const own = builtInPolicies();
  assert.ok(own.has("github.rego"));
  for (const [name, text] of own) {
    assert.match(name, /^(allow|github|review|run|gh-[a-z0-9-]+|mode-[a-z]+)\.rego$/, name);
    // A feature allowed everywhere (gh-checks.rego) ships its file for its docs and its name
    // alone: comments and the package, nothing else.
    const bare = text.replace(/^\s*#.*$/gm, "").trim() === "package deckhand";
    assert.ok(rulesOf(text).length || bare, `${name} defines a rule of package deckhand`);
  }
  // allow.rego allows each decision, whatever the input: the listener knows it without opa.
  // All but `run`, which run.rego allows where each mode makes sense.
  const allow = own.get(ALLOW);
  assert.deepEqual(
    rulesOf(allow),
    DECISIONS.filter((d) => d !== "run").map((d) => `allow_${d}`),
  );
  assert.deepEqual(rulesOf(own.get("run.rego")), ["allow_run"]);
  assert.deepEqual([...allowOnly()], [[ALLOW, allow]]);
  assert.equal(BUILT_IN_DIR, join(import.meta.dirname, "..", "policy/"));
  const dir = tempDir(t);
  writeFileSync(join(dir, "a.rego"), DENY);
  writeFileSync(join(dir, "notes.md"), "not a policy");
  assert.deepEqual([...builtInPolicies(dir)], [["a.rego", DENY]]);
  assert.equal(builtInPolicies(join(dir, "none")).size, 0);
});

test("deny: Deckhand's files under the operator's by name, the repo's a layer of its own", async (t) => {
  // Each layer denies with its files' names and texts (allow.rego left out).
  const opa = fakeOpa({
    answer: (files) =>
      evalResult(
        Object.keys(files)
          .filter((n) => n !== ALLOW)
          .map((n) => `${n}: ${files[n]}`),
      ),
  });
  const GH = 'package deckhand\ndeny_github contains "x" if true\n';
  const { policies } = setup(t, {
    opa,
    builtIn: { ...ALLOWING, "gh-a.rego": GH, "gh-b.rego": GH, "gh-c.rego": GH },
    operator: { "gh-b.rego": "operator b" },
    repoFiles: { "gh-c.rego": "package deckhand # repo c" },
  });
  const denied = await policies.deny("deny_github", "org/repo", "main", input);
  assert.deepEqual(denied.sort(), [
    'gh-a.rego: package deckhand deny_github contains "x" if true',
    "gh-b.rego: operator b",
    "gh-c.rego: package deckhand # repo c",
    'gh-c.rego: package deckhand deny_github contains "x" if true',
  ]);
  // One query of one opa server, each layer in a folder of its own, the repo's package moved
  // under its namespace: neither layer's files can define the other's rules.
  const [call, ...more] = opa.evals();
  assert.equal(more.length, 0);
  assert.deepEqual(
    Object.fromEntries(Object.entries(call.layers).map(([l, f]) => [l, Object.keys(f).sort()])),
    { operator: [ALLOW, "gh-a.rego", "gh-b.rego", "gh-c.rego"], repo: ["gh-c.rego"] },
  );
  assert.equal(call.written.repo["gh-c.rego"], "package deckhand_repository.deckhand # repo c");
  assert.equal(
    call.query,
    'result := {"operator": {"allow": [x | x := data.deckhand.allow_github], "deny": [x | x := data.deckhand.deny_github]}, "repo": {"deny": [x | x := data.deckhand_repository.deckhand.deny_github]}}',
  );
  // Deckhand's are read once by the service: they are its image's.
  let reads = 0;
  const counted = createPolicies({
    config: {},
    github: fakeGitHub().github,
    service: localService(
      policyEngineOf(t, {
        opa,
        readBuiltIn: () => (reads++, new Map([["gh-a.rego", GH]])),
      }),
    ),
  });
  await counted.deny("deny_github", "org/repo", "main", input);
  await counted.deny("deny_github", "org/repo", "main", input);
  assert.equal(reads, 1);
});

test("decide: an allow rule of each layer it needs, and no deny", async (t) => {
  // `operator` and `repo`: what each layer's allow rule says (null: none defines it).
  const decide = async ({ operator, repo, denies = [], custom = false, decision = "github" }) => {
    const opa = fakeOpa({
      answer: (files, doc) =>
        files["own.rego"] ? evalResult(denies, repo) : evalResult([], operator),
    });
    const { policies } = setup(t, {
      opa,
      builtIn: { "rules.rego": "package deckhand\n" },
      repoFiles: { "own.rego": "package deckhand\n" },
    });
    const doc = { mode: custom ? "plan" : "work", custom_mode: custom, action: "comment" };
    return (await policies.decide(`deny_${decision}`, "org/repo", "main", () => doc)).messages;
  };
  assert.deepEqual(await decide({ operator: true }), []);
  // No allow rule matched: refused, saying which layer's.
  assert.deepEqual(await decide({ operator: false }), [
    "no rule allows `comment` for a `work` run",
  ]);
  assert.deepEqual(await decide({ operator: null }), ["no rule allows `comment` for a `work` run"]);
  // A deny wins over an allow, and says why alone.
  assert.deepEqual(await decide({ operator: true, denies: ["not here"] }), ["not here"]);
  assert.deepEqual(await decide({ operator: false, denies: ["not here"] }), ["not here"]);
  // The repo's allow counts for its own modes only, which need the operator's too.
  assert.deepEqual(await decide({ operator: true, repo: false }), []);
  assert.deepEqual(await decide({ operator: true, repo: true, custom: true }), []);
  assert.deepEqual(await decide({ operator: true, repo: false, custom: true }), [
    "no rule of .deckhand/policy/ allows `comment` for a `plan` run",
  ]);
  assert.deepEqual(await decide({ operator: false, repo: true, custom: true }), [
    "no rule allows `comment` for a `plan` run",
  ]);
  // A merge is no mode of the repo's, whatever its input says.
  assert.deepEqual(await decide({ operator: true, custom: true, decision: "merge" }), []);
  // An allow rule that isn't true or false: a policy error.
  assert.deepEqual(await decide({ operator: "yes" }), [
    "policy error: `allow_github` must be true or false",
  ]);
});

test("decide: Deckhand's files alone, allowing and none defining the deny rule: no policy asked", async (t) => {
  const GH = 'package deckhand\n\ndeny_github contains "x" if true\n';
  const { policies, opa } = setup(t, {
    opa: fakeOpa({ answer: () => evalResult(["x"]) }),
    builtIn: { ...ALLOWING, "gh-a.rego": GH },
  });
  assert.deepEqual(await policies.decide("deny_merge", "org/repo", "main", input), {
    applied: false,
    messages: [],
  });
  assert.equal(opa.evals().length, 0);
  // The rule they define is asked.
  assert.deepEqual((await policies.decide("deny_github", "org/repo", "main", input)).messages, [
    "x",
  ]);
  // A file of the operator's or the repo's, even with Deckhand's name: asked.
  for (const more of [
    { operator: { "gh-a.rego": DENY } },
    { repoFiles: { "b.rego": "package deckhand\n" } },
  ]) {
    const other = setup(t, { builtIn: { ...ALLOWING, "gh-a.rego": GH }, ...more });
    assert.equal(
      (await other.policies.decide("deny_merge", "org/repo", "main", input)).applied,
      true,
    );
  }
  // Without Deckhand's allow.rego: asked, and refused when nothing allows.
  const bare = setup(t, { opa: fakeOpa({ answer: () => evalResult([], null) }), builtIn: {} });
  assert.deepEqual(await bare.policies.decide("deny_merge", "org/repo", "main", input), {
    applied: true,
    messages: ["no rule allows the merge"],
    input: { version: 1, ...input() },
    asked: true,
    layers: [
      {
        layer: "operator",
        allow: false,
        denies: [],
        error: null,
        allowFiles: [],
        denyFiles: [],
      },
    ],
  });
  // So is a run of the repo's own mode without a repo file: its allow is missing.
  const custom = () => ({ mode: "plan", custom_mode: true, action: "comment" });
  const plan = await policies.decide("deny_link_branch", "org/repo", "main", custom);
  assert.deepEqual(plan.messages, [
    "no rule of .deckhand/policy/ allows linking a branch for a `plan` run",
  ]);
  assert.equal(opa.evals().length, 1);
});

test("describe and the checks: Deckhand's files first, which the operator's replace; the repo's apart", async (t) => {
  const GH = 'package deckhand\ndeny_github contains "x" if true\n';
  const { policies, opa } = setup(t, {
    builtIn: { "gh-a.rego": GH, "gh-b.rego": GH, "gh-c.rego": GH },
    operator: { "gh-b.rego": "package deckhand\n", "gh-c.rego": "package deckhand\n" },
    repoFiles: { "gh-a.rego": "package deckhand\n", "gh-c.rego": "package deckhand\n" },
  });
  const described = await policies.describe("org/repo", "main");
  assert.deepEqual(
    described.files.map((f) => [f.source, f.name, f.replaces, f.active]),
    [
      ["deckhand", "gh-a.rego", null, true],
      ["deckhand", "gh-b.rego", null, false],
      ["deckhand", "gh-c.rego", null, false],
      ["operator", "gh-b.rego", "deckhand", true],
      ["operator", "gh-c.rego", "deckhand", true],
      ["repo", "gh-a.rego", null, true],
      ["repo", "gh-c.rego", null, true],
    ],
  );
  assert.deepEqual([...described.policies.operator.keys()].sort(), [
    "gh-a.rego",
    "gh-b.rego",
    "gh-c.rego",
  ]);
  assert.equal(described.policies.operator.get("gh-a.rego"), GH);
  assert.deepEqual([...described.policies.repo.keys()].sort(), ["gh-a.rego", "gh-c.rego"]);
  // A repo file named as one of the operator's layer replaces nothing any more: said.
  assert.deepEqual(
    described.warnings.map((w) => w.slice(0, w.indexOf(" "))),
    ["gh-a.rego", "gh-c.rego"],
  );
  assert.match(described.warnings[0], /doesn't replace the operator's or Deckhand's file/);
  // The start's check compiles Deckhand's files under the operator's, the onboarding's the
  // repo's alone, as each layer is evaluated.
  await policies.checkOperator();
  assert.deepEqual(Object.keys(opa.calls.at(-1).files).sort(), [
    "gh-a.rego",
    "gh-b.rego",
    "gh-c.rego",
  ]);
  assert.equal(opa.calls.at(-1).files["gh-a.rego"], GH);
  const repo = await policies.checkRepo("org/repo", "main");
  assert.deepEqual(Object.keys(opa.calls.at(-1).files).sort(), ["gh-a.rego", "gh-c.rego"]);
  assert.equal(opa.calls.at(-1).files["gh-a.rego"], "package deckhand\n");
  assert.equal(repo.warnings.length, 2);
});

test("deny: no policy anywhere, no opa call and no input built", async (t) => {
  const { policies, gh, opa } = setup(t);
  let built = 0;
  assert.deepEqual(await policies.deny("deny_merge", "org/repo", "main", () => built++), []);
  assert.equal(opa.calls.length, 0);
  assert.equal(built, 0);
  // The listing only.
  assert.deepEqual(gh.calls, ["/repos/org/repo/contents/.deckhand/policy?ref=main"]);
});

test("deny: the operator's and the repo's layers, each on its own, a deny of either refuses", async (t) => {
  const opa = fakeOpa({
    answer: (files) =>
      evalResult(
        Object.keys(files)
          .filter((n) => n !== ALLOW)
          .map((n) => `${n}: ${files[n]}`),
      ),
  });
  const { policies } = setup(t, {
    opa,
    operator: { "a.rego": "operator a", "b.rego": "operator b" },
    repoFiles: { "a.rego": "package repo_a", "c.rego": "package repo_c" },
  });
  const denied = await policies.deny("deny_merge", "org/repo", "main", input);
  assert.deepEqual(denied.sort(), [
    "a.rego: operator a",
    "a.rego: package repo_a",
    "b.rego: operator b",
    "c.rego: package repo_c",
  ]);
  // A repo file without a package where the parser reads it: refused, as one that doesn't
  // compile, never staged as it is.
  for (const text of ["repo a", "package\ndeckhand\n", "\uFEFFpackage deckhand\n"]) {
    const odd = setup(t, { opa, repoFiles: { "a.rego": text } });
    assert.deepEqual(await odd.policies.deny("deny_merge", "org/repo", "main", input), [
      "policy error: a.rego must start with `package …` (after comments only), on one line",
    ]);
    const { errors } = await odd.policies.describe("org/repo", "main");
    assert.deepEqual(
      errors.map((e) => [e.layer, e.file, e.row]),
      [["repo", "a.rego", 1]],
    );
  }
  // The operator's alone apply to a repo without policies.
  const bare = setup(t, { opa, operator: { "b.rego": "operator b" } });
  assert.deepEqual(await bare.policies.deny("deny_merge", "org/repo", "main", input), [
    "b.rego: operator b",
  ]);
});

test("deny: the rule's messages, its input, a set checked with restricted capabilities then served", async (t) => {
  const opa = fakeOpa({
    answer: (files, doc) => evalResult(doc.pr.additions > 400 ? ["too big"] : []),
  });
  const { policies, logs, engine } = setup(t, { opa, repoFiles: { "size.rego": DENY } });
  assert.deepEqual(await policies.deny("deny_merge", "org/repo", "main", input), ["too big"]);
  const [call] = opa.evals();
  assert.deepEqual(JSON.parse(call.input), { version: 1, ...input() });
  // The repo's layer: its deny rule, not its allow, a merge being no mode of its own. Deckhand's
  // allow.rego alone needs no asking, but is loaded beside it.
  assert.equal(
    call.query,
    'result := {"repo": {"deny": [x | x := data.deckhand_repository.deckhand.deny_merge]}}',
  );
  assert.equal(opa.evals().length, 1);
  // The set was checked with the restricted capabilities before its server started, the same
  // files staged for both.
  const [check, serve] = opa.calls.filter((c) => c.args[0] === "check" || c.args[0] === "serve");
  assert.deepEqual(check.args, [
    "check",
    "--format=json",
    "--capabilities=capabilities.json",
    "policy",
  ]);
  assert.equal(serve.args[0], "serve");
  assert.ok(!check.capabilities.builtins.some((b) => b.name === "http.send"));
  assert.deepEqual(serve.written, check.written);
  assert.deepEqual(Object.keys(serve.layers).sort(), ["operator", "repo"]);
  assert.match(logs.join("\n"), /merge refused: too big/);
  const small = () => ({ pr: { additions: 1 } });
  assert.deepEqual(await policies.deny("deny_merge", "org/repo", "main", small), []);
  // The same set: the same server, checked once; once per binary: its capabilities.
  assert.equal(opa.calls.filter((c) => c.args[0] === "check").length, 1);
  assert.equal(opa.calls.filter((c) => c.args[0] === "serve").length, 1);
  assert.equal(opa.calls.filter((c) => c.args[0] === "capabilities").length, 1);
  // Its staged files go with its server.
  await engine.stop();
  assert.throws(() => readdirSync(serve.cwd));
});

test("deny: messages capped, on one line and redacted", async (t) => {
  const secret = "s3cr3t-value-0123456789abcdef";
  const many = ["a\n  b", `the key is ${secret}`, "x".repeat(500), "4", "5", "6", "7"];
  const opa = fakeOpa({ answer: () => evalResult(many) });
  const { policies } = setup(t, { opa, repoFiles: { "p.rego": DENY }, secrets: [secret] });
  const denied = await policies.deny("deny_merge", "org/repo", "main", input);
  assert.equal(denied.length, 6);
  assert.equal(denied[0], "a b");
  assert.equal(denied[1], "the key is [redacted]");
  assert.equal(denied[2].length, MAX_MESSAGE_LENGTH);
  assert.equal(denied[5], "and 2 more");
});

test("deny: fail closed, each failure one policy error", async (t) => {
  const cases = [
    [
      {
        code: 1,
        stdout: JSON.stringify({
          errors: [
            {
              message: "rego_parse_error: unexpected }",
              location: { file: "/tmp/x/policy/a.rego", row: 3 },
            },
          ],
        }),
      },
      /^policy error: a\.rego:3: rego_parse_error: unexpected \}$/,
    ],
    [
      { code: -1, stdout: "", stderr: "", timedOut: true },
      /^policy error: the `merge` rules took more than 2 s$/,
    ],
    [
      {
        code: 1,
        stdout: JSON.stringify({
          errors: [
            {
              message: "numbers.range: timed out before generating all numbers in range",
              code: "eval_cancel_error",
            },
          ],
        }),
      },
      /^policy error: the `merge` rules took more than 2 s$/,
    ],
    // An error that only names a `timeout` isn't one.
    [
      {
        code: 1,
        stdout: JSON.stringify({
          errors: [{ message: "var timeout is unsafe", code: "rego_unsafe_var_error" }],
        }),
      },
      /^policy error: var timeout is unsafe$/,
    ],
    // An evaluation's error, which opa's server says in one message.
    [
      {
        code: 1,
        stdout: JSON.stringify({
          code: "internal_error",
          message:
            "a.rego:3: eval_conflict_error: complete rules must not produce multiple outputs",
        }),
      },
      /^policy error: a\.rego:3: eval_conflict_error: complete rules must not produce multiple outputs$/,
    ],
    [evalResult([1, "x"]), /^policy error: `deny_merge` must be a set of strings$/],
    [evalResult("x"), /must be a set of strings/],
    [{ code: 0, stdout: "not json" }, /^policy error: opa's answer can't be read$/],
    // Undefined: the query always has a value, its rules' lists.
    [{ code: 0, stdout: "{}" }, /^policy error: opa's answer can't be read$/],
  ];
  for (const [answer, expected] of cases) {
    const { policies } = setup(t, {
      opa: fakeOpa({ answer: () => answer }),
      repoFiles: { "a.rego": DENY },
    });
    const denied = await policies.deny("deny_merge", "org/repo", "main", input);
    assert.equal(denied.length, 1);
    assert.match(denied[0], expected);
  }
  // No file defines the deny rule: nothing denies.
  const none = setup(t, {
    opa: fakeOpa({ answer: () => evalResult(undefined) }),
    repoFiles: { "a.rego": DENY },
  });
  assert.deepEqual(await none.policies.deny("deny_merge", "org/repo", "main", input), []);
  // GitHub can't list them, an input that can't be built: refused too.
  const down = setup(t, { status: 500 });
  assert.match(
    (await down.policies.deny("deny_merge", "org/repo", "main", input))[0],
    /^policy error: the policies can't be read/,
  );
  const broken = setup(t, { repoFiles: { "a.rego": DENY } });
  const failing = async () => {
    throw new Error("GitHub GET x: 502");
  };
  assert.match(
    (await broken.policies.deny("deny_merge", "org/repo", "main", failing))[0],
    /input can't be built \(GitHub GET x: 502\)/,
  );
  // An error in either layer refuses, whatever the other says.
  const repoBroken = setup(t, {
    opa: fakeOpa({
      answer: (files) => (files["a.rego"] ? { code: 0, stdout: "not json" } : evalResult([])),
    }),
    operator: { "op.rego": DENY },
    repoFiles: { "a.rego": DENY },
  });
  assert.deepEqual(await repoBroken.policies.deny("deny_merge", "org/repo", "main", input), [
    "policy error: opa's answer can't be read",
  ]);
  // The operator's folder can't be read: refused, whatever the repo has.
  const { policies: operator } = setup(t, {
    readOperator: () => {
      throw new Error("policy/x.rego can't be read (EACCES)");
    },
  });
  assert.match((await operator.deny("deny_merge", "org/repo", "main", input))[0], /EACCES/);
  // GitHub's part is told apart (`unread`): a caller may ask again rather than keep the refusal.
  const unread = async (p, i) => (await p.decide("deny_merge", "org/repo", "main", i)).unread;
  assert.deepEqual(
    [await unread(down.policies, input), await unread(broken.policies, failing)],
    [true, true],
  );
  // So is an operator's folder that can't be read: no rule refused anything either.
  assert.equal(await unread(operator, input), true);
  // A rule's own failure isn't: opa answering nonsense is the policy's.
  const nonsense = setup(t, {
    opa: fakeOpa({ answer: () => ({ code: 0, stdout: "not json" }) }),
    repoFiles: { "a.rego": DENY },
  });
  assert.equal(await unread(nonsense.policies, input), undefined);
  // denyKept() keeps those for the task's page unless told not to; a rule's refusal always.
  const kept = [];
  const ask = (p, i, keepUnread) =>
    denyKept(p, "deny_fix", "org/repo", "main", i, {
      pr: { number: 5 },
      keep: (entry) => kept.push(entry),
      log: () => {},
      keepUnread,
    });
  assert.equal((await ask(down.policies, input, false)).unread, true);
  assert.equal((await ask(broken.policies, failing, false)).unread, true);
  assert.deepEqual(kept, []);
  assert.equal((await ask(down.policies, input, true)).unread, true);
  assert.deepEqual(
    [kept.length, kept[0].rule, kept[0].denied, kept[0].pr],
    [1, "deny_fix", true, 5],
  );
});

test("deny: failures are capped and redacted like messages", async (t) => {
  const secret = "s3cr3t-value-0123456789abcdef";
  const long = `rego_parse_error: ${secret} ${"y".repeat(400)}\nsecond line`;
  const opa = fakeOpa({ answer: () => ({ code: 1, stdout: "", stderr: long }) });
  const { policies } = setup(t, { opa, repoFiles: { "a.rego": DENY }, secrets: [secret] });
  const [denied] = await policies.deny("deny_merge", "org/repo", "main", input);
  assert.match(denied, /^policy error: rego_parse_error: \[redacted\] y+…$/);
  assert.equal(denied.length, MAX_MESSAGE_LENGTH);
  const check = await policies.check(new Map([["a.rego", DENY]]));
  assert.ok(check.errors.every((e) => e.length <= MAX_MESSAGE_LENGTH && !e.includes(secret)));
});

test("decide: an opa that can't start is no layer's error, a repo file without its package the repo's", async (t) => {
  const missing = {
    run: async () => ({ code: -1, stdout: "", stderr: "spawn opa ENOENT" }),
  };
  const { policies } = setup(t, {
    opa: missing,
    operator: { "op.rego": DENY },
    repoFiles: { "a.rego": DENY },
  });
  const said = await policies.decide("deny_merge", "org/repo", "main", input);
  assert.match(said.messages[0], /spawn opa ENOENT/);
  // Said on each layer it was asked about, not pinned on the repo's.
  assert.deepEqual(
    said.layers.map((l) => [l.layer, !!l.error]),
    [
      ["operator", true],
      ["repo", true],
    ],
  );
  const odd = setup(t, { operator: { "op.rego": DENY }, repoFiles: { "a.rego": "no package" } });
  const refused = await odd.policies.decide("deny_merge", "org/repo", "main", input);
  assert.deepEqual(
    refused.layers.map((l) => [l.layer, l.error]),
    [
      ["operator", null],
      [
        "repo",
        "policy error: a.rego must start with `package …` (after comments only), on one line",
      ],
    ],
  );
});

test("deny: a policy file is fetched once per blob, the listing once per push", async (t) => {
  let time = 1_000_000;
  const { policies, gh } = setup(t, { repoFiles: { "a.rego": DENY }, now: () => time });
  const listings = () => gh.calls.filter((p) => p.includes("/contents/")).length;
  await policies.deny("deny_merge", "org/repo", "main", input);
  await policies.deny("deny_merge", "org/repo", "main", input);
  assert.equal(gh.calls.filter((p) => p.includes("/git/blobs/")).length, 1);
  assert.equal(listings(), 1);
  // The default branch moved: listed again.
  policies.forget("Org/Repo");
  await policies.deny("deny_merge", "org/repo", "main", input);
  assert.equal(listings(), 2);
  // A push whose webhook never came: listed again after a while.
  time += 11 * 60_000;
  await policies.deny("deny_merge", "org/repo", "main", input);
  assert.equal(listings(), 3);
  // A branch's (the config check's) is never kept.
  await policies.checkRepo("org/repo", "main");
  await policies.checkRepo("org/repo", "main");
  assert.equal(listings(), 5);
});

test("deny: no policy anywhere, one listing until the default branch moves", async (t) => {
  const { policies, gh, opa } = setup(t);
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(await policies.deny("deny_merge", "org/repo", "main", input), []);
  }
  assert.equal(gh.calls.length, 1);
  assert.equal(opa.calls.length, 0);
});

test("check: a review.rego that replaces Deckhand's without a word on bots is warned of", async (t) => {
  const own = builtInPolicies().get("review.rego");
  const wip = 'package deckhand\ndeny_review contains "wip" if "wip" in input.pr.labels\n';
  const warned = async (operator, repoFiles = null) => {
    const { policies } = setup(t, { builtIn: { "review.rego": own }, operator, repoFiles });
    const operatorSide = (await policies.checkOperator()).warnings;
    const repoSide = repoFiles ? (await policies.checkRepo("org/repo", "main")).warnings : [];
    const described = (await policies.describe("org/repo", "main")).warnings;
    return [operatorSide.length, repoSide.length, described.length];
  };
  // Deckhand's alone, or replaced by a file that names author_type (a comment will do): nothing.
  assert.deepEqual(await warned({}), [0, 0, 0]);
  assert.deepEqual(
    await warned({ "review.rego": `${wip}# input.pr.author_type: bots too\n` }),
    [0, 0, 0],
  );
  // An operator's written before the default: said at start and on every Policies tab. A repo's
  // onboarding check doesn't repeat it, which the start said.
  const other = { "a.rego": 'package deckhand\ndeny_merge contains "x" if false\n' };
  assert.deepEqual(await warned({ "review.rego": wip }), [1, 0, 1]);
  assert.deepEqual(await warned({ "review.rego": wip }, other), [1, 0, 1]);
  const operator = setup(t, { builtIn: { "review.rego": own }, operator: { "review.rego": wip } });
  const start = (await operator.policies.checkOperator()).warnings[0];
  assert.match(
    start,
    /^The grants folder's policy\/review\.rego replaces Deckhand's default without a rule on `input\.pr\.author_type`: other bots' ready pull requests .* are reviewed by themselves in every repository\./,
  );
  assert.deepEqual((await operator.policies.describe("org/repo", "main")).warnings, [start]);
  // A repo's review.rego replaces nothing: it only adds refusals, so it is warned of as such.
  const repo = setup(t, { builtIn: { "review.rego": own }, repoFiles: { "review.rego": wip } });
  const [onboarding] = (await repo.policies.checkRepo("org/repo", "main")).warnings;
  assert.match(onboarding, /^review\.rego doesn't replace the operator's or Deckhand's file/);
  assert.deepEqual((await repo.policies.describe("org/repo", "main")).warnings, [onboarding]);
});

test("check: compile errors and rules nobody evaluates; nothing to check, no opa call", async (t) => {
  const opa = fakeOpa({
    checked: (files) =>
      files["bad.rego"]
        ? {
            code: 1,
            stdout: "",
            stderr: JSON.stringify({
              errors: [
                {
                  message: "undefined function http.send",
                  location: { file: "policy/bad.rego", row: 2 },
                },
              ],
            }),
          }
        : { code: 0, stdout: "" },
  });
  const { policies } = setup(t, { opa });
  assert.deepEqual(await policies.check(new Map()), { errors: [], warnings: [] });
  assert.equal(opa.calls.length, 0);
  const files = new Map([
    ["a.rego", `${DENY}deny_reveiw contains "x" if true\nallow_mrege if true\n`],
    ["bad.rego", "package deckhand\ndeny_merge contains x if { x := http.send({}) }\n"],
  ]);
  const rules =
    "`allow_run`, `deny_run`, `allow_merge`, `deny_merge`, `allow_review`, `deny_review`, `allow_fix`, `deny_fix`, `allow_link_branch`, `deny_link_branch`, `allow_request_review`, `deny_request_review`, `allow_github`, `deny_github`, `allow_capabilities`, `deny_capabilities`";
  assert.deepEqual(await policies.check(files), {
    errors: ["policy error: bad.rego:2: undefined function http.send"],
    warnings: [
      `a.rego: \`deny_reveiw\` isn't a rule Deckhand evaluates (${rules})`,
      `a.rego: \`allow_mrege\` isn't a rule Deckhand evaluates (${rules})`,
    ],
  });
  // A repo's allow rule for a decision only built-in modes make: an error at its line, ignored.
  const repo = new Map([
    ["own.rego", 'package deckhand\n\nallow_github if input.mode == "plan"\nallow_merge := true\n'],
  ]);
  assert.deepEqual(await policies.check(repo, "repo"), {
    errors: [
      "own.rego:4: `allow_merge` is ignored: a repository's allow rules count only for its own modes, and only the operator's allow the merge",
    ],
    warnings: [],
  });
  assert.deepEqual(await policies.check(repo), { errors: [], warnings: [] });
  const check = opa.calls.find((c) => c.args[0] === "check");
  assert.deepEqual(check.args, [
    "check",
    "--format=json",
    "--capabilities=capabilities.json",
    "policy",
  ]);
});

test("checkRepo: a branch's policies on their own; none on the branch, nothing", async (t) => {
  const opa = fakeOpa({
    checked: (files) => ({ code: files["op.rego"] || !files["a.rego"] ? 1 : 0, stdout: "" }),
  });
  const { policies } = setup(t, {
    opa,
    operator: { "op.rego": DENY },
    repoFiles: { "a.rego": DENY },
  });
  assert.deepEqual(await policies.checkRepo("org/repo", "main"), { errors: [], warnings: [] });
  const none = setup(t, { opa: fakeOpa(), operator: { "op.rego": DENY } });
  assert.deepEqual(await none.policies.checkRepo("org/repo", "main"), { errors: [], warnings: [] });
  assert.equal(none.opa.calls.length, 0);
});

test("decide: whether a policy was asked, with deny()'s messages", async (t) => {
  const none = setup(t);
  assert.deepEqual(await none.policies.decide("deny_merge", "org/repo", "main", input), {
    applied: false,
    messages: [],
  });
  const opa = fakeOpa({ answer: () => evalResult([]) });
  const { policies } = setup(t, { opa, repoFiles: { "a.rego": DENY } });
  // The input the rules saw, version included, and what each layer said, for the task's page.
  assert.deepEqual(await policies.decide("deny_merge", "org/repo", "main", input), {
    applied: true,
    asked: true,
    messages: [],
    input: { version: 1, ...(await input()) },
    layers: [
      {
        layer: "operator",
        allow: true,
        denies: [],
        error: null,
        allowFiles: [ALLOW],
        denyFiles: [],
      },
      {
        layer: "repo",
        allow: null,
        denies: [],
        error: null,
        allowFiles: [],
        denyFiles: ["a.rego"],
      },
    ],
  });
  // A folder GitHub can't list: applied, and refused (fail closed).
  const broken = setup(t, { status: 500 });
  const said = await broken.policies.decide("deny_merge", "org/repo", "main", input);
  assert.equal(said.applied, true);
  assert.match(said.messages[0], /^policy error: the policies can't be read/);
});

test("describe: a repo's allow rule for a built-in-only decision, an error flagged ignored", async (t) => {
  const { policies } = setup(t, {
    repoFiles: { "merge.rego": "package deckhand\n\nallow_merge := true\n" },
  });
  const { errors } = await policies.describe("org/repo", "main");
  assert.deepEqual(errors, [
    {
      layer: "repo",
      file: "merge.rego",
      row: 3,
      message:
        "`allow_merge` is ignored: a repository's allow rules count only for its own modes, and only the operator's allow the merge",
      text: "merge.rego:3: `allow_merge` is ignored: a repository's allow rules count only for its own modes, and only the operator's allow the merge",
      ignored: true,
    },
  ]);
  // The operator's own allow_merge is its ceiling, not ignored.
  const operator = setup(t, {
    operator: { "merge.rego": "package deckhand\n\nallow_merge := true\n" },
  });
  assert.deepEqual((await operator.policies.describe("org/repo", "main")).errors, []);
});

test("describe: each file with its source and rules, the check of them all", async (t) => {
  const opa = fakeOpa({
    checked: (files) =>
      files["bad.rego"]
        ? {
            code: 1,
            stdout: "",
            stderr: JSON.stringify({
              errors: [
                { message: "unexpected eof", location: { file: "policy/bad.rego", row: 3 } },
              ],
            }),
          }
        : { code: 0, stdout: "" },
  });
  const { policies } = setup(t, {
    opa,
    operator: { "a.rego": DENY, "b.rego": 'package deckhand\ndeny_review contains "x" if true\n' },
    repoFiles: {
      "a.rego": "# drops it\npackage deckhand\n",
      "bad.rego": `${DENY}deny_merged contains "y" if true\n`,
    },
  });
  const described = await policies.describe("org/repo", "main");
  const file = (name, source, replaces, active, rules, text) => ({
    name,
    source,
    replaces,
    active,
    url: null,
    rules,
    text,
    truncated: false,
  });
  assert.deepEqual(described.files, [
    file(
      ALLOW,
      "deckhand",
      null,
      true,
      DECISIONS.filter((d) => d !== "run").map((d) => `allow_${d}`),
      ALLOWING[ALLOW],
    ),
    // The operator's a.rego, evaluated beside the repo's of the same name.
    file("a.rego", "operator", null, true, ["deny_merge"], DENY),
    file(
      "b.rego",
      "operator",
      null,
      true,
      ["deny_review"],
      'package deckhand\ndeny_review contains "x" if true\n',
    ),
    file("a.rego", "repo", null, true, [], "# drops it\npackage deckhand\n"),
    file(
      "bad.rego",
      "repo",
      null,
      true,
      ["deny_merge", "deny_merged"],
      `${DENY}deny_merged contains "y" if true\n`,
    ),
  ]);
  // Each layer checked on its own: the error is the repo's.
  assert.deepEqual(described.errors, [
    {
      layer: "repo",
      file: "bad.rego",
      row: 3,
      message: "unexpected eof",
      text: "policy error: bad.rego:3: unexpected eof",
    },
  ]);
  assert.equal(described.warnings.length, 2);
  assert.match(described.warnings[0], /^bad.rego: `deny_merged` isn't a rule/);
  assert.match(described.warnings[1], /^a.rego doesn't replace the operator's/);
  // What decide() would evaluate, and the checks compiled: each layer's files.
  assert.equal(described.policies.operator.get("a.rego"), DENY);
  assert.equal(described.policies.repo.get("a.rego"), "# drops it\npackage deckhand\n");
  assert.deepEqual([described.policies.operator.size, described.policies.repo.size], [3, 2]);
  const checks = opa.calls.filter((c) => c.args[0] === "check");
  assert.deepEqual(checks.map((c) => Object.keys(c.files).sort()).sort(), [
    ["a.rego", ALLOW, "b.rego"],
    ["a.rego", "bad.rego"],
  ]);
});

test("describe: each error of opa check at its file and row (a recorded output)", async (t) => {
  const recorded = readFileSync(new URL("fixtures/opa-check-errors.json", import.meta.url), "utf8");
  const { policies } = setup(t, {
    opa: { run: opaRunner(FAKE) },
    builtIn: {},
    repoFiles: { "net.rego": NET, "size.rego": SIZE },
  });
  const described = await policies.describe("org/repo", "main");
  assert.deepEqual(described.errors, [
    {
      layer: "repo",
      file: "net.rego",
      row: 3,
      message: "undefined function http.send",
      text: "policy error: net.rego:3: undefined function http.send",
    },
    {
      layer: "repo",
      file: "size.rego",
      row: 4,
      message: "count: arity mismatch",
      text: "policy error: size.rego:4: count: arity mismatch",
    },
  ]);
  assert.equal(JSON.parse(recorded).errors.length, 2);
  // check() says the same, one line each.
  assert.deepEqual(await policies.check(described.policies.repo, "repo"), {
    errors: described.errors.map((e) => e.text),
    warnings: [],
  });
});

test("describe: errors without a place, file and row null", async (t) => {
  const slow = setup(t, {
    opa: fakeOpa({ checked: () => ({ code: -1, stdout: "", timedOut: true }) }),
    repoFiles: { "a.rego": DENY },
  });
  const text = "the policies' check took too long";
  // Each layer's check timed out.
  assert.deepEqual((await slow.policies.describe("org/repo", "main")).errors, [
    { layer: "operator", file: null, row: null, message: text, text },
    { layer: "repo", file: null, row: null, message: text, text },
  ]);
  const plain = setup(t, {
    opa: fakeOpa({ checked: () => ({ code: 2, stdout: "", stderr: "opa: no such flag\nusage" }) }),
    repoFiles: { "a.rego": DENY },
  });
  const flag = { file: null, row: null, message: "opa: no such flag" };
  assert.deepEqual((await plain.policies.describe("org/repo", "main")).errors, [
    { layer: "operator", ...flag, text: "policy error: opa: no such flag" },
    { layer: "repo", ...flag, text: "policy error: opa: no such flag" },
  ]);
});

test("describe: each file's text, redacted and cut at MAX_TEXT", async (t) => {
  const secret = "s3cr3t-value-0123456789abcdef";
  const long = `${DENY}# ${"x".repeat(MAX_TEXT)}\n`;
  const { policies } = setup(t, {
    operator: { "op.rego": `${DENY}# ${secret}\n` },
    repoFiles: { "long.rego": long },
    secrets: [secret],
  });
  const [, op, own] = (await policies.describe("org/repo", "main")).files;
  assert.equal(op.text, `${DENY}# [redacted]\n`);
  assert.equal(op.truncated, false);
  assert.equal(own.text, long.slice(0, MAX_TEXT));
  assert.equal(own.truncated, true);
});

test("describe: no policy anywhere, no opa call; an operator folder that can't be read, said", async (t) => {
  const { policies, opa } = setup(t, { builtIn: {} });
  const described = await policies.describe("org/repo", "main");
  assert.deepEqual(described.files, []);
  assert.deepEqual(described.errors, []);
  assert.equal(opa.calls.length, 0);
  const { policies: broken } = setup(t, {
    builtIn: {},
    readOperator: () => {
      throw new Error("policy/x.rego leads outside the grants folder");
    },
  });
  const text =
    "the operator's policies can't be read: policy/x.rego leads outside the grants folder";
  assert.deepEqual((await broken.describe("org/repo", "main")).errors, [
    { layer: null, file: null, row: null, message: text, text },
  ]);
  // A policy service that can't be reached: said, the repo's files listed alone.
  const away = createPolicies({
    config: {},
    github: fakeGitHub({ "a.rego": DENY }).github,
    service: {
      policies: async () => {
        throw new Error("the policy service can't be reached (ECONNREFUSED, for 30 s)");
      },
      compile: async () => {
        throw new Error("the policy service can't be reached (ECONNREFUSED, for 30 s)");
      },
    },
  });
  const unreachable = await away.describe("org/repo", "main");
  assert.deepEqual(
    unreachable.files.map((f) => [f.source, f.name]),
    [["repo", "a.rego"]],
  );
  assert.deepEqual(
    unreachable.errors.map((e) => e.text),
    [
      "the policy service can't be reached (ECONNREFUSED, for 30 s)",
      "policy error: the policy service can't be reached (ECONNREFUSED, for 30 s)",
    ],
  );
});

test("mergeInput: what deny_merge reads", () => {
  const doc = mergeInput({
    info: { full_name: "org/repo", private: true, default_branch: "main" },
    pr: {
      number: 5,
      title: "Add a thing",
      user: { login: "Deckhand-App[bot]", type: "Bot" },
      labels: [{ name: "bug" }],
      base: { ref: "main" },
      head: { ref: "issue-12-thing", sha: "sha-1" },
      draft: false,
      additions: 10,
      deletions: 2,
      changed_files: 1,
    },
    files: [{ filename: "src/a.mjs", status: "modified", additions: 10, deletions: 2 }],
    issue: { number: 12, title: "A thing", labels: [{ name: "idea" }] },
    review: {
      verdict: "comment",
      rating: 8,
      allowed: "medium",
      summary: "left out",
      findings: [{ severity: "medium", path: "src/a.mjs", line: 3, text: "a test" }],
    },
    fixes: 2,
    runs: [{ name: "CI", status: "completed", conclusion: "success", id: 1 }],
    bot: "deckhand-app[bot]",
    now: () => Date.parse("2026-10-26T10:00:00Z"),
  });
  assert.deepEqual(doc, {
    decision: "merge",
    time: "2026-10-26T10:00:00.000Z",
    repo: { name: "org/repo", private: true, default_branch: "main" },
    pr: {
      number: 5,
      author: "Deckhand-App[bot]",
      author_type: "Bot",
      deckhand: true,
      title: "Add a thing",
      labels: ["bug"],
      base: "main",
      head: "issue-12-thing",
      head_sha: "sha-1",
      draft: false,
      additions: 10,
      deletions: 2,
      changed_files: 1,
      files: [
        { path: "src/a.mjs", previous_path: null, status: "modified", additions: 10, deletions: 2 },
      ],
    },
    issue: { number: 12, title: "A thing", labels: ["idea"] },
    review: {
      verdict: "comment",
      rating: 8,
      allowed: "medium",
      findings: [{ severity: "medium", path: "src/a.mjs", line: 3, text: "a test" }],
    },
    fixed: true,
    fixes: 2,
    checks: [{ name: "CI", status: "completed", conclusion: "success" }],
  });
});

test("pullInput: the author's type, and whether the pull request is Deckhand's own", () => {
  const pr = (login, type) => ({ number: 5, user: { login, type } });
  const author = (p, bot = "deckhand-app[bot]") => {
    const { author_type, deckhand } = pullInput({
      decision: "review",
      info: {},
      pr: p,
      files: [],
      bot,
    }).pr;
    return [author_type, deckhand];
  };
  assert.deepEqual(author(pr("dependabot[bot]", "Bot")), ["Bot", false]);
  assert.deepEqual(author(pr("alice", "User")), ["User", false]);
  assert.deepEqual(author(pr("deckhand-app[bot]", "Bot")), ["Bot", true]);
  // Without the App's login, nothing is Deckhand's own.
  assert.deepEqual(author(pr("deckhand-app[bot]", "Bot"), null), ["Bot", false]);
  assert.deepEqual(author({ number: 5 }), [null, false]);
});

const FAKE = new URL("fixtures/fake-opa.sh", import.meta.url).pathname;

test("opaRunner: an empty environment, the input on stdin, killed at its timeout", async (t) => {
  process.env.DECKHAND_POLICY_TEST = "leaked";
  t.after(() => delete process.env.DECKHAND_POLICY_TEST);
  const run = opaRunner(FAKE);
  const env = await run(["env"]);
  assert.equal(env.code, 0);
  assert.doesNotMatch(env.stdout, /DECKHAND_POLICY_TEST|HOME=/);
  const cwd = tempDir(t);
  const echo = await run(["echo", "a"], { input: '{"x":1}', cwd });
  assert.equal(echo.stdout, `echo a\n${cwd}\n{"x":1}`);
  const start = Date.now();
  const slow = await run(["sleep"], { timeoutMs: 200 });
  assert.equal(slow.timedOut, true);
  assert.ok(Date.now() - start < 5000);
  assert.deepEqual(await run(["fail"]), {
    code: 2,
    stdout: "",
    stderr: "broken\n",
    timedOut: false,
  });
  const missing = await opaRunner(join(cwd, "nothing"))(["eval"]);
  assert.equal(missing.code, -1);
  assert.match(missing.stderr, /ENOENT/);
});

// With the real binary on the PATH (hasOpa): the policy as written.

// The policies through the policy service itself, over HTTP, as the listener calls it: its
// engine with the real opa and the operator's `operator` files (name → text) over Deckhand's
// allow.rego, each call with a service token the broker's key signed, checked offline with its
// public key. `repo`: the repo's files.
async function overHttp(t, { operator = {}, repo = null } = {}) {
  const key = signingKey(tempDir(t));
  const keysDir = tempDir(t);
  publishKey(keysDir, key);
  const url = await servePolicies(t, {
    keysDir,
    engine: policyEngineOf(t, { opa: opaBinary(), operator }),
  });
  const tokens = serviceTokens({
    audiences: ["policy"],
    request: async (audiences) => issueServiceTokens("orchestrator", audiences, key),
  });
  return createPolicies({
    config: {},
    github: fakeGitHub(repo).github,
    service: policyClient({ url, header: () => tokens.header("policy") }),
  });
}

test(
  "the real opa, through the policy service: a denial, no environment, network or files, a compile error",
  { skip: !hasOpa() && "no opa on the PATH" },
  async (t) => {
    const sized = await overHttp(t, { operator: { "size.rego": DENY } });
    assert.deepEqual(await sized.deny("deny_merge", "org/repo", "main", input), ["too big"]);
    const tiny = () => ({ pr: { additions: 1 } });
    assert.deepEqual(await sized.deny("deny_merge", "org/repo", "main", tiny), []);
    const net = "package deckhand\ndeny_merge contains x if { x := opa.runtime().env.HOME }\n";
    const runtime = await overHttp(t, { operator: { "n.rego": net } });
    assert.match(
      (await runtime.deny("deny_merge", "org/repo", "main", input))[0],
      /^policy error: n\.rego:2: undefined function opa\.runtime/,
    );
    assert.match(
      (await runtime.check(new Map([["n.rego", net]]))).errors[0],
      /undefined function opa\.runtime/,
    );
    // Nothing that reads the environment, the network or the service's files compiles: refused
    // when the set is loaded, the operator's or a repo's, before any opa serves it.
    for (const call of [
      "opa.runtime().env.HOME",
      'http.send({"method": "get", "url": "https://example.com"}).body',
      'net.lookup_ip_addr("example.com")',
      'json.match_schema({}, {"$ref": "file:///etc/hostname"})',
      'json.verify_schema({"$ref": "file:///etc/hostname"})',
      'trace("x")',
    ]) {
      const name = call.slice(0, call.indexOf("("));
      const file = `package deckhand\ndeny_merge contains sprintf("%v", [x]) if { x := ${call} }\n`;
      const expected = new RegExp(`undefined function ${name.replace(/\./g, "\\.")}`);
      for (const layers of [{ operator: { "x.rego": file } }, { repo: { "x.rego": file } }]) {
        const policies = await overHttp(t, layers);
        const [denied] = await policies.deny("deny_merge", "org/repo", "main", input);
        assert.match(denied, /^policy error: /, name);
        assert.match(denied, expected, name);
      }
    }
  },
);

// The two layers with the real opa: `operator` and `repo`, name → text, over Deckhand's files
// (`builtIn`: its allow.rego by default).
function layered(t, { operator = {}, repo = null, builtIn = ALLOWING } = {}) {
  return setup(t, { opa: opaBinary(), operator, repoFiles: repo, builtIn });
}

// A write by a run in `mode` (one of the repo's own when `custom`), as deny_github reads it.
const write =
  (mode, custom = false) =>
  () => ({
    repo: "org/repo",
    mode,
    custom_mode: custom,
    light: false,
    reason: null,
    issue: 1,
    action: "comment",
    actions: ["comment"],
    target: { kind: "own_pr", number: 7, labels: [], author: "a" },
    change: { fields: ["body"], labels_added: [], labels_removed: [] },
  });

test(
  "the real opa: no allow rule refuses, a deny wins over an allow, a policy error refuses",
  { skip: !hasOpa() && "no opa on the PATH" },
  async (t) => {
    // Deckhand's allow.rego replaced by the operator's, which allows small merges only.
    const small = layered(t, {
      operator: {
        [ALLOW]: "package deckhand\n\nallow_merge if input.pr.additions < 100\n",
      },
    });
    assert.deepEqual(await small.policies.deny("deny_merge", "org/repo", "main", input), [
      "no rule allows the merge",
    ]);
    const tiny = () => ({ decision: "merge", pr: { additions: 1 } });
    assert.deepEqual(await small.policies.deny("deny_merge", "org/repo", "main", tiny), []);
    // No allow rule at all: everything refused, the GitHub writes too.
    const none = layered(t, { builtIn: {} });
    assert.deepEqual(await none.policies.deny("deny_github", "org/repo", "main", write("work")), [
      "no rule allows `comment` on `own_pr` for a `work` run",
    ]);
    // A deny wins over an allow, the operator's or the repo's.
    const denied = layered(t, { operator: { "size.rego": DENY } });
    assert.deepEqual(await denied.policies.deny("deny_merge", "org/repo", "main", input), [
      "too big",
    ]);
    const repoDenied = layered(t, { repo: { "size.rego": DENY } });
    assert.deepEqual(await repoDenied.policies.deny("deny_merge", "org/repo", "main", input), [
      "too big",
    ]);
    // A policy error refuses: an allow rule that isn't a boolean, a repo file that doesn't
    // compile, whatever the other layer says.
    const odd = layered(t, { operator: { [ALLOW]: 'package deckhand\n\nallow_merge := "yes"\n' } });
    assert.deepEqual(await odd.policies.deny("deny_merge", "org/repo", "main", tiny), [
      "policy error: `allow_merge` must be true or false",
    ]);
    const broken = layered(t, {
      repo: { "bad.rego": "package deckhand\n\ndeny_merge contains\n" },
    });
    const [error] = await broken.policies.deny("deny_merge", "org/repo", "main", tiny);
    assert.match(error, /^policy error: bad\.rego:4: unexpected eof token/);
  },
);

test(
  "the real opa: a repo's allow is ignored for a built-in mode; its own modes need both layers' allows",
  { skip: !hasOpa() && "no opa on the PATH" },
  async (t) => {
    // The operator's ceiling: no work run comments, every other run may.
    const ceiling = {
      [ALLOW]: 'package deckhand\n\nallow_github if input.mode != "work"\n',
    };
    // The repo allows everything, its plan mode included, and denies its deploy mode.
    const repo = {
      "modes.rego": `package deckhand

allow_github := true

deny_github contains "deploy runs don't comment" if input.mode == "deploy"
`,
    };
    const { policies } = layered(t, { operator: ceiling, repo });
    const ask = (mode, custom) =>
      policies.deny("deny_github", "org/repo", "main", write(mode, custom));
    // A built-in mode: the repo's allow isn't asked, the operator's refuses.
    assert.deepEqual(await ask("work", false), [
      "no rule allows `comment` on `own_pr` for a `work` run",
    ]);
    assert.deepEqual(await ask("brainstorm", false), []);
    // The repo's own modes: both allows, and no deny.
    assert.deepEqual(await ask("plan", true), []);
    assert.deepEqual(await ask("deploy", true), ["deploy runs don't comment"]);
    // Without the repo's allow, refused; without the operator's, too.
    const quiet = layered(t, { operator: ceiling, repo: { "modes.rego": "package deckhand\n" } });
    assert.deepEqual(
      await quiet.policies.deny("deny_github", "org/repo", "main", write("plan", true)),
      ["no rule of .deckhand/policy/ allows `comment` on `own_pr` for a `plan` run"],
    );
    const closed = layered(t, {
      operator: { [ALLOW]: "package deckhand\n\nallow_github if not input.custom_mode\n" },
      repo,
    });
    assert.deepEqual(
      await closed.policies.deny("deny_github", "org/repo", "main", write("plan", true)),
      ["no rule allows `comment` on `own_pr` for a `plan` run"],
    );
    // A repo can't reach the operator's rules: in the opa both layers share, its packages are
    // moved under deckhand_repository (namespaced()), so a library of the operator's package or
    // a helper of the same name changes nothing there.
    const sneaky = layered(t, {
      operator: {
        [ALLOW]: "package deckhand\n\nallow_github if data.lib.trusted\n",
        "lib.rego": 'package lib\n\ntrusted if input.mode == "brainstorm"\n',
      },
      repo: {
        "lib.rego": "package lib\n\ntrusted := true\n",
        // Its own library, where its own data.lib is.
        "own.rego": "package deckhand\n\nimport data.lib\n\nallow_github if lib.trusted\n",
        // A package naming the operator's, or the namespace itself, stays under it.
        "deckhand.rego": "# Not the operator's.\npackage deckhand.x\n\ny := 1\n",
        "ns.rego": "package deckhand_repository.deckhand\n\nallow_github := true\n",
      },
    });
    assert.deepEqual(await sneaky.policies.deny("deny_github", "org/repo", "main", write("work")), [
      "no rule allows `comment` on `own_pr` for a `work` run",
    ]);
    assert.deepEqual(
      await sneaky.policies.deny("deny_github", "org/repo", "main", write("brainstorm")),
      [],
    );
    // Its own mode: both layers in one opa, the repo's allow read from its own library.
    assert.deepEqual(
      await sneaky.policies.deny("deny_github", "org/repo", "main", write("plan", true)),
      ["no rule allows `comment` on `own_pr` for a `plan` run"],
    );
    const ownLib = layered(t, {
      repo: {
        "lib.rego": "package lib\n\ntrusted := true\n",
        "own.rego": "package deckhand\n\nimport data.lib\n\nallow_github if lib.trusted\n",
      },
    });
    assert.deepEqual(
      await ownLib.policies.deny("deny_github", "org/repo", "main", write("plan", true)),
      [],
    );
    // A repo's rule on a path holding `data.` still matches: its strings aren't rewritten.
    const dataSql = layered(t, {
      repo: {
        "data.rego":
          'package deckhand\n\ndeny_merge contains "db/data.sql waits for a human" if {\n  some f in input.pr.files\n  f.path == "db/data.sql"\n}\n',
      },
    });
    const migration = () => ({ decision: "merge", pr: { files: [{ path: "db/data.sql" }] } });
    assert.deepEqual(await dataSql.policies.deny("deny_merge", "org/repo", "main", migration), [
      "db/data.sql waits for a human",
    ]);
    // A template string reading its own library: refused (fail closed), at the check and at
    // each decision; the same rule with sprintf() refuses the merge.
    const lib = 'package lib\n\ndir := "db"\n';
    const rule = (path) =>
      `package deckhand\n\ndeny_merge contains "the schema waits for a human" if {\n  some f in input.pr.files\n  f.path == ${path}\n}\n`;
    const schema = () => ({ decision: "merge", pr: { files: [{ path: "db/schema.sql" }] } });
    const templated = layered(t, {
      repo: { "lib.rego": lib, "schema.rego": rule('$"{data.lib.dir}/schema.sql"') },
    });
    assert.deepEqual(await templated.policies.deny("deny_merge", "org/repo", "main", schema), [
      "policy error: schema.rego: a repository's policies can't use template strings (`$\"…{…}\"`): use sprintf()",
    ]);
    assert.deepEqual(
      (await templated.policies.describe("org/repo", "main")).errors.map((e) => [
        e.layer,
        e.file,
        e.row,
      ]),
      [["repo", "schema.rego", 5]],
    );
    const formatted = layered(t, {
      repo: { "lib.rego": lib, "schema.rego": rule('sprintf("%s/schema.sql", [data.lib.dir])') },
    });
    assert.deepEqual(await formatted.policies.deny("deny_merge", "org/repo", "main", schema), [
      "the schema waits for a human",
    ]);
    // Its compile error is placed in its file, without the namespace.
    const bad = layered(t, {
      repo: { "x.rego": "package deckhand\n\nallow_github if data.nope.z(1)\n" },
    });
    const [error] = await bad.policies.deny("deny_github", "org/repo", "main", write("plan", true));
    assert.match(error, /^policy error: x\.rego:3: /);
    assert.doesNotMatch(error, /deckhand_repository/);
    // A repo's allow rule for a built-in-only decision: a config check error.
    const merging = layered(t, {
      repo: { "merge.rego": "package deckhand\n\nallow_merge := true\n" },
    });
    assert.deepEqual(await merging.policies.checkRepo("org/repo", "main"), {
      errors: [
        "merge.rego:3: `allow_merge` is ignored: a repository's allow rules count only for its own modes, and only the operator's allow the merge",
      ],
      warnings: [],
    });
  },
);

test(
  "the real opa: Deckhand's defaults allow each decision, and compile",
  { skip: !hasOpa() && "no opa on the PATH" },
  async (t) => {
    const { policies } = layered(t, { builtIn: Object.fromEntries(builtInPolicies()) });
    assert.deepEqual(await policies.checkOperator(), { errors: [], warnings: [] });
    for (const decision of DECISIONS) {
      const { layers } = await policies.evaluated(
        decision,
        "org/repo",
        {
          operator: builtInPolicies(),
          repo: new Map(),
        },
        write("work"),
      );
      assert.equal(layers[0].allow, true, decision);
    }
  },
);

test(
  "the real opa: the operator's file replaces Deckhand's of its name, a slow policy times out",
  { skip: !hasOpa() && "no opa on the PATH" },
  async (t) => {
    // Deckhand's size.rego denies; the operator's, only `package deckhand`, drops it.
    const merged = layered(t, {
      builtIn: { ...ALLOWING, "size.rego": DENY },
      operator: { "size.rego": "package deckhand\n" },
    });
    assert.deepEqual(await merged.policies.deny("deny_merge", "org/repo", "main", input), []);
    // The repo's of that name replaces nothing.
    const kept = layered(t, {
      builtIn: { ...ALLOWING, "size.rego": DENY },
      repo: { "size.rego": "package deckhand\n" },
    });
    assert.deepEqual(await kept.policies.deny("deny_merge", "org/repo", "main", input), [
      "too big",
    ]);
    // A query past TIMEOUT_MS is cut, which cancels it in opa: the decision is refused, saying
    // so, and the same server answers the next one.
    const slow = layered(t, {
      repo: {
        "slow.rego":
          'package deckhand\ndeny_merge contains "x" if {\n  input.slow\n  count([n | some n in numbers.range(1, 100000000); n % 7 == 0]) > 0\n}\n',
      },
    });
    // Its set started first, so that what is timed is the decision alone.
    assert.deepEqual(await slow.policies.deny("deny_merge", "org/repo", "main", input), []);
    const start = Date.now();
    assert.deepEqual(
      await slow.policies.deny("deny_merge", "org/repo", "main", () => ({ slow: true })),
      ["policy error: the `merge` rules took more than 2 s"],
    );
    assert.ok(Date.now() - start < TIMEOUT_MS + 1000);
    assert.deepEqual(await slow.policies.deny("deny_merge", "org/repo", "main", input), []);
    assert.equal(slow.engine.servers(), 1);
  },
);
