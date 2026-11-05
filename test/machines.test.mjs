// Machines (listener/machines.mjs, #595): what a machine registers, who reaches it, and which
// repositories are offered to it. The MCP tools and the dashboard's list: mcp.test.mjs.
import assert from "node:assert/strict";
import { test } from "node:test";
import { grantFor, grantsFrom, withGrants } from "../listener/grants.mjs";
import {
  createMachines,
  machineFields,
  MAX_MACHINES,
  offeredLabels,
  ONLINE_MS,
  repoMatches,
} from "../listener/machines.mjs";
import { parseRepoConfig } from "../listener/repo-config.mjs";
import { testConfig } from "./helpers.mjs";

const config = testConfig({ ALLOWED_USERS: "alice,bob" });
const machine = (labels) => ({ labels });
const settingsOf = (yaml) => parseRepoConfig(yaml, config).settings;

test("a repository is offered only with the operator's grant and its own machines: block", () => {
  const desk = machine(["unreal", "gpu"]);
  // Neither, or one of the two: never.
  assert.equal(offeredLabels({ granted: false, settings: settingsOf(""), machine: desk }), null);
  assert.equal(
    offeredLabels({ granted: false, settings: settingsOf("machines: true\n"), machine: desk }),
    null,
  );
  assert.equal(offeredLabels({ granted: true, settings: settingsOf(""), machine: desk }), null);
  assert.equal(
    offeredLabels({ granted: true, settings: settingsOf("machines: false\n"), machine: desk }),
    null,
  );
  // Both: every label of the machine's, or a machine without any.
  const both = settingsOf("machines: true\n");
  assert.deepEqual(offeredLabels({ granted: true, settings: both, machine: desk }), [
    "unreal",
    "gpu",
  ]);
  assert.deepEqual(offeredLabels({ granted: true, settings: both, machine: machine([]) }), []);
  // A grant that isn't plainly true grants nothing.
  assert.equal(offeredLabels({ granted: "yes", settings: both, machine: desk }), null);
});

test("machines.labels narrows the machines a repository takes, and their labels", () => {
  const narrowed = settingsOf("machines:\n  labels: [Unreal]\n");
  assert.deepEqual(narrowed.machines, { labels: ["unreal"] });
  const offered = (labels) =>
    offeredLabels({ granted: true, settings: narrowed, machine: machine(labels) });
  assert.deepEqual(offered(["unreal", "gpu"]), ["unreal"]);
  assert.equal(offered(["gpu"]), null);
  assert.equal(offered([]), null);
});

test("the machines grant is the operator's policies', per repository", () => {
  const grant = (names) =>
    withGrants(grantFor(grantsFrom({}, config), config, "org/app"), {
      granted: new Set(names),
      files: ["grants.rego"],
    });
  assert.equal(grantFor(grantsFrom({}, config), config, "org/app").allowMachines, false);
  assert.equal(grant([]).allowMachines, false);
  assert.equal(grant(["machines"]).allowMachines, true);
});

test("machines: in .deckhand.yaml: true, false, or labels; anything else is an error", () => {
  const parse = (text) => parseRepoConfig(text, config);
  assert.equal(parse("").settings.machines, null);
  assert.deepEqual(parse("machines: true\n").settings.machines, { labels: null });
  assert.equal(parse("machines: false\n").settings.machines, null);
  assert.deepEqual(parse("machines: {}\n").settings.machines, { labels: null });
  assert.deepEqual(parse("machines:\n  labels: [gpu, gpu, unreal]\n").settings.machines, {
    labels: ["gpu", "unreal"],
  });
  assert.deepEqual(parse("machines: yes\n").errors, [
    "machines: expected true, false or { labels: [...] }",
  ]);
  const wrong = parse("machines:\n  labels: [gpu, 'not one']\n  repos: [a/b]\n");
  assert.deepEqual(wrong.errors, [
    "machines.repos: unknown key (expected labels)",
    'machines.labels: expected a list of labels (letters, digits, ".", "_" and "-")',
  ]);
  // An error leaves it off: never more machines than meant.
  assert.equal(wrong.settings.machines, null);
  assert.equal(parse("machines:\n  labels: []\n").settings.machines, null);
});

test("a machine's fields: checked, labels in lower case, each once", () => {
  assert.deepEqual(
    machineFields({ name: " desk ", labels: ["GPU", "gpu"], repos: ["Org/*", "org/app"] }),
    { name: "desk", labels: ["gpu"], capacity: 1, repos: ["org/*", "org/app"], version: null },
  );
  for (const [input, message] of [
    [{ repos: ["org/app"] }, /`name`/],
    [{ name: "x".repeat(65), repos: ["org/app"] }, /`name`/],
    [{ name: "a\nb", repos: ["org/app"] }, /one line/],
    [{ name: "desk", repos: [] }, /`repos`/],
    [{ name: "desk", repos: ["*/*"] }, /isn't "owner\/name"/],
    [{ name: "desk", repos: ["org"] }, /isn't "owner\/name"/],
    [{ name: "desk", repos: ["org/app"], labels: ["a b"] }, /isn't a label/],
    [{ name: "desk", repos: ["org/app"], capacity: 0 }, /`capacity`/],
    [{ name: "desk", repos: ["org/app"], capacity: 1.5 }, /`capacity`/],
    [{ name: "desk", repos: ["org/app"], capacity: 17 }, /`capacity`/],
  ]) {
    assert.throws(() => machineFields(input), message, JSON.stringify(input));
  }
  assert.equal(repoMatches(["org/*"], "Org/App"), true);
  assert.equal(repoMatches(["org/app"], "org/app"), true);
  assert.equal(repoMatches(["org/app"], "org/other"), false);
  assert.equal(repoMatches(["other/*"], "org/app"), false);
});

test("an owner's machines: online while heartbeats come, capped, each name once", () => {
  const clock = { now: 1000 };
  let n = 0;
  const machines = createMachines({
    config,
    now: () => clock.now,
    newId: () => String(++n).padStart(16, "0"),
  });
  const desk = machines.register("alice", { name: "desk", repos: ["org/app"] });
  assert.equal(desk.online, true);
  clock.now += ONLINE_MS - 1;
  assert.equal(machines.list("alice")[0].online, true);
  clock.now += 1;
  assert.equal(machines.list("alice")[0].online, false);
  assert.equal(machines.heartbeat("alice", desk.id).online, true);
  // The same name in another case: the same machine.
  assert.equal(machines.register("alice", { name: "DESK", repos: ["org/app"] }).id, desk.id);
  for (let i = 1; i < MAX_MACHINES; i++) {
    machines.register("alice", { name: `m${i}`, repos: ["org/app"] });
  }
  assert.throws(
    () => machines.register("alice", { name: "one more", repos: ["org/app"] }),
    /remove one first/,
  );
  // Another owner's count is their own.
  assert.equal(machines.register("bob", { name: "desk", repos: ["org/app"] }).online, true);
  assert.equal(machines.list("bob").length, 1);
  assert.throws(() => machines.heartbeat("bob", desk.id), /No machine/);
  assert.throws(() => machines.remove("bob", desk.id), /No machine/);
  assert.throws(() => machines.heartbeat("alice", "../etc"), /No such machine/);
  // Someone not in ALLOWED_USERS registers nothing.
  assert.throws(() => machines.register("carol", { name: "desk", repos: ["org/app"] }), /users/);
});

test("offers: the repositories of the machine's that opt in, where its owner may start runs", async () => {
  const asked = [];
  const machines = createMachines({
    config,
    repoNames: async () => ["org/app", "org/game", "org/broken", "org/plain", "other/x"],
    granted: async (repo) => {
      asked.push(repo);
      if (repo === "org/broken") throw new Error("the policy service is away");
      return repo !== "org/plain";
    },
    settings: async (repo) => ({
      settings: settingsOf(
        repo === "org/game" ? "machines:\n  labels: [unreal]\n" : "machines: true\n",
      ),
      errors: [],
    }),
    mayRun: async (owner, repo) => !(owner === "alice" && repo === "org/app"),
  });
  const desk = machines.register("alice", { name: "desk", labels: ["unreal"], repos: ["org/*"] });
  // org/app: alice may not start runs there; org/broken: its grant can't be decided; org/plain:
  // not granted; other/x: not one of the machine's.
  assert.deepEqual(await machines.offers("alice", desk.id), [
    { repo: "org/game", labels: ["unreal"] },
  ]);
  assert.ok(!asked.includes("other/x"));
  const bobs = machines.register("bob", { name: "desk", repos: ["org/app", "org/game"] });
  // Bob's machine has no `unreal` label: org/game isn't offered to it.
  assert.deepEqual(await machines.offers("bob", bobs.id), [{ repo: "org/app", labels: [] }]);
});

test("a machine that isn't one: the answer doesn't repeat what was asked", () => {
  const machines = createMachines({ config });
  assert.throws(
    () => machines.heartbeat("alice", "<script>x</script>"),
    (error) => error.message === "No such machine of yours: register it again.",
  );
  assert.throws(() => machines.remove("alice", "0123456789abcdef"), /No machine 0123456789abcdef/);
});
