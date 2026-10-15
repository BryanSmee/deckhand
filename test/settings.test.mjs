// Every environment variable the listener and the egress proxy read is in docs/setup.md: a
// setting nobody can find is one nobody can change.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { FILE_SETTINGS } from "../listener/config.mjs";

const root = new URL("../", import.meta.url).pathname;

function sources(dir) {
  return readdirSync(join(root, dir), { recursive: true })
    .filter((file) => file.endsWith(".mjs"))
    .map((file) => readFileSync(join(root, dir, file), "utf8"));
}

// `env.X`, `process.env.X` and `setting("X")` or `number("X", …)`: how config.mjs, server.mjs, runs.mjs and
// proxy.mjs read them.
function settingsRead() {
  const names = new Set();
  for (const source of [...sources("listener"), ...sources("proxy")]) {
    for (const [, name] of source.matchAll(/\b(?:env\.|(?:setting|number)\(")([A-Z][A-Z0-9_]*)/g))
      names.add(name);
  }
  return [...names].sort();
}

test("the listener and the proxy read settings that the scan finds", () => {
  // Guards the scan itself: an empty list would pass the next test.
  for (const name of ["ALLOWED_USERS", "DEBOUNCE_MS", "POLICY_URL", "BROKER_URL"]) {
    assert.ok(settingsRead().includes(name), name);
  }
});

test("docs/setup.md documents every setting the listener and the proxy read", () => {
  const doc = readFileSync(join(root, "docs/setup.md"), "utf8");
  const missing = settingsRead().filter((name) => !doc.includes(`\`${name}\``));
  assert.deepEqual(missing, [], `not in docs/setup.md: ${missing.join(", ")}`);
});

test("every setting config.yaml takes is read, and documented with its key", () => {
  const doc = readFileSync(join(root, "docs/setup.md"), "utf8");
  const read = settingsRead();
  for (const name of Object.keys(FILE_SETTINGS)) {
    assert.ok(read.includes(name), `${name} is in FILE_SETTINGS but nothing reads it`);
    assert.ok(
      doc.includes(`\`${name.toLowerCase()}\``),
      `${name.toLowerCase()} not in docs/setup.md`,
    );
  }
});

test("config.yaml takes every setting config.mjs reads through setting() or number()", () => {
  const source = readFileSync(join(root, "listener/config.mjs"), "utf8");
  for (const [, name] of source.matchAll(/\b(?:setting|number)\("([A-Z][A-Z0-9_]*)"\)/g)) {
    assert.ok(
      name in FILE_SETTINGS,
      `${name} is read with setting() or number() but has no config.yaml key`,
    );
  }
});
