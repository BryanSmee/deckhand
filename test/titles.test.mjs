import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createTitles, parseKey } from "../listener/titles.mjs";

test("task keys: issues, pull requests and discussions", () => {
  assert.deepEqual(parseKey("org/repo#12"), { repo: "org/repo", kind: "issue", number: 12 });
  assert.deepEqual(parseKey("org/repo#pr-3"), { repo: "org/repo", kind: "pr", number: 3 });
  assert.deepEqual(parseKey("org/repo#discussion-8"), {
    repo: "org/repo",
    kind: "discussion",
    number: 8,
  });
  assert.equal(parseKey("org-repo-12"), null);
});

test("titles: webhooks first, the rest fetched once and kept across a restart", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "deckhand-")), "titles.json");
  const asked = [];
  const fetchTitle = async (repo, kind, number) => {
    asked.push(`${repo} ${kind} ${number}`);
    if (number === 404) throw new Error("Not Found");
    return `Title ${number}`;
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
