// Every environment variable the listener, the runner, the policy service, the egress proxy and
// the broker read is in docs/setup.md: a setting nobody can find is one nobody can change. Every
// setting config.yaml takes is in compose.yaml too, which passes .env's value.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { FILE_SETTINGS, SETTINGS } from "../listener/config.mjs";

const root = new URL("../", import.meta.url).pathname;

function sources(dir) {
  return readdirSync(join(root, dir), { recursive: true })
    .filter((file) => file.endsWith(".mjs"))
    .map((file) => readFileSync(join(root, dir, file), "utf8"));
}

// SETTINGS, `env.X`, `process.env.X` and `setting("X")`: how config.mjs, server.mjs, runs.mjs,
// proxy.mjs, the policy service's service.mjs and the broker's server.mjs read them.
function settingsRead() {
  const names = new Set(Object.keys(SETTINGS));
  for (const source of [
    ...sources("listener"),
    ...sources("runner"),
    ...sources("proxy"),
    ...sources("policy-service"),
    ...sources("broker"),
  ]) {
    for (const [, name] of source.matchAll(/\b(?:env\.|setting\(")([A-Z][A-Z0-9_]*)/g))
      names.add(name);
  }
  return [...names].sort();
}

test("the listener, the policy service and the proxy read settings that the scan finds", () => {
  // Guards the scan itself: an empty list would pass the next test.
  for (const name of [
    "ALLOWED_USERS",
    "DEBOUNCE_MS",
    "POLICY_URL",
    "BROKER_URL",
    "SERVICE_NETWORKS",
  ]) {
    assert.ok(settingsRead().includes(name), name);
  }
});

test("docs/setup.md documents every setting the listener, the runner, the policy service, the proxy and the broker read", () => {
  const doc = readFileSync(join(root, "docs/setup.md"), "utf8");
  const missing = settingsRead().filter((name) => !doc.includes(`\`${name}\``));
  assert.deepEqual(missing, [], `not in docs/setup.md: ${missing.join(", ")}`);
});

test("every setting config.yaml takes is documented with its key, and in compose.yaml", () => {
  const doc = readFileSync(join(root, "docs/setup.md"), "utf8");
  const compose = readFileSync(join(root, "compose.yaml"), "utf8");
  assert.deepEqual(Object.keys(FILE_SETTINGS), Object.keys(SETTINGS));
  for (const name of Object.keys(FILE_SETTINGS)) {
    assert.ok(
      doc.includes(`\`${name.toLowerCase()}\``),
      `${name.toLowerCase()} not in docs/setup.md`,
    );
    assert.match(compose, new RegExp(`^ {6}${name}:`, "m"), `${name} not in compose.yaml`);
  }
});

// A setting's value lands in readSettings()'s `s`: loadConfig() takes it from there, or one
// of the aliases (aliasesFrom()) or a default after it does.
test("config.mjs uses every setting it reads", () => {
  const source = readFileSync(join(root, "listener/config.mjs"), "utf8");
  const tiers = [...source.matchAll(/aliasesFrom\(s, "([A-Z_]+)"/g)].map((m) => m[1]);
  for (const name of Object.keys(SETTINGS)) {
    const alias = tiers.some((p) => new RegExp(`^${p}_[A-Z]+_MODEL$`).test(name));
    assert.ok(alias || source.includes(`s.${name}`), `${name} is in SETTINGS but nothing uses it`);
  }
});

test("config.yaml takes every setting config.mjs reads through setting()", () => {
  const source = readFileSync(join(root, "listener/config.mjs"), "utf8");
  for (const [, name] of source.matchAll(/\bsetting\("([A-Z][A-Z0-9_]*)"\)/g)) {
    assert.ok(name in FILE_SETTINGS, `${name} is read with setting() but has no config.yaml key`);
  }
});
