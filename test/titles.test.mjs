import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { closedAs, createTitles } from "../listener/titles.mjs";
import { tempDir } from "./helpers.mjs";

test("titles: webhooks first, the rest fetched once and kept across a restart", async (t) => {
  const path = join(tempDir(t), "titles.json");
  const asked = [];
  const fetchTitle = async (repo, kind, number) => {
    asked.push(`${repo} ${kind} ${number}`);
    if (number === 404) throw new Error("Not Found");
    return { title: `Title ${number}` };
  };
  const titles = createTitles({ path, fetchTitle });
  titles.set("org/repo#1", "From the webhook");
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
  assert.equal(JSON.parse(readFileSync(path, "utf8"))["org/repo#discussion-8"], "Title 8");
  const next = createTitles({ path, fetchTitle });
  assert.equal(next.get("org/repo#pr-3"), "Title 3");
});

test("closed states: from webhooks and the lookup; what was open is asked again by the next listener", async (t) => {
  const dir = tempDir(t);
  const path = join(dir, "titles.json");
  const closedPath = join(dir, "closed.json");
  const asked = [];
  const states = { 1: "done", 2: "open", 3: "not-done" };
  const fetchTitle = async (repo, kind, number) => {
    asked.push(number);
    if (kind === "discussion") return { title: "A talk" };
    return { title: `Title ${number}`, closed: closedAs(states[number]) };
  };
  const titles = createTitles({ path, closedPath, fetchTitle });
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
  await titles.fill(keys);
  assert.deepEqual(asked, [1, 2, 3, 4]);

  // The next listener asks only about what was open: a close may have been missed meanwhile.
  states[2] = "done";
  const next = createTitles({ path, closedPath, fetchTitle });
  assert.equal(next.closed("org/repo#1"), "completed");
  await next.fill(keys);
  assert.deepEqual(asked, [1, 2, 3, 4, 2]);
  assert.equal(next.closed("org/repo#2"), "completed");
});
