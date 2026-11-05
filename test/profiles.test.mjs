// profiles.mjs (#478): a chat's permissions profile, checked against its ceiling on every save
// (what would widen it refused) and narrowed to it at every start.
import assert from "node:assert/strict";
import { test } from "node:test";
import { outcomeOf } from "../listener/capabilities.mjs";
import {
  ceilingOf,
  checkProfile,
  DEFAULT_PROFILE,
  leftOut,
  narrowProfile,
} from "../listener/profiles.mjs";

// The outcome of a `chat` run whose policies allow `names` (the operator's layer), with the
// repo's `settings` and the operator's `grant` fields (grants.mjs).
function outcome(names, settings = { setup: "npm ci" }, grant = {}) {
  const rules = {
    operator: { allow: new Map(names.map((n) => [n, ["mode-chat.rego"]])), deny: [] },
  };
  return outcomeOf({
    rules,
    custom: false,
    settings,
    grant,
    repo: { private: true },
    mode: "chat",
  });
}

const CHAT = ["pull", "setup", "image:repo", "read:issues", "read:pulls", "read:actions"];
const GRANT = { hosts: ["registry.npmjs.org", "*.Example.org"] };
const MOUNTS = [
  { source: "/srv/ro", target: "/srv/ro", readOnly: true },
  { source: "/srv/rw", target: "/srv/rw", readOnly: false },
];

const ceiling = (names = CHAT, settings, grant = GRANT) =>
  ceilingOf({ outcome: outcome(names, settings, grant), grant, mounts: MOUNTS });

test("the ceiling: what a chat run gets, `pull` required, `push` never, the reasons for the rest", () => {
  const c = ceiling([...CHAT, "push", "docker"], { setup: "npm ci" });
  const row = (name) => c.capabilities.find((r) => r.name === name);
  assert.deepEqual(
    c.capabilities.filter((r) => r.allowed).map((r) => r.name),
    CHAT.filter((n) => n !== "image:repo"),
  );
  assert.equal(row("pull").required, true);
  assert.match(row("push").reason, /only read GitHub/);
  // Allowed by the policies, not asked for by the config (no `docker`, no `dockerfile`).
  assert.equal(row("docker").reason, ".deckhand.yaml doesn't set docker");
  assert.equal(row("image:repo").reason, ".deckhand.yaml doesn't set dockerfile");
  assert.equal(row("internet").reason, "no allow rule of the operator's policies gives it");
  // The grant's hosts, in lower case; its mounts, read-only either way (a chat doesn't push).
  assert.deepEqual(c.hosts, ["registry.npmjs.org", "*.example.org"]);
  assert.deepEqual(c.mounts, [
    { target: "/srv/ro", writable: false, reason: "the operator grants it read-only" },
    { target: "/srv/rw", writable: false, reason: "a chat doesn't push: its mounts are read-only" },
  ]);
  assert.deepEqual(
    c.github.map((l) => [l.level, l.allowed]),
    [
      ["read", true],
      ["comment", false],
      ["push", false],
    ],
  );
});

test("a profile within the ceiling is saved normalized: in the ceiling's order, hosts in lower case", () => {
  const { profile, errors } = checkProfile(
    {
      github: "read",
      capabilities: ["read:pulls", "pull"],
      hosts: ["Registry.npmjs.org"],
      mounts: [{ target: "/srv/rw" }],
    },
    ceiling(),
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(profile, {
    github: "read",
    capabilities: ["pull", "read:pulls"],
    hosts: ["registry.npmjs.org"],
    mounts: [{ target: "/srv/rw", readOnly: true }],
  });
  // Nothing said: everything the ceiling allows.
  assert.deepEqual(checkProfile({}, ceiling()).profile, DEFAULT_PROFILE);
});

test("widening attempts are refused: an unknown host, the engine without a grant, a read-write mount, a push level", () => {
  // The repo asks for an engine, the policies allow it, the operator doesn't grant it.
  const c = ceiling([...CHAT, "docker"], { setup: "npm ci", docker: {} }, GRANT);
  const refused = (body) => {
    const { profile, errors } = checkProfile(body, c);
    assert.equal(profile, null);
    return errors;
  };
  assert.deepEqual(refused({ hosts: ["evil.example"] }), [
    "`evil.example`: not among the hosts the operator grants this repository",
  ]);
  assert.deepEqual(refused({ capabilities: ["pull", "docker"] }), [
    "`docker`: the operator's policies don't grant docker to this repository (allow_grant)",
  ]);
  assert.deepEqual(refused({ mounts: [{ target: "/srv/ro", readOnly: false }] }), [
    "`/srv/ro`: read-write: the operator grants it read-only",
  ]);
  assert.deepEqual(refused({ mounts: [{ target: "/srv/rw", readOnly: false }] }), [
    "`/srv/rw`: read-write: a chat doesn't push: its mounts are read-only",
  ]);
  assert.deepEqual(refused({ mounts: [{ target: "/etc" }] }), [
    "`/etc`: not among the repository's granted mounts",
  ]);
  for (const level of ["comment", "push"]) {
    assert.match(refused({ github: level })[0], /^GitHub: `\w+`: chats only read GitHub/);
  }
  assert.match(refused({ github: "admin" })[0], /isn't a level/);
  assert.match(refused({ capabilities: ["pull", "push"] })[0], /^`push`: chats only read GitHub/);
  assert.deepEqual(refused({ capabilities: ["pull", "internet"] }), [
    "`internet`: no allow rule of the operator's policies gives it",
  ]);
  assert.deepEqual(refused({ capabilities: ["pull", "sudo"] }), [
    "`sudo`: not a capability Deckhand knows",
  ]);
  // `pull` can't be turned off, nor a capability kept without its need.
  assert.deepEqual(refused({ capabilities: ["setup"] }), [
    "`pull` can't be turned off: a chat works in a clone of the repository",
    "`setup` needs `pull`",
  ]);
  assert.deepEqual(refused({ hosts: "all" }), ["`hosts`: a list, or null for everything allowed"]);
  assert.deepEqual(refused({ admin: true }), ["`admin`: not part of a profile"]);
  assert.deepEqual(refused(null), ["a profile is an object"]);
});

test("at a start, a saved profile narrows to the ceiling of the day: what a grant or a policy dropped goes silently", () => {
  const saved = {
    github: "read",
    capabilities: ["pull", "setup", "read:issues"],
    hosts: ["registry.npmjs.org", "*.example.org"],
    mounts: [{ target: "/srv/rw", readOnly: true }],
  };
  assert.deepEqual(narrowProfile(saved, ceiling()), {
    github: "read",
    capabilities: ["pull", "setup", "read:issues"],
    hosts: ["registry.npmjs.org", "*.example.org"],
    mounts: [{ target: "/srv/rw", readOnly: true }],
  });
  // The grant lost a host, the policies `read:issues`, the config its setup: gone, no error.
  const later = ceilingOf({
    outcome: outcome(["pull", "setup", "read:pulls"], {}),
    grant: { hosts: ["*.example.org"] },
    mounts: [],
  });
  assert.deepEqual(narrowProfile(saved, later), {
    github: "read",
    capabilities: ["pull"],
    hosts: ["*.example.org"],
    mounts: [],
  });
  // The default: everything the ceiling allows, mounts read-only.
  const all = narrowProfile(null, ceiling());
  assert.deepEqual(all.capabilities, [
    "pull",
    "setup",
    "read:issues",
    "read:pulls",
    "read:actions",
  ]);
  assert.deepEqual(all.mounts, [
    { target: "/srv/ro", readOnly: true },
    { target: "/srv/rw", readOnly: true },
  ]);
  assert.equal(leftOut(all, ceiling()), null);
  // What it leaves out, for the run's log.
  assert.equal(
    leftOut(narrowProfile(saved, ceiling()), ceiling()),
    "read:pulls, read:actions; mounts: /srv/ro",
  );
});

test("a capability whose need a policy took away goes with it, whatever the profile kept", () => {
  // A ceiling whose `pull` is gone (an operator's own mode-chat.rego): nothing that needs it.
  const c = ceilingOf({ outcome: outcome(["setup", "read:issues"]), grant: GRANT, mounts: [] });
  assert.deepEqual(narrowProfile(null, c).capabilities, []);
});
