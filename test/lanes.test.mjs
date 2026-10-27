// The names of the board's lanes (lanes.mjs): a maintainer's over a plan's parent over an
// inbox's, kept across a restart under any spelling of the repo, old closed ones forgotten.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { MAX_NAME, PARENT_MS, createLanes, fetchParent, laneName } from "../listener/lanes.mjs";
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
    "org/app#18": { name: "Webhooks", source: "user", at: again.get("org/app#18").namedAt },
    "ORG/APP#pr-19": { name: "Webhooks", source: "user", at: again.get("org/app#18").namedAt },
    // The parent in the asker's spelling: titles.mjs's key.
    "org/app#31": { name: "#30", source: "parent" },
  });
});

test("lanes: a name's time is when it was typed, not when a plan or a fetch came after", async () => {
  let time = 1;
  const lanes = createLanes({
    now: () => time,
    fetchParent: async () => ({ key: "o/a#99", title: "Epic" }),
  });
  lanes.name(["o/a#11"], "Old");
  time = 2;
  lanes.name(["o/a#20"], "New");
  time = 3;
  lanes.planned("o/a", 10, [11]);
  await lanes.fill(["o/a#11"]);
  // Typed again as it was: still its first time.
  lanes.name(["o/a#11"], "Old");
  const found = lanes.labels(["o/a#11", "o/a#20"]);
  assert.deepEqual(found["o/a#11"], { name: "Old", source: "user", at: 1 });
  assert.deepEqual(found["o/a#20"], { name: "New", source: "user", at: 2 });
});

test("lanes: GitHub's parent of the board's open issues, asked again after PARENT_MS", async () => {
  let time = 0;
  const asked = [];
  const parents = {
    11: { key: "org/app#10", title: "Epic" },
    13: { key: "org/other#4", title: "Theirs" },
  };
  const closed = new Set(["org/app#14"]);
  const logs = [];
  const lanes = createLanes({
    now: () => time,
    closed: (key) => closed.has(key),
    log: (line) => logs.push(line),
    fetchParent: async (repo, number) => {
      asked.push(`${repo}#${number}`);
      if (number === 15) throw new Error("GitHub GET …/parent: 502");
      return parents[number] ?? null;
    },
  });
  const keys = ["org/app#11", "org/app#12", "org/app#13", "org/app#14", "org/app#15"];
  await lanes.fill([...keys, "org/app#pr-16", "org/app#discussion-3"]);
  assert.deepEqual(asked, keys);
  assert.deepEqual(logs, ["Parent of org/app#15: GitHub GET …/parent: 502"]);
  const titles = { "org/app#10": "Budgets" };
  assert.deepEqual(lanes.labels(keys, { title: (key) => titles[key] ?? null }), {
    // The title the listener has now, else the one GitHub gave with the parent.
    "org/app#11": { name: "Budgets", source: "parent" },
    "org/app#13": { name: "Theirs", source: "parent" },
  });
  assert.deepEqual(lanes.parentKeys(keys), ["org/app#10", "org/other#4"]);
  // Not again until PARENT_MS; then the open ones, and the one that failed.
  asked.length = 0;
  time = PARENT_MS - 1;
  await lanes.fill(keys);
  assert.deepEqual(asked, ["org/app#15"]);
  asked.length = 0;
  time = 2 * PARENT_MS;
  parents[12] = { key: "org/app#10", title: "Epic" };
  await lanes.fill(keys);
  assert.deepEqual(asked, ["org/app#11", "org/app#12", "org/app#13", "org/app#15"]);
  assert.equal(lanes.labels(["org/app#12"])["org/app#12"].name, "Epic");
  // A plan's parent wins over GitHub's.
  lanes.planned("org/app", 30, [11]);
  assert.equal(lanes.labels(["org/app#11"])["org/app#11"].name, "#30");
});

test("fetchParent: the parent issue as GitHub has it, null without one", async () => {
  const calls = [];
  const github = async (repo, method, path) => {
    calls.push(`${method} ${path}`);
    if (path.endsWith("/5/parent")) {
      return Response.json({
        number: 4,
        title: "Epic",
        repository_url: "https://api.github.com/repos/Org/Other",
      });
    }
    return new Response("{}", { status: 404 });
  };
  assert.deepEqual(await fetchParent(github, "org/app", 5), { key: "Org/Other#4", title: "Epic" });
  assert.equal(await fetchParent(github, "org/app", 6), null);
  assert.deepEqual(calls, [
    "GET /repos/org/app/issues/5/parent",
    "GET /repos/org/app/issues/6/parent",
  ]);
});

test("lanes: respelled at a restart, so that old closed ones are found and forgotten", (t) => {
  const path = join(tempDir(t), "lanes.json");
  let time = 0;
  const closed = new Set(["Org/App#1"]);
  const lanes = createLanes({ path, closed: (key) => closed.has(key), now: () => time });
  lanes.name(["org/app#1"], "Old");
  assert.deepEqual(lanes.keys(), ["org/app#1"]);
  const again = createLanes({ path, closed: (key) => closed.has(key), now: () => time });
  again.respell((repo) => (repo.toLowerCase() === "org/app" ? "Org/App" : repo));
  assert.deepEqual(again.keys(), ["Org/App#1"]);
  time = 91 * DAY;
  again.name(["org/app#2"], "New");
  assert.equal(again.get("org/app#1"), null);
});

test("lanes: an issue the listener never heard of goes some time after it was set", () => {
  let time = 0;
  const lanes = createLanes({ known: (key) => key !== "org/app#404", now: () => time });
  lanes.name(["org/app#404", "org/app#5"], "Typed");
  time = 91 * DAY;
  lanes.name(["org/app#6"], "Other");
  assert.equal(lanes.get("org/app#404"), null);
  assert.equal(lanes.get("org/app#5").name, "Typed");
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
