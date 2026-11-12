// The workflow engine (#1040): runs a parsed workflow (workflow-format.mjs) on one pull request,
// one instance per task and event, kept in the store (the `workflows` map) after each step, so
// that the next orchestrator goes on where the last one stopped (a handover, a crash).
//
// - An event has an id (the conflict watcher's: its pull request, head and base): an id handled
//   already does nothing, so a redelivered webhook or a check repeated starts nothing twice. A
//   new id starts the steps again from the top, the vars kept, and drops what an older one
//   waited for: the caller triggers no event while the task has a run going (conflicts.mjs
//   checks busy() first).
// - An instance keeps the workflow as it started with it: a pull request stays on that version
//   whatever its default branch says later. A new pull request on the task starts afresh.
// - A step that acts (a run, a comment) is marked started before it acts. A comment a handover
//   or a crash interrupted is taken as done, never posted twice. A run step is asked again on
//   the same event (`interrupted`: the step's own record says whether its run was queued), and
//   its run's end goes on from it all the same (resume()). A run waits for its end.
// - Vars: counters only go up, flags are only set (with the head they were set at); two copies
//   of one instance (two spellings of a repo) merge by max and OR.
// - Loops are bounded twice: by their `max` (at most MAX_FIX_ROUNDS) and by their counter, an
//   iteration that counted nothing ending the loop. A step may also end the loop it is in
//   (`break`: the review loop's fix step with nothing to fix), or the event's steps (`stop`).
// - A run that ended where its instance doesn't wait (the review loop's: a pull request in the
//   loop before it moved onto the engine, a run a maintainer asked for) is placed there first
//   (place()), its loops taken as having gone round, then goes on (resume()).
//
// The engine decides nothing about what a run may do: each action (`act`) asks the policies as
// the built-in code does.
import { posix } from "node:path";
import { respellMap } from "./spelling.mjs";
import { SEVERITIES } from "./severities.mjs";

// The event ids an instance remembers having handled: a check repeats the latest few at most.
const MAX_HANDLED = 20;
// The operations one drive() runs at most: loops are bounded already, this bounds a bug.
const MAX_OPS = 1000;
// The severities a condition compares, most severe first: `none`, a review without findings.
const LEVELS = [...SEVERITIES, "none"];

// A workflow's steps → a flat program, each operation an index the instance can stop at:
// { op: "act", step }, { op: "unless", cond, to }, { op: "jump", to }, { op: "loop", var,
// rounds, end }, { op: "next", head }. Deterministic: an instance keeps its workflow, never its
// program.
export function compile(steps, ops = []) {
  for (const step of steps) {
    if (step.repeat) {
      const head = ops.length;
      ops.push({ op: "loop", var: step.max.var, rounds: step.max.rounds, end: null });
      compile(step.repeat, ops);
      ops.push({ op: "next", head });
      ops[head].end = ops.length;
      continue;
    }
    const guard = step.if ? ops.push({ op: "unless", cond: step.if, to: null }) - 1 : null;
    if (step.then) compile(step.then, ops);
    else ops.push({ op: "act", step });
    if (guard === null) continue;
    if (step.else) {
      const jump = ops.push({ op: "jump", to: null }) - 1;
      ops[guard].to = ops.length;
      compile(step.else, ops);
      ops[jump].to = ops.length;
    } else ops[guard].to = ops.length;
  }
  return ops;
}

// The loop op `pc` is inside of, the innermost, or null.
export function enclosing(ops, pc) {
  let found = null;
  ops.forEach((op, i) => {
    if (op.op === "loop" && i < pc && pc < op.end && (found === null || i > found)) found = i;
  });
  return found;
}

// Whether condition `cond` holds. `vars`: the instance's; `facts`: what the event knows of the
// pull request, each read when a condition first asks (facts()).
export async function holds(cond, vars, facts) {
  if (cond.and) return (await holds(cond.and[0], vars, facts)) && holds(cond.and[1], vars, facts);
  if (cond.or) return (await holds(cond.or[0], vars, facts)) || holds(cond.or[1], vars, facts);
  if (cond.not) return !(await holds(cond.not, vars, facts));
  if (cond.flag) return !!vars.flags?.[cond.flag];
  if (cond.call === "paths") return matches(await facts.files(), cond.args);
  if (cond.call === "label") {
    const names = new Set(cond.args.map((a) => a.toLowerCase()));
    return (await facts.labels()).some((l) => names.has(String(l).toLowerCase()));
  }
  if (cond.call === "changed") {
    const flag = cond.since ? vars.flags?.[cond.since] : null;
    if (!flag) return matches(await facts.files(), cond.args);
    const head = await facts.head();
    if (!flag.head || flag.head === head) return false;
    return matches(await facts.changedSince(flag.head), cond.args);
  }
  if (cond.cmp === "severity") {
    const severity = await facts.severity();
    // Unknown (no review): no comparison holds. Ranked so that none (a review without
    // findings) < low < medium < high < critical.
    if (!LEVELS.includes(severity)) return false;
    const rank = (s) => LEVELS.length - LEVELS.indexOf(s);
    return compare(rank(severity), cond.op, rank(cond.value));
  }
  if (cond.cmp === "ci") {
    const state = await facts.ci();
    return cond.op === "==" ? state === cond.value : state !== cond.value;
  }
  return compare(vars.counters?.[cond.cmp] ?? 0, cond.op, cond.value);
}

function compare(a, op, b) {
  switch (op) {
    case "==":
      return a === b;
    case "!=":
      return a !== b;
    case "<":
      return a < b;
    case "<=":
      return a <= b;
    case ">":
      return a > b;
    default:
      return a >= b;
  }
}

const matches = (files, globs) =>
  files.some((f) => globs.some((g) => posix.matchesGlob(String(f), g)));

// The facts conditions read, each asked once per drive: `read` gives each a function
// ({ files, labels, head, ci, severity, changedSince(sha) }), the missing ones answering
// nothing (no file, no label, no CI, no severity).
export function facts(read = {}) {
  const kept = new Map();
  const once = (name, fallback) => (arg) => {
    const id = arg === undefined ? name : `${name}:${arg}`;
    if (!kept.has(id)) kept.set(id, Promise.resolve(read[name] ? read[name](arg) : fallback));
    return kept.get(id);
  };
  return {
    files: once("files", []),
    labels: once("labels", []),
    head: once("head", null),
    ci: once("ci", "none"),
    severity: once("severity", null),
    changedSince: once("changedSince", []),
  };
}

// Two copies of one instance → one: the later's position, the vars of both (max, OR), the ids
// either handled. Of two pull requests, the later's alone.
export function mergeInstances(a, b) {
  const [earlier, later] = (a.at ?? 0) > (b.at ?? 0) ? [b, a] : [a, b];
  if (earlier.pr !== later.pr) return later;
  const counters = { ...earlier.vars.counters };
  for (const [name, n] of Object.entries(later.vars.counters)) {
    counters[name] = Math.max(n, counters[name] ?? 0);
  }
  return {
    ...later,
    vars: { counters, flags: { ...later.vars.flags, ...earlier.vars.flags } },
    handled: [...new Set([...earlier.handled, ...later.handled])].slice(-MAX_HANDLED),
  };
}

// `instances`: the Map they are kept in (storeMap()'s), task key → { [event]: instance }, each
// instance { pr, event, workflow, vars: { counters, flags }, current: { id, head, at } | null,
// pc, started, waiting, loops, handled, at }. `maxRounds`: MAX_FIX_ROUNDS, every loop's ceiling.
export function createEngine({
  instances = new Map(),
  maxRounds = Infinity,
  log = () => {},
  now = Date.now,
}) {
  const load = (key, event) => {
    const kept = instances.get(key)?.[event];
    return kept ? structuredClone(kept) : null;
  };
  // Written whole after each step: the store keeps a copy, never the object being changed.
  const save = (key, inst) => {
    inst.at = now();
    instances.set(key, { ...instances.get(key), [inst.event]: structuredClone(inst) });
  };

  const fresh = (workflow, event, pr) => ({
    pr,
    event,
    workflow,
    vars: { counters: {}, flags: {} },
    current: null,
    pc: 0,
    started: null,
    waiting: null,
    loops: {},
    handled: [],
    at: now(),
  });

  // Whether `inst` waits for a run's end: its run step's, or one interrupted before it said so.
  function waitsOn(inst) {
    if (inst.waiting !== null && inst.waiting !== undefined) return true;
    if (inst.started === null || inst.started === undefined) return false;
    return !!compile(inst.workflow.steps)[inst.started]?.step?.run;
  }

  // What a step that acted changes: its counter, its flag (at the event's head).
  function took(inst, step) {
    if (step.count) inst.vars.counters[step.count] = (inst.vars.counters[step.count] ?? 0) + 1;
    if (step.set && !inst.vars.flags[step.set]) {
      inst.vars.flags[step.set] = { head: inst.current?.head ?? null, at: now() };
    }
  }

  // Event `event` ({ name, id, pr, head }) on task `key`: `workflow` runs it, unless the
  // instance has one already for that pull request. `io`: { act(step, view) → "done" | "wait"
  // | "refused" | "skipped", facts } (drive()). → "handled" (that id was), "waiting" (its run
  // going), "skipped" (an action took nothing: the same id goes on from there) or "done".
  async function trigger(key, workflow, event, io) {
    let inst = load(key, event.name);
    if (!inst || inst.pr !== event.pr) inst = fresh(workflow, event.name, event.pr);
    if (inst.handled.includes(event.id)) return "handled";
    if (inst.current?.id === event.id) {
      if (inst.waiting !== null) return "waiting";
    } else {
      // An action of the event left behind, marked started and never finished, counted still.
      if (inst.started !== null) took(inst, compile(inst.workflow.steps)[inst.started].step);
      inst.current = { id: event.id, head: event.head ?? null, at: now() };
      Object.assign(inst, { pc: 0, started: null, waiting: null, loops: {} });
    }
    return drive(key, inst, io);
  }

  // The run task `key`'s instance on `event` waits for has ended: its next steps. `head`: the
  // pull request's head now. → as trigger(), or "idle" when nothing waited.
  async function resume(key, event, io, head = null) {
    const inst = load(key, event);
    if (!inst || !waitsOn(inst)) return "idle";
    // A run step interrupted after its run was queued: that run's end is the step's.
    if (inst.waiting === null) {
      took(inst, compile(inst.workflow.steps)[inst.started].step);
      inst.pc = inst.started;
    }
    Object.assign(inst, { waiting: null, started: null });
    inst.pc += 1;
    if (head && inst.current) inst.current.head = head;
    return drive(key, inst, io);
  }

  async function drive(key, inst, io) {
    const ops = compile(inst.workflow.steps);
    const name = inst.workflow.file ?? "the built-in workflow";
    for (let n = 0; inst.pc < ops.length; n++) {
      if (n > MAX_OPS) throw new Error(`${key}: ${name} ran over ${MAX_OPS} steps`);
      const op = ops[inst.pc];
      if (op.op === "unless") {
        inst.pc = (await holds(op.cond, inst.vars, io.facts)) ? inst.pc + 1 : op.to;
      } else if (op.op === "jump") {
        inst.pc = op.to;
      } else if (op.op === "loop") {
        const value = inst.vars.counters[op.var] ?? 0;
        if (value >= Math.min(op.rounds, maxRounds)) {
          delete inst.loops[inst.pc];
          inst.pc = op.end;
          // Told, for what the built-in code said when its rounds ran out (reviews.mjs).
          await io.bounded?.(op);
        } else {
          inst.loops[inst.pc] = value;
          inst.pc += 1;
        }
      } else if (op.op === "next") {
        const loop = ops[op.head];
        // An iteration that counted nothing ends the loop rather than spin.
        const moved = (inst.vars.counters[loop.var] ?? 0) > (inst.loops[op.head] ?? Infinity);
        if (!moved) delete inst.loops[op.head];
        inst.pc = moved ? op.head : loop.end;
      } else {
        const result = await act(key, inst, op.step, io, ops);
        if (result) return result;
      }
    }
    inst.handled = [...inst.handled, inst.current?.id].filter(Boolean).slice(-MAX_HANDLED);
    Object.assign(inst, { current: null, pc: 0, loops: {} });
    save(key, inst);
    return "done";
  }

  // One action: null when the program goes on, else what drive() returns. Its outcome, beside
  // trigger()'s: "break" ends the loop it is in (outside any, as "refused"), "stop" the event's
  // steps (handled), both counting nothing.
  async function act(key, inst, step, io, ops) {
    // Started by an orchestrator that stopped before it ended. A comment: taken, not posted
    // again. A run: asked again, told so, as it may have stopped before or after queuing it.
    const interrupted = inst.started === inst.pc;
    if (interrupted && !step.run) {
      inst.started = null;
      took(inst, step);
      inst.pc += 1;
      save(key, inst);
      return null;
    }
    inst.started = inst.pc;
    save(key, inst);
    let outcome;
    try {
      outcome = await io.act(step, { key, vars: inst.vars, workflow: inst.workflow, interrupted });
    } catch (error) {
      inst.started = null;
      save(key, inst);
      throw error;
    }
    inst.started = null;
    if (outcome === "skipped") {
      save(key, inst);
      return "skipped";
    }
    if (outcome === "break" || outcome === "stop") {
      const loop = outcome === "break" ? enclosing(ops, inst.pc) : null;
      if (loop !== null) delete inst.loops[loop];
      inst.pc = outcome === "stop" ? ops.length : loop !== null ? ops[loop].end : inst.pc + 1;
      save(key, inst);
      return null;
    }
    if (outcome !== "refused") took(inst, step);
    if (outcome === "wait") {
      inst.waiting = inst.pc;
      save(key, inst);
      return "waiting";
    }
    if (outcome !== "done" && outcome !== "refused") {
      log(`${key}: a step said \`${outcome}\`, taken as done`);
    }
    inst.pc += 1;
    save(key, inst);
    return null;
  }

  // Task `key`'s instance on `event` waits for its run's end.
  const waiting = (key, event) => {
    const inst = instances.get(key)?.[event];
    return !!inst && waitsOn(inst);
  };

  // The step task `key`'s instance on `event` waits on (its run's end), or null.
  function waitingStep(key, event) {
    const inst = instances.get(key)?.[event];
    if (!inst || !waitsOn(inst)) return null;
    return compile(inst.workflow.steps)[inst.waiting ?? inst.started]?.step ?? null;
  }

  // Task `key`'s instance on `event` ({ name, pr, head }) placed to wait on the step `at(ops)`
  // picks (its index, or -1 for none), its instance `workflow`'s unless it has one for that pull
  // request: the run that ended there goes on with resume(). The loops it is in are taken as
  // having gone round, so their counter decides. Counts nothing: the run was counted when it
  // was queued, by the code that queued it. → whether it was placed.
  function place(key, workflow, { name, pr, head = null }, at) {
    let inst = load(key, name);
    if (!inst || inst.pr !== pr) inst = fresh(workflow, name, pr);
    const ops = compile(inst.workflow.steps);
    const pc = at(ops);
    if (!(pc >= 0) || ops[pc]?.op !== "act") return false;
    inst.current ??= { id: `placed:${now()}`, head, at: now() };
    const loops = {};
    ops.forEach((op, i) => {
      if (op.op === "loop" && i < pc && pc < op.end) loops[i] = -1;
    });
    Object.assign(inst, { pc, started: null, waiting: pc, loops });
    save(key, inst);
    return true;
  }

  // The run task `key`'s instance on `event` waited for ended without its workflow going on (a
  // fix that pushed nothing, CI no longer waited for): its event is over.
  function end(key, event) {
    const inst = load(key, event);
    if (!inst?.current) return;
    inst.handled = [...inst.handled, inst.current.id].slice(-MAX_HANDLED);
    Object.assign(inst, { current: null, pc: 0, started: null, waiting: null, loops: {} });
    save(key, inst);
  }

  // Pull request `pr` of task `key` is closed: its instances go.
  function forget(key, pr) {
    const kept = instances.get(key);
    if (!kept) return;
    const left = Object.fromEntries(Object.entries(kept).filter(([, inst]) => inst.pr !== pr));
    if (Object.keys(left).length === Object.keys(kept).length) return;
    if (Object.keys(left).length) instances.set(key, left);
    else instances.delete(key);
  }

  // The instances whose pull request isn't their task's open one any more (`open`: task key →
  // its open pull request's number) go: the `closed` delivery lost, or the task's pull request
  // replaced without one. → how many.
  function sweep(open) {
    let dropped = 0;
    for (const key of [...instances.keys()]) {
      const prs = new Set(Object.values(instances.get(key) ?? {}).map((inst) => inst.pr));
      for (const pr of prs) {
        if (open.get(key) === pr) continue;
        forget(key, pr);
        dropped += 1;
      }
    }
    return dropped;
  }

  // Rekeyed with spelled() (restart.mjs unifySpellings()): two spellings' instances merged.
  function respell(spelled) {
    respellMap(instances, spelled, undefined, (a, b) => {
      const both = { ...a, ...b };
      for (const event of Object.keys(both)) {
        if (a[event] && b[event]) both[event] = mergeInstances(a[event], b[event]);
      }
      return both;
    });
  }

  return {
    trigger,
    resume,
    waiting,
    waitingStep,
    place,
    end,
    forget,
    sweep,
    respell,
    instance: (key, event) => instances.get(key)?.[event] ?? null,
    keys: () => [...instances.keys()],
  };
}
