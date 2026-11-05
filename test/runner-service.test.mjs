// The runner service (runner/service.mjs) and its client (runner/client.mjs), in process: the
// Docker runner on the in-memory fake docker (helpers.mjs fakeDocker()) behind its API, what each
// caller may call, the orchestrator's fencing epoch, a start asked twice, and two copies on one
// store handing over, on release and on expiry.
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { activePassive } from "../lib/active.mjs";
import { openBlobs } from "../lib/blobs.mjs";
import { createLogger, withLogContext } from "../lib/log.mjs";
import { EPOCH_HEADER } from "../lib/service-client.mjs";
import { networkCallers, signServiceToken } from "../lib/service-token.mjs";
import { fileStore } from "../lib/store-file.mjs";
import { keyId } from "../lib/tokens.mjs";
import { markerName } from "../listener/runner/deployment.mjs";
import { createDockerRunner } from "../listener/runner/docker.mjs";
import { SANDBOX_USER } from "../listener/sandbox-spec.mjs";
import { createRunnerClient, RunnerAway } from "../runner/client.mjs";
import { createEvents } from "../runner/events.mjs";
import { createLogs } from "../runner/logs.mjs";
import { createRunnerService, ROUTES } from "../runner/service.mjs";
import { runnerMetrics } from "../runner/metrics.mjs";
import { createRegistry } from "../lib/metrics.mjs";
import { chatSandbox } from "../runner/spec-check.mjs";
import { sandboxName } from "../listener/repo-config.mjs";
import { grantsFrom } from "../listener/grants.mjs";
import {
  assertHealth,
  fakeDocker,
  grantedOf,
  listenToRestart,
  tempDir,
  until,
} from "./helpers.mjs";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const signing = { privateKey, kid: keyId(publicKey) };
const keys = new Map([[signing.kid, publicKey]]);
const tokenFor = (sub) => `Bearer ${signServiceToken({ sub, aud: "runner" }, signing)}`;

const config = {
  runner: "docker",
  prefix: "dh",
  image: "dh-sandbox",
  // The operator's limits, the specs' own (spec-check.mjs).
  limits: { cpus: "1", memory: "1g", pids: 256 },
  githubUrl: "https://github.com",
  githubApi: "https://api.github.com",
  egressProxy: "http://egress:3128",
  egressContainer: "",
  engine: null,
};

const SPEC = {
  run: "dh-o-a-1-1",
  name: "dh-o-a-1",
  image: "dh-sandbox",
  user: SANDBOX_USER,
  limits: { cpus: "1", memory: "1g", pids: 256 },
  env: { TASK_PROMPT: "Do it" },
  labels: { "deckhand.task": "o/a#1" },
};

// `docker logs --follow`: what the fake sandbox printed, then its end.
function logsSpawn(lines) {
  return () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => child.emit("close", null);
    setImmediate(() => {
      child.stdout.end(lines.map((l) => `${l}\n`).join(""));
      child.stderr.end("cloning\n");
      setImmediate(() => child.emit("close", 0));
    });
    return child;
  };
}

// The Docker runner on one fake docker, shared by the copies (one host's Docker).
function host({ lines = ['{"type":"result","result":"Done."}'], answers, metrics } = {}) {
  const calls = [];
  const fake = fakeDocker({ answers });
  const docker = async (args, opts = {}) => {
    calls.push({ args, env: opts.env });
    return fake.docker(args);
  };
  const inboxDir = tempDir(null, "deckhand-runs-");
  const runner = createDockerRunner({
    config,
    docker,
    spawn: logsSpawn(lines),
    inboxDir,
    metrics,
  });
  const runs = () => calls.filter((c) => c.args[0] === "run").length;
  // A run's inbox file, as the broker gets a copy of it.
  const inbox = (run) => {
    try {
      return readFileSync(join(inboxDir, run, "inbox.jsonl"), "utf8");
    } catch {
      return null;
    }
  };
  return { ...fake, calls, runner, runs, inbox };
}

// One copy of the runner service, listening; its lease on `store` (shared by the copies).
// `bound`: its callers' networks; `brokerTokens`: what the broker gives a run being started.
// `ttlMs`: long by default, so that a paused runner doesn't let it expire (a 503 then); the
// expiry's tests set theirs.
// The grants folder, and what the operator's policies grant: org/repo may build its Dockerfile.
const grants = () => grantsFrom({ "org/repo.yaml": "hosts: [pypi.org]\n" }, config);
const granted = grantedOf(["dockerfile"], "org/repo");

async function copy(
  t,
  {
    store,
    backend,
    ttlMs = 10_000,
    bound,
    brokerTokens,
    imageFor,
    blobOf,
    log,
    refresh,
    logs = createLogs({ store }),
    metrics,
    settings = config,
    grantedTo = granted,
    claimAgainMs,
  } = {},
) {
  let service;
  const lease = activePassive({
    store,
    name: "runner",
    holder: `copy-${Math.random()}`,
    ttlMs,
    pollMs: 10,
    onActive: () => service.activate(),
    onPassive: () => service.deactivate(),
  });
  const asked = [];
  const built = [];
  service = createRunnerService({
    config: settings,
    runner: backend.runner,
    images: {
      keepsCaches: true,
      noCaches: null,
      egressFor: async () => null,
      imageFor: imageFor ?? (async (plan) => (built.push(plan), "dh-sandbox")),
      installAgent: async () => {},
      caches: async () => [],
    },
    logs,
    store,
    broker: {
      runTokens: async (run, sandbox) => {
        asked.push([run, sandbox]);
        return brokerTokens ? brokerTokens(run, sandbox) : { DECKHAND_RUN_TOKEN: `tok-${run}` };
      },
    },
    keys: () => keys,
    bound: bound ?? networkCallers("edge+orchestrator+models+broker=127.0.0.0/8"),
    lease,
    watchMs: 50,
    grants,
    granted: grantedTo,
    blobOf:
      blobOf ?? (async (repo, path, ref) => `blob of ${path} at ${ref ?? "the default branch"}`),
    ...(log && { log }),
    ...(refresh && { refresh }),
    ...(metrics && { metrics }),
    ...(claimAgainMs !== undefined && { claimAgainMs }),
  });
  // Where a test may start it again (a runner away, then back).
  await listenToRestart(service.server);
  await lease.start();
  t.after(async () => {
    await lease.stop();
    service.deactivate();
    service.server.closeAllConnections();
    await new Promise((resolve) => service.server.close(resolve));
  });
  const url = `http://127.0.0.1:${service.server.address().port}`;
  return { url, service, lease, asked, built };
}

// A call to `url` as `sub` (the orchestrator's with `epoch`).
function call(url, method, path, { sub, epoch = 1, body } = {}) {
  return fetch(`${url}${path}`, {
    method,
    headers: {
      ...(sub && { authorization: tokenFor(sub) }),
      ...(sub === "orchestrator" && epoch !== null && { [EPOCH_HEADER]: String(epoch) }),
      ...(body !== undefined && { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const client = (urls, extra = {}) =>
  createRunnerClient({
    urls,
    token: async (sub) => tokenFor(sub),
    epoch: () => 1,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 20))),
    runWaitMs: 5000,
    ...extra,
  });

test("GET /health: without a token, its start, version and whether this copy acts, nothing else", async (t) => {
  const { url, lease } = await copy(t, { store: fileStore(), backend: host() });
  const health = await fetch(`${url}/health`);
  assert.equal(health.status, 200);
  assertHealth(await health.json(), { active: lease.active() });
});

// The closed log segments a copy left (blob storage away): the copy taking the lease moves them,
// and its /health counts them while blob storage fails (logs.mjs, #608).
test("GET /health: the log segments waiting for blob storage; the copy acting moves them", async (t) => {
  const store = fileStore();
  const files = openBlobs(pathToFileURL(join(tempDir(t), "blobs")).href);
  let down = true;
  const blobs = {
    ...files,
    put: async (...args) => (down ? Promise.reject(new Error("away")) : files.put(...args)),
  };
  const before = createLogs({ store, blobs, segmentMax: 4 });
  let at = await before.append("dh-o-a-1-1", 0, Buffer.from("hello"));
  at = await before.append("dh-o-a-1-1", at, Buffer.from("world"), { step: true, close: true });
  const logs = createLogs({ store, blobs, log: () => {} });
  const { url } = await copy(t, { store, backend: host(), logs });
  const warnings = async () => (await (await fetch(`${url}/health`)).json()).warnings;
  await until(async () => (await warnings())?.length);
  assert.deepEqual(await warnings(), [
    "2 closed log segments (0.0 MB) wait in the store: they can't be moved to blob storage now, tried again with a growing delay (the runner's log says why)",
  ]);
  down = false;
  await logs.moves.pass();
  assert.equal(await warnings(), undefined);
  assert.equal(await store.blobSize("logs/dh-o-a-1-1/0"), null);
  assert.equal((await files.read("logs/dh-o-a-1-1/1")).toString(), "world");
  assert.equal((await logs.read("dh-o-a-1-1")).data.toString(), "hello");
});

// Two deployments of one prefix on one engine (#858): each store its own ID, the first to claim
// the prefix keeps it, the other takes no call and watches no sandbox until its marker is removed.
test("a prefix another deployment claimed: no call taken, no event watched, the clash logged once and in /health", async (t) => {
  const backend = host();
  const first = await copy(t, { store: fileStore(), backend });
  assert.equal((await call(first.url, "GET", "/sandboxes", { sub: "orchestrator" })).status, 200);
  // A sandbox of the first one's, running.
  backend.containers.set("dh-o-a-1", { owner: "dh", run: "dh-o-a-1-1", running: true });
  const logged = [];
  const store = fileStore();
  const second = await copy(t, { store, backend, log: (line) => logged.push(line) });
  const refused = await call(second.url, "GET", "/sandboxes", { sub: "orchestrator" });
  assert.equal(refused.status, 503);
  assert.match((await refused.json()).message, /NAME_PREFIX dh is another deployment's/);
  assert.equal((await call(second.url, "GET", "/sandboxes", { sub: "orchestrator" })).status, 503);
  const warnings = async (url) => (await (await fetch(`${url}/health`)).json()).warnings;
  assert.match((await warnings(second.url))[0], /docker volume rm dh-deployment/);
  assert.equal(logged.filter((line) => /NAME_PREFIX/.test(line)).length, 1);
  // Its watch (every 50 ms here) never saw the first one's sandbox, nor do its metrics.
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(await store.get("events/running"), null);
  assert.equal(await second.service.sandboxes(), null);
  // The first one goes on.
  assert.equal((await call(first.url, "GET", "/sandboxes", { sub: "orchestrator" })).status, 200);
  assert.equal(await warnings(first.url), undefined);
  assert.deepEqual(await first.service.sandboxes(), [{ engine: "none" }]);
  // Its marker removed (the operator's, when no other deployment uses the prefix): claimed again
  // by its watch, without a restart, which then follows the sandboxes.
  backend.volumes.delete(markerName("dh"));
  await until(async () => (await store.get("events/running"))?.["dh-o-a-1-1"]);
  assert.equal((await call(second.url, "GET", "/sandboxes", { sub: "orchestrator" })).status, 200);
  assert.equal(await warnings(second.url), undefined);
  assert.deepEqual(await second.service.sandboxes(), [{ engine: "none" }]);
});

// A marker removed while the runner runs (a `docker volume prune`): its watch claims the prefix
// again, before another deployment can.
test("the prefix claimed again while the runner acts: its marker put back", async (t) => {
  const backend = host();
  const store = fileStore();
  await copy(t, { store, backend, claimAgainMs: 0 });
  await until(() => backend.volumes.has(markerName("dh")));
  const id = backend.volumes.get(markerName("dh"))["deckhand.deployment"];
  assert.equal(id, await store.get("deployment"));
  backend.volumes.delete(markerName("dh"));
  await until(() => backend.volumes.has(markerName("dh")));
  assert.equal(backend.volumes.get(markerName("dh"))["deckhand.deployment"], id);
});

// A probe's second: /health never waits on the store, Redis stalling or not.
test("GET /health answers while the store's reads hang", async (t) => {
  const shared = fileStore();
  const files = openBlobs(pathToFileURL(join(tempDir(t), "blobs")).href);
  const hanging = {
    ...shared,
    get: async (key) => (key.startsWith("log-moves/") ? new Promise(() => {}) : shared.get(key)),
  };
  const logs = createLogs({ store: hanging, blobs: files, log: () => {} });
  logs.moves.stop(); // as a copy that isn't acting: it reads the store for /health
  const { url } = await copy(t, { store: shared, backend: host(), logs });
  logs.moves.stop();
  for (let i = 0; i < 3; i++) {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1000) });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).warnings, undefined);
  }
});

test("each caller gets its own endpoints only, from its own network, with a valid token", async (t) => {
  const store = fileStore();
  const { url } = await copy(t, { store, backend: host() });
  const status = async (...args) => (await call(url, ...args)).status;
  // No token, or one of another key.
  assert.equal(await status("GET", "/sandboxes"), 401);
  const other = generateKeyPairSync("ed25519");
  const forged = signServiceToken(
    { sub: "orchestrator", aud: "runner" },
    { privateKey: other.privateKey, kid: signing.kid },
  );
  const res = await fetch(`${url}/sandboxes`, {
    headers: { authorization: `Bearer ${forged}`, [EPOCH_HEADER]: "1" },
  });
  assert.equal(res.status, 401);
  // The orchestrator drives runs and reads their logs (the dashboard's, which edge passes on,
  // #506); edge calls the runner for nothing.
  assert.equal(await status("GET", "/sandboxes", { sub: "orchestrator" }), 200);
  assert.equal(await status("GET", "/sandboxes", { sub: "edge" }), 403);
  assert.equal(await status("POST", "/sandboxes", { sub: "edge", body: SPEC }), 403);
  assert.equal(await status("GET", "/logs/dh-o-a-1-1", { sub: "edge" }), 403);
  assert.equal(await status("GET", "/logs/dh-o-a-1-1", { sub: "orchestrator" }), 200);
  assert.equal(await status("DELETE", "/logs/dh-o-a-1-1", { sub: "edge" }), 403);
  // The egress policy's lookups, the orchestrator's: without its epoch (UNFENCED), so a
  // listener draining still answers them; nothing else of its goes without one.
  assert.equal(
    await status("GET", "/addresses/10.0.0.9", { sub: "orchestrator", epoch: null }),
    200,
  );
  assert.equal(await status("GET", "/proxy-addresses", { sub: "orchestrator", epoch: null }), 200);
  // The inbox is the broker's to serve: the runner keeps no route for it.
  assert.equal(
    await status("GET", "/runs/dh-o-a-1-1/inbox?from=0", { sub: "orchestrator", epoch: null }),
    403,
  );
  assert.equal(await status("GET", "/sandboxes", { sub: "orchestrator", epoch: null }), 400);
  assert.equal(await status("GET", "/addresses/10.0.0.9", { sub: "edge" }), 403);
  // The broker calls the runner for nothing.
  assert.equal(await status("GET", "/addresses/10.0.0.9", { sub: "broker" }), 403);
  // Models has the Antigravity login refreshed (none on this runner), only that.
  assert.equal(
    await status("POST", "/logins/antigravity/refresh", { sub: "models", body: {} }),
    501,
  );
  assert.equal(await status("POST", "/logins/antigravity/refresh", { sub: "edge", body: {} }), 403);
  assert.equal(await status("GET", "/events", { sub: "models" }), 403);
  // A service that doesn't call the runner, and an endpoint that isn't in the table.
  assert.equal(await status("GET", "/sandboxes", { sub: "github" }), 403);
  assert.equal(await status("GET", "/nothing", { sub: "orchestrator" }), 403);
  // Names that would climb out of the runs folder, or read as an option.
  assert.equal(await status("DELETE", "/sandboxes/dh-a?run=..", { sub: "orchestrator" }), 400);
  assert.equal(await status("DELETE", "/sandboxes/-rf", { sub: "orchestrator" }), 400);
  const dots = { ...SPEC, run: "..", name: "dh-o-a-1" };
  assert.equal(await status("POST", "/sandboxes", { sub: "orchestrator", body: dots }), 400);
  // Every endpoint names its callers: none takes the proxy or the policy service.
  for (const callers of Object.values(ROUTES)) {
    assert.ok(callers.every((c) => ["orchestrator", "models"].includes(c)));
  }
});

test("a build its grants don't allow is refused", async (t) => {
  const { url } = await copy(t, { store: fileStore(), backend: host() });
  const build = { repo: "org/other", ref: "main", dockerfile: "Dockerfile", blob: "b" };
  const refused = await call(url, "POST", "/images", { sub: "orchestrator", body: build });
  assert.equal(refused.status, 403);
  assert.match((await refused.json()).message, /don't grant `dockerfile`/);
  const branch = { ...build, repo: "org/repo", branch: true };
  assert.match(
    (await (await call(url, "POST", "/images", { sub: "orchestrator", body: branch })).json())
      .message,
    /don't grant `branch_docker_images`/,
  );
});

test("a build is the runner's to plan: the default branch unless granted, the blob GitHub says, the granted hosts", async (t) => {
  const { url, built } = await copy(t, { store: fileStore(), backend: host() });
  const build = (body) => call(url, "POST", "/images", { sub: "orchestrator", body });
  // Not asked as a branch's, a pull request's head is the default branch: no grant needed for
  // it, and its tag can't be the default branch's with another commit's files.
  const res = await build({
    repo: "org/repo",
    ref: "0123456789abcdef0123456789abcdef01234567",
    branch: false,
    dockerfile: "Dockerfile",
    blob: "a blob it made up",
    access: { hosts: ["github.com", "evil.example"], trusted: ["evil.example"] },
  });
  assert.equal(res.status, 200);
  await res.text();
  assert.equal(built.length, 1);
  assert.deepEqual(
    [built[0].ref, built[0].branch, built[0].blob],
    [null, false, "blob of Dockerfile at the default branch"],
  );
  assert.deepEqual(built[0].access, { hosts: ["github.com"], trusted: [] });
});

test("a cache is prepared in the base image or the repository's own, at plain paths only", async (t) => {
  const { url } = await copy(t, { store: fileStore(), backend: host() });
  const caches = (body) => call(url, "POST", "/caches", { sub: "orchestrator", body });
  const asked = { repo: "org/repo", paths: ["/home/node/.npm"], image: "dh-sandbox" };
  assert.equal((await caches(asked)).status, 200);
  for (const [body, status] of [
    [{ ...asked, image: "alpine" }, 403],
    [{ ...asked, image: "--privileged" }, 403],
    [{ ...asked, image: "dh-repo-org-other-0123456789:abc" }, 403],
    [{ ...asked, paths: ["/x,dst=/host"] }, 400],
    [{ ...asked, paths: ["/a/../etc"] }, 400],
    [{ ...asked, repo: "org/../x" }, 400],
  ]) {
    assert.equal((await caches(body)).status, status, JSON.stringify(body));
  }
});

test("a caller's token from another network is refused", async (t) => {
  const store = fileStore();
  // The orchestrator's network is elsewhere: 127.0.0.1 is the models service's alone.
  const bound = networkCallers("models=127.0.0.0/8,orchestrator=10.9.0.0/16");
  const { url } = await copy(t, { store, backend: host(), bound });
  assert.equal((await call(url, "GET", "/sandboxes", { sub: "orchestrator" })).status, 403);
  const refresh = await call(url, "POST", "/logins/antigravity/refresh", {
    sub: "models",
    body: {},
  });
  assert.equal(refresh.status, 501);
});

test("the login's refresh gets what is left of the models service's lease, a bad one refused", async (t) => {
  const store = fileStore();
  const asked = [];
  const { url } = await copy(t, {
    store,
    backend: host(),
    refresh: async (input, options) => (
      asked.push([input, options]),
      { code: 0, out: "{}", err: "" }
    ),
  });
  const refresh = (body) =>
    call(url, "POST", "/logins/antigravity/refresh", { sub: "models", body });
  assert.equal((await refresh({ input: "file", timeoutMs: 150_000 })).status, 200);
  // A models service older than this runner sends none: the runner's own budget.
  assert.equal((await refresh({ input: "file" })).status, 200);
  assert.deepEqual(asked, [
    ["file", { timeoutMs: 150_000 }],
    ["file", {}],
  ]);
  for (const timeoutMs of ["soon", -1, null]) {
    assert.equal((await refresh({ input: "file", timeoutMs })).status, 400, String(timeoutMs));
  }
  assert.equal(asked.length, 2);
});

test("the orchestrator's fencing epoch: none refused, a stale one refused, the newest kept by both copies", async (t) => {
  const store = fileStore();
  const backend = host();
  const a = await copy(t, { store, backend });
  const status = async (url, epoch) =>
    (await call(url, "GET", "/sandboxes", { sub: "orchestrator", epoch })).status;
  assert.equal(await status(a.url, null), 400);
  assert.equal(await status(a.url, 2), 200);
  assert.equal(await status(a.url, 1), 409);
  assert.equal(await status(a.url, 3), 200);
  // The other copy, once it acts, refuses the same: the newest is in the store.
  const b = await copy(t, { store, backend });
  await a.lease.stop();
  await until(() => b.lease.active(), { what: "the other copy's lease" });
  assert.equal(await status(b.url, 2), 409);
  const refused = await call(b.url, "POST", "/sandboxes", {
    sub: "orchestrator",
    epoch: 2,
    body: SPEC,
  });
  assert.match((await refused.json()).message, /epoch 2 is stale: 3 is the orchestrator's now/);
  assert.equal(backend.runs(), 0);
  // A log's read changes nothing: not fenced, a stale epoch's included.
  const read = (epoch) => call(b.url, "GET", "/logs/dh-o-a-1-1", { sub: "orchestrator", epoch });
  assert.equal((await read(null)).status, 200);
  assert.equal((await read(1)).status, 200);
  // One no clock gives (they are the orchestrator's clock until #506): refused, not kept, so
  // that it never locks every later listener out.
  const far = Date.now() + 2 * 24 * 3600_000;
  assert.equal(await status(b.url, far), 400);
  assert.equal(await status(b.url, Number.MAX_SAFE_INTEGER), 400);
  assert.equal(await status(b.url, 4), 200);
});

test("a run starts through the client, its first tokens from the broker; asked again, nothing starts", async (t) => {
  const store = fileStore();
  const backend = host();
  const a = await copy(t, { store, backend });
  const pendingTokens = new Map();
  const runner = client(a.url, { pendingTokens }).runner;
  let sandbox = null;
  const tokens = async (id) => ((sandbox = id), { DECKHAND_RUN_TOKEN: "run-token" });
  assert.deepEqual(await runner.start({ ...SPEC, tokens }), { engine: null });
  // The runner asked the broker for them, bound to the run's network, once it existed.
  assert.deepEqual(a.asked, [["dh-o-a-1-1", "id-dh-o-a-1-1"]]);
  const run = backend.calls.find((c) => c.args[0] === "run");
  // In the sandbox's environment, by name only: never on its command line.
  assert.equal(run.env.DECKHAND_RUN_TOKEN, "tok-dh-o-a-1-1");
  assert.ok(run.args.includes("DECKHAND_RUN_TOKEN"));
  assert.ok(!run.args.some((a) => a.includes("tok-dh-o-a-1-1")));
  assert.equal(pendingTokens.size, 0);
  assert.equal(sandbox, null);
  // The same run again (a lost answer, a handover): it finds the sandbox, starts nothing.
  assert.deepEqual(await runner.start({ ...SPEC, tokens }), { engine: null });
  assert.equal(backend.runs(), 1);
  assert.equal(await runner.state("dh-o-a-1"), "running");
  assert.deepEqual(await runner.list(), [{ name: "dh-o-a-1", run: "dh-o-a-1-1", running: true }]);
});

test("a start recovered after a crash keeps its sandbox's container engine", async (t) => {
  const store = fileStore();
  const backend = host();
  const settings = { ...config, engine: "sysbox" };
  const grantedTo = grantedOf(["docker"], "o/a");
  const said = [];
  const log = (line) => said.push(line);
  const a = await copy(t, { store, backend, settings, grantedTo, log });
  const runner = client(a.url).runner;
  const spec = { ...SPEC, engine: { limits: SPEC.limits, cache: null } };
  // A copy that crashed once Docker ran the sandbox and its Sysbox engine, before its record.
  await store.set(`starts/${spec.run}`, { state: "starting" });
  backend.containers.set(spec.name, { owner: "dh", run: spec.run, running: true, ip: "10.1.0.2" });
  backend.containers.set(`${spec.name}-engine`, {
    owner: "dh",
    engine: spec.run,
    runtime: "sysbox-runc",
    volume: `${spec.run}-engine`,
    running: true,
    ip: "10.1.0.3",
  });
  const sysbox = { backend: "sysbox", volume: `${spec.run}-engine`, cached: false };
  assert.deepEqual(await runner.start(spec), { engine: sysbox });
  assert.equal(backend.runs(), 0);
  assert.deepEqual(await store.get(`starts/${spec.run}`), {
    state: "started",
    result: { engine: sysbox },
  });
  // Asked again, the record answers.
  assert.deepEqual(await runner.start(spec), { engine: sysbox });
  // Counted under its engine, not as one without.
  assert.deepEqual(await a.service.sandboxes(), [{ engine: "sysbox" }]);
  // One whose engine is another run's: none, as before.
  const other = { ...spec, run: "dh-o-a-1-2" };
  await store.set(`starts/${other.run}`, { state: "starting" });
  backend.containers.get(spec.name).run = other.run;
  assert.deepEqual(await runner.start(other), { engine: null });
  // One whose engine is gone (`docker inspect` fails): none too.
  const gone = { ...spec, run: "dh-o-a-1-3" };
  await store.set(`starts/${gone.run}`, { state: "starting" });
  backend.containers.get(spec.name).run = gone.run;
  backend.containers.delete(`${spec.name}-engine`);
  assert.deepEqual(await runner.start(gone), { engine: null });
  // One the backend can't say (its error): none, logged, and the start stands rather than fail.
  const unknown = { ...spec, run: "dh-o-a-1-4" };
  await store.set(`starts/${unknown.run}`, { state: "starting" });
  backend.containers.get(spec.name).run = unknown.run;
  backend.runner.engine = async () => {
    throw new Error("docker inspect: the daemon is away");
  };
  assert.deepEqual(await runner.start(unknown), { engine: null });
  assert.deepEqual(await store.get(`starts/${unknown.run}`), {
    state: "started",
    result: { engine: null },
  });
  assert.ok(said.some((line) => /its container engine unknown: .*daemon is away/.test(line)));
  assert.equal(backend.runs(), 0);
});

test("a start a copy left halfway is done again; a sandbox that started stands", async (t) => {
  const store = fileStore();
  const backend = host();
  const a = await copy(t, { store, backend });
  const runner = client(a.url).runner;
  // A copy that crashed after it said so, before its sandbox (its network left behind).
  await store.set("starts/dh-o-a-1-1", { state: "starting" });
  backend.nets.set("dh-o-a-1-1", new Set(["egress-id"]));
  backend.netLabels.set("dh-o-a-1-1", { "deckhand.owner": "dh", "deckhand.run": "dh-o-a-1-1" });
  await runner.start(SPEC);
  assert.equal(backend.runs(), 1);
  // One that crashed after Docker started it: found, nothing started.
  await store.set("starts/dh-o-b-1-1", { state: "starting" });
  backend.containers.set("dh-o-b-1", {
    owner: "dh",
    run: "dh-o-b-1-1",
    running: true,
    ip: "10.1.0.9",
  });
  assert.deepEqual(
    await runner.start({
      ...SPEC,
      run: "dh-o-b-1-1",
      name: "dh-o-b-1",
      labels: { "deckhand.task": "o/b#1" },
    }),
    { engine: null },
  );
  assert.equal(backend.runs(), 1);
  // A start left halfway whose sandbox's name has another run's container: not taken for it,
  // started again (and Docker refuses the name), never answered as started.
  await store.set("starts/dh-o-b-1-3", { state: "starting" });
  const other = await call(a.url, "POST", "/sandboxes", {
    sub: "orchestrator",
    body: { ...SPEC, run: "dh-o-b-1-3", name: "dh-o-b-1", labels: { "deckhand.task": "o/b#1" } },
  });
  assert.equal(other.status, 500);
  // One whose spec the runner refuses: refused, whatever was left halfway.
  await store.set("starts/dh-o-e-1-1", { state: "starting" });
  const root = { ...SPEC, run: "dh-o-e-1-1", name: "dh-o-e-1", user: { uid: 0, gid: 0 } };
  const refusedHalf = await call(a.url, "POST", "/sandboxes", {
    sub: "orchestrator",
    body: { ...root, labels: { "deckhand.task": "o/e#1" } },
  });
  assert.equal(refusedHalf.status, 403);
  // A start Docker refuses is forgotten: asked again, it is tried again (its name is taken).
  const failed = await call(a.url, "POST", "/sandboxes", {
    sub: "orchestrator",
    body: { ...SPEC, run: "dh-o-b-1-2", name: "dh-o-b-1", labels: { "deckhand.task": "o/b#1" } },
  });
  assert.equal(failed.status, 500);
  assert.match((await failed.json()).message, /the sandbox didn't start/);
  assert.equal(await store.get("starts/dh-o-b-1-2"), null);
  // A spec the runner refuses (spec-check.mjs) starts nothing, and is said as the reply says it.
  await assert.rejects(
    runner.start({
      ...SPEC,
      run: "dh-o-d-1-1",
      name: "dh-o-d-1",
      labels: { "deckhand.task": "o/d#1" },
      user: { uid: 0, gid: 0 },
    }),
    /^Error: the runner refuses its spec: it runs as 0:0, not the sandbox's user$/,
  );
  // Docker was asked twice: the refused name, and the other run of that name above.
  assert.equal(backend.runs(), 3);
});

// One grep follows a webhook across the services (#547): the request the orchestrator handles
// goes with its calls (lib/service-client.mjs), and the runner's lines about them carry it.
test("a request's ID set by the orchestrator shows in the runner's log lines about its call", async (t) => {
  const lines = [];
  const log = createLogger({ service: "runner", env: {}, write: (line) => lines.push(line) });
  const { url } = await copy(t, { store: fileStore(), backend: host(), log });
  const runner = client(url).runner;
  const refused = { ...SPEC, user: { uid: 0, gid: 0 } };
  const fields = { request: "4f1c2a9e0b7d6e35", repo: "o/a", issue: 1 };
  await assert.rejects(
    withLogContext(fields, () => runner.start(refused)),
    /refuses its spec/,
  );
  const said = lines.map((l) => JSON.parse(l)).find((l) => /not started/.test(l.msg));
  assert.equal(said?.request, "4f1c2a9e0b7d6e35");
  assert.equal(said.service, "runner");
  // Only the request crosses: the repository and issue are the caller's context.
  assert.equal(said.repo, undefined);
  // A call outside any request gets an ID of its own.
  await assert.rejects(runner.start({ ...refused, run: "dh-o-a-1-2" }), /refuses its spec/);
  const own = lines.map((l) => JSON.parse(l)).filter((l) => /not started/.test(l.msg))[1];
  assert.match(own.request, /^[0-9a-f]{16}$/);
  assert.notEqual(own.request, said.request);
});

test("output, messages and the inbox through the client: what was read is skipped, its catching up said, a message keyed is sent once", async (t) => {
  const store = fileStore();
  const backend = host({ lines: ["one", "two", "three"] });
  const a = await copy(t, { store, backend });
  const { runner } = client(a.url);
  await runner.start(SPEC);
  const out = [];
  const err = [];
  let caughtUp = 0;
  await runner.follow("dh-o-a-1", {
    skip: { out: 1, err: 0 },
    onOut: (line) => out.push(line),
    onErr: (line) => err.push(line),
    onCaughtUp: () => caughtUp++,
  });
  assert.deepEqual([out, err], [["two", "three"], ["cloning"]]);
  // Past what it skipped: said once, through the runner.
  assert.equal(caughtUp, 1);
  // A runner that isn't there: follow() says so and ends, never throws (its caller asks again).
  const gone = client("http://127.0.0.1:9", { runWaitMs: 50 }).runner;
  await gone.follow("dh-o-a-1", { onOut: () => assert.fail(), onErr: () => assert.fail() });
  // Messages in order, the close after them, in the inbox the broker gets a copy of.
  await runner.send("dh-o-a-1-1", "First", { name: "claude", message: (t) => t });
  runner.send("dh-o-a-1-1", "Second");
  await runner.close("dh-o-a-1-1");
  assert.equal(await runner.closed("dh-o-a-1-1"), true);
  const lines = backend.inbox("dh-o-a-1-1").trim().split("\n");
  assert.equal(lines.length, 3);
  assert.match(lines[0], /First/);
  assert.match(lines[1], /Second/);
  assert.match(lines[2], /"event":"close"/);
  // A message sent again with its key (its answer lost): delivered once.
  const again = async () =>
    (
      await call(a.url, "POST", "/runs/dh-o-a-1-1/messages", {
        sub: "orchestrator",
        body: { text: "Third", id: "k1" },
      })
    ).json();
  assert.deepEqual(await again(), { sent: true });
  assert.deepEqual(await again(), { sent: false });
  // No inbox: none.
  assert.equal(backend.inbox("dh-o-x-1-1"), null);
});

test("a run's log: appends in order through the client, one sent twice taken once, a wrong offset refused", async (t) => {
  const store = fileStore();
  const a = await copy(t, { store, backend: host() });
  const { logs } = client(a.url);
  const file = logs.open("dh-o-a-1-1");
  file.write('{"type":"listener"}\n');
  file.write("line 2\n");
  assert.equal(file.size, 27);
  await file.flushed();
  assert.equal(await logs.text("dh-o-a-1-1"), '{"type":"listener"}\nline 2\n');
  // The same append again: taken already.
  const append = (at, body) =>
    fetch(`${a.url}/logs/dh-o-a-1-1?at=${at}`, {
      method: "POST",
      headers: { authorization: tokenFor("orchestrator"), [EPOCH_HEADER]: "1" },
      body,
    });
  assert.deepEqual(await (await append(20, "line 2\n")).json(), { size: 27 });
  const wrong = await append(3, "x");
  assert.equal(wrong.status, 409);
  assert.equal((await wrong.json()).size, 27);
  // Reopened after a restart: it goes on from the runner's end.
  const reopened = logs.open("dh-o-a-1-1", { size: null });
  await reopened.ready;
  assert.equal(reopened.size, 27);
  reopened.write("line 3\n");
  assert.equal(await reopened.flushed(), true);
  // Read from an offset, waiting for more (the dashboard's live view).
  const waiting = logs.read("dh-o-a-1-1", { offset: 34, wait: 2000 });
  reopened.write("line 4\n");
  assert.equal((await waiting).data.toString(), "line 4\n");
  assert.equal(await logs.remove("dh-o-a-1-1"), true);
  assert.deepEqual(await logs.read("dh-o-a-1-1"), { size: 0, data: Buffer.alloc(0) });
});

test("a log's append whose answer was lost is taken once; a stale epoch's is refused, not looped", async (t) => {
  const store = fileStore();
  const a = await copy(t, { store, backend: host() });
  // The first append reaches the runner, and its answer is lost (the connection cut).
  let cut = 1;
  const losing = async (url, options) => {
    const res = await fetch(url, options);
    if (options?.method === "POST" && String(url).includes("/logs/") && cut-- > 0) {
      throw new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
    }
    return res;
  };
  const { logs } = client(a.url, { fetch: losing });
  const file = logs.open("dh-o-a-1-1");
  file.write("one\n");
  await until(() => cut < 0 || file.size === 0, { what: "the cut" });
  file.write("two\n");
  await until(async () => (await logs.text("dh-o-a-1-1")) === "one\ntwo\n", { what: "the log" });
  assert.equal(await file.flushed(), true);
  // A newer listener writes now: this one's appends are refused, said, and tried again later,
  // not in a loop.
  await call(a.url, "GET", "/sandboxes", { sub: "orchestrator", epoch: 5 });
  let appends = 0;
  const counting = async (url, options) => {
    if (options?.method === "POST") appends++;
    return fetch(url, options);
  };
  const said = [];
  const stale = client(a.url, { fetch: counting, log: (line) => said.push(line) }).logs;
  const old = stale.open("dh-o-a-1-1", { size: null });
  await old.ready;
  old.write("three\n");
  assert.equal(await old.flushed(), false);
  // Tried again after a pause each time (5 s, here 20 ms): a few in 100 ms, not hundreds.
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(appends <= 7, `${appends} appends`);
  assert.match(said.join("\n"), /409 .*epoch 1 is stale/);
  // Read (a stale epoch reads too): nothing of the stale writer's.
  assert.equal((await logs.read("dh-o-a-1-1")).data.toString(), "one\ntwo\n");
});

test("a log written while the runner is away is sent once it is back, in order", async (t) => {
  const store = fileStore();
  // Its port, before it listens.
  const probe = await copy(t, { store: fileStore(), backend: host() });
  const url = probe.url;
  await probe.lease.stop();
  probe.service.server.closeAllConnections();
  await new Promise((resolve) => probe.service.server.close(resolve));
  const { logs } = client(url, { runWaitMs: 30 });
  const file = logs.open("dh-o-a-1-1");
  file.write("one\n");
  file.write("two\n");
  assert.equal(await file.flushed(), false);
  // Back, on the same port.
  const backend = host();
  let service;
  const lease = activePassive({
    store,
    name: "runner",
    holder: "back",
    ttlMs: 400,
    pollMs: 10,
    onActive: () => service.activate(),
  });
  service = createRunnerService({
    config,
    runner: backend.runner,
    images: {},
    logs: createLogs({ store }),
    store,
    broker: {},
    keys: () => keys,
    bound: networkCallers("edge+orchestrator+models+broker=127.0.0.0/8"),
    lease,
  });
  await new Promise((resolve) =>
    service.server.listen(Number(new URL(url).port), "127.0.0.1", resolve),
  );
  await lease.start();
  t.after(async () => {
    await lease.stop();
    service.deactivate();
    await new Promise((resolve) => service.server.close(resolve));
  });
  file.write("three\n");
  await until(async () => (await logs.text("dh-o-a-1-1")) === "one\ntwo\nthree\n", {
    what: "the log",
  });
});

test("handover on release: the waiting copy takes over at once, finds the sandboxes, their logs and events", async (t) => {
  const store = fileStore();
  const backend = host();
  // Leases far longer than the handover: it doesn't wait for one to expire.
  const a = await copy(t, { store, backend, ttlMs: 5000 });
  const b = await copy(t, { store, backend, ttlMs: 5000 });
  assert.equal(a.lease.active(), true);
  assert.equal(b.lease.active(), false);
  // The waiting copy takes no call.
  const passive = await call(b.url, "GET", "/sandboxes", { sub: "orchestrator" });
  assert.equal(passive.status, 503);
  // Behind one Service (Kubernetes), the caller's next try opens another connection.
  assert.equal(passive.headers.get("connection"), "close");
  assert.equal((await fetch(`${b.url}/ready`)).status, 503);
  assert.equal((await fetch(`${a.url}/ready`)).status, 200);
  // The client tries the copies in turn: it reaches the one that acts.
  const both = client(`${b.url},${a.url}`);
  await both.runner.start(SPEC);
  const file = both.logs.open("dh-o-a-1-1");
  file.write("before\n");
  await file.flushed();
  // SIGTERM on the active copy: its calls finish, its lease goes, the other takes it at once.
  const first = a.lease.epoch();
  const released = Date.now();
  await a.service.stop({ graceMs: 1000 });
  await until(() => b.lease.active(), { what: "the other copy's lease" });
  assert.ok(Date.now() - released < 1000, `took ${Date.now() - released} ms`);
  // A higher epoch than the copy before it.
  assert.ok(b.lease.epoch() > first);
  // It finds the sandbox by its labels and the log where it was; a start asked again starts
  // nothing.
  assert.deepEqual(await both.runner.list(), [
    { name: "dh-o-a-1", run: "dh-o-a-1-1", running: true },
  ]);
  assert.equal(await both.logs.text("dh-o-a-1-1"), "before\n");
  await both.runner.start(SPEC);
  assert.equal(backend.runs(), 1);
  // The run's events: its start, then its end with its exit code, seen by the copy acting.
  backend.containers.get("dh-o-a-1").running = false;
  await until(async () => (await both.events.read()).length === 2, { what: "the end's event" });
  const events = await both.events.read();
  assert.deepEqual(
    events.map(({ event }) => [event.type, event.run]),
    [
      ["started", "dh-o-a-1-1"],
      ["ended", "dh-o-a-1-1"],
    ],
  );
  await both.events.ack(events.map((e) => e.id));
  assert.deepEqual(await both.events.read(), []);
});

test("handover on expiry: a copy that stopped answering loses the lease, the other takes over", async (t) => {
  const store = fileStore();
  const backend = host();
  // The first copy's renewals never come back (a frozen process, a lost network).
  let frozen = false;
  const freezing = new Proxy(store, {
    get: (target, key) =>
      key === "renew" && frozen
        ? () => new Promise(() => {})
        : (target[key].bind?.(target) ?? target[key]),
  });
  const a = await copy(t, { store: freezing, backend, ttlMs: 200 });
  const b = await copy(t, { store, backend, ttlMs: 200 });
  const { runner } = client(a.url);
  await runner.start(SPEC);
  const first = a.lease.epoch();
  frozen = true;
  await until(() => b.lease.active(), { what: "the lease's expiry" });
  assert.ok(b.lease.epoch() > first);
  // The frozen copy took itself out by its own clock: it takes no more calls.
  await until(() => !a.lease.active(), { what: "the first copy's loss" });
  assert.equal((await call(a.url, "GET", "/sandboxes", { sub: "orchestrator" })).status, 503);
  const runnerB = client(b.url).runner;
  assert.deepEqual(await runnerB.list(), [{ name: "dh-o-a-1", run: "dh-o-a-1-1", running: true }]);
  await runnerB.start(SPEC);
  assert.equal(backend.runs(), 1);
});

test("run events: an end said once, with its exit code, across the copies' looks", async () => {
  const store = fileStore();
  const sandboxes = [{ name: "dh-o-a-1", run: "dh-o-a-1-1", running: true }];
  const runner = { list: async () => sandboxes, exitCode: async () => 137 };
  const events = createEvents({ store, runner, now: () => 5 });
  await events.started("dh-o-a-1-1", "dh-o-a-1");
  await events.watch();
  sandboxes[0].running = false;
  await events.watch();
  // The next copy's look: nothing new.
  await createEvents({ store, runner }).watch();
  const read = await events.read();
  assert.deepEqual(
    read.map(({ event }) => event),
    [
      { type: "started", run: "dh-o-a-1-1", name: "dh-o-a-1", at: 5 },
      { type: "ended", run: "dh-o-a-1-1", name: "dh-o-a-1", exitCode: 137, at: 5 },
    ],
  );
  // A sandbox running that no start said (a copy from before events): its end is said too.
  sandboxes.push({ name: "dh-o-b-1", run: "dh-o-b-1-1", running: true });
  await events.watch();
  sandboxes.pop();
  await events.watch();
  assert.equal((await events.read()).at(-1).event.run, "dh-o-b-1-1");
  // A sandbox removed before any look saw it end: said as it goes, with its exit code then.
  await events.started("dh-o-c-1-1", "dh-o-c-1");
  await events.ending("dh-o-c-1-1", "dh-o-c-1");
  await events.ending("dh-o-c-1-1", "dh-o-c-1");
  const ends = (await events.read()).filter(({ event }) => event.run === "dh-o-c-1-1");
  assert.deepEqual(
    ends.map(({ event }) => [event.type, event.exitCode ?? null]),
    [
      ["started", null],
      ["ended", 137],
    ],
  );
});

test("the egress policy's questions fall back on the runner's last answer while it is away, and say it is away without one", async (t) => {
  const store = fileStore();
  const backend = host();
  const a = await copy(t, { store, backend });
  const { runner } = client(a.url, { policyWaitMs: 30 });
  await runner.start(SPEC);
  const at = await runner.locate("10.1.0.2");
  assert.deepEqual(at, { sandbox: "id-dh-o-a-1-1", name: "dh-o-a-1" });
  assert.deepEqual(await runner.proxyAddresses({ fresh: true }), ["10.0.0.3"]);
  await a.service.stop({ graceMs: 100 });
  assert.deepEqual(await runner.locate("10.1.0.2"), at);
  assert.deepEqual(await runner.proxyAddresses({ fresh: true }), ["10.0.0.3"]);
  // An address it has no answer for: unknown, not "no sandbox there" (#936).
  await assert.rejects(runner.locate("10.1.0.99"), RunnerAway);
  assert.equal(await runner.installing("dh-o-a-1"), null);
});

test("the egress policy's questions while the runner is away: one answer's lookups within one wait (#936)", async (t) => {
  const backend = host();
  const a = await copy(t, { store: fileStore(), backend });
  // The client's own clock, which its pauses move on: the runner refuses at once once stopped.
  let clock = 0;
  const { runner } = client(a.url, {
    now: () => clock,
    sleep: async (ms) => (clock += ms),
    policyWaitMs: 3000,
  });
  await runner.start(SPEC);
  const at = await runner.locate("10.1.0.2");
  assert.deepEqual(await runner.proxyAddresses(), ["10.0.0.3"]);
  await a.service.stop({ graceMs: 100 });
  // An answer of the egress policy, past the proxy's addresses' second: they, then the caller.
  for (const [i, skip] of [2000, 1500, 5000].entries()) {
    clock += skip;
    const asked = clock;
    assert.deepEqual(await runner.proxyAddresses(), ["10.0.0.3"]);
    assert.deepEqual(await runner.locate("10.1.0.2"), at);
    // An address with no last answer, in the same answer: away, at once.
    await assert.rejects(runner.locate("10.1.0.99"), RunnerAway);
    assert.equal(await runner.installing("dh-o-a-1"), null);
    // Within one wait, below the proxy's 5 s for the whole answer.
    assert.ok(clock - asked <= 3000, `question ${i}: ${clock - asked} ms`);
  }
});

// Two copies on two nodes: each its own client of one Redis (#509), TEST_REDIS_URL's.
test(
  "handover on Redis: two copies, each its own store client, the logs and starts shared",
  { skip: process.env.TEST_REDIS_URL ? false : "no Redis: set TEST_REDIS_URL" },
  async (t) => {
    const { redisStore } = await import("../lib/store-redis.mjs");
    const prefix = `deckhand-test:${Math.random().toString(36).slice(2)}:`;
    const storeA = redisStore({ url: process.env.TEST_REDIS_URL, prefix });
    const storeB = redisStore({ url: process.env.TEST_REDIS_URL, prefix });
    t.after(() => Promise.all([storeA.close(), storeB.close()]));
    const backend = host();
    const a = await copy(t, { store: storeA, backend });
    const b = await copy(t, { store: storeB, backend });
    const both = client(`${a.url},${b.url}`);
    await both.runner.start(SPEC);
    const file = both.logs.open("dh-o-a-1-1");
    file.write("on a\n");
    await file.flushed();
    await a.service.stop({ graceMs: 1000 });
    await until(() => b.lease.active(), { what: "the other copy's lease" });
    await both.runner.start(SPEC);
    assert.equal(backend.runs(), 1);
    file.write("on b\n");
    await file.flushed();
    assert.equal(await both.logs.text("dh-o-a-1-1"), "on a\non b\n");
  },
);

test("only this deployment's sandboxes and runs' networks: never another container or network of the host", async (t) => {
  const store = fileStore();
  const backend = host();
  const { url } = await copy(t, { store, backend });
  // The operator's database, the egress proxy, the host's bridge network.
  backend.containers.set("db", { running: true, ip: "10.0.0.9" });
  backend.nets.set("bridge", new Set(["db"]));
  const status = async (method, path) =>
    (await call(url, method, path, { sub: "orchestrator" })).status;
  assert.equal(await status("POST", "/sandboxes/db/kill"), 404);
  assert.equal(await status("POST", "/sandboxes/egress-id/kill"), 404);
  assert.equal(await status("DELETE", "/sandboxes/db"), 404);
  assert.equal(await status("GET", "/sandboxes/db/output"), 404);
  assert.deepEqual(
    await (await call(url, "GET", "/sandboxes/db", { sub: "orchestrator" })).json(),
    { state: null },
  );
  // A run that isn't the sandbox's, or a network named as one.
  assert.equal(await status("DELETE", "/sandboxes/dh-o-a-1?run=bridge"), 400);
  const bridge = { ...SPEC, run: "bridge" };
  const refused = await call(url, "POST", "/sandboxes", { sub: "orchestrator", body: bridge });
  assert.equal(refused.status, 403);
  assert.match((await refused.json()).message, /its run bridge isn't one of dh-o-a-1's/);
  assert.ok(backend.containers.get("db").running);
  assert.deepEqual([...backend.nets.get("bridge")], ["db"]);
  assert.ok(!backend.calls.some((c) => ["stop", "rm", "logs"].includes(c.args[0])));
  // No sandbox of that name: its run's inbox only, never a container, an engine or a volume
  // of the host's named after it, nor an end for a run the runner never started.
  backend.containers.set("myapp-engine", { running: true, ip: "10.0.0.10" });
  backend.volumes.set("myapp-1-engine", {});
  assert.equal(await status("DELETE", "/sandboxes/myapp?run=myapp-1"), 200);
  assert.ok(backend.containers.has("myapp-engine"));
  assert.ok(backend.volumes.has("myapp-1-engine"));
  assert.deepEqual(
    (await client(url).events.read()).filter(({ event }) => event.run === "myapp-1"),
    [],
  );
  // Its own, once started, as before; another run of its task, refused.
  await client(url).runner.start(SPEC);
  assert.equal(await status("DELETE", "/sandboxes/dh-o-a-1?run=dh-o-a-1-2"), 409);
  assert.equal(await status("POST", "/sandboxes/dh-o-a-1/kill"), 200);
  assert.equal(await status("DELETE", "/sandboxes/dh-o-a-1?run=dh-o-a-1-1"), 200);
});

test("a chat's session volumes: removed for a chat's key and sandbox only, once its sandbox is gone (#476)", async (t) => {
  const store = fileStore();
  const backend = host();
  const { url } = await copy(t, { store, backend });
  const key = "o/a#chat-0123456789abcdef";
  const name = chatSandbox(config, key);
  assert.equal(name, sandboxName(config, "o/a", "chat-0123456789abcdef"));
  // Not a chat's: an issue's key, an id that isn't 16 hex digits.
  assert.equal(chatSandbox(config, "o/a#1"), null);
  assert.equal(chatSandbox(config, "o/a#chat-12"), null);
  assert.equal(chatSandbox(config, "o/a#chat-0123456789abcdef/x"), null);
  const issue = sandboxName(config, "o/a", "1");
  const other = chatSandbox(config, "o/a#chat-fedcba9876543210");
  for (const volume of [
    `${name}-light-workspace`,
    `${name}-light-claude`,
    `${name}-light-trusted-codex`,
    `${issue}-workspace`,
    `${issue}-light-workspace`,
    `${other}-light-workspace`,
  ]) {
    backend.volumes.set(volume, {});
  }
  const remove = (n, task) =>
    call(url, "DELETE", `/sessions/${n}?task=${encodeURIComponent(task)}`, {
      sub: "orchestrator",
    });
  // An issue's sessions, or a name that isn't the key's chat's: refused.
  assert.equal((await remove(issue, "o/a#1")).status, 400);
  assert.equal((await remove(issue, key)).status, 400);
  assert.equal((await remove(other, key)).status, 400);
  // Its sandbox still there: refused.
  backend.containers.set(name, { running: false, ip: "10.0.0.11" });
  assert.equal((await remove(name, key)).status, 409);
  backend.containers.delete(name);
  const done = await remove(name, key);
  assert.equal(done.status, 200);
  assert.deepEqual((await done.json()).removed.sort(), [
    `${name}-light-claude`,
    `${name}-light-trusted-codex`,
    `${name}-light-workspace`,
  ]);
  // The deployment's marker of its prefix stays too (#858).
  assert.deepEqual(
    [...backend.volumes.keys()].sort(),
    [
      `${issue}-light-workspace`,
      `${issue}-workspace`,
      `${other}-light-workspace`,
      markerName(config.prefix),
    ].sort(),
  );
  // Only the orchestrator asks it.
  const models = await call(url, "DELETE", `/sessions/${name}?task=${encodeURIComponent(key)}`, {
    sub: "models",
  });
  assert.equal(models.status, 403);
});

// Two copies during a handover (a lease that expired on a stalled one), both reading the log's
// size before either appends: the same chunk, sent to each, lands once.
test("logs: the same append through two copies at once is written once", async () => {
  const store = fileStore();
  let readers = 0;
  let release;
  const both = new Promise((resolve) => (release = resolve));
  const shared = {
    ...store,
    blobSize: async (key) => {
      const size = await store.blobSize(key);
      if (++readers === 2) release();
      await both;
      return size;
    },
  };
  const [a, b] = [createLogs({ store: shared }), createLogs({ store: shared })];
  const id = "dh-a-1000";
  const data = Buffer.from("one line\n");
  assert.deepEqual(await Promise.all([a.append(id, 0, data), b.append(id, 0, data)]), [9, 9]);
  assert.equal((await store.readBlob(`logs/${id}/0`)).toString(), "one line\n");
});

// The orchestrator marks a phase's first line (a step of the run) and the run's end: the
// runner's segments close there (logs.mjs), and the log reads back whole.
test("a run's log through the client: a step starts a segment, the run's end closes the last", async (t) => {
  const store = fileStore();
  const a = await copy(t, { store, backend: host() });
  const { logs } = client(a.url);
  const id = "dh-o-a-1-1";
  const file = logs.open(id);
  file.write("setup\n");
  file.write("more setup\n");
  file.write('{"phase":"work"}\n', { step: true });
  file.write("work\n");
  file.close();
  assert.equal(await file.flushed(), true);
  assert.deepEqual(await store.get(`logs/${id}/index`), {
    segments: [
      { at: 0, size: 17, where: "store" },
      { at: 17, size: 22, where: "store" },
    ],
    open: 39,
  });
  assert.equal(await logs.text(id), 'setup\nmore setup\n{"phase":"work"}\nwork\n');
  // A read answers from one segment only: the dashboard goes on from where it ends.
  assert.equal((await logs.read(id, { offset: 11 })).data.toString(), "setup\n");
  assert.equal(await logs.remove(id), true);
  assert.equal(await store.get(`logs/${id}/index`), null);
  assert.equal(await store.blobSize(`logs/${id}/0`), null);
});

// A run's end the orchestrator never sent (#664): a run's sandbox removed with its last segment
// open.
test("a log's last segment closes when its sandbox goes", async (t) => {
  const store = fileStore();
  const a = await copy(t, { store, backend: host() });
  const { logs, runner } = client(a.url);
  const index = (id) => store.get(`logs/${id}/index`);
  // An orchestrator stopped before its close went: the sandbox's removal closes it.
  await runner.start(SPEC);
  const run = logs.open(SPEC.run);
  run.write("work\n");
  assert.equal(await run.flushed(), true);
  assert.equal(await index(SPEC.run), null);
  await runner.remove(SPEC.name, SPEC.run);
  assert.deepEqual(await index(SPEC.run), {
    segments: [{ at: 0, size: 5, where: "store" }],
    open: 5,
  });
  // The close that comes after it closes nothing more; a note after it opens a segment of its own.
  run.close();
  run.write("a note\n");
  run.close();
  assert.equal(await run.flushed(), true);
  assert.deepEqual((await index(SPEC.run)).segments.at(-1), { at: 5, size: 7, where: "store" });
  assert.equal(await logs.text(SPEC.run), "work\na note\n");
});

// An update stops a copy: its lease goes once its calls are done, so the other copy acts at once.
test("stop: the lease goes once the calls are done", async (t) => {
  const store = fileStore();
  const backend = host();
  const a = await copy(t, { store, backend });
  const b = await copy(t, { store, backend });
  assert.equal(await a.service.stop({ graceMs: 5000 }), true);
  await until(() => b.lease.active(), { what: "the other copy's lease" });
});

// A push between the Dockerfile's lookup and the download of the files: planned again, once.
test("a build whose Dockerfile moved in between is planned again once", async (t) => {
  let looked = 0;
  let tries = 0;
  const { url } = await copy(t, {
    store: fileStore(),
    backend: host(),
    blobOf: async () => `blob-${++looked}`,
    imageFor: async (plan) => {
      tries++;
      if (plan.blob === "blob-1") {
        throw Object.assign(new Error("not the Dockerfile its tag names"), {
          code: "DOCKERFILE_MOVED",
        });
      }
      return "dh-repo-org-repo:abc";
    },
  });
  const build = { repo: "org/repo", ref: "main", dockerfile: "Dockerfile" };
  const res = await call(url, "POST", "/images", { sub: "orchestrator", body: build });
  const lines = (await res.text())
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  assert.deepEqual(lines.at(-1), { type: "done", value: "dh-repo-org-repo:abc" });
  assert.deepEqual([looked, tries], [2, 2]);
});

test("activate: a runner with leased() (Kubernetes': its network probe) is told at each lease taken; Docker's has none", async (t) => {
  const store = fileStore();
  let leases = 0;
  const kube = host();
  kube.runner = { ...kube.runner, leased: () => leases++ };
  const a = await copy(t, { store, backend: kube, ttlMs: 5000 });
  assert.equal(a.lease.active(), true);
  assert.equal(leases, 1);
  // The other copy takes the lease over: told once more.
  const b = await copy(t, { store, backend: kube, ttlMs: 5000 });
  await a.lease.stop();
  await until(() => b.lease.active(), { what: "the handover" });
  assert.equal(leases, 2);
  // Docker's runner: no leased(), and activating is no error.
  const docker = await copy(t, { store: fileStore(), backend: host() });
  assert.equal(docker.lease.active(), true);
  assert.equal(docker.service.activate() instanceof Promise, true);
});

// The runner's metrics (runner/metrics.mjs): its sandboxes by engine from the acting copy alone,
// what a start took, and why one didn't.
test("metrics: the acting copy's sandboxes by engine, starts timed, failed ones by why", async (t) => {
  const store = fileStore();
  const registry = createRegistry();
  const copies = {};
  const active = () => [copies.a, copies.b].find((c) => c?.lease.active());
  const metrics = runnerMetrics(registry, {
    runner: "docker",
    sandboxes: async () => (active() ? active().service.sandboxes() : null),
    active: () => Boolean(active()),
  });
  let failRun = false;
  const backend = host({
    metrics,
    answers: { run: () => failRun && { code: 125, out: "", err: "no such image" } },
  });
  copies.a = await copy(t, { store, backend, metrics, ttlMs: 5000 });
  const runner = client(copies.a.url).runner;
  await runner.start(SPEC);
  // Its start's record, as a start with Sysbox's engine leaves it.
  await store.set(`starts/${SPEC.run}`, {
    state: "started",
    result: { engine: { backend: "sysbox" } },
  });
  const text = await registry.render();
  const has = (body, line) => assert.ok(body.includes(`${line}\n`), line);
  has(text, 'deckhand_sandboxes_running{engine="none"} 0');
  has(text, 'deckhand_sandboxes_running{engine="sysbox"} 1');
  has(text, 'deckhand_sandbox_start_seconds_count{runner="docker"} 1');
  // The waiting copy has none.
  copies.b = await copy(t, { store, backend, ttlMs: 5000 });
  assert.equal(await copies.b.service.sandboxes(), null);

  await assert.rejects(
    runner.start({ ...SPEC, run: "dh-o-a-1-3", limits: { cpus: "64" } }),
    /refuses its spec/,
  );
  failRun = true;
  await assert.rejects(runner.start({ ...SPEC, run: "dh-o-a-1-2" }), /no such image/);
  const after = await registry.render();
  has(after, 'deckhand_sandboxes_failed_to_start_total{reason="refused"} 1');
  has(after, 'deckhand_sandboxes_failed_to_start_total{reason="error"} 1');
  has(after, 'deckhand_sandbox_start_seconds_count{runner="docker"} 1');
});
