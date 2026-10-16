import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../listener/config.mjs";
import { workItem } from "../listener/events.mjs";
import {
  cacheProblem,
  cacheVolume,
  customMode,
  defaultSettings,
  engineCacheVolume,
  effectiveConfig,
  legacySandboxName,
  loadRepoSettings,
  modeNames,
  parseRepoConfig,
  repoPath,
  sandboxName,
  startable,
} from "../listener/repo-config.mjs";

const config = loadConfig({ ALLOWED_USERS: "alice,bob", MAX_PARALLEL: "3" });

test("no config file: the operator's settings as they are", async () => {
  const request = async () => new Response("{}", { status: 404 });
  const { settings, errors } = await loadRepoSettings(request, config, "org/repo", "main");
  assert.deepEqual(errors, []);
  assert.deepEqual(settings, defaultSettings(config));
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
cached_hosts: [registry.npmjs.org]
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
  assert.deepEqual(warnings, [
    "allow_branch_docker_images: ignored here, the operator's grants folder sets it for this repository",
    // Only the operator lists hosts: a repo's are no longer read.
    "hosts: ignored, the operator lists the hosts in grants/<owner>/<repo>.yaml",
    // So does what the egress proxy keeps for every run.
    "cached_hosts: ignored, the operator lists them in grants/<owner>/<repo>.yaml",
    "colour: unknown, ignored",
  ]);
  assert.equal(settings.model, "sonnet");
  assert.equal(settings.effort, "high");
  assert.equal(settings.brainstormModel, "haiku");
  assert.equal(settings.setup, "npm ci");
  assert.equal(settings.dockerfile, "docker/Dockerfile");
  assert.deepEqual(settings.caches, ["/home/node/.npm", "/home/node/.cache/pip"]);
  assert.equal("hosts" in settings, false);
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
caches: [relative/path, /workspace/node_modules, /home/node/../root]
inbox: { ideas: three, discussions: 5 }
`,
    config,
  );
  assert.equal(errors.length, 8);
  assert.match(errors.join("\n"), /inbox\.ideas: expected an issue number/);
  assert.match(errors.join("\n"), /inbox\.discussions: expected the name of a discussion category/);
  assert.match(errors.join("\n"), /effort: expected one of low/);
  assert.match(errors.join("\n"), /the sandbox uses \/workspace itself/);
  assert.match(parseRepoConfig("a: [", config).errors[0], /\.deckhand\.yaml: line 1/);
  assert.match(parseRepoConfig("- a", config).errors[0], /top level/);
});

test("a preview hook's timeout: two hours at most", () => {
  const preview = (minutes) =>
    parseRepoConfig(`preview:\n  command: ./x.sh\n  timeout_minutes: ${minutes}\n`, config);
  assert.equal(preview(120).settings.preview.timeoutMinutes, 120);
  for (const bad of [0, 121, 100000]) {
    assert.match(
      preview(bad).errors.join("\n"),
      /timeout_minutes: expected a whole number from 1 to 120/,
    );
  }
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

test("sandbox names: repos that collide without the hash are distinct", () => {
  assert.equal(
    legacySandboxName(config, "acme/x", "pr-5"),
    legacySandboxName(config, "acme/x-pr", "5"),
  );
  assert.notEqual(sandboxName(config, "acme/x", "pr-5"), sandboxName(config, "acme/x-pr", "5"));
  assert.match(sandboxName(config, "acme/x", "5"), /^deckhand-acme-x-5-[0-9a-f]{10}$/);
  // GitHub's names aren't case-sensitive: the same task.
  assert.equal(sandboxName(config, "Acme/X", "5"), sandboxName(config, "acme/x", "5"));
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
    agent: "claude",
    model: "sonnet",
    effort: "low",
  });
  assert.deepEqual(customMode(settings, "triage"), {
    name: "triage",
    light: false,
    fresh: true,
    instructions: ".deckhand/triage.md",
    agent: "claude",
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
    "modes.work: work is built in: set it with agent, model and effort instead",
    "modes.Brainstorm: brainstorm is built in: set it with brainstorm_agent, brainstorm_model and brainstorm_effort instead",
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
    `mounts: [/nfs/work]
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
    "modes.wide.hosts: unknown key (expected instructions, light, session, agent, model, effort)",
    "modes.wide.mounts: unknown key (expected instructions, light, session, agent, model, effort)",
    "modes.wide.limits: unknown key (expected instructions, light, session, agent, model, effort)",
    "modes.wide.allow_branch_docker_images: unknown key (expected instructions, light, session, agent, model, effort)",
  ]);
  // Refused as a whole, and the repo's own grants are untouched.
  assert.equal(customMode(settings, "wide"), null);
  assert.deepEqual(settings.mounts, [{ path: "/nfs/work", readOnly: true }]);
  // What a valid mode's run gets: nothing about access.
  const { settings: valid } = parseRepoConfig(MODES, config);
  assert.deepEqual(Object.keys(customMode(valid, "review")).sort(), [
    "agent",
    "effort",
    "fresh",
    "instructions",
    "light",
    "model",
    "name",
  ]);
});

test("conflicts: opt-in, never more often than the operator's floor", () => {
  const parse = (text, c = config) => parseRepoConfig(text, c);
  assert.equal(parse("trigger: go").settings.conflicts, null);
  assert.deepEqual(parse("conflicts:\n  check_minutes: 10").settings.conflicts, {
    checkMinutes: 10,
  });
  // Below the floor (5 by default): the floor.
  const slow = parse("conflicts:\n  check_minutes: 2");
  assert.deepEqual(slow.settings.conflicts, { checkMinutes: 5 });
  assert.match(slow.warnings.join(), /below CONFLICT_CHECK_MINUTES/);
  // 0: off for every repo.
  const off = loadConfig({ ALLOWED_USERS: "alice", CONFLICT_CHECK_MINUTES: "0" });
  const ignored = parse("conflicts:\n  check_minutes: 10", off);
  assert.equal(ignored.settings.conflicts, null);
  assert.deepEqual(ignored.errors, []);
  assert.match(ignored.warnings.join(), /turned the conflict watcher off/);
  // Nothing to check: off.
  assert.equal(parse("conflicts: {}").settings.conflicts, null);
});

test("conflicts: invalid values and unknown keys are errors", () => {
  const errors = (text) => parseRepoConfig(text, config).errors;
  assert.match(errors("conflicts: 5").join(), /conflicts: expected check_minutes/);
  for (const bad of ["0", "-3", "2.5", "soon"]) {
    assert.match(
      errors(`conflicts:\n  check_minutes: ${bad}`).join(),
      /conflicts.check_minutes: expected a whole number above 0/,
    );
  }
  const typo = parseRepoConfig("conflicts:\n  check_minute: 5", config);
  assert.match(typo.errors.join(), /conflicts.check_minute: unknown key/);
  assert.equal(typo.settings.conflicts, null);
});

test("wait_for_answers: on by default, a boolean or an error", () => {
  assert.equal(defaultSettings(config).waitForAnswers, true);
  assert.equal(parseRepoConfig("trigger: go", config).settings.waitForAnswers, true);
  assert.equal(parseRepoConfig("wait_for_answers: false", config).settings.waitForAnswers, false);
  assert.equal(parseRepoConfig("wait_for_answers: true", config).settings.waitForAnswers, true);
  for (const bad of ["no", "0", '"false"', "[true]"]) {
    const { settings, errors } = parseRepoConfig(`wait_for_answers: ${bad}`, config);
    assert.match(errors.join(), /wait_for_answers: expected true or false/, bad);
    assert.equal(settings.waitForAnswers, true);
  }
});

test("a gateway's model names, with a slash, at the top and in a mode", () => {
  const { settings, errors } = parseRepoConfig(
    `model: openai/gpt-5
brainstorm_model: "meta-llama/llama-4:free"
modes:
  cheap:
    instructions: docs/cheap.md
    model: anthropic/claude-haiku-4.5
`,
    config,
  );
  assert.deepEqual(errors, []);
  assert.equal(settings.model, "openai/gpt-5");
  assert.equal(settings.brainstormModel, "meta-llama/llama-4:free");
  assert.equal(customMode(settings, "cheap").model, "anthropic/claude-haiku-4.5");
  const bad = parseRepoConfig("model: two words\n", config);
  assert.deepEqual(bad.errors, [
    "model: expected a model tier (best, balanced, fast) or name (opus, claude-…, openai/gpt-…)",
  ]);
});

test("docker: true, false, or a cache kept; anything else is an error", () => {
  const docker = (text) => parseRepoConfig(text, config);
  assert.equal(defaultSettings(config).docker, null);
  assert.deepEqual(docker("docker: true\n").settings.docker, { cache: false });
  assert.equal(docker("docker: false\n").settings.docker, null);
  assert.deepEqual(docker("docker:\n  cache: true\n").settings.docker, { cache: true });
  assert.deepEqual(docker("docker: { cache: false }\n").settings.docker, { cache: false });
  assert.deepEqual(docker("docker: yes\n").errors, [
    "docker: expected true, false or { cache: true }",
  ]);
  const wrong = docker("docker:\n  cache: always\n  pull: true\n");
  assert.deepEqual(wrong.errors, [
    "docker.cache: expected true or false",
    "docker.pull: unknown key (expected cache)",
  ]);
  assert.equal(wrong.settings.docker, null);
});

test("one engine cache volume per repo, apart from the sandbox's caches", () => {
  const a = engineCacheVolume(config, "Org/Repo");
  assert.match(a, /^deckhand-engine-cache-org-repo-[0-9a-f]{10}$/);
  assert.equal(engineCacheVolume(config, "org/repo"), a);
  assert.notEqual(engineCacheVolume(config, "org/repo-x"), a);
});

test("agent: a repo picks among the operator's agents, per repo, light runs and mode", () => {
  const both = loadConfig({
    ALLOWED_USERS: "alice",
    CLAUDE_CODE_OAUTH_TOKEN: "t",
    OPENAI_API_KEY: "k",
  });
  const { settings, errors } = parseRepoConfig(
    `agent: Codex
brainstorm_agent: claude
modes:
  review:
    instructions: review.md
    light: true
  audit:
    instructions: audit.md
    agent: claude
`,
    both,
  );
  assert.deepEqual(errors, []);
  assert.equal(settings.agent, "codex");
  assert.equal(settings.brainstormAgent, "claude");
  // A light mode takes the light runs' agent, a full one work's, unless it names its own.
  assert.equal(customMode(settings, "review").agent, "claude");
  assert.equal(customMode(settings, "audit").agent, "claude");
  assert.equal(effectiveConfig(both, settings).agent, "codex");
  // Without the keys, the operator's.
  assert.equal(parseRepoConfig("", both).settings.agent, "claude");
});

test("agent: one the operator hasn't configured is an error, at the top or in a mode", () => {
  // The operator has no OpenAI key: Codex isn't theirs to give.
  const { settings, errors } = parseRepoConfig(
    `agent: codex
brainstorm_agent: gemini
modes:
  review:
    instructions: review.md
    agent: codex
`,
    config,
  );
  assert.deepEqual(errors, [
    "agent: the operator hasn't configured codex (configured: claude)",
    "brainstorm_agent: expected one of claude",
    "modes.review.agent: the operator hasn't configured codex (configured: claude)",
  ]);
  assert.equal(settings.agent, "claude");
  assert.equal(customMode(settings, "review"), null);
  assert.deepEqual(parseRepoConfig("agent: [codex]", config).errors, [
    "agent: expected one of claude",
  ]);
});
