// The egress proxy's handover during an update (docs/services.md): a second copy on the same
// network takes the new connections while the old one drains, as long as an agent call lasts,
// so an agent stream through the old one finishes and no sandbox connection is refused.
import assert from "node:assert/strict";
import { request } from "node:http";
import { connect } from "node:net";
import { test } from "node:test";
import { createProxy, drainMs } from "../proxy/proxy.mjs";
import { listening, serve } from "./helpers.mjs";

// A proxy whose broker is `brokerUrl`, the fake agents' API below: agents call their API at
// the broker (BROKER_URL, listener/agents/claude.mjs), which the proxy forwards (toBroker()).
async function proxy(t, brokerUrl) {
  const server = createProxy({
    policy: async () => ({ allowed: true, private: true }),
    brokerUrl,
    lookup: async () => [{ address: "127.0.0.1", family: 4 }],
    // Loopback, which the real check always refuses.
    blocked: () => false,
  });
  const port = await listening(server);
  t.after(() => server.close());
  return { server, port };
}

// GET `url` through the proxy on `port`, on a connection of its own → { status, body() }.
function through(port, url) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: url, agent: false }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (d) => (body += d));
      const ended = new Promise((done) => res.on("end", () => done(body)));
      resolve({ status: res.statusCode, body: () => ended });
    });
    req.on("error", reject);
    req.end();
  });
}

// What a Kubernetes Service does with the proxies' pods: new connections go to one that is
// ready (answers /ready), never to one draining.
async function rotation(proxies) {
  for (const { port } of proxies) {
    try {
      const ready = await through(port, "/ready");
      if (ready.status === 200) return port;
    } catch {
      // Not taking connections: out of rotation.
    }
  }
  throw new Error("no proxy ready");
}

test("two proxies: the old one's agent stream finishes as it drains, new connections go to the new one", async (t) => {
  const streams = [];
  const clients = [];
  const { url: broker } = await serve(t, (req, res) => {
    // Forwarded as the broker's (toBroker()), naming the sandbox.
    clients.push(req.headers["x-deckhand-client"]);
    if (req.url === "/quick") return res.end("quick");
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: 1\n\n");
    streams.push(res);
  });
  const old = await proxy(t, broker);
  const next = await proxy(t, broker);
  const both = [old, next];

  // An agent call, through the proxy in rotation: the old one.
  assert.equal(await rotation(both), old.port);
  const stream = await through(old.port, `${broker}/v1/messages`);
  assert.equal(stream.status, 200);

  // A readiness probe on a connection to the old one opened before its drain: its request
  // comes after.
  const probe = connect(old.port, "127.0.0.1");
  await new Promise((resolve) => probe.on("connect", resolve));
  probe.write("GET /ready HTTP/1.1\r\n");
  let probed = "";
  probe.on("data", (d) => (probed += d));
  const probeClosed = new Promise((resolve) => probe.on("close", resolve));
  await new Promise((resolve) => setTimeout(resolve, 20));

  // The update: the new one is ready, the old one drains, as long as an agent call.
  let grace;
  let drained = null;
  old.server
    .drain({
      graceMs: drainMs("600"),
      setTimer: (fn, ms) => ((grace = ms), setTimeout(fn, ms).unref()),
    })
    .then((all) => (drained = all));
  assert.equal(grace, 600_000);
  probe.write("host: egress\r\n\r\n");
  await probeClosed;
  assert.match(probed, /^HTTP\/1\.1 503 /);

  // New connections: the new proxy, the old one takes none.
  assert.equal(await rotation(both), next.port);
  const quick = await through(next.port, `${broker}/quick`);
  assert.equal(await quick.body(), "quick");
  await assert.rejects(through(old.port, `${broker}/quick`), {
    code: "ECONNREFUSED",
  });

  // The agent's stream goes on through the old one until its end, and the old one exits then.
  streams[0].write("data: 2\n\n");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(drained, null);
  streams[0].end("data: 3\n\n");
  assert.equal(await stream.body(), "data: 1\n\ndata: 2\n\ndata: 3\n\n");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(drained, true);
  assert.deepEqual(clients, ["127.0.0.1", "127.0.0.1"]);
});

test("DRAIN_SECONDS: 25 s alone, any whole number of seconds", () => {
  assert.equal(drainMs(undefined), 25_000);
  assert.equal(drainMs(""), 25_000);
  assert.equal(drainMs("600"), 600_000);
  assert.throws(() => drainMs("10m"), /DRAIN_SECONDS: expected seconds/);
});
