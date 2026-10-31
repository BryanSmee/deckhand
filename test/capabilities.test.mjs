// What a run gets (capabilities.mjs): the catalogue's dependencies and risky combinations,
// checked in code, the greedy use of what the policies allow, and Deckhand's default policies
// (policy/mode-*.rego) with the real opa, which give each built-in mode what it had before
// capabilities.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CAPABILITIES,
  capabilitiesInput,
  KNOWN,
  modeOutcomes,
  modesOf,
  outcomeOf,
  RISKY,
} from "../listener/capabilities.mjs";
import { LIGHT, MODES, OPEN, permissionsFor } from "../listener/modes.mjs";
import { createPolicies } from "../listener/policies.mjs";
import { builtInPolicies } from "../policy-service/engine.mjs";
import { opaBinary } from "../policy-service/opa.mjs";
import {
  capabilityPolicies,
  defaultCapabilities,
  hasOpa,
  localService,
  policyEngineOf,
  WORK_CAPABILITIES,
} from "./helpers.mjs";

// A layer's answer, as policies.mjs evaluateCapabilities() gives it: `allow`, name → files.
const layer = (allow = {}, deny = []) => ({ allow: new Map(Object.entries(allow)), deny });
// Every capability allowed by the operator's `mode.rego`.
const everything = () => Object.fromEntries([...KNOWN].map((name) => [name, ["mode.rego"]]));
const full = {
  setup: "npm ci",
  dockerfile: "Dockerfile",
  docker: { cache: false },
  preview: { command: "x" },
};
const granted = {
  allowDockerfile: true,
  allowBranchDockerImages: true,
  allowDocker: true,
  allowPreview: true,
  allowResearch: true,
};
const outcome = ({
  allow = everything(),
  deny = [],
  repo,
  custom = false,
  settings = full,
  grant = granted,
  isPrivate = true,
} = {}) =>
  outcomeOf({
    rules: { operator: layer(allow, deny), ...(repo && { repo }) },
    custom,
    settings,
    grant,
    repo: { private: isPrivate },
  });
const only = (...names) => Object.fromEntries(names.map((name) => [name, ["mode.rego"]]));

test("the catalogue: its names, dependencies and config sides", () => {
  assert.deepEqual(
    CAPABILITIES.map((c) => c.name),
    [
      "pull",
      "push",
      "setup",
      "image:repo",
      "image:branch",
      "docker",
      "preview",
      "internet",
      "read:issues",
      "read:pulls",
      "read:discussions",
      "read:actions",
    ],
  );
  const needs = Object.fromEntries(
    CAPABILITIES.filter((c) => c.needs.length).map((c) => [c.name, c.needs]),
  );
  assert.deepEqual(needs, {
    push: ["pull"],
    setup: ["pull"],
    "image:repo": ["pull"],
    "image:branch": ["push", "image:repo"],
    docker: ["pull"],
    // Until #497: without `pull`, a run has no token to read with.
    "read:issues": ["pull"],
    "read:pulls": ["pull"],
    "read:discussions": ["pull"],
    "read:actions": ["pull"],
  });
  for (const c of CAPABILITIES) {
    assert.ok(c.what && c.enforcedBy, c.name);
    // Every dependency is a capability of the catalogue.
    for (const need of c.needs) assert.ok(KNOWN.has(need), need);
  }
  assert.deepEqual(
    RISKY.map((r) => r.name),
    ["pull+internet"],
  );
});

test("each dependency: a capability whose need no allow rule gives stops the run", () => {
  const cases = [
    [["push"], "`push` needs `pull`"],
    [["setup"], "`setup` needs `pull`"],
    [["image:repo"], "`image:repo` needs `pull`"],
    [["docker"], "`docker` needs `pull`"],
    [["pull", "image:repo", "image:branch"], "`image:branch` needs `push`"],
    [["pull", "push", "image:branch"], "`image:branch` needs `image:repo`"],
    [["read:issues"], "`read:issues` needs `pull`"],
    [["read:pulls"], "`read:pulls` needs `pull`"],
    [["read:discussions"], "`read:discussions` needs `pull`"],
    [["read:actions"], "`read:actions` needs `pull`"],
  ];
  for (const [names, error] of cases) {
    const said = outcome({ allow: only(...names) });
    assert.deepEqual(said.used, names);
    assert.deepEqual(said.errors, [`${error}, which the run doesn't get`]);
  }
  // With what they need, none.
  assert.deepEqual(
    outcome({ allow: only("pull", "push", "image:repo", "image:branch") }).errors,
    [],
  );
  // A dependency denied narrows: its dependents go too, with a warning, and the run starts.
  const denied = outcome({
    allow: only("pull", "push", "setup", "read:issues"),
    deny: [{ capability: "pull", reason: "no code here", file: "deny.rego" }],
  });
  assert.deepEqual(denied.errors, []);
  assert.deepEqual(denied.used, []);
  const row = denied.capabilities.find((c) => c.name === "setup");
  assert.deepEqual(row, {
    name: "setup",
    status: "denied",
    used: false,
    files: [{ layer: "operator", file: "deny.rego" }],
    reason: "it needs `pull`: no code here",
  });
  assert.deepEqual(denied.warnings, [
    "`push` isn't used: it needs `pull`: no code here",
    "`setup` isn't used: it needs `pull`: no code here",
    "`read:issues` isn't used: it needs `pull`: no code here",
  ]);
});

test("a not-granted capability whose need goes isn't an error; a review or discussion needs `pull`", () => {
  const said = outcome({
    allow: only("pull", "image:repo", "read:issues"),
    deny: [{ capability: "pull", reason: "no code", file: "d.rego" }],
    grant: { ...granted, allowDockerfile: false },
  });
  assert.deepEqual(said.errors, []);
  assert.equal(said.capabilities.find((c) => c.name === "image:repo").status, "denied");
  // Only the used one is said.
  assert.deepEqual(said.warnings, ["`read:issues` isn't used: it needs `pull`: no code"]);
  for (const mode of ["review", "discussion"]) {
    const bare = outcomeOf({
      rules: { operator: layer({}) },
      custom: false,
      settings: {},
      grant: granted,
      repo: { private: true },
      mode,
    });
    assert.match(bare.errors[0], new RegExp(`^a \`${mode}\` run needs \`pull\`: `));
  }
});

test("a research run given `pull` doesn't start: it has no token to clone with (#497)", () => {
  const said = outcomeOf({
    rules: { operator: layer(only("pull", "internet")) },
    custom: false,
    settings: {},
    grant: granted,
    repo: { private: false },
    mode: "research",
  });
  assert.deepEqual(said.errors, [
    "a `research` run can't have `pull` yet: it has no GitHub token to clone with (#497)",
  ]);
  const internet = outcomeOf({
    rules: { operator: layer(only("internet")) },
    custom: false,
    settings: {},
    grant: granted,
    repo: { private: true },
    mode: "research",
  });
  assert.deepEqual(internet.errors, []);
});

test("a policy denying `image:repo` denies a pull request branch's image too", () => {
  const said = outcome({
    deny: [{ capability: "image:repo", reason: "base image only", file: "img.rego" }],
  });
  assert.deepEqual(said.errors, []);
  const branch = said.capabilities.find((c) => c.name === "image:branch");
  assert.equal(branch.status, "denied");
  assert.equal(branch.reason, "it needs `image:repo`: base image only");
});

test("forks don't push: a work run with branch images granted keeps its code, without `push` or `image:branch`", () => {
  const said = outcomeOf({
    rules: {
      operator: layer(Object.fromEntries(WORK_CAPABILITIES.map((c) => [c, ["mode-work.rego"]]))),
      repo: layer({}, [{ capability: "push", reason: "forks don't push", file: "forks.rego" }]),
    },
    custom: false,
    settings: full,
    grant: granted,
    repo: { private: true },
  });
  assert.deepEqual(said.errors, []);
  assert.deepEqual(said.used, [
    "pull",
    "setup",
    "image:repo",
    "docker",
    "preview",
    "read:issues",
    "read:pulls",
    "read:discussions",
    "read:actions",
  ]);
  const branch = said.capabilities.find((c) => c.name === "image:branch");
  assert.equal(branch.status, "denied");
  assert.deepEqual(branch.files, [{ layer: "repo", file: "forks.rego" }]);
  assert.equal(branch.reason, "it needs `push`: forks don't push");
});

test("the risky combination: `pull` of a repository not known to be public with `internet`", () => {
  const allow = only("pull", "internet");
  const refused = outcome({ allow });
  assert.equal(refused.errors.length, 1);
  assert.match(
    refused.errors[0],
    /^`pull` with `internet`: a private repository's code next to the open internet: .+\. Refused unless an allow rule of the operator's policies gives `pull\+internet`$/,
  );
  // Unknown visibility counts as private; a public repository's code is no secret.
  assert.equal(outcome({ allow, isPrivate: null }).errors.length, 1);
  assert.deepEqual(outcome({ allow, isPrivate: false }).errors, []);
  // Named by the operator: used, with a warning.
  const named = outcome({ allow: only("pull", "internet", "pull+internet") });
  assert.deepEqual(named.errors, []);
  assert.deepEqual(named.used, ["pull", "internet"]);
  assert.match(named.warnings[0], /\(the operator's `pull\+internet` allows it\)$/);
  // The repository's allow rules can't name it, even for its own modes.
  const repo = layer(only("pull", "internet", "pull+internet"));
  assert.equal(outcome({ allow, repo, custom: true }).errors.length, 1);
});

test("greedy: allowed and asked for by the config, granted when a grant gates it", () => {
  const all = outcome();
  assert.deepEqual(
    all.used,
    [...KNOWN].filter((n) => n !== "pull+internet"),
  );
  // The config asks for nothing: what has a config side isn't used.
  const none = outcome({ settings: {}, isPrivate: false });
  assert.deepEqual(none.used, [
    "pull",
    "push",
    "internet",
    "read:issues",
    "read:pulls",
    "read:discussions",
    "read:actions",
  ]);
  const row = (said, name) => said.capabilities.find((c) => c.name === name);
  assert.deepEqual(row(none, "setup"), {
    name: "setup",
    status: "not-asked",
    used: false,
    files: [{ layer: "operator", file: "mode.rego" }],
    reason: ".deckhand.yaml doesn't set setup or caches",
  });
  // Caches alone ask for `setup`, which brings them.
  assert.equal(row(outcome({ settings: { caches: ["/x"] } }), "setup").used, true);
  // A grant missing: an error, but for `image:branch`, which goes without.
  const ungranted = outcome({
    grant: { ...granted, allowDocker: false, allowBranchDockerImages: false },
  });
  assert.equal(row(ungranted, "docker").status, "not-granted");
  assert.equal(row(ungranted, "image:branch").status, "not-granted");
  assert.deepEqual(ungranted.errors, [
    "`docker`: the operator's grants don't set `allow_docker: true` for this repository",
  ]);
  // Grants that can't be read give nothing they gate.
  assert.equal(row(outcome({ grant: null }), "internet").status, "not-granted");
});

test("a deny wins, with its reason and file; a repo's own mode needs the repo's allow too", () => {
  const denied = outcome({
    deny: [{ capability: "push", reason: "reads only", file: "ro.rego", layer: "x" }],
    repo: layer({}, [{ capability: "docker", reason: "no engine here", file: "repo.rego" }]),
  });
  const row = (said, name) => said.capabilities.find((c) => c.name === name);
  assert.deepEqual(row(denied, "push"), {
    name: "push",
    status: "denied",
    used: false,
    files: [{ layer: "operator", file: "ro.rego" }],
    reason: "reads only",
  });
  // The repo's deny rules apply to built-in modes too.
  assert.equal(row(denied, "docker").status, "denied");
  assert.deepEqual(row(denied, "docker").files, [{ layer: "repo", file: "repo.rego" }]);
  // Its own mode: both layers' allows, both files named.
  const own = outcome({ custom: true, repo: layer({ pull: ["audit.rego"] }) });
  assert.deepEqual(own.used, ["pull"]);
  assert.deepEqual(row(own, "pull").files, [
    { layer: "operator", file: "mode.rego" },
    { layer: "repo", file: "audit.rego" },
  ]);
  assert.equal(row(own, "push").reason, "no allow rule of the repository's policies gives it");
  assert.equal(
    row(outcome({ allow: {} }), "pull").reason,
    "no allow rule of the operator's policies gives it",
  );
  // Without any of the repo's allows: refused, naming the rule to add, rather than a run
  // without the code its mode expects.
  const bare = outcome({ custom: true });
  assert.deepEqual(bare.used, []);
  assert.deepEqual(bare.errors, [
    "no `allow_capabilities` rule of the repository's policies (.deckhand/policy/) gives this mode anything: add one naming what its runs get (`pull`, `push`, `setup`…)",
  ]);
});

test("a risky combination's name does nothing but in the operator's allow rules: a warning", () => {
  const said = outcome({
    allow: only("pull", "internet"),
    deny: [{ capability: "pull+internet", reason: "no", file: "a.rego" }],
    repo: layer(only("pull+internet")),
    isPrivate: false,
  });
  assert.deepEqual(said.errors, []);
  assert.equal(said.warnings.length, 2);
  assert.match(
    said.warnings[0],
    /^`allow_capabilities` of the repository's policies names `pull\+internet`, which only an allow rule of the operator's counts/,
  );
  assert.match(
    said.warnings[1],
    /^`deny_capabilities` of the operator's policies names `pull\+internet`/,
  );
});

test("a name nobody knows is a warning, in either rule", () => {
  const said = outcome({
    allow: only("pull", "clone"),
    deny: [{ capability: "pussh", reason: "x", file: "a.rego" }],
  });
  assert.deepEqual(said.errors, []);
  assert.equal(said.warnings.length, 2);
  assert.match(said.warnings[0], /^`allow_capabilities` of the operator's policies names `clone`/);
  assert.match(said.warnings[1], /^`deny_capabilities` of the operator's policies names `pussh`/);
});

test("the input: the repo and its visibility, the mode, its issue, reason, fork, trigger and command", () => {
  assert.deepEqual(
    capabilitiesInput({
      repo: { name: "org/repo", private: true },
      mode: "audit",
      issue: 3,
      reason: "conflict",
      fork: true,
      trigger: "comment",
      command: "work",
    }),
    {
      repo: { name: "org/repo", private: true },
      mode: "audit",
      custom_mode: true,
      issue: 3,
      reason: "conflict",
      fork: true,
      trigger: "comment",
      command: "work",
    },
  );
  // Lower case, as the run input's: GitHub's spelling doesn't decide a rule.
  assert.equal(
    capabilitiesInput({ repo: { name: "Org/Repo" }, mode: "work" }).repo.name,
    "org/repo",
  );
  const bare = capabilitiesInput({ repo: { name: "org/repo" }, mode: "work" });
  assert.deepEqual(bare, {
    repo: { name: "org/repo", private: null },
    mode: "work",
    custom_mode: false,
    issue: null,
    reason: null,
    fork: false,
    trigger: null,
    command: null,
  });
});

test("modesOf: the built-in modes that run, review with its block, research with its grant, then the repo's own", () => {
  const names = (settings, grant) =>
    modesOf(settings, grant).map((m) => (m.custom ? `+${m.mode}` : m.mode));
  const builtIn = Object.keys(MODES).filter((m) => !["policy", "review", "research"].includes(m));
  assert.deepEqual(names({}), builtIn);
  assert.deepEqual(names({ review: {}, modes: { audit: {} } }, { allowResearch: true }), [
    ...Object.keys(MODES).filter((m) => m !== "policy"),
    "+audit",
  ]);
});

// The policies' engine with the real opa: Deckhand's files (all of them by default), the
// operator's over them and the repo's (name → text).
function realPolicies(t, { builtIn = null, operator = {}, repo = {} } = {}) {
  return createPolicies({
    config: {},
    github: async (name, method, path) => {
      if (path.startsWith("/repos/org/repo/contents/.deckhand/policy")) {
        if (!Object.keys(repo).length) return new Response("{}", { status: 404 });
        return Response.json(Object.keys(repo).map((n) => ({ type: "file", name: n, sha: n })));
      }
      const sha = path.split("/").pop();
      return Response.json({ content: Buffer.from(repo[sha]).toString("base64") });
    },
    // The policy service's engine with the real opa: the capabilities are evaluated there.
    service: localService(
      policyEngineOf(t, {
        opa: opaBinary(),
        readBuiltIn: () => (builtIn ? new Map(Object.entries(builtIn)) : builtInPolicies()),
        readOperator: () => new Map(Object.entries(operator)),
      }),
    ),
  });
}

test(
  "the real opa: Deckhand's defaults give each built-in mode what it had before capabilities",
  { skip: !hasOpa() && "no opa on the PATH" },
  async (t) => {
    const policies = realPolicies(t);
    const settings = { review: {}, modes: { audit: {} } };
    const modes = modesOf(settings, granted);
    const inputs = Object.fromEntries(
      modes.map(({ mode }) => [mode, capabilitiesInput({ repo: { name: "org/repo" }, mode })]),
    );
    const { results, error } = await policies.capabilityRules("org/repo", "main", inputs);
    assert.equal(error, undefined);
    for (const { mode } of modes) {
      const allowed = [...results[mode].operator.allow.keys()].sort();
      assert.deepEqual(allowed, [...defaultCapabilities(inputs[mode])].sort(), mode);
      // And what its traits (modes.mjs) gave it, so the two can't drift apart: an open mode the
      // internet alone; a light one no branch, setup or engine; a token with discussions, their
      // reads; a work run the rest.
      const has = (c) => allowed.includes(c);
      if (OPEN.has(mode)) assert.deepEqual(allowed, ["internet"], mode);
      else {
        assert.ok(has("pull") && !has("internet"), mode);
        for (const c of ["push", "setup", "docker", "image:branch", "preview"]) {
          assert.equal(has(c), !LIGHT.has(mode), `${mode}: ${c}`);
        }
        // A work run's, or a token that reads discussions (a discussion run's).
        const discussions = !LIGHT.has(mode) || !!permissionsFor(mode)?.discussions;
        assert.equal(has("read:discussions"), discussions, mode);
      }
      assert.deepEqual(results[mode].operator.deny, [], mode);
      // One file per mode decided it; a repo's own modes are mode-work.rego's.
      const files = new Set([...results[mode].operator.allow.values()].flat());
      const file = inputs[mode].custom_mode ? "mode-work.rego" : null;
      assert.equal(files.size, 1, mode);
      if (file) assert.ok(files.has(file));
    }
    // What a work run with everything asked for and granted gets: all of work's.
    const outcomes = await modeOutcomes({
      repo: { name: "org/repo", private: true },
      settings: { ...full, ...settings },
      grant: granted,
      decide: (asked) => policies.capabilityRules("org/repo", "main", asked),
    });
    const work = outcomes.modes.find((m) => m.mode === "work");
    assert.deepEqual(work.used, WORK_CAPABILITIES);
    assert.deepEqual(work.errors, []);
    // Nothing its token reads that its capabilities don't give.
    assert.deepEqual(work.warnings, []);
    // Research: the open internet only, no risky combination.
    const research = outcomes.modes.find((m) => m.mode === "research");
    assert.deepEqual(research.used, ["internet"]);
    assert.deepEqual(research.errors, []);
    // The repo's own audit mode: refused until the repo allows it something.
    const audit = outcomes.modes.find((m) => m.mode === "audit");
    assert.deepEqual(audit.used, []);
    assert.equal(audit.errors.length, 1);
  },
);

test(
  "the real opa: each file's rules apart, a rule reading the whole set, both layers",
  { skip: !hasOpa() && "no opa on the PATH" },
  async (t) => {
    const policies = realPolicies(t, {
      builtIn: {
        "a.rego": 'package deckhand\n\nallow_capabilities contains "pull"\n',
        "b.rego": `package deckhand

allow_capabilities contains c if {
  input.mode == "work"
  some c in {"pull", "push"}
}

# Reads the union: a.rego's "pull" counts.
deny_capabilities contains {"capability": "internet", "reason": "not with the code"} if {
  "pull" in allow_capabilities
}
`,
        "lib.rego": "package deckhand\n\nforks := true\n",
      },
      repo: {
        "audit.rego": `package deckhand

allow_capabilities contains "pull" if input.custom_mode
deny_capabilities contains {"capability": "push", "reason": "forks don't push"} if input.fork
`,
      },
    });
    const { results } = await policies.capabilityRules("org/repo", "main", {
      work: { mode: "work", fork: true },
      audit: { mode: "audit", custom_mode: true },
    });
    assert.deepEqual(Object.fromEntries(results.work.operator.allow), {
      pull: ["a.rego", "b.rego"],
      push: ["b.rego"],
    });
    assert.deepEqual(results.work.operator.deny, [
      { capability: "internet", reason: "not with the code", file: "b.rego" },
    ]);
    assert.deepEqual(Object.fromEntries(results.work.repo.allow), {});
    assert.deepEqual(results.work.repo.deny, [
      { capability: "push", reason: "forks don't push", file: "audit.rego" },
    ]);
    assert.deepEqual(Object.fromEntries(results.audit.repo.allow), { pull: ["audit.rego"] });
  },
);

test(
  "the real opa: a rule byFile() can't rename still counts: an indented deny, a package line with a comment",
  { skip: !hasOpa() && "no opa on the PATH" },
  async (t) => {
    const policies = realPolicies(t, {
      builtIn: {
        "a.rego":
          'package deckhand\n\nallow_capabilities contains "pull"\nallow_capabilities contains "push"\n',
        "b.rego": `package deckhand

  deny_capabilities contains {"capability": "push", "reason": "indented"} if true
`,
        "c.rego": `package deckhand # the operator's

allow_capabilities contains "setup"
deny_capabilities contains {"capability": "pull", "reason": "commented"} if true
`,
      },
    });
    const { results } = await policies.capabilityRules("org/repo", "main", { run: {} });
    const { allow, deny } = results.run.operator;
    assert.deepEqual(Object.fromEntries(allow), {
      pull: ["a.rego"],
      push: ["a.rego"],
      setup: [null],
    });
    assert.deepEqual(
      deny.sort((x, y) => x.reason.localeCompare(y.reason)),
      [
        { capability: "pull", reason: "commented", file: null },
        { capability: "push", reason: "indented", file: null },
      ],
    );
    const said = outcomeOf({
      rules: results.run,
      custom: false,
      settings: { setup: "x" },
      grant: granted,
      repo: { private: false },
    });
    assert.equal(said.capabilities.find((c) => c.name === "push").status, "denied");
    assert.deepEqual(said.capabilities.find((c) => c.name === "push").files, [
      { layer: "operator", file: null },
    ]);
  },
);

test(
  "the real opa: a rule of the wrong shape or that doesn't compile is a policy error",
  { skip: !hasOpa() && "no opa on the PATH" },
  async (t) => {
    const error = async (builtIn, repo) =>
      (
        await realPolicies(t, { builtIn, repo }).capabilityRules("org/repo", "main", {
          run: { mode: "work" },
        })
      ).error;
    assert.equal(
      await error({ "a.rego": "package deckhand\n\nallow_capabilities contains 3\n" }),
      "policy error: `allow_capabilities` must be a set of strings",
    );
    assert.equal(
      await error({ "a.rego": 'package deckhand\n\ndeny_capabilities contains "push"\n' }),
      'policy error: `deny_capabilities` must be a set of {"capability": …, "reason": …} objects',
    );
    // Said with the rule's own name, not the one it is evaluated under.
    assert.match(
      await error(
        { "a.rego": 'package deckhand\n\nallow_capabilities contains "pull"\n' },
        { "b.rego": "package deckhand\n\nallow_capabilities contains x if x := y\n" },
      ),
      /^policy error: b\.rego:3: var (x|y) is unsafe$/,
    );
    assert.equal(
      await error({ "a.rego": 'package deckhand\n\nallow_capabilities := "pull"\n' }),
      "policy error: `allow_capabilities` and `deny_capabilities` must be sets (`contains` rules)",
    );
    assert.equal(
      await error({
        "a.rego":
          'package deckhand\n\nallow_capabilities contains "pull"\nallow_capabilities := {"x"}\n',
      }),
      "policy error: a.rego:3: conflicting rules data.deckhand.allow_capabilities found",
    );
  },
);

test("a light mode's run doesn't get `push`, whatever the policies allow, nor what needs it", () => {
  const modes = { fixer: { light: true }, audit: {} };
  const settings = { ...full, modes };
  for (const [mode, custom] of [
    ["brainstorm", false],
    ["fixer", true],
  ]) {
    const said = outcomeOf({
      rules: { operator: layer(everything()), repo: layer(everything()) },
      custom,
      settings,
      grant: granted,
      repo: { private: true },
      mode,
    });
    const push = said.capabilities.find((c) => c.name === "push");
    assert.equal(push.status, "denied", mode);
    assert.match(push.reason, /is a light mode: its token can't push/, mode);
    assert.ok(!said.used.includes("push") && !said.used.includes("image:branch"), mode);
    assert.ok(said.used.includes("pull") && said.used.includes("setup"), mode);
    assert.deepEqual(said.errors, [], mode);
    assert.ok(
      said.warnings.some((w) => w.startsWith("`push` isn't used")),
      mode,
    );
  }
  // A mode that isn't light keeps it.
  const audit = outcomeOf({
    rules: { operator: layer(everything()), repo: layer(everything()) },
    custom: true,
    settings,
    grant: granted,
    repo: { private: true },
    mode: "audit",
  });
  assert.ok(audit.used.includes("push"));
});

test("the config page: a config key its grant doesn't give stops every mode with a clone, said once", async () => {
  const fake = capabilityPolicies();
  const outcomes = await modeOutcomes({
    repo: { name: "org/repo", private: true },
    // A container engine asked for, not granted (access.mjs grantedAccess() refuses the run).
    settings: { docker: { cache: false } },
    grant: { ...granted, allowDocker: false },
    decide: (asked) => fake.capabilityRules("org/repo", "main", asked),
  });
  const of = (mode) => outcomes.modes.find((m) => m.mode === mode);
  // A brainstorm gets no `docker`, yet doesn't start: what its run would stop with.
  assert.deepEqual(of("brainstorm").errors, [
    "docker: the operator's grants don't set `allow_docker: true` for this repository",
  ]);
  // A work run, which asks for it: the capability's own refusal, once.
  assert.equal(of("work").errors.length, 1);
  assert.match(of("work").errors[0], /^`docker`: /);
  // Research has no clone: the grant doesn't concern it.
  const research = await modeOutcomes({
    repo: { name: "org/repo", private: true },
    settings: { docker: { cache: false } },
    grant: { ...granted, allowDocker: false },
    decide: (asked) => fake.capabilityRules("org/repo", "main", asked),
  });
  assert.deepEqual(research.modes.find((m) => m.mode === "research").errors, []);
});

test("a read refused while the run has `pull`: said, since its token still has it until #497", () => {
  const said = outcomeOf({
    rules: {
      operator: layer(everything(), [
        { capability: "read:actions", reason: "no logs", file: "mode.rego" },
      ]),
    },
    custom: false,
    settings: full,
    grant: granted,
    repo: { private: true },
    mode: "work",
  });
  assert.ok(said.used.includes("pull") && !said.used.includes("read:actions"));
  assert.ok(said.warnings.some((w) => /^`read:actions` isn't given, but the run's token/.test(w)));
  // A brainstorm's token reads no discussions: nothing to say.
  const brainstorm = outcomeOf({
    rules: {
      operator: layer(everything(), [
        { capability: "read:discussions", reason: "not here", file: "mode.rego" },
      ]),
    },
    custom: false,
    settings: full,
    grant: granted,
    repo: { private: true },
    mode: "brainstorm",
  });
  assert.ok(!brainstorm.warnings.some((w) => w.startsWith("`read:discussions`")));
  // What the page says enforces it.
  const entry = CAPABILITIES.find((c) => c.name === "read:actions");
  assert.match(entry.enforcedBy, /^not yet: the run's token follows its mode until #497/);
});

test("the config page: grants that can't be read stop every mode, as every run", async () => {
  const fake = capabilityPolicies();
  const outcomes = await modeOutcomes({
    repo: { name: "org/repo", private: true },
    settings: {},
    grant: null,
    decide: (asked) => fake.capabilityRules("org/repo", "main", asked),
  });
  assert.ok(outcomes.modes.length > 0);
  for (const { mode, errors } of outcomes.modes) {
    assert.match(errors[0], /^the operator's grants folder has errors, so no run starts/, mode);
  }
});

test("Deckhand's defaults give each built-in mode every read its token has: no warning", () => {
  for (const mode of ["work", "brainstorm", "discussion", "review", "analyze"]) {
    const said = outcomeOf({
      rules: {
        operator: layer(Object.fromEntries(defaultCapabilities({ mode }).map((c) => [c, ["m"]]))),
      },
      custom: false,
      settings: full,
      grant: granted,
      repo: { private: false },
      mode,
    });
    assert.ok(
      !said.warnings.some((w) => /token still reads it/.test(w)),
      `${mode}: ${said.warnings}`,
    );
  }
});

test("a deny of `preview`: said not to stop the hook yet, which runs on pull request events", () => {
  const preview = (settings, grant) =>
    outcomeOf({
      rules: {
        operator: layer(everything(), [
          { capability: "preview", reason: "no previews", file: "mode.rego" },
        ]),
      },
      custom: false,
      settings,
      grant,
      repo: { private: true },
      mode: "work",
    }).warnings.some((w) => w.startsWith("`preview` is denied, but the repository's preview hook"));
  assert.equal(preview(full, granted), true);
  // No hook asked for, or none granted: none runs, nothing to say.
  assert.equal(preview({ ...full, preview: null }, granted), false);
  assert.equal(preview(full, { ...granted, allowPreview: false }), false);
});
