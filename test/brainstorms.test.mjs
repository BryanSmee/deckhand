import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mock, test } from "node:test";
import { createBrainstorms, createIssueModes, REPLY_GRACE_MS } from "../listener/brainstorms.mjs";
import { mapStore, tempDir } from "./helpers.mjs";

const saved = (path) => JSON.parse(readFileSync(path, "utf8"));

test("brainstorms: active, idle once the deadline passes, restored, stopped, ended", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const path = join(tempDir(t), "brainstorms.json");
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

test("brainstorms: a restarted listener arms the idle timer of active ones", (t) => {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  try {
    const path = join(tempDir(t), "brainstorms.json");
    const options = { path, idleMs: 1000, busy: () => false, log: () => {}, now: Date.now };
    createBrainstorms(options).activate("org/repo#1", { repo: "org/repo", number: 1 });
    const again = createBrainstorms(options);
    mock.timers.tick(1000);
    assert.equal(again.get("org/repo#1").status, "idle");
  } finally {
    mock.timers.reset();
  }
});

test("issue modes: kept across a restart, removed with null", async () => {
  const maps = mapStore();
  const modes = createIssueModes(await maps.map("modes"));
  assert.equal(modes.has("org/repo#1"), false);
  modes.set("org/repo#1", "review");
  assert.equal(createIssueModes(await maps.again("modes")).get("org/repo#1"), "review");
  modes.set("org/repo#1", null);
  assert.equal(createIssueModes(await maps.again("modes")).has("org/repo#1"), false);
});

test("respell: brainstorms and modes saved under another spelling move, timers and all", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const dir = tempDir(t);
  const spelled = (repo) => (repo.toLowerCase() === "org/repo" ? "Org/repo" : repo);
  const brainstorms = createBrainstorms({
    path: join(dir, "brainstorms.json"),
    idleMs: 60000,
    busy: () => false,
    log: () => {},
    now: Date.now,
  });
  brainstorms.activate("org/repo#12", { repo: "org/repo", number: 12 });
  brainstorms.respell(spelled);
  assert.deepEqual(brainstorms.keys(), ["Org/repo#12"]);
  assert.equal(brainstorms.get("Org/repo#12").repo, "Org/repo");
  t.mock.timers.tick(60000);
  assert.equal(brainstorms.get("Org/repo#12").status, "idle");
  assert.deepEqual(Object.keys(saved(join(dir, "brainstorms.json"))), ["Org/repo#12"]);

  const maps = mapStore();
  const modes = createIssueModes(await maps.map("modes"));
  modes.set("org/repo#3", "audit");
  modes.respell(spelled);
  assert.deepEqual(modes.keys(), ["Org/repo#3"]);
  assert.deepEqual(Object.fromEntries(await maps.again("modes")), { "Org/repo#3": "audit" });
});
