// Draining on SIGTERM (lib/drain.mjs): the broker, or the egress proxy, takes no new
// connection while the calls in flight finish, then resolves; or the grace period ends first.
import assert from "node:assert/strict";
import { Agent, request } from "node:http";
import { test } from "node:test";
import { drain, drainable } from "../lib/drain.mjs";
import { serve } from "./helpers.mjs";

// A server whose /stream answers (an agent's) stay open in `streams`, for the test to write
// and end; /quick answers at once.
async function streaming(t) {
  const streams = [];
  const served = [];
  const { server, port } = await serve(t, (req, res) => {
    served.push(req.url);
    if (req.url === "/quick") return res.end("quick");
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: 1\n\n");
    streams.push(res);
  });
  // As the broker's and the proxy's: its answers tracked for a drain.
  drainable(server);
  return { server, port, streams, served };
}

// GET /path on a kept-alive connection → { status, headers, body() }, once the headers came.
function get(port, path, agent) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, agent }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (d) => (body += d));
      const ended = new Promise((done) => res.on("end", () => done(body)));
      resolve({ status: res.statusCode, headers: res.headers, body: () => ended });
    });
    req.on("error", reject);
    req.end();
  });
}

const refused = (port) =>
  assert.rejects(
    get(port, "/quick", false).then((res) => res.body()),
    (error) => error.code === "ECONNREFUSED",
  );

test("a draining server refuses new connections, and a stream in flight finishes", async (t) => {
  const { server, port, streams } = await streaming(t);
  const stream = await get(port, "/stream", false);
  assert.equal(stream.status, 200);
  let done = false;
  const drained = drain(server).then((all) => ((done = true), all));

  await refused(port);
  // The stream goes on until its end.
  streams[0].write("data: 2\n\n");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(done, false);
  streams[0].end("data: 3\n\n");
  assert.equal(await stream.body(), "data: 1\n\ndata: 2\n\ndata: 3\n\n");
  assert.equal(await drained, true);
});

test("a kept-alive connection: closed as soon as its answer is sent, no request after it", async (t) => {
  const { server, port, streams } = await streaming(t);
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  t.after(() => agent.destroy());
  // An answer started before the drain, on a connection kept alive.
  const stream = await get(port, "/stream", agent);
  const drained = drain(server);
  streams[0].end();
  await stream.body();
  // Closed with it, so the server ends.
  assert.equal(await drained, true);

  // A request queued on a kept-alive connection open when the drain began (an agent's next
  // turn): never served, the connection gone with the answer before it.
  const again = await streaming(t);
  const other = new Agent({ keepAlive: true, maxSockets: 1 });
  t.after(() => other.destroy());
  const first = await get(again.port, "/stream", other);
  const draining = drain(again.server);
  const second = get(again.port, "/quick", other).then((res) => res.body());
  again.streams[0].end();
  await first.body();
  await assert.rejects(second);
  assert.equal(await draining, true);
  assert.deepEqual(again.served, ["/stream"]);

  // Without the drain's interval: closed at once, not at its next tick.
  const quick = await streaming(t);
  const third = new Agent({ keepAlive: true, maxSockets: 1 });
  t.after(() => third.destroy());
  const open = await get(quick.port, "/stream", third);
  const started = Date.now();
  const ended = drain(quick.server);
  quick.streams[0].end();
  await open.body();
  assert.equal(await ended, true);
  assert.ok(Date.now() - started < 400, `${Date.now() - started} ms`);
});

test("the grace period ends first: resolves false", async (t) => {
  const { server, port, streams } = await streaming(t);
  await get(port, "/stream", false);
  let ends;
  const drained = drain(server, {
    graceMs: 280_000,
    setTimer: (fn, ms) => ((ends = { fn, ms }), { unref() {} }),
  });
  assert.equal(ends.ms, 280_000);
  ends.fn();
  assert.equal(await drained, false);
  streams[0].destroy();
});
