import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { createBrainstorms, createIssueModes, REPLY_GRACE_MS } from "../listener/brainstorms.mjs";
import { AGENTS } from "../listener/agents/index.mjs";
import { isApart } from "../listener/modes.mjs";
import { promptFor } from "../listener/prompts.mjs";
import { sandboxSpec } from "../listener/sandbox-spec.mjs";
import { mapStore } from "./helpers.mjs";

test("brainstorms: active, idle once the deadline passes, restored, stopped, ended", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const maps = mapStore();
  let busy = false;
  const options = { idleMs: 60000, busy: () => busy, log: () => {}, now: Date.now };
  const brainstorms = createBrainstorms({ brainstorms: await maps.map("brainstorms"), ...options });
  const stored = async () => Object.fromEntries(await maps.again("brainstorms"));
  const key = "org/repo#12";
  assert.equal(brainstorms.activate(key, { repo: "org/repo", number: 12 }), false);
  assert.equal(brainstorms.get(key).status, "active");
  assert.deepEqual((await stored())[key], {
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
  assert.equal((await stored())[key].status, "idle");

  // The next comment restores the session; the next copy reads the state back.
  assert.equal(brainstorms.activate(key, { repo: "org/repo", number: 12 }), true);
  brainstorms.stop(key);
  const again = createBrainstorms({ brainstorms: await maps.again("brainstorms"), ...options });
  assert.deepEqual(again.list(), [
    { key, repo: "org/repo", number: 12, status: "stopped", deadline: 240000 },
  ]);
  brainstorms.end(key);
  assert.equal(brainstorms.get(key), undefined);
  assert.deepEqual(await stored(), {});
  brainstorms.end(key); // nothing to end
});

test("brainstorms: the next copy arms the idle timer of active ones, which fires once", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  try {
    const maps = mapStore();
    const copy = async (logged = []) => ({
      logged,
      brainstorms: createBrainstorms({
        brainstorms: await maps.again("brainstorms"),
        idleMs: 1000,
        busy: () => false,
        log: (line) => logged.push(line),
        now: Date.now,
      }),
    });
    (await copy()).brainstorms.activate("org/repo#1", { repo: "org/repo", number: 1 });
    // A deadline that passed while no copy acted.
    await maps.store.set("brainstorms/org/repo#2", {
      repo: "org/repo",
      number: 2,
      status: "active",
      deadline: Date.now() - 1,
    });
    // The lease handed over: the next copy arms the timers from the deadlines.
    const { brainstorms, logged } = await copy();
    mock.timers.tick(0);
    assert.equal(brainstorms.get("org/repo#2").status, "idle");
    mock.timers.tick(400);
    assert.equal(brainstorms.get("org/repo#1").status, "active");
    mock.timers.tick(5000);
    assert.equal(brainstorms.get("org/repo#1").status, "idle");
    assert.deepEqual(logged, ["org/repo#2: brainstorm idle", "org/repo#1: brainstorm idle"]);
    assert.equal((await maps.again("brainstorms")).get("org/repo#1").status, "idle");
  } finally {
    mock.timers.reset();
  }
});

test("brainstorms: ended by a comment, deleted from the store once the queue has that comment", async () => {
  const maps = mapStore();
  const options = { idleMs: 60000, busy: () => false, log: () => {} };
  let written;
  const queueSaved = () => new Promise((resolve) => (written = resolve));
  const brainstorms = createBrainstorms({
    brainstorms: await maps.map("brainstorms"),
    queueSaved,
    ...options,
  });
  brainstorms.activate("org/repo#4", { repo: "org/repo", number: 4 });
  brainstorms.end("org/repo#4");
  assert.equal(brainstorms.get("org/repo#4"), undefined);
  // Killed before the queue was written: the brainstorm is still in the store, as is the
  // comment that ended it in the queue (or not yet: it came again then).
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await maps.store.get("brainstorms/org/repo#4").then((b) => b?.status), "active");
  written();
  await maps.settled();
  assert.equal(await maps.store.get("brainstorms/org/repo#4"), null);
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
  const maps = mapStore();
  const spelled = (repo) => (repo.toLowerCase() === "org/repo" ? "Org/repo" : repo);
  const brainstorms = createBrainstorms({
    brainstorms: await maps.map("brainstorms"),
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
  assert.deepEqual([...(await maps.again("brainstorms")).keys()], ["Org/repo#12"]);

  const modes = createIssueModes(await maps.map("modes"));
  modes.set("org/repo#3", "audit");
  modes.respell(spelled);
  assert.deepEqual(modes.keys(), ["Org/repo#3"]);
  assert.deepEqual(Object.fromEntries(await maps.again("modes")), { "Org/repo#3": "audit" });
});

// A brainstorm's sandbox and the issue's work's (sandbox-spec.mjs), as preparation.mjs leaves
// their parts: the brainstorm gets no caches (no `setup` to fill them).
test("a brainstorm and the issue's work share no writable volume; work reads what was settled from the issue", () => {
  const config = { claudeCodeVolume: "deckhand-claude-code", claudeCodeVersion: "2.0.0" };
  const specOf = (mode, capabilities, caches) => {
    const live = {
      id: `deckhand-org-repo-12-${mode}`,
      key: "org/repo#12",
      mode,
      light: isApart(mode),
      capabilities,
      fork: false,
      handoff: false,
      record: { provider: null, model: "opus", effort: "high" },
    };
    const task = { repo: "org/repo", base: "main", kind: "issue", number: 12, live };
    task.name = "deckhand-org-repo-12";
    const run = { config, task, agent: AGENTS.claude, bot: { name: "b", email: "b@x" } };
    return sandboxSpec(run, "p", "m", {
      image: "deckhand-sandbox",
      caches,
      settings: { setup: "npm ci" },
      mounts: [{ source: "/srv/api", target: "/srv/api", readOnly: false }],
    });
  };
  const light = specOf("brainstorm", ["pull", "image:repo", "read:issues", "read:pulls"], []);
  const work = specOf(
    "work",
    ["pull", "push", "setup", "image:repo", "read:issues"],
    [{ name: "deckhand-cache-org-repo-npm", path: "/home/node/.npm" }],
  );
  const named = (spec, kind) => spec.volumes.filter((v) => v.kind === kind).map((v) => v.name);
  assert.deepEqual(named(light, "session"), [
    "deckhand-org-repo-12-light-workspace",
    "deckhand-org-repo-12-light-claude",
  ]);
  assert.deepEqual(named(work, "session"), [
    "deckhand-org-repo-12-workspace",
    "deckhand-org-repo-12-claude",
  ]);
  // The granted host path: read-only for the brainstorm, writable for the work.
  const mount = (spec) => spec.volumes.find((v) => v.kind === "mount").readOnly;
  assert.deepEqual([mount(light), mount(work)], [true, false]);
  // Nothing the brainstorm could write is mounted by the work.
  const writable = (spec) => new Set(spec.volumes.filter((v) => !v.readOnly).map((v) => v.name));
  const shared = [...writable(work)].filter((name) => writable(light).has(name));
  assert.deepEqual(shared, []);
  // A fresh session, from the issue: it reads what the brainstorm settled there.
  const prompt = promptFor(
    { repo: "org/repo", kind: "issue", number: 12, base: "main", settings: {} },
    { mode: "work", text: "", settings: {}, config: { users: [], hosts: [] }, grant: {} },
  );
  assert.match(prompt, /^Work on GitHub issue #12 of org\/repo/);
  assert.match(prompt, /gh issue view 12 --comments`\. If it was brainstormed there/);
});
