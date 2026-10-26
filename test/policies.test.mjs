import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  createPolicies,
  deniesOf,
  MAX_MESSAGE_LENGTH,
  opaRunner,
  operatorPolicies,
  restrictedCapabilities,
} from "../listener/policies.mjs";
import { mergeInput } from "../listener/reviews.mjs";
import { tempDir } from "./helpers.mjs";

const CAPABILITIES = {
  builtins: [
    { name: "count" },
    { name: "http.send" },
    { name: "net.cidr_contains" },
    { name: "net.lookup_ip_addr" },
    { name: "opa.runtime" },
    { name: "trace" },
    { name: "time.now_ns" },
  ],
  features: ["rego_v1"],
};

const DENY = 'package deckhand\n\ndeny_merge contains "too big" if input.pr.additions > 400\n';

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

// A fake `opa`: `eval` answers `answer(files, input)` → { code, stdout, … } (files: the staged
// policies, name → text), `check` likewise with `checked(files)`.
function fakeOpa({
  answer = () => evalResult([]),
  checked = () => ({ code: 0, stdout: "" }),
} = {}) {
  const calls = [];
  const staged = (cwd) =>
    Object.fromEntries(
      readdirSync(join(cwd, "policy")).map((n) => [
        n,
        readFileSync(join(cwd, "policy", n), "utf8"),
      ]),
    );
  const run = async (args, { input, cwd } = {}) => {
    calls.push({ args, input, cwd });
    if (args[0] === "capabilities") return { code: 0, stdout: JSON.stringify(CAPABILITIES) };
    const caps = JSON.parse(readFileSync(join(cwd, "capabilities.json"), "utf8"));
    calls.at(-1).capabilities = caps;
    if (args[0] === "eval") return answer(staged(cwd), JSON.parse(input));
    return checked(staged(cwd));
  };
  return { run, calls, evals: () => calls.filter((c) => c.args[0] === "eval") };
}

const evalResult = (value) => ({
  code: 0,
  stdout: JSON.stringify({
    result: [{ expressions: [{ value, text: "data.deckhand.deny_merge" }] }],
  }),
});

function setup(t, { repoFiles = null, operator = {}, opa = fakeOpa(), secrets = [], status } = {}) {
  const gh = fakeGitHub(repoFiles, { status });
  const logs = [];
  const policies = createPolicies({
    config: {},
    github: gh.github,
    run: opa.run,
    secrets: () => secrets,
    readOperator: () => new Map(Object.entries(operator)),
    tmp: tempDir(t),
    log: (line) => logs.push(line),
  });
  return { policies, gh, opa, logs };
}

const input = () => ({ decision: "merge", pr: { additions: 500 } });

test("restrictedCapabilities: no environment, network or trace, and no host", () => {
  const caps = restrictedCapabilities(JSON.stringify(CAPABILITIES));
  assert.deepEqual(
    caps.builtins.map((b) => b.name),
    ["count", "time.now_ns"],
  );
  assert.deepEqual(caps.allow_net, []);
  assert.deepEqual(caps.features, ["rego_v1"]);
  assert.throws(() => restrictedCapabilities("{}"), /no builtins/);
});

test("deniesOf: the deny_* rules of package deckhand", () => {
  assert.deepEqual(
    deniesOf(`${DENY}deny_review contains "x" if true\ndeny_merge contains "y" if true\n`),
    ["deny_merge", "deny_review"],
  );
  assert.deepEqual(deniesOf('package lib\ndeny_merge contains "x" if true\n'), []);
});

test("operatorPolicies: the grants folder's policy/*.rego, symlinks only inside it", (t) => {
  const grants = tempDir(t);
  assert.equal(operatorPolicies({ grantsDir: grants }).size, 0);
  mkdirSync(join(grants, "policy"));
  writeFileSync(join(grants, "policy", "size.rego"), DENY);
  writeFileSync(join(grants, "policy", "notes.md"), "not a policy");
  writeFileSync(join(grants, "shared.rego"), "package deckhand\n");
  symlinkSync(join(grants, "shared.rego"), join(grants, "policy", "shared.rego"));
  assert.deepEqual(
    [...operatorPolicies({ grantsDir: grants })],
    [
      ["shared.rego", "package deckhand\n"],
      ["size.rego", DENY],
    ],
  );
  const outside = join(tempDir(t), "x.rego");
  writeFileSync(outside, "package deckhand\n");
  symlinkSync(outside, join(grants, "policy", "out.rego"));
  assert.throws(() => operatorPolicies({ grantsDir: grants }), /out\.rego leads outside/);
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

test("deny: a repo file replaces the operator's of the same name, other names add", async (t) => {
  const opa = fakeOpa({
    answer: (files) => evalResult(Object.keys(files).map((n) => `${n}: ${files[n]}`)),
  });
  const { policies } = setup(t, {
    opa,
    operator: { "a.rego": "operator a", "b.rego": "operator b" },
    repoFiles: { "a.rego": "repo a", "c.rego": "repo c" },
  });
  const denied = await policies.deny("deny_merge", "org/repo", "main", input);
  assert.deepEqual(denied.sort(), ["a.rego: repo a", "b.rego: operator b", "c.rego: repo c"]);
  // The operator's alone apply to a repo without policies.
  const bare = setup(t, { opa, operator: { "b.rego": "operator b" } });
  assert.deepEqual(await bare.policies.deny("deny_merge", "org/repo", "main", input), [
    "b.rego: operator b",
  ]);
});

test("deny: the rule's messages, its input on stdin, a restricted opa", async (t) => {
  const opa = fakeOpa({
    answer: (files, doc) => evalResult(doc.pr.additions > 400 ? ["too big"] : []),
  });
  const { policies, logs } = setup(t, { opa, repoFiles: { "size.rego": DENY } });
  assert.deepEqual(await policies.deny("deny_merge", "org/repo", "main", input), ["too big"]);
  const [call] = opa.evals();
  assert.deepEqual(JSON.parse(call.input), { version: 1, ...input() });
  assert.ok(call.args.includes("--stdin-input"));
  assert.ok(call.args.includes("--capabilities=capabilities.json"));
  assert.ok(call.args.some((a) => a.startsWith("--timeout=")));
  assert.equal(call.args.at(-1), "data.deckhand.deny_merge");
  assert.ok(!call.capabilities.builtins.some((b) => b.name === "http.send"));
  // The staged files are gone after.
  assert.throws(() => readdirSync(call.cwd));
  assert.match(logs.join("\n"), /deny_merge denies: too big/);
  const small = () => ({ pr: { additions: 1 } });
  assert.deepEqual(await policies.deny("deny_merge", "org/repo", "main", small), []);
  // Once per binary: its capabilities.
  assert.equal(opa.calls.filter((c) => c.args[0] === "capabilities").length, 1);
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
      /^policy error: `deny_merge` took more than 2 s$/,
    ],
    [
      {
        code: 1,
        stdout: JSON.stringify({
          errors: [{ message: "eval_cancel_error: caller cancelled query execution" }],
        }),
      },
      /took more than/,
    ],
    [evalResult([1, "x"]), /^policy error: `deny_merge` must be a set of strings$/],
    [evalResult("x"), /must be a set of strings/],
    [{ code: 0, stdout: "not json" }, /^policy error: opa's answer can't be read$/],
    [{ code: -1, stdout: "", stderr: "spawn opa ENOENT" }, /^policy error: spawn opa ENOENT$/],
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
  // Undefined: no file defines the rule.
  const none = setup(t, {
    opa: fakeOpa({ answer: () => ({ code: 0, stdout: "{}" }) }),
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
  // The operator's folder can't be read: refused, whatever the repo has.
  const operator = createPolicies({
    config: {},
    github: fakeGitHub().github,
    run: fakeOpa().run,
    readOperator: () => {
      throw new Error("policy/x.rego can't be read (EACCES)");
    },
    tmp: tempDir(t),
  });
  assert.match((await operator.deny("deny_merge", "org/repo", "main", input))[0], /EACCES/);
});

test("deny: a policy file is fetched once per blob", async (t) => {
  const { policies, gh } = setup(t, { repoFiles: { "a.rego": DENY } });
  await policies.deny("deny_merge", "org/repo", "main", input);
  await policies.deny("deny_merge", "org/repo", "main", input);
  assert.equal(gh.calls.filter((p) => p.includes("/git/blobs/")).length, 1);
  assert.equal(gh.calls.filter((p) => p.includes("/contents/")).length, 2);
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
    ["a.rego", `${DENY}deny_reveiw contains "x" if true\n`],
    ["bad.rego", "package deckhand\ndeny_merge contains x if { x := http.send({}) }\n"],
  ]);
  assert.deepEqual(await policies.check(files), {
    errors: ["policy error: bad.rego:2: undefined function http.send"],
    warnings: ["a.rego: `deny_reveiw` isn't a rule Deckhand evaluates (`deny_merge`)"],
  });
  const check = opa.calls.find((c) => c.args[0] === "check");
  assert.deepEqual(check.args, [
    "check",
    "--format=json",
    "--capabilities=capabilities.json",
    "policy",
  ]);
});

test("checkRepo: a branch's policies over the operator's; none on the branch, nothing", async (t) => {
  const opa = fakeOpa({
    checked: (files) => ({ code: files["op.rego"] && files["a.rego"] ? 0 : 1, stdout: "" }),
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

test("mergeInput: what deny_merge reads", () => {
  const doc = mergeInput({
    info: { full_name: "org/repo", private: true, default_branch: "main" },
    pr: {
      number: 5,
      title: "Add a thing",
      user: { login: "deckhand-app[bot]" },
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
    fixed: true,
    runs: [{ name: "CI", status: "completed", conclusion: "success", id: 1 }],
    now: () => Date.parse("2026-10-26T10:00:00Z"),
  });
  assert.deepEqual(doc, {
    decision: "merge",
    time: "2026-10-26T10:00:00.000Z",
    repo: { name: "org/repo", private: true, default_branch: "main" },
    pr: {
      number: 5,
      author: "deckhand-app[bot]",
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
    checks: [{ name: "CI", status: "completed", conclusion: "success" }],
  });
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

// With the real binary on the PATH (the listener's image has it): the policy as written.
let opa = null;
try {
  execFileSync("opa", ["version"], { stdio: "ignore" });
  opa = "opa";
} catch {
  // Not here: the fakes above cover the listener's side.
}

test(
  "the real opa: a denial, no network, a compile error",
  { skip: !opa && "no opa on the PATH" },
  async (t) => {
    const tmp = tempDir(t);
    const policies = createPolicies({
      config: {},
      github: null,
      readOperator: () => new Map(),
      tmp,
    });
    const files = new Map([["size.rego", DENY]]);
    assert.deepEqual(await policies.evaluate("deny_merge", files, input()), ["too big"]);
    assert.deepEqual(await policies.evaluate("deny_merge", files, { pr: { additions: 1 } }), []);
    const net = new Map([
      ["n.rego", "package deckhand\ndeny_merge contains x if { x := opa.runtime().env.HOME }\n"],
    ]);
    assert.match(
      (await policies.evaluate("deny_merge", net, {}))[0],
      /n\.rego:2: undefined function opa\.runtime/,
    );
    assert.match((await policies.check(net)).errors[0], /undefined function opa\.runtime/);
  },
);
