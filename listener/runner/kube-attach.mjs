// A pod's stdin, stdout and stderr through the API server (`pods/<name>/attach`, kube-api.mjs
// attach()): the WebSocket channel protocol v5 (`v5.channel.k8s.io`, Kubernetes 1.30+), whose
// channel 255 closes stdin, which a job that reads its input to the end needs (v4 has no
// way to). No library: node:https's upgrade and RFC 6455's framing, the client's side only.
import { createHash, randomBytes } from "node:crypto";
import { request as httpsRequest } from "node:https";

export const PROTOCOL = "v5.channel.k8s.io";
const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

// The protocol's channels: each binary message's first byte.
const STDIN = 0;
const STDOUT = 1;
const STDERR = 2;
const ERROR = 3;
const CLOSE = 255;

// RFC 6455's opcodes.
const CONTINUATION = 0x0;
const BINARY = 0x2;
const CLOSING = 0x8;
const PING = 0x9;
const PONG = 0xa;

// What is kept of stdout and of stderr, each: a job's output is small (a token file).
const MAX_OUTPUT = 1024 * 1024;

// An HTTP upgrade over node:https that trusts the cluster's CA (`ca()`, read at the first
// call: the tests' APIs never read it), which fetch() can't do. → { status, socket, head,
// headers } once the server switched protocols, else { status, text }: its answer.
export function inClusterUpgrade({ ca, request = httpsRequest } = {}) {
  let read;
  return (url, headers, signal) =>
    new Promise((resolve, reject) => {
      const req = request(url, {
        headers: { ...headers, connection: "Upgrade", upgrade: "websocket" },
        ...(ca ? { ca: (read ??= ca()) } : {}),
        signal,
      });
      req.on("upgrade", (res, socket, head) =>
        resolve({ status: res.statusCode, headers: res.headers, socket, head }),
      );
      req.on("response", (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString() }),
        );
        res.on("error", reject);
      });
      req.on("error", reject);
      req.end();
    });
}

// The handshake's headers, with `key`: what the answer's Sec-WebSocket-Accept must hash.
export function handshake() {
  const key = randomBytes(16).toString("base64");
  return {
    key,
    headers: {
      "sec-websocket-key": key,
      "sec-websocket-version": "13",
      "sec-websocket-protocol": PROTOCOL,
    },
  };
}

// Why an upgraded answer isn't this protocol's, or null.
export function handshakeProblem({ headers = {} }, key) {
  const accept = createHash("sha1")
    .update(key + GUID)
    .digest("base64");
  if (headers["sec-websocket-accept"] !== accept) return "a WebSocket answer that doesn't match";
  if (headers["sec-websocket-protocol"] !== PROTOCOL) {
    return `the API server speaks ${headers["sec-websocket-protocol"] || "no channel protocol"}, not ${PROTOCOL} (Kubernetes 1.30 or later)`;
  }
  return null;
}

// A client's frame: masked, as RFC 6455 requires of it.
export function frame(opcode, payload = Buffer.alloc(0)) {
  const length = payload.length;
  let head;
  if (length < 126) head = Buffer.from([0x80 | opcode, 0x80 | length]);
  else if (length < 65536) {
    head = Buffer.from([0x80 | opcode, 0x80 | 126, 0, 0]);
    head.writeUInt16BE(length, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x80 | opcode;
    head[1] = 0x80 | 127;
    head.writeBigUInt64BE(BigInt(length), 2);
  }
  const mask = randomBytes(4);
  const body = Buffer.alloc(length);
  for (let i = 0; i < length; i++) body[i] = payload[i] ^ mask[i & 3];
  return Buffer.concat([head, mask, body]);
}

// The first whole frame of `buffer`: { fin, opcode, payload, rest }, or null until there is one.
export function parseFrame(buffer) {
  if (buffer.length < 2) return null;
  const fin = Boolean(buffer[0] & 0x80);
  const opcode = buffer[0] & 0x0f;
  const masked = Boolean(buffer[1] & 0x80);
  let length = buffer[1] & 0x7f;
  let at = 2;
  if (length === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(2);
    at = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return null;
    length = Number(buffer.readBigUInt64BE(2));
    at = 10;
  }
  const mask = masked ? buffer.subarray(at, at + 4) : null;
  if (masked) at += 4;
  if (buffer.length < at + length) return null;
  let payload = buffer.subarray(at, at + length);
  if (mask) payload = Buffer.from(payload.map((b, i) => b ^ mask[i & 3]));
  return { fin, opcode, payload, rest: buffer.subarray(at + length) };
}

// `input` on the attached container's stdin, then its end; its stdout and stderr until the
// server closes (the container ended). → { out, err, error }: `error`, what channel 3 said
// (a Status), or null. `signal` cuts it short, rejecting.
export function exchange({ socket, head = Buffer.alloc(0) }, { input, signal } = {}) {
  return new Promise((resolve, reject) => {
    const out = [];
    const err = [];
    const error = [];
    const sizes = { [STDOUT]: 0, [STDERR]: 0 };
    let buffer = Buffer.alloc(0);
    let message = null; // a fragmented message's opcode and parts
    let done = false;

    function finish(failure) {
      if (done) return;
      done = true;
      signal?.removeEventListener("abort", aborted);
      socket.destroy();
      if (failure) return reject(failure);
      let status = null;
      try {
        status = error.length ? JSON.parse(Buffer.concat(error).toString()) : null;
      } catch {
        status = { message: Buffer.concat(error).toString() };
      }
      resolve({
        out: Buffer.concat(out).toString(),
        err: Buffer.concat(err).toString(),
        error: status,
      });
    }
    const aborted = () => finish(signal.reason ?? new Error("aborted"));

    function onMessage(payload) {
      if (!payload.length) return;
      const data = payload.subarray(1);
      if (payload[0] === ERROR) error.push(data);
      const into = { [STDOUT]: out, [STDERR]: err }[payload[0]];
      if (!into || sizes[payload[0]] >= MAX_OUTPUT) return;
      const kept = data.subarray(0, MAX_OUTPUT - sizes[payload[0]]);
      sizes[payload[0]] += kept.length;
      into.push(kept);
    }

    function onData(chunk) {
      buffer = Buffer.concat([buffer, chunk]);
      for (let f = parseFrame(buffer); f; f = parseFrame(buffer)) {
        buffer = f.rest;
        if (f.opcode === PING) socket.write(frame(PONG, f.payload));
        else if (f.opcode === CLOSING) {
          socket.write(frame(CLOSING, f.payload.subarray(0, 2)));
          return finish();
        } else if (f.opcode === CONTINUATION && message) {
          message.parts.push(f.payload);
          if (f.fin) {
            onMessage(Buffer.concat(message.parts));
            message = null;
          }
        } else if (f.opcode === BINARY) {
          if (f.fin) onMessage(f.payload);
          else message = { parts: [f.payload] };
        }
      }
    }

    if (signal?.aborted) return aborted();
    signal?.addEventListener("abort", aborted, { once: true });
    socket.on("data", onData);
    socket.on("end", () => finish());
    socket.on("close", () => finish());
    socket.on("error", (e) => finish(e));
    if (input !== undefined && input !== null && String(input).length) {
      socket.write(frame(BINARY, Buffer.concat([Buffer.from([STDIN]), Buffer.from(input)])));
    }
    socket.write(frame(BINARY, Buffer.from([CLOSE, STDIN])));
    if (head.length) onData(head);
  });
}
