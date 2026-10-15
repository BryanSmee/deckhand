// What the listener's API endpoints share (anthropic.mjs, openai.mjs): a sandbox's call goes
// on to the provider with the operator's credential in place of the run's secret, and the
// answer streams back as it comes.
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

// Per connection, or the listener's own business: never forwarded either way.
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
// provider can't be reached before anything was sent back.
export function forward(req, res, { target, headers, unreachable, log, what }) {
  const send = target.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve) => {
    const out = send(target, { method: req.method, headers }, (answer) => {
      res.writeHead(answer.statusCode, forwarded(answer.headers));
      // Server-sent events: each chunk goes on as it arrives.
      answer.pipe(res);
      answer.on("end", resolve);
      answer.on("error", () => (res.destroy(), resolve()));
    });
    out.on("error", (error) => {
      log(`${what}: ${req.method} ${target.pathname}: ${error.message}`);
      if (!res.headersSent) unreachable();
      else res.destroy();
      resolve();
    });
    // The agent gave up (an interrupt, the run's end): so does the request upstream.
    res.on("close", () => {
      if (!res.writableFinished) out.destroy();
      resolve();
    });
    req.pipe(out);
  });
}
