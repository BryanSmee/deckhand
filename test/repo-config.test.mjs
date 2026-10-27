import assert from "node:assert/strict";
import { test } from "node:test";
import { AGENTS } from "../listener/agents/index.mjs";
import { workItem } from "../listener/events.mjs";
import {
  cacheProblem,
  cacheVolume,
  customMode,
  defaultSettings,
  engineCacheVolume,
  fileLines,
  effectiveConfig,
  legacySandboxName,
  loadRepoSettings,
  modeNames,
  parseRepoConfig,
  repoImage,
  repoPath,
  RESERVED,
  RESERVED_MODES,
  sandboxName,
  startable,
  taskSandboxName,
} from "../listener/repo-config.mjs";
import { testConfig } from "./helpers.mjs";

const config = testConfig({ ALLOWED_USERS: "alice,bob", MAX_PARALLEL: "3" });

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

test("every agent's session and install, and the inbox, are reserved", () => {
  for (const agent of Object.values(AGENTS)) {
    assert.ok(RESERVED.includes(agent.session.path), agent.name);
    assert.ok(RESERVED.includes(agent.install(config).mount), agent.name);
  }
  for (const path of ["/home/node/.gemini/x", "/opt/antigravity", "/deckhand", "/screenshots"]) {
    assert.ok(cacheProblem(path), path);
  }
  const { errors } = parseRepoConfig("caches:\n  - /home/node/.gemini/x\n", config);
  assert.match(errors.join(""), /the sandbox uses \/home\/node\/\.gemini itself/);
});

test("one image name per repo, even when their names slug alike", () => {
  const names = ["acme/x.y", "acme/x-y", "acme-x/y"].map((r) => repoImage(config, r));
  assert.equal(new Set(names).size, 3);
  for (const name of names) assert.match(name, /^deckhand-repo-acme-x-y-[0-9a-f]{10}$/);
  assert.equal(repoImage(config, "Acme/X.Y"), names[0]);
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

test("sandbox names: a task with a session from before the hash keeps its old name", async () => {
  // org/repo #12 had a run by its old name, and that session's volumes are there; so are
  // org/repo-pr #5's, whose old name is also org/repo #pr-5's.
  const runs = [
    { key: "org/repo#12", id: "deckhand-org-repo-12-1000" },
    { key: "org/repo-pr#5", id: "deckhand-org-repo-pr-5-1000" },
  ];
  const sessions = new Set(["deckhand-org-repo-12", "deckhand-org-repo-pr-5"]);
  const name = (repo, id, ran = runs) =>
    taskSandboxName(config, repo, id, ran, async (n) => sessions.has(n));
  assert.equal(await name("org/repo", "12"), "deckhand-org-repo-12");
  assert.equal(await name("Org/Repo", "12"), "deckhand-org-repo-12");
  // None from before: the new name.
  assert.equal(await name("org/repo", "14"), sandboxName(config, "org/repo", "14"));
  // The other repo's session isn't this task's.
  assert.equal(await name("org/repo", "pr-5"), sandboxName(config, "org/repo", "pr-5"));
  assert.equal(await name("org/repo-pr", "5"), "deckhand-org-repo-pr-5");
  // A run of that name, but its session gone; or a session without a run of that name.
  sessions.delete("deckhand-org-repo-pr-5");
  assert.equal(await name("org/repo-pr", "5"), sandboxName(config, "org/repo-pr", "5"));
  const other = [{ key: "org/repo#12", id: "deckhand-org-repo-12-x-1000" }];
  assert.equal(await name("org/repo", "12", other), sandboxName(config, "org/repo", "12"));
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
  Audit:
    instructions: .deckhand/audit.md # from the default branch, like instructions
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
  assert.deepEqual(modeNames(settings), [
    "work",
    "brainstorm",
    "onboarding",
    "research",
    "policy",
    "audit",
    "triage",
  ]);
  // A light mode takes the brainstorms' defaults, a full one work's.
  assert.deepEqual(customMode(settings, "audit"), {
    name: "audit",
    light: true,
    fresh: false,
    instructions: ".deckhand/audit.md",
    agent: "claude",
    model: "sonnet",
    effort: "low",
    speed: null,
  });
  assert.deepEqual(customMode(settings, "triage"), {
    name: "triage",
    light: false,
    fresh: true,
    instructions: ".deckhand/triage.md",
    agent: "claude",
    model: "opus",
    effort: "high",
    speed: null,
  });
  // The listener's own modes aren't the repo's.
  assert.equal(customMode(settings, "work"), null);
  assert.equal(customMode(settings, "brainstorm"), null);
  assert.equal(customMode(defaultSettings(config), "audit"), null);
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
  assert.match(parseRepoConfig("modes: [audit]", config).errors[0], /^modes: expected modes/);
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
    "modes.wide.hosts: unknown key (expected instructions, light, session, agent, model, effort, speed)",
    "modes.wide.mounts: unknown key (expected instructions, light, session, agent, model, effort, speed)",
    "modes.wide.limits: unknown key (expected instructions, light, session, agent, model, effort, speed)",
    "modes.wide.allow_branch_docker_images: unknown key (expected instructions, light, session, agent, model, effort, speed)",
  ]);
  // Refused as a whole, and the repo's own grants are untouched.
  assert.equal(customMode(settings, "wide"), null);
  assert.deepEqual(settings.mounts, [{ path: "/nfs/work", readOnly: true }]);
  // What a valid mode's run gets: nothing about access.
  const { settings: valid } = parseRepoConfig(MODES, config);
  assert.deepEqual(Object.keys(customMode(valid, "audit")).sort(), [
    "agent",
    "effort",
    "fresh",
    "instructions",
    "light",
    "model",
    "name",
    "speed",
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
  const off = testConfig({ CONFLICT_CHECK_MINUTES: "0" });
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

test("fast_mode: only narrows the operator's SANDBOX_FAST_MODE", () => {
  const allowed = testConfig({ ALLOWED_USERS: "alice", SANDBOX_FAST_MODE: "allowed" });
  assert.equal(config.fastMode, false);
  assert.equal(allowed.fastMode, true);
  assert.equal(defaultSettings(allowed).fastMode, true);
  assert.equal(parseRepoConfig("fast_mode: false", allowed).settings.fastMode, false);
  assert.equal(parseRepoConfig("fast_mode: true", allowed).settings.fastMode, true);
  // The repo can't turn it on when the operator hasn't.
  const widened = parseRepoConfig("fast_mode: true", config);
  assert.equal(widened.settings.fastMode, false);
  assert.match(widened.warnings.join(), /fast_mode: the operator hasn't allowed fast mode/);
  assert.equal(effectiveConfig(allowed, widened.settings).fastMode, false);
  assert.match(parseRepoConfig("fast_mode: yes please", allowed).errors.join(), /expected true/);
});

test("a mode's speed: fast or normal, anything else an error", () => {
  const { settings, errors } = parseRepoConfig(
    `modes:
  hotfix: { instructions: h.md, speed: Fast }
  calm: { instructions: c.md, speed: normal }
  odd: { instructions: o.md, speed: warp }
`,
    config,
  );
  assert.deepEqual(errors, ["modes.odd.speed: expected normal or fast"]);
  assert.equal(customMode(settings, "hotfix").speed, "fast");
  assert.equal(customMode(settings, "calm").speed, "normal");
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
  const both = testConfig({
    CLAUDE_CODE_OAUTH_TOKEN: "t",
    OPENAI_API_KEY: "k",
  });
  const { settings, errors } = parseRepoConfig(
    `agent: Codex
brainstorm_agent: claude
modes:
  lint:
    instructions: lint.md
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
  assert.equal(customMode(settings, "lint").agent, "claude");
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
  audit:
    instructions: audit.md
    agent: codex
`,
    config,
  );
  assert.deepEqual(errors, [
    "agent: the operator hasn't configured codex (configured: claude)",
    "brainstorm_agent: expected one of claude",
    "modes.audit.agent: the operator hasn't configured codex (configured: claude)",
  ]);
  assert.equal(settings.agent, "claude");
  assert.equal(customMode(settings, "audit"), null);
  assert.deepEqual(parseRepoConfig("agent: [codex]", config).errors, [
    "agent: expected one of claude",
  ]);
  // Nor the Antigravity CLI without the operator's Google AI plan login.
  assert.deepEqual(parseRepoConfig("agent: antigravity", config).errors, [
    "agent: the operator hasn't configured antigravity (configured: claude)",
  ]);
  const google = testConfig({ AGY_AUTH_FILE: "/data/agy-auth.json" });
  const picked = parseRepoConfig("agent: antigravity", google);
  assert.deepEqual(picked.errors, []);
  assert.equal(picked.settings.agent, "antigravity");
});

test("review: off without the block, manual with true, its keys checked", () => {
  const off = parseRepoConfig("", config).settings;
  assert.equal(off.review, null);
  assert.equal(customMode(off, "review"), null);
  assert.ok(!modeNames(off).includes("review"));
  assert.equal(parseRepoConfig("review: false\n", config).settings.review, null);
  const manual = parseRepoConfig("review: true\n", config).settings;
  assert.equal(manual.review.on, "manual");
  assert.deepEqual(modeNames(manual), [
    "work",
    "brainstorm",
    "onboarding",
    "research",
    "policy",
    "review",
  ]);
  // A light, fresh mode with the light runs' model and effort, unless the block says otherwise.
  assert.deepEqual(customMode(manual, "review"), {
    name: "review",
    light: true,
    fresh: true,
    instructions: null,
    agent: "claude",
    model: "best",
    effort: "medium",
  });
  const { settings, errors } = parseRepoConfig(
    `brainstorm_model: sonnet
review:
  on: ready
  instructions: .deckhand/review.md
  model: opus
  effort: high
`,
    config,
  );
  assert.deepEqual(errors, []);
  assert.equal(settings.review.on, "ready");
  const mode = customMode(settings, "review");
  assert.deepEqual(
    [mode.instructions, mode.model, mode.effort],
    [".deckhand/review.md", "opus", "high"],
  );
  assert.equal(
    customMode(
      parseRepoConfig("brainstorm_model: sonnet\nreview: true\n", config).settings,
      "review",
    ).model,
    "sonnet",
  );
  const bad = parseRepoConfig(
    `review:
  on: every_push
  instructions: ../x.md
  effort: huge
  agent: codex
  hosts: ["*"]
`,
    config,
  );
  assert.deepEqual(bad.errors, [
    "review.on: expected ready or manual",
    "review.instructions: expected a path in the repository (relative, no ..)",
    "review.effort: expected one of low, medium, high, xhigh, max",
    "review.agent: the operator hasn't configured codex (configured: claude)",
    "review.hosts: unknown key (expected on, instructions, agent, model, effort, fix, merge, merge_method, max_allowed_severity)",
  ]);
  assert.equal(bad.settings.review, null);
  assert.deepEqual(parseRepoConfig("review: [on]\n", config).errors, [
    "review: expected true, or on, instructions, agent, model, effort, fix, merge, merge_method, max_allowed_severity",
  ]);
});

test("review.merge and merge_method: off and squash by default, merge warns without on: ready", () => {
  const manual = parseRepoConfig("review: true\n", config).settings.review;
  assert.deepEqual([manual.merge, manual.mergeMethod], [false, "squash"]);
  const on = parseRepoConfig(
    "review:\n  on: ready\n  fix: true\n  merge: true\n  merge_method: rebase\n",
    config,
  );
  assert.deepEqual([on.errors, on.warnings], [[], []]);
  assert.deepEqual([on.settings.review.merge, on.settings.review.mergeMethod], [true, "rebase"]);
  // Nothing merges without on: ready: the config check says so.
  const manualMerge = parseRepoConfig("review:\n  merge: true\n", config);
  assert.deepEqual(manualMerge.errors, []);
  assert.deepEqual(manualMerge.warnings, [
    "review.merge: needs `review.on: ready`, nothing is merged",
  ]);
  const bad = parseRepoConfig("review:\n  merge: yes\n  merge_method: ff\n", config);
  assert.deepEqual(bad.errors, [
    "review.merge: expected true or false",
    "review.merge_method: expected squash, merge, rebase",
  ]);
  assert.equal(bad.settings.review, null);
});

test("review.max_allowed_severity: low by default, or medium, nothing more severe", () => {
  assert.equal(parseRepoConfig("review: true\n", config).settings.review.maxAllowedSeverity, "low");
  const medium = parseRepoConfig("review:\n  max_allowed_severity: medium\n", config);
  assert.deepEqual(medium.errors, []);
  assert.equal(medium.settings.review.maxAllowedSeverity, "medium");
  for (const bad of ["high", "critical", "true"]) {
    assert.deepEqual(parseRepoConfig(`review:\n  max_allowed_severity: ${bad}\n`, config).errors, [
      "review.max_allowed_severity: expected low or medium",
    ]);
  }
});

test("review.fix: a boolean, off by default", () => {
  assert.equal(parseRepoConfig("review: true\n", config).settings.review.fix, false);
  assert.equal(parseRepoConfig("review:\n  on: ready\n", config).settings.review.fix, false);
  const on = parseRepoConfig("review:\n  on: ready\n  fix: true\n", config);
  assert.deepEqual(on.errors, []);
  assert.equal(on.settings.review.fix, true);
  for (const bad of ['"yes"', "1", "[high]"]) {
    const parsed = parseRepoConfig(`review:\n  fix: ${bad}\n`, config);
    assert.deepEqual(parsed.errors, ["review.fix: expected true or false"]);
    assert.equal(parsed.settings.review, null);
  }
});

test("review: a repo's own mode can't take the name, the error says what to do", () => {
  const { settings, errors } = parseRepoConfig(
    "modes:\n  Review:\n    instructions: .deckhand/review.md\n    light: true\n",
    config,
  );
  assert.deepEqual(errors, [
    "modes.Review: review is built in: remove it and turn it on with a top-level `review:` block, or rename it",
  ]);
  assert.deepEqual(settings.modes, {});
});

test("fileLines: each error and warning at the line of its key, mounts at their item", () => {
  const text = [
    "users: [alice]",
    "modes:",
    "  review: { agent: codex }",
    "caches: [relative]",
    "mounts:",
    "  - path: /srv/a",
    "  - /srv/b",
    "my key: 1",
  ].join("\n");
  const { errors, warnings, fixes } = parseRepoConfig(text, config);
  const { lineOf, mountLine, locate } = fileLines(text);
  const located = errors.map((e) => locate(e, fixes));
  const review = located.find((e) => e.key === "modes.review");
  assert.equal(review.line, 3);
  assert.match(review.message, /^review is built in/);
  assert.match(review.fix, /^Remove modes\.review and add review: true/);
  // A key the file only has a parent of: the parent's line; a fix that fits any error.
  const caches = located.find((e) => e.key.startsWith("caches"));
  assert.equal(caches.line, 4);
  assert.match(caches.fix, /remove the key to get the default/);
  // A key with a space is found by the file's keys; a warning has no fix.
  assert.deepEqual(
    warnings.map((w) => locate(w)),
    [{ key: "my key", message: "unknown, ignored", line: 8, fix: null }],
  );
  assert.equal(lineOf("users"), 1);
  assert.equal(lineOf("model"), null);
  assert.deepEqual([mountLine("/srv/a"), mountLine("/srv/b"), mountLine("/srv/c")], [6, 7, null]);
  // A syntax error: its own line; what isn't about a key, none.
  const broken = fileLines("users: [a\nmodel: x\n");
  const [syntax] = parseRepoConfig("users: [a\n", testConfig()).errors;
  assert.deepEqual(broken.locate(syntax, {}), {
    key: null,
    message: "flow […] must fit on one line",
    line: 1,
    fix: "Fix the YAML: until then, none of the file is read.",
  });
  assert.deepEqual(broken.locate("users not in ALLOWED_USERS, ignored: carol"), {
    key: null,
    message: "users not in ALLOWED_USERS, ignored: carol",
    line: null,
    fix: null,
  });
});

test("the errors whose message doesn't say how to fix them come with a fix", () => {
  const fixOf = (text, error) => {
    const { errors, fixes } = parseRepoConfig(text, config);
    const found = errors.find((e) => e.startsWith(error));
    assert.ok(found, `${error} in ${errors}`);
    return fixes[found];
  };
  assert.equal(
    fixOf("agent: codex\n", "agent: the operator hasn't configured codex"),
    "Use an agent the operator runs (claude), or ask them to configure codex.",
  );
  assert.match(
    fixOf("modes:\n  docs: { instructions: a.md, agent: codex }\n", "modes.docs.agent:"),
    /ask them to configure codex/,
  );
  assert.match(fixOf("review:\n  agent: codex\n", "review.agent:"), /configure codex/);
  assert.equal(
    fixOf("modes:\n  work: { instructions: a.md }\n", "modes.work:"),
    "Remove modes.work, and set agent, model and effort at the top level.",
  );
  assert.match(
    fixOf("modes:\n  review: { instructions: a.md }\n", "modes.review:"),
    /another name/,
  );
  const reserved = RESERVED_MODES.find((m) => !["work", "brainstorm", "review"].includes(m));
  assert.match(
    fixOf(`modes:\n  ${reserved}: { instructions: a.md }\n`, `modes.${reserved}:`),
    /^Give the mode another name/,
  );
  assert.match(
    fixOf("modes:\n  docs: { light: true }\n", "modes.docs.instructions:"),
    /^Add instructions/,
  );
  assert.match(
    fixOf(
      "modes:\n  docs: { instructions: a.md }\n  Docs: { instructions: b.md }\n",
      "modes.Docs: defined twice",
    ),
    /^Keep one of the modes named Docs/,
  );
  // A message that says what is expected needs none of its own.
  assert.equal(fixOf("effort: loud\n", "effort:"), undefined);
});
