// Draining an HTTP server on SIGTERM (the listener's broker, the egress proxy): it takes no new
// connection, the requests in flight finish, and each connection closes once its answer is
// sent. A call that comes meanwhile is refused, and the egress proxy tries it again until the
// next one answers (proxy/wait.mjs): an update delays the runs' calls rather than failing them.
// The proxy's image copies it.

// compose.yaml's stop_grace_period is 5 minutes: what is still going after this is cut, a little
// before Docker kills the process, so that it exits on its own.
export const DRAIN_MS = 280_000;

// Resolves true once every connection of `server` is closed, false when `graceMs` ends first.
// `also`: servers that don't listen but are handed connections (the proxy's decrypted
// tunnels), whose answers close their connection too.
export function drain(server, { graceMs = DRAIN_MS, also = [], setTimer = setTimeout } = {}) {
  // Before the handler: the answer says the connection closes, and Node closes it once sent.
  for (const s of [server, ...also]) {
    s.prependListener("request", (req, res) => res.setHeader("connection", "close"));
  }
  return new Promise((resolve) => {
    const timer = setTimer(() => resolve(false), graceMs);
    timer.unref?.();
    // Answers started before the drain leave a kept-alive connection idle once sent: closed
    // then, as are those idle now.
    const idle = setInterval(() => server.closeIdleConnections(), 500);
    idle.unref?.();
    server.close(() => {
      clearTimeout(timer);
      clearInterval(idle);
      resolve(true);
    });
  });
}
