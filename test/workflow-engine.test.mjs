import assert from "node:assert/strict";
import { test } from "node:test";
import {
  compile,
  createEngine,
  facts,
  holds,
  mergeInstances,
} from "../listener/workflow-engine.mjs";
import { parseCondition, parseWorkflow } from "../listener/workflow-format.mjs";
import { mapStore } from "./helpers.mjs";

const KEY = "org/repo#30";

function workflow(text) {
  const { workflow: parsed, errors } = parseWorkflow("w.yaml", text);
  assert.deepEqual(errors, []);
  return parsed;
}

// An engine on `instances`, its actions recorded: `outcomes` says what each `run` answers
// (by default "wait"), comments answer "done".
function engineOn(instances, { maxRounds, outcomes = [] } = {}) {
  let time = 1_000;
  const acted = [];
  const engine = createEngine({ instances, maxRounds, now: () => (time += 1) });
  const io = (known = {}) => ({
    facts: facts(known),
    act: async (step) => {
      acted.push(step.run ?? step.comment);
      if (step.comment) return "done";
      const next = outcomes.length ? outcomes.shift() : "wait";
      if (next instanceof Error) throw next;
      return next;
    },
  });
  return { engine, acted, io };
}

const event = (id, pr = 31, head = "h1") => ({ name: "conflict", id, pr, head });

const TWO_STEPS = workflow(`on: conflict
vars:
  rebases: counter
steps:
  - run: rebase
    count: rebases
  - comment: rebased
`);

test("a run waits for its end, then the workflow goes on; the event is handled once", async () => {
  const { engine, acted, io } = engineOn(new Map());
  assert.equal(await engine.trigger(KEY, TWO_STEPS, event("a"), io()), "waiting");
  assert.deepEqual(acted, ["rebase"]);
  // The same event again (a redelivered webhook, a check repeated): nothing acts twice.
  assert.equal(await engine.trigger(KEY, TWO_STEPS, event("a"), io()), "waiting");
  assert.equal(await engine.resume(KEY, "conflict", io(), "h2"), "done");
  assert.deepEqual(acted, ["rebase", "rebased"]);
  assert.equal(await engine.trigger(KEY, TWO_STEPS, event("a"), io()), "handled");
  assert.equal(await engine.resume(KEY, "conflict", io()), "idle");
  assert.deepEqual(engine.instance(KEY, "conflict").vars.counters, { rebases: 1 });
  // A new event starts from the top, its counter kept.
  assert.equal(await engine.trigger(KEY, TWO_STEPS, event("b"), io()), "waiting");
  assert.deepEqual(engine.instance(KEY, "conflict").vars.counters, { rebases: 2 });
});

test("an instance survives a handover: the next engine goes on from the store", async () => {
  const maps = mapStore();
  const first = engineOn(await maps.map("workflows"));
  assert.equal(await first.engine.trigger(KEY, TWO_STEPS, event("a"), first.io()), "waiting");

  // The next orchestrator: the same event redelivered starts nothing; the run's end goes on.
  const next = engineOn(await maps.again("workflows"));
  assert.equal(next.engine.waiting(KEY, "conflict"), true);
  assert.equal(await next.engine.trigger(KEY, TWO_STEPS, event("a"), next.io()), "waiting");
  assert.equal(await next.engine.resume(KEY, "conflict", next.io()), "done");
  assert.deepEqual([first.acted, next.acted], [["rebase"], ["rebased"]]);

  // And once more: the event is remembered as handled.
  const third = engineOn(await maps.again("workflows"));
  assert.equal(await third.engine.trigger(KEY, TWO_STEPS, event("a"), third.io()), "handled");
  assert.deepEqual(third.acted, []);
});

// An orchestrator that stops in the middle of `flow`'s first step: marked started, never ended.
// → the next one's engine (engineOn()) on the same store.
async function interrupted(maps, flow = TWO_STEPS) {
  const first = createEngine({ instances: await maps.map("workflows") });
  first
    .trigger(KEY, flow, event("a"), { facts: facts(), act: () => new Promise(() => {}) })
    .catch(() => {});
  await new Promise((resolve) => setImmediate(resolve));
  return engineOn(await maps.again("workflows"));
}

test("a run step a handover cut off is asked again on its event, told so", async () => {
  const next = await interrupted(mapStore());
  const told = [];
  const io = next.io();
  const act = io.act;
  io.act = (step, view) => (told.push(view.interrupted), act(step, view));
  // Cut off before its run was queued, say: the step queues it now, counted once.
  assert.equal(await next.engine.trigger(KEY, TWO_STEPS, event("a"), io), "waiting");
  assert.deepEqual([next.acted, told], [["rebase"], [true]]);
  assert.equal(await next.engine.resume(KEY, "conflict", next.io()), "done");
  assert.deepEqual(next.acted, ["rebase", "rebased"]);
  assert.deepEqual(next.engine.instance(KEY, "conflict").vars.counters, { rebases: 1 });
});

test("a run step cut off after its run was queued goes on at that run's end", async () => {
  const next = await interrupted(mapStore());
  assert.equal(next.engine.waiting(KEY, "conflict"), true);
  assert.equal(await next.engine.resume(KEY, "conflict", next.io()), "done");
  assert.deepEqual(next.acted, ["rebased"]);
  assert.deepEqual(next.engine.instance(KEY, "conflict").vars.counters, { rebases: 1 });
});

test("a comment a handover cut off is taken as posted, never posted twice", async () => {
  const flow = workflow("on: conflict\nsteps:\n  - comment: first\n  - comment: second\n");
  const next = await interrupted(mapStore(), flow);
  assert.equal(next.engine.waiting(KEY, "conflict"), false);
  assert.equal(await next.engine.trigger(KEY, flow, event("a"), next.io()), "done");
  assert.deepEqual(next.acted, ["second"]);
});

test("a new event counts the step an older one left cut off, then runs", async () => {
  const next = await interrupted(mapStore());
  assert.equal(await next.engine.trigger(KEY, TWO_STEPS, event("b"), next.io()), "waiting");
  assert.deepEqual(next.acted, ["rebase"]);
  assert.deepEqual(next.engine.instance(KEY, "conflict").vars.counters, { rebases: 2 });
});

test("a skipped action takes nothing and the same event goes on from it; a throw too", async () => {
  const { engine, acted, io } = engineOn(new Map(), {
    outcomes: ["skipped", new Error("GitHub said 502"), "wait"],
  });
  assert.equal(await engine.trigger(KEY, TWO_STEPS, event("a"), io()), "skipped");
  await assert.rejects(engine.trigger(KEY, TWO_STEPS, event("a"), io()), /502/);
  assert.deepEqual(engine.instance(KEY, "conflict").vars.counters, {});
  assert.equal(await engine.trigger(KEY, TWO_STEPS, event("a"), io()), "waiting");
  assert.deepEqual(acted, ["rebase", "rebase", "rebase"]);
  assert.deepEqual(engine.instance(KEY, "conflict").vars.counters, { rebases: 1 });
});

test("a refused step counts nothing and the workflow goes on", async () => {
  const { engine, acted, io } = engineOn(new Map(), { outcomes: ["refused"] });
  assert.equal(await engine.trigger(KEY, TWO_STEPS, event("a"), io()), "done");
  assert.deepEqual(acted, ["rebase", "rebased"]);
  assert.deepEqual(engine.instance(KEY, "conflict").vars.counters, {});
});

test("a pull request stays on the workflow version it started with", async () => {
  const { engine, acted, io } = engineOn(new Map(), { outcomes: ["done", "done"] });
  await engine.trigger(KEY, TWO_STEPS, event("a"), io());
  const changed = workflow("on: conflict\nsteps:\n  - comment: version two\n");
  await engine.trigger(KEY, changed, event("b"), io());
  assert.deepEqual(acted, ["rebase", "rebased", "rebase", "rebased"]);
  assert.equal(engine.instance(KEY, "conflict").workflow.version, TWO_STEPS.version);
  // Another pull request on the task: the version of now.
  await engine.trigger(KEY, changed, event("c", 32), io());
  assert.deepEqual(acted.slice(4), ["version two"]);
  engine.forget(KEY, 32);
  assert.equal(engine.instance(KEY, "conflict"), null);
});

test("a sweep keeps the instances of open pull requests alone", async () => {
  const instances = new Map();
  const { engine, io } = engineOn(instances);
  await engine.trigger(KEY, TWO_STEPS, event("a"), io());
  await engine.trigger("org/repo#40", TWO_STEPS, event("b", 41), io());
  await engine.trigger("org/repo#50", TWO_STEPS, event("c", 51), io());
  // #30's pull request open still, #40's replaced by #42, #50 without one.
  assert.equal(
    engine.sweep(
      new Map([
        [KEY, 31],
        ["org/repo#40", 42],
      ]),
    ),
    2,
  );
  assert.deepEqual(engine.keys(), [KEY]);
  assert.equal(engine.sweep(new Map([[KEY, 31]])), 0);
});

test("conditions pick the branch, flags are set once with their head", async () => {
  const flow = workflow(`on: conflict
vars:
  warned: flag
steps:
  - if: label("hold") and not warned
    comment: on hold
    set: warned
  - if: paths("migrations/**")
    comment: migrations
    else:
      - comment: no migrations
`);
  const { engine, acted, io } = engineOn(new Map());
  const known = { labels: () => ["Hold"], files: () => ["src/a.js"] };
  await engine.trigger(KEY, flow, event("a", 31, "h1"), io(known));
  await engine.trigger(KEY, flow, event("b", 31, "h2"), io(known));
  assert.deepEqual(acted, ["on hold", "no migrations", "no migrations"]);
  assert.equal(engine.instance(KEY, "conflict").vars.flags.warned.head, "h1");
});

test("a loop stops at its max, at MAX_FIX_ROUNDS, and when an iteration counts nothing", async () => {
  const loop = (rounds) =>
    workflow(`on: conflict
vars:
  n: counter
steps:
  - repeat:
      - if: n < 100
        comment: again
        count: n
    max: n ${rounds}
`);
  let run = engineOn(new Map());
  await run.engine.trigger(KEY, loop(3), event("a"), run.io());
  assert.equal(run.acted.length, 3);
  run = engineOn(new Map(), { maxRounds: 2 });
  await run.engine.trigger(KEY, loop(5), event("a"), run.io());
  assert.equal(run.acted.length, 2);
  // An iteration whose counting step didn't run: the loop ends rather than spin.
  const idle = workflow(`on: conflict
vars:
  n: counter
steps:
  - repeat:
      - if: ci == failed
        comment: fix
        count: n
      - comment: looked
    max: n 3
`);
  run = engineOn(new Map());
  assert.equal(await run.engine.trigger(KEY, idle, event("a"), run.io()), "done");
  assert.deepEqual(run.acted, ["looked"]);
});

test("conditions read the facts once, and only when asked", async () => {
  let reads = 0;
  const known = facts({
    files: () => (reads++, ["policy/a.rego", "src/b.js"]),
    head: () => "h2",
    changedSince: (sha) => (sha === "h1" ? ["src/b.js"] : []),
    ci: () => "failed",
    severity: () => "medium",
  });
  const vars = { counters: { n: 2 }, flags: { done: { head: "h1" } } };
  const check = (text) =>
    holds(parseCondition(text, { n: "counter", done: "flag", other: "flag" }), vars, known);
  assert.equal(await check('paths("policy/**")'), true);
  assert.equal(await check('paths("docs/**")'), false);
  assert.equal(await check('changed("policy/**", since done)'), false);
  assert.equal(await check('changed("src/*", since done)'), true);
  assert.equal(await check('changed("policy/**", since other)'), true);
  assert.equal(await check("severity <= medium and severity > low"), true);
  assert.equal(await check("severity >= high"), false);
  assert.equal(await check("ci == failed and n >= 2 and not other"), true);
  assert.equal(reads, 1);
  // No review: no comparison of severity holds.
  assert.equal(await holds(parseCondition("severity != low"), vars, facts()), false);
});

test("the program a workflow compiles to: guards jump over their steps, loops back", () => {
  const flow = workflow(`on: conflict
vars:
  n: counter
steps:
  - if: ci == passed
    comment: a
    else:
      - comment: b
  - repeat:
      - comment: c
        count: n
    max: n 2
`);
  assert.deepEqual(
    compile(flow.steps).map(({ op, to, end, head }) => ({ op, to, end, head })),
    [
      { op: "unless", to: 3, end: undefined, head: undefined },
      { op: "act", to: undefined, end: undefined, head: undefined },
      { op: "jump", to: 4, end: undefined, head: undefined },
      { op: "act", to: undefined, end: undefined, head: undefined },
      { op: "loop", to: undefined, end: 7, head: undefined },
      { op: "act", to: undefined, end: undefined, head: undefined },
      { op: "next", to: undefined, end: undefined, head: 4 },
    ],
  );
});

test("two spellings' instances merge: counters by max, flags by OR, ids either handled", async () => {
  const a = {
    pr: 31,
    at: 1,
    vars: { counters: { n: 3, m: 1 }, flags: { f: { head: "x" } } },
    handled: ["a"],
  };
  const b = {
    pr: 31,
    at: 2,
    vars: { counters: { n: 1 }, flags: { g: { head: "y" } } },
    handled: ["b"],
  };
  const merged = mergeInstances(a, b);
  assert.deepEqual(merged.vars, {
    counters: { n: 3, m: 1 },
    flags: { f: { head: "x" }, g: { head: "y" } },
  });
  assert.deepEqual(merged.handled, ["a", "b"]);
  // Another pull request: the later's alone.
  assert.equal(mergeInstances(a, { ...b, pr: 32 }).pr, 32);

  const instances = new Map([
    ["Org/repo#30", { conflict: a }],
    ["org/repo#30", { conflict: b }],
  ]);
  const { engine } = engineOn(instances);
  engine.respell((repo) => (repo.toLowerCase() === "org/repo" ? "org/repo" : repo));
  assert.deepEqual(engine.keys(), ["org/repo#30"]);
  assert.deepEqual(engine.instance("org/repo#30", "conflict").vars.counters, { n: 3, m: 1 });
});
