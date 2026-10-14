import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../listener/config.mjs";
import { workItem } from "../listener/events.mjs";
import {
  cacheProblem,
  cacheVolume,
  defaultSettings,
  effectiveConfig,
  loadRepoSettings,
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

test("its users and trigger lines decide which comments run", () => {
  const { settings } = parseRepoConfig("users: [bob]\ntriggers:\n  work: Deckhand, go!\n", config);
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
  assert.equal(
    workItem(repoConfig, "issue_comment", payload("bob", "Claude work on this")).trigger,
    null,
  );
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
hosts: ["bad host"]
inbox: { ideas: three, discussions: 5 }
`,
    config,
  );
  assert.equal(errors.length, 10);
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
