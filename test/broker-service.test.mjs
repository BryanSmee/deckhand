// The broker service (../broker/, #505): the runs' tokens, signed and renewed with a key only it
// holds, the live runs and their files in its store, and the calls it takes from each caller.
// Two copies on one store are two servers here, on the same memory store: what one of them
// does, the other sees.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Agent, request } from "node:http";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { accountCallers, createCallers } from "../broker/callers.mjs";
import { createFiles, wholeLines } from "../broker/files.mjs";
import { SHOT_PART } from "../broker/http.mjs";
import { ANSWER_WAIT_MS, createPermissions, REQUESTS_MAX } from "../broker/permissions.mjs";
import { RECORD_TTL_MS, RENEW_GRACE_MS } from "../broker/runs.mjs";
import { createBroker } from "../broker/server.mjs";
import { createSeal } from "../broker/seal.mjs";
import { openBlobs } from "../lib/blobs.mjs";
import { createRegistry } from "../lib/metrics.mjs";
import { MAX_SHOT, MAX_SHOTS } from "../lib/shots.mjs";
import { openStore } from "../lib/store.mjs";
import { SERVICE_TOKEN_TTL_MS } from "../lib/service-token.mjs";
import { TOKEN_VERSION, verifyToken } from "../lib/tokens.mjs";
import { assertHealth, resetsUnread, samplesOf, tempDir, testKey } from "./helpers.mjs";

// Each caller reaches the broker at an address of its own, as over a network of its own with
// Docker: the broker's address a call arrives at tells it apart (SERVICE_NETWORKS).
const AT = {
  orchestrator: "127.0.0.2",
  proxy: "127.0.0.3",
  edge: "127.0.0.4",
  shared: "127.0.0.5",
  // The runner, on the network it shares (below): it says which service it is.
  runner: "127.0.0.5",
};
// Services may share one network (here the runner and the models service, at `shared`).
const NETWORKS =
  "orchestrator=127.0.0.2/32,proxy=127.0.0.3/32,edge=127.0.0.4/32,runner+models=127.0.0.5/32";
const FOLDER = "0123456789abcdef01234567";
const PNG = Buffer.from("89504e470d0a1a0a", "hex");

// `copies` brokers on one store, listening on every loopback address, closed after `t`.
// `blobs(store)`: their blob storage (lib/blobs.mjs; the store's own blobs by default).
async function brokers(
  t,
  {
    copies = 1,
    clock = { now: 1_900_000_000_000 },
    key = testKey(),
    blobs = () => undefined,
    registry = null,
  } = {},
) {
  const store = openStore("memory:", { now: () => clock.now });
  const callers = createCallers({ networks: NETWORKS });
  const started = [];
  for (let i = 0; i < copies; i++) {
    const broker = createBroker({
      store,
      blobs: blobs(store),
      key,
      callers,
      now: () => clock.now,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 20))),
      registry,
    });
    await new Promise((resolve) => broker.server.listen(0, "0.0.0.0", resolve));
    broker.server.unref();
    t.after(() => broker.server.close());
    broker.port = broker.server.address().port;
    started.push(broker);
  }
  return { copies: started, store, clock, key };
}

// A call to a broker from `as` (a service's address), bypassing any HTTP_PROXY of the
// environment: → { status, text, json }.
function call(broker, as, method, path, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    const req = request(
      {
        host: AT[as] ?? as,
        port: broker.port,
        method,
        path,
        agent: new Agent(),
        headers: { ...(data && { "content-length": data.length }), ...headers },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            // Not JSON.
          }
          const body = Buffer.concat(chunks);
          resolve({ status: res.statusCode, headers: res.headers, text, json, body });
        });
      },
    );
    req.on("error", reject);
    req.end(data);
  });
}

// `as`'s service token for the broker, asked for as a service asks.
async function tokenOf(broker, as) {
  const res = await call(broker, as, "POST", "/service-tokens", {
    body: { audiences: ["broker"], ...(as === "runner" && { service: "runner" }) },
  });
  assert.equal(res.status, 200, res.text);
  return res.json.tokens.broker;
}

// A client of the broker for `as`: (method, path, options) → call() with its service token,
// asked for each time (the tests' clock moves past a token's life). The orchestrator's carry
// its fencing epoch (`epoch`).
async function client(broker, as, { epoch = 1 } = {}) {
  return async (method, path, { headers = {}, ...rest } = {}) => {
    const token = await tokenOf(broker, as);
    return call(broker, as, method, path, {
      ...rest,
      headers: {
        authorization: `Bearer ${token}`,
        ...(as === "orchestrator" && epoch != null && { "x-deckhand-epoch": String(epoch) }),
        ...headers,
      },
    });
  };
}

// The proxy's call for a sandbox on `sandbox` holding `token`.
const sandboxCall = (proxy, method, path, token, sandbox, options = {}) =>
  proxy(method, path, {
    ...options,
    headers: { "x-deckhand-run-token": token, "x-deckhand-sandbox": sandbox, ...options.headers },
  });

// A run's first tokens, as the orchestrator asks for them.
async function started(orchestrator, id = "run-a", fields = {}) {
  const res = await orchestrator("POST", `/runs/${id}/tokens`, {
    body: { repo: "Org/A", mode: "work", sandbox: "net-a", shots: FOLDER, ...fields },
    headers: { "content-type": "application/json" },
  });
  assert.equal(res.status, 200, res.text);
  return res.json;
}

const renewOn = async (proxy, token, sandbox = "net-a") => {
  const res = await sandboxCall(proxy, "POST", "/run/token", token, sandbox);
  return res.status === 200
    ? { token: res.text.trim() }
    : { status: res.status, message: res.json?.message };
};

test("service tokens: to the service its network proves, for the services it calls only", async (t) => {
  const { copies, key } = await brokers(t);
  const [broker] = copies;
  // From an address that is no caller's: none.
  const stranger = await call(broker, "127.0.0.9", "POST", "/service-tokens", {
    body: { audiences: ["broker"] },
  });
  assert.deepEqual([stranger.status, stranger.json.message], [403, "not from a service"]);
  // Edge calls the broker; it doesn't call the models service.
  const edge = await call(broker, "edge", "POST", "/service-tokens", {
    body: { audiences: ["broker", "models"] },
  });
  assert.equal(edge.status, 403);
  // What the token says: its caller, as its network proved it, whatever it names.
  const token = await tokenOf(broker, "proxy");
  const claims = verifyToken(token, {
    keys: new Map([[key.kid, key.publicKey]]),
    audience: "deckhand:service:broker",
    now: Date.now(),
  });
  assert.equal(claims.sub, "proxy");
  // Naming another service than the one its network proves: none.
  const named = await call(broker, "proxy", "POST", "/service-tokens", {
    body: { audiences: ["broker"], service: "orchestrator" },
  });
  assert.equal(named.status, 403);
  // Two services on one network: each asks as itself, by name, and only as one of them.
  const asked = async (service) =>
    call(broker, "shared", "POST", "/service-tokens", {
      body: { audiences: ["broker"], ...(service && { service }) },
    });
  for (const service of ["runner", "models"]) {
    const res = await asked(service);
    assert.equal(res.status, 200, res.text);
    const { sub } = verifyToken(res.json.tokens.broker, {
      keys: new Map([[key.kid, key.publicKey]]),
      audience: "deckhand:service:broker",
      now: Date.now(),
    });
    assert.equal(sub, service);
  }
  assert.equal((await asked(null)).status, 403);
  assert.equal((await asked("orchestrator")).status, 403);
  // The public keys, for every service checking tokens offline.
  const keys = await call(broker, "edge", "GET", "/keys");
  assert.deepEqual(
    keys.json.service.map((k) => k.kid),
    [key.kid],
  );
});

test("each endpoint takes its callers only, from their own network", async (t) => {
  const { copies } = await brokers(t);
  const [broker] = copies;
  const proxy = await client(broker, "proxy");
  const orchestrator = await client(broker, "orchestrator");
  const edge = await client(broker, "edge");
  // No token: 401. The proxy's token on the orchestrator's endpoints, edge's anywhere: 403.
  assert.equal((await call(broker, "orchestrator", "GET", "/runs")).status, 401);
  assert.equal((await proxy("GET", "/runs")).status, 403);
  assert.equal(
    (await proxy("POST", "/runs/run-a/tokens", { body: { repo: "o/r", sandbox: "x" } })).status,
    403,
  );
  assert.equal((await edge("GET", "/runs")).status, 403);
  assert.equal((await edge("POST", "/run/token")).status, 403);
  // The runner's token copies inboxes and files, never signs a run's tokens: their claims are
  // the orchestrator's (#503).
  const asRunner = await call(broker, "shared", "POST", "/service-tokens", {
    body: { audiences: ["broker"], service: "runner" },
  });
  const runnerToken = asRunner.json.tokens.broker;
  const minted = await call(broker, "shared", "POST", "/runs/run-a/tokens", {
    body: { repo: "o/r", mode: "work", sandbox: "x" },
    headers: { authorization: `Bearer ${runnerToken}`, "content-type": "application/json" },
  });
  assert.equal(minted.status, 403);
  assert.equal((await orchestrator("GET", "/runs")).status, 200);
  // The inboxes and files are the runner's to copy, never the orchestrator's.
  const write = { body: Buffer.from("x\n") };
  assert.equal((await orchestrator("POST", "/runs/run-a/inbox?offset=0", write)).status, 403);
  assert.equal((await orchestrator("PUT", "/runs/run-a/files/ca", write)).status, 403);
  // A token replayed from another caller's network.
  const stolen = await tokenOf(broker, "proxy");
  const replayed = await call(broker, "orchestrator", "GET", "/runs", {
    headers: { authorization: `Bearer ${stolen}` },
  });
  assert.equal(replayed.status, 403);
  // An endpoint in no table: refused to everyone.
  assert.equal((await orchestrator("GET", "/nothing")).status, 403);
  // Health and readiness, for probes: no token.
  const health = await call(broker, "127.0.0.1", "GET", "/health");
  assert.equal(health.status, 200);
  assertHealth(health.json);
  assert.equal((await call(broker, "127.0.0.1", "GET", "/ready")).status, 200);
  broker.server.startDraining();
  assert.equal((await call(broker, "127.0.0.1", "GET", "/ready")).status, 503);
});

test("a run's tokens renew through the proxy, from its own sandbox, every 5 minutes for an hour", async (t) => {
  const { copies, clock } = await brokers(t);
  const [broker] = copies;
  const orchestrator = await client(broker, "orchestrator");
  const proxy = await client(broker, "proxy");
  const { token: first, agentToken } = await started(orchestrator);
  const claims = JSON.parse(Buffer.from(first.split(".")[1], "base64url"));
  assert.deepEqual(
    { ...claims, iat: 0, exp: 0 },
    {
      ver: TOKEN_VERSION,
      jti: "run-a",
      repo: "org/a",
      mode: "work",
      issue: null,
      fork: false,
      branches: [],
      sandbox: "net-a",
      caps: [],
      aud: "deckhand:broker",
      iat: 0,
      exp: 0,
    },
  );
  assert.equal(
    JSON.parse(Buffer.from(agentToken.split(".")[1], "base64url")).aud,
    "deckhand:agents",
  );
  let token = first;
  for (let minute = 5; minute <= 60; minute += 5) {
    clock.now += 5 * 60_000;
    const renewed = await renewOn(proxy, token);
    assert.ok(renewed.token, `renewed at ${minute} minutes: ${renewed.message}`);
    token = renewed.token;
  }
  // The first one expired long ago, and isn't the one the sandbox holds: dead.
  assert.match((await renewOn(proxy, first)).message, /expired/);
  // Never from another sandbox; never the agent's token; never a secret.
  assert.equal((await renewOn(proxy, token, "net-b")).status, 403);
  assert.equal((await renewOn(proxy, token, "")).status, 403);
  assert.equal((await renewOn(proxy, agentToken)).status, 401);
  assert.equal((await renewOn(proxy, "a-secret")).status, 401);
  // Ended: nothing renews.
  assert.deepEqual((await orchestrator("DELETE", "/runs/run-a")).json, { ended: true });
  assert.deepEqual(await renewOn(proxy, token), {
    status: 401,
    message: "unknown or finished run",
  });
});

test("two copies on one store: a run ended on one renews on neither, an inbox read goes on from the same offset", async (t) => {
  const { copies } = await brokers(t, { copies: 2 });
  const [one, two] = copies;
  const orchestratorOne = await client(one, "orchestrator");
  const orchestratorTwo = await client(two, "orchestrator");
  const proxyOne = await client(one, "proxy");
  const proxyTwo = await client(two, "proxy");
  const runnerOne = await client(one, "runner");
  const runnerTwo = await client(two, "runner");
  const { token } = await started(orchestratorOne);
  // Either copy renews it, the other one's token too.
  const renewed = await renewOn(proxyTwo, token);
  assert.ok(renewed.token);
  // The inbox: appended through one, read from either, each line once.
  const append = (runner, offset, text) =>
    runner("POST", `/runs/run-a/inbox?offset=${offset}`, { body: Buffer.from(text) });
  assert.deepEqual((await append(runnerOne, 0, "one\n")).json, { length: 4 });
  const read = (proxy, from) =>
    sandboxCall(proxy, "GET", `/run/inbox?from=${from}`, token, "net-a");
  const first = await read(proxyOne, 0);
  assert.deepEqual([first.status, first.text], [200, "one\n"]);
  // A long poll on the other copy, woken by a line appended through the first.
  const waiting = read(proxyTwo, 4);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual((await append(runnerOne, 0, "one\ntwo\n")).json, { length: 8 });
  const second = await waiting;
  assert.deepEqual([second.status, second.text], [200, "two\n"]);
  // The same bytes sent again add nothing; a gap is said, for the runner to send from there.
  assert.deepEqual((await append(runnerTwo, 4, "two\n")).json, { length: 8 });
  const gap = await append(runnerTwo, 20, "late\n");
  assert.deepEqual([gap.status, gap.json], [409, { length: 8, gap: true }]);
  // Ended through the second copy: the first renews it no more, nor serves its inbox.
  await orchestratorTwo("DELETE", "/runs/run-a");
  assert.equal((await renewOn(proxyOne, renewed.token)).status, 401);
  assert.equal((await read(proxyOne, 0)).status, 401);
});

test("the inbox: whole lines only, a bad offset refused, a run without one 404", async (t) => {
  const { copies } = await brokers(t);
  const [broker] = copies;
  const orchestrator = await client(broker, "orchestrator");
  const proxy = await client(broker, "proxy");
  const { token } = await started(orchestrator);
  const runner = await client(broker, "runner");
  const read = (from) => sandboxCall(proxy, "GET", `/run/inbox?from=${from}`, token, "net-a");
  assert.equal((await read(0)).status, 404);
  await runner("POST", "/runs/run-a/inbox?offset=0", { body: Buffer.from("a\nhalf") });
  assert.equal((await read(0)).text, "a\n");
  assert.equal((await read("x")).status, 400);
  assert.equal((await read(-1)).status, 400);
  // A line over the most one read answers comes alone; whole lines up to it otherwise.
  assert.equal(wholeLines(Buffer.from("a\nb\nc")).toString(), "a\nb\n");
  const long = Buffer.from(`${"x".repeat(2 * 1024 * 1024)}\nnext\n`);
  assert.equal(wholeLines(long).length, 2 * 1024 * 1024 + 1);
});

test("the CA and digest: the run's own, put before its sandbox starts", async (t) => {
  const { copies } = await brokers(t);
  const [broker] = copies;
  const orchestrator = await client(broker, "orchestrator");
  const proxy = await client(broker, "proxy");
  const a = await started(orchestrator, "run-a");
  const b = await started(orchestrator, "run-b", { sandbox: "net-b" });
  const runner = await client(broker, "runner");
  assert.equal(
    (await runner("PUT", "/runs/run-a/files/ca", { body: Buffer.from("CA") })).status,
    204,
  );
  assert.equal(
    (await runner("PUT", "/runs/run-a/files/app.json", { body: Buffer.from("x") })).status,
    404,
  );
  const ca = await sandboxCall(proxy, "GET", "/run/ca", a.token, "net-a");
  assert.deepEqual([ca.status, ca.text], [200, "CA"]);
  assert.equal((await sandboxCall(proxy, "GET", "/run/digest", a.token, "net-a")).status, 404);
  // Another run's sandbox gets its own run's, which has none; a's token from b's network nothing.
  assert.equal((await sandboxCall(proxy, "GET", "/run/ca", b.token, "net-b")).status, 404);
  assert.equal((await sandboxCall(proxy, "GET", "/run/ca", a.token, "net-b")).status, 403);
  assert.equal((await sandboxCall(proxy, "GET", "/run/ca", "", "net-a")).status, 401);
});

test("screenshots: into the run's folder, images only, capped, said on the stream, served to edge", async (t) => {
  const { copies, store } = await brokers(t);
  const [broker] = copies;
  const orchestrator = await client(broker, "orchestrator");
  const proxy = await client(broker, "proxy");
  const edge = await client(broker, "edge");
  const { token } = await started(orchestrator);
  const put = (name, body) =>
    sandboxCall(proxy, "PUT", `/run/shots/${name}`, token, "net-a", { body });
  const image = Buffer.concat([PNG, Buffer.from("x")]);
  assert.equal((await put("page.png", image)).status, 204);
  assert.equal((await put("page.gif", PNG)).status, 400);
  assert.equal((await put("fake.png", Buffer.from("GIF89a"))).status, 415);
  assert.ok(MAX_SHOTS >= MAX_SHOT);
  // The stream says it to the orchestrator, which copies nothing (#609).
  const { events } = (await orchestrator("GET", "/events")).json;
  assert.deepEqual(
    events.map(({ event }) => ({ ...event, at: 0 })),
    [
      { type: "started", run: "run-a", at: 0 },
      { type: "shot", run: "run-a", folder: FOLDER, name: "page.png", size: PNG.length + 1, at: 0 },
    ],
  );
  // Without BLOB_URL, in the store's own blobs.
  assert.deepEqual(await store.readBlob(`shots/${FOLDER}/page.png`), image);
  // Edge serves it to anyone; the proxy (a sandbox) can't read it back.
  const served = await edge("GET", `/shots/${FOLDER}/page.png`);
  assert.equal(served.status, 200);
  assert.deepEqual(served.body, image);
  assert.equal((await edge("GET", `/shots/${FOLDER}/none.png`)).status, 404);
  assert.equal((await edge("GET", `/shots/${FOLDER}/../app.json`)).status, 400);
  assert.equal((await proxy("GET", `/shots/${FOLDER}/page.png`)).status, 403);
  // Edge only reads: the orchestrator alone moves and removes them.
  assert.equal((await edge("DELETE", `/shots/${FOLDER}`)).status, 403);
  assert.equal((await edge("PUT", `/shots/${FOLDER}/other.png`, { body: PNG })).status, 403);
  // The orchestrator of the release before deletes each one it copied: nothing is deleted now.
  assert.deepEqual((await orchestrator("DELETE", `/shots/${FOLDER}/page.png`)).json, {
    deleted: false,
  });
  // The run's end leaves them: replies link to them.
  assert.equal((await orchestrator("DELETE", "/runs/run-a")).status, 200);
  assert.equal((await edge("GET", `/shots/${FOLDER}/page.png`)).status, 200);
  const acked = await orchestrator("POST", "/events/ack", {
    body: { ids: events.map((e) => e.id) },
  });
  assert.deepEqual(acked.json, { acked: 2 });
  // A run without a folder (research) has none.
  const research = await started(orchestrator, "run-r", { sandbox: "net-r", shots: null });
  const refused = await sandboxCall(proxy, "PUT", "/run/shots/page.png", research.token, "net-r", {
    body: PNG,
  });
  assert.equal(refused.status, 403);
});

// An animated WebP, as img2webp writes one (#1050): RIFF…WEBP, a VP8X header whose animation
// flag is set, the ANIM chunk, then one ANMF frame per step (an empty one is enough here).
function chunk(fourcc, data) {
  const head = Buffer.alloc(8);
  head.write(fourcc, 0, "latin1");
  head.writeUInt32LE(data.length, 4);
  return Buffer.concat([head, data, Buffer.alloc(data.length % 2)]);
}
const ANIMATED_WEBP = (() => {
  const vp8x = Buffer.alloc(10);
  vp8x[0] = 0x02; // animation
  const body = Buffer.concat([
    Buffer.from("WEBP", "latin1"),
    chunk("VP8X", vp8x),
    chunk("ANIM", Buffer.alloc(6)),
    chunk("ANMF", Buffer.alloc(16)),
    chunk("ANMF", Buffer.alloc(16)),
  ]);
  const head = Buffer.alloc(8);
  head.write("RIFF", 0, "latin1");
  head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
})();

test("screenshots: an animated WebP, served to edge as one; a .webp that isn't one refused", async (t) => {
  const { copies } = await brokers(t);
  const [broker] = copies;
  const orchestrator = await client(broker, "orchestrator");
  const proxy = await client(broker, "proxy");
  const edge = await client(broker, "edge");
  const { token } = await started(orchestrator);
  const put = (name, body) =>
    sandboxCall(proxy, "PUT", `/run/shots/${name}`, token, "net-a", { body });
  assert.equal((await put("flow.webp", ANIMATED_WEBP)).status, 204);
  const served = await edge("GET", `/shots/${FOLDER}/flow.webp`);
  assert.deepEqual([served.status, served.headers["content-type"]], [200, "image/webp"]);
  assert.deepEqual(served.body, ANIMATED_WEBP);
  // Another kind of file named .webp: a PNG, a GIF, a RIFF that isn't a WebP (a WAV).
  const wav = Buffer.from(ANIMATED_WEBP);
  wav.write("WAVE", 8, "latin1");
  for (const body of [PNG, Buffer.from("GIF89a"), wav]) {
    assert.equal((await put("fake.webp", body)).status, 415, body.subarray(0, 12).toString());
  }
  assert.equal((await edge("GET", `/shots/${FOLDER}/fake.webp`)).status, 404);
});

test("screenshots: in blob storage, sent in parts, those of the release before adopted; removed with their run", async (t) => {
  const dir = tempDir(t);
  const clock = { now: 1_900_000_000_000 };
  const { copies, store } = await brokers(t, {
    clock,
    blobs: () => openBlobs(pathToFileURL(dir).href),
  });
  const [broker] = copies;
  const orchestrator = await client(broker, "orchestrator", { epoch: 2 });
  const proxy = await client(broker, "proxy");
  const edge = await client(broker, "edge");
  const { token } = await started(orchestrator);
  const image = Buffer.concat([PNG, Buffer.from("new")]);
  const put = await sandboxCall(proxy, "PUT", "/run/shots/page.png", token, "net-a", {
    body: image,
  });
  assert.equal(put.status, 204);
  // Written once into blob storage, not the store.
  const blobs = openBlobs(pathToFileURL(dir).href);
  assert.deepEqual(await blobs.read(`shots/${FOLDER}/page.png`), image);
  assert.equal(await store.readBlob(`shots/${FOLDER}/page.png`), null);
  // Moved here by the orchestrator, which kept one itself (moveShots()): checked as an upload.
  // Longer than a part: sent in parts.
  const moved = Buffer.concat([PNG, Buffer.alloc(SHOT_PART * 2 + 5, 7)]);
  const move = (name, body) => orchestrator("PUT", `/shots/${FOLDER}/${name}`, { body });
  assert.equal((await move("kept.png", moved)).status, 204);
  assert.equal((await move("kept.txt", moved)).status, 400);
  assert.equal((await move("fake.png", Buffer.from("GIF89a"))).status, 415);
  assert.equal((await move("big.png", Buffer.alloc(MAX_SHOT + 1))).status, 413);
  // From a copy that lost the orchestrator's lease (an older epoch): refused, as its other writes.
  const stale = await client(broker, "orchestrator", { epoch: 1 });
  assert.equal((await stale("PUT", `/shots/${FOLDER}/other.png`, { body: moved })).status, 409);
  for (const [name, body] of [
    ["page.png", image],
    ["kept.png", moved],
  ]) {
    const served = await edge("GET", `/shots/${FOLDER}/${name}`);
    assert.deepEqual([served.status, served.headers["content-type"]], [200, "image/png"], name);
    assert.equal(Number(served.headers["content-length"]), body.length, name);
    assert.deepEqual(served.body, body, name);
  }
  // Retention: every one of the folder goes.
  assert.deepEqual((await orchestrator("DELETE", `/shots/${FOLDER}`)).json, { deleted: 2 });
  for (const name of ["page.png", "kept.png"]) {
    assert.equal((await edge("GET", `/shots/${FOLDER}/${name}`)).status, 404, name);
  }
  assert.equal(await blobs.read(`shots/${FOLDER}/page.png`), null);
  assert.equal(await store.get(`shots:${FOLDER}`), null);
  assert.deepEqual((await orchestrator("DELETE", `/shots/${FOLDER}`)).json, { deleted: 0 });

  // One uploaded to the broker of the release before, which its orchestrator hadn't copied yet:
  // in the store, its name in a record that expires, as that broker wrote them. Still served.
  const before = "abcdef0123456789abcdef01";
  const legacy = Buffer.concat([PNG, Buffer.from("old")]);
  await store.putBlob(`shot:${before}/before.png`, legacy);
  await store.set(`shots:${before}`, { "before.png": legacy.length }, { ttlMs: RECORD_TTL_MS });
  assert.deepEqual((await edge("GET", `/shots/${before}/before.png`)).body, legacy);
  // Its `shot` event, which the orchestrator reads: adopted, into blob storage, kept for good.
  const adopt = () => orchestrator("POST", `/shots/${before}/before.png`);
  assert.deepEqual((await adopt()).json, { adopted: true });
  assert.deepEqual((await adopt()).json, { adopted: false });
  assert.equal((await edge("POST", `/shots/${before}/before.png`)).status, 403);
  assert.deepEqual(await blobs.read(`shots/${before}/before.png`), legacy);
  assert.equal(await store.readBlob(`shot:${before}/before.png`), null);
  // Past the record's day, retention still finds it.
  clock.now += RECORD_TTL_MS + 1;
  assert.deepEqual((await edge("GET", `/shots/${before}/before.png`)).body, legacy);
  assert.deepEqual((await orchestrator("DELETE", `/shots/${before}`)).json, { deleted: 1 });
  assert.equal(await blobs.read(`shots/${before}/before.png`), null);
});

test("screenshots: one over the cap is refused unread", { skip: resetsUnread }, async (t) => {
  const { copies } = await brokers(t);
  const [broker] = copies;
  const orchestrator = await client(broker, "orchestrator");
  const proxy = await client(broker, "proxy");
  const { token } = await started(orchestrator);
  const big = await sandboxCall(proxy, "PUT", "/run/shots/big.png", token, "net-a", {
    body: Buffer.alloc(MAX_SHOT + 1),
  });
  assert.equal(big.status, 413);
  assert.deepEqual(
    (await orchestrator("GET", "/events")).json.events.map(({ event }) => event.type),
    ["started"],
  );
});

test("screenshots: the run's total is capped", async (t) => {
  const { copies } = await brokers(t);
  const [broker] = copies;
  const orchestrator = await client(broker, "orchestrator");
  const proxy = await client(broker, "proxy");
  const { token } = await started(orchestrator);
  const image = Buffer.concat([PNG, Buffer.alloc(MAX_SHOT - PNG.length)]);
  const count = Math.floor(MAX_SHOTS / MAX_SHOT);
  for (let i = 0; i < count; i++) {
    const res = await sandboxCall(proxy, "PUT", `/run/shots/p${i}.png`, token, "net-a", {
      body: image,
    });
    assert.equal(res.status, 204);
  }
  const over = await sandboxCall(proxy, "PUT", "/run/shots/more.png", token, "net-a", {
    body: PNG,
  });
  assert.equal(over.status, 413);
  // The same name again replaces it, within the cap.
  const again = await sandboxCall(proxy, "PUT", "/run/shots/p0.png", token, "net-a", { body: PNG });
  assert.equal(again.status, 204);
});

test("a token expired while the broker was away still renews, from its sandbox, within the grace", async (t) => {
  const { copies, clock } = await brokers(t);
  const [broker] = copies;
  const orchestrator = await client(broker, "orchestrator");
  const { token } = await started(orchestrator);
  // The broker away for an hour: its token expired. The proxy's own is renewed on its return.
  clock.now += 60 * 60_000;
  const proxy = await client(broker, "proxy");
  const renewed = await renewOn(proxy, token);
  assert.ok(renewed.token);
  assert.equal((await renewOn(proxy, token, "net-b")).status, 403);
  clock.now += RENEW_GRACE_MS;
  assert.match((await renewOn(proxy, token)).message, /expired/);
});

test("a renewal asked again within a minute gets the same token back, sealed in the store meanwhile", async (t) => {
  const { copies, clock, store, key } = await brokers(t);
  const [broker] = copies;
  const orchestrator = await client(broker, "orchestrator");
  const proxy = await client(broker, "proxy");
  const { token } = await started(orchestrator);
  for (let i = 0; i < 5; i++) {
    clock.now += 1000;
    assert.equal((await renewOn(proxy, token)).token, token);
  }
  clock.now += 60_000;
  const next = (await renewOn(proxy, token)).token;
  assert.notEqual(next, token);
  assert.equal((await renewOn(proxy, next)).token, next);
  // The store holds no token in the clear: hashes, and the last one sealed with the broker's key.
  const record = await store.get("run:run-a");
  const text = JSON.stringify(record);
  assert.ok(!text.includes(token) && !text.includes(next));
  assert.ok(record.issued.some((t) => t.hash === createHash("sha256").update(next).digest("hex")));
  assert.equal(createSeal(key.privateKey).open(record.last), next);
  assert.equal(createSeal(testKey().privateKey).open(record.last), null);
});

test("past its expiry, only the token the sandbox holds renews, not an older one left behind", async (t) => {
  const { copies, clock } = await brokers(t);
  const [broker] = copies;
  const orchestrator = await client(broker, "orchestrator");
  const proxy = await client(broker, "proxy");
  const tokens = [(await started(orchestrator)).token];
  for (let i = 0; i < 3; i++) {
    clock.now += 5 * 60_000;
    tokens.push((await renewOn(proxy, tokens.at(-1))).token);
  }
  const [a, b, c, d] = tokens;
  // Half an hour on, the broker away meanwhile: all of them expired. A (still in a process's
  // environment, say) and B: dead. C was presented last, D is the newest: D renews, and C is
  // dead from then on.
  clock.now += 30 * 60_000;
  for (const old of [a, b]) assert.match((await renewOn(proxy, old)).message, /expired/);
  assert.ok((await renewOn(proxy, d)).token);
  assert.match((await renewOn(proxy, c)).message, /expired/);
});

test("the live runs: the orchestrator's list, what it ended gone, a restored run's tokens kept", async (t) => {
  const { copies } = await brokers(t);
  const [broker] = copies;
  const orchestrator = await client(broker, "orchestrator");
  const proxy = await client(broker, "proxy");
  const { token } = await started(orchestrator, "run-a");
  await started(orchestrator, "run-b", { sandbox: "net-b" });
  assert.deepEqual((await orchestrator("GET", "/runs")).json.runs.sort(), ["run-a", "run-b"]);
  // A restarted listener says run-a still goes, without what it doesn't know: its binding stays.
  await orchestrator("PUT", "/runs/run-a", {
    body: { repo: "org/a", mode: "work", sandbox: null },
  });
  assert.ok((await renewOn(proxy, token)).token);
  await orchestrator("DELETE", "/runs/run-b");
  assert.deepEqual((await orchestrator("GET", "/runs")).json.runs, ["run-a"]);
  assert.deepEqual((await orchestrator("DELETE", "/runs/run-b")).json, { ended: false });
  // A first token needs a sandbox to bind it to.
  const unbound = await orchestrator("POST", "/runs/run-c/tokens", { body: { repo: "org/a" } });
  assert.equal(unbound.status, 400);
});

test("on Kubernetes, the pod's service account names the caller, once the API server reviewed its token", async () => {
  assert.deepEqual(
    [
      ...accountCallers(
        "orchestrator=deckhand:deckhand-orchestrator, proxy=deckhand:deckhand-egress",
      ),
    ],
    [
      ["system:serviceaccount:deckhand:deckhand-orchestrator", ["orchestrator"]],
      ["system:serviceaccount:deckhand:deckhand-egress", ["proxy"]],
    ],
  );
  assert.throws(() => accountCallers("sandbox=deckhand:x"), /SERVICE_ACCOUNTS/);
  assert.throws(() => accountCallers("proxy=deckhand"), /SERVICE_ACCOUNTS/);
  const reviewed = [];
  const callers = createCallers({
    accounts: "orchestrator=deckhand:deckhand-orchestrator",
    review: async (token) => {
      reviewed.push(token);
      return token === "good" ? "system:serviceaccount:deckhand:deckhand-orchestrator" : null;
    },
  });
  assert.equal(callers.bound, null);
  const req = (token) => ({ headers: token ? { "x-deckhand-pod-token": token } : {}, socket: {} });
  assert.equal(await callers.callerOf(req("good")), "orchestrator");
  assert.equal(await callers.callerOf(req("bad")), null);
  assert.equal(await callers.callerOf(req(null)), null);
  assert.deepEqual(reviewed, ["good", "bad"]);
  // Neither proof set: the broker doesn't start.
  assert.throws(() => createCallers({}), /SERVICE_NETWORKS .* or SERVICE_ACCOUNTS/);
});

test("services that share a network or an account: each asks as itself among them, never as another", async () => {
  const shared = createCallers({
    accounts: "edge+orchestrator+models=deckhand:deckhand-control,runner=deckhand:deckhand-runner",
    review: async (token) => `system:serviceaccount:deckhand:${token}`,
  });
  const req = (token) => ({ headers: { "x-deckhand-pod-token": token }, socket: {} });
  assert.equal(await shared.callerOf(req("deckhand-control"), "edge"), "edge");
  assert.equal(await shared.callerOf(req("deckhand-control"), "models"), "models");
  // More than one it may be: it has to say which; one it may not be, never.
  assert.equal(await shared.callerOf(req("deckhand-control")), null);
  assert.equal(await shared.callerOf(req("deckhand-control"), "runner"), null);
  assert.equal(await shared.callerOf(req("deckhand-control"), "broker"), null);
  // The one it is: with its name or without.
  assert.equal(await shared.callerOf(req("deckhand-runner")), "runner");
  assert.equal(await shared.callerOf(req("deckhand-runner"), "runner"), "runner");
  assert.equal(await shared.callerOf(req("deckhand-runner"), "orchestrator"), null);
  assert.throws(() => accountCallers("edge+sandbox=deckhand:x"), /SERVICE_ACCOUNTS/);
  // By network, the same.
  const byNetwork = createCallers({
    networks: "edge+orchestrator=10.231.250.0/28,runner=10.231.250.32/28",
  });
  const at = (localAddress) => ({ headers: {}, socket: { localAddress } });
  assert.equal(await byNetwork.callerOf(at("10.231.250.2"), "edge"), "edge");
  assert.equal(await byNetwork.callerOf(at("10.231.250.2")), null);
  assert.equal(await byNetwork.callerOf(at("10.231.250.34")), "runner");
  assert.equal(await byNetwork.callerOf(at("10.231.250.34"), "edge"), null);
});

test("the inbox: the runner's file byte for byte, a token's shape refused rather than redacted, a failed write sent again whole", async (t) => {
  const { copies, store } = await brokers(t);
  const [broker] = copies;
  const orchestrator = await client(broker, "orchestrator");
  const proxy = await client(broker, "proxy");
  const runner = await client(broker, "runner");
  const { token } = await started(orchestrator);
  // Redacted, the blob would be shorter than the runner's file, and their offsets apart: the
  // runner redacts its lines itself (runner/inbox.mjs), the store refuses what it would change.
  const ghp = `ghp_${"a".repeat(36)}`;
  const refused = await runner("POST", "/runs/run-a/inbox?offset=0", {
    body: Buffer.from(`{"text":"${ghp} is revoked"}\n`),
  });
  assert.equal(refused.status, 500);
  assert.equal(await store.readBlob("inbox:run-a"), null);
  // The runner's lines, the same bytes in the blob and its offsets.
  const lines = ['{"text":"[redacted] is revoked"}\n', '{"text":"next"}\n'];
  let file = Buffer.alloc(0);
  let synced = 0;
  for (const line of lines) {
    file = Buffer.concat([file, Buffer.from(line)]);
    const res = await runner("POST", `/runs/run-a/inbox?offset=${synced}`, {
      body: file.subarray(synced),
    });
    assert.deepEqual(res.json, { length: file.length });
    synced = res.json.length;
  }
  assert.deepEqual(await store.readBlob("inbox:run-a"), file);
  const read = await sandboxCall(proxy, "GET", "/run/inbox?from=0", token, "net-a");
  assert.deepEqual(read.body, file);
});

test("the inbox: a write the store failed leaves nothing behind, and the same one sent again goes in", async () => {
  const inner = openStore("memory:");
  let failing = true;
  const store = {
    ...inner,
    appendBlobAt: async (...args) => {
      if (failing) {
        failing = false;
        throw new Error("Redis timed out");
      }
      return inner.appendBlobAt(...args);
    },
  };
  const files = createFiles({ store, runs: { event: async () => {} } });
  const line = Buffer.from('{"text":"hi"}\n');
  await assert.rejects(files.appendInbox("r1", 0, line), /timed out/);
  assert.equal(await inner.readBlob("inbox:r1"), null);
  assert.deepEqual(await files.appendInbox("r1", 0, line), { length: line.length });
  assert.deepEqual(await inner.readBlob("inbox:r1"), line);
  // A later write that comes first is refused, then the earlier one, then the later again.
  const next = Buffer.from('{"text":"later"}\n');
  const gap = await files.appendInbox("r1", line.length + next.length, next);
  assert.equal(gap.gap, true);
  assert.deepEqual(await files.appendInbox("r1", line.length, next), {
    length: line.length + next.length,
  });
});

test("an expired run's files go with its record", async (t) => {
  const { copies, clock, store } = await brokers(t);
  const [broker] = copies;
  const orchestrator = await client(broker, "orchestrator");
  const runner = await client(broker, "runner");
  await started(orchestrator, "run-a");
  await runner("POST", "/runs/run-a/inbox?offset=0", { body: Buffer.from("x\n") });
  await runner("PUT", "/runs/run-a/files/ca", { body: Buffer.from("CA") });
  // Its end never came: the record expires, and the next listing drops its files.
  clock.now += 9 * 24 * 60 * 60_000;
  assert.deepEqual((await orchestrator("GET", "/runs")).json.runs, []);
  assert.equal(await store.readBlob("inbox:run-a"), null);
  assert.equal(await store.readBlob("file:run-a:ca"), null);
});

test("the orchestrator's fencing epoch: none or a stale one changes nothing, on either copy (#506)", async (t) => {
  const { copies, clock } = await brokers(t, { copies: 2 });
  const [one, two] = copies;
  const now = clock.now;
  // The copy that holds the lease now, and the one that lost it without noticing.
  const current = await client(one, "orchestrator", { epoch: now });
  const stale = await client(two, "orchestrator", { epoch: now - 1000 });
  const unfenced = await client(two, "orchestrator", { epoch: null });
  await started(current);
  assert.equal((await started(stale, "run-b").catch((error) => error)).actual, 409);
  assert.equal((await stale("DELETE", "/runs/run-a")).status, 409);
  assert.equal((await unfenced("DELETE", "/runs/run-a")).status, 400);
  // Reads aren't fenced: a stale copy still sees the run, which goes on.
  const listed = await stale("GET", "/runs");
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.json.runs, ["run-a"]);
  assert.deepEqual((await current("DELETE", "/runs/run-a")).json, { ended: true });
});

test("a live run's tokens: to the orchestrator alone, renewed ones included, on either copy, sealed in the store (#617)", async (t) => {
  const { copies, clock, store } = await brokers(t, { copies: 2 });
  const [one, two] = copies;
  const orchestrator = await client(one, "orchestrator", { epoch: clock.now });
  const proxy = await client(one, "proxy");
  const { token, agentToken } = await started(orchestrator);
  clock.now += 5 * 60_000;
  const renewed = (await renewOn(proxy, token)).token;
  // The next copy of the orchestrator, through the other copy of the broker: both, the newest last.
  const next = await client(two, "orchestrator", { epoch: clock.now });
  const answer = await next("POST", "/runs/run-a/secrets");
  assert.equal(answer.status, 200, answer.text);
  assert.deepEqual(answer.json, { agentToken, tokens: [token, renewed] });
  assert.equal(answer.headers["cache-control"], "no-store");
  // Nobody else's: not the runner's, the proxy's, edge's, nor a copy that lost its lease.
  const runner = await call(two, "shared", "POST", "/service-tokens", {
    body: { audiences: ["broker"], service: "runner" },
  });
  const asRunner = await call(two, "shared", "POST", "/runs/run-a/secrets", {
    headers: { authorization: `Bearer ${runner.json.tokens.broker}` },
  });
  assert.equal(asRunner.status, 403);
  assert.equal((await proxy("POST", "/runs/run-a/secrets")).status, 403);
  assert.equal((await (await client(two, "edge"))("POST", "/runs/run-a/secrets")).status, 403);
  assert.equal((await orchestrator("POST", "/runs/run-a/secrets")).status, 409);
  // None of them in the clear in the store: each key read.
  const page = await store.keys("");
  const values = await Promise.all(page.keys.map((k) => store.get(k)));
  const text = JSON.stringify(values);
  for (const secret of [token, renewed, agentToken]) assert.ok(!text.includes(secret));
  // An ended run has none.
  await next("DELETE", "/runs/run-a");
  assert.equal((await next("POST", "/runs/run-a/secrets")).status, 404);
});

test("a run's tokens moved from the orchestrator's files: only those this broker signed for that run kept (#617)", async (t) => {
  const { copies, store } = await brokers(t);
  const other = await brokers(t);
  const [broker] = copies;
  const orchestrator = await client(broker, "orchestrator");
  const { token, agentToken } = await started(orchestrator, "run-a");
  const { token: elsewhere } = await started(orchestrator, "run-b", { sandbox: "net-b" });
  const forged = (await started(await client(other.copies[0], "orchestrator"), "run-a")).token;
  // A record of the release before: its last token sealed, no agent token, nothing else sealed.
  const record = await store.get("run:run-a");
  await store.set("run:run-a", {
    ...record,
    agent: undefined,
    issued: record.issued.map(({ sealed: _, ...t }) => t),
  });
  assert.deepEqual((await orchestrator("POST", "/runs/run-a/secrets")).json, {
    agentToken: null,
    tokens: [token],
  });
  // The orchestrator moves what its file kept: the run's own tokens only.
  const put = await orchestrator("PUT", "/runs/run-a", {
    body: { repo: "org/a", tokens: [agentToken, token, elsewhere, forged, "not-a-token"] },
  });
  assert.equal(put.status, 204, put.text);
  assert.deepEqual((await orchestrator("POST", "/runs/run-a/secrets")).json, {
    agentToken,
    tokens: [token],
  });
});

test("a token presented to a broker that lost the run's record: sealed with the rest, for the orchestrator's next copy (#617)", async (t) => {
  const { copies, clock, store } = await brokers(t);
  const [broker] = copies;
  const orchestrator = await client(broker, "orchestrator");
  const proxy = await client(broker, "proxy");
  const { token } = await started(orchestrator);
  // Lost (its store, say), then told again by the orchestrator, without the token's hash.
  await store.delete("run:run-a");
  await orchestrator("PUT", "/runs/run-a", { body: { repo: "org/a", sandbox: "net-a" } });
  clock.now += 2 * 60_000;
  const renewed = (await renewOn(proxy, token)).token;
  assert.deepEqual((await orchestrator("POST", "/runs/run-a/secrets")).json.tokens, [
    token,
    renewed,
  ]);
});

test("its metrics: the tokens signed, renewed and refused, the live runs, the inbox polls open", async (t) => {
  const registry = createRegistry();
  const { copies, clock } = await brokers(t, { registry });
  const [broker] = copies;
  const orchestrator = await client(broker, "orchestrator");
  const proxy = await client(broker, "proxy");
  const { token } = await started(orchestrator);
  // Asked again within a minute: the same token, signed once.
  const again = await renewOn(proxy, token);
  assert.equal(again.token, token);
  clock.now += 2 * 60_000;
  const renewed = await renewOn(proxy, token);
  assert.notEqual(renewed.token, token);
  // Refused: from another sandbox, not a token, a run that ended.
  assert.equal((await renewOn(proxy, renewed.token, "net-b")).status, 403);
  assert.equal((await renewOn(proxy, "a-secret")).status, 401);
  const read = (from) =>
    sandboxCall(proxy, "GET", `/run/inbox?from=${from}`, renewed.token, "net-a");
  // A service token from no service, and none at all.
  const stranger = await call(broker, "127.0.0.9", "POST", "/service-tokens", {
    body: { audiences: ["broker"] },
  });
  assert.equal(stranger.status, 403);
  assert.equal((await call(broker, "orchestrator", "GET", "/runs")).status, 401);
  // An endpoint the caller may not call; a token from another service's network.
  assert.equal((await proxy("GET", "/runs")).status, 403);
  const proxyToken = await tokenOf(broker, "proxy");
  const replayed = await call(broker, "orchestrator", "GET", "/runs", {
    headers: { authorization: `Bearer ${proxyToken}` },
  });
  assert.equal(replayed.status, 403);

  assert.deepEqual(await samplesOf(registry, "deckhand_runs_live"), { "": 1 });

  // A long poll open while it waits for a line.
  const runner = await client(broker, "runner");
  await runner("POST", "/runs/run-a/inbox?offset=0", { body: Buffer.from("one\n") });
  const waiting = read(4);
  while ((await samplesOf(registry, "deckhand_inbox_polls_open"))[""] !== 1)
    await new Promise((resolve) => setTimeout(resolve, 5));
  await runner("POST", "/runs/run-a/inbox?offset=4", { body: Buffer.from("two\n") });
  assert.equal((await waiting).text, "two\n");
  assert.deepEqual(await samplesOf(registry, "deckhand_inbox_polls_open"), { "": 0 });

  await orchestrator("DELETE", "/runs/run-a");
  assert.equal((await renewOn(proxy, renewed.token)).status, 401);
  assert.equal((await read(0)).status, 401);
  assert.deepEqual(await samplesOf(registry, "deckhand_runs_live"), { "": 0 });
  // Past its renewal's grace: expired, before anything else is read of it.
  clock.now += RENEW_GRACE_MS + 60 * 60_000;
  assert.equal((await renewOn(proxy, renewed.token)).status, 401);
  // A service token past its life.
  const old = await tokenOf(broker, "orchestrator");
  clock.now += SERVICE_TOKEN_TTL_MS + 1000;
  const expired = await call(broker, "orchestrator", "GET", "/runs", {
    headers: { authorization: `Bearer ${old}` },
  });
  assert.deepEqual([expired.status, expired.json.message], [401, "service token: expired"]);
  // A run whose record expired, its end never said: no longer counted, listed or not.
  await started(orchestrator, "run-b");
  assert.deepEqual(await samplesOf(registry, "deckhand_runs_live"), { "": 1 });
  clock.now += RECORD_TTL_MS + 1000;
  assert.deepEqual(await samplesOf(registry, "deckhand_runs_live"), { "": 0 });

  assert.deepEqual(await samplesOf(registry, "deckhand_token_renewals_total"), {
    '{result="again"}': 1,
    '{result="renewed"}': 1,
    '{result="refused"}': 4,
  });
  const issued = await samplesOf(registry, "deckhand_tokens_issued_total");
  // Three run tokens (two starts, one renewal) and two agent tokens; a service token per call.
  assert.equal(issued['{kind="run"}'], 3);
  assert.equal(issued['{kind="agent"}'], 2);
  assert.ok(issued['{kind="service"}'] >= 5);
  assert.deepEqual(await samplesOf(registry, "deckhand_tokens_refused_total"), {
    '{reason="wrong_sandbox"}': 1,
    '{reason="invalid"}': 2,
    '{reason="unknown_caller"}': 2,
    '{reason="not_allowed"}': 1,
    '{reason="run_over"}': 2,
    '{reason="expired"}': 2,
  });
});

test("a chat's requests for more permissions: asked from its sandbox, said on the stream, answered by the orchestrator alone (#479)", async (t) => {
  const { copies } = await brokers(t);
  const [broker] = copies;
  const orchestrator = await client(broker, "orchestrator");
  const proxy = await client(broker, "proxy");
  const work = (await started(orchestrator, "run-a")).token;
  const chat = (await started(orchestrator, "run-c", { mode: "chat", sandbox: "net-c" })).token;
  const json = { "content-type": "application/json" };
  const ask = (token, sandbox, body) =>
    sandboxCall(proxy, "POST", "/run/permissions", token, sandbox, { body, headers: json });
  const request = { kind: "host", value: "pypi.org", reason: "pip install" };

  // Only a chat's run may ask, with its own token from its own sandbox.
  const refused = await ask(work, "net-a", request);
  assert.equal(refused.status, 403);
  assert.match(refused.json.message, /only a chat's may/);
  assert.equal((await ask(chat, "net-a", request)).status, 403);
  assert.equal((await ask(chat, "net-c", { ...request, kind: "sudo" })).status, 400);
  assert.equal((await ask(chat, "net-c", { ...request, value: "x".repeat(300) })).status, 400);
  const asked = await ask(chat, "net-c", request);
  assert.equal(asked.status, 202);
  const { id } = asked.json;
  assert.match(id, /^[0-9a-f]{16}$/);

  // On the stream, for the orchestrator.
  const { events } = (await orchestrator("GET", "/events")).json;
  const said = events.map((e) => e.event).find((e) => e.type === "permission");
  assert.deepEqual({ ...said, at: 0 }, { type: "permission", run: "run-c", at: 0, id, ...request });

  // Another run's token never reads it; the proxy never answers it.
  const read = (token, sandbox) =>
    sandboxCall(proxy, "GET", `/run/permissions/${id}`, token, sandbox);
  assert.equal((await read(work, "net-a")).status, 404);
  const answer = (caller, rid, body) =>
    caller("PUT", `/runs/run-c/permissions/${rid}`, { body, headers: json });
  assert.equal((await answer(proxy, id, { state: "granted", message: "ok" })).status, 403);
  assert.equal((await answer(orchestrator, id, { state: "maybe" })).status, 400);
  assert.equal((await answer(orchestrator, "ffffffffffffffff", { state: "denied" })).status, 404);
  assert.equal((await answer(orchestrator, id, { state: "granted", message: "ok" })).status, 204);
  // The first answer stays.
  assert.equal((await answer(orchestrator, id, { state: "denied", message: "no" })).status, 204);
  const got = await read(chat, "net-c");
  assert.equal(got.status, 200);
  assert.deepEqual(got.json, { state: "granted", message: "ok" });
});

test("a request's answer: waited for, a run asking in a loop stopped at REQUESTS_MAX", async () => {
  const clock = { now: 0 };
  const store = openStore("memory:", { now: () => clock.now });
  const permissions = createPermissions({
    store,
    now: () => clock.now,
    sleep: async (ms) => (clock.now += ms),
  });
  const record = { id: "run-c", mode: "chat" };
  const { body } = await permissions.ask(record, { kind: "engine", reason: "docker build" });
  // No answer within the wait: null (the sandbox asks again), then the answer once it came.
  assert.equal(await permissions.answerOf("run-c", body.id), null);
  assert.equal(clock.now, ANSWER_WAIT_MS);
  assert.equal(await permissions.answerOf("run-x", body.id), undefined);
  await permissions.answer("run-c", body.id, { state: "denied", message: "Denied by alice." });
  assert.deepEqual(await permissions.answerOf("run-c", body.id), {
    state: "denied",
    message: "Denied by alice.",
  });
  // Sent again with its key (its 202 lost): the same request, said again, counted once.
  const key = "0123456789abcdef0123456789abcdef";
  const first = await permissions.ask(record, { kind: "engine", key });
  const said = async () =>
    (await store.read("runs", "orchestrator", { count: 1000 })).filter(
      (e) => e.event.id === first.body.id,
    ).length;
  for (let i = 0; i < 20; i++) {
    const again = await permissions.ask(record, { kind: "engine", key });
    assert.equal(again.body.id, first.body.id);
  }
  // Said once on the stream every run shares, however often it is sent again.
  assert.equal(await said(), 1);
  assert.equal((await permissions.ask(record, { kind: "engine", key: "nope" })).status, 400);
  await permissions.answer("run-c", first.body.id, { state: "granted", message: "ok" });
  assert.equal((await permissions.ask(record, { kind: "engine", key })).body.state, "answered");
  for (let i = 2; i < REQUESTS_MAX; i++) await permissions.ask(record, { kind: "engine" });
  const over = await permissions.ask(record, { kind: "engine" });
  assert.equal(over.status, 429);
  // For the run's whole life, not a few hours: its count goes as the run ends.
  clock.now += 24 * 60 * 60_000;
  assert.equal((await permissions.ask(record, { kind: "engine" })).status, 429);
  await permissions.forget("run-c");
  assert.equal((await permissions.ask(record, { kind: "engine" })).status, 202);
});
