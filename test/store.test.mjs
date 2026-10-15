import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createBrainstorms, createIssueModes } from "../listener/brainstorms.mjs";
import { loadCredentials, saveCredentials } from "../listener/github-app.mjs";
import { createOnboardingStore } from "../listener/onboarding.mjs";
import { createPulls } from "../listener/pulls.mjs";
import { readJson, writeJsonAtomic } from "../listener/store.mjs";
import { createTitles } from "../listener/titles.mjs";

const temp = () => mkdtempSync(join(tmpdir(), "deckhand-store-"));
const leftovers = (dir) => readdirSync(dir).filter((f) => f.endsWith(".tmp"));

test("readJson: the value, or the fallback when missing or unreadable", () => {
  const dir = temp();
  assert.equal(readJson(join(dir, "none.json")), null);
  assert.deepEqual(readJson(join(dir, "none.json"), {}), {});
  writeFileSync(join(dir, "half.json"), '{"a": ');
  assert.deepEqual(readJson(join(dir, "half.json"), []), []);
  writeFileSync(join(dir, "ok.json"), '{"a": 1}');
  assert.deepEqual(readJson(join(dir, "ok.json"), {}), { a: 1 });
});

test("writeJsonAtomic: replaces the file whole, leaves no temporary file", () => {
  const dir = temp();
  const path = join(dir, "state.json");
  writeJsonAtomic(path, { a: 1 });
  writeJsonAtomic(path, { a: 2 });
  assert.deepEqual(readJson(path), { a: 2 });
  assert.deepEqual(leftovers(dir), []);
});

test("writeJsonAtomic: a mode for secrets, even over a wider umask", () => {
  const dir = temp();
  const path = join(dir, "secret.json");
  writeJsonAtomic(path, { pem: "…" }, { mode: 0o600 });
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test("writeJsonAtomic: a failed write keeps the previous file and cleans up", () => {
  const dir = temp();
  // A directory where the file should be: the rename fails.
  const path = join(dir, "taken");
  mkdirSync(path);
  assert.throws(() => writeJsonAtomic(path, { a: 1 }));
  assert.deepEqual(leftovers(dir), []);
  assert.throws(() => writeJsonAtomic(join(dir, "no", "such.json"), { a: 1 }));
  assert.deepEqual(leftovers(dir), []);
});

test("every state file is written through store.mjs: no temporary file left behind", async () => {
  const dir = temp();
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
