// Context repos, part 1 (#929): the config key, the grants' patterns, the start check, the
// `read:context` capability and its default policies (the real opa).
import assert from "node:assert/strict";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { grantedAccess, RunError } from "../listener/access.mjs";
import { agentFor } from "../listener/agents/index.mjs";
import { capabilitiesInput, outcomeOf, runInput } from "../listener/capabilities.mjs";
import { contextFolder, patternMatches } from "../listener/context-repos.mjs";
import {
  grantCheck,
  grantFor,
  grantsFrom,
  refusedByGrants,
  resolveMounts,
} from "../listener/grants.mjs";
import { createPolicies } from "../listener/policies.mjs";
import { parseRepoConfig } from "../listener/repo-config.mjs";
import { builtInPolicies } from "../policy-service/engine.mjs";
import { opaBinary } from "../policy-service/opa.mjs";
import { hasOpa, localService, policyEngineOf, tempDir, testConfig } from "./helpers.mjs";

const config = testConfig({ ALLOWED_USERS: "a" });
const parse = (yaml, repo = "org/app") => parseRepoConfig(yaml, config, { repo });
const grantOf = (files, repo = "org/app") => grantFor(grantsFrom(files, config), config, repo);

test("context_repos: names, refs and their folders, in lower case", () => {
  const { settings, errors } = parse(`context_repos:
  - Acme/Docs
  - { repo: acme/app, ref: v1.2 }
  - { repo: acme/app, ref: release/2.0 }
  - { repo: acme/app }
`);
  assert.deepEqual(errors, []);
  assert.deepEqual(settings.contextRepos, [
    { repo: "acme/docs", ref: null, folder: "/context/acme/docs" },
    { repo: "acme/app", ref: "v1.2", folder: "/context/acme/app@v1.2" },
    { repo: "acme/app", ref: "release/2.0", folder: "/context/acme/app@release-2.0" },
    { repo: "acme/app", ref: null, folder: "/context/acme/app" },
  ]);
  assert.equal(contextFolder("a/b", "x/y/z"), "/context/a/b@x-y-z");
  // None by default.
  assert.deepEqual(parse("").settings.contextRepos, []);
});

test("context_repos: what isn't an exact name, the run's own repo, twins and one folder for two", () => {
  const errors = (yaml, repo) => parse(yaml, repo).errors;
  assert.deepEqual(errors("context_repos: acme/docs\n"), [
    "context_repos: expected a list of <owner>/<name> or { repo, ref }",
  ]);
  assert.deepEqual(errors("context_repos: [acme/*, '*/docs', acme, a/b/c, -a/b, 3]\n"), [
    'context_repos.0: "acme/*": no wildcards here: name each repository (the operator\'s grant may use them)',
    'context_repos.1: "*/docs": no wildcards here: name each repository (the operator\'s grant may use them)',
    'context_repos.2: "acme": expected <owner>/<name>',
    'context_repos.3: "a/b/c": expected <owner>/<name>',
    'context_repos.4: "-a/b": expected <owner>/<name>',
    "context_repos.5: expected <owner>/<name> or { repo, ref }",
  ]);
  assert.deepEqual(errors("context_repos:\n  - { repo: a/b, branch: main }\n  - { ref: v1 }\n"), [
    "context_repos.0: branch: unknown (expected repo, ref)",
    "context_repos.1: null: expected <owner>/<name>",
  ]);
  // Its own repository, whatever the case; unknown when the caller doesn't say whose file it is.
  assert.deepEqual(errors("context_repos: [Org/App]\n"), [
    "context_repos.0: org/app: the run's own repository, already in /workspace",
  ]);
  assert.deepEqual(errors("context_repos: [org/app]\n", null), []);
  for (const ref of ["..", "a..b", "-x", "/x", "x/", "a//b", "a/.b", "x.lock", "x.lock/y", "a b"]) {
    assert.deepEqual(
      errors(`context_repos:\n  - { repo: a/b, ref: "${ref}" }\n`),
      [`context_repos.0: ref: ${JSON.stringify(ref)}: expected a branch, tag or commit name`],
      ref,
    );
  }
  assert.match(errors("context_repos:\n  - { repo: a/b, ref: 3 }\n")[0], /ref: 3: expected/);
  // The same repo and ref twice (case apart), and two that would share a folder.
  const twins = parse(`context_repos:
  - a/b
  - A/B
  - { repo: a/b, ref: release/1 }
  - { repo: a/b, ref: release-1 }
  - { repo: a/b, ref: release/1 }
`);
  assert.deepEqual(twins.errors, [
    "context_repos.1: a/b: listed twice",
    "context_repos.3: a/b@release-1: the same folder as a/b@release/1 (/context/a/b@release-1)",
    "context_repos.4: a/b@release/1: listed twice",
  ]);
  // An entry with an error is left out.
  assert.deepEqual(
    twins.settings.contextRepos.map((c) => c.folder),
    ["/context/a/b", "/context/a/b@release-1"],
  );
});

test("context_repos: /context is the sandbox's, no mount takes it over", () => {
  const { refused } = resolveMounts([{ path: "/context/x", readOnly: true }], { mounts: [] });
  assert.deepEqual(refused, ["`/context/x`: the sandbox uses /context itself"]);
});

test("grants: context_repos patterns, the owner exact, `*` within the name, both files adding up", () => {
  const files = {
    "default.yaml": "context_repos: [Acme/Shared-Docs]\n",
    "org/app.yaml": "context_repos: [acme/templates-*, acme/*, ACME/*]\n",
  };
  assert.deepEqual(grantOf(files).contextRepos, ["acme/shared-docs", "acme/templates-*", "acme/*"]);
  assert.deepEqual(grantOf(files, "org/other").contextRepos, ["acme/shared-docs"]);
  assert.deepEqual(grantOf({}).contextRepos, []);
  for (const bad of ["*/*", "*/docs", "*", "ac*/docs"]) {
    assert.throws(
      () => grantOf({ "org/app.yaml": `context_repos: ["${bad}"]\n` }),
      new RegExp(`context_repos: "${RegExp.escape(bad)}": no wildcard in the owner`),
      bad,
    );
  }
  for (const bad of ["acme", "a/b/c", "acme/", "acme/a b"]) {
    assert.throws(
      () => grantOf({ "org/app.yaml": `context_repos: ["${bad}"]\n` }),
      /context_repos: .*expected <owner>\/<name>, `\*` within the name/,
      bad,
    );
  }
  // In default.yaml too: a mistake there stops every run.
  assert.throws(
    () => grantsFrom({ "default.yaml": "context_repos: ['*/*']\n" }, config),
    /default\.yaml: context_repos: "\*\/\*": no wildcard in the owner/,
  );
  assert.throws(() => grantOf({ "org/app.yaml": "context_repos: acme/*\n" }), /expected a list/);
});

test("grants: a pattern matches the whole name, case-insensitive", () => {
  assert.ok(patternMatches("acme/*", "acme/x"));
  assert.ok(patternMatches("acme/*", "ACME/X.y"));
  assert.ok(!patternMatches("acme/*", "acmex/y"));
  assert.ok(!patternMatches("acme/*", "other/acme"));
  assert.ok(patternMatches("acme/templates-*", "acme/Templates-Web"));
  assert.ok(!patternMatches("acme/templates-*", "acme/old-templates-web"));
  assert.ok(!patternMatches("acme/templates-*", "acme/templates"));
  assert.ok(patternMatches("acme/docs", "Acme/Docs"));
  assert.ok(!patternMatches("acme/docs", "acme/docs2"));
  // `.` is a character, not any one.
  assert.ok(!patternMatches("acme/a.b", "acme/axb"));
});

// A grants folder holding org/app.yaml (`text`), and the config reading it.
function granted(t, text) {
  const dir = realpathSync(tempDir(t));
  mkdirSync(join(dir, "org"));
  writeFileSync(join(dir, "org", "app.yaml"), text);
  return testConfig({ ALLOWED_USERS: "a", GRANTS_DIR: dir });
}

const YAML = "context_repos:\n  - acme/docs\n  - { repo: acme/app, ref: v1 }\n  - other/lib\n";

test("the start check: a requested repo no pattern grants stops the run, the reply naming it", async (t) => {
  const withGrant = granted(t, "context_repos: [acme/*]\n");
  const { settings } = parse(YAML);
  const check = await grantCheck(withGrant, "org/app", settings);
  assert.deepEqual(check.context, [
    "`other/lib`: no pattern of the operator's `context_repos` grants it (`acme/*`)",
  ]);
  assert.equal(refusedByGrants(check), true);
  const logged = [];
  const task = { repo: "org/app", base: "main", live: { mode: "work", capabilities: ["pull"] } };
  const io = { agent: agentFor("claude"), note: () => {}, log: (m) => logged.push(m) };
  await assert.rejects(
    grantedAccess(withGrant, task, settings, io),
    (e) =>
      e instanceof RunError &&
      e.message.startsWith(
        "Claude can't run here: context repos requested by `.deckhand.yaml` are refused.\n\n- `other/lib`: no pattern",
      ) &&
      /list them under `context_repos` in the repository's grants file/.test(e.message),
  );
  assert.match(logged.join("\n"), /org\/app: .*context repos its grant doesn't list/);
  // Nothing granted: each one, saying so.
  const none = await grantCheck(granted(t, "hosts: [pypi.org]\n"), "org/app", settings);
  assert.deepEqual(none.context, [
    "`acme/docs`: the operator grants this repository no context repositories (`context_repos`)",
    "`acme/app`: the operator grants this repository no context repositories (`context_repos`)",
    "`other/lib`: the operator grants this repository no context repositories (`context_repos`)",
  ]);
  // All granted: the run goes on. A grant nobody requests loads nothing.
  const all = granted(t, "context_repos: [acme/*, other/lib]\n");
  assert.deepEqual((await grantCheck(all, "org/app", settings)).context, []);
  await grantedAccess(all, task, settings, io);
  const nobody = await grantCheck(all, "org/app", parse("").settings);
  assert.deepEqual(nobody.context, []);
  assert.equal(refusedByGrants(nobody), false);
});

// A layer's answer, as policies.mjs evaluateCapabilities() gives it.
const layer = (names, deny = []) => ({
  allow: new Map(names.map((n) => [n, ["mode.rego"]])),
  deny,
});

test("read:context: needs `pull`, used when the config names context repos, in the run input", () => {
  const { settings } = parse(YAML);
  const outcome = (names, s = settings, repo = { private: false }) =>
    outcomeOf({ rules: { operator: layer(names) }, custom: false, settings: s, grant: {}, repo });
  assert.deepEqual(outcome(["pull", "read:context"]).used, ["pull", "read:context"]);
  const unasked = outcome(["pull", "read:context"], parse("").settings);
  assert.deepEqual(unasked.used, ["pull"]);
  assert.equal(
    unasked.capabilities.find((c) => c.name === "read:context").reason,
    ".deckhand.yaml doesn't set context_repos",
  );
  // Without `pull`: an error, as for every capability whose need no rule gives.
  assert.deepEqual(outcome(["read:context"]).errors, [
    "`read:context` needs `pull`, which the run doesn't get",
  ]);
  // A pull denied takes it along.
  const denied = outcomeOf({
    rules: { operator: layer(["pull", "read:context"], [{ capability: "pull", reason: "no" }]) },
    custom: false,
    settings,
    grant: {},
    repo: { private: false },
  });
  assert.deepEqual(denied.used, []);
  // The input names each repo once, whatever its refs.
  const input = capabilitiesInput({ repo: { name: "org/app" }, mode: "work", settings });
  assert.deepEqual(input.context_repos, ["acme/docs", "acme/app", "other/lib"]);
  const item = { reason: null, trigger: "work" };
  const run = runInput({ repo: { name: "org/app" }, mode: "work", item, fork: true, settings });
  assert.deepEqual(run.context_repos, ["acme/docs", "acme/app", "other/lib"]);
  assert.deepEqual(
    capabilitiesInput({ repo: { name: "org/app" }, mode: "work" }).context_repos,
    [],
  );
});

test("pull+internet: risky when a context repo the run reads is private or unknown", () => {
  const { settings } = parse(YAML);
  const grant = { allowResearch: true };
  const outcome = (names, repo, s = settings) =>
    outcomeOf({ rules: { operator: layer(names) }, custom: false, settings: s, grant, repo });
  const reads = ["pull", "internet", "read:context"];
  // A public repository reading context repos of unknown visibility: refused.
  const unknown = outcome(reads, { private: false });
  assert.equal(unknown.errors.length, 1);
  assert.match(unknown.errors[0], /^`pull` with `internet`: .*context repo's.*`pull\+internet`$/);
  // One known private among public ones: refused.
  const context = { "acme/docs": false, "acme/app": false, "other/lib": true };
  assert.equal(outcome(reads, { private: false, context }).errors.length, 1);
  // All known public: nothing risky.
  const open = { ...context, "other/lib": false };
  assert.deepEqual(outcome(reads, { private: false, context: open }).errors, []);
  // Without `read:context` (or without context repos), the run reads none of them.
  assert.deepEqual(outcome(["pull", "internet"], { private: false }).errors, []);
  assert.deepEqual(outcome(reads, { private: false }, parse("").settings).errors, []);
  // The operator's allow rule naming it: used, with a warning.
  const named = outcome([...reads, "pull+internet"], { private: false });
  assert.deepEqual(named.errors, []);
  assert.match(named.warnings[0], /the operator's `pull\+internet` allows it/);
});

test(
  "the real opa: every built-in mode with `pull` gets read:context, denied to a fork's pull request",
  { skip: !hasOpa() && "no opa on the PATH" },
  async (t) => {
    const policies = createPolicies({
      config: {},
      github: async () => new Response("{}", { status: 404 }),
      service: localService(
        policyEngineOf(t, {
          opa: opaBinary(),
          readBuiltIn: () => builtInPolicies(),
          readOperator: () => new Map(),
        }),
      ),
    });
    const modes = ["work", "brainstorm", "bug", "idea", "review", "chat", "discussion", "research"];
    const inputs = {};
    for (const mode of modes) {
      for (const fork of [false, true]) {
        inputs[`${mode}:${fork}`] = capabilitiesInput({ repo: { name: "org/app" }, mode, fork });
      }
    }
    const { results, error } = await policies.capabilityRules("org/app", "main", inputs);
    assert.equal(error, undefined);
    for (const mode of modes) {
      const gives = results[`${mode}:false`].operator.allow.has("read:context");
      assert.equal(gives, mode !== "research", mode);
      assert.deepEqual(results[`${mode}:false`].operator.deny, [], mode);
      assert.deepEqual(
        results[`${mode}:true`].operator.deny.map((d) => [d.capability, d.file]),
        [["read:context", "context.rego"]],
        mode,
      );
      assert.equal(
        results[`${mode}:true`].operator.deny[0].reason,
        "a pull request from a fork reads no context repos",
      );
    }
  },
);
