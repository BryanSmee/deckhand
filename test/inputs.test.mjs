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
  const dropped = [];
  const inputs = createInputs({
    path,
    listLabelled,
    dropped: (repo, number) => dropped.push([repo, number]),
    now: () => 5,
    log: (l) => logs.push(l),
  });
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
  // #1's run, if it asked, has its questions set aside, as the delivery would have.
  assert.deepEqual(dropped, [["org/repo", 1]]);
  // Its questions from the listing's body.
  const questions = Object.fromEntries(inputs.list().map((i) => [i.key, i.questions]));
  assert.deepEqual(questions["org/repo#2"], {
    items: [{ title: null, text: "Which one?", options: [] }],
    raw: "1. Which one?",
  });
  assert.equal(questions["org/repo#4"], null);
  assert.equal(createInputs({ path, listLabelled }).has("org/repo#2"), true);
});

test("keep: an entry the listing missed comes back as it was, unless a delivery set it since", async (t) => {
  const path = join(tempDir(t), "inputs.json");
  let clock = 1;
  const inputs = createInputs({ path, listLabelled: async () => [], now: () => clock });
  const old = { items: null, raw: "Which one, before?" };
  for (const n of [1, 2, 3, 4, 5, 6]) inputs.set(`org/repo#${n}`, true, old);
  inputs.set("org/repo#1", true, undefined, true);
  clock = 9;
  await inputs.sync(["org/repo"]);
  assert.deepEqual(inputs.keys(), []);
  const asked = { items: null, raw: "Which one?" };
  assert.equal(inputs.keep("org/repo#1", asked), true);
  // Deliveries during the lookups: #2 labelled again (from where it was: its `since`), #3
  // unlabelled, #5's boxes ticked by someone whose ticks answer nothing.
  inputs.set("org/repo#2", true, null);
  inputs.set("org/repo#3", false);
  inputs.update("org/repo#5", undefined, true);
  assert.equal(inputs.has("org/repo#5"), false);
  // Then their lookups answer, with the bodies as they were when looked up.
  assert.equal(inputs.keep("org/repo#2", asked), false);
  assert.equal(inputs.keep("org/repo#3", asked), false);
  assert.equal(inputs.keep("org/repo#5", asked), true);
  // Never dropped by sync(): nothing to keep.
  assert.equal(inputs.keep("org/repo#7", asked), false);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
    "org/repo#1": { since: 1, questions: asked, ignoredTicks: true },
    "org/repo#2": { since: 1, questions: null },
    // The ticks kept, the questions the lookup's: those ticks changed no question.
    "org/repo#5": { since: 1, questions: asked, ignoredTicks: true },
  });
  // Kept once: a second answer for #1 changes nothing.
  inputs.set("org/repo#1", false);
  assert.equal(inputs.keep("org/repo#1", asked), false);
  assert.equal(inputs.has("org/repo#1"), false);
});

test("release: a dropped entry whose lookup didn't keep it is forgotten; the label put back starts afresh", async (t) => {
  const path = join(tempDir(t), "inputs.json");
  let clock = 1;
  const inputs = createInputs({ path, listLabelled: async () => [], now: () => clock });
  inputs.set("org/repo#4", true, null, true);
  await inputs.sync(["org/repo"]);
  // Its lookup: the label is off.
  inputs.release("org/repo#4");
  assert.equal(inputs.keep("org/repo#4", null), false);
  // Days later, the label put back: a new entry, without the old one's time or ticks.
  clock = 100_000;
  const asked = { items: [], raw: "Which?" };
  inputs.set("org/repo#4", true, asked);
  assert.deepEqual(inputs.list(), [
    { key: "org/repo#4", repo: "org/repo", since: 100_000, questions: asked },
  ]);
  assert.equal(inputs.ticksIgnored("org/repo#4"), false);
});

test("respell: an issue waiting for input under another spelling moves to the one given", (t) => {
  const path = join(tempDir(t), "inputs.json");
  const inputs = createInputs({ path, listLabelled: async () => [], now: () => 5 });
  inputs.set("org/repo#4", true, null);
  inputs.respell((repo) => (repo.toLowerCase() === "org/repo" ? "Org/repo" : repo));
  assert.deepEqual(inputs.keys(), ["Org/repo#4"]);
  assert.equal(inputs.list()[0].repo, "Org/repo");
  assert.equal(createInputs({ path, listLabelled: async () => [] }).has("Org/repo#4"), true);
});

test("the bot's ticks: kept with the entry across a restart and the startup lookup, a person's edit clears them", async (t) => {
  const path = join(tempDir(t), "inputs.json");
  const listed = [{ number: 1, body: "## Open questions\n\n1. A?", updated_at: "x" }];
  const inputs = createInputs({ path, listLabelled: async () => listed });
  inputs.set("org/repo#1", true, null, true);
  assert.equal(inputs.ticksIgnored("org/repo#1"), true);
  // An edit that doesn't say: as it was.
  inputs.update("org/repo#1", null);
  assert.equal(inputs.ticksIgnored("org/repo#1"), true);
  await inputs.sync(["org/repo"]);
  const again = createInputs({ path, listLabelled: async () => [] });
  assert.equal(again.ticksIgnored("org/repo#1"), true);
  // A person's edit.
  again.update("org/repo#1", null, false);
  assert.equal(again.ticksIgnored("org/repo#1"), false);
  assert.equal(again.ticksIgnored("org/repo#9"), false);
});
