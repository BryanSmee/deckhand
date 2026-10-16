import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { BUILT_IN, entryRun, sessionName } from "../listener/modes.mjs";
import { modeNames, RESERVED_MODES } from "../listener/repo-config.mjs";

test("built-in modes: one list, which the dashboard's copy follows", () => {
  assert.deepEqual([...BUILT_IN], RESERVED_MODES);
  assert.ok(RESERVED_MODES.includes("onboarding"));
  // "/mode" picks only some of them.
  assert.deepEqual(modeNames(null), ["work", "brainstorm", "onboarding"]);
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
});

test("entryRun: only the ideas and bugs inboxes' entries are a run each", () => {
  assert.equal(entryRun("idea"), true);
  assert.equal(entryRun("bug"), true);
  for (const mode of ["discussion", "brainstorm", "work", "stop", "review"]) {
    assert.equal(entryRun(mode), false, mode);
  }
});
