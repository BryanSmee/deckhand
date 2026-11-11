import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BUILT_IN_CONFLICTS,
  builtInWorkflow,
  checkTriggers,
  errorText,
  parseCondition,
  parseWorkflow,
} from "../listener/workflow-format.mjs";

// The errors of a file as the config check says them.
const errors = (text, name = "w.yaml") => parseWorkflow(name, text).errors.map(errorText);

const FULL = `on: conflict
vars:
  rebases: counter
  warned: flag
steps:
  - if: label("no-rebase") or paths("migrations/**")
    then:
      - if: not warned
        comment: "Hands off: a maintainer rebases this one."
        set: warned
    else:
      - if: rebases < 3 and ci != failed
        run: rebase
        count: rebases
        else:
          - comment: Three rebases already.
  - repeat:
      - run: rebase
        count: rebases
    max: rebases 2
`;

test("a workflow parses into its event, vars and steps, its conditions as trees", () => {
  const { workflow, errors: found } = parseWorkflow("conflicts.yaml", FULL);
  assert.deepEqual(found, []);
  assert.equal(workflow.name, "conflicts");
  assert.equal(workflow.file, ".deckhand/workflows/conflicts.yaml");
  assert.match(workflow.version, /^[0-9a-f]{64}$/);
  assert.deepEqual(workflow.on, ["conflict"]);
  assert.deepEqual(workflow.vars, { rebases: "counter", warned: "flag" });
  const [branch, loop] = workflow.steps;
  assert.deepEqual(branch.if, {
    or: [
      { call: "label", args: ["no-rebase"] },
      { call: "paths", args: ["migrations/**"] },
    ],
  });
  assert.equal(branch.then[0].set, "warned");
  assert.deepEqual(branch.else[0].if, {
    and: [
      { cmp: "rebases", op: "<", value: 3 },
      { cmp: "ci", op: "!=", value: "failed" },
    ],
  });
  assert.equal(branch.else[0].else[0].comment, "Three rebases already.");
  assert.deepEqual(loop.max, { var: "rebases", rounds: 2 });
  assert.equal(loop.line, 17);
});

test("unknown conditions are refused, naming the file and the line", () => {
  const text = "on: conflict\nsteps:\n  - if: sevrity <= low\n    run: rebase\n";
  assert.deepEqual(errors(text), [
    "`.deckhand/workflows/w.yaml` line 3: `if`: unknown condition `sevrity` (expected `severity`, `ci`, `paths`, `label`, `changed`, or a var declared under `vars`)",
  ]);
  assert.match(
    errors('on: conflict\nsteps:\n  - if: author("me")\n    run: rebase\n')[0],
    /line 3: `if`: unknown condition `author\(\)`/,
  );
  // A var not declared is no condition either.
  assert.match(
    errors("on: conflict\nsteps:\n  - if: tries < 3\n    run: rebase\n")[0],
    /line 3: `if`: unknown condition `tries`/,
  );
});

test("each condition's values are checked", () => {
  const vars = { n: "counter", done: "flag" };
  const bad = [
    ["severity < huge", /`severity` compares with/],
    ["ci < passed", /`ci` takes == or !=/],
    ["ci == green", /`ci` is one of/],
    ['n == "3"', /`n` is a counter: compare it with a whole number/],
    ["n", /`n` needs a comparison/],
    ["paths()", /`paths\(\)` needs at least one quoted value/],
    ['changed("a", since n)', /`since`: `n` isn't a flag/],
    ["done and", /a condition ends too soon/],
    ["(done", /expected \)/],
    ["done done", /unexpected `done`/],
    ["done; rm", /unexpected `;`/],
  ];
  for (const [text, message] of bad) {
    assert.throws(() => parseCondition(text, vars), message, text);
  }
  assert.deepEqual(parseCondition('changed("policy/**", since done)', vars), {
    call: "changed",
    args: ["policy/**"],
    since: "done",
  });
  assert.deepEqual(parseCondition("not (done or severity >= high)", vars), {
    not: { or: [{ flag: "done" }, { cmp: "severity", op: ">=", value: "high" }] },
  });
});

test("an unbounded loop is refused: no max, a max on no counter, or a counter it never counts", () => {
  const head = "on: conflict\nvars:\n  n: counter\n  f: flag\nsteps:\n";
  assert.deepEqual(errors(`${head}  - repeat:\n      - run: rebase\n`), [
    "`.deckhand/workflows/w.yaml` line 6: an unbounded loop: `repeat` needs `max: <counter> <rounds>`",
  ]);
  assert.deepEqual(errors(`${head}  - repeat:\n      - run: rebase\n    max: n 3\n`), [
    "`.deckhand/workflows/w.yaml` line 8: an unbounded loop: no step of the `repeat` counts `n` (`count: n`)",
  ]);
  assert.match(
    errors(`${head}  - repeat:\n      - run: rebase\n        set: f\n    max: f 3\n`)[0],
    /line 9: `max`: `f` isn't a counter/,
  );
  assert.match(
    errors(`${head}  - repeat:\n      - run: rebase\n        count: n\n    max: n 0\n`)[0],
    /line 9: `max`: expected at least 1 round/,
  );
  // Counted in a nested step: bounded.
  const nested = `${head}  - repeat:\n      - if: ci == failed\n        then:\n          - run: rebase\n            count: n\n    max: n 2\n`;
  assert.deepEqual(errors(nested), []);
});

test("unknown events, steps, keys and vars are refused", () => {
  assert.match(
    errors("on: push\nsteps:\n  - run: rebase\n")[0],
    /line 1: `on`: unknown event `push`/,
  );
  assert.match(
    errors("on: conflict\nsteps:\n  - run: deploy\n")[0],
    /line 3: `run`: unknown step `deploy`/,
  );
  assert.match(
    errors("on: conflict\nsteps:\n  - run: merge\n")[0],
    /line 3: `run: merge` doesn't run on `conflict`/,
  );
  assert.match(
    errors("on: conflict\nname: x\nsteps:\n  - run: rebase\n")[0],
    /line 2: unknown key `name`/,
  );
  assert.match(
    errors("on: conflict\nsteps:\n  - run: rebase\n    when: always\n")[0],
    /line 4: unknown key `when` in a step/,
  );
  assert.match(
    errors("on: conflict\nsteps:\n  - run: rebase\n    count: n\n")[0],
    /line 4: `count`: expected a counter declared under `vars`/,
  );
  assert.match(
    errors("on: conflict\nvars:\n  and: flag\nsteps:\n  - run: rebase\n")[0],
    /line 3: `vars.and`: a var's name/,
  );
  assert.match(
    errors("on: conflict\nvars:\n  n: string\nsteps:\n  - run: rebase\n")[0],
    /line 3: `vars.n`: expected counter or flag/,
  );
  assert.match(
    errors("on: conflict\nsteps:\n  - run: rebase\n    comment: hi\n")[0],
    /line 3: one of `run`, `comment` per step/,
  );
  assert.match(
    errors("on: conflict\nsteps:\n  - then:\n      - run: rebase\n")[0],
    /`then` needs an `if`/,
  );
  assert.match(errors("on: conflict\nsteps: []\n")[0], /line 2: `steps`: expected a list of steps/);
  assert.match(errors("on: [conflict\n")[0], /line 1: /);
  assert.match(errors("- a\n")[0], /expected a mapping with `on` and `steps`/);
});

test("two triggers for one event are refused, whatever their conditions", () => {
  const a = parseWorkflow("a.yaml", "on: conflict\nsteps:\n  - run: rebase\n").workflow;
  const b = parseWorkflow(
    "b.yaml",
    '# mine\non: [conflict]\nsteps:\n  - if: label("x")\n    run: rebase\n',
  ).workflow;
  assert.deepEqual(checkTriggers([a, b], {}).map(errorText), [
    "`.deckhand/workflows/b.yaml` line 2: two triggers for `conflict`: this workflow and `.deckhand/workflows/a.yaml` (line 1)",
  ]);
  assert.deepEqual(checkTriggers([a], {}), []);
});

test("the built-in review loop counts as a trigger on `ready`", () => {
  const ready = parseWorkflow("r.yaml", "on: ready\nsteps:\n  - comment: hi\n").workflow;
  assert.deepEqual(checkTriggers([ready], { review: { on: "ready" } }).map(errorText), [
    "`.deckhand/workflows/r.yaml` line 1: two triggers for `ready`: this workflow and the built-in review loop (`review.on: ready`)",
  ]);
  // Without it, the workflow is the one on `ready`; it needs the `review` block's settings.
  assert.deepEqual(checkTriggers([ready], { review: { on: "manual" } }), []);
  assert.match(
    errorText(checkTriggers([ready], { review: null })[0]),
    /`ready` needs the repository's `review:` block/,
  );
});

test("the built-in conflicts workflow is a file of the format, one rebase step", () => {
  assert.deepEqual(parseWorkflow("x.yaml", BUILT_IN_CONFLICTS).errors, []);
  const built = builtInWorkflow("conflict");
  assert.deepEqual(
    [built.name, built.file, built.on, built.steps],
    ["built-in", null, ["conflict"], [{ line: 4, run: "rebase" }]],
  );
  assert.equal(builtInWorkflow("ready"), null);
  assert.equal(builtInWorkflow("ready", { review: { on: "manual" } }), null);
});

test("a file too large or too deep is refused", () => {
  assert.match(errors(`on: conflict\n# ${"x".repeat(33 * 1024)}\n`)[0], /over 32 KB/);
  let steps = "  - run: rebase\n";
  for (let depth = 0; depth < 6; depth++) {
    steps = `  - if: ci == passed\n    then:\n${steps.replace(/^/gm, "    ")}`;
  }
  assert.match(errors(`on: conflict\nsteps:\n${steps}`).join("\n"), /nested deeper than 5/);
});
