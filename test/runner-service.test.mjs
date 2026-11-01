// The runner service (runner/service.mjs) and its client (runner/client.mjs), in process: the
// Docker runner on the in-memory fake docker (helpers.mjs fakeDocker()) behind its API, what each
// caller may call, the orchestrator's fencing epoch, a start asked twice, and two copies on one
// store handing over, on release and on expiry.
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { activePassive } from "../lib/active.mjs";
import { EPOCH_HEADER } from "../lib/service-client.mjs";
import { networkCallers, signServiceToken } from "../lib/service-token.mjs";
import { fileStore } from "../lib/store-file.mjs";
import { keyId } from "../lib/tokens.mjs";
import { createDockerRunner } from "../listener/runner/docker.mjs";
import { SANDBOX_USER } from "../listener/sandbox-spec.mjs";
import { createRunnerClient } from "../runner/client.mjs";
import { createEvents } from "../runner/events.mjs";
import { createLogs } from "../runner/logs.mjs";
import { createRunnerService, ROUTES } from "../runner/service.mjs";
import { grantsFrom } from "../listener/grants.mjs";
import { fakeDocker, grantedOf, tempDir } from "./helpers.mjs";

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
  brokerUrl: "http://listener:8081",
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
function host({ lines = ['{"type":"result","result":"Done."}'] } = {}) {
  const calls = [];
  const fake = fakeDocker();
  const docker = async (args, opts = {}) => {
    calls.push({ args, env: opts.env });
    return fake.docker(args);
  };
  const runner = createDockerRunner({
    config,
    docker,
    spawn: logsSpawn(lines),
    inboxDir: tempDir(null, "deckhand-runs-"),
  });
  const runs = () => calls.filter((c) => c.args[0] === "run").length;
  return { ...fake, calls, runner, runs };
}

// One copy of the runner service, listening; its lease on `store` (shared by the copies).
// `bound`: its callers' networks; `brokerTokens`: what the broker gives a run being started.
// The grants folder, and what the operator's policies grant: org/repo may build its Dockerfile.
const grants = () => grantsFrom({ "org/repo.yaml": "hosts: [pypi.org]\n" }, config);
const granted = grantedOf(["dockerfile"], "org/repo");

async function copy(
  t,
  { store, backend, ttlMs = 400, bound, brokerTokens, imageFor, blobOf } = {},
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
    config,
    runner: backend.runner,
    images: {
      keepsCaches: true,
      noCaches: null,
      egressFor: async () => null,
      imageFor: imageFor ?? (async (plan) => (built.push(plan), "dh-sandbox")),
      installAgent: async () => {},
      caches: async () => [],
    },
    logs: createLogs({ store }),
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
    granted,
    blobOf:
      blobOf ?? (async (repo, path, ref) => `blob of ${path} at ${ref ?? "the default branch"}`),
  });
  await new Promise((resolve) => service.server.listen(0, "127.0.0.1", resolve));
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

const until = async (check, what) => {
  for (let i = 0; i < 300; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
};

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
  assert.equal(
    await status("GET", "/runs/dh-o-a-1-1/inbox?from=0", { sub: "orchestrator", epoch: null }),
    404,
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
  await until(() => b.lease.active(), "the other copy's lease");
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
  // Messages in order, the close after them; the inbox read by the broker's poll.
  await runner.send("dh-o-a-1-1", "First", { name: "claude", message: (t) => t });
  runner.send("dh-o-a-1-1", "Second");
  await runner.close("dh-o-a-1-1");
  assert.equal(await runner.closed("dh-o-a-1-1"), true);
  const lines = (await runner.poll("dh-o-a-1-1", 0)).toString().trim().split("\n");
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
  // No inbox: null.
  assert.equal(await runner.poll("dh-o-x-1-1", 0), null);
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
  await until(() => cut < 0 || file.size === 0, "the cut");
  file.write("two\n");
  await until(async () => (await logs.text("dh-o-a-1-1")) === "one\ntwo\n", "the log");
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
  await until(async () => (await logs.text("dh-o-a-1-1")) === "one\ntwo\nthree\n", "the log");
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
  await until(() => b.lease.active(), "the other copy's lease");
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
  await until(async () => (await both.events.read()).length === 2, "the end's event");
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
  await until(() => b.lease.active(), "the lease's expiry");
  assert.ok(b.lease.epoch() > first);
  // The frozen copy took itself out by its own clock: it takes no more calls.
  await until(() => !a.lease.active(), "the first copy's loss");
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

test("the broker's questions fall back on the runner's last answer while it is away", async (t) => {
  const store = fileStore();
  const backend = host();
  const a = await copy(t, { store, backend });
  const { runner } = client(a.url, { brokerWaitMs: 30 });
  await runner.start(SPEC);
  const at = await runner.locate("10.1.0.2");
  assert.deepEqual(at, { sandbox: "id-dh-o-a-1-1", name: "dh-o-a-1" });
  assert.deepEqual(await runner.proxyAddresses({ fresh: true }), ["10.0.0.3"]);
  await a.service.stop({ graceMs: 100 });
  assert.deepEqual(await runner.locate("10.1.0.2"), at);
  assert.deepEqual(await runner.proxyAddresses({ fresh: true }), ["10.0.0.3"]);
  assert.equal(await runner.locate("10.1.0.99"), null);
  assert.equal(await runner.installing("dh-o-a-1"), null);
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
    await until(() => b.lease.active(), "the other copy's lease");
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
  assert.equal((await store.readBlob(`logs/${id}`)).toString(), "one line\n");
});

// An update stops a copy: its lease goes once its calls are done, so the other copy acts at once.
test("stop: the lease goes once the calls are done", async (t) => {
  const store = fileStore();
  const backend = host();
  const a = await copy(t, { store, backend });
  const b = await copy(t, { store, backend });
  assert.equal(await a.service.stop({ graceMs: 5000 }), true);
  await until(() => b.lease.active(), "the other copy's lease");
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
