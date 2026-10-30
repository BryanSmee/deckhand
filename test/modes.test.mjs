import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
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

test("work runs and the repo's other modes manage their issues' labels as a brainstorm does", () => {
  const { work, brainstorm } = Object.fromEntries(
    ["work", "brainstorm"].map((m) => [m, MODES[m].ceiling]),
  );
  assert.deepEqual(work.label, brainstorm.label);
  assert.deepEqual(work.label, ["create"]);
  for (const kind of ["own_issue", "sub_issue", "created_issue"]) {
    assert.ok(work[kind].includes("label"), kind);
  }
  // Not another's issue, and never a label's settings.
  assert.equal(work.other_issue, undefined);
  assert.ok(!work.label.includes("edit") && !work.label.includes("delete"));
});
