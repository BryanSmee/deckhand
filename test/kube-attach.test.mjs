// A pod's attach through the API server (listener/runner/kube-attach.mjs, kube-api.mjs
// attach()): the WebSocket channel protocol v5 over node:http's upgrade, against a server that
// plays the API server's side: stdin in, its end on channel 255, stdout and stderr out.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { request } from "node:http";
import { test } from "node:test";
import { createKubeApi } from "../listener/runner/kube-api.mjs";
import { frame, inClusterUpgrade, parseFrame, PROTOCOL } from "../listener/runner/kube-attach.mjs";
import { serve } from "./helpers.mjs";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

// A server frame: unmasked.
function serverFrame(opcode, payload) {
  const head =
    payload.length < 126
      ? Buffer.from([0x80 | opcode, payload.length])
      : Buffer.from([0x80 | opcode, 126, payload.length >> 8, payload.length & 0xff]);
  return Buffer.concat([head, payload]);
}

// An API server whose attach upgrades: `container(stdin)` → { out, err } once stdin ended.
// `protocol`: what it answers in Sec-WebSocket-Protocol. `ending`: "close" (channel 3's
// Success, then a close frame, as the API server ends it), "cut" (the connection dropped
// without a close frame) or a Status channel 3 says instead. Every request is in `requests`.
async function fakeAttach(
  t,
  { container, protocol = PROTOCOL, status = 101, ending = "close" } = {},
) {
  const requests = [];
  const { url, server } = await serve(t, (req, res) => {
    res.writeHead(403, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: 'pods "x" is forbidden: cannot create pods/attach' }));
  });
  server.on("upgrade", (req, socket) => {
    requests.push({ url: req.url, headers: req.headers });
    if (status !== 101) {
      const body = JSON.stringify({ message: "forbidden" });
      socket.end(
        `HTTP/1.1 ${status} Forbidden\r\ncontent-type: application/json\r\ncontent-length: ${body.length}\r\n\r\n${body}`,
      );
      return;
    }
    const accept = createHash("sha1")
      .update(req.headers["sec-websocket-key"] + GUID)
      .digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-accept: ${accept}\r\nsec-websocket-protocol: ${protocol}\r\n\r\n`,
    );
    // Each stream's first, empty message, as the API server sends them.
    socket.write(serverFrame(2, Buffer.from([1])));
    socket.write(serverFrame(9, Buffer.from("ping")));
    let buffer = Buffer.alloc(0);
    const stdin = [];
    const seen = { masked: true, pong: false };
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (let f = parseFrame(buffer); f; f = parseFrame(buffer)) {
        seen.masked &&= Boolean(buffer[1] & 0x80);
        buffer = f.rest;
        if (f.opcode === 0xa) seen.pong = true;
        if (f.opcode === 0x8) return socket.end();
        if (f.opcode !== 2) continue;
        if (f.payload[0] === 0) stdin.push(f.payload.subarray(1));
        if (f.payload[0] === 255 && f.payload[1] === 0) {
          const { out, err } = container(Buffer.concat(stdin).toString());
          // stdout in two fragments, then stderr, then the end.
          const half = Math.floor(out.length / 2);
          socket.write(
            Buffer.concat([Buffer.from([0x02, half + 1, 1]), Buffer.from(out.slice(0, half))]),
          );
          const rest = Buffer.from(out.slice(half));
          socket.write(Buffer.concat([Buffer.from([0x80, rest.length]), rest]));
          socket.write(serverFrame(2, Buffer.concat([Buffer.from([2]), Buffer.from(err)])));
          requests.at(-1).seen = seen;
          if (ending === "cut") return socket.destroy();
          const said = ending === "close" ? { metadata: {}, status: "Success" } : ending;
          socket.write(serverFrame(2, Buffer.from([3, ...Buffer.from(JSON.stringify(said))])));
          socket.write(serverFrame(8, Buffer.from([0x03, 0xe8])));
        }
      }
    });
  });
  const api = createKubeApi({
    base: url,
    token: () => "sa-token",
    namespace: "runs",
    fetch: () => assert.fail("no plain call"),
    upgrade: inClusterUpgrade({ request }),
  });
  return { api, requests };
}

test("attach: the input on stdin then its end, stdout and stderr back apart", async (t) => {
  const { api, requests } = await fakeAttach(t, {
    container: (stdin) => ({ out: `{"read":${JSON.stringify(stdin)}}`, err: "agy: done\n" }),
  });
  const result = await api.attach(
    "pods/dh-job-x/attach",
    { container: "job", stdin: "true", stdout: "true", stderr: "true" },
    { input: '{"token":"ya29.old"}' },
  );
  assert.deepEqual(result, {
    out: '{"read":"{\\"token\\":\\"ya29.old\\"}"}',
    err: "agy: done\n",
  });
  const [req] = requests;
  assert.equal(
    req.url,
    "/api/v1/namespaces/runs/pods/dh-job-x/attach?container=job&stdin=true&stdout=true&stderr=true",
  );
  assert.equal(req.headers.authorization, "Bearer sa-token");
  assert.equal(req.headers["sec-websocket-protocol"], PROTOCOL);
  // Every frame of the client's masked, and the server's ping answered.
  assert.deepEqual(req.seen, { masked: true, pong: true });
});

test("attach: a refused upgrade is the API's error, an older protocol is said", async (t) => {
  const refused = await fakeAttach(t, { status: 403 });
  await assert.rejects(
    refused.api.attach("pods/p/attach", {}, { input: "x" }),
    (error) => error.status === 403 && /GET pods\/p\/attach: forbidden/.test(error.message),
  );
  const older = await fakeAttach(t, {
    protocol: "v4.channel.k8s.io",
    container: () => assert.fail("no input sent"),
  });
  await assert.rejects(
    older.api.attach("pods/p/attach", {}, { input: "x" }),
    /speaks v4\.channel\.k8s\.io, not v5\.channel\.k8s\.io \(Kubernetes 1\.30 or later\)/,
  );
});

test("attach: a stream cut before its close frame, or a Status that isn't Success, fails", async (t) => {
  const container = () => ({ out: '{"token":"half', err: "" });
  const cut = await fakeAttach(t, { container, ending: "cut" });
  await assert.rejects(
    cut.api.attach("pods/p/attach", {}, { input: "x" }),
    /the attach stream ended before its close frame/,
  );
  const failed = await fakeAttach(t, {
    container,
    ending: { status: "Failure", message: "error attaching to container: container not found" },
  });
  await assert.rejects(
    failed.api.attach("pods/p/attach", {}, { input: "x" }),
    /the API server said: error attaching to container: container not found/,
  );
});

test("frames: a client's masked, of any length, read back whole or not yet", () => {
  for (const size of [0, 5, 125, 126, 65535, 70000]) {
    const payload = Buffer.alloc(size, 7);
    const encoded = frame(2, payload);
    assert.equal(encoded[0], 0x82);
    assert.ok(encoded[1] & 0x80, "masked");
    const parsed = parseFrame(Buffer.concat([encoded, Buffer.from([1])]));
    assert.equal(parsed.opcode, 2);
    assert.equal(parsed.fin, true);
    assert.ok(parsed.payload.equals(payload), `${size} bytes`);
    assert.deepEqual([...parsed.rest], [1]);
    assert.equal(parseFrame(encoded.subarray(0, -1)), null);
  }
});
