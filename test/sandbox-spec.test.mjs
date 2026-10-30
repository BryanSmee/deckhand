import assert from "node:assert/strict";
import { test } from "node:test";
import { AGENTS } from "../listener/agents/index.mjs";
import { sandboxArgs } from "../listener/runner/docker.mjs";
import { createBackend } from "../listener/runner/index.mjs";
import { SANDBOX_USER, sandboxEnv, sandboxSpec } from "../listener/sandbox-spec.mjs";

const config = {
  claudeCodeVolume: "deckhand-claude-code",
  claudeCodeVersion: "2.0.0",
  codexVolume: "deckhand-codex",
  codexVersion: "0.50.0",
  brokerUrl: "http://listener:8081",
  egressProxy: "http://egress:3128",
  githubUrl: "https://github.com",
};
const limits = { cpus: "2", memory: "4g", pids: 512 };
const bot = { name: "deckhand[bot]", email: "1+deckhand[bot]@users.noreply.github.com" };

function runOf({
  light = false,
  fork = false,
  mode = "work",
  kind = "issue",
  agent = AGENTS.claude,
} = {}) {
  const live = {
    id: "deckhand-org-app-12-1",
    key: "org/app#12",
    mode,
    light,
    fork,
    shots: "f".repeat(24),
    secret: "s".repeat(32),
    handoff: false,
    record: { provider: null, model: "opus", effort: "high" },
  };
  const task = {
    repo: "org/app",
    base: "main",
    kind,
    number: 12,
    name: "deckhand-org-app-12",
    live,
  };
  return { config, task, agent, bot, publicUrl: "https://deckhand.example" };
}

const parts = {
  image: "deckhand-sandbox:latest",
  caches: [{ name: "cache-npm", path: "/home/node/.npm" }],
  settings: { setup: "npm ci", instructions: "AGENTS.md" },
  mounts: [{ source: "/srv/data", target: "/data", readOnly: false }],
  limits,
  engine: null,
  ca: null,
  digest: undefined,
};

test("sandboxSpec: as uid 1000, no capabilities, no shots volume, the agent read-only", () => {
  const spec = sandboxSpec(runOf(), "the prompt", "the message", parts);
  assert.equal(spec.run, "deckhand-org-app-12-1");
  assert.equal(spec.name, "deckhand-org-app-12");
  assert.equal(spec.image, "deckhand-sandbox:latest");
  assert.deepEqual(spec.labels, { "deckhand.task": "org/app#12" });
  assert.deepEqual(spec.user, SANDBOX_USER);
  assert.deepEqual(spec.limits, limits);
  assert.deepEqual(spec.caps, []);
  // Its screenshots go to the broker (run-files.mjs), not into a volume of the listener's.
  assert.deepEqual(spec.volumes, [
    { kind: "agent", name: "deckhand-claude-code", path: "/opt/claude-code", readOnly: true },
    { kind: "session", name: "deckhand-org-app-12-workspace", path: "/workspace" },
    { kind: "session", name: "deckhand-org-app-12-claude", path: "/home/node/.claude" },
    { kind: "cache", name: "cache-npm", path: "/home/node/.npm" },
    { kind: "mount", name: "/srv/data", path: "/data", readOnly: false },
  ]);
  assert.equal(spec.engine, undefined);
  assert.equal(spec.ca, undefined);
});

// Backend-neutral: what the sandbox needs, never a backend's own options.
test("sandboxSpec: no docker flags", () => {
  const spec = sandboxSpec(runOf(), "p", "m", parts);
  assert.equal(spec.args, undefined);
  const text = JSON.stringify({ ...spec, env: undefined });
  assert.doesNotMatch(text, /--|type=bind|volume-subpath/);
});

test("sandboxSpec: a light run's mounts are read-only, and its volumes its own", () => {
  const spec = sandboxSpec(runOf({ light: true, mode: "brainstorm" }), "p", "m", parts);
  const mount = spec.volumes.find((v) => v.kind === "mount");
  assert.equal(mount.readOnly, true);
  const sessions = spec.volumes.filter((v) => v.kind === "session").map((v) => v.name);
  assert.deepEqual(sessions, [
    "deckhand-org-app-12-light-workspace",
    "deckhand-org-app-12-light-claude",
  ]);
});

// Its code could leave a tampered file there for the repo's later work runs, which trust them.
test("sandboxSpec: a work run with a comment from a fork's pull request mounts read-only", () => {
  const spec = sandboxSpec(runOf({ fork: true }), "p", "m", { ...parts, caches: [] });
  assert.equal(spec.volumes.find((v) => v.kind === "mount").readOnly, true);
  assert.ok(!spec.volumes.some((v) => v.kind === "cache"));
  // A clone of its own: what it checks out stays out of the issue's other work runs.
  const names = spec.volumes.map((v) => `${v.name}:${v.path}`);
  assert.ok(names.includes("deckhand-org-app-12-fork-workspace:/workspace"), String(names));
  assert.ok(!names.includes("deckhand-org-app-12-workspace:/workspace"));
  // The agent's session is the issue's, as before.
  assert.ok(
    names.some((n) => n.startsWith("deckhand-org-app-12-claude:")),
    String(names),
  );
  // Blobless, as before: its own pull request's head is no fork's to it (github-forks.mjs).
  assert.equal(spec.env.SANDBOX_FULL_CLONE, "");
});

test("sandboxSpec: a work run that isn't a fork's clones whole; a light run doesn't", () => {
  assert.equal(sandboxSpec(runOf(), "p", "m", parts).env.SANDBOX_FULL_CLONE, "1");
  const light = sandboxSpec(runOf({ light: true, mode: "brainstorm" }), "p", "m", parts);
  assert.equal(light.env.SANDBOX_FULL_CLONE, "");
});

// The `docker run` options the spec carried itself before it became a description (#392):
// the Docker runner must still give these, word for word, but the screenshots volume, which
// sandboxes no longer mount (#393).
const BEFORE = {
  work: "--user 1000:1000 --cap-drop ALL --security-opt no-new-privileges --cpus 2 --memory 4g --memory-swap 4g --pids-limit 512 -v deckhand-claude-code:/opt/claude-code:ro -v deckhand-org-app-12-workspace:/workspace -v deckhand-org-app-12-claude:/home/node/.claude",
  light:
    "--user 1000:1000 --cap-drop ALL --security-opt no-new-privileges --cpus 2 --memory 4g --memory-swap 4g --pids-limit 512 -v deckhand-claude-code:/opt/claude-code:ro -v deckhand-org-app-12-light-workspace:/workspace -v deckhand-org-app-12-light-claude:/home/node/.claude",
  // A fork's run's clone is its own (#409).
  fork: "--user 1000:1000 --cap-drop ALL --security-opt no-new-privileges --cpus 2 --memory 4g --memory-swap 4g --pids-limit 512 -v deckhand-claude-code:/opt/claude-code:ro -v deckhand-org-app-12-fork-workspace:/workspace -v deckhand-org-app-12-claude:/home/node/.claude --mount type=bind,src=/srv/data,dst=/data,readonly --mount type=bind,src=/srv/ref,dst=/ref,readonly",
  caches:
    "--user 1000:1000 --cap-drop ALL --security-opt no-new-privileges --cpus 2 --memory 4g --memory-swap 4g --pids-limit 512 -v deckhand-claude-code:/opt/claude-code:ro -v deckhand-org-app-12-workspace:/workspace -v deckhand-org-app-12-claude:/home/node/.claude -v deckhand-cache-a:/home/node/.npm -v deckhand-cache-b:/home/node/.cache/pip",
  mounts:
    "--user 1000:1000 --cap-drop ALL --security-opt no-new-privileges --cpus 2 --memory 4g --memory-swap 4g --pids-limit 512 -v deckhand-claude-code:/opt/claude-code:ro -v deckhand-org-app-12-workspace:/workspace -v deckhand-org-app-12-claude:/home/node/.claude --mount type=bind,src=/srv/data,dst=/data --mount type=bind,src=/srv/ref,dst=/ref,readonly",
};

const mounts = [
  { source: "/srv/data", target: "/data", readOnly: false },
  { source: "/srv/ref", target: "/ref", readOnly: true },
];
const caches = [
  { name: "deckhand-cache-a", path: "/home/node/.npm" },
  { name: "deckhand-cache-b", path: "/home/node/.cache/pip" },
];
const CASES = {
  work: [{}, { caches: [], mounts: [] }],
  light: [
    { light: true, mode: "brainstorm" },
    { caches: [], mounts: [] },
  ],
  fork: [{ fork: true }, { caches: [], mounts }],
  caches: [{}, { caches, mounts: [] }],
  mounts: [{}, { caches: [], mounts }],
};

for (const [name, [run, { caches, mounts }]] of Object.entries(CASES)) {
  test(`sandboxArgs: a ${name} run's docker run options, as before the spec described them`, () => {
    const spec = sandboxSpec(runOf(run), "p", "m", { ...parts, caches, mounts });
    assert.equal(sandboxArgs(spec).join(" "), BEFORE[name]);
  });
}

test("sandboxEnv: the run's secret in place of a credential, its prompt, mode and setup", () => {
  const env = sandboxEnv(runOf(), "the prompt", "the message", parts.settings, null);
  assert.equal(env.DECKHAND_RUN_SECRET, "s".repeat(32));
  assert.equal(env.SANDBOX_AGENT, "claude");
  assert.equal(env.SANDBOX_PROVIDER, "anthropic");
  assert.equal(env.CLAUDE_CODE_VERSION, "2.0.0");
  assert.equal(env.TASK_PROMPT, "the prompt");
  assert.equal(env.TASK_MESSAGE, "the message");
  assert.equal(env.TASK_MODE, "work");
  assert.equal(env.TASK_SESSION, "");
  assert.equal(env.TASK_ISSUE, "12");
  assert.equal(env.SANDBOX_SETUP, "npm ci");
  assert.equal(env.SANDBOX_LIGHT, "");
  assert.equal(env.REPO_URL, "https://github.com/org/app.git");
  assert.equal(env.GIT_AUTHOR_NAME, "deckhand[bot]");
  assert.equal(env.SCREENSHOT_URL, `https://deckhand.example/shots/${"f".repeat(24)}`);
  assert.equal(env.SCREENSHOT_DIR, "/tmp/screenshots");
  assert.equal(env.HTTPS_PROXY, "http://egress:3128");
  assert.doesNotMatch(env.NO_PROXY, /engine/);
  assert.equal(env.SANDBOX_SPEED, "normal");
  // No value of the operator's: none is in the listener's config here, and none may be.
  for (const value of Object.values(env)) assert.equal(typeof value, "string");
});

test("sandboxEnv: a wrap-up is a brainstorm, light runs skip setup, an engine is reached directly", () => {
  const light = sandboxEnv(runOf({ light: true, mode: "stop" }), "p", "m", parts.settings, null);
  assert.equal(light.TASK_MODE, "brainstorm");
  assert.equal(light.SANDBOX_LIGHT, "1");
  assert.equal(light.SANDBOX_SETUP, "");
  assert.equal(light.TASK_ISSUE, "");
  const inbox = sandboxEnv(runOf({ light: true, mode: "idea" }), "p", "m", parts.settings, null);
  assert.equal(inbox.TASK_SESSION, "fresh");
  const engine = sandboxEnv(runOf(), "p", "m", parts.settings, { limits, cache: null });
  assert.match(engine.NO_PROXY, /engine/);
  const codex = sandboxEnv(runOf({ agent: AGENTS.codex }), "p", "m", parts.settings, null);
  assert.equal(codex.SANDBOX_PROVIDER, "openai");
  assert.equal(codex.OPENAI_API_KEY, "s".repeat(32));
  assert.equal(codex.CODEX_VERSION, "0.50.0");
});

test("sandboxEnv: the run's speed, as speedFor() decided it", () => {
  const run = runOf();
  run.task.live.record.speed = "fast";
  assert.equal(sandboxEnv(run, "p", "m", parts.settings, null).SANDBOX_SPEED, "fast");
});

test("sandboxArgs: caps, a read-only volume folder, a root user", () => {
  const args = sandboxArgs({
    user: { uid: 0 },
    limits,
    caps: ["CHOWN"],
    volumes: [{ kind: "shots", name: "v", path: "/s", subpath: "x", readOnly: true }],
  });
  assert.equal(
    args.join(" "),
    "--user 0 --cap-drop ALL --cap-add CHOWN --security-opt no-new-privileges --cpus 2 --memory 4g --memory-swap 4g --pids-limit 512 --mount type=volume,src=v,dst=/s,volume-subpath=x,readonly",
  );
});

test("createBackend: Docker's runner, images and jobs, or Kubernetes'; another runner is refused", () => {
  const backend = createBackend({ config: { runner: "docker" }, docker: async () => ({}) });
  assert.deepEqual(Object.keys(backend).sort(), ["images", "jobs", "runner"]);
  assert.equal(typeof backend.jobs.preview.create, "function");
  const kube = createBackend({
    config: { runner: "kubernetes", kubernetes: { namespace: "" } },
    kubeApi: { namespace: "runs" },
  });
  assert.equal(typeof kube.runner.start, "function");
  // No short containers: an agent's install, previews and the login refresh say so.
  assert.deepEqual(kube.jobs, {});
  assert.throws(() => createBackend({ config: { runner: "nomad" } }), /RUNNER: expected docker/);
});

// Fail closed: never a sandbox as the image's user, or without the operator's limits.
test("sandboxArgs: a spec without a user or limits is refused", () => {
  assert.throws(() => sandboxArgs({ limits, volumes: [] }), /the sandbox spec has no user/);
  assert.throws(
    () => sandboxArgs({ user: SANDBOX_USER, volumes: [] }),
    /the sandbox spec has no limits/,
  );
});
