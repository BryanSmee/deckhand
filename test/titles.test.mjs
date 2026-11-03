import assert from "node:assert/strict";
import { test } from "node:test";
import { closedAs, createTitles } from "../listener/titles.mjs";
import { mapStore } from "./helpers.mjs";

// createTitles()'s maps, as a copy taking the lease reads them.
const loaded = async (maps, load = maps.map) => ({
  titles: await load("titles"),
  closed: await load("closed"),
});

test("titles: webhooks first, the rest fetched once and kept across a restart", async () => {
  const maps = mapStore();
  const asked = [];
  const fetchTitle = async (repo, kind, number) => {
    asked.push(`${repo} ${kind} ${number}`);
    if (number === 404) throw new Error("Not Found");
    return { title: `Title ${number}` };
  };
  const titles = createTitles({ ...(await loaded(maps)), fetchTitle });
  // An `issues` delivery: its title and its state.
  titles.set("org/repo#1", "From the webhook");
  titles.setClosed("org/repo#1", "completed");
  titles.seed([
    ["org/repo#1", "From an old log"],
    ["org/repo#2", "Newest log"],
    ["org/repo#2", "Older log"],
  ]);
  assert.equal(titles.get("org/repo#1"), "From the webhook");
  assert.equal(titles.get("org/repo#2"), "Newest log");

  const keys = ["org/repo#1", "org/repo#pr-3", "org/repo#discussion-8", "org/repo#404"];
  await titles.fill(keys);
  assert.deepEqual(asked, ["org/repo pr 3", "org/repo discussion 8", "org/repo issue 404"]);
  assert.equal(titles.get("org/repo#pr-3"), "Title 3");
  assert.equal(titles.get("org/repo#404"), null);
  // A failure isn't retried by this listener; nothing is fetched twice.
  await titles.fill(keys);
  assert.equal(asked.length, 3);

  // The next listener has them without asking.
  assert.equal(await maps.store.get("titles/org/repo#discussion-8"), "Title 8");
  const next = createTitles({ ...(await loaded(maps, maps.again)), fetchTitle });
  assert.equal(next.get("org/repo#pr-3"), "Title 3");
});

test("closed states: from webhooks and the lookup; what was open is asked again by the next listener", async () => {
  const maps = mapStore();
  const asked = [];
  const states = { 1: "done", 2: "open", 3: "not-done" };
  const fetchTitle = async (repo, kind, number) => {
    asked.push(number);
    if (kind === "discussion") return { title: "A talk" };
    return { title: `Title ${number}`, closed: closedAs(states[number]) };
  };
  const titles = createTitles({ ...(await loaded(maps)), fetchTitle });
  const keys = ["org/repo#1", "org/repo#2", "org/repo#pr-3", "org/repo#discussion-4"];
  await titles.fill(keys);
  assert.deepEqual(
    keys.map((k) => titles.closed(k)),
    ["completed", null, "not_planned", null],
  );
  // A webhook: #2 closed, then reopened.
  titles.setClosed("org/repo#2", "completed");
  assert.equal(titles.closed("org/repo#2"), "completed");
  titles.setClosed("org/repo#2", null);
  // Open: no entry, as the next copy would read it back.
  assert.equal(titles.closed("org/repo#2"), null);
  await maps.settled();
  assert.deepEqual((await maps.store.keys("closed/org/repo#2")).keys, []);
  await titles.fill(keys);
  assert.deepEqual(asked, [1, 2, 3, 4]);

  // The next listener asks only about what was open: a close may have been missed meanwhile.
  states[2] = "done";
  const next = createTitles({ ...(await loaded(maps, maps.again)), fetchTitle });
  assert.equal(next.closed("org/repo#1"), "completed");
  await next.fill(keys);
  assert.deepEqual(asked, [1, 2, 3, 4, 2]);
  assert.equal(next.closed("org/repo#2"), "completed");
});

test("respell: titles and closed states under another spelling move to the one given", async () => {
  const maps = mapStore();
  const { titles: titleMap, closed } = await loaded(maps);
  for (const [key, title] of Object.entries({
    "org/repo#1": "Old",
    "Org/repo#1": "New",
    "x/y#2": "Y",
  }))
    titleMap.set(key, title);
  closed.set("org/repo#1", "completed");
  const titles = createTitles({ titles: titleMap, closed, fetchTitle: async () => null });
  titles.respell((repo) => (repo.toLowerCase() === "org/repo" ? "Org/repo" : repo));
  assert.deepEqual(titles.keys().sort(), ["Org/repo#1", "x/y#2"]);
  const again = await loaded(maps, maps.again);
  assert.deepEqual(Object.fromEntries(again.titles), { "Org/repo#1": "New", "x/y#2": "Y" });
  assert.deepEqual(Object.fromEntries(again.closed), { "Org/repo#1": "completed" });
});
