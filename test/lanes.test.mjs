// The names of the board's lanes (lanes.mjs): a maintainer's over a plan's parent over an
// inbox's, kept across a restart under any spelling of the repo, old closed ones forgotten.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { MAX_NAME, createLanes, laneName } from "../listener/lanes.mjs";
import { tempDir } from "./helpers.mjs";

const DAY = 24 * 3600_000;

test("lanes: a parent's title, a typed name over it, an inbox's title or its kind", () => {
  let time = 1000;
  const lanes = createLanes({ now: () => time });
  lanes.planned("org/app", 10, [11, 12]);
  const titles = { "org/app#10": "Budgets", "org/app#7": "Ideas inbox" };
  const title = (key) => titles[key] ?? null;
  const inboxes = [["Org/App", { ideas: 7, bugs: 8, discussions: null }]];
  const keys = ["org/app#10", "org/app#11", "org/app#12", "org/app#7", "org/app#8", "org/app#9"];
  assert.deepEqual(lanes.labels(keys, { title, inboxes }), {
    "org/app#10": { name: "Budgets", source: "parent" },
    "org/app#11": { name: "Budgets", source: "parent" },
    "org/app#12": { name: "Budgets", source: "parent" },
    "org/app#7": { name: "Ideas inbox", source: "inbox" },
    "org/app#8": { name: "Bug reports", source: "inbox" },
  });
  assert.deepEqual(lanes.parentKeys(["org/app#11", "org/app#9"]), ["org/app#10"]);
  // Without the parent's title yet: its number.
  assert.deepEqual(lanes.labels(["org/app#11"]), {
    "org/app#11": { name: "#10", source: "parent" },
  });
  time = 2000;
  lanes.name(["org/app#11", "org/app#7"], "Spending caps");
  assert.deepEqual(lanes.labels(["org/app#11", "org/app#12", "org/app#7"], { title, inboxes }), {
    "org/app#11": { name: "Spending caps", source: "user", at: 2000 },
    "org/app#12": { name: "Budgets", source: "parent" },
    "org/app#7": { name: "Spending caps", source: "user", at: 2000 },
  });
  // Taken off: back to the parent's, and nothing left for an issue that had only the name.
  lanes.name(["org/app#11", "org/app#7"], "");
  assert.equal(lanes.labels(["org/app#11"], { title })["org/app#11"].source, "parent");
  assert.equal(lanes.get("org/app#7"), null);
});

test("lanes: kept across a restart, under any spelling of the repo", (t) => {
  const path = join(tempDir(t), "lanes.json");
  const lanes = createLanes({ path });
  lanes.name(["Org/App#18", "org/app#pr-19"], "Webhooks");
  lanes.planned("Org/App", 30, [31]);
  const again = createLanes({ path });
  assert.deepEqual(again.labels(["org/app#18", "ORG/APP#pr-19", "org/app#31"]), {
    "org/app#18": { name: "Webhooks", source: "user", at: again.get("org/app#18").at },
    "ORG/APP#pr-19": { name: "Webhooks", source: "user", at: again.get("org/app#18").at },
    // The parent in the asker's spelling: titles.mjs's key.
    "org/app#31": { name: "#30", source: "parent" },
  });
});

test("lanes: a closed issue's entry goes some time after it was set, an open one's stays", () => {
  let time = 0;
  const closed = new Set(["org/app#1"]);
  const lanes = createLanes({ closed: (key) => closed.has(key), now: () => time });
  lanes.name(["org/app#1", "org/app#2"], "Old");
  time = 89 * DAY;
  lanes.name(["org/app#3"], "New");
  assert.equal(lanes.get("org/app#1").name, "Old");
  time = 91 * DAY;
  lanes.name(["org/app#3"], "Newer");
  assert.equal(lanes.get("org/app#1"), null);
  assert.equal(lanes.get("org/app#2").name, "Old");
});

test("laneName: one line, trimmed, at most MAX_NAME characters; empty takes it off", () => {
  assert.equal(laneName("  Per-repo\n\tbudgets "), "Per-repo budgets");
  assert.equal(laneName(""), "");
  assert.equal(laneName("   "), "");
  assert.equal(laneName("x".repeat(MAX_NAME)), "x".repeat(MAX_NAME));
  assert.equal(laneName("x".repeat(MAX_NAME + 1)), null);
  assert.equal(laneName("a\u0007b"), null);
  assert.equal(laneName(null), null);
  assert.equal(laneName(12), null);
});
