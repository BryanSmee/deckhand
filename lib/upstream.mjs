// Forwarding a call to another HTTP server as it comes, its answer streamed back (#504): what the
// models service's agent endpoints (../models/upstream.mjs), the listener's GitHub gateway
// (../listener/github-gateway.mjs) and its relay of the agents' calls to the models service
// (../listener/models-service.mjs) share. No dependencies: node:http, node:https.
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { RUN_TOKEN_HEADER, SANDBOX_HEADER } from "./broker-client.mjs";

// A call that gets no byte from the provider (or the agent) for this long is cut off.
export const IDLE_MS = 10 * 60_000;
// Calls one run may have in flight at once, through all of a service's endpoints.
export const MAX_IN_FLIGHT = 16;

// Per connection, or Deckhand's own business: never forwarded either way.
const HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "proxy-authorization",
  "proxy-authenticate",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  // The sandbox's address, which the egress proxy adds to the calls it relays (proxy.mjs).
  "x-deckhand-client",
  // What the proxy or the listener vouches for to the models service: the sandbox's network
  // (or pod), its run token (lib/broker-client.mjs).
  SANDBOX_HEADER,
  RUN_TOKEN_HEADER,
]);

export function forwarded(headers, drop = []) {
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !HOP.has(name) && !drop.includes(name)),
  );
}

// "https://api.openai.com/v1/" → its URL with a trailing slash, for paths relative to it.
export function baseOf(upstream) {
  return new URL(upstream.replace(/\/?$/, "/"));
}

// `req` to `target` with `headers`, its answer back to `res`. `unreachable()` answers when the
// provider can't be reached before anything was sent back. `answered(status, headers, lost)`:
// the provider's status and headers, 502 (no headers, `lost` true) when it can't be reached or
// its answer never came, though the request may have gone out (what a fallback reads, agents/
// providerError()).
// `idleMs`: how long the call may go without a byte either way before it is cut off, on
// `clock`'s timers: a stalled provider doesn't hold a service every run shares. `body`: what
// is sent in place of the request's own, already read (github-gateway.mjs's redacted writes).
// `tap(chunk)`: each chunk of the answer too, as it goes on (github-gateway.mjs's writes).
// `follow(status, headers)`: { target, headers } to fetch instead with a GET, its answer sent
// back in place of this one (github-gateway.mjs's Actions logs, a redirect to a storage host
// the sandbox can't reach), or null; asked of the first answer only.
// `transform(status, headers, body)`: the answer read whole, up to `maxTransform` bytes, and
// sent back as it returns it (null: as it was); past that size, it goes on as it comes, as is
// (github-gateway.mjs's GraphQL reads without a permission, whose error it explains).
export function forward(
  req,
  res,
  {
    target,
    headers,
    unreachable,
    log,
    what,
    answered = () => {},
    idleMs = IDLE_MS,
    clock = globalThis,
    body,
    tap,
    follow,
    transform,
    maxTransform = 1024 * 1024,
  },
) {
  const sender = (url) => (url.protocol === "https:" ? httpsRequest : httpRequest);
  return new Promise((done) => {
    let timer = null;
    let ended = false;
    const resolve = () => {
      ended = true;
      clock.clearTimeout(timer);
      req.off("data", idle);
      done();
    };
    const onAnswer = (answer, first) => {
      const next = first ? follow?.(answer.statusCode, answer.headers) : null;
      if (next) {
        answer.resume();
        out = sender(next.target)(next.target, { method: "GET", headers: next.headers }, (again) =>
          onAnswer(again, false),
        );
        out.on("error", failed);
        out.end();
        return;
      }
      if (transform) return transformed(answer);
      answered(answer.statusCode, answer.headers);
      res.writeHead(answer.statusCode, forwarded(answer.headers));
      // Server-sent events: each chunk goes on as it arrives.
      answer.on("data", idle);
      if (tap) answer.on("data", tap);
      answer.pipe(res);
      answer.on("end", resolve);
      answer.on("error", () => (res.destroy(), resolve()));
    };
    // The answer held until it ends, then transform()'s; past maxTransform, what was held and
    // the rest go on as they come.
    const transformed = (answer) => {
      const chunks = [];
      let size = 0;
      let passing = false;
      answer.on("data", idle);
      if (tap) answer.on("data", tap);
      answer.on("data", (chunk) => {
        if (passing) return void res.write(chunk);
        chunks.push(chunk);
        size += chunk.length;
        if (size <= maxTransform) return;
        passing = true;
        answered(answer.statusCode, answer.headers);
        res.writeHead(answer.statusCode, forwarded(answer.headers));
        for (const held of chunks) res.write(held);
      });
      answer.on("end", () => {
        if (passing) return (res.end(), resolve());
        const held = Buffer.concat(chunks);
        let body = held;
        try {
          body = transform(answer.statusCode, answer.headers, held) ?? held;
        } catch (error) {
          log(`${what}: ${req.method} ${target.pathname}: ${error.message}`);
        }
        answered(answer.statusCode, answer.headers);
        res.writeHead(answer.statusCode, {
          ...forwarded(answer.headers),
          "content-length": String(body.length),
        });
        res.end(body);
        resolve();
      });
      answer.on("error", () => (res.destroy(), resolve()));
    };
    let out = sender(target)(target, { method: req.method, headers }, (answer) =>
      onAnswer(answer, true),
    );
    function idle() {
      if (ended) return;
      clock.clearTimeout(timer);
      timer = clock.setTimeout(() => {
        out.destroy(new Error(`no bytes for ${Math.round(idleMs / 1000)} s`));
        // Already answering: the agent sees its stream end early, and may retry.
        if (res.headersSent) (res.destroy(), resolve());
      }, idleMs);
    }
    idle();
    req.on("data", idle);
    function failed(error) {
      log(`${what}: ${req.method} ${target.pathname}: ${error.message}`);
      if (!res.headersSent) {
        answered(502, {}, true);
        unreachable();
      } else res.destroy();
      resolve();
    }
    out.on("error", failed);
    // The agent gave up (an interrupt, the run's end): so does the request upstream.
    res.on("close", () => {
      if (!res.writableFinished) out.destroy();
      resolve();
    });
    if (body === undefined) req.pipe(out);
    else out.end(body);
  });
}
