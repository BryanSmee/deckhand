// Edge's process (edge/server.mjs, #506) end to end, alone: the broker service in this process
// (its service tokens), a fake github service and a fake orchestrator. The deliveries' way to a
// run and back to a reply goes through the orchestrator too: orchestrator-server.test.mjs.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { createCallers } from "../broker/callers.mjs";
import { createBroker } from "../broker/server.mjs";
import { signServiceToken } from "../lib/service-token.mjs";
import { openStore } from "../lib/store.mjs";
import { SESSION_COOKIE, SESSION_MS } from "../listener/auth.mjs";
import { listening, serve, tempDir, testKey } from "./helpers.mjs";

const SECRET = "webhook-secret";
const KEY = Buffer.alloc(32, 3);
const host = "127.0.0.1";

// A session cookie for `login`, as edge signs them with KEY.
function session(login) {
  const payload = Buffer.from(
    JSON.stringify({ login, exp: Date.now() + SESSION_MS, epoch: 0 }),
  ).toString("base64url");
  const signature = createHmac("sha256", KEY).update(payload).digest("base64url");
  return `${SESSION_COOKIE}=${payload}.${signature}`;
}

// Edge, with its App and session key in its data folder, the broker in process, and fakes of
// the github service and the orchestrator: what the orchestrator was asked, edge's ports.
async function startEdge(t) {
  const dir = tempDir(t);
  writeFileSync(
    join(dir, "app.json"),
    JSON.stringify({
      id: 5,
      slug: "deckhand-x",
      client_id: "Iv1.x",
      client_secret: "cs",
      webhook_secret: SECRET,
    }),
  );
  writeFileSync(join(dir, "session.key"), KEY);
  const key = testKey();
  const broker = createBroker({
    store: openStore("memory:"),
    key,
    callers: createCallers({ networks: "edge=127.0.0.0/8" }),
    keysDir: join(dir, "keys"),
  }).server;
  const brokerPort = await listening(broker);
  broker.unref();
  t.after(() => (broker.closeAllConnections(), broker.close()));
  // The github service: the redeliveries' list, empty.
  const { url: github } = await serve(t, (req, res) => {
    res.writeHead(200, { "content-type": "application/json", "x-github-status": "200" });
    res.end("[]");
  });
  const asked = [];
  const { url: orchestrator } = await serve(t, (req, res) => {
    asked.push({
      method: req.method,
      url: req.url,
      user: req.headers["x-deckhand-user"] ?? null,
      local: req.headers["x-deckhand-local"] === "1",
      service: !!req.headers.authorization,
    });
    res.writeHead(200, { "content-type": "application/json" }).end('{"answered":true}');
  });
  const child = spawn(process.execPath, ["edge/server.mjs"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: {
      PATH: process.env.PATH,
      PORT: "0",
      // A port the OS picks, as for PORT: one probed free first may be another test's by then.
      INTERNAL_PORT: "0",
      DATA_DIR: dir,
      ALLOWED_USERS: "alice",
      PUBLIC_URL: "https://hooks.example.com",
      BROKER_SERVICE_URL: `http://127.0.0.1:${brokerPort}`,
      GITHUB_SERVICE_URL: github,
      ORCHESTRATOR_URL: orchestrator,
      SERVICE_NETWORKS: "orchestrator=127.0.0.0/8",
      DRAIN_SECONDS: "2",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  t.after(() => child.kill("SIGKILL"));
  const until = (pattern) =>
    new Promise((resolve, reject) => {
      const timer = setInterval(() => {
        const found = typeof pattern === "string" ? out.includes(pattern) : pattern.exec(out);
        if (found) (clearInterval(timer), resolve(found));
      }, 20);
      child.on("exit", (code) => (clearInterval(timer), reject(new Error(`exit ${code}: ${out}`))));
    });
  const port = Number((await until(/Listening on :(\d+)\n/))[1]);
  const internalPort = Number((await until(/Internal port on :(\d+)\n/))[1]);
  const asOrchestrator = `Bearer ${signServiceToken({ sub: "orchestrator", aud: "edge" }, key)}`;
  const internal = (path, init = {}) =>
    fetch(`http://127.0.0.1:${internalPort}${path}`, {
      ...init,
      headers: {
        authorization: asOrchestrator,
        "content-type": "application/json",
        ...init.headers,
      },
    });
  return { child, port, internal, asked, until, output: () => out };
}

const signature = (body) => `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;

function send(port, payload, { id, event = "issue_comment" } = {}) {
  const body = JSON.stringify(payload);
  return fetch(`http://127.0.0.1:${port}/webhook`, {
    method: "POST",
    headers: {
      ...(id && { "x-github-delivery": id }),
      "x-github-event": event,
      "x-hub-signature-256": signature(body),
    },
    body,
  });
}

const comment = (login) => ({
  action: "created",
  installation: { id: 7 },
  repository: { full_name: "org/repo", default_branch: "trunk" },
  issue: { number: 12 },
  comment: { id: 99, body: "Deckhand", user: { login, type: "User" } },
  sender: { login },
});

test("edge: a delivery taken once, read and acknowledged by the orchestrator; the API passed on with its user", async (t) => {
  const edge = await startEdge(t);
  assert.equal((await send(edge.port, comment("alice"), { id: "g-1" })).status, 202);
  assert.equal((await send(edge.port, comment("alice"), { id: "g-1" })).status, 202);
  await edge.until("Delivery g-1 again: already handled");
  const { events } = await (await edge.internal("/events?wait=0")).json();
  assert.deepEqual(
    events.map(({ event }) => [event.id, event.event, event.payload.sender.login]),
    [["g-1", "issue_comment", "alice"]],
  );
  const ack = await edge.internal("/events/ack", {
    method: "POST",
    body: JSON.stringify({ ids: events.map((e) => e.id) }),
  });
  assert.deepEqual(await ack.json(), { acked: 1 });
  assert.deepEqual((await (await edge.internal("/events?wait=0")).json()).events, []);
  // The App's public parts, never its secrets.
  const app = await (await edge.internal("/app")).json();
  assert.equal(app.slug, "deckhand-x");
  assert.doesNotMatch(JSON.stringify(app), /webhook-secret|"cs"/);
  // The dashboard's API: the signed-in user's, else nobody's; /status from inside, local.
  const base = `http://127.0.0.1:${edge.port}`;
  const state = await fetch(`${base}/api/state`, { headers: { cookie: session("alice") } });
  assert.deepEqual(await state.json(), { answered: true });
  await fetch(`${base}/api/state`, { headers: { cookie: session("mallory") } });
  await fetch(`${base}/status`);
  assert.equal(
    (await fetch(`${base}/status`, { headers: { "x-forwarded-for": "1.2.3.4" } })).status,
    401,
  );
  await fetch(`${base}/shots/0123456789abcdef01234567/page.png`);
  assert.deepEqual(
    edge.asked.map(({ method, url, user, local, service }) => [method, url, user, local, service]),
    [
      ["GET", "/edge/api/state", "alice", false, true],
      ["GET", "/edge/api/state", null, false, true],
      ["GET", "/edge/status", null, true, true],
      ["GET", "/edge/shots/0123456789abcdef01234567/page.png", null, false, true],
    ],
  );
  // Its poller scans at start, holding the lease.
  await edge.until("edge/redeliveries: lease taken");
  // SIGTERM: the lease given back, the requests drained, then it exits.
  const exited = new Promise((resolve) => edge.child.on("exit", resolve));
  edge.child.kill("SIGTERM");
  assert.equal(await exited, 0);
  assert.match(edge.output(), /edge\/redeliveries: lease released/);
});

// Sends a delivery's headers and holds its body back: the answer comes from the headers alone.
function headersOnly(port, headers) {
  return new Promise((resolve, reject) => {
    const req = request({ host, port, method: "POST", path: "/webhook", headers }, (res) => {
      resolve(res.statusCode);
      res.resume();
      req.destroy();
    });
    req.on("error", reject);
    req.flushHeaders();
  });
}

test("unsigned or oversized deliveries are refused unread; one client gets only its share of places", async (t) => {
  const { port, until, output } = await startEdge(t);
  const signed = { "x-github-event": "issue_comment", "x-hub-signature-256": "sha256=00" };
  assert.equal(
    await headersOnly(port, { "x-github-event": "issue_comment", "content-length": "100" }),
    401,
  );
  assert.equal(
    await headersOnly(port, { ...signed, "content-length": String(6 * 1024 * 1024) }),
    413,
  );
  await until("Rejected a delivery: over 5242880 bytes");
  assert.match(output(), /Rejected a delivery: no signature/);
  // One client holds its share of the places, 4, with stalled bodies: its 5th is refused...
  const held = [];
  for (let i = 0; i < 4; i++) {
    const req = request({ host, port, method: "POST", path: "/webhook", headers: signed });
    req.on("error", () => {});
    req.write("{");
    held.push(req);
  }
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(await headersOnly(port, signed), 503);
  await until("no place to read a delivery from 127.0.0.1");
  // ...while a signed delivery from another address gets through.
  const body = JSON.stringify(comment("mallory"));
  const delivered = await new Promise((resolve, reject) => {
    const req = request(
      {
        host,
        port,
        method: "POST",
        path: "/webhook",
        localAddress: "127.0.0.2",
        headers: { "x-github-event": "issue_comment", "x-hub-signature-256": signature(body) },
      },
      (res) => (res.resume(), resolve(res.statusCode)),
    );
    req.on("error", reject);
    req.end(body);
  });
  assert.equal(delivered, 202);
  // Stalled bodies are dropped after a while: readDelivery() in deliveries.test.mjs.
  for (const req of held) req.destroy();
});

test("a path with dot segments is refused at edge, never passed on as another", async (t) => {
  const edge = await startEdge(t);
  const base = `http://127.0.0.1:${edge.port}`;
  const raw = (path) =>
    new Promise((resolve, reject) => {
      const req = request({ host, port: edge.port, path }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on("error", reject);
      req.end();
    });
  for (const path of [
    "/shots/../api/state",
    "/shots/%2e%2e/api/state",
    "/api/./state",
    "/shots/..\\api/state",
    "/shots/..%5capi/state",
    "/shots/..\\status",
  ]) {
    assert.equal(await raw(path), 400, path);
  }
  assert.equal(edge.asked.length, 0);
  assert.equal((await fetch(`${base}/health`)).status, 200);
});
