import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createBrainstorms, createIssueModes } from "../listener/brainstorms.mjs";
import { loadCredentials, saveCredentials } from "../listener/github-app.mjs";
import { createOnboardingStore } from "../listener/onboarding.mjs";
import { createPulls } from "../listener/pulls.mjs";
import { persistentMap, readJson, writeJsonAtomic } from "../lib/files.mjs";
import { createTitles } from "../listener/titles.mjs";
import { assertMode, needsModes, tempDir } from "./helpers.mjs";

const temp = (t) => tempDir(t, "deckhand-store-");
const leftovers = (dir) => readdirSync(dir).filter((f) => f.endsWith(".tmp"));

test("readJson: the value, or the fallback when missing or unreadable", (t) => {
  const dir = temp(t);
  assert.equal(readJson(join(dir, "none.json")), null);
  assert.deepEqual(readJson(join(dir, "none.json"), {}), {});
  writeFileSync(join(dir, "half.json"), '{"a": ');
  assert.deepEqual(readJson(join(dir, "half.json"), []), []);
  writeFileSync(join(dir, "ok.json"), '{"a": 1}');
  assert.deepEqual(readJson(join(dir, "ok.json"), {}), { a: 1 });
});

test("writeJsonAtomic: replaces the file whole, leaves no temporary file", (t) => {
  const dir = temp(t);
  const path = join(dir, "state.json");
  writeJsonAtomic(path, { a: 1 });
  writeJsonAtomic(path, { a: 2 });
  assert.deepEqual(readJson(path), { a: 2 });
  assert.deepEqual(leftovers(dir), []);
});

test("writeJsonAtomic: a mode for secrets, even over a wider umask", { skip: needsModes }, (t) => {
  const dir = temp(t);
  const path = join(dir, "secret.json");
  writeJsonAtomic(path, { pem: "…" }, { mode: 0o600 });
  assertMode(path, 0o600);
});

test("writeJsonAtomic: a failed write keeps the previous file and cleans up", (t) => {
  const dir = temp(t);
  // A directory where the file should be: the rename fails.
  const path = join(dir, "taken");
  mkdirSync(path);
  assert.throws(() => writeJsonAtomic(path, { a: 1 }));
  assert.deepEqual(leftovers(dir), []);
  assert.throws(() => writeJsonAtomic(join(dir, "no", "such.json"), { a: 1 }));
  assert.deepEqual(leftovers(dir), []);
});

test("persistentMap: the file's object as a Map, saved whole in the same format", (t) => {
  const dir = temp(t);
  const path = join(dir, "pulls.json");
  // A file from before persistentMap(), as writeJsonAtomic() wrote it.
  const before = { "o/r#1": { number: 2, state: "draft" }, "o/r#pr-3": { number: 3 } };
  writeJsonAtomic(path, before);
  const text = readFileSync(path, "utf8");
  const map = persistentMap(path);
  assert.deepEqual([...map.keys()], ["o/r#1", "o/r#pr-3"]);
  assert.deepEqual(map.get("o/r#1"), { number: 2, state: "draft" });
  map.save();
  assert.equal(readFileSync(path, "utf8"), text);
  map.delete("o/r#1");
  map.set("o/r#4", "x");
  map.save();
  assert.deepEqual(readJson(path), { "o/r#pr-3": { number: 3 }, "o/r#4": "x" });
  assert.deepEqual(leftovers(dir), []);
  // Missing or unreadable: empty. Without a path: kept in memory only.
  assert.equal(persistentMap(join(dir, "none.json")).size, 0);
  writeFileSync(join(dir, "half.json"), '{"a": ');
  assert.equal(persistentMap(join(dir, "half.json")).size, 0);
  const memory = persistentMap(null);
  memory.set("a", 1);
  memory.save();
  assert.deepEqual(readdirSync(dir).sort(), ["half.json", "pulls.json"]);
  // A mode for the files with comments' text (waits.json).
  const secret = persistentMap(join(dir, "waits.json"), { mode: 0o600 });
  secret.set("o/r#5", { blockers: [4] });
  secret.save();
  assertMode(join(dir, "waits.json"), 0o600);
});

test("every state file is written through lib/files.mjs: no temporary file left behind", async (t) => {
  const dir = temp(t);
  const brainstorms = createBrainstorms({
    path: join(dir, "brainstorms.json"),
    idleMs: 60000,
    busy: () => false,
    log: () => {},
  });
  brainstorms.activate("o/r#1", { repo: "o/r", number: 1 });
  brainstorms.end("o/r#1");
  createIssueModes(join(dir, "modes.json")).set("o/r#1", "review");
  createTitles({ path: join(dir, "titles.json"), fetchTitle: async () => null }).set("o/r#1", "A");
  createPulls({ path: join(dir, "pulls.json"), listPulls: async () => [] }).record("o/r#1", {
    number: 2,
    url: "https://github.com/o/r/pull/2",
    state: "draft",
    readyAt: null,
  });
  createOnboardingStore(join(dir, "onboarding.json")).record("o/r", 3);
  saveCredentials(dir, { id: 1, pem: "…" });

  assert.deepEqual(readdirSync(dir).sort(), [
    "app.json",
    "brainstorms.json",
    "modes.json",
    "onboarding.json",
    "pulls.json",
    "titles.json",
  ]);
  assert.deepEqual(readJson(join(dir, "modes.json")), { "o/r#1": "review" });
  assert.equal(readJson(join(dir, "onboarding.json"))["o/r"].issue, 3);
  assert.deepEqual(loadCredentials(dir), { id: 1, pem: "…" });
});
