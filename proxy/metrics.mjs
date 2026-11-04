// The egress proxy's metrics (#658), on its metrics port (../lib/metrics.mjs): every connection a
// sandbox, an engine, a build or an install makes, what went through it, the policy's answers'
// time, the cache, and the runs' calls passed on to the services. Labelled by who made it and
// why it was refused, as the policy says (../listener/egress-http.mjs), never by host or run:
// those stay in the log lines.
import { performance } from "node:perf_hooks";
import { createRegistry, STATUS_LABELS, statusLabel } from "../lib/metrics.mjs";

// Who made a connection: the policy's answer says (`source`); "unknown" when it didn't answer.
export const SOURCES = ["sandbox", "engine", "build", "install", "none", "unknown"];

// Why: "granted" when allowed; the policy's reasons (not granted, blocked by the agent, no run
// or build at that address, a service's name not forwarded for it), and the proxy's own: the
// host's address private, its name unresolved, a relayed host with nothing to relay it to, the
// policy failing to answer.
export const REASONS = [
  "granted",
  "not_granted",
  "blocked",
  "no_run",
  "no_build",
  "not_forwarded",
  "private_address",
  "unresolved",
  "no_relay",
  "policy_error",
];

// A cached host's request: answered from disk ("hit"), from disk once the host said it hadn't
// changed ("revalidated"), downloaded ("miss", and "stored" once kept), or not through the cache
// at all ("bypassed": credentials, a range, a body, no-store, varied headers).
export const CACHE_RESULTS = ["hit", "revalidated", "miss", "stored", "bypassed"];

// The services the runs' calls go to: the broker (their own run's), the github service (GitHub's
// hosts, the pushes), the models service (the agents').
export const TARGETS = ["broker", "github", "models"];

// The registry's egress metrics, shared by both ports' proxies (the sandboxes' and the engines').
// `cache`: createCache()'s, whose size and limit are read at each scrape.
export function egressMetrics(registry = createRegistry(), { cache = null } = {}) {
  const connections = registry.counter(
    "deckhand_egress_connections_total",
    "Connections (a CONNECT, or a plain HTTP request) by who made them, the decision and its reason.",
    {
      labels: ["source", "decision", "reason"],
      values: { source: SOURCES, decision: ["allowed", "denied"], reason: REASONS },
    },
  );

  // The client sockets still open, each with its source, and the bytes of those closed: the
  // bytes counted at each scrape, a long tunnel's as it goes rather than all at its end.
  const open = new Map(); // socket → source
  const closed = new Map(); // source → { in, out }
  function track(socket, source) {
    if (!socket || open.has(socket) || socket.destroyed) return;
    open.set(socket, source);
    socket.once("close", () => {
      open.delete(socket);
      const total = closed.get(source) ?? { in: 0, out: 0 };
      total.in += socket.bytesWritten ?? 0;
      total.out += socket.bytesRead ?? 0;
      closed.set(source, total);
    });
  }
  registry.counter(
    "deckhand_egress_bytes_total",
    "Bytes between the clients and the proxy: out, sent by the client; in, sent to it.",
    {
      labels: ["source", "direction"],
      values: { source: SOURCES, direction: ["in", "out"] },
      collect: () => {
        const samples = [];
        for (const [source, total] of closed) {
          samples.push([{ source, direction: "in" }, total.in]);
          samples.push([{ source, direction: "out" }, total.out]);
        }
        for (const [socket, source] of open) {
          samples.push([{ source, direction: "in" }, socket.bytesWritten ?? 0]);
          samples.push([{ source, direction: "out" }, socket.bytesRead ?? 0]);
        }
        return samples;
      },
    },
  );
  registry.gauge(
    "deckhand_egress_connections_open",
    "Client connections open, by who made them (a kept-alive one carries several requests).",
    {
      labels: ["source"],
      values: { source: SOURCES },
      collect: () => [...open.values()].map((source) => [{ source }, 1]),
    },
  );

  // "failed": no answer (policy_error), and a wait for a restarting orchestrator counts in its
  // time, up to 5 minutes (wait.mjs): those aren't slow answers.
  const policy = registry.histogram(
    "deckhand_egress_policy_duration_seconds",
    "How long the orchestrator's egress policy took, in seconds: answered, or failed (waits for a restarting orchestrator included).",
    { labels: ["result"], values: { result: ["answered", "failed"] } },
  );

  const cacheRequests = registry.counter(
    "deckhand_egress_cache_requests_total",
    "Requests to cached hosts, by what the cache did with them.",
    { labels: ["result"], values: { result: CACHE_RESULTS } },
  );
  registry.gauge("deckhand_egress_cache_bytes", "Bytes in the cache: kept, and being written.", {
    collect: () => (cache?.enabled ? cache.size : 0),
  });
  registry.gauge(
    "deckhand_egress_cache_max_bytes",
    "The cache's limit (EGRESS_CACHE_MAX), in bytes: 0 when it is off.",
    { collect: () => (cache?.enabled ? cache.max : 0) },
  );

  const gateway = registry.counter(
    "deckhand_egress_gateway_calls_total",
    "The runs' calls passed on to a service, by service and its answer's status (unreachable: none).",
    {
      labels: ["target", "status"],
      values: { target: TARGETS, status: STATUS_LABELS },
      maxSeries: (TARGETS.length + 1) * STATUS_LABELS.length,
    },
  );

  return {
    // A connection decided: counted, and its socket's bytes from now on.
    connection(socket, { source = "unknown", allowed, reason }) {
      const decision = allowed ? "allowed" : "denied";
      connections.inc({ source, decision, reason: allowed ? "granted" : reason });
      track(socket, source);
    },
    // A policy call's timer: the function returned observes its duration, with whether it
    // `failed`.
    policyTimer() {
      const start = performance.now();
      return (failed) =>
        policy.observe(
          { result: failed ? "failed" : "answered" },
          (performance.now() - start) / 1000,
        );
    },
    cache: (result) => cacheRequests.inc({ result }),
    gateway: (target, status) => gateway.inc({ target, status: statusLabel(status) }),
  };
}
