import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../listener/config.mjs";
import { workItem } from "../listener/events.mjs";
import {
  cacheProblem,
  cacheVolume,
  customMode,
  defaultSettings,
  effectiveConfig,
  loadRepoSettings,
  modeNames,
  parseRepoConfig,
  repoPath,
  startable,
} from "../listener/repo-config.mjs";

const config = loadConfig({ ALLOWED_USERS: "alice,bob", MAX_PARALLEL: "3" });

test("no config file: the operator's settings as they are", async () => {
  const request = async () => new Response("{}", { status: 404 });
  const { settings, errors } = await loadRepoSettings(request, config, "org/repo", "main");
  assert.deepEqual(errors, []);
  assert.deepEqual(settings, defaultSettings(config));
  assert.equal(settings.allowBranchDockerImages, false);
});

test("read from the default branch through the contents API", async () => {
  const asked = [];
  const request = async (repo, method, path) => {
    asked.push(path);
    const content = Buffer.from("model: sonnet\n").toString("base64");
    return Response.json({ type: "file", sha: "abc", content });
  };
  const { settings } = await loadRepoSettings(request, config, "org/repo", "trunk");
  assert.deepEqual(asked, ["/repos/org/repo/contents/.deckhand.yaml?ref=trunk"]);
  assert.equal(settings.model, "sonnet");
});

test("a repo can only narrow the operator's users and parallel cap", () => {
  const { settings, warnings, errors } = parseRepoConfig(
    "users: [Alice, mallory]\nmax_parallel: 10\n",
    config,
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(settings.users, ["alice"]);
  assert.match(warnings[0], /mallory/);
  assert.equal(settings.maxParallel, 3);
  assert.equal(parseRepoConfig("max_parallel: 1", config).settings.maxParallel, 1);
  // An empty list lets nobody in.
  assert.deepEqual(parseRepoConfig("users: []", config).settings.users, []);
});

test("its users and trigger decide which comments run", () => {
  const { settings } = parseRepoConfig("users: [bob]\ntrigger: Deckhand, go!\n", config);
  const repoConfig = effectiveConfig(config, settings);
  const payload = (login, body) => ({
    action: "created",
    installation: { id: 1 },
    repository: { full_name: "org/repo" },
    issue: { number: 4 },
    comment: { id: 1, body, user: { login, type: "User" } },
  });
  assert.equal(workItem(repoConfig, "issue_comment", payload("alice", "Deckhand go")), null);
  assert.equal(
    workItem(repoConfig, "issue_comment", payload("bob", "deckhand go")).trigger,
    "work",
  );
  assert.equal(workItem(repoConfig, "issue_comment", payload("bob", "Deckhand")).trigger, null);
});

test("a bad trigger is an error; the old triggers key only a warning", () => {
  assert.deepEqual(parseRepoConfig("trigger: '!!'", config).errors, [
    "trigger: expected a line of text",
  ]);
  assert.deepEqual(parseRepoConfig("trigger: [a, b]", config).errors, [
    "trigger: expected a line of text",
  ]);
  const old = parseRepoConfig("triggers:\n  work: Go\n", config);
  assert.deepEqual(old.errors, []);
  assert.deepEqual(old.warnings, ["triggers: unknown, ignored"]);
  assert.equal(old.settings.trigger, "deckhand");
});

test("everything a repo brings", () => {
  const { settings, errors, warnings } = parseRepoConfig(
    `model: sonnet
effort: HIGH
brainstorm_model: haiku
brainstorm_effort: low
setup: |
  npm ci
instructions: docs/agents.md
dockerfile: ./docker/Dockerfile
allow_branch_docker_images: true
caches: [/home/node/.npm, /home/node/.cache/pip/]
hosts: [registry.npmjs.org, "*.example.com"]
mounts:
  - path: /nfs/work/api
    read_only: false
inbox: { ideas: 3, bugs: 4, discussions: "💬 Ask Claude" }
preview:
  command: ./deploy/preview.sh
  image: docker:27-cli
colour: blue
`,
    config,
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, ["colour: unknown, ignored"]);
  assert.equal(settings.model, "sonnet");
  assert.equal(settings.effort, "high");
  assert.equal(settings.brainstormModel, "haiku");
  assert.equal(settings.setup, "npm ci");
  assert.equal(settings.dockerfile, "docker/Dockerfile");
  assert.equal(settings.allowBranchDockerImages, true);
  assert.deepEqual(settings.caches, ["/home/node/.npm", "/home/node/.cache/pip"]);
  assert.deepEqual(settings.hosts, ["registry.npmjs.org", "*.example.com"]);
  assert.deepEqual(settings.mounts, [{ path: "/nfs/work/api", readOnly: false }]);
  assert.deepEqual(settings.inbox, { ideas: 3, bugs: 4, discussions: "ask claude" });
  assert.deepEqual(settings.preview, {
    command: "./deploy/preview.sh",
    image: "docker:27-cli",
    timeoutMinutes: 30,
  });
});

test("wrong values are errors, each named", () => {
  const { errors } = parseRepoConfig(
    `effort: extreme
max_parallel: 0
dockerfile: ../outside/Dockerfile
allow_branch_docker_images: "yes"
caches: [relative/path, /workspace/node_modules, /home/node/../root]
hosts: ["bad host", "*"]
inbox: { ideas: three, discussions: 5 }
`,
    config,
  );
  assert.equal(errors.length, 11);
  assert.match(errors.join("\n"), /hosts: "\*": a repository can't open that much/);
  assert.match(errors.join("\n"), /inbox\.ideas: expected an issue number/);
  assert.match(errors.join("\n"), /inbox\.discussions: expected the name of a discussion category/);
  assert.match(errors.join("\n"), /effort: expected one of low/);
  assert.match(errors.join("\n"), /the sandbox uses \/workspace itself/);
  assert.match(parseRepoConfig("a: [", config).errors[0], /\.deckhand\.yaml: line 1/);
  assert.match(parseRepoConfig("- a", config).errors[0], /top level/);
});

test("paths in the repo and cache paths", () => {
  assert.equal(repoPath("docker/Dockerfile"), "docker/Dockerfile");
  for (const bad of ["/etc/passwd", "../x", "a/../../x", ".", "a b", ""]) {
    assert.equal(repoPath(bad), null, bad);
  }
  assert.equal(cacheProblem("/home/node/.cache"), null);
  for (const bad of ["/", "/home/node/.claude", "/home", "/opt/claude-code/x", "/a//b", "/a:b"]) {
    assert.ok(cacheProblem(bad), bad);
  }
});

test("one cache volume per repo and path", () => {
  const a = cacheVolume(config, "org/api", "/a-b");
  assert.match(a, /^deckhand-cache-org-api-a-b-[0-9a-f]{10}$/);
  assert.notEqual(a, cacheVolume(config, "org/api", "/a/b"));
  assert.notEqual(a, cacheVolume(config, "org/web", "/a-b"));
});

test("parallel caps: the operator's overall, each repo's within it", () => {
  const task = (repo, cap) => ({ repo, settings: { maxParallel: cap } });
  const ready = [task("org/a", 1), task("org/a", 1), task("org/b", 3), task("org/b", 3)];
  assert.deepEqual(
    startable(ready, new Map(), 0, 3).map((t) => t.repo),
    ["org/a", "org/b", "org/b"],
  );
  // One run of org/a already: only org/b, and one slot left overall.
  assert.deepEqual(
    startable(ready, new Map([["org/a", 1]]), 2, 3).map((t) => t.repo),
    ["org/b"],
  );
});

const MODES = `model: opus
brainstorm_model: haiku
brainstorm_effort: low
modes:
  Review:
    instructions: .deckhand/review.md # from the default branch, like instructions
    light: true
    model: sonnet
  triage:
    instructions: .deckhand/triage.md
    session: fresh
    effort: high
`;

test("modes: parsed, with the defaults of work or brainstorms", () => {
  const { settings, errors, warnings } = parseRepoConfig(MODES, config);
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
  assert.deepEqual(modeNames(settings), ["work", "brainstorm", "onboarding", "review", "triage"]);
  // A light mode takes the brainstorms' defaults, a full one work's.
  assert.deepEqual(customMode(settings, "review"), {
    name: "review",
    light: true,
    fresh: false,
    instructions: ".deckhand/review.md",
    model: "sonnet",
    effort: "low",
  });
  assert.deepEqual(customMode(settings, "triage"), {
    name: "triage",
    light: false,
    fresh: true,
    instructions: ".deckhand/triage.md",
    model: "opus",
    effort: "high",
  });
  // The listener's own modes aren't the repo's.
  assert.equal(customMode(settings, "work"), null);
  assert.equal(customMode(settings, "brainstorm"), null);
  assert.equal(customMode(defaultSettings(config), "review"), null);
});

test("modes: built-in names, wrong names, unknown keys and bad paths are errors", () => {
  const { settings, errors } = parseRepoConfig(
    `modes:
  work: { model: sonnet }
  Brainstorm: { instructions: b.md }
  stop: { instructions: s.md }
  onboarding: { instructions: o.md }
  "a b": { instructions: a.md }
  escape: { instructions: ../secrets.md }
  absolute: { instructions: /etc/passwd }
  vague: { light: yes, session: forever, effort: huge }
  bare: { light: true }
  ok: { instructions: ok.md }
  OK: { instructions: other.md }
`,
    config,
  );
  assert.deepEqual(errors, [
    "modes.work: work is built in: set its model with model and effort instead",
    "modes.Brainstorm: brainstorm is built in: set its model with brainstorm_model and brainstorm_effort instead",
    "modes.stop: stop is reserved by Deckhand",
    "modes.onboarding: onboarding is reserved by Deckhand",
    "modes.a b: expected a name of letters, digits, - and _ (32 at most)",
    "modes.escape.instructions: expected a path in the repository (relative, no ..)",
    "modes.absolute.instructions: expected a path in the repository (relative, no ..)",
    "modes.vague.light: expected true or false",
    "modes.vague.session: expected issue or fresh",
    "modes.vague.effort: expected one of low, medium, high, xhigh, max",
    "modes.vague.instructions: missing: a mode is its instructions",
    "modes.bare.instructions: missing: a mode is its instructions",
    "modes.OK: defined twice (names are not case-sensitive)",
  ]);
  assert.deepEqual(Object.keys(settings.modes), ["ok"]);
  assert.match(parseRepoConfig("modes: [review]", config).errors[0], /^modes: expected modes/);
});

test("a mode can't grant anything: hosts, mounts and limits stay the repo's", () => {
  const { settings, errors } = parseRepoConfig(
    `hosts: [registry.npmjs.org]
modes:
  wide:
    instructions: wide.md
    hosts: ["*"]
    mounts: [/]
    limits: { memory: 64g }
    allow_branch_docker_images: true
`,
    config,
  );
  assert.deepEqual(errors, [
    "modes.wide.hosts: unknown key (expected instructions, light, session, model, effort)",
    "modes.wide.mounts: unknown key (expected instructions, light, session, model, effort)",
    "modes.wide.limits: unknown key (expected instructions, light, session, model, effort)",
    "modes.wide.allow_branch_docker_images: unknown key (expected instructions, light, session, model, effort)",
  ]);
  // Refused as a whole, and the repo's own grants are untouched.
  assert.equal(customMode(settings, "wide"), null);
  assert.deepEqual(settings.hosts, ["registry.npmjs.org"]);
  assert.deepEqual(settings.mounts, []);
  assert.equal(settings.allowBranchDockerImages, false);
  // What a valid mode's run gets: nothing about access.
  const { settings: valid } = parseRepoConfig(MODES, config);
  assert.deepEqual(Object.keys(customMode(valid, "review")).sort(), [
    "effort",
    "fresh",
    "instructions",
    "light",
    "model",
    "name",
  ]);
});
