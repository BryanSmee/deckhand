// Draining on SIGTERM (listener/drain.mjs): the broker, or the egress proxy, takes no new
// connection while the calls in flight finish, then resolves; or the grace period ends first.
import assert from "node:assert/strict";
import { Agent, request } from "node:http";
import { test } from "node:test";
import { drain } from "../listener/drain.mjs";
import { serve } from "./helpers.mjs";

// A server whose /stream answers (an agent's) stay open in `streams`, for the test to write
// and end; /quick answers at once.
async function streaming(t) {
  const streams = [];
  const { server, port } = await serve(t, (req, res) => {
    if (req.url === "/quick") return res.end("quick");
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: 1\n\n");
    streams.push(res);
  });
  return { server, port, streams };
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

test("a kept-alive connection: closed once its answer is sent, its next request says so", async (t) => {
  const { server, port, streams } = await streaming(t);
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  t.after(() => agent.destroy());
  // An answer started before the drain, on a connection kept alive.
  const stream = await get(port, "/stream", agent);
  const drained = drain(server);
  streams[0].end();
  await stream.body();
  // Idle now: closed, so the server ends.
  assert.equal(await drained, true);

  // A request on a kept-alive connection open when the drain began: answered, then closed.
  const again = await streaming(t);
  const other = new Agent({ keepAlive: true, maxSockets: 1 });
  t.after(() => other.destroy());
  const first = await get(again.port, "/stream", other);
  const draining = drain(again.server);
  const second = get(again.port, "/quick", other);
  again.streams[0].end();
  await first.body();
  const answer = await second;
  assert.equal(answer.headers.connection, "close");
  assert.equal(await answer.body(), "quick");
  assert.equal(await draining, true);
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
