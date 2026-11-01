import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigError } from "../listener/config.mjs";
import { AGENTS } from "../listener/agents/index.mjs";
import { sandboxArgs } from "../listener/runner/docker.mjs";
import { createBackend } from "../listener/runner/index.mjs";
import {
  SANDBOX_USER,
  sandboxEnv,
  sandboxSpec,
  sessionNames,
  sessionOf,
} from "../listener/sandbox-spec.mjs";

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
  capabilities = null,
} = {}) {
  const live = {
    id: "deckhand-org-app-12-1",
    key: "org/app#12",
    mode,
    light,
    // What Deckhand's default policies give it (capabilities.mjs): a work run all, a light run
    // the code.
    capabilities:
      capabilities ??
      (light
        ? ["pull", "image:repo", "read:issues", "read:pulls", "read:actions"]
        : ["pull", "push", "setup", "image:repo", "image:branch", "docker", "read:issues"]),
    fork,
    shots: "f".repeat(24),
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
  // Its tokens, as the broker signs them for `sandbox` (broker.mjs issue()).
  const broker = {
    issue: (id, sandbox) => ({
      token: `run-${id}@${sandbox}`,
      agentToken: `agent-${id}@${sandbox}`,
    }),
  };
  return { config, task, agent, bot, publicUrl: "https://deckhand.example", broker };
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
    {
      kind: "agent",
      name: "deckhand-claude-code",
      path: "/opt/claude-code",
      readOnly: true,
      // How to fill it, for a runner that installs it in the sandbox's own pod.
      install: {
        command: "deckhand-install-claude-code",
        env: { CLAUDE_CODE_VERSION: "2.0.0" },
      },
    },
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

// A fork's light run: a clone of its own too, apart from the issue's other light runs, which a
// repo's policies may give caches or an engine (capabilities.mjs).
test("sandboxSpec: a light run with a comment from a fork's pull request has a clone of its own", () => {
  const spec = sandboxSpec(runOf({ light: true, fork: true, mode: "brainstorm" }), "p", "m", parts);
  const names = spec.volumes.map((v) => `${v.name}:${v.path}`);
  assert.ok(names.includes("deckhand-org-app-12-light-fork-workspace:/workspace"), String(names));
  assert.ok(!names.includes("deckhand-org-app-12-light-workspace:/workspace"));
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

test("tokens: the run's tokens, bound to its sandbox, the agent's in place of a credential", async () => {
  const run = runOf();
  run.config = { ...config, claudeCredential: "CLAUDE_CODE_OAUTH_TOKEN" };
  const spec = sandboxSpec(run, "p", "m", { ...parts, caches: [], mounts: [] });
  // Nothing of them before the runner knows where the sandbox runs.
  assert.ok(!Object.keys(spec.env).some((k) => /TOKEN|SECRET|API_KEY/.test(k)));
  const env = await spec.tokens("net-1");
  assert.equal(env.DECKHAND_RUN_TOKEN, "run-deckhand-org-app-12-1@net-1");
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "agent-deckhand-org-app-12-1@net-1");
  assert.equal(env.ANTHROPIC_BASE_URL, "http://listener:8081/anthropic");
  // Kept on the live run, for its output's redaction after a restart.
  assert.equal(run.task.live.agentToken, "agent-deckhand-org-app-12-1@net-1");
  const codex = sandboxSpec(runOf({ agent: AGENTS.codex }), "p", "m", {
    ...parts,
    caches: [],
    mounts: [],
  });
  assert.equal((await codex.tokens("net-2")).OPENAI_API_KEY, "agent-deckhand-org-app-12-1@net-2");
});

test("sandboxEnv: its prompt, mode and setup", () => {
  const env = sandboxEnv(runOf(), "the prompt", "the message", parts.settings, null);
  assert.equal(env.DECKHAND_RUN_SECRET, undefined);
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
  assert.equal(typeof backend.jobs.run, "function");
  const kube = createBackend({
    config: { runner: "kubernetes", kubernetes: { namespace: "" } },
    kubeApi: { namespace: "runs" },
  });
  assert.equal(typeof kube.runner.start, "function");
  // No short containers: an agent's install and the login refresh say so.
  assert.deepEqual(kube.jobs, {});
  assert.throws(() => createBackend({ config: { runner: "nomad" } }), /RUNNER: expected docker/);
  // Outside the cluster: no ServiceAccount, no start.
  assert.throws(
    () =>
      createBackend({
        config: { runner: "kubernetes", kubernetes: { namespace: "" } },
        readNamespace: () => {
          throw Object.assign(new Error("ENOENT"), { code: "ENOENT", path: "/x/namespace" });
        },
      }),
    (error) =>
      error instanceof ConfigError &&
      /no ServiceAccount at .* \(\/x\/namespace\)/.test(error.message),
  );
});

// Fail closed: never a sandbox as the image's user, or without the operator's limits.
test("sandboxArgs: a spec without a user or limits is refused", () => {
  assert.throws(() => sandboxArgs({ limits, volumes: [] }), /the sandbox spec has no user/);
  assert.throws(
    () => sandboxArgs({ user: SANDBOX_USER, volumes: [] }),
    /the sandbox spec has no limits/,
  );
});

// Where a run starts, and how it clones, by what it gets (capabilities.mjs) and what the gateways
// check (github-forks.mjs restricted()).
const workspaceOf = (spec) => spec.volumes.filter((v) => v.kind === "session").map((v) => v.name);

test("sandboxSpec: a run without `pull` has volumes of its own, no earlier run's clone or session", () => {
  const spec = sandboxSpec(
    runOf({ light: true, mode: "brainstorm", capabilities: [] }),
    "p",
    "m",
    parts,
  );
  assert.deepEqual(workspaceOf(spec), [
    "deckhand-org-app-12-light-bare-workspace",
    "deckhand-org-app-12-light-bare-claude",
  ]);
  assert.equal(spec.env.SANDBOX_NO_CLONE, "1");
  // A work run's: apart from the light runs' too.
  const work = sandboxSpec(runOf({ capabilities: [] }), "p", "m", parts);
  assert.equal(workspaceOf(work)[0], "deckhand-org-app-12-bare-workspace");
});

test("sandboxSpec: a light run with `setup` or `docker` starts apart from the other light runs, and clones whole", () => {
  for (const extra of ["setup", "docker"]) {
    const spec = sandboxSpec(
      runOf({ light: true, mode: "audit", capabilities: ["pull", extra] }),
      "p",
      "m",
      parts,
    );
    assert.deepEqual(workspaceOf(spec), [
      "deckhand-org-app-12-light-trusted-workspace",
      "deckhand-org-app-12-light-trusted-claude",
    ]);
    assert.equal(spec.env.SANDBOX_FULL_CLONE, "1", extra);
  }
  // A plain light run, which may fetch a fork's code, as before: blobless, its own volumes.
  const plain = sandboxSpec(runOf({ light: true, mode: "brainstorm" }), "p", "m", parts);
  assert.equal(workspaceOf(plain)[0], "deckhand-org-app-12-light-workspace");
  assert.equal(plain.env.SANDBOX_FULL_CLONE, "");
});

test("sandboxSpec: a run the gateways check clones whole, `push` or not", () => {
  // A work run whose `push` is denied, and a repo's mode given only reads and `setup`: its
  // capabilities decide, not its mode (#498).
  for (const mode of ["work", "audit"]) {
    const spec = sandboxSpec(
      runOf({ mode, capabilities: ["pull", "setup", "read:issues"] }),
      "p",
      "m",
      parts,
    );
    assert.equal(spec.env.SANDBOX_FULL_CLONE, "1", mode);
    assert.equal(spec.env.SANDBOX_LIGHT, "1", mode);
    // With reads alone, nothing the repo's later runs trust: not checked.
    const reads = sandboxSpec(
      runOf({ mode, capabilities: ["pull", "read:issues"] }),
      "p",
      "m",
      parts,
    );
    assert.equal(reads.env.SANDBOX_FULL_CLONE, "", mode);
  }
  // A fork's: never checked, blobless.
  const fork = sandboxSpec(runOf({ fork: true }), "p", "m", parts);
  assert.equal(fork.env.SANDBOX_FULL_CLONE, "");
});

test("sandboxSpec: a run without `push` never mounts the work runs' clone, nor the light runs'", () => {
  // It starts as a light run (SANDBOX_LIGHT: its reset doesn't stash), so it never starts where
  // a work run left uncommitted changes for its next run; and its session is work's, so it never
  // shares the light runs' either.
  for (const mode of ["work", "audit"]) {
    const spec = sandboxSpec(
      runOf({ mode, capabilities: ["pull", "read:issues"] }),
      "p",
      "m",
      parts,
    );
    assert.equal(spec.env.SANDBOX_LIGHT, "1", mode);
    // Nothing the gateways check it for: reads alone.
    assert.deepEqual(
      workspaceOf(spec),
      ["deckhand-org-app-12-readonly-workspace", "deckhand-org-app-12-readonly-claude"],
      mode,
    );
    // With `setup` (caches), checked: apart from those.
    const setup = sandboxSpec(
      runOf({ mode, capabilities: ["pull", "setup", "read:issues"] }),
      "p",
      "m",
      parts,
    );
    assert.equal(workspaceOf(setup)[0], "deckhand-org-app-12-readonly-trusted-workspace", mode);
  }
  // A fork's: unchecked, a clone of its own.
  const fork = sandboxSpec(
    runOf({ fork: true, capabilities: ["pull", "read:issues"] }),
    "p",
    "m",
    parts,
  );
  assert.deepEqual(workspaceOf(fork), [
    "deckhand-org-app-12-readonly-fork-workspace",
    "deckhand-org-app-12-readonly-claude",
  ]);
  // With `push`, and before its capabilities are decided: the work clone, as before.
  assert.equal(
    workspaceOf(sandboxSpec(runOf(), "p", "m", parts))[0],
    "deckhand-org-app-12-workspace",
  );
  assert.equal(sessionOf("n", { mode: "work", light: false, capabilities: null }), "n");
});
test("sessionNames: every volume sessionOf() may give a work run or a light one, never both", () => {
  const n = "deckhand-org-app-12";
  const live = (mode, light, capabilities, fork = false) => ({ mode, light, capabilities, fork });
  const given = {
    work: [
      live("work", false, ["pull", "push"]),
      live("work", false, ["pull"]),
      live("work", false, ["pull"], true),
      live("work", false, []),
      live("work", false, null),
    ],
    light: [
      live("brainstorm", true, ["pull"]),
      live("brainstorm", true, ["pull"], true),
      live("audit", true, ["pull", "setup"]),
      live("brainstorm", true, ["pull", "push"]),
      live("brainstorm", true, []),
      live("brainstorm", true, null),
    ],
  };
  for (const [kind, runs] of Object.entries(given)) {
    const names = sessionNames(n, kind === "light");
    for (const run of runs) assert.ok(names.includes(sessionOf(n, run)), JSON.stringify(run));
  }
  const work = new Set(sessionNames(n, false));
  assert.ok(sessionNames(n, true).every((name) => !work.has(name)));
  assert.deepEqual(sessionNames(n), [...sessionNames(n, false), ...sessionNames(n, true)]);
});
test("sessionOf: a run that stashes and one that doesn't never share a clone", () => {
  // A work run with `push` stashes: the work clone. A work run without it doesn't: its own,
  // apart from both the work runs' and those of the modes apart from work (modes.mjs
  // `volumes`), which get one of their own again when the policies give them `push` (#498).
  const pushes = { mode: "work", light: false, capabilities: ["pull", "push", "setup"] };
  const reads = { mode: "work", light: false, capabilities: ["pull", "setup", "read:issues"] };
  const lightReads = { mode: "brainstorm", light: true, capabilities: ["pull", "setup"] };
  const lightPushes = { mode: "brainstorm", light: true, capabilities: ["pull", "push"] };
  assert.equal(sessionOf("n", pushes), "n");
  assert.equal(sessionOf("n", reads), "n-readonly-trusted");
  assert.equal(sessionOf("n", lightReads), "n-light-trusted");
  assert.equal(sessionOf("n", lightPushes), "n-light-push");
  const workspaces = [pushes, reads, lightReads, lightPushes].map(
    (live) => workspaceOf(sandboxSpec(runOf(live), "p", "m", parts))[0],
  );
  assert.equal(new Set(workspaces).size, 4);
});

test("sessionOf: a run that reaches the open internet never shares volumes with one that doesn't", () => {
  // A work run with `internet` beside the issue's next ordinary one; two light runs with
  // `setup`, one with `internet` (both checked by the gateways); a light run without `pull`.
  const pairs = [
    [
      { mode: "work", light: false, capabilities: ["pull", "push", "internet"] },
      { mode: "work", light: false, capabilities: ["pull", "push"] },
    ],
    [
      { mode: "audit", light: true, capabilities: ["pull", "setup", "internet"] },
      { mode: "audit", light: true, capabilities: ["pull", "setup"] },
    ],
    [
      { mode: "brainstorm", light: true, capabilities: ["internet"] },
      { mode: "brainstorm", light: true, capabilities: [] },
    ],
  ];
  for (const [open, closed] of pairs) {
    const [a, b] = [open, closed].map((live) =>
      workspaceOf(sandboxSpec(runOf(live), "p", "m", parts)),
    );
    assert.ok(
      a.every((v) => !b.includes(v)),
      `${open.mode}: ${a} / ${b}`,
    );
    assert.ok(
      a.every((v) => v.includes("-open-")),
      String(a),
    );
  }
  assert.equal(sessionOf("n", pairs[0][0]), "n-open");
  assert.equal(sessionOf("n", pairs[1][0]), "n-light-trusted-open");
  // Each among the names a comment without a trigger line looks in, and the runner takes.
  assert.ok(sessionNames("n", false).includes("n-open"));
  assert.ok(sessionNames("n", true).includes("n-light-trusted-open"));
  // Research keeps its own.
  assert.equal(
    sessionOf("n", { mode: "research", light: true, capabilities: ["internet"] }),
    "n-research",
  );
});
