// A run's files, as a sandbox reaches them: on the broker service (../broker/files.mjs, #505),
// through the listener's port that relays them (broker-service.mjs relay(), for a proxy or a
// sandbox from before it) or through the egress proxy; its inbox as a long poll, its CA and
// digest, its screenshots' uploads, copied back into the listener's shots folder. Only from its
// own sandbox, and only its own run's.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { createCallers } from "../broker/callers.mjs";
import { createBroker as createBrokerService } from "../broker/server.mjs";
import { createBroker } from "../listener/broker.mjs";
import { clientAddress, createBrokerHttp } from "../listener/broker-http.mjs";
import { createBrokerService as createRemote } from "../listener/broker-service.mjs";
import { createBrokerCaller } from "../lib/broker-client.mjs";
import { MAX_SHOT, MAX_SHOTS, SHOT_NAME } from "../lib/shots.mjs";
import { openStore } from "../lib/store.mjs";
import { CLOSE, createInbox } from "../listener/runner/inbox.mjs";
import { createProxy } from "../proxy/proxy.mjs";
import { listening, serve, tempDir, testConfig, testKey } from "./helpers.mjs";

// The sandbox's scripts, deckhand-token among them, on the PATH of those the tests run.
const sandboxBin = new URL("../sandbox", import.meta.url).pathname;

const PNG = Buffer.from("89504e470d0a1a0a", "hex");
const image = (head, size = 64) => Buffer.concat([head, Buffer.alloc(size - head.length)]);

// The broker service's callers, at addresses of their own (SERVICE_NETWORKS).
const LISTENER_AT = "127.0.0.5";
const PROXY_AT = "127.0.0.6";

// The broker service, on every loopback address, for the test: it outlives the listener's
// restarts, as it does an update.
async function brokerService(t) {
  const { server } = createBrokerService({
    store: openStore("memory:"),
    key: testKey(),
    callers: createCallers({ networks: `orchestrator=${LISTENER_AT}/32,proxy=${PROXY_AT}/32` }),
  });
  await new Promise((resolve) => server.listen(0, "0.0.0.0", resolve));
  server.unref();
  t.after(() => (server.closeAllConnections(), server.close()));
  const { port } = server.address();
  return { at: (host) => `http://${host}:${port}` };
}

// A listener with two running tasks, A (its sandbox's network at 127.0.0.1, where the test's
// requests come from) and B (elsewhere), over `runsDir` and `shotsDir`: what a restart keeps.
// `service`: the broker service, which signed their tokens (`tokens`, a first listener's, none
// for one restarted), restart.mjs registers the runs once more by their ids. `ips`: their
// sandboxes' addresses.
async function listener(t, { service, runsDir, shotsDir, ips, tokens = null }) {
  const networks = { [ips.a]: "net-a", [ips.b]: "net-b" };
  const remote = createRemote({ caller: createBrokerCaller({ url: service.at(LISTENER_AT) }) });
  t.after(() => remote.stop());
  await remote.start();
  const broker = createBroker({
    issuer: remote.issuer,
    keys: remote.keys,
    sandboxOf: async (ip) => networks[ip] ?? null,
    clientOf: (req) => clientAddress(ctx, req),
  });
  const inbox = createInbox({ inboxDir: runsDir, mirror: remote.mirror });
  // Kubernetes names no container: the address of a run's network is its sandbox.
  const runner = {
    ...inbox,
    locate: async (ip) => (networks[ip] ? { sandbox: networks[ip], name: null } : null),
    proxyAddresses: async () => [],
  };
  const issued = tokens ?? {};
  const task = async (name, id, net, shots) => {
    broker.register("org/repo", { id });
    if (!tokens) issued[name] = (await broker.issue(id, net, shots)).token;
    return [name, { name: id, repo: "org/repo", live: { id, shots, sandbox: net, hosts: [] } }];
  };
  const tasks = new Map([
    await task("a", "run-a", "net-a", "a".repeat(24)),
    await task("b", "run-b", "net-b", "b".repeat(24)),
  ]);
  const config = testConfig();
  const ctx = { config, broker, tasks, runner, shotsDir, brokerService: remote, log: () => {} };
  remote.consume({ shotsDir });
  return { ctx, inbox, remote, tokens: issued, secret: (name) => issued[name] };
}

// The listener's port for sandboxes, on `port` (0: one the OS picks).
async function start(t, ctx, port = 0) {
  ctx.config.brokerPort = port;
  ctx.config.brokerUrl = `http://127.0.0.1:${port}`;
  const server = createBrokerHttp(ctx).listen();
  await once(server, "listening");
  const stop = () => (server.closeAllConnections(), server.close());
  t.after(stop);
  return { url: ctx.config.brokerUrl, port: server.address().port, stop };
}

async function fixture(t, ips = { a: "127.0.0.1", b: "10.2.0.2" }) {
  const runsDir = tempDir(t, "deckhand-runs-");
  const shotsDir = tempDir(t, "deckhand-shots-");
  const service = await brokerService(t);
  const made = await listener(t, { service, runsDir, shotsDir, ips });
  await made.inbox.write("run-a", "PEM-A", "# Digest A\n");
  await made.inbox.write("run-b", "PEM-B", "# Digest B\n");
  return { runsDir, shotsDir, service, ips, ...made };
}

// Until `check()` holds: the listener copies a screenshot from the broker's stream a moment
// after its upload.
async function until(check, ms = 5000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const auth = (secret) => ({ authorization: `Bearer ${secret}` });

test("a sandbox gets its own run's CA and digest; another run's token or none is refused", async (t) => {
  const { ctx, secret } = await fixture(t);
  const { url } = await start(t, ctx);
  const get = async (path, headers) => {
    const res = await fetch(url + path, { headers });
    return [res.status, await res.text()];
  };
  assert.deepEqual(await get("/run/ca", auth(secret("a"))), [200, "PEM-A"]);
  assert.deepEqual(await get("/run/digest", auth(secret("a"))), [200, "# Digest A\n"]);
  // B's token, sent from A's network: B's files stay B's.
  for (const path of ["/run/ca", "/run/digest", "/run/inbox?from=0"]) {
    assert.equal((await get(path, auth(secret("b"))))[0], 403, path);
    assert.equal((await get(path, auth("not-a-secret")))[0], 401, path);
    assert.equal((await get(path, {}))[0], 401, path);
  }
  assert.equal((await get("/run/nothing", auth(secret("a"))))[0], 404);
  // A sandbox calling the listener's port directly: nothing past its own run's endpoints, which
  // the relay's service token would otherwise open.
  for (const path of ["/run/../runs", "/run/%2e%2e/keys", "/run/../events"]) {
    const [status] = await get(path, auth("a.b.c"));
    assert.equal(status, 404, path);
  }
});

test("the inbox: whole lines after an offset, a long poll woken by a message, a bad offset refused", async (t) => {
  const { ctx, inbox, secret } = await fixture(t);
  const { url } = await start(t, ctx);
  const poll = (from) => fetch(`${url}/run/inbox?from=${from}`, { headers: auth(secret("a")) });
  inbox.send("run-a", "one");
  const first = await poll(0);
  assert.equal(first.status, 200);
  const one = Buffer.from(await first.arrayBuffer());
  assert.equal(JSON.parse(one).message.content, "one");
  // Nothing yet: it waits, until a message comes.
  const waiting = poll(one.length);
  await new Promise((resolve) => setTimeout(resolve, 50));
  inbox.send("run-a", "two");
  const two = await (await waiting).text();
  assert.equal(JSON.parse(two).message.content, "two");
  assert.equal((await poll(-1)).status, 400);
  assert.equal((await poll("x")).status, 400);
});

// What a sandbox runs (../sandbox/deckhand-inbox), against a listener that restarts between
// two messages: each message printed once, then it stops at the close line.
test("deckhand-inbox over the broker: a listener restart loses and repeats nothing", async (t) => {
  const { runsDir, shotsDir, ctx, inbox, secret, service, ips, tokens, remote } = await fixture(t);
  const first = await start(t, ctx);
  const script = new URL("../sandbox/deckhand-inbox", import.meta.url).pathname;
  // The token in its file, as entrypoint.sh writes it.
  const tokenFile = join(tempDir(t, "deckhand-sandbox-"), "run-token");
  writeFileSync(tokenFile, `${secret("a")}\n`);
  let printed;
  const firstLine = new Promise((resolve) => (printed = resolve));
  const done = new Promise((resolve, reject) => {
    const child = execFile(
      script,
      [`${first.url}/run/inbox`],
      {
        timeout: 20000,
        env: {
          ...process.env,
          PATH: `${sandboxBin}:${process.env.PATH}`,
          DECKHAND_TOKEN_FILE: tokenFile,
        },
      },
      (error, out) => (error ? reject(error) : resolve(out)),
    );
    child.stdout.once("data", printed);
  });
  inbox.send("run-a", "one");
  await firstLine;
  // The listener stops; a new one, on the same port and folders, with the same broker service,
  // checks the run's token again, and hands the broker what it doesn't have of the inbox.
  first.stop();
  remote.stop();
  const again = await listener(t, { service, runsDir, shotsDir, ips, tokens });
  again.inbox.send("run-a", "two");
  await start(t, again.ctx, first.port);
  again.inbox.send("run-a", "three");
  again.inbox.close("run-a");
  const out = (await done).trim().split("\n").map(JSON.parse);
  assert.deepEqual(
    out.map((m) => m.message.content),
    ["one", "two", "three"],
  );
  assert.ok(readFileSync(join(runsDir, "run-a", "inbox.jsonl"), "utf8").endsWith(CLOSE + "\n"));
});

test("screenshots: into the run's own folder, PNG, JPEG or WebP only, capped", async (t) => {
  const { ctx, shotsDir, secret } = await fixture(t);
  const { url } = await start(t, ctx);
  const folder = join(shotsDir, "a".repeat(24));
  const put = async (name, body, key = "a") =>
    (await fetch(`${url}/run/shots/${name}`, { method: "PUT", headers: auth(secret(key)), body }))
      .status;
  assert.equal(await put("page.png", image(PNG)), 204);
  // The listener copies it from the broker's stream, where GET /shots serves it.
  await until(() => existsSync(join(folder, "page.png")));
  assert.deepEqual(readFileSync(join(folder, "page.png")), image(PNG));
  assert.equal(await put("photo.jpg", image(Buffer.from("ffd8ff", "hex"))), 204);
  const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP")]);
  assert.equal(await put("pic.webp", image(webp)), 204);
  // Not what its name says, nor an image name at all, nor out of its folder.
  assert.equal(await put("fake.png", Buffer.from("<script>")), 415);
  assert.equal(await put("page.html", image(PNG)), 400);
  assert.equal(await put("..%2Fescape.png", image(PNG)), 400);
  assert.equal(await put(".hidden", image(PNG)), 400);
  // Over the cap: refused, nothing written.
  assert.equal(await put("big.png", image(PNG, MAX_SHOT + 1)), 413);
  assert.equal(existsSync(join(folder, "big.png")), false);
  // B's secret from A's address: refused; B's folder untouched.
  assert.equal(await put("page.png", image(PNG), "b"), 403);
  assert.equal(existsSync(join(shotsDir, "b".repeat(24))), false);
  // Replacing a file counts once toward the run's total.
  assert.equal(await put("page.png", image(PNG, 128)), 204);
  await until(() => readFileSync(join(folder, "page.png")).length === 128);
  await until(() => readdirSync(folder).length === 3);
  assert.deepEqual(readdirSync(folder).sort(), ["page.png", "photo.jpg", "pic.webp"]);
  assert.ok(MAX_SHOTS >= MAX_SHOT);
});

test("screenshots: a run's total is capped too; a research run (no folder) has none", async (t) => {
  const { ctx, secret } = await fixture(t);
  const { url } = await start(t, ctx);
  const put = async (name, size) =>
    (
      await fetch(`${url}/run/shots/${name}`, {
        method: "PUT",
        headers: auth(secret("a")),
        body: image(PNG, size),
      })
    ).status;
  const count = Math.floor(MAX_SHOTS / MAX_SHOT);
  for (let i = 0; i < count - 1; i++) assert.equal(await put(`p${i}.png`, MAX_SHOT), 204);
  // One file's room left: an upload in flight holds it, so a second one at once is refused.
  const { port } = new URL(url);
  const slow = request({
    port,
    host: "127.0.0.1",
    method: "PUT",
    path: "/run/shots/slow.png",
    headers: { ...auth(secret("a")), "content-length": MAX_SHOT },
  });
  const answered = once(slow, "response");
  slow.write(PNG);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(await put("meanwhile.png", 1024), 413);
  // The same name again (the watcher and gh both sending it): told to come back, not refused
  // (413 would be final) nor held beside the first in memory.
  assert.equal(await put("slow.png", 1024), 409);
  slow.end(Buffer.alloc(MAX_SHOT - PNG.length));
  assert.equal((await answered)[0].statusCode, 204);
  assert.equal(await put("one-more.png", 1024), 413);
  // The same name again, once done, replaces it: only the files count.
  assert.equal(await put("slow.png", 1024), 204);
  assert.equal(await put("after.png", 1024), 204);
});

// What a sandbox runs (../sandbox/deckhand-files): its files fetched, its screenshots sent once
// each, again when they change.
test("deckhand-files: get fetches a run file, shots uploads new and changed images only", async (t) => {
  const { ctx, shotsDir, secret } = await fixture(t);
  const { url } = await start(t, ctx);
  const tmp = tempDir(t, "deckhand-sandbox-");
  const shots = join(tmp, "screenshots");
  mkdirSync(shots);
  const script = new URL("../sandbox/deckhand-files", import.meta.url).pathname;
  // The token in its file, as entrypoint.sh writes it, read again at each request.
  const tokenFile = join(tmp, "run-token");
  writeFileSync(tokenFile, secret("a"));
  const env = {
    ...process.env,
    PATH: `${sandboxBin}:${process.env.PATH}`,
    DECKHAND_BROKER_URL: url,
    DECKHAND_TOKEN_FILE: tokenFile,
    SCREENSHOT_DIR: shots,
    TMPDIR: tmp,
  };
  const run = (...args) =>
    new Promise((resolve) =>
      execFile(script, args, { env, timeout: 20000 }, (error, out, err) =>
        resolve({ code: error?.code ?? 0, err }),
      ),
    );
  assert.equal((await run("get", `${url}/run/ca`, join(tmp, "ca.crt"))).code, 0);
  assert.equal(readFileSync(join(tmp, "ca.crt"), "utf8"), "PEM-A");
  // A 401 or 403 may be a restarted listener taking the run back: asked again.
  let asked = 0;
  const flaky = await serve(t, (req, res) => {
    if (asked++) res.end("PEM-LATER");
    else res.writeHead(401).end();
  });
  assert.equal((await run("get", `${flaky.url}/run/ca`, join(tmp, "later.crt"))).code, 0);
  assert.equal(readFileSync(join(tmp, "later.crt"), "utf8"), "PEM-LATER");
  assert.equal(asked, 2);
  // No such file for the run: no retry.
  const missing = await run("get", `${url}/run/nothing`, join(tmp, "x"));
  assert.equal(missing.code, 1);
  assert.match(missing.err, /couldn't fetch .*404/);

  writeFileSync(join(shots, "page.png"), image(PNG));
  writeFileSync(join(shots, "fake.png"), "not an image");
  writeFileSync(join(shots, "notes.txt"), "skipped");
  const first = await run("shots");
  assert.equal(first.code, 0);
  assert.match(first.err, /fake\.png refused/);
  const folder = join(shotsDir, "a".repeat(24));
  await until(() => existsSync(join(folder, "page.png")));
  assert.deepEqual(readdirSync(folder), ["page.png"]);
  // Sent already: not again, and the refused one isn't retried until it changes.
  rmSync(join(folder, "page.png"));
  assert.equal((await run("shots")).err, "");
  assert.deepEqual(readdirSync(folder), []);
  writeFileSync(join(shots, "page.png"), image(PNG, 99));
  await run("shots");
  await until(() => existsSync(join(folder, "page.png")));
  assert.equal(readFileSync(join(folder, "page.png")).length, 99);
  // Refused for the sandbox, not the file (another run's token here, as a listener that
  // doesn't know the sandbox's network yet answers): tried again next time.
  writeFileSync(join(shots, "later.png"), image(PNG));
  writeFileSync(tokenFile, secret("b"));
  await run("shots");
  assert.equal(existsSync(join(folder, "later.png")), false);
  writeFileSync(tokenFile, secret("a"));
  await run("shots");
  await until(() => existsSync(join(folder, "later.png")));
  // A refusal the watcher (or a hook: --log) met first is still told once by the next call
  // whose stderr the agent reads, and not sent again.
  writeFileSync(join(shots, "huge.webp"), "not a webp");
  assert.match((await run("shots", "--log")).err, /huge\.webp refused: 415/);
  assert.match((await run("shots")).err, /huge\.webp refused: 415/);
  assert.equal((await run("shots")).err, "");
  // A pass merges what it decided into the state as it is when it ends: another pass's entry,
  // written while this one uploads (by the broker here), stays.
  const state = join(tmp, "deckhand-shots.json");
  const meanwhile = await serve(t, (req, res) => {
    const now = JSON.parse(readFileSync(state, "utf8"));
    writeFileSync(state, JSON.stringify({ ...now, "elsewhere.png": "1:2" }));
    req.resume().on("end", () => res.writeHead(204).end());
  });
  writeFileSync(join(shots, "new.png"), image(PNG));
  const broker = env.DECKHAND_BROKER_URL;
  env.DECKHAND_BROKER_URL = meanwhile.url;
  await run("shots");
  env.DECKHAND_BROKER_URL = broker;
  const merged = JSON.parse(readFileSync(state, "utf8"));
  assert.equal(merged["elsewhere.png"], "1:2");
  assert.equal(typeof merged["new.png"], "string");
  assert.equal(merged["huge.webp"].told, true);
});

test("deckhand-inbox: a refusal it keeps getting is said once on stderr", async (t) => {
  const { ctx } = await fixture(t);
  const { url } = await start(t, ctx);
  const script = new URL("../sandbox/deckhand-inbox", import.meta.url).pathname;
  const env = {
    ...process.env,
    PATH: `${sandboxBin}:${process.env.PATH}`,
    DECKHAND_TOKEN_FILE: "/nonexistent/run-token",
    DECKHAND_RUN_SECRET: "unknown",
  };
  const child = execFile(script, [`${url}/run/inbox`], { env, timeout: 20000 });
  let err = "";
  child.stderr.on("data", (d) => (err += d));
  await new Promise((resolve) => setTimeout(resolve, 2500));
  child.kill();
  // Asked several times (0.5 s, 1 s…), said once.
  assert.equal(err.match(/deckhand-inbox: the broker answered 401 /g)?.length, 1, err);
});

// deckhand-files is plain Node in the image and can't import the listener's pattern: a copy.
test("deckhand-files and the broker agree on the screenshots' names", () => {
  const script = readFileSync(new URL("../sandbox/deckhand-files", import.meta.url), "utf8");
  const copy = script.match(/^const SHOT = (\/.+\/);$/m);
  assert.ok(copy, "deckhand-files declares SHOT");
  assert.equal(new Function(`return ${copy[1]}`)().source, SHOT_NAME.source);
});

test("a sandbox's calls through the egress proxy go to the broker service, vouched for by the proxy alone", async (t) => {
  // B's sandbox at 127.0.0.2; A's elsewhere.
  const { ctx, secret, service } = await fixture(t, { a: "10.1.0.2", b: "127.0.0.2" });
  const { url } = await start(t, ctx);
  // The listener's policy: the broker for its runs' sandboxes, with their network.
  const nets = { "10.1.0.2": "net-a", "127.0.0.2": "net-b" };
  const asked = [];
  const proxy = createProxy({
    policy: async (ip, host, { broker } = {}) => (
      asked.push(ip),
      { allowed: broker === true && !!nets[ip], sandbox: nets[ip] ?? null }
    ),
    brokerUrl: url,
    brokerService: createBrokerCaller({ url: service.at(PROXY_AT) }),
  });
  const proxyPort = await listening(proxy);
  t.after(() => proxy.close());
  // From B's sandbox, through the proxy → [status, body].
  const viaProxy = (path, headers) =>
    new Promise((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          localAddress: "127.0.0.2",
          port: proxyPort,
          path: url + path,
          headers,
        },
        (res) => {
          let text = "";
          res.setEncoding("utf8");
          res.on("data", (d) => (text += d));
          res.on("end", () => resolve([res.statusCode, text]));
        },
      );
      req.on("error", reject);
      req.end();
    });
  assert.deepEqual(await viaProxy("/run/ca", auth(secret("b"))), [200, "PEM-B"]);
  // A's token from B's sandbox: refused, whatever network or address B names itself.
  const spoofed = {
    ...auth(secret("a")),
    "x-deckhand-client": "10.1.0.2",
    "x-deckhand-sandbox": "net-a",
  };
  assert.equal((await viaProxy("/run/ca", spoofed))[0], 403);
  // Its renewal too, through the proxy.
  const renewed = await new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        localAddress: "127.0.0.2",
        port: proxyPort,
        method: "POST",
        path: `${url}/run/token`,
        headers: auth(secret("b")),
      },
      (res) => {
        let text = "";
        res.on("data", (d) => (text += d));
        res.on("end", () => resolve([res.statusCode, text.trim()]));
      },
    );
    req.on("error", reject);
    req.end();
  });
  assert.equal(renewed[0], 200);
  assert.equal(JSON.parse(Buffer.from(renewed[1].split(".")[1], "base64url")).jti, "run-b");
  // The broker service believes no one else's word: a sandbox's own call with the headers set
  // (or the listener's port without the proxy, from no sandbox's address) gets nothing.
  const direct = await fetch(`${url}/run/ca`, {
    headers: { ...auth(secret("b")), "x-deckhand-sandbox": "net-b" },
  });
  assert.equal(direct.status, 403);
  assert.ok(asked.every((ip) => ip === "127.0.0.2"));
});
