import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import {
  ConfigError,
  loadConfig,
  normalize,
  parseConfigFile,
  readConfigFile,
} from "../listener/config.mjs";

test("refuses to start without allowed users", () => {
  for (const ALLOWED_USERS of [undefined, "", " , ,"]) {
    assert.throws(() => loadConfig({ ALLOWED_USERS }), ConfigError);
  }
});

test("allowed users and repos are lowercase lists", () => {
  const config = loadConfig({
    ALLOWED_USERS: " Alice,BOB ",
    ALLOWED_REPOS: "Org/Repo",
  });
  assert.deepEqual(config.users, ["alice", "bob"]);
  assert.deepEqual(config.repos, ["org/repo"]);
});

test("names come from settings, with a neutral default", () => {
  const defaults = loadConfig({ ALLOWED_USERS: "a" });
  assert.equal(defaults.image, "deckhand-sandbox");
  assert.equal(defaults.network, "deckhand-sandboxes");
  assert.equal(defaults.shotsVolume, "deckhand-screenshots");
  assert.equal(defaults.claudeCodeVolume, "deckhand-claude-code");
  assert.equal(defaults.publicUrl, null);
  const custom = loadConfig({
    ALLOWED_USERS: "a",
    NAME_PREFIX: "ops",
    SANDBOX_IMAGE: "registry/img:1",
    PUBLIC_URL: "https://hooks.example.com/",
  });
  assert.equal(custom.image, "registry/img:1");
  assert.equal(custom.network, "ops-sandboxes");
  assert.equal(custom.publicUrl, "https://hooks.example.com");
});

test("trigger lines are compared loosely", () => {
  assert.equal(normalize("@Deckhand:"), "deckhand");
  assert.equal(normalize("Let’s go!"), "lets go");
});

test("the default trigger is Deckhand", () => {
  assert.equal(loadConfig({ ALLOWED_USERS: "alice" }).trigger, "deckhand");
  assert.equal(loadConfig({ ALLOWED_USERS: "alice", TRIGGER: "Hey Bot!" }).trigger, "hey bot");
});

test("conflict watcher floor: 5 minutes by default, 0 turns it off, junk refused", () => {
  const base = { ALLOWED_USERS: "alice" };
  assert.equal(loadConfig(base).conflictCheckMinutes, 5);
  assert.equal(loadConfig({ ...base, CONFLICT_CHECK_MINUTES: "0" }).conflictCheckMinutes, 0);
  assert.equal(loadConfig({ ...base, CONFLICT_CHECK_MINUTES: " 15 " }).conflictCheckMinutes, 15);
  // Empty is unset, as compose passes a variable .env leaves out.
  assert.equal(loadConfig({ ...base, CONFLICT_CHECK_MINUTES: "" }).conflictCheckMinutes, 5);
  for (const bad of ["-1", "2.5", "soon"]) {
    assert.throws(() => loadConfig({ ...base, CONFLICT_CHECK_MINUTES: bad }), ConfigError);
  }
});

const file = (text) => parseConfigFile(text, "/etc/deckhand/config.yaml");

test("config.yaml sets what the environment leaves out, as YAML lists and values", () => {
  const config = loadConfig(
    {},
    file(`
allowed_users: [Alice, bob]
allowed_repos:
  - org/api
  - org/web
allowed_hosts: [registry.npmjs.org]
trigger: Hey Bot
sandbox_model: sonnet
sandbox_cpus: 0.5
sandbox_memory: 2g
max_parallel: 3
onboarding: false
needs_input_label: ""
conflict_check_minutes: 0
claude_code_version: 2.1.300
`),
  );
  assert.deepEqual(config.users, ["alice", "bob"]);
  assert.deepEqual(config.repos, ["org/api", "org/web"]);
  assert.deepEqual(config.hosts, ["registry.npmjs.org"]);
  assert.equal(config.trigger, "hey bot");
  assert.equal(config.model, "sonnet");
  assert.equal(config.brainstormModel, "sonnet");
  assert.deepEqual(config.limits, { cpus: "0.5", memory: "2g", pids: 2048 });
  assert.equal(config.maxParallel, 3);
  assert.equal(config.onboarding, false);
  assert.equal(config.needsInputLabel, "");
  assert.equal(config.conflictCheckMinutes, 0);
  assert.equal(config.claudeCodeVersion, "2.1.300");
});

test("a set, non-empty environment variable overrides config.yaml, of every type", () => {
  const yaml = file(`
allowed_users: [alice]
trigger: Bot
max_parallel: 3
onboarding: true
needs_input_label: waiting
`);
  const config = loadConfig(
    {
      ALLOWED_USERS: "carol,dan",
      TRIGGER: "Other",
      MAX_PARALLEL: "5",
      ONBOARDING: "off",
      NEEDS_INPUT_LABEL: "",
    },
    yaml,
  );
  assert.deepEqual(config.users, ["carol", "dan"]);
  assert.equal(config.trigger, "other");
  assert.equal(config.maxParallel, 5);
  assert.equal(config.onboarding, false);
  // Empty means no label, so set in the environment it still wins.
  assert.equal(config.needsInputLabel, "");

  // Empty elsewhere is unset: compose passes `${TRIGGER:-}` when .env leaves it out.
  const kept = loadConfig({ ALLOWED_USERS: "", TRIGGER: "", MAX_PARALLEL: "" }, yaml);
  assert.deepEqual(kept.users, ["alice"]);
  assert.equal(kept.trigger, "bot");
  assert.equal(kept.maxParallel, 3);
  assert.equal(kept.needsInputLabel, "waiting");
});

test("config.yaml refuses unknown keys, wrong types and secrets, naming each", () => {
  const refuse = (text, pattern) => assert.throws(() => file(text), pattern);
  refuse("allowed_user: [a]", /config\.yaml: allowed_user: unknown/);
  refuse("ALLOWED_USERS: [a]", /ALLOWED_USERS: unknown/);
  refuse("broker_url: http://x", /broker_url: unknown/);
  refuse("anthropic_api_key: sk-1", /anthropic_api_key: a secret/);
  refuse("claude_code_oauth_token: t", /claude_code_oauth_token: a secret/);
  refuse("allowed_users: alice\nmax_parallel: [1]", /max_parallel: expected a value/);
  refuse("allowed_users: {a: 1}", /allowed_users: expected a list/);
  refuse("[a, b]", /config\.yaml: line 1/);
  refuse("a: [", /config\.yaml/);
  assert.throws(
    () => file("trigger: x\nfoo: 1\nanthropic_api_key: k"),
    (error) =>
      error instanceof ConfigError && /foo/.test(error.message) && /anthropic/.test(error.message),
  );
});

test("a bad value in config.yaml names its key, one in the environment its variable", () => {
  const base = "allowed_users: [a]\n";
  const bad = [
    ["max_parallel: lots", /config\.yaml: max_parallel: expected/],
    ["sandbox_cpus: -1", /config\.yaml: sandbox_cpus: expected/],
    ["onboarding: maybe", /config\.yaml: onboarding: expected on or off/],
    ["allowed_hosts: [a.*.b]", /config\.yaml: allowed_hosts: a\.\*\.b/],
    ["debounce_ms: 1.5", /config\.yaml: debounce_ms: expected/],
  ];
  for (const [line, pattern] of bad) {
    assert.throws(() => loadConfig({}, file(base + line)), pattern);
  }
  assert.throws(
    () => loadConfig({ MAX_PARALLEL: "lots" }, file(base + "max_parallel: 2")),
    /MAX_PARALLEL: expected/,
  );
  assert.throws(() => loadConfig({}, file("trigger: x")), /ALLOWED_USERS is empty/);
});

test("without config.yaml, the environment alone, as before", () => {
  const read = () => {
    throw Object.assign(new Error("no such file"), { code: "ENOENT" });
  };
  assert.deepEqual(readConfigFile({}, read).settings, {});
  assert.deepEqual(
    loadConfig({ ALLOWED_USERS: "a" }, readConfigFile({}, read)),
    loadConfig({ ALLOWED_USERS: "a" }),
  );
  // Named on purpose, it has to be there.
  assert.throws(() => readConfigFile({ CONFIG_FILE: "/x.yaml" }, read), /reading \/x\.yaml/);
  let path;
  const found = readConfigFile({ CONFIG_FILE: "/ops/deckhand.yaml" }, (p) => {
    path = p;
    return "allowed_users: [a]";
  });
  assert.equal(path, "/ops/deckhand.yaml");
  assert.deepEqual(found.settings, { ALLOWED_USERS: "a" });
  assert.equal(readConfigFile({}, () => "").settings.ALLOWED_USERS, undefined);
});

test("config.example.yaml is a valid config.yaml", () => {
  const text = readFileSync(new URL("../config.example.yaml", import.meta.url), "utf8");
  const config = loadConfig({}, parseConfigFile(text, "config.example.yaml"));
  assert.ok(config.users.length);
});
