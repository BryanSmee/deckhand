import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  createPolicies,
  deniesOf,
  MAX_MESSAGE_LENGTH,
  MAX_TEXT,
  opaRunner,
  operatorPolicies,
  restrictedCapabilities,
  TIMEOUT_MS,
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
    const files = staged(cwd);
    Object.assign(calls.at(-1), { capabilities: caps, files });
    if (args[0] === "eval") return answer(files, JSON.parse(input));
    return checked(files);
  };
  return { run, calls, evals: () => calls.filter((c) => c.args[0] === "eval") };
}

const evalResult = (value) => ({
  code: 0,
  stdout: JSON.stringify({
    result: [{ expressions: [{ value, text: "data.deckhand.deny_merge" }] }],
  }),
});

function setup(
  t,
  { repoFiles = null, operator = {}, opa = fakeOpa(), secrets = [], status, now } = {},
) {
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
    ...(now ? { now } : {}),
  });
  return { policies, gh, opa, logs };
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
          errors: [
            {
              message: "numbers.range: timed out before generating all numbers in range",
              code: "eval_cancel_error",
            },
          ],
        }),
      },
      /^policy error: `deny_merge` took more than 2 s$/,
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
    // Too much output: opaRunner() says so on stderr, not as a timeout.
    [
      { code: -1, stdout: "", stderr: "stdout maxBuffer length exceeded", timedOut: false },
      /^policy error: stdout maxBuffer length exceeded$/,
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
    warnings: [
      "a.rego: `deny_reveiw` isn't a rule Deckhand evaluates (`deny_merge`, `deny_review`, `deny_fix`, `deny_github`)",
    ],
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

test("decide: whether a policy was asked, with deny()'s messages", async (t) => {
  const none = setup(t);
  assert.deepEqual(await none.policies.decide("deny_merge", "org/repo", "main", input), {
    applied: false,
    messages: [],
  });
  const opa = fakeOpa({ answer: () => evalResult([]) });
  const { policies } = setup(t, { opa, repoFiles: { "a.rego": DENY } });
  // The input the rules saw, version included, for the task's page.
  assert.deepEqual(await policies.decide("deny_merge", "org/repo", "main", input), {
    applied: true,
    messages: [],
    input: { version: 1, ...(await input()) },
  });
  // A folder GitHub can't list: applied, and refused (fail closed).
  const broken = setup(t, { status: 500 });
  const said = await broken.policies.decide("deny_merge", "org/repo", "main", input);
  assert.equal(said.applied, true);
  assert.match(said.messages[0], /^policy error: the policies can't be read/);
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
    // The operator's a.rego, listed, but the repo's replaces it.
    file("a.rego", "operator", false, false, ["deny_merge"], DENY),
    file(
      "b.rego",
      "operator",
      false,
      true,
      ["deny_review"],
      'package deckhand\ndeny_review contains "x" if true\n',
    ),
    file("a.rego", "repo", true, true, [], "# drops it\npackage deckhand\n"),
    file(
      "bad.rego",
      "repo",
      false,
      true,
      ["deny_merge", "deny_merged"],
      `${DENY}deny_merged contains "y" if true\n`,
    ),
  ]);
  assert.deepEqual(described.errors, [
    {
      file: "bad.rego",
      row: 3,
      message: "unexpected eof",
      text: "policy error: bad.rego:3: unexpected eof",
    },
  ]);
  assert.equal(described.warnings.length, 1);
  assert.match(described.warnings[0], /^bad.rego: `deny_merged` isn't a rule/);
  // What deny() would evaluate, and the check compiled: the repo's a.rego, not the operator's.
  assert.equal(described.policies.get("a.rego"), "# drops it\npackage deckhand\n");
  assert.equal(described.policies.size, 3);
  const check = opa.calls.find((c) => c.args[0] === "check");
  assert.equal(check.files["a.rego"], "# drops it\npackage deckhand\n");
});

test("describe: each error of opa check at its file and row (a recorded output)", async (t) => {
  const recorded = readFileSync(new URL("fixtures/opa-check-errors.json", import.meta.url), "utf8");
  const policies = createPolicies({
    config: {},
    github: fakeGitHub({ "net.rego": NET, "size.rego": SIZE }).github,
    run: opaRunner(FAKE),
    readOperator: () => new Map(),
    tmp: tempDir(t),
  });
  const described = await policies.describe("org/repo", "main");
  assert.deepEqual(described.errors, [
    {
      file: "net.rego",
      row: 3,
      message: "undefined function http.send",
      text: "policy error: net.rego:3: undefined function http.send",
    },
    {
      file: "size.rego",
      row: 4,
      message: "count: arity mismatch",
      text: "policy error: size.rego:4: count: arity mismatch",
    },
  ]);
  assert.equal(JSON.parse(recorded).errors.length, 2);
  // check() says the same, one line each.
  assert.deepEqual(await policies.check(described.policies), {
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
  assert.deepEqual((await slow.policies.describe("org/repo", "main")).errors, [
    { file: null, row: null, message: text, text },
  ]);
  const plain = setup(t, {
    opa: fakeOpa({ checked: () => ({ code: 2, stdout: "", stderr: "opa: no such flag\nusage" }) }),
    repoFiles: { "a.rego": DENY },
  });
  assert.deepEqual((await plain.policies.describe("org/repo", "main")).errors, [
    {
      file: null,
      row: null,
      message: "opa: no such flag",
      text: "policy error: opa: no such flag",
    },
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
  const [op, own] = (await policies.describe("org/repo", "main")).files;
  assert.equal(op.text, `${DENY}# [redacted]\n`);
  assert.equal(op.truncated, false);
  assert.equal(own.text, long.slice(0, MAX_TEXT));
  assert.equal(own.truncated, true);
});

test("describe: no policy anywhere, no opa call; an operator folder that can't be read, said", async (t) => {
  const { policies, opa } = setup(t);
  const described = await policies.describe("org/repo", "main");
  assert.deepEqual(described.files, []);
  assert.deepEqual(described.errors, []);
  assert.equal(opa.calls.length, 0);
  const broken = createPolicies({
    config: {},
    github: fakeGitHub().github,
    run: fakeOpa().run,
    readOperator: () => {
      throw new Error("policy/x.rego leads outside the grants folder");
    },
    tmp: tempDir(t),
  });
  const text =
    "the operator's policies can't be read: policy/x.rego leads outside the grants folder";
  assert.deepEqual((await broken.describe("org/repo", "main")).errors, [
    { file: null, row: null, message: text, text },
  ]);
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
    fixes: 2,
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
    fixes: 2,
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
    // Nothing that reads the environment, the network or the listener's files compiles.
    for (const call of [
      "opa.runtime().env.HOME",
      'http.send({"method": "get", "url": "https://example.com"}).body',
      'net.lookup_ip_addr("example.com")',
      'json.match_schema({}, {"$ref": "file:///etc/hostname"})',
      'json.verify_schema({"$ref": "file:///etc/hostname"})',
    ]) {
      const name = call.slice(0, call.indexOf("("));
      const file = new Map([
        [
          "x.rego",
          `package deckhand\ndeny_merge contains sprintf("%v", [x]) if { x := ${call} }\n`,
        ],
      ]);
      const [denied] = await policies.evaluate("deny_merge", file, {});
      assert.match(denied, new RegExp(`undefined function ${name.replace(/\./g, "\\.")}`), name);
    }
  },
);

test(
  "the real opa: a repo file drops the operator's of its name, a slow policy times out",
  { skip: !opa && "no opa on the PATH" },
  async (t) => {
    // The operator's size.rego denies; the repo's, only `package deckhand`, drops it.
    const merged = setup(t, {
      opa: { run: opaRunner() },
      operator: { "size.rego": DENY },
      repoFiles: { "size.rego": "package deckhand\n" },
    });
    assert.deepEqual(await merged.policies.deny("deny_merge", "org/repo", "main", input), []);
    const kept = setup(t, { opa: { run: opaRunner() }, operator: { "size.rego": DENY } });
    assert.deepEqual(await kept.policies.deny("deny_merge", "org/repo", "main", input), [
      "too big",
    ]);
    // opa stops itself at --timeout: the decision is refused, saying so.
    const slow = new Map([
      [
        "slow.rego",
        'package deckhand\ndeny_merge contains "x" if { count([n | some n in numbers.range(1, 100000000); n % 7 == 0]) > 0 }\n',
      ],
    ]);
    const start = Date.now();
    assert.deepEqual(await kept.policies.evaluate("deny_merge", slow, {}), [
      "policy error: `deny_merge` took more than 2 s",
    ]);
    assert.ok(Date.now() - start < TIMEOUT_MS + 3000);
  },
);
