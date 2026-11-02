// Edge (edge/, #506): its two copies on one store, both active. A delivery is verified and taken
// once, whichever copy GitHub sends it to and however often; the orchestrator reads it from the
// stream and acknowledges it once handled; the redeliveries' poller runs on one copy, the
// lease's holder; the dashboard's API is passed on with the signed-in user. Sign-outs across
// copies: auth.test.mjs.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { activePassive } from "../lib/active.mjs";
import { signServiceToken, networkCallers } from "../lib/service-token.mjs";
import { openStore } from "../lib/store.mjs";
import { createEdgeApp, publicPart } from "../edge/app.mjs";
import { createEdgeClient } from "../edge/client.mjs";
import { createForwarder, USER_HEADER } from "../edge/forward.mjs";
import { createEdgeHttp } from "../edge/http.mjs";
import { createEdgeInternal, DELIVERIES } from "../edge/internal.mjs";
import { fromDashboard, fromKey, postOf, tagger } from "../listener/discussions.mjs";
import { createRedeliveries } from "../listener/redeliveries.mjs";
import { listening, recordingFetch, serve, tempDir, testConfig, testKey } from "./helpers.mjs";

// As long as a real one: redact() leaves out shorter ones (lib/redact.mjs MIN_LENGTH).
const SECRET = "webhook-secret-0123456789abcdef";
const CREDENTIALS = {
  id: 5,
  slug: "deckhand-x",
  owner: "org",
  html_url: "https://github.com/apps/deckhand-x",
  bot_id: 77,
  client_id: "Iv1.x",
  client_secret: "cs",
  webhook_secret: SECRET,
};

const signed = (body) => `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;

// One copy of edge's public server on `store`, its App held in `dir`; `orchestrator`: what the
// dashboard's API is passed on to.
async function edgeCopy(
  t,
  { store, dir = tempDir(t), orchestrator, logs = [], config = testConfig({ PORT: "0" }) } = {},
) {
  writeFileSync(join(dir, "app.json"), JSON.stringify(CREDENTIALS));
  const app = createEdgeApp({ dir });
  const redeliveries = createRedeliveries({ store, app: () => null });
  const http = createEdgeHttp({
    config,
    app,
    auth: { handle: () => false, user: async () => null },
    setup: { handle: () => false },
    store,
    orchestrator: orchestrator ?? { forward: async (req, res) => res.writeHead(599).end() },
    redeliveries,
    dashboardDir: dir,
    secrets: () => app.secrets(),
    log: (line) => logs.push(line),
  });
  const { url } = await serve(t, http.handle);
  return { url, app, logs };
}

const deliver = (url, payload, { id, event = "issue_comment", signature } = {}) => {
  const body = JSON.stringify(payload);
  return fetch(`${url}/webhook`, {
    method: "POST",
    headers: {
      ...(id && { "x-github-delivery": id }),
      "x-github-event": event,
      "x-hub-signature-256": signature ?? signed(body),
    },
    body,
  });
};

const comment = { action: "created", comment: { id: 1, body: "Deckhand" } };

test("two copies: a delivery GitHub sends to both, or twice, goes on the stream once", async (t) => {
  const store = openStore("memory:");
  const one = await edgeCopy(t, { store });
  const two = await edgeCopy(t, { store });
  for (const copy of [one, two, one]) {
    assert.equal((await deliver(copy.url, comment, { id: "guid-1" })).status, 202);
  }
  assert.equal((await deliver(two.url, comment, { id: "guid-2" })).status, 202);
  const events = await store.read(DELIVERIES, "orchestrator");
  assert.deepEqual(
    events.map(({ event }) => [event.id, event.event, event.payload.comment.id]),
    [
      ["guid-1", "issue_comment", 1],
      ["guid-2", "issue_comment", 1],
    ],
  );
  assert.ok(two.logs.includes("Delivery guid-1 again: already handled"));
});

test("a delivery: unsigned, badly signed or without an App refused; a secret in it kept out of the store", async (t) => {
  const store = openStore("memory:");
  const dir = tempDir(t);
  const copy = await edgeCopy(t, { store, dir });
  assert.equal((await deliver(copy.url, comment, { id: "a", signature: "sha256=00" })).status, 401);
  const unsigned = await fetch(`${copy.url}/webhook`, {
    method: "POST",
    headers: { "x-github-event": "issue_comment" },
    body: "{}",
  });
  assert.equal(unsigned.status, 401);
  // A comment pasting the webhook secret by mistake: kept, without it.
  const leaky = { action: "created", comment: { id: 2, body: `oops ${SECRET} there` } };
  assert.equal((await deliver(copy.url, leaky, { id: "b" })).status, 202);
  const [kept] = await store.read(DELIVERIES, "orchestrator");
  assert.doesNotMatch(JSON.stringify(kept), new RegExp(SECRET));
  assert.match(kept.event.payload.comment.body, /^oops .+ there$/);
  // No App (removed): nothing read, GitHub told to come back.
  const none = await edgeCopy(t, { store, dir: tempDir(t) });
  none.app.get = () => null;
  assert.equal((await deliver(none.url, comment, { id: "c" })).status, 503);
});

test("a delivery the store can't keep: 503, and its GUID free for GitHub's next attempt", async (t) => {
  const store = openStore("memory:");
  const copy = await edgeCopy(t, { store });
  const append = store.append;
  store.append = async () => {
    throw new Error("the store is away");
  };
  assert.equal((await deliver(copy.url, comment, { id: "g" })).status, 503);
  assert.equal(await store.get("deliveries/g"), null);
  store.append = append;
  assert.equal((await deliver(copy.url, comment, { id: "g" })).status, 202);
  assert.equal((await store.read(DELIVERIES, "orchestrator")).length, 1);
});

test("a delivery on the stream is answered 202 though its mark couldn't be kept", async (t) => {
  const store = openStore("memory:");
  const copy = await edgeCopy(t, { store });
  const set = store.set;
  store.set = async (key, ...rest) => {
    if (key === "deliveries/m") throw new Error("the store is away");
    return set(key, ...rest);
  };
  assert.equal((await deliver(copy.url, comment, { id: "m" })).status, 202);
  assert.equal((await store.read(DELIVERIES, "orchestrator")).length, 1);
  assert.ok(copy.logs.some((line) => /Delivery m: its mark/.test(line)));
});

test("a delivery a copy died taking is taken again a minute on; one being taken, or kept, isn't", async (t) => {
  const store = openStore("memory:");
  const copy = await edgeCopy(t, { store });
  await store.set("deliveries/lost", { taking: Date.now() - 120_000 });
  await store.set("deliveries/now", { taking: Date.now() });
  for (const id of ["lost", "now"]) await deliver(copy.url, comment, { id });
  const events = await store.read(DELIVERIES, "orchestrator");
  assert.deepEqual(
    events.map(({ event }) => event.id),
    ["lost"],
  );
  assert.ok((await store.get("deliveries/lost")).kept);
  // What the redeliveries ask: kept, or being taken now, is edge's; a stale mark isn't.
  const { takenDelivery } = await import("../edge/http.mjs");
  await store.set("deliveries/stale", { taking: Date.now() - 120_000 });
  assert.deepEqual(
    await Promise.all(["lost", "now", "stale", "none"].map((id) => takenDelivery(store, id))),
    [true, true, false, false],
  );
});

// Edge's internal port, the orchestrator calling it with its service token.
async function internal(
  t,
  { store = openStore("memory:"), dir = tempDir(t), redeliveries, handOver = null } = {},
) {
  const key = testKey();
  const app = createEdgeApp({ dir });
  const handedOver = [];
  const server = createEdgeInternal({
    store,
    app,
    keys: new Map([[key.kid, key.publicKey]]),
    bound: networkCallers("orchestrator=127.0.0.0/8"),
    redeliveries: redeliveries ?? createRedeliveries({ store, app: () => null }),
    handOver: async (body) => {
      if (handOver) await handOver(body);
      handedOver.push(body);
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 20))),
  });
  const url = `http://127.0.0.1:${await listening(server)}`;
  server.unref();
  t.after(() => server.close());
  const as = (sub) => async () => `Bearer ${signServiceToken({ sub, aud: "edge" }, key)}`;
  const client = createEdgeClient({ urls: url, token: as("orchestrator"), waitMs: 1000 });
  t.after(() => client.stop());
  return { url, app, store, client, as, handedOver };
}

test("CI deliveries: only what the orchestrator reads, allowed repos only, one waiting per commit until it is read", async (t) => {
  const store = openStore("memory:");
  const logs = [];
  const config = testConfig({ PORT: "0", ALLOWED_REPOS: "org/repo" });
  const copy = await edgeCopy(t, { store, logs, config });
  const { url, as } = await internal(t, { store });
  const repository = { full_name: "org/repo", private: true, owner: { login: "org" } };
  const status = (sha, more = {}) => ({
    installation: { id: 7 },
    repository,
    sha,
    state: "pending",
    context: "ci/jenkins",
    commit: { sha, commit: { message: "a long message" } },
    branches: [{ name: "issue-30-fix" }],
    ...more,
  });
  const quiet = async () =>
    (await store.read(DELIVERIES, "orchestrator")).filter((e) => e.event.event !== "push");
  // The same commit twice, and its check suite: one entry, with only what ciDelivery() reads,
  // without its GUID.
  await deliver(copy.url, status("abc"), { id: "s-1", event: "status" });
  await deliver(copy.url, status("abc", { state: "success" }), { id: "s-2", event: "status" });
  const suite = {
    action: "completed",
    installation: { id: 7 },
    repository,
    check_suite: { head_sha: "abc", app: {} },
  };
  await deliver(copy.url, suite, { id: "c-1", event: "check_suite" });
  // Another repository's, or one without a commit: none.
  await deliver(copy.url, status("abc", { repository: { full_name: "else/where" } }), {
    event: "status",
  });
  await deliver(copy.url, status(null), { event: "status" });
  assert.deepEqual(
    (await quiet()).map(({ event }) => [event.id, event.event, event.payload]),
    [
      [
        null,
        "status",
        { installation: { id: 7 }, repository: { full_name: "org/repo" }, sha: "abc" },
      ],
    ],
  );
  assert.equal(await store.get("deliveries/s-1"), null);
  assert.ok(!logs.some((line) => /status|check_suite/.test(line)), logs.join("\n"));
  // Once the orchestrator read it, the next one for that commit goes on the stream: its read of
  // CI may have been before it.
  const auth = { authorization: await as("orchestrator")() };
  const { events } = await (await fetch(`${url}/events?wait=0`, { headers: auth })).json();
  assert.equal(events.length, 1);
  await deliver(copy.url, suite, { id: "c-2", event: "check_suite" });
  const after = await quiet();
  assert.deepEqual(
    after.map(({ event }) => [
      event.event,
      event.payload.check_suite?.head_sha ?? event.payload.sha,
    ]),
    [
      ["status", "abc"],
      ["check_suite", "abc"],
    ],
  );
});

test("the orchestrator reads the deliveries, acknowledges each once handled; one that fails is read again", async (t) => {
  const { store, client } = await internal(t);
  for (const id of ["d1", "d2", "d3"]) await store.append(DELIVERIES, { id, event: "push" });
  const handled = [];
  const started = [];
  let fail = true;
  let release;
  const slow = new Promise((resolve) => (release = resolve));
  client.consume(async (entry) => {
    started.push(entry.id);
    // d1 slow (an onboarding of many repositories, say): it holds up neither d2 nor d3.
    if (entry.id === "d1") await slow;
    if (entry.id === "d2" && fail) {
      fail = false;
      throw new Error("not now");
    }
    handled.push(entry.id);
  });
  for (let i = 0; i < 200 && !handled.includes("d3"); i++) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  // Started in the stream's order, d3 handled while d1 still goes.
  assert.deepEqual(started.slice(0, 3), ["d1", "d2", "d3"]);
  assert.deepEqual(handled, ["d3"]);
  release();
  for (let i = 0; i < 200 && handled.length < 3; i++) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  // d1 once; d2 read again after its failure, and handled then.
  assert.deepEqual(handled, ["d3", "d1", "d2"]);
  assert.deepEqual(started, ["d1", "d2", "d3", "d2"]);
  await client.stop();
  assert.deepEqual(await store.read(DELIVERIES, "orchestrator"), []);
  // Handled, gone from the stream: no reader finds their payloads any more.
  assert.deepEqual(await store.read(DELIVERIES, "anyone"), []);
});

test("edge's internal port: the orchestrator's token alone; the App's public parts, never its secrets", async (t) => {
  const { url, app, as, client } = await internal(t);
  assert.deepEqual(await client.app(), { configured: false });
  app.save({ ...CREDENTIALS, pem: "-----BEGIN RSA PRIVATE KEY-----" });
  const info = await client.app();
  assert.deepEqual(info, publicPart(CREDENTIALS));
  assert.doesNotMatch(JSON.stringify(info), /"cs"|webhook-secret|PRIVATE/);
  // The key never kept, even sent along.
  assert.equal(app.get().pem, undefined);
  for (const sub of ["runner", "proxy", "edge"]) {
    const res = await fetch(`${url}/app`, { headers: { authorization: await as(sub)() } });
    assert.equal(res.status, 403, sub);
  }
  assert.equal((await fetch(`${url}/app`)).status, 401);
});

test("the dashboard's from tags: edge's, which the orchestrator's posts and checks match", async (t) => {
  const { app, client } = await internal(t);
  app.save(CREDENTIALS);
  const from = tagger({ tags: (items) => client.tags(items) });
  const posted = await from.post("alice", "Hi\n\nthere");
  // As the key that the webhook secret gives would sign it.
  assert.equal(posted, fromDashboard("alice", "Hi\n\nthere", fromKey(SECRET)));
  const node = (body) => ({
    id: "x",
    body,
    author: { login: "deckhand-x[bot]", __typename: "Bot" },
  });
  const verify = await from.verifier([
    node(posted),
    node(fromDashboard("bob", "Hi", fromKey("x"))),
  ]);
  assert.equal(postOf(node(posted), "deckhand-x", verify).author, "alice");
  const forged = fromDashboard("bob", "Hi", fromKey("x"));
  assert.equal(postOf(node(forged), "deckhand-x", verify).author, "deckhand-x[bot]");
});

test("a listener's App handed over: taken once with its sessions, another App refused", async (t) => {
  const dir = tempDir(t);
  const { client, handedOver } = await internal(t, { dir });
  const sessionKey = Buffer.alloc(32, 7).toString("base64");
  const body = { credentials: { ...CREDENTIALS, pem: "x" }, sessionKey, epochs: { alice: 2 } };
  assert.deepEqual(await client.handOver(body), publicPart(CREDENTIALS));
  assert.equal(JSON.parse(readFileSync(join(dir, "app.json"), "utf8")).pem, undefined);
  assert.deepEqual(handedOver, [body]);
  // Asked again (a lost answer): the same App's, nothing replaced.
  await client.handOver(body);
  assert.equal(handedOver.length, 1);
  await assert.rejects(client.handOver({ credentials: { ...CREDENTIALS, id: 6 } }), {
    status: 409,
  });
  // The same App with another webhook secret, or another OAuth client: never replaced by the
  // orchestrator, which holds no secret of edge's.
  for (const changed of [{ webhook_secret: "x".repeat(32) }, { client_secret: "other" }]) {
    await assert.rejects(client.handOver({ credentials: { ...CREDENTIALS, ...changed } }), {
      status: 409,
    });
  }
  const kept = JSON.parse(readFileSync(join(dir, "app.json"), "utf8"));
  assert.equal(kept.webhook_secret, SECRET);
  assert.equal(kept.client_secret, "cs");
});

test("a handover whose sessions fail to move takes nothing: asked again, they move then", async (t) => {
  const dir = tempDir(t);
  let fail = true;
  const { client, handedOver, app } = await internal(t, {
    dir,
    handOver: async () => {
      if (fail) throw new Error("the store is away");
    },
  });
  const body = { credentials: CREDENTIALS, sessionKey: null, epochs: { alice: 2 } };
  await assert.rejects(client.handOver(body), { status: 500 });
  // Not taken: the orchestrator keeps the listener's files and asks again.
  assert.equal(app.get(), null);
  fail = false;
  assert.deepEqual(await client.handOver(body), publicPart(CREDENTIALS));
  assert.deepEqual(handedOver, [body]);
  assert.equal(app.get().webhook_secret, SECRET);
});

test("two copies: the redeliveries' poller runs on the one holding its lease, then on the other", async (t) => {
  const store = openStore("memory:");
  const listed = [];
  const copies = ["one", "two"].map((name) => {
    const { fetch } = recordingFetch(() => {
      listed.push(name);
      return [];
    });
    const redeliveries = createRedeliveries({
      store,
      app: () => ({ asApp: (method, path) => fetch(`https://api.example${path}`, { method }) }),
      checkMs: 20,
    });
    const poller = activePassive({
      store,
      name: "edge/redeliveries",
      holder: name,
      // Long enough that a paused runner doesn't let it expire: stop() hands it over.
      ttlMs: 10_000,
      pollMs: 10,
      onActive: () => redeliveries.start(),
      onPassive: () => redeliveries.stop(),
    });
    return { name, poller };
  });
  for (const { poller } of copies) await poller.start();
  t.after(() => Promise.all(copies.map(({ poller }) => poller.stop())));
  const scans = async (check) => {
    for (let i = 0; i < 500 && !check(); i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  await scans(() => listed.length >= 3);
  assert.ok(listed.length >= 3, `scans: ${listed.length}`);
  assert.deepEqual([...new Set(listed)], ["one"]);
  // The first copy stops: the other takes the lease at once, and scans from then on.
  await copies[0].poller.stop();
  const before = listed.length;
  await scans(() => listed.length >= before + 3);
  assert.deepEqual([...new Set(listed.slice(before))], ["two"]);
});

test("the dashboard's API, passed on with the signed-in user; an orchestrator away: 503", async (t) => {
  const key = testKey();
  const seen = [];
  const { url: orchestrator } = await serve(t, (req, res) => {
    seen.push({
      path: req.url,
      user: req.headers[USER_HEADER] ?? null,
      auth: !!req.headers.authorization,
    });
    res.writeHead(200, { "content-type": "application/json", "x-other": "dropped" });
    res.end('{"ok":true}');
  });
  const token = async () => `Bearer ${signServiceToken({ sub: "edge", aud: "orchestrator" }, key)}`;
  const forwarder = createForwarder({ urls: orchestrator, token, log: () => {} });
  const store = openStore("memory:");
  const copy = await edgeCopy(t, { store, orchestrator: forwarder });
  // A user header the browser sends is no sign-in: edge's auth says who it is (here, nobody).
  const res = await fetch(`${copy.url}/api/state`, { headers: { [USER_HEADER]: "mallory" } });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(res.headers.get("x-other"), null);
  assert.deepEqual(seen, [{ path: "/edge/api/state", user: null, auth: true }]);
  const away = createForwarder({ urls: "http://127.0.0.1:9", token, waitMs: 200, log: () => {} });
  const down = await edgeCopy(t, { store, orchestrator: away });
  assert.equal((await fetch(`${down.url}/api/state`)).status, 503);
});

test("a live log passed on ends once its user signs out", async (t) => {
  const key = testKey();
  const { url: orchestrator } = await serve(t, (req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("event: entries\ndata: []\n\n");
    // Never ends by itself, as a run's log while it runs.
  });
  const token = async () => `Bearer ${signServiceToken({ sub: "edge", aud: "orchestrator" }, key)}`;
  const forwarder = createForwarder({ urls: orchestrator, token, log: () => {} });
  let signedIn = true;
  const { url } = await serve(t, (req, res) =>
    forwarder.forward(req, res, { user: "alice", still: async () => signedIn }),
  );
  const res = await fetch(`${url}/api/runs/x/stream`);
  const reader = res.body.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /event: entries/);
  signedIn = false;
  const started = Date.now();
  while (!(await reader.read()).done) {
    // What else came before its end.
  }
  assert.ok(Date.now() - started < 3000);
});

test("two copies on one volume: the App one of them was set up with, the other has at once", (t) => {
  const dir = tempDir(t);
  const one = createEdgeApp({ dir });
  const two = createEdgeApp({ dir });
  assert.equal(two.get(), null);
  one.save({ ...CREDENTIALS, pem: "x" });
  assert.equal(two.get().webhook_secret, SECRET);
  assert.equal(two.get().pem, undefined);
  assert.deepEqual(two.secrets(), [SECRET, "cs"]);
  // Another App, handed over to the other copy: refused there too.
  assert.equal(two.takeOver({ ...CREDENTIALS, id: 6 })?.status, 409);
});
