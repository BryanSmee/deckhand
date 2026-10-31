// What the runner refuses of a sandbox spec whatever the orchestrator says (runner/spec-check.mjs):
// root, capabilities, another repository's image or volumes, a host path outside a granted root,
// an engine the repository isn't granted.
import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { cacheVolume, repoImage, sandboxName } from "../listener/repo-config.mjs";
import { SANDBOX_USER } from "../listener/sandbox-spec.mjs";
import { cliEnv, cliName } from "../listener/runner/docker.mjs";
import { specProblems } from "../runner/spec-check.mjs";
import { tempDir } from "./helpers.mjs";

function setup(t, grant = "") {
  const dir = tempDir(t, "deckhand-grants-");
  mkdirSync(join(dir, "grants", "org"), { recursive: true });
  writeFileSync(join(dir, "grants", "org", "repo.yaml"), grant);
  const config = {
    prefix: "dh",
    image: "dh-sandbox",
    grantsDir: join(dir, "grants"),
    limits: { cpus: "2", memory: "4g", pids: 2048 },
    claudeCodeVolume: "dh-claude-code",
    codexVolume: "dh-codex",
    agyVolume: "dh-antigravity",
    engine: "sysbox",
    kubernetes: { registry: "registry.example.com/dh" },
  };
  return { dir, config };
}

// A spec as sandbox-spec.mjs makes one, for org/repo#12.
const spec = (config, extra = {}) => ({
  run: "dh-org-repo-12-1",
  name: "dh-org-repo-12",
  image: config.image,
  labels: { "deckhand.task": "org/repo#12" },
  user: SANDBOX_USER,
  caps: [],
  limits: config.limits,
  volumes: [
    { kind: "agent", name: "dh-claude-code", path: "/opt/claude-code", readOnly: true },
    { kind: "session", name: "dh-org-repo-12-workspace", path: "/workspace" },
    {
      kind: "cache",
      name: cacheVolume(config, "org/repo", "/home/node/.npm"),
      path: "/home/node/.npm",
    },
  ],
  ...extra,
});

test("a spec as the listener makes one passes, on the base image or the repository's own", (t) => {
  const { config } = setup(t);
  assert.deepEqual(specProblems(config, spec(config)), []);
  const own = `${repoImage(config, "org/repo")}:0123456789abcdef`;
  assert.deepEqual(specProblems(config, spec(config, { image: own })), []);
  // Under the registry the Kubernetes runner pushes to; never another.
  assert.deepEqual(
    specProblems(config, spec(config, { image: `registry.example.com/dh/${own}` })),
    [],
  );
  const [elsewhere] = specProblems(config, spec(config, { image: `evil.example/x/${own}` }));
  assert.match(
    elsewhere,
    /^its image evil\.example\/x\/dh-repo-.* is neither the base image nor org\/repo's$/,
  );
});

test("root, capabilities, another image, another's volumes: refused, each said", (t) => {
  const { config } = setup(t);
  const other = `${repoImage(config, "org/other")}:0123456789abcdef`;
  assert.deepEqual(
    specProblems(
      config,
      spec(config, {
        user: { uid: 0, gid: 0 },
        caps: ["SYS_ADMIN"],
        image: other,
        volumes: [
          { kind: "agent", name: "dh-claude-code", path: "/opt/claude-code", readOnly: false },
          { kind: "agent", name: "docker-socket", path: "/x", readOnly: true },
          { kind: "session", name: "dh-org-other-3-workspace", path: "/workspace" },
          { kind: "cache", name: cacheVolume(config, "org/other", "/c"), path: "/c" },
          { kind: "bind", name: "rootfs", path: "/host" },
        ],
      }),
    ),
    [
      "it runs as 0:0, not the sandbox's user",
      "it asks for capabilities (SYS_ADMIN)",
      `its image ${other} is neither the base image nor org/repo's`,
      "the volume dh-claude-code at /opt/claude-code: an agent's volume, read-only, only",
      "the volume docker-socket at /x: an agent's volume, read-only, only",
      "the volume dh-org-other-3-workspace at /workspace: not one of dh-org-repo-12's sessions",
      `the volume ${cacheVolume(config, "org/other", "/c")} at /c: not org/repo's cache for /c`,
      "the volume rootfs at /host: of no kind a sandbox has (bind)",
    ],
  );
  // Nothing Docker would read as another option: a target that names its own source, a volume
  // whose name ends early, a folder of it.
  const injected = (volume) => specProblems(config, spec(config, { volumes: [volume] }));
  assert.deepEqual(injected({ kind: "mount", name: "/srv", path: "/w,src=/,dst=/host" }), [
    "the volume /srv at /w,src=/,dst=/host: not at a plain absolute path",
  ]);
  assert.deepEqual(injected({ kind: "session", name: "dh-org-repo-12-x:/etc", path: "/w" }), [
    "the volume dh-org-repo-12-x:/etc at /w: not a volume's name",
  ]);
  assert.deepEqual(
    injected({ kind: "session", name: "dh-org-repo-12-w", path: "/w", subpath: "../.." }),
    ["the volume dh-org-repo-12-w at /w: not at a plain absolute path"],
  );
  assert.deepEqual(
    injected({ kind: "agent", name: "dh-codex", path: "/opt/../x", readOnly: true }),
    ["the volume dh-codex at /opt/../x: not at a plain absolute path"],
  );
  // The task's own sandbox name, and only the session volumes it has: never a name that other
  // volumes start with (the agents', the runs folder, another service's).
  assert.deepEqual(specProblems(config, spec(config, { name: "dh" })), [
    `its name dh is not org/repo#12's sandbox's (${sandboxName(config, "org/repo", "12")})`,
  ]);
  const hashed = sandboxName(config, "org/repo", "12");
  assert.deepEqual(
    specProblems(
      config,
      spec(config, {
        name: hashed,
        run: `${hashed}-1`,
        volumes: [
          { kind: "session", name: `${hashed}-light-claude`, path: "/home/node/.claude" },
          { kind: "session", name: `${hashed}-fork-workspace`, path: "/workspace" },
          // A run without `pull`'s, and a light run's that gets what later runs trust
          // (sandbox-spec.mjs sessionOf()).
          { kind: "session", name: `${hashed}-bare-workspace`, path: "/w1" },
          { kind: "session", name: `${hashed}-light-trusted-claude`, path: "/w2" },
          { kind: "session", name: `${hashed}-claude-code`, path: "/x" },
        ],
      }),
    ),
    [`the volume ${hashed}-claude-code at /x: not one of ${hashed}'s sessions`],
  );
  // Its environment: no name the runner's docker CLI or a loader would take for its own.
  assert.deepEqual(
    specProblems(
      config,
      spec(config, {
        env: { TASK_PROMPT: "x", LD_PRELOAD: "/a.so", DOCKER_HOST: "tcp://x", "a=b": "" },
      }),
    ),
    ["its environment's LD_PRELOAD", "its environment's DOCKER_HOST", "its environment's a=b"],
  );
  // The operator's limits, never lifted by the spec; its task's label only (the runner finds the
  // listener and the proxy by theirs).
  assert.deepEqual(
    specProblems(
      config,
      spec(config, {
        limits: { cpus: "2", memory: "0", pids: -1 },
        labels: {
          "deckhand.task": "org/repo#12",
          "deckhand.role": "broker",
          "com.docker.compose.project": "x",
        },
      }),
    ),
    [
      "its label deckhand.role",
      "its label com.docker.compose.project",
      "its limits aren't the operator's for it",
    ],
  );
  assert.deepEqual(
    specProblems(config, spec(config, { engine: { limits: { ...config.limits, pids: 0 } } })),
    [
      "its engine's limits aren't the operator's for it",
      "a container engine, which the operator doesn't grant org/repo",
    ],
  );
  // A task's legacy name only when it can't be another task's current one (a hash at its end):
  // a/b-5#<hash>'s would be a/b #5's.
  const current = sandboxName(config, "a/b", "5");
  const hash = current.slice(-10);
  const lookalike = spec(config, {
    name: current,
    labels: { "deckhand.task": `a/b-5#${hash}` },
    volumes: [],
  });
  assert.match(specProblems(config, lookalike)[0], /^its name .* is not a\/b-5#/);
  // Its run named after its sandbox: never the host's network, nor another task's run.
  for (const run of ["bridge", "dh-org-repo-1-5", "dh-org-repo-12-x"]) {
    assert.deepEqual(specProblems(config, spec(config, { run })), [
      `its run ${run} isn't one of dh-org-repo-12's`,
    ]);
  }
  // No task: nothing else is read.
  assert.deepEqual(specProblems(config, spec(config, { labels: {} })), [
    "it names no run's task (its deckhand.task label)",
  ]);
});

test("host paths: inside a root granted to the repository, resolved again, read-only unless granted", (t) => {
  const { dir, config } = setup(t);
  const root = join(dir, "srv");
  mkdirSync(join(root, "data"), { recursive: true });
  // A link inside the root that leads out of it.
  symlinkSync("/etc", join(root, "out"));
  writeFileSync(
    join(config.grantsDir, "org", "repo.yaml"),
    `mounts:\n  - root: ${root}\n    read_only: true\nallow_docker: false\n`,
  );
  const mount = (name, readOnly = true) =>
    spec(config, { volumes: [{ kind: "mount", name, path: name, readOnly }] });
  assert.deepEqual(specProblems(config, mount(join(root, "data"))), []);
  const [writable] = specProblems(config, mount(join(root, "data"), false));
  assert.match(writable, /data: not as the operator grants it$/);
  const [out] = specProblems(config, mount(join(root, "out")));
  assert.match(
    out,
    /out: .*resolves to \/etc, outside the roots the operator grants this repository/,
  );
  const [etc] = specProblems(config, mount("/etc"));
  assert.match(etc, /^the host path \/etc: .*outside the roots/);
  // An engine it isn't granted.
  assert.deepEqual(specProblems(config, spec(config, { engine: { limits: config.limits } })), [
    "a container engine, which the operator doesn't grant org/repo",
  ]);
});

test("the environment names the runner's docker CLI keeps are the ones a spec may not set", (t) => {
  const { config } = setup(t);
  const names = ["LD_PRELOAD", "DOCKER_HOST", "SSL_CERT_FILE", "SSL_CERT_DIR", "GODEBUG"];
  for (const name of [...names, "GOTRACEBACK", "PATH", "NODE_OPTIONS", "BUILDKIT_HOST"]) {
    assert.equal(cliName(name), true, name);
    const env = cliEnv({ [name]: "theirs" }, { PATH: "/bin" });
    assert.notEqual(env[name], "theirs", name);
    assert.deepEqual(specProblems(config, spec(config, { env: { [name]: "x" } })), [
      `its environment's ${name}`,
    ]);
  }
  assert.equal(cliName("TASK_PROMPT"), false);
});
