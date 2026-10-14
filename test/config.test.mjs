import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigError, loadConfig, normalize } from "../listener/config.mjs";

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
  assert.equal(normalize("Claude let’s brainstorm this!"), "claude lets brainstorm this");
});
