import assert from "node:assert/strict";
import { test } from "node:test";
import { AGENTS } from "../listener/agents/index.mjs";
import { sandboxEnv, sandboxSpec } from "../listener/sandbox-spec.mjs";

const config = {
  shotsVolume: "deckhand-shots",
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
  cacheArgs: ["-v", "cache-npm:/home/node/.npm"],
  settings: { setup: "npm ci", instructions: "AGENTS.md" },
  mounts: [{ source: "/srv/data", target: "/data", readOnly: false }],
  limits,
  engine: null,
  ca: null,
  digest: undefined,
};

test("sandboxSpec: hardened, as uid 1000, its own shots folder, the agent read-only", () => {
  const spec = sandboxSpec(runOf(), "the prompt", "the message", parts);
  assert.equal(spec.run, "deckhand-org-app-12-1");
  assert.equal(spec.name, "deckhand-org-app-12");
  assert.equal(spec.image, "deckhand-sandbox:latest");
  assert.deepEqual(spec.labels, { "deckhand.task": "org/app#12" });
  const args = spec.args.join(" ");
  assert.match(args, /^--user 1000:1000 --cap-drop ALL --security-opt no-new-privileges/);
  assert.match(args, /volume-subpath=f{24}/);
  assert.match(args, /-v deckhand-claude-code:\/opt\/claude-code:ro/);
  assert.match(args, /-v deckhand-org-app-12-workspace:\/workspace/);
  assert.match(args, /-v cache-npm:\/home\/node\/.npm/);
  assert.match(args, /type=bind,src=\/srv\/data,dst=\/data( |$)/);
  assert.equal(spec.engine, undefined);
  assert.equal(spec.ca, undefined);
});

test("sandboxSpec: a light run's mounts are read-only, and its volumes its own", () => {
  const spec = sandboxSpec(runOf({ light: true, mode: "brainstorm" }), "p", "m", parts);
  const args = spec.args.join(" ");
  assert.match(args, /type=bind,src=\/srv\/data,dst=\/data,readonly/);
  assert.doesNotMatch(args, /deckhand-org-app-12-workspace/);
});

// Its code could leave a tampered file there for the repo's later work runs, which trust them.
test("sandboxSpec: a work run with a comment from a fork's pull request mounts read-only", () => {
  const spec = sandboxSpec(runOf({ fork: true }), "p", "m", { ...parts, cacheArgs: [] });
  const args = spec.args.join(" ");
  assert.match(args, /type=bind,src=\/srv\/data,dst=\/data,readonly/);
  assert.match(args, /-v deckhand-org-app-12-workspace:\/workspace/);
});

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
  assert.equal(env.HTTPS_PROXY, "http://egress:3128");
  assert.doesNotMatch(env.NO_PROXY, /engine/);
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
