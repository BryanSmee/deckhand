// Workflows as data (#1040, stage 2 of #899): the format of a repo's `.deckhand/workflows/*.yaml`,
// read from its default branch (workflows.mjs) and run by the engine (workflow-engine.mjs). A
// workflow orders steps; it never says what a run may do: every step still asks the policies as
// the built-in code does (a rebase run its `deny_fix`), so a file can only narrow what happens.
//
// Everything is checked when the file is read, its errors naming the file and the line: a fixed
// vocabulary of events, steps and conditions (CONDITIONS), vars declared before use, loops
// bounded by a counter a step of theirs increments (MAX_FIX_ROUNDS still the ceiling, at run
// time), and one workflow per event across the repo's files and its built-in loop
// (checkTriggers()). Format: ../docs/repo-config/workflows.md.
import { createHash } from "node:crypto";
import { isMap, parseYaml, YamlError } from "../lib/yaml.mjs";
import { EFFORTS, MODEL_NAME } from "./events.mjs";
import { repoPath } from "./repo-config.mjs";
import { SEVERITIES } from "./severities.mjs";

// Where a repo's workflows are, on its default branch, and what a file's name is.
export const WORKFLOW_DIR = ".deckhand/workflows";
export const WORKFLOW_FILE = /^[A-Za-z0-9][A-Za-z0-9_.-]*\.yaml$/;

// Bounds: a workflow is a few steps, not a program.
export const MAX_FILE_BYTES = 32 * 1024;
export const MAX_FILES = 20;
const MAX_STEPS = 50;
const MAX_DEPTH = 5;
const MAX_COMMENT = 4000;
const MAX_CONDITION = 500;

// The events a workflow can start on. `steps`: what its `run:` may name; `comments`: Deckhand's
// own comments its `comment:` may name instead of a text.
export const EVENTS = {
  // The conflict watcher found the pull request in conflict with its base, at a (head, base)
  // pair not tried yet (conflicts.mjs). Needs `conflicts.check_minutes`, which turns it on.
  conflict: { steps: ["rebase"], comments: [] },
  // A pull request turned ready, at a head not reviewed yet (reviews.mjs, #1041): the review
  // loop. Deckhand's own workflow compiled from `review:` (reviewWorkflow()), or the repo's.
  ready: { steps: ["ci", "review", "fix", "merge"], comments: ["rounds-out"] },
};

// The steps a workflow runs. `rebase`: the conflict run (conflicts.mjs), which waits for its
// run's end before the next step. The review loop's (reviews.mjs): `ci`, its CI step (the head's
// Actions runs waited for, CI fix runs as `review.ci_fix` allows); `review`, a review run;
// `fix`, a fix run of the last review's findings, which ends the loop it is in when none
// starts; `merge`, the auto-merge decided. Each but `merge` waits for its run's end.
export const RUN_STEPS = ["rebase", "ci", "review", "fix", "merge"];

// What a step may say of its run, beside the repo's defaults (`review.agent`…, `agent`…): the
// review and fix runs' agent, model and effort, a review's instructions.
const STEP_OPTIONS = {
  review: ["agent", "model", "effort", "instructions"],
  fix: ["agent", "model", "effort"],
};

// What a condition may ask, beside the workflow's own vars: the fixed vocabulary.
// - severity: the pull request's last review's most severe finding (none outside the review
//   loop): `severity <= medium` (low is the least severe);
// - ci: its head's CI, passed, failed, running or none: `ci == passed`;
// - paths("glob", …): a file the pull request changes matches one;
// - label("name", …): the pull request has one of the labels;
// - changed("glob", …, since flag): as paths(), but only the files changed since the head the
//   flag was set at (all of them while it isn't set);
// - a counter compared with a whole number (`rebases < 3`), a flag alone (`not warned`).
export const CONDITIONS = ["severity", "ci", "paths", "label", "changed"];
const CI_STATES = ["passed", "failed", "running", "none"];
// What `severity` compares with: `none`, a review without findings, below low.
const LEVELS = [...SEVERITIES, "none"];
const OPERATORS = ["==", "!=", "<=", ">=", "<", ">"];
const WORDS = new Set(["and", "or", "not", "since", ...CONDITIONS]);
const VAR = /^[a-z_][a-z0-9_]*$/;
const VAR_TYPES = ["counter", "flag"];

const TOP_KEYS = ["on", "vars", "steps"];
const STEP_KEYS = [
  "if",
  "run",
  "comment",
  "then",
  "else",
  "count",
  "set",
  "repeat",
  "max",
  "agent",
  "model",
  "effort",
  "instructions",
];

// Deckhand's own workflow on `conflict`: what `conflicts.check_minutes` runs in a repo with no
// workflow of its own on that event. Parsed like any other, so the format runs it too.
export const BUILT_IN_CONFLICTS = `# Deckhand's built-in conflicts workflow.
on: conflict
steps:
  - run: rebase
`;

// One workflow file → { workflow, errors }: `workflow` (null with errors) is
// { name, file, version, on, line, vars, steps }, each step { line, if?, run?, comment?, say?,
// count?, set?, then?, else?, repeat?, max?, agent?, model?, effort?, instructions? }, its
// conditions parsed (parseCondition()), `say` the name of Deckhand's own comment. `name`: the
// file's, without .yaml; `version`: its text's sha256, which an instance keeps (workflow-engine.mjs).
// Each error is { file, line, message }, line null when the file as a whole is wrong. `agents`:
// the agents the operator runs, which a step's `agent` must be one of (unchecked without).
export function parseWorkflow(name, text, { agents = null } = {}) {
  const file = `${WORKFLOW_DIR}/${name}`;
  const errors = [];
  const fail = (line, message) => errors.push({ file, line: line ?? null, message });
  if (Buffer.byteLength(String(text)) > MAX_FILE_BYTES) {
    fail(null, `over ${MAX_FILE_BYTES / 1024} KB`);
    return { workflow: null, errors };
  }
  const where = new Map();
  let doc;
  try {
    doc = parseYaml(text, where);
  } catch (error) {
    if (!(error instanceof YamlError)) throw error;
    const [, line, message] = /^line (\d+): (.*)$/s.exec(error.message) ?? [];
    fail(line ? Number(line) : null, message ?? error.message);
    return { workflow: null, errors };
  }
  // The line of a dotted path, else of the nearest parent that has one.
  const lineOf = (path) => {
    for (let at = path; at; at = at.includes(".") ? at.slice(0, at.lastIndexOf(".")) : "") {
      if (where.has(at)) return where.get(at);
    }
    return null;
  };
  if (!isMap(doc)) {
    fail(null, "expected a mapping with `on` and `steps`");
    return { workflow: null, errors };
  }
  for (const key of Object.keys(doc)) {
    if (!TOP_KEYS.includes(key))
      fail(lineOf(key), `unknown key \`${key}\` (expected ${list(TOP_KEYS)})`);
  }
  const on = parseOn(doc.on, lineOf("on"), fail);
  const vars = parseVars(doc.vars, lineOf, fail);
  const context = { vars, on, lineOf, fail, count: 0, agents };
  let steps = [];
  if (!Array.isArray(doc.steps) || !doc.steps.length) {
    fail(lineOf("steps"), "`steps`: expected a list of steps");
  } else {
    steps = parseSteps(doc.steps, "steps", 1, context);
    if (context.count > MAX_STEPS) fail(lineOf("steps"), `over ${MAX_STEPS} steps`);
  }
  if (errors.length) return { workflow: null, errors };
  const workflow = {
    name: name.replace(/\.yaml$/, ""),
    file,
    version: createHash("sha256").update(String(text)).digest("hex"),
    on,
    line: lineOf("on"),
    vars,
    steps,
  };
  return { workflow, errors };
}

// `on`: one event, or a list of them, each known.
function parseOn(value, line, fail) {
  const events = typeof value === "string" ? [value] : value;
  if (!Array.isArray(events) || !events.length) {
    fail(line, `\`on\`: expected an event (${list(Object.keys(EVENTS))})`);
    return [];
  }
  const out = [];
  for (const event of events) {
    if (typeof event !== "string" || !Object.hasOwn(EVENTS, event)) {
      fail(line, `\`on\`: unknown event \`${event}\` (expected ${list(Object.keys(EVENTS))})`);
    } else if (out.includes(event)) {
      fail(line, `\`on\`: \`${event}\` twice`);
    } else out.push(event);
  }
  return out;
}

// `vars`: name → counter or flag.
function parseVars(value, lineOf, fail) {
  const vars = {};
  if (value === undefined || value === null) return vars;
  if (!isMap(value)) {
    fail(lineOf("vars"), "`vars`: expected each var's name and type (counter or flag)");
    return vars;
  }
  for (const [name, type] of Object.entries(value)) {
    const line = lineOf(`vars.${name}`);
    if (!VAR.test(name) || WORDS.has(name)) {
      fail(
        line,
        `\`vars.${name}\`: a var's name is lowercase letters, digits and _, not a word of the conditions`,
      );
    } else if (!VAR_TYPES.includes(type)) {
      fail(line, `\`vars.${name}\`: expected counter or flag`);
    } else vars[name] = type;
  }
  return vars;
}

function parseSteps(items, path, depth, context) {
  const { lineOf, fail } = context;
  if (depth > MAX_DEPTH) {
    fail(lineOf(path), `steps nested deeper than ${MAX_DEPTH}`);
    return [];
  }
  const steps = [];
  items.forEach((item, i) => {
    const at = `${path}.${i}`;
    context.count += 1;
    const step = parseStep(item, at, depth, context);
    if (step) steps.push(step);
  });
  return steps;
}

function parseStep(item, at, depth, context) {
  const { vars, on, lineOf, fail } = context;
  const line = lineOf(at);
  if (!isMap(item)) {
    fail(line, "expected a step: `run`, `comment`, `if` with `then`, or `repeat`");
    return null;
  }
  for (const key of Object.keys(item)) {
    if (!STEP_KEYS.includes(key)) {
      fail(
        lineOf(`${at}.${key}`),
        `unknown key \`${key}\` in a step (expected ${list(STEP_KEYS)})`,
      );
    }
  }
  const kinds = ["run", "comment", "then", "repeat"].filter((k) => k in item);
  if (kinds.length !== 1) {
    fail(
      line,
      kinds.length
        ? `one of ${list(kinds)} per step, not both`
        : "a step needs `run`, `comment`, `then` (with `if`) or `repeat`",
    );
    return null;
  }
  const [kind] = kinds;
  const step = { line };
  if ("if" in item) {
    if (kind === "repeat")
      fail(lineOf(`${at}.if`), "a `repeat` takes no `if`: put it under a `then`");
    else step.if = condition(item.if, lineOf(`${at}.if`), context);
  }
  if ("else" in item && !("if" in item)) fail(lineOf(`${at}.else`), "`else` needs an `if`");
  if (kind === "then" && !("if" in item)) fail(lineOf(`${at}.then`), "`then` needs an `if`");
  for (const key of ["then", "else", "repeat"]) {
    if (!(key in item)) continue;
    if (!Array.isArray(item[key]) || !item[key].length) {
      fail(lineOf(`${at}.${key}`), `\`${key}\`: expected a list of steps`);
    } else step[key] = parseSteps(item[key], `${at}.${key}`, depth + 1, context);
  }
  if (kind === "run") {
    const allowed = on.flatMap((e) => EVENTS[e]?.steps ?? []);
    if (!RUN_STEPS.includes(item.run)) {
      fail(
        lineOf(`${at}.run`),
        `\`run\`: unknown step \`${item.run}\` (expected ${list(RUN_STEPS)})`,
      );
    } else if (on.length && !allowed.includes(item.run)) {
      fail(lineOf(`${at}.run`), `\`run: ${item.run}\` doesn't run on ${list(on)}`);
    } else step.run = item.run;
  }
  if (kind === "comment") {
    const text = item.comment;
    if (typeof text !== "string" || !text.trim() || text.length > MAX_COMMENT) {
      fail(
        lineOf(`${at}.comment`),
        `\`comment\`: expected its text, at most ${MAX_COMMENT} characters`,
      );
    } else {
      step.comment = text;
      // Deckhand's own text by its name, on the events that have it.
      if (on.some((e) => EVENTS[e]?.comments.includes(text.trim()))) step.say = text.trim();
    }
  }
  stepOptions(item, step, kind, at, context);
  for (const [key, type] of [
    ["count", "counter"],
    ["set", "flag"],
  ]) {
    if (!(key in item)) continue;
    if (kind !== "run" && kind !== "comment") {
      fail(lineOf(`${at}.${key}`), `\`${key}\` goes on a \`run\` or \`comment\` step`);
    } else if (vars[item[key]] !== type) {
      fail(lineOf(`${at}.${key}`), `\`${key}\`: expected a ${type} declared under \`vars\``);
    } else step[key] = item[key];
  }
  if ("max" in item && kind !== "repeat") fail(lineOf(`${at}.max`), "`max` goes with `repeat`");
  if (kind === "repeat") {
    const match = typeof item.max === "string" ? /^\s*(\S+)\s+(\d+)\s*$/.exec(item.max) : null;
    if (!match) {
      fail(
        lineOf(`${at}.max`) ?? line,
        "an unbounded loop: `repeat` needs `max: <counter> <rounds>`",
      );
    } else if (vars[match[1]] !== "counter") {
      fail(lineOf(`${at}.max`), `\`max\`: \`${match[1]}\` isn't a counter declared under \`vars\``);
    } else if (Number(match[2]) < 1) {
      fail(lineOf(`${at}.max`), "`max`: expected at least 1 round");
    } else if (step.repeat && !counts(step.repeat, match[1])) {
      fail(
        lineOf(`${at}.max`),
        `an unbounded loop: no step of the \`repeat\` counts \`${match[1]}\` (\`count: ${match[1]}\`)`,
      );
    } else step.max = { var: match[1], rounds: Number(match[2]) };
  }
  return step;
}

// A `run` step's own agent, model, effort and instructions (STEP_OPTIONS), into `step`.
function stepOptions(item, step, kind, at, { lineOf, fail, agents }) {
  for (const key of ["agent", "model", "effort", "instructions"]) {
    if (!(key in item)) continue;
    const value = item[key];
    const bad = (what) => fail(lineOf(`${at}.${key}`), `\`${key}\`: ${what}`);
    if (kind !== "run" || !STEP_OPTIONS[item.run]?.includes(key)) {
      const takes = Object.entries(STEP_OPTIONS).filter(([, keys]) => keys.includes(key));
      bad(`goes on a ${takes.map(([run]) => `\`run: ${run}\``).join(" or ")} step`);
    } else if (key === "agent") {
      const name = typeof value === "string" ? value.trim().toLowerCase() : "";
      if (!/^[a-z][a-z0-9-]*$/.test(name)) bad("expected an agent's name");
      else if (agents && !agents.includes(name)) {
        bad(`the operator hasn't configured \`${name}\` (configured: ${agents.join(", ")})`);
      } else step.agent = name;
    } else if (key === "model") {
      if (typeof value === "string" && MODEL_NAME.test(value)) step.model = value;
      else
        bad("expected a model tier (best, balanced, fast) or name (opus, claude-…, openai/gpt-…)");
    } else if (key === "effort") {
      const effort = String(value).toLowerCase();
      if (EFFORTS.includes(effort)) step.effort = effort;
      else bad(`expected one of ${EFFORTS.join(", ")}`);
    } else {
      const path = repoPath(value);
      if (path) step.instructions = path;
      else bad("expected a path in the repository (relative, no ..)");
    }
  }
}

// Whether a step of `steps` (nested ones too) increments `counter`.
function counts(steps, counter) {
  return steps.some(
    (s) =>
      s.count === counter ||
      [s.then, s.else, s.repeat].some((inner) => inner && counts(inner, counter)),
  );
}

function condition(value, line, { vars, fail }) {
  if (typeof value !== "string" || !value.trim() || value.length > MAX_CONDITION) {
    fail(line, `\`if\`: expected a condition, at most ${MAX_CONDITION} characters`);
    return null;
  }
  try {
    return parseCondition(value, vars);
  } catch (error) {
    if (!(error instanceof ConditionError)) throw error;
    fail(line, `\`if\`: ${error.message}`);
    return null;
  }
}

export class ConditionError extends Error {}

// A condition's text → its tree: { and: [a, b] }, { or: [a, b] }, { not: a },
// { cmp: "severity" | "ci" | <counter>, op, value }, { flag }, { call: "paths" | "label" |
// "changed", args: [string], since? }. `vars`: the workflow's, name → type.
export function parseCondition(text, vars = {}) {
  const tokens = tokenize(text);
  let i = 0;
  const peek = () => tokens[i];
  const next = () => tokens[i++];
  const expect = (type, value) => {
    const t = next();
    if (!t || t.type !== type || (value !== undefined && t.value !== value)) {
      throw new ConditionError(
        `expected ${value ?? type}${t ? `, not \`${t.value}\`` : " at the end"}`,
      );
    }
    return t;
  };
  const word = (value) => peek()?.type === "word" && peek().value === value;

  function or() {
    let left = and();
    while (word("or")) {
      next();
      left = { or: [left, and()] };
    }
    return left;
  }
  function and() {
    let left = unary();
    while (word("and")) {
      next();
      left = { and: [left, unary()] };
    }
    return left;
  }
  function unary() {
    if (word("not")) {
      next();
      return { not: unary() };
    }
    return primary();
  }
  function primary() {
    const t = next();
    if (!t) throw new ConditionError("a condition ends too soon");
    if (t.type === "(") {
      const inner = or();
      expect(")");
      return inner;
    }
    if (t.type !== "word") throw new ConditionError(`unexpected \`${t.value}\``);
    if (peek()?.type === "(") return call(t.value);
    if (t.value === "severity" || t.value === "ci") return comparison(t.value);
    if (vars[t.value] === "counter") return comparison(t.value);
    if (vars[t.value] === "flag") return { flag: t.value };
    throw new ConditionError(
      `unknown condition \`${t.value}\` (expected ${list(CONDITIONS)}, or a var declared under \`vars\`)`,
    );
  }
  function comparison(subject) {
    const op = next();
    if (!op || op.type !== "op") {
      throw new ConditionError(`\`${subject}\` needs a comparison (${OPERATORS.join(" ")})`);
    }
    const value = next();
    if (subject === "severity") {
      if (value?.type !== "word" || !LEVELS.includes(value.value)) {
        throw new ConditionError(`\`severity\` compares with ${list(LEVELS)}`);
      }
      return { cmp: subject, op: op.value, value: value.value };
    }
    if (subject === "ci") {
      if (!["==", "!="].includes(op.value)) throw new ConditionError("`ci` takes == or !=");
      if (value?.type !== "word" || !CI_STATES.includes(value.value)) {
        throw new ConditionError(`\`ci\` is one of ${list(CI_STATES)}`);
      }
      return { cmp: subject, op: op.value, value: value.value };
    }
    if (value?.type !== "number") {
      throw new ConditionError(`\`${subject}\` is a counter: compare it with a whole number`);
    }
    return { cmp: subject, op: op.value, value: value.value };
  }
  function call(name) {
    if (!["paths", "label", "changed"].includes(name)) {
      throw new ConditionError(
        `unknown condition \`${name}()\` (expected ${list(["paths()", "label()", "changed()"])})`,
      );
    }
    expect("(");
    const args = [];
    let since = null;
    while (peek() && peek().type !== ")") {
      if (args.length || since) expect(",");
      if (name === "changed" && word("since")) {
        next();
        // `since flag`: YAML takes `since: flag` only in a quoted condition.
        if (peek()?.type === ":") next();
        const flag = expect("word").value;
        if (vars[flag] !== "flag") {
          throw new ConditionError(`\`since\`: \`${flag}\` isn't a flag declared under \`vars\``);
        }
        since = flag;
        continue;
      }
      if (since) throw new ConditionError("`since:` comes last");
      args.push(expect("string").value);
    }
    expect(")");
    if (!args.length) throw new ConditionError(`\`${name}()\` needs at least one quoted value`);
    return { call: name, args, ...(since && { since }) };
  }

  const tree = or();
  if (i < tokens.length) throw new ConditionError(`unexpected \`${tokens[i].value}\``);
  return tree;
}

function tokenize(text) {
  const tokens = [];
  const re =
    /\s*(?:(==|!=|<=|>=|<|>)|([(),:])|"([^"]*)"|'([^']*)'|(\d+)|([A-Za-z_][A-Za-z0-9_]*)|(\S))/gy;
  const source = text.trimEnd();
  let match;
  while (re.lastIndex < source.length && (match = re.exec(source))) {
    const [, op, punct, dq, sq, number, word, other] = match;
    if (op) tokens.push({ type: "op", value: op });
    else if (punct) tokens.push({ type: punct, value: punct });
    else if (dq !== undefined || sq !== undefined) tokens.push({ type: "string", value: dq ?? sq });
    else if (number) tokens.push({ type: "number", value: Number(number) });
    else if (word) tokens.push({ type: "word", value: word });
    else if (other) throw new ConditionError(`unexpected \`${other}\``);
  }
  return tokens;
}

// The repo's parsed workflows (with their files' errors so far) → the errors of more than one
// trigger for an event: two workflows on it, whatever their conditions, or one on `ready` while
// the built-in loop has it (`review.on: ready`). A workflow on `ready` also needs the `review`
// block, whose settings its steps read (tolerance, waits, merge method, the reviews' agent).
// `settings`: the repo's.
export function checkTriggers(workflows, settings) {
  const errors = [];
  const first = new Map();
  for (const w of workflows) {
    for (const event of w.on) {
      const fail = (message) => errors.push({ file: w.file, line: w.line, message });
      if (event === "ready" && settings?.review?.on === "ready") {
        fail(
          "two triggers for `ready`: this workflow and the built-in review loop (`review.on: ready`)",
        );
      } else if (event === "ready" && settings && !settings.review) {
        fail(
          "`ready` needs the repository's `review:` block in .deckhand.yaml (the reviews' settings), without `on: ready`",
        );
      } else if (first.has(event)) {
        const other = first.get(event);
        fail(
          `two triggers for \`${event}\`: this workflow and \`${other.file}\` (line ${other.line})`,
        );
      } else first.set(event, w);
    }
  }
  return errors;
}

// A workflow error as the config check and the logs say it.
export function errorText({ file, line, message }) {
  return `\`${file}\`${line ? ` line ${line}` : ""}: ${message}`;
}

// The built-in workflow on `event`, parsed once per text; null when the event has none: on
// `ready`, the review loop `settings`' `review:` block compiles to (reviewWorkflow()), none
// without `review.on: ready`.
const builtIns = new Map();
export function builtInWorkflow(event, settings = null) {
  const text =
    event === "conflict"
      ? BUILT_IN_CONFLICTS
      : event === "ready"
        ? reviewWorkflow(settings?.review)
        : null;
  if (!text) return null;
  if (!builtIns.has(text)) {
    const { workflow, errors } = parseWorkflow(`built-in-${event}.yaml`, text);
    if (errors.length) throw new Error(errors.map(errorText).join("; "));
    // A few shapes per repo's settings: kept, not grown.
    if (builtIns.size >= 100) builtIns.delete(builtIns.keys().next().value);
    builtIns.set(text, { ...workflow, name: "built-in", file: null, text });
  }
  return builtIns.get(text);
}

// The review loop a repo's `review:` block (repo-config.mjs parseReview()) stands for, as a
// workflow on `ready`: its text, null without `review.on: ready`. The steps the built-in code
// ran in that order before it moved onto the engine (#1041): the CI step with `review.ci: wait`,
// the review, then with `review.fix` its fix runs, each reviewed again when the loop has more
// than one round or merges (`fix: true` without `merge` leaves its one fix run unreviewed, as
// before, #376), and the merge with `review.merge`, else the comment saying the rounds ran out.
export function reviewWorkflow(review) {
  if (review?.on !== "ready") return null;
  const ci = review.ci === "wait";
  const rounds = review.fix ? Math.max(1, review.fixRounds ?? 1) : 0;
  const loop = rounds > 1 || (rounds === 1 && review.merge);
  const ciStep = (indent) =>
    `${indent}- run: ci # review.ci: wait, ci_wait: ${review.ciWait ?? 30}${rounds ? `, ci_fix: ${review.ciFix ?? 1}` : ""}`;
  const lines = [
    "# Deckhand's built-in review loop, compiled from the repository's `review:` block.",
    "on: ready",
  ];
  if (rounds) lines.push("vars:", "  fixes: counter");
  lines.push("steps:");
  if (ci) lines.push(ciStep("  "));
  lines.push("  - run: review");
  if (loop) {
    lines.push(
      "  - repeat:",
      "      - run: fix # ends the loop when no fix run starts",
      "        count: fixes",
    );
    if (ci) lines.push(ciStep("      "));
    lines.push("      - run: review", `    max: fixes ${rounds} # review.fix`);
  } else if (rounds) {
    lines.push(
      "  - run: fix # review.fix: true without review.merge: its push isn't reviewed",
      "    count: fixes",
    );
  }
  if (review.merge)
    lines.push("  - run: merge # review.merge, with the operator's auto_merge grant");
  else if (rounds) lines.push("  - comment: rounds-out # the last review still requests changes");
  return `${lines.join("\n")}\n`;
}

const list = (items) => items.map((i) => `\`${i}\``).join(", ");
