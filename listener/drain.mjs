// Draining an HTTP server on SIGTERM (the listener's broker, the egress proxy): it takes no new
// connection, the requests in flight finish, and each connection closes once its answer is
// sent. A call that comes meanwhile is refused, and the egress proxy tries those it relays again
// until the next one answers (proxy/wait.mjs): an update delays them rather than failing them.
// The proxy's image copies it.

// The listener's: its stop_grace_period in compose.yaml is 5 minutes. What is still going after
// this is cut, a little before Docker kills the process, so that it exits on its own.
export const DRAIN_MS = 280_000;

// The answers a server is sending, which a drain closes the connection of once sent: call it
// as the server is made (`createServer()`), since the drain can't find them afterwards.
const ANSWERS = Symbol("answers");
export function drainable(server) {
  server[ANSWERS] = new Set();
  server.on("request", (req, res) => {
    server[ANSWERS].add(res);
    res.on("close", () => server[ANSWERS].delete(res));
  });
  return server;
}

// Resolves true once every connection of `server` is closed, false when `graceMs` ends first.
// `also`: servers that don't listen but are handed connections (the proxy's decrypted
// tunnels), whose answers close their connection too.
export function drain(server, { graceMs = DRAIN_MS, also = [], setTimer = setTimeout } = {}) {
  for (const s of [server, ...also]) {
    // Before the handler: the answer says the connection closes, and Node closes it once sent.
    s.prependListener("request", (req, res) => res.setHeader("connection", "close"));
    // Answers under way, whose headers may have said keep-alive: their connection ends once
    // they are sent, so that no request comes after them (an agent's next turn on the same
    // connection would start a stream that lengthens the drain).
    for (const res of s[ANSWERS] ?? []) {
      const socket = res.socket;
      res.on("finish", () => socket?.destroySoon());
    }
  }
  return new Promise((resolve) => {
    const timer = setTimer(() => resolve(false), graceMs);
    timer.unref?.();
    // Kept-alive connections idle now, and those of servers that don't track their answers once
    // idle.
    const idle = setInterval(() => server.closeIdleConnections(), 500);
    idle.unref?.();
    server.close(() => {
      clearTimeout(timer);
      clearInterval(idle);
      resolve(true);
    });
  });
}
