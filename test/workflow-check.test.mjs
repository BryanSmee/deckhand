// The checks on a workflow file a sandbox pushes (allow_workflows): the YAML subset they
// read, and the rules.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseYaml, workflowProblems, YamlError } from "../listener/workflow-check.mjs";

// Maps as plain objects, to compare.
const plain = (v) =>
  v instanceof Map
    ? Object.fromEntries([...v].map(([k, x]) => [k, plain(x)]))
    : Array.isArray(v)
      ? v.map(plain)
      : v;
const read = (text) => plain(parseYaml(text));

test("a workflow's YAML: block mappings and sequences, scalars of every style, one-line flows", () => {
  const text = `---
# A comment
name: CI
on:
  push:
    branches: [main, "release/*"]
  pull_request:
    branches:
    - main
permissions: { contents: read }
jobs:
  test:
    if: github.event_name == 'push' # trailing comment
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - with: { node-version: "22", cache: npm }
        run: |
          npm ci
          echo "a: b"   # kept

      - run: >-
          one
          two
      - 'it''s'
      - "tab\\there \\x41\\u00e9"
      - - nested
      -
        below: x
      - url: https://example.com/a#b
`;
  assert.deepEqual(read(text), {
    name: "CI",
    on: { push: { branches: ["main", "release/*"] }, pull_request: { branches: ["main"] } },
    permissions: { contents: "read" },
    jobs: {
      test: {
        if: "github.event_name == 'push'",
        "runs-on": "ubuntu-latest",
        steps: [
          { uses: "actions/checkout@v4" },
          {
            with: { "node-version": "22", cache: "npm" },
            run: 'npm ci\necho "a: b"   # kept\n',
          },
          { run: "one two" },
          "it's",
          "tab\there Aé",
          ["nested"],
          { below: "x" },
          { url: "https://example.com/a#b" },
        ],
      },
    },
  });
});

test("block scalars: chomping, folding, an explicit indent", () => {
  assert.deepEqual(read("a: |\n  x\n\n\nb: 1\n"), { a: "x\n", b: "1" });
  assert.deepEqual(read("a: |-\n  x\n\n"), { a: "x" });
  assert.deepEqual(read("a: |+\n  x\n\n"), { a: "x\n\n" });
  assert.deepEqual(read("a: >\n  one\n  two\n\n  three\n    more\n  four\n"), {
    a: "one two\nthree\n  more\nfour\n",
  });
  assert.deepEqual(read("a: |2\n    two\n  base\n"), { a: "  two\nbase\n" });
  assert.deepEqual(read("a: |\nb: 1\n"), { a: "", b: "1" });
});

test("anything outside the subset is refused, with its line", () => {
  for (const [text, line, why] of [
    ["a: &x 1\nb: *x\n", 1, /anchors, aliases, tags/],
    ["a: 1\nb: *x\n", 2, /anchors, aliases, tags/],
    ["a: !!str 1\n", 1, /anchors, aliases, tags/],
    ["&x a: 1\n", 1, /unsupported key/],
    ["<<: {a: 1}\n", 1, /merge keys/],
    ["a: {<<: x}\n", 1, /merge keys/],
    ["a: 1\n---\nb: 2\n", 2, /several documents/],
    ["a: 1\n...\n", 2, /several documents/],
    ["%YAML 1.2\n---\na: 1\n", 1, /directives/],
    ["a: 1\nA: 2\n", 2, /duplicate key `A`/],
    ["a: {b: 1, B: 2}\n", 1, /duplicate key/],
    ["a: b\n  c\n", 2, /multi-line scalars/],
    ['a: "b\n  c"\n', 1, /must close on their line/],
    ["a: [b,\n  c]\n", 1, /fit on one line/],
    ["? a\n: b\n", 1, /anchors, aliases, tags/],
    ["a:\n\tb: 1\n", 2, /tabs/],
    ["a: b: c\n", 1, /mapping isn't allowed/],
    ['a: "\\q"\n', 1, /bad escape/],
    ["a:\n  b: 1\n c: 2\n", 3, /expected `key: value`|unexpected indentation/],
    ["a: [b: c]\n", 1, /expected `,`/],
    ["a: {b}\n", 1, /key: value/],
    ["a: 1\n- b\n", 2, /sequence item/],
  ]) {
    assert.throws(
      () => parseYaml(text),
      (error) => error instanceof YamlError && error.line === line && why.test(error.message),
      JSON.stringify(text),
    );
  }
});

test("every key and value is seen decoded, with its line", () => {
  const seen = [];
  parseYaml('a: "\\x73"\nb:\n  - [c, {d: e}]\nf: |\n  g\n', (value, line) =>
    seen.push(`${line}:${value}`),
  );
  assert.deepEqual(seen, ["1:a", "1:s", "2:b", "3:c", "3:d", "3:e", "4:f", "4:g\n"]);
});

const WORKFLOW = `on: push
permissions:
  contents: read
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: npm test
`;

test("a workflow whose token reads at most and that names no secret passes", () => {
  assert.deepEqual(workflowProblems(WORKFLOW), []);
  for (const permissions of [
    "read-all",
    "{}",
    "{ contents: read, pull-requests: none }",
    "\n  Contents: READ\n  actions: none",
  ]) {
    const text = WORKFLOW.replace("permissions:\n  contents: read", `permissions: ${permissions}`);
    assert.deepEqual(workflowProblems(text), [], permissions);
  }
  // github.token is capped by the same permissions.
  assert.deepEqual(workflowProblems(`${WORKFLOW}        env: { T: "\${{ github.token }}" }\n`), []);
});

test("a workflow that may write, or whose permissions can't be read, is refused", () => {
  assert.deepEqual(workflowProblems(WORKFLOW.replace("permissions:\n  contents: read\n", "")), [
    "no top-level `permissions:` (add `permissions: { contents: read }`)",
  ]);
  for (const [permissions, why] of [
    ["write-all", "`permissions: write-all` is not allowed"],
    ["read", "`permissions: read` is not allowed"],
    ["${{ inputs.p }}", "`permissions: ${{ inputs.p }}` is not allowed"],
    ["", "`permissions: ` is not allowed"],
    ["[contents]", "`permissions` must be read-all or a mapping of scopes"],
    ["{ contents: write }", "`permissions.contents` must be read or none"],
    ["{ ID-Token: Write }", "`permissions.ID-Token` must be read or none"],
    ["{ packages: '${{ x }}' }", "`permissions.packages` must be read or none"],
    ["{ actions: [read] }", "`permissions.actions` must be read or none"],
  ]) {
    const text = WORKFLOW.replace("permissions:\n  contents: read", `permissions: ${permissions}`);
    assert.deepEqual(workflowProblems(text), [why], permissions);
  }
  // A job's own, its key in any case.
  const job = WORKFLOW.replace(
    "    runs-on:",
    "    Permissions:\n      contents: write\n    runs-on:",
  );
  assert.deepEqual(workflowProblems(job), [
    "`jobs.test.permissions.contents` must be read or none",
  ]);
  const top = WORKFLOW.replace("permissions:", "PERMISSIONS:").replace("read", "write");
  assert.deepEqual(workflowProblems(top), ["`permissions.contents` must be read or none"]);
});

test("a workflow naming `secrets`, however it spells it, is refused", () => {
  for (const line of [
    'run: echo "${{ secrets.TOKEN }}"',
    "run: echo ${{ secrets['TOKEN'] }}",
    "run: echo ${{ toJSON(secrets) }}",
    "run: echo ${{ SECRETS.token }}",
    'run: "echo ${{ \\x73ecrets.TOKEN }}"',
    'run: "echo ${{ \\u0053ECRETS.TOKEN }}"',
    "with: { token: '${{ secrets.T }}' }",
    "secrets: inherit",
  ]) {
    const problems = workflowProblems(`${WORKFLOW}      - ${line}\n`);
    assert.deepEqual(problems, ["mentions `secrets` (line 9)"], line);
  }
  const block = workflowProblems(`${WORKFLOW}      - run: |\n          echo \${{ secrets.X }}\n`);
  assert.deepEqual(block, ["mentions `secrets` (line 9)"]);
});

test("a file the parser refuses, or that isn't a mapping, is refused with its line", () => {
  assert.deepEqual(workflowProblems(`${WORKFLOW}x: &a 1\n`), [
    "line 9: unsupported YAML: `&` (anchors, aliases, tags…)",
  ]);
  assert.deepEqual(workflowProblems("- a\n"), ["not a workflow (a mapping of keys)"]);
  assert.deepEqual(workflowProblems(""), ["not a workflow (a mapping of keys)"]);
});
