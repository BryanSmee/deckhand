// The egress proxy's handover during an update (docs/services.md): a second copy on the same
// network takes the new connections while the old one drains, as long as an agent call lasts,
// so an agent stream through the old one finishes and no sandbox connection is refused.
import assert from "node:assert/strict";
import { request } from "node:http";
import { test } from "node:test";
import { createProxy, drainMs } from "../proxy/proxy.mjs";
import { listening, serve } from "./helpers.mjs";

// A proxy allowing every host, all at 127.0.0.1: the fake agents' API below.
async function proxy(t) {
  const server = createProxy({
    policy: async () => ({ allowed: true, private: true }),
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
  const { port: api } = await serve(t, (req, res) => {
    if (req.url === "/quick") return res.end("quick");
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: 1\n\n");
    streams.push(res);
  });
  const old = await proxy(t);
  const next = await proxy(t);
  const both = [old, next];

  // An agent call, through the proxy in rotation: the old one.
  assert.equal(await rotation(both), old.port);
  const stream = await through(old.port, `http://agent.example:${api}/v1/messages`);
  assert.equal(stream.status, 200);

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

  // New connections: the new proxy, the old one takes none.
  assert.equal(await rotation(both), next.port);
  const quick = await through(next.port, `http://agent.example:${api}/quick`);
  assert.equal(await quick.body(), "quick");
  await assert.rejects(through(old.port, `http://agent.example:${api}/quick`), {
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
});

test("DRAIN_SECONDS: 25 s alone, any whole number of seconds", () => {
  assert.equal(drainMs(undefined), 25_000);
  assert.equal(drainMs(""), 25_000);
  assert.equal(drainMs("600"), 600_000);
  assert.throws(() => drainMs("10m"), /DRAIN_SECONDS: expected seconds/);
});
