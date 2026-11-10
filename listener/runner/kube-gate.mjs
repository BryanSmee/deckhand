// The network gate (#647): an init container first in every pod the runner makes in the
// sandboxes' namespace (the sandboxes, the agents' installs and jobs, the caches' checks, the
// network probe), so that nothing of theirs runs before their NetworkPolicies apply. Some
// network plugins apply them a moment after the pod has its address (kube-router, from the
// pod's events; Calico programs them once the pod's network is up): in between, its traffic
// isn't filtered, and a probe that tried its targets then would see them reached.
//
// The gate tries, every RETRY_MS, a TCP connection to addresses no pod of that namespace may
// reach (the API server, the cluster's DNS: the runner's own, which answer it) and, for a pod
// that goes out through it, to the egress proxy. It exits 0 once the first are out of reach
// (refused, or no answer within CONNECT_MS) and the proxy answers: the pod's rules are in place,
// not merely its network down. Past its deadline, it exits LEAK when one it mustn't reach still
// answered, CLOSED when only the proxy never did, and its pod fails: fail closed. That deadline
// is a time, not a wait: MARGIN_MS before its caller gives up on the pod (KUBERNETES_PENDING_
// MINUTES from its creation, a cache's check's or a job's own limit), so that its failure, and
// what it still reached, is what the run is told, rather than "Pending for 10 min".
import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { restrictedContainer } from "./kube-names.mjs";

// The gate's container, in its pod and in its log's URL.
export const GATE_CONTAINER = "network-gate";

// Its exit codes past its deadline: a target its policies forbid still reached, or the egress
// proxy never reached.
export const LEAK = 3;
export const CLOSED = 4;

// How long a connection is tried before it counts as out of reach: the gate's and the probe's.
export const CONNECT_MS = 3000;
const RETRY_MS = 500;

// How long before its caller's limit the gate gives up: its last round (CONNECT_MS and
// RETRY_MS), the kubelet reporting it, the runner's next look (every 2 s), and the node's clock
// a little off the runner's.
export const MARGIN_MS = 30_000;

// A TCP connection tried within CONNECT_MS, as a script's source (`net` is node:net there):
// `tcp({ host, port })` resolves true when it connected. The gate's script and the probe's.
export const TCP_TRY = `
const tcp = ({ host, port }) => new Promise((resolve) => {
  const socket = net.connect({ host, port, timeout: ${CONNECT_MS} });
  const done = (reached) => { socket.destroy(); resolve(reached); };
  socket.on("connect", () => done(true));
  socket.on("timeout", () => done(false));
  socket.on("error", () => done(false));
});
`;

// What pendingReason() (kubernetes.mjs) says while the gate waits.
export const GATING = "its init container waits for its NetworkPolicies to apply";

// What the gate runs (node, which the base image has): argv[1] a JSON array of
// { what, host, port, reach }, argv[2] its deadline, in ms since the epoch. Its last line says
// what it found, in words: the runner quotes it.
export const GATE_SCRIPT = `
const net = require("node:net");
${TCP_TRY}
const at = ({ host, port }) => (net.isIPv6(host) ? "[" + host + "]" : host) + ":" + port;
const says = (list) => list.map((t) => t.what + " (" + at(t) + ")").join(", ");
const targets = JSON.parse(process.argv[1]);
const started = Date.now();
const until = Number(process.argv[2]);
(async () => {
  for (;;) {
    const reached = await Promise.all(targets.map(tcp));
    const leaks = targets.filter((t, i) => !t.reach && reached[i]);
    const missed = targets.filter((t, i) => t.reach && !reached[i]);
    const s = Math.round((Date.now() - started) / 1000);
    if (!leaks.length && !missed.length) {
      console.log("Its NetworkPolicies apply (" + s + " s)");
      return;
    }
    if (Date.now() >= until) {
      const what = leaks.length
        ? "still reached " + says(leaks) + " after "
        : "never reached " + says(missed) + " in ";
      console.log(what + s + " s");
      process.exit(leaks.length ? ${LEAK} : ${CLOSED});
    }
    await new Promise((resolve) => setTimeout(resolve, ${RETRY_MS}));
  }
})();
`;

// The nameservers of a resolv.conf.
export const nameservers = (text) =>
  [...text.matchAll(/^\s*nameserver\s+(\S+)/gm)].map((m) => m[1].replace(/%.*$/, ""));

// What no pod of the sandboxes' namespace may reach, and the runner does: the API server (the
// `kubernetes` Service) and the cluster's DNS, TCP. Throws when it knows neither: a gate with
// nothing to wait on would prove nothing.
export function forbiddenTargets({ env = process.env, resolvConf = readResolvConf } = {}) {
  const list = [];
  if (env.KUBERNETES_SERVICE_HOST) {
    list.push({
      what: "the Kubernetes API server",
      host: env.KUBERNETES_SERVICE_HOST,
      port: Number(env.KUBERNETES_SERVICE_PORT || 443),
    });
  }
  let dns = [];
  try {
    dns = nameservers(resolvConf());
  } catch {}
  for (const host of dns.filter((h) => isIP(h))) {
    list.push({ what: "the cluster's DNS", host, port: 53 });
  }
  if (!list.length) {
    throw new Error(
      "the runner knows no address the sandboxes mustn't reach (neither KUBERNETES_SERVICE_HOST nor a nameserver in its resolv.conf) for their pods to wait on until their NetworkPolicies apply",
    );
  }
  return list;
}

const readResolvConf = () => readFileSync("/etc/resolv.conf", "utf8");

// The gates of one runner: `config` (its image, KUBERNETES_PENDING_MINUTES), `env` and
// `resolvConf` (the tests'), the forbidden targets read once; `now`, the runner's clock.
export function createNetworkGate({ config, env, resolvConf, now = Date.now } = {}) {
  let forbidden = null;
  return {
    // The init container of a pod about to be made: `proxy` ({ host, port }, the egress proxy
    // as the pod reaches it) when the pod goes out through it, null when it may reach nothing
    // at all; `withinMs`, how long from now its caller waits for the pod to start (by default
    // KUBERNETES_PENDING_MINUTES, as for a sandbox), its deadline MARGIN_MS before that.
    container({ proxy = null, withinMs = config.kubernetes.pendingMs } = {}) {
      forbidden ??= forbiddenTargets({ env, resolvConf });
      const targets = [
        ...forbidden.map((t) => ({ ...t, reach: false })),
        ...(proxy ? [{ what: "the egress proxy", ...proxy, reach: true }] : []),
      ];
      return gateContainer({
        image: config.image,
        targets,
        until: now() + Math.max(withinMs - MARGIN_MS, 0),
      });
    },
  };
}

// The gate's container, from `image` (the base image's node), Pod Security `restricted` as the
// pod's user, small: it only connects.
function gateContainer({ image, targets, until }) {
  const resources = { cpu: "100m", memory: "128Mi" };
  return {
    name: GATE_CONTAINER,
    image,
    command: ["node", "-e", GATE_SCRIPT, JSON.stringify(targets), String(until)],
    resources: { limits: resources, requests: resources },
    securityContext: restrictedContainer(),
  };
}

// The egress proxy as a pod reaches it: its Service's cluster IP (`proxySvc`, kubernetes.mjs
// proxyService()), else EGRESS_PROXY's address, on EGRESS_PROXY's port.
export function proxyTarget(config, proxySvc) {
  const url = new URL(config.egressProxy);
  return {
    host: proxySvc?.ip ?? url.hostname.replace(/^\[|\]$/g, ""),
    port: Number(url.port || 3128),
  };
}

// The gate's exit code when it failed, else null.
export function failedGate(pod) {
  const code = (pod.status?.initContainerStatuses ?? []).find((s) => s.name === GATE_CONTAINER)
    ?.state?.terminated?.exitCode;
  return code === undefined || code === 0 ? null : code;
}

// Whether the gate is still waiting.
export const gating = (pod) =>
  (pod.status?.initContainerStatuses ?? []).some(
    (s) => s.name === GATE_CONTAINER && s.state?.running,
  );

// Why a pod's gate failed, from its exit code and its log's last line (`said`, which says how
// long it waited).
export function gateProblem(code, said) {
  const what = said ? `: ${said}` : "";
  if (code === LEAK) return `its NetworkPolicies didn't apply${what}`;
  if (code === CLOSED) return `its NetworkPolicies didn't let it reach the egress proxy${what}`;
  return `its init container ${GATE_CONTAINER} failed (exit ${code})${what}`;
}
