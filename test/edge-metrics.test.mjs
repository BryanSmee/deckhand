// Edge's metrics (edge/metrics.mjs, #655): deliveries by event and result, requests by route
// pattern and never by path, the users active on either copy, the live logs open.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { createRegistry } from "../lib/metrics.mjs";
import { openStore } from "../lib/store.mjs";
import { createEdgeApp } from "../edge/app.mjs";
import { createForwarder } from "../edge/forward.mjs";
import { createEdgeHttp } from "../edge/http.mjs";
import { ACTIVE_MS, edgeMetrics, routeOf } from "../edge/metrics.mjs";
import { createRedeliveries } from "../listener/redeliveries.mjs";
import { serve, tempDir, testConfig, until } from "./helpers.mjs";

const SECRET = "webhook-secret-0123456789abcdef";
const signed = (body) => `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;

// The value of `sample` (its name and labels as rendered) in `registry`'s page, or null.
async function value(registry, sample) {
  const line = (await registry.render()).split("\n").find((l) => l.startsWith(`${sample} `));
  return line ? Number(line.slice(sample.length + 1)) : null;
}

// Edge's public server with its metrics; `user`: who its sessions say signs in.
async function edgeWithMetrics(
  t,
  { store = openStore("memory:"), user = null, config = testConfig({ PORT: "0" }) } = {},
) {
  const dir = tempDir(t);
  writeFileSync(join(dir, "app.json"), JSON.stringify({ id: 5, webhook_secret: SECRET }));
  const app = createEdgeApp({ dir });
  const registry = createRegistry();
  const metrics = edgeMetrics(registry, { store });
  let stopping = false;
  const http = createEdgeHttp({
    config,
    app,
    auth: { handle: () => false, user: async () => user },
    setup: { handle: () => false },
    store,
    orchestrator: { forward: async (req, res) => res.writeHead(200).end("{}") },
    redeliveries: createRedeliveries({ store, app: () => null }),
    dashboardDir: dir,
    stopping: () => stopping,
    metrics,
  });
  // How many requests reached it: a test waits for those it holds open.
  let arrived = 0;
  const { url } = await serve(t, (req, res) => (arrived++, http.handle(req, res)));
  const port = new URL(url).port;
  return { url, port, app, registry, arrived: () => arrived, stop: () => (stopping = true) };
}

const deliver = (url, body, { id, event = "issue_comment", signature = signed(body) } = {}) =>
  fetch(`${url}/webhook`, {
    method: "POST",
    headers: {
      ...(id && { "x-github-delivery": id }),
      ...(event && { "x-github-event": event }),
      ...(signature && { "x-hub-signature-256": signature }),
    },
    body,
  });

test("a route is its pattern, never its path; a path edge doesn't serve is other", () => {
  const cases = {
    "/": "/",
    "/webhook": "/webhook",
    "/api/state": "/api/state",
    "/api/runs/run-1a2b.c/stream": "/api/runs/:id/stream",
    "/api/repos/org/repo/work": "/api/repos/:owner/:repo/work",
    "/api/repos/org/repo.js/config": "/api/repos/:owner/:repo/config",
    "/api/repos/org/repo/discussions/12": "/api/repos/:owner/:repo/discussions/:number",
    "/api/repos/org/repo/discussions/12/comments":
      "/api/repos/:owner/:repo/discussions/:number/comments",
    "/api/mcp/clients/abc_D-1/revoke": "/api/mcp/clients/:id/revoke",
    "/.well-known/oauth-protected-resource/mcp": "/.well-known/oauth-protected-resource",
    "/assets/index-3f2a.js": "/assets/:file",
    "/theme.js": "/:file",
    "/api/repos/org/repo/nothing": "other",
    "/api/runs/x/stream/more": "other",
    "/wp-login.php/x": "other",
    "/etc/passwd": "other",
  };
  for (const [path, route] of Object.entries(cases)) assert.equal(routeOf(path), route, path);
});

test("deliveries: counted by event and what became of them; an unknown event is other", async (t) => {
  const edge = await edgeWithMetrics(t);
  const body = JSON.stringify({ action: "created", comment: { id: 1 } });
  assert.equal((await deliver(edge.url, body, { id: "g1" })).status, 202);
  assert.equal((await deliver(edge.url, body, { id: "g1" })).status, 202);
  assert.equal((await deliver(edge.url, body, { id: "g2", signature: "sha256=00" })).status, 401);
  assert.equal((await deliver(edge.url, body, { id: "g3", signature: null })).status, 401);
  assert.equal((await deliver(edge.url, "not json", { id: "g4" })).status, 202);
  assert.equal((await deliver(edge.url, body, { id: "g5", event: "made_up_event" })).status, 202);
  edge.stop();
  assert.equal((await deliver(edge.url, body, { id: "g6" })).status, 503);
  const count = (event, result) =>
    value(edge.registry, `deckhand_webhooks_received_total{event="${event}",result="${result}"}`);
  assert.equal(await count("issue_comment", "accepted"), 1);
  assert.equal(await count("issue_comment", "duplicate"), 1);
  assert.equal(await count("issue_comment", "bad_signature"), 2);
  assert.equal(await count("issue_comment", "ignored"), 1);
  assert.equal(await count("issue_comment", "refused"), 1);
  assert.equal(await count("other", "accepted"), 1);
  assert.doesNotMatch(await edge.registry.render(), /made_up_event/);
});

test("requests: counted and timed by route and status, the path itself never a label", async (t) => {
  const edge = await edgeWithMetrics(t, { user: "alice" });
  await fetch(`${edge.url}/health`);
  await fetch(`${edge.url}/api/runs/run-42/stream`);
  await fetch(`${edge.url}/api/repos/org/secret-repo/work`, { method: "POST", body: "{}" });
  await fetch(`${edge.url}/nowhere/at/all`, { method: "DELETE" });
  // Counted as its answer ends: the client may read it a moment before.
  const requests = (route, status) =>
    value(edge.registry, `deckhand_http_requests_total{route="${route}",status="${status}"}`);
  await until(async () => (await requests("other", "404")) === 1);
  assert.equal(await requests("/health", "200"), 1);
  assert.equal(await requests("/api/runs/:id/stream", "200"), 1);
  assert.equal(await requests("/api/repos/:owner/:repo/work", "200"), 1);
  const page = await edge.registry.render();
  assert.match(page, /deckhand_http_request_duration_seconds_count\{route="\/health"\} 1/);
  assert.match(
    page,
    /deckhand_http_request_duration_seconds_bucket\{route="\/health",le="\+Inf"\} 1/,
  );
  for (const path of ["run-42", "secret-repo", "nowhere"])
    assert.doesNotMatch(page, new RegExp(path));
});

test("sessions: the users seen on either copy in the last 15 minutes, the same on both", async (t) => {
  let clock = 1_000_000;
  const now = () => clock;
  const store = openStore("memory:", { now });
  const one = createRegistry();
  const two = createRegistry();
  const first = edgeMetrics(one, { store, now });
  const second = edgeMetrics(two, { store, now });
  const active = (registry) => value(registry, "deckhand_sessions_active");
  assert.equal(await active(one), 0);
  await first.seen("alice");
  await second.seen("alice");
  await second.seen("bob");
  assert.equal(await active(one), 2);
  assert.equal(await active(two), 2);
  // Alice goes on on the first copy; Bob's mark runs out.
  clock += ACTIVE_MS - 60_000;
  await first.seen("alice");
  clock += 60_000;
  assert.equal(await active(one), 1);
  assert.equal(await active(two), 1);
});

test("live logs: open while the orchestrator's answer streams, closed once the browser goes", async (t) => {
  const registry = createRegistry();
  const metrics = edgeMetrics(registry, { store: openStore("memory:") });
  const { url: orchestrator } = await serve(t, (req, res) => {
    if (req.url.endsWith("/stream")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      return res.write("data: hello\n\n");
    }
    res.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
  const forwarder = createForwarder({
    urls: orchestrator,
    token: () => "Bearer x",
    stream: metrics.stream,
    log: () => {},
  });
  const { url } = await serve(t, (req, res) => forwarder.forward(req, res, { user: "alice" }));
  const open = () => value(registry, "deckhand_log_streams_open");
  await (await fetch(`${url}/api/state`)).text();
  assert.equal(await open(), 0);
  const gone = new AbortController();
  const res = await fetch(`${url}/api/runs/r1/stream`, { signal: gone.signal });
  const reader = res.body.getReader();
  await reader.read();
  assert.equal(await open(), 1);
  gone.abort();
  await until(async () => (await open()) === 0);
});

const count = (registry, event, result) =>
  value(registry, `deckhand_webhooks_received_total{event="${event}",result="${result}"}`);

// A delivery's request with its headers sent and its body not: → { req, status } (the answer's,
// should one come before the body).
function started(port, headers) {
  const req = request({ host: "127.0.0.1", port, method: "POST", path: "/webhook", headers });
  req.on("error", () => {});
  const status = new Promise((resolve) =>
    req.on("response", (res) => (res.resume(), resolve(res.statusCode))),
  );
  req.flushHeaders();
  return { req, status };
}

test("deliveries refused before their body, cut short, or that the store can't keep: each its result", async (t) => {
  const store = openStore("memory:");
  const edge = await edgeWithMetrics(t, { store });
  const headers = { "x-github-event": "issue_comment", "x-hub-signature-256": "sha256=00" };
  const large = started(edge.port, { ...headers, "content-length": String(6 * 1024 * 1024) });
  assert.equal(await large.status, 413);
  large.req.destroy();
  // One address holds its 4 places with bodies that never come: its 5th is busy.
  const held = [];
  for (let i = 0; i < 4; i++) {
    const one = started(edge.port, headers);
    one.req.write("{");
    held.push(one.req);
  }
  await until(() => edge.arrived() === 5, { what: "the 4 held reaching edge" });
  const busy = started(edge.port, headers);
  assert.equal(await busy.status, 503);
  busy.req.destroy();
  assert.equal(await count(edge.registry, "issue_comment", "too_large"), 1);
  assert.equal(await count(edge.registry, "issue_comment", "busy"), 1);
  // Cut short: each unread, once.
  for (const req of held) req.destroy();
  await until(async () => (await count(edge.registry, "issue_comment", "unread")) === 4, {
    what: "the 4 cut short counted",
  });
  // The store away: failed, once, and nothing else.
  store.append = async () => {
    throw new Error("the store is away");
  };
  const body = JSON.stringify({ action: "created", comment: { id: 1 } });
  assert.equal((await deliver(edge.url, body, { id: "f-1" })).status, 503);
  assert.equal(await count(edge.registry, "issue_comment", "failed"), 1);
  assert.equal(await count(edge.registry, "issue_comment", "unread"), 4);
  assert.equal(await count(edge.registry, "issue_comment", "accepted"), null);
});

test("CI deliveries: another repo's ignored, a commit already waiting a duplicate", async (t) => {
  const edge = await edgeWithMetrics(t, {
    config: testConfig({ PORT: "0", ALLOWED_REPOS: "org/repo" }),
  });
  const suite = (full_name) =>
    JSON.stringify({
      action: "completed",
      installation: { id: 7 },
      repository: { full_name },
      check_suite: { head_sha: "abc", app: {} },
    });
  const event = "check_suite";
  assert.equal((await deliver(edge.url, suite("else/where"), { id: "c-1", event })).status, 202);
  assert.equal((await deliver(edge.url, suite("org/repo"), { id: "c-2", event })).status, 202);
  assert.equal((await deliver(edge.url, suite("org/repo"), { id: "c-3", event })).status, 202);
  assert.equal(await count(edge.registry, event, "ignored"), 1);
  assert.equal(await count(edge.registry, event, "accepted"), 1);
  assert.equal(await count(edge.registry, event, "duplicate"), 1);
});

test("requests: a status edge doesn't usually answer with is other, its route kept", async (t) => {
  const registry = createRegistry();
  const metrics = edgeMetrics(registry, { store: openStore("memory:") });
  const { url } = await serve(t, (req, res) => {
    metrics.request(req, res);
    res.writeHead(599).end();
  });
  await (await fetch(`${url}/api/state`)).arrayBuffer();
  await until(
    async () =>
      (await value(registry, 'deckhand_http_requests_total{route="/api/state",status="other"}')) ===
      1,
  );
});
