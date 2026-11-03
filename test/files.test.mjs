import assert from "node:assert/strict";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { loadCredentials, saveCredentials } from "../listener/github-app.mjs";
import { readJson, writeJsonAtomic } from "../lib/files.mjs";
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

test("every state file is written through lib/files.mjs: no temporary file left behind", async (t) => {
  const dir = temp(t);
  writeJsonAtomic(join(dir, "kept.json"), { a: 1 });
  saveCredentials(dir, { id: 1, pem: "…" });

  assert.deepEqual(readdirSync(dir).sort(), ["app.json", "kept.json"]);
  assert.deepEqual(loadCredentials(dir), { id: 1, pem: "…" });
});
