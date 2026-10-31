import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { BUILT_IN, entryRun, MODES, sessionName } from "../listener/modes.mjs";
import { modeNames, RESERVED_MODES } from "../listener/repo-config.mjs";

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

test("light runs have volumes of their own, apart from work's", () => {
  assert.equal(sessionName("deckhand-org-repo-12", false), "deckhand-org-repo-12");
  assert.equal(sessionName("deckhand-org-repo-12", true), "deckhand-org-repo-12-light");
  // Research runs' own again: what a web page leaves there never runs with a token.
  assert.equal(
    sessionName("deckhand-org-repo-12", true, "research"),
    "deckhand-org-repo-12-research",
  );
  assert.equal(
    sessionName("deckhand-org-repo-12", true, "brainstorm"),
    "deckhand-org-repo-12-light",
  );
});

test("entryRun: only the ideas and bugs inboxes' entries are a run each", () => {
  assert.equal(entryRun("idea"), true);
  assert.equal(entryRun("bug"), true);
  for (const mode of ["discussion", "brainstorm", "work", "stop", "audit"]) {
    assert.equal(entryRun(mode), false, mode);
  }
});

test("every built-in mode's prompt is in prompts/, and copied into the listener's image", () => {
  // The Dockerfile names each file: one left out stops the listener at start.
  const dockerfile = readFileSync(new URL("../listener/Dockerfile", import.meta.url), "utf8");
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

test("no mode holds a write ceiling or an issue label: the policies' per-mode files do", async () => {
  const modes = await import("../listener/modes.mjs");
  for (const name of ["ceilingOf", "issueLabelOf"]) assert.equal(modes[name], undefined, name);
  for (const [name, mode] of Object.entries(MODES)) {
    for (const trait of ["ceiling", "issueLabel"]) assert.ok(!(trait in mode), `${name}: ${trait}`);
    // A token only reads: each write gets its own (github-writes.mjs writePermissions()).
    for (const level of Object.values(mode.permissions || {})) assert.equal(level, "read", name);
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
