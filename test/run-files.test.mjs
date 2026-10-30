// A run's files on the broker (run-files.mjs): its inbox as a long poll, its CA and digest, its
// screenshots' uploads. Only from its own sandbox, and only its own run's.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { createBroker } from "../listener/broker.mjs";
import { clientAddress, createBrokerHttp } from "../listener/broker-http.mjs";
import { MAX_SHOT, MAX_SHOTS, SHOT_NAME } from "../listener/run-files.mjs";
import { CLOSE, createInbox } from "../listener/runner/inbox.mjs";
import { createProxy } from "../proxy/proxy.mjs";
import { listening, serve, tempDir, testConfig } from "./helpers.mjs";

const PNG = Buffer.from("89504e470d0a1a0a", "hex");
const image = (head, size = 64) => Buffer.concat([head, Buffer.alloc(size - head.length)]);

// A listener with two running tasks, A (its sandbox at 127.0.0.1, where the test's requests
// come from) and B (elsewhere), over `runsDir` and `shotsDir`: what a restart keeps.
// `secrets`: theirs again, as restart.mjs registers them once more.
// `ips`: their sandboxes' addresses.
function listener({ runsDir, shotsDir, secrets = {}, ips = { a: "127.0.0.1", b: "10.2.0.2" } }) {
  const at = new Map();
  const broker = createBroker({
    sentFrom: async (run, ip) => at.get(run) === ip,
    clientOf: (req) => clientAddress(ctx, req),
  });
  const inbox = createInbox({ inboxDir: runsDir });
  const task = (key, id, ip, shots) => {
    const secret = broker.register("org/repo", null, { secret: secrets[key] });
    at.set(broker.runOf(secret), ip);
    return [key, { name: id, repo: "org/repo", live: { id, secret, shots } }];
  };
  const tasks = new Map([
    task("a", "run-a", ips.a, "a".repeat(24)),
    task("b", "run-b", ips.b, "b".repeat(24)),
  ]);
  const config = testConfig();
  const ctx = { config, broker, tasks, runner: inbox, shotsDir, log: () => {} };
  return { ctx, inbox, secret: (key) => tasks.get(key).live.secret };
}

// The broker's server, on `port` (0: one the OS picks).
async function start(t, ctx, port = 0) {
  ctx.config.brokerPort = port;
  ctx.config.brokerUrl = `http://127.0.0.1:${port}`;
  const server = createBrokerHttp(ctx).listen();
  await once(server, "listening");
  const stop = () => (server.closeAllConnections(), server.close());
  t.after(stop);
  return { url: ctx.config.brokerUrl, port: server.address().port, stop };
}

function fixture(t, ips) {
  const runsDir = tempDir(t, "deckhand-runs-");
  const shotsDir = tempDir(t, "deckhand-shots-");
  const made = listener({ runsDir, shotsDir, ips });
  made.inbox.write("run-a", "PEM-A", "# Digest A\n");
  made.inbox.write("run-b", "PEM-B", "# Digest B\n");
  return { runsDir, shotsDir, ...made };
}

const auth = (secret) => ({ authorization: `Bearer ${secret}` });

test("a sandbox gets its own run's CA and digest; another run's secret or none is refused", async (t) => {
  const { ctx, runsDir, secret } = fixture(t);
  const { url } = await start(t, ctx);
  const get = async (path, headers) => {
    const res = await fetch(url + path, { headers });
    return [res.status, await res.text()];
  };
  assert.deepEqual(await get("/run/ca", auth(secret("a"))), [200, "PEM-A"]);
  assert.deepEqual(await get("/run/digest", auth(secret("a"))), [200, "# Digest A\n"]);
  // B's secret, sent from A's address: B's files stay B's.
  for (const path of ["/run/ca", "/run/digest", "/run/inbox?from=0"]) {
    assert.equal((await get(path, auth(secret("b"))))[0], 403, path);
    assert.equal((await get(path, auth("not-a-secret")))[0], 401, path);
    assert.equal((await get(path, {}))[0], 401, path);
  }
  assert.equal((await get("/run/nothing", auth(secret("a"))))[0], 404);
  // A run without a digest.
  rmSync(join(runsDir, "run-a", "digest.md"));
  assert.equal((await get("/run/digest", auth(secret("a"))))[0], 404);
});

test("the inbox: whole lines after an offset, a long poll woken by a message, a bad offset refused", async (t) => {
  const { ctx, inbox, secret } = fixture(t);
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
  const { runsDir, shotsDir, ctx, inbox, secret } = fixture(t);
  const first = await start(t, ctx);
  const script = new URL("../sandbox/deckhand-inbox", import.meta.url).pathname;
  let printed;
  const firstLine = new Promise((resolve) => (printed = resolve));
  const done = new Promise((resolve, reject) => {
    const child = execFile(
      script,
      [`${first.url}/run/inbox`],
      { timeout: 20000, env: { ...process.env, DECKHAND_RUN_SECRET: secret("a") } },
      (error, out) => (error ? reject(error) : resolve(out)),
    );
    child.stdout.once("data", printed);
  });
  inbox.send("run-a", "one");
  await firstLine;
  // The listener stops; a new one, on the same port and folders, knows the run's secret again.
  first.stop();
  const again = listener({ runsDir, shotsDir, secrets: { a: secret("a"), b: secret("b") } });
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
  const { ctx, shotsDir, secret } = fixture(t);
  const { url } = await start(t, ctx);
  const folder = join(shotsDir, "a".repeat(24));
  const put = async (name, body, key = "a") =>
    (await fetch(`${url}/run/shots/${name}`, { method: "PUT", headers: auth(secret(key)), body }))
      .status;
  assert.equal(await put("page.png", image(PNG)), 204);
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
  assert.deepEqual(readdirSync(folder).sort(), ["page.png", "photo.jpg", "pic.webp"]);
  assert.ok(MAX_SHOTS >= MAX_SHOT);
});

test("screenshots: a run's total is capped too; a research run (no folder) has none", async (t) => {
  const { ctx, secret } = fixture(t);
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
  // Done, its reservation is given back: only the files count.
  rmSync(join(ctx.shotsDir, "a".repeat(24), "slow.png"));
  assert.equal(await put("after.png", 1024), 204);
  ctx.tasks.get("a").live.shots = null;
  assert.equal(await put("p0.png", 64), 403);
});

// What a sandbox runs (../sandbox/deckhand-files): its files fetched, its screenshots sent once
// each, again when they change.
test("deckhand-files: get fetches a run file, shots uploads new and changed images only", async (t) => {
  const { ctx, shotsDir, secret } = fixture(t);
  const { url } = await start(t, ctx);
  const tmp = tempDir(t, "deckhand-sandbox-");
  const shots = join(tmp, "screenshots");
  mkdirSync(shots);
  const script = new URL("../sandbox/deckhand-files", import.meta.url).pathname;
  const env = {
    ...process.env,
    DECKHAND_BROKER_URL: url,
    DECKHAND_RUN_SECRET: secret("a"),
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
  assert.deepEqual(readdirSync(folder), ["page.png"]);
  // Sent already: not again, and the refused one isn't retried until it changes.
  rmSync(join(folder, "page.png"));
  assert.equal((await run("shots")).err, "");
  assert.deepEqual(readdirSync(folder), []);
  writeFileSync(join(shots, "page.png"), image(PNG, 99));
  await run("shots");
  assert.equal(readFileSync(join(folder, "page.png")).length, 99);
  // Refused for the sandbox, not the file (another run's secret here, as a listener that
  // doesn't know the sandbox's address yet answers): tried again next time.
  writeFileSync(join(shots, "later.png"), image(PNG));
  env.DECKHAND_RUN_SECRET = secret("b");
  await run("shots");
  assert.equal(existsSync(join(folder, "later.png")), false);
  env.DECKHAND_RUN_SECRET = secret("a");
  await run("shots");
  assert.equal(existsSync(join(folder, "later.png")), true);
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
  const { ctx } = fixture(t);
  const { url } = await start(t, ctx);
  const script = new URL("../sandbox/deckhand-inbox", import.meta.url).pathname;
  const env = { ...process.env, DECKHAND_RUN_SECRET: "unknown" };
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

test("a sandbox's calls through the egress proxy are its own: the broker believes the address it names", async (t) => {
  // B's sandbox at 127.0.0.2; the proxy calls the broker from 127.0.0.1.
  const { ctx, secret } = fixture(t, { a: "10.1.0.2", b: "127.0.0.2" });
  ctx.runner.proxyAddresses = async () => ["127.0.0.1"];
  const { url } = await start(t, ctx);
  // The listener's policy: the broker for its runs' sandboxes.
  const proxy = createProxy({
    policy: async (ip, host, { broker } = {}) => ({
      allowed: broker === true && ["10.1.0.2", "127.0.0.2"].includes(ip),
    }),
    brokerUrl: url,
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
  // A's secret from B's sandbox: refused, whatever address B names itself.
  const spoofed = { ...auth(secret("a")), "x-deckhand-client": "10.1.0.2" };
  assert.equal((await viaProxy("/run/ca", spoofed))[0], 403);
  // Without the header, a call is its source address's: here the proxy's own, no sandbox's.
  const direct = await fetch(`${url}/run/ca`, { headers: auth(secret("b")) });
  assert.equal(direct.status, 403);
});
