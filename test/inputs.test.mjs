import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createInputs } from "../listener/inputs.mjs";
import { tempDir } from "./helpers.mjs";

const issue = (number, extra = {}) => ({
  number,
  title: `Issue ${number}`,
  updated_at: "2026-10-15T12:00:00Z",
  ...extra,
});

test("issues waiting for input: from webhooks, kept across a restart", (t) => {
  const path = join(tempDir(t), "inputs.json");
  let clock = 1000;
  const inputs = createInputs({ path, listLabelled: async () => [], now: () => clock });
  inputs.set("org/repo#1", true);
  clock = 2000;
  // Labelled again: still since the first time.
  inputs.set("org/repo#1", true);
  inputs.set("org/repo#2", true);
  inputs.set("org/repo#2", false);
  inputs.set("org/repo#3", false);
  assert.deepEqual(inputs.list(), [
    { key: "org/repo#1", repo: "org/repo", since: 1000, questions: null },
  ]);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
    "org/repo#1": { since: 1000, questions: null },
  });
  // Its questions, then an edit to them; an issue not listed isn't added by one.
  const asked = { items: null, raw: "Which one?" };
  inputs.set("org/repo#1", true, asked);
  inputs.set("org/repo#1", true);
  inputs.update("org/repo#5", asked);
  assert.deepEqual(inputs.list(), [
    { key: "org/repo#1", repo: "org/repo", since: 1000, questions: asked },
  ]);
  inputs.update("org/repo#1", null);
  assert.equal(inputs.list()[0].questions, null);
  inputs.update("org/repo#1", asked);
  const again = createInputs({ path, listLabelled: async () => [] });
  assert.equal(again.has("org/repo#1"), true);
  assert.deepEqual(again.list()[0].questions, asked);
});

test("the startup lookup adds labels added meanwhile and drops those removed", async (t) => {
  const path = join(tempDir(t), "inputs.json");
  const lists = {
    "org/repo": [
      issue(2, { body: "## Open questions\n\n1. Which one?" }),
      issue(3, { pull_request: {} }),
      issue(4),
    ],
    "org/down": new Error("502"),
  };
  const listLabelled = async (repo) => {
    if (lists[repo] instanceof Error) throw lists[repo];
    return lists[repo];
  };
  const logs = [];
  const inputs = createInputs({ path, listLabelled, now: () => 5, log: (l) => logs.push(l) });
  inputs.set("org/repo#1", true);
  inputs.set("org/repo#4", true);
  inputs.set("org/down#7", true);
  const titles = await inputs.sync(["org/repo", "org/down"]);
  assert.deepEqual(titles, [
    ["org/repo#2", "Issue 2"],
    ["org/repo#4", "Issue 4"],
  ]);
  // #1 lost its label; #2 got one; #3 is a pull request; #4 keeps its time; a repo that
  // can't be listed keeps what it had.
  assert.deepEqual(Object.fromEntries(inputs.list().map((i) => [i.key, i.since])), {
    "org/repo#4": 5,
    "org/down#7": 5,
    "org/repo#2": Date.parse("2026-10-15T12:00:00Z"),
  });
  assert.match(logs[0], /org\/down: 502/);
  // Its questions from the listing's body.
  const questions = Object.fromEntries(inputs.list().map((i) => [i.key, i.questions]));
  assert.deepEqual(questions["org/repo#2"], {
    items: [{ title: null, text: "Which one?", options: [] }],
    raw: "1. Which one?",
  });
  assert.equal(questions["org/repo#4"], null);
  assert.equal(createInputs({ path, listLabelled }).has("org/repo#2"), true);
});
