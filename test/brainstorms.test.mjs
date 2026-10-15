import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";
import { createBrainstorms, createIssueModes, REPLY_GRACE_MS } from "../listener/brainstorms.mjs";

const saved = (path) => JSON.parse(readFileSync(path, "utf8"));

test("brainstorms: active, idle once the deadline passes, restored, stopped, ended", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const path = join(mkdtempSync(join(tmpdir(), "deckhand-")), "brainstorms.json");
  let busy = false;
  const make = () =>
    createBrainstorms({ path, idleMs: 60000, busy: () => busy, log: () => {}, now: Date.now });
  const brainstorms = make();
  const key = "org/repo#12";
  assert.equal(brainstorms.activate(key, { repo: "org/repo", number: 12 }), false);
  assert.equal(brainstorms.get(key).status, "active");
  assert.deepEqual(saved(path)[key], {
    repo: "org/repo",
    number: 12,
    status: "active",
    deadline: 60000,
  });

  // A reply on its way keeps it active.
  busy = true;
  t.mock.timers.tick(60000);
  assert.equal(brainstorms.get(key).status, "active");
  busy = false;
  brainstorms.replied(key);
  assert.equal(brainstorms.get(key).deadline, 60000 + REPLY_GRACE_MS);
  t.mock.timers.tick(REPLY_GRACE_MS);
  assert.equal(brainstorms.get(key).status, "idle");
  assert.equal(saved(path)[key].status, "idle");

  // The next comment restores the session; a new listener reads the state back.
  assert.equal(brainstorms.activate(key, { repo: "org/repo", number: 12 }), true);
  brainstorms.stop(key);
  assert.deepEqual(make().list(), [
    { key, repo: "org/repo", number: 12, status: "stopped", deadline: 240000 },
  ]);
  brainstorms.end(key);
  assert.equal(brainstorms.get(key), undefined);
  assert.deepEqual(saved(path), {});
  brainstorms.end(key); // nothing to end
});

test("brainstorms: a restarted listener arms the idle timer of active ones", () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  try {
    const path = join(mkdtempSync(join(tmpdir(), "deckhand-")), "brainstorms.json");
    const options = { path, idleMs: 1000, busy: () => false, log: () => {}, now: Date.now };
    createBrainstorms(options).activate("org/repo#1", { repo: "org/repo", number: 1 });
    const again = createBrainstorms(options);
    mock.timers.tick(1000);
    assert.equal(again.get("org/repo#1").status, "idle");
  } finally {
    mock.timers.reset();
  }
});

test("issue modes: kept across a restart, removed with null", () => {
  const path = join(mkdtempSync(join(tmpdir(), "deckhand-")), "modes.json");
  const modes = createIssueModes(path);
  assert.equal(modes.has("org/repo#1"), false);
  modes.set("org/repo#1", "review");
  assert.equal(createIssueModes(path).get("org/repo#1"), "review");
  modes.set("org/repo#1", null);
  assert.equal(createIssueModes(path).has("org/repo#1"), false);
});
