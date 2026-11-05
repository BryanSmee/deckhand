// Waiting for the orchestrator's egress policy, or a service the proxy forwards to, while it
// restarts (docs/architecture.md, Restarts): a connection it refused, or that failed before it was made, never reached it, so trying again is safe for
// any call, a push or a POST too. Once a request is sent on a connection, it never is again.

// How long a call waits for one before the sandbox hears it is unreachable: as long as
// the previous one may drain (DRAIN_MS, ../lib/drain.mjs) and the next one start, as with
// one copy of each (compose) the next only starts once the previous one has exited.
export const LISTENER_WAIT_MS = 300_000;

// The errors of a connection that wasn't made: refused (a copy stopped or draining), reset
// while connecting, or no such host (its container gone, Docker's DNS has no name for it).
const NOT_REACHED = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
]);

// An answer that says to ask again, which did nothing: the egress policy's 503 while the runner
// can't tell where a sandbox is (#936).
export class AskAgain extends Error {}

// fetch() wraps the socket's error in its own.
export const notReached = (error) =>
  error instanceof AskAgain || NOT_REACHED.has(error?.code) || NOT_REACHED.has(error?.cause?.code);

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// attempt() until it resolves, while it fails with a connection that wasn't made, with a
// growing delay, for up to `limitMs`; then its last error. `gone()`: the caller left, no use
// trying again.
export async function untilReached(
  attempt,
  { limitMs = LISTENER_WAIT_MS, now = Date.now, sleep = realSleep, gone = () => false } = {},
) {
  const start = now();
  let delay = 250;
  for (;;) {
    try {
      return await attempt();
    } catch (error) {
      const left = start + limitMs - now();
      if (!notReached(error) || left <= 0 || gone()) throw error;
      await sleep(Math.min(delay, left));
      delay = Math.min(delay * 2, 5000);
    }
  }
}
