import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import {
  APART,
  brainstormDefaults,
  BUILT_IN,
  customMode,
  entryRun,
  isApart,
  MODES,
  RESEARCH,
} from "../listener/modes.mjs";
import { modeNames, RESERVED_MODES } from "../listener/repo-config.mjs";
import { sessionName } from "../listener/sandbox-spec.mjs";

test("built-in modes: one list, which the dashboard's copy follows", () => {
  assert.deepEqual([...BUILT_IN], RESERVED_MODES);
  assert.ok(RESERVED_MODES.includes("onboarding"));
  // "/mode" picks only some of them.
  assert.deepEqual(modeNames(null), ["work", "brainstorm", "onboarding", "research", "policy"]);
  // The dashboard (format.ts) can't import the listener: its copy is checked here.
  const source = readFileSync(new URL("../dashboard/src/format.ts", import.meta.url), "utf8");
  const copy = /export const BUILT_IN_MODES = (\[[^\]]*\])/.exec(source);
  assert.ok(copy, "format.ts exports BUILT_IN_MODES");
  assert.deepEqual(
    [...copy[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]),
    RESERVED_MODES,
  );
});

test("modes apart from work have volumes of their own, research's apart again", () => {
  assert.equal(sessionName("deckhand-org-repo-12", "work"), "deckhand-org-repo-12");
  assert.equal(sessionName("deckhand-org-repo-12", "brainstorm"), "deckhand-org-repo-12-light");
  assert.equal(sessionName("deckhand-org-repo-12", "review"), "deckhand-org-repo-12-light");
  // Research runs' own again: what a web page leaves there never runs with a token.
  assert.equal(sessionName("deckhand-org-repo-12", "research"), "deckhand-org-repo-12-research");
  // The repo's own modes share the issue's, as their capabilities pick them.
  assert.equal(sessionName("deckhand-org-repo-12", "audit"), "deckhand-org-repo-12");
  assert.deepEqual([...RESEARCH], ["research"]);
  assert.ok(!APART.has("work") && !APART.has("policy") && APART.has("research"));
  // A brainstorm, its wrap-up and onboarding are light runs (runs.mjs newLive()); work and the
  // repo's own modes aren't.
  for (const mode of ["brainstorm", "stop", "onboarding"]) assert.equal(isApart(mode), true, mode);
  for (const mode of ["work", "audit"]) assert.equal(isApart(mode), false, mode);
});

test("a mode's defaults: the light runs' agent, model and effort, or work's", () => {
  const settings = {
    agent: "claude",
    model: "opus",
    effort: "high",
    brainstormAgent: "codex",
    brainstormModel: "fast",
    brainstormEffort: "low",
    review: {},
    modes: { audit: { session: "fresh" }, own: { agent: "codex", model: "x", effort: "max" } },
  };
  assert.equal(brainstormDefaults("brainstorm"), true);
  assert.equal(brainstormDefaults("work"), false);
  assert.equal(brainstormDefaults("audit"), false);
  // A review takes the light runs'; the repo's own modes work's, unless they say otherwise.
  assert.deepEqual(
    [customMode(settings, "review").agent, customMode(settings, "review").model],
    ["codex", "fast"],
  );
  const audit = customMode(settings, "audit");
  assert.deepEqual(
    [audit.agent, audit.model, audit.effort, audit.fresh],
    ["claude", "opus", "high", true],
  );
  const own = customMode(settings, "own");
  assert.deepEqual([own.agent, own.model, own.effort, own.fresh], ["codex", "x", "max", false]);
});

test("no mode says what its runs may do: no light, open, permissions, ceiling or issue label", async () => {
  const modes = await import("../listener/modes.mjs");
  for (const name of ["LIGHT", "OPEN", "isLight", "ceilingOf", "issueLabelOf"]) {
    assert.equal(modes[name], undefined, name);
  }
  for (const [name, mode] of Object.entries(MODES)) {
    for (const trait of ["light", "open", "permissions", "ceiling", "issueLabel"]) {
      assert.ok(!(trait in mode), `${name}: ${trait}`);
    }
  }
  // Nor a repo's own mode.
  const own = customMode({ modes: { audit: { light: true } } }, "audit");
  assert.ok(!("light" in own));
  const source = readFileSync(new URL("../listener/modes.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\b(light|open|permissions|ceiling)\b\s*:/);
});

test("entryRun: only the ideas and bugs inboxes' entries are a run each", () => {
  assert.equal(entryRun("idea"), true);
  assert.equal(entryRun("bug"), true);
  for (const mode of ["discussion", "brainstorm", "work", "stop", "audit"]) {
    assert.equal(entryRun(mode), false, mode);
  }
});

test("every built-in mode's prompt is in prompts/, and copied into the orchestrator's image", () => {
  // The Dockerfile names each file: one left out stops the orchestrator at start.
  const dockerfile = readFileSync(new URL("../orchestrator/Dockerfile", import.meta.url), "utf8");
  for (const [name, { prompt }] of Object.entries(MODES)) {
    if (!prompt) continue;
    assert.ok(existsSync(new URL(`../prompts/${prompt}`, import.meta.url)), name);
    assert.match(
      dockerfile,
      new RegExp(`^COPY .*\\bprompts/${prompt.replace(".", "\\.")}\\b`, "m"),
      name,
    );
  }
});

// The actions a mode's file allows: its `*_writes` sets, and those its other allow rules name.
function allowedActions(text) {
  const actions = new Set();
  const writes = /^\w+_writes := \{([\s\S]*?)^\}/m.exec(text)?.[1] ?? "";
  for (const [, set] of writes.matchAll(/\{([^{}]*)\}/g)) {
    for (const [, a] of set.matchAll(/"([^"]+)"/g)) actions.add(a);
  }
  for (const [, rest] of text.matchAll(/input\.actions? (?:==|in) ([^\n]*)/g)) {
    for (const [, a] of rest.matchAll(/"([^"]+)"/g)) actions.add(a);
  }
  return actions;
}

// It checks that the actions are named, not under which kind of target: the rows are prose
// ("its pull requests: the same but `link`, and …"), which a parser would have to follow.
test("docs/repo-config.md's table names each mode's file and every action it allows", () => {
  const docs = readFileSync(new URL("../docs/repo-config.md", import.meta.url), "utf8");
  const input = docs.slice(docs.indexOf("### The GitHub input"));
  const table = input.slice(
    input.indexOf("| Mode "),
    input.indexOf("\n\n", input.indexOf("| Mode ")),
  );
  const rows = table.split("\n");
  const list = /^\| `action` .*$/m.exec(input)?.[0] ?? "";
  const dir = new URL("../policy/", import.meta.url);
  const files = readdirSync(dir).filter((f) => /^mode-.*\.rego$/.test(f));
  let writing = 0;
  for (const file of files) {
    const text = readFileSync(new URL(file, dir), "utf8");
    if (!/^allow_github\b/m.test(text)) continue;
    writing++;
    const row = rows.find((line) => line.includes(`${file}`));
    assert.ok(row, `the table has a row for ${file}`);
    for (const action of allowedActions(text)) {
      if (action === "read_projects") continue;
      assert.ok(row.includes(`\`${action}\``), `${file}'s row names ${action}`);
      assert.ok(list.includes(`\`${action}\``), `the action list names ${action}`);
    }
  }
  assert.ok(writing >= 4, "work, brainstorm, the inboxes and discussions write");
});
