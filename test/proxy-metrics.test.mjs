// The egress proxy's metrics (proxy/metrics.mjs) through the proxy: its connections and why
// they were refused, their bytes, the policy's time, the cache, and the runs' calls to the
// services, as a scrape renders them.
import assert from "node:assert/strict";
import { request } from "node:http";
import { connect } from "node:net";
import { test } from "node:test";
import { createRegistry } from "../lib/metrics.mjs";
import { SANDBOX_URLS } from "../lib/services.mjs";
import { createCache } from "../proxy/cache.mjs";
import { egressMetrics } from "../proxy/metrics.mjs";
import { createProxy } from "../proxy/proxy.mjs";
import { closedPort, listening, serve, tempDir, until } from "./helpers.mjs";

// A sample's value in the registry's page, or undefined: `labels` in their declared order.
async function sample(registry, name, labels = "") {
  const page = await registry.render();
  const line = page.split("\n").find((l) => l.startsWith(`${name}${labels} `));
  return line === undefined ? undefined : Number(line.slice(line.lastIndexOf(" ") + 1));
}

// An upstream, and a proxy with its metrics whose policy answers `answers[host]` (default:
// allowed, a sandbox's), every name resolving to the upstream but `nowhere.test`.
async function setup(t, { answers = {}, cache = null, engine = false, ...options } = {}) {
  const { port: upstreamPort } = await serve(t, (req, res) => {
    res.writeHead(200, { "content-type": "text/plain", "cache-control": "max-age=60" });
    res.end(`body of ${req.url}`);
  });
  const registry = createRegistry();
  const metrics = egressMetrics(registry, { cache });
  const proxy = createProxy({
    policy: async (ip, host, { forward } = {}) =>
      answers[host] ?? { allowed: !forward, private: true, source: "sandbox" },
    lookup: async (host) => {
      if (host === "nowhere.test") throw new Error("ENOTFOUND");
      return [{ address: "127.0.0.1", family: 4 }];
    },
    blocked: (address) => address === "127.0.0.2",
    cache,
    engine,
    metrics,
    ...options,
  });
  const proxyPort = await listening(proxy);
  t.after(() => proxy.close());
  return { registry, proxyPort, upstreamPort };
}

// A request through the proxy: { status, body }.
function viaProxy(proxyPort, url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: proxyPort,
        path: url,
        headers: { connection: "close", ...headers },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (d) => (body += d));
        res.on("end", () => resolve({ status: res.statusCode, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

// A CONNECT's socket once answered: { socket, head }.
function tunnel(proxyPort, authority) {
  return new Promise((resolve, reject) => {
    const socket = connect(proxyPort, "127.0.0.1", () =>
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nhost: ${authority}\r\n\r\n`),
    );
    socket.once("data", (head) => resolve({ socket, head: String(head) }));
    socket.on("error", reject);
  });
}

const CONNECTIONS = "deckhand_egress_connections_total";

test("connections: allowed or refused, by source and reason, never the host", async (t) => {
  const { registry, proxyPort, upstreamPort } = await setup(t, {
    answers: {
      "evil.test": { allowed: false, source: "sandbox", reason: "not_granted" },
      "built.test": { allowed: false, source: "build", reason: "no_build" },
      // An orchestrator from before #658: no source, no reason.
      "old.test": { allowed: false },
      // The policy's own reason, outside the declared ones: folded into "other".
      "odd.test": { allowed: false, source: "sandbox", reason: "a new one" },
      "private.test": { allowed: true, private: false, source: "engine" },
    },
    // An address the check refuses: private.test's.
    lookup: async (host) => {
      if (host === "nowhere.test") throw new Error("ENOTFOUND");
      return [{ address: host === "private.test" ? "127.0.0.2" : "127.0.0.1", family: 4 }];
    },
  });
  const { socket, head } = await tunnel(proxyPort, `ok.test:${upstreamPort}`);
  assert.match(head, /^HTTP\/1\.1 200/);
  socket.destroy();
  assert.equal((await viaProxy(proxyPort, `http://ok.test:${upstreamPort}/a`)).status, 200);
  for (const host of ["evil.test", "built.test", "old.test", "odd.test", "private.test"]) {
    assert.equal((await viaProxy(proxyPort, `http://${host}:${upstreamPort}/`)).status, 403);
  }
  assert.equal((await viaProxy(proxyPort, `http://nowhere.test:${upstreamPort}/`)).status, 502);

  const count = (labels) => sample(registry, CONNECTIONS, labels);
  assert.equal(await count('{source="sandbox",decision="allowed",reason="granted"}'), 2);
  assert.equal(await count('{source="sandbox",decision="denied",reason="not_granted"}'), 1);
  assert.equal(await count('{source="build",decision="denied",reason="no_build"}'), 1);
  assert.equal(await count('{source="unknown",decision="denied",reason="not_granted"}'), 1);
  assert.equal(await count('{source="sandbox",decision="denied",reason="other"}'), 1);
  assert.equal(await count('{source="engine",decision="denied",reason="private_address"}'), 1);
  assert.equal(await count('{source="sandbox",decision="denied",reason="unresolved"}'), 1);
  // Every connection asked the policy once, timed.
  assert.equal(await sample(registry, "deckhand_egress_policy_duration_seconds_count"), 8);
  assert.doesNotMatch(await registry.render(), /evil\.test|ok\.test/);
});

test("the engines' port: its connections an engine's when the policy doesn't say", async (t) => {
  const { registry, proxyPort, upstreamPort } = await setup(t, {
    engine: true,
    policy: async () => ({ allowed: true, private: true }),
  });
  assert.equal((await viaProxy(proxyPort, `http://ok.test:${upstreamPort}/`)).status, 200);
  const labels = '{source="engine",decision="allowed",reason="granted"}';
  assert.equal(await sample(registry, CONNECTIONS, labels), 1);
});

test("bytes and open connections: a tunnel's counted as it goes, kept once closed", async (t) => {
  const { registry, proxyPort, upstreamPort } = await setup(t);
  const open = () => sample(registry, "deckhand_egress_connections_open", '{source="sandbox"}');
  const bytes = (direction) =>
    sample(registry, "deckhand_egress_bytes_total", `{source="sandbox",direction="${direction}"}`);
  const { socket } = await tunnel(proxyPort, `ok.test:${upstreamPort}`);
  assert.equal(await open(), 1);
  const outBefore = await bytes("out");
  const inBefore = await bytes("in");
  socket.write(`GET /${"x".repeat(1000)} HTTP/1.1\r\nhost: ok.test\r\n\r\n`);
  await new Promise((resolve) => socket.once("data", resolve));
  // While open: what went through so far.
  await until(async () => (await bytes("out")) >= outBefore + 1000, { what: "the bytes out" });
  await until(async () => (await bytes("in")) > inBefore + 1000, { what: "the bytes in" });
  socket.destroy();
  await until(async () => (await open()) === undefined, { what: "the tunnel closed" });
  const total = await bytes("out");
  assert.ok(total >= outBefore + 1000);
  // Closed: its bytes stay.
  assert.equal(await bytes("out"), total);
});

test("the cache: misses, stored, hits and bypassed, its size and its limit", async (t) => {
  const dir = tempDir(t, "deckhand-egress-metrics-");
  const cache = createCache({ dir, max: 1024 * 1024 });
  const { registry, proxyPort, upstreamPort } = await setup(t, {
    cache,
    answers: { "cached.test": { allowed: true, private: true, cache: true, source: "sandbox" } },
  });
  const result = (name) =>
    sample(registry, "deckhand_egress_cache_requests_total", `{result="${name}"}`);
  const url = `http://cached.test:${upstreamPort}/pkg.deb`;
  assert.equal((await viaProxy(proxyPort, url)).body, "body of /pkg.deb");
  await until(async () => (await result("stored")) === 1, { what: "the download stored" });
  assert.equal((await viaProxy(proxyPort, url)).body, "body of /pkg.deb");
  await viaProxy(proxyPort, url, { authorization: "Bearer t" });
  // Another host's requests aren't the cache's.
  await viaProxy(proxyPort, `http://other.test:${upstreamPort}/pkg.deb`);
  assert.deepEqual(
    await Promise.all(["miss", "stored", "hit", "bypassed"].map(result)),
    [1, 1, 1, 1],
  );
  assert.equal(await sample(registry, "deckhand_egress_cache_bytes"), cache.size);
  assert.ok(cache.size > 0);
  assert.equal(await sample(registry, "deckhand_egress_cache_max_bytes"), 1024 * 1024);
});

test("the runs' calls to the services: by service and status, or unreachable", async (t) => {
  const { url } = await serve(t, (req, res) =>
    res.writeHead(req.url.endsWith("/no") ? 404 : 200).end("ok"),
  );
  const port = await closedPort();
  const { registry, proxyPort } = await setup(t, {
    policy: async (ip, host, { forward } = {}) => ({
      allowed: forward === true,
      sandbox: "net-1",
      source: "sandbox",
    }),
    githubService: { url, header: async () => "Bearer proxy" },
    modelsService: { url: `http://127.0.0.1:${port}`, header: async () => "Bearer proxy" },
    wait: { limitMs: 0 },
  });
  const github = `${SANDBOX_URLS.github}/git/org/repo.git/info/refs`;
  assert.equal((await viaProxy(proxyPort, github)).status, 200);
  assert.equal((await viaProxy(proxyPort, `${github}/no`)).status, 404);
  const models = `${SANDBOX_URLS.models}/anthropic/v1/messages`;
  assert.equal((await viaProxy(proxyPort, models)).status, 502);
  // No broker service: unreachable too.
  assert.equal((await viaProxy(proxyPort, `${SANDBOX_URLS.broker}/run/token`)).status, 502);
  const calls = (labels) => sample(registry, "deckhand_egress_gateway_calls_total", labels);
  assert.equal(await calls('{target="github",status="200"}'), 1);
  assert.equal(await calls('{target="github",status="404"}'), 1);
  assert.equal(await calls('{target="models",status="unreachable"}'), 1);
  assert.equal(await calls('{target="broker",status="unreachable"}'), 1);
  const allowed = '{source="sandbox",decision="allowed",reason="granted"}';
  assert.equal(await sample(registry, CONNECTIONS, allowed), 4);
});
