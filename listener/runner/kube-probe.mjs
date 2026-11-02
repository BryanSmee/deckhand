// Whether the cluster enforces the sandboxes' NetworkPolicies (#568). isolationProblem()
// (kubernetes.mjs) reads what they say; a network plugin that ignores them (Flannel alone, say)
// takes them and isolates nothing, and every sandbox would reach the services, the API server
// and the internet with no proxy in between. So the runner starts a probe pod labelled as a
// sandbox, in the sandboxes' namespace, Pod Security `restricted`, with no Secret, claim or token,
// which tries a TCP connection (UDP too for DNS) to each target within CONNECT_MS:
//
//   - each port of every Service of the services' namespace, at its cluster IP and at one of
//     its pods' addresses (some plugins treat the two differently): edge, the orchestrator, the
//     runner, the broker, the github, models and policy services, BuildKit, Redis…;
//   - the hosts of KUBERNETES_REGISTRY, KUBERNETES_BUILDKIT (with a registry) and STORE_URL
//     (redis://), as the runner resolves them, wherever they are;
//   - the cluster's DNS (the runner's own nameservers), TCP and UDP 53: sandboxes get none, but
//     one reached by its IP could carry data out in its lookups;
//   - the API server (the `kubernetes` Service, KUBERNETES_SERVICE_HOST);
//   - a public address (PUBLIC).
//
// Every one has to fail, and the egress proxy's Service has to answer: a pod with no network at
// all doesn't pass as isolated. A target reached is a verdict, kept until the namespaces'
// NetworkPolicies change or the runner takes its lease again (reset()); a probe that couldn't
// tell (its pod didn't end, an API error, the proxy not answering: not ready yet, evicted) isn't,
// and the next run's start tries again. Fail closed either way.
import { lookup as dnsLookup } from "node:dns/promises";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { SANDBOX_USER } from "../sandbox-spec.mjs";
import { kubeName, restrictedContainer } from "./kube-names.mjs";

// How long a connection is tried before it counts as out of reach.
export const CONNECT_MS = 3000;

// An address of the internet that answers on 443 (Cloudflare's resolver).
export const PUBLIC = { host: "1.1.1.1", port: 443 };

// The annotation that sets the probe pod apart from the sandboxes, whose labels it shares.
export const PROBE = "deckhand.probe";

const POLL_MS = 2000;
const NETWORKING = "/apis/networking.k8s.io/v1/namespaces";
const DISCOVERY = "/apis/discovery.k8s.io/v1/namespaces";

// What the probe pod runs (node, which the base image has): argv[1] is a JSON array of
// { host, port, proto }; it prints one JSON array of booleans, each target reached or not.
// A UDP target is asked a DNS query (the root's NS): any answer reaches it.
export const PROBE_SCRIPT = `
const net = require("node:net");
const dgram = require("node:dgram");
const ms = ${CONNECT_MS};
const tcp = ({ host, port }) => new Promise((resolve) => {
  const socket = net.connect({ host, port, timeout: ms });
  const done = (reached) => { socket.destroy(); resolve(reached); };
  socket.on("connect", () => done(true));
  socket.on("timeout", () => done(false));
  socket.on("error", () => done(false));
});
const udp = ({ host, port }) => new Promise((resolve) => {
  const socket = dgram.createSocket(net.isIPv6(host) ? "udp6" : "udp4");
  let over = false;
  const done = (reached) => {
    if (over) return;
    over = true;
    clearTimeout(timer);
    socket.close();
    resolve(reached);
  };
  const timer = setTimeout(() => done(false), ms);
  socket.on("message", () => done(true));
  socket.on("error", () => done(false));
  socket.send(Buffer.from("6468010000010000000000000000020001", "hex"), port, host);
});
const targets = JSON.parse(process.argv[1]);
Promise.all(targets.map((t) => (t.proto === "udp" ? udp(t) : tcp(t)))).then((reached) =>
  console.log(JSON.stringify(reached)),
);
`;

const at = ({ host, port, proto }) =>
  `${isIP(host) === 6 ? `[${host}]` : host}:${port}${proto === "udp" ? "/udp" : ""}`;

const says = (list) => list.map((t) => `${t.what} (${at(t)})`).join(", ");

// The targets that answered and mustn't have, as the reason runs are refused, or null: `targets`
// are { what, host, port, proto, reach }, `reached` the probe's booleans, in their order.
export function probeProblem(targets, reached) {
  const leaks = targets.filter((t, i) => !t.reach && reached[i]);
  if (!leaks.length) return null;
  return `a pod labelled as a sandbox reached ${says(leaks)}: does the network plugin enforce NetworkPolicies? (Calico and Cilium do, Flannel alone doesn't)`;
}

// The targets that had to answer and didn't (the egress proxy).
export const probeMissed = (targets, reached) => targets.filter((t, i) => t.reach && !reached[i]);

// The probe pod: a sandbox's labels (`labels`), so the policies that pick sandboxes pick it,
// and Pod Security `restricted`, as podSpec() (kubernetes.mjs) has them; no Secret, claim,
// ServiceAccount token, Service links or DNS. `pullSecret`: the registry's, for the kubelet to
// pull the base image with, never mounted.
export function probePod({ pod, image, labels, targets, pullSecret = null }) {
  const resources = { cpu: "100m", memory: "128Mi" };
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: { name: pod, labels, annotations: { [PROBE]: "network" } },
    spec: {
      restartPolicy: "Never",
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      terminationGracePeriodSeconds: 0,
      ...(pullSecret ? { imagePullSecrets: [{ name: pullSecret }] } : {}),
      dnsPolicy: "None",
      dnsConfig: { nameservers: ["127.0.0.1"] },
      securityContext: {
        runAsNonRoot: true,
        runAsUser: SANDBOX_USER.uid,
        runAsGroup: SANDBOX_USER.gid,
        seccompProfile: { type: "RuntimeDefault" },
      },
      containers: [
        {
          name: "probe",
          image,
          command: [
            "node",
            "-e",
            PROBE_SCRIPT,
            JSON.stringify(targets.map(({ what, reach, ...t }) => t)),
          ],
          resources: { limits: resources, requests: resources },
          securityContext: restrictedContainer(),
        },
      ],
    },
  };
}

// `host:port` or `scheme://host:port/…` → { host, port }, `port` when it names none.
function hostPort(text, port) {
  const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `tcp://${text}`);
  return { host: url.hostname.replace(/^\[|\]$/g, ""), port: Number(url.port || port) };
}

// The nameservers of a resolv.conf.
const nameservers = (text) =>
  [...text.matchAll(/^\s*nameserver\s+(\S+)/gm)].map((m) => m[1].replace(/%.*$/, ""));

export function createNetworkProbe({
  config,
  api, // kube-api.mjs, in the sandboxes' namespace
  services = api, // the same, in the services'
  pullSecret, // kube-pull.mjs
  proxy, // () → { ip, port }: the egress proxy's Service, as sandboxes reach it
  labels, // a sandbox pod's
  log = () => {},
  now = Date.now,
  sleep = delay,
  env = process.env,
  lookup = (host) => dnsLookup(host, { all: true }),
  resolvConf = () => readFileSync("/etc/resolv.conf", "utf8"),
}) {
  const apart = services.namespace !== api.namespace;
  // The probe's verdict, for the policies it was made under.
  let kept = null; // { key, verdict: Promise<problem | null> }
  let queue = Promise.resolve();

  // What the probe tries, the egress proxy's Service first: { what, host, port, proto, reach }.
  async function targets() {
    const list = [];
    const seen = new Set();
    const add = (target) => {
      const key = at(target);
      if (seen.has(key)) return;
      seen.add(key);
      list.push({ proto: "tcp", reach: false, ...target });
    };
    const egress = await proxy();
    add({ what: "the egress proxy", host: egress.ip, port: egress.port, reach: true });
    const { items: all = [] } = await services.get("services");
    const { items: slices = [] } = await services.get(
      `${DISCOVERY}/${services.namespace}/endpointslices`,
    );
    const tcp = (ports = []) => ports.filter((p) => (p.protocol ?? "TCP") === "TCP" && p.port);
    for (const service of all) {
      const name = service.metadata?.name;
      const ip = service.spec?.clusterIP;
      if (ip && ip !== "None") {
        for (const { port } of tcp(service.spec.ports)) {
          add({ what: `the Service ${name}`, host: ip, port });
        }
      }
      // One of its pods, each port: the proxy's own is the one sandboxes may reach.
      const slice = slices.find(
        (s) =>
          s.metadata?.labels?.["kubernetes.io/service-name"] === name &&
          s.endpoints?.some((e) => e.addresses?.length),
      );
      const address = slice?.endpoints.find((e) => e.addresses?.length).addresses[0];
      for (const { port } of tcp(slice?.ports)) {
        if (ip === egress.ip && port === egress.port) continue;
        add({ what: `a pod of the Service ${name}`, host: address, port });
      }
    }
    // What the services' namespace may not hold: the registry, BuildKit, Redis.
    const { registry, buildkit } = config.kubernetes;
    const named = [
      registry && { what: "the registry", ...hostPort(registry, 443) },
      registry && buildkit && { what: "BuildKit", ...hostPort(buildkit, 1234) },
      /^rediss?:/.test(env.STORE_URL ?? "") && { what: "Redis", ...hostPort(env.STORE_URL, 6379) },
    ].filter(Boolean);
    for (const { what, host, port } of named) {
      let addresses;
      try {
        addresses = isIP(host) ? [{ address: host }] : await lookup(host);
      } catch (error) {
        log(
          `Network probe: ${what} (${host}) left out, the runner can't resolve it: ${error.message}`,
        );
        continue;
      }
      for (const { address } of addresses) add({ what: `${what} (${host})`, host: address, port });
    }
    let dns = [];
    try {
      dns = nameservers(resolvConf());
    } catch (error) {
      log(`Network probe: the cluster's DNS left out, no resolv.conf: ${error.message}`);
    }
    for (const host of dns.filter((h) => isIP(h))) {
      add({ what: "the cluster's DNS", host, port: 53 });
      add({ what: "the cluster's DNS", host, port: 53, proto: "udp" });
    }
    if (env.KUBERNETES_SERVICE_HOST) {
      add({
        what: "the Kubernetes API server",
        host: env.KUBERNETES_SERVICE_HOST,
        port: Number(env.KUBERNETES_SERVICE_PORT || 443),
      });
    }
    add({ what: "a public address", ...PUBLIC });
    return list;
  }

  // Probe pods older than any probe lasts: a runner's that stopped mid-probe. A younger one may
  // be the other copy's, still probing during a handover: each probe's pod has a name of its own.
  async function removeLeftovers(waitMs) {
    const selector = Object.entries(labels)
      .map(([k, v]) => `${k}=${v}`)
      .join(",");
    const { items = [] } = await api.get("pods", { labelSelector: selector });
    for (const left of items) {
      const born = Date.parse(left.metadata?.creationTimestamp ?? "");
      if (!left.metadata?.annotations?.[PROBE] || !(now() - born > waitMs)) continue;
      await api
        .remove(`pods/${left.metadata.name}`, { gracePeriodSeconds: 0 })
        .catch((error) => log(`Network probe: removing ${left.metadata.name}: ${error.message}`));
    }
  }

  // Runs the probe pod once: its problem, or null. Throws when it couldn't tell.
  async function probe() {
    const list = await targets();
    // As long as a sandbox may stay Pending (KUBERNETES_PENDING_MINUTES), and a minute to run.
    const waitMs = config.kubernetes.pendingMs + 60_000;
    await removeLeftovers(waitMs);
    const deadline = now() + waitMs;
    const pod = kubeName(`${config.prefix}-network-probe-${randomBytes(4).toString("hex")}`);
    const podPath = `pods/${pod}`;
    const spec = probePod({
      pod,
      image: config.image,
      labels,
      targets: list,
      pullSecret: await pullSecret.forPods(),
    });
    await api.create("pods", spec);
    try {
      let found;
      for (;;) {
        found = await api.find(podPath);
        if (!found) throw new Error("its probe pod was removed before it ended");
        if (["Succeeded", "Failed"].includes(found.status?.phase)) break;
        if (now() >= deadline) {
          const waiting = found.status?.containerStatuses?.[0]?.state?.waiting;
          throw new Error(
            `its probe pod didn't end within ${Math.round(waitMs / 60000)} min (${found.status?.phase}${waiting?.reason ? `, ${waiting.reason}` : ""})`,
          );
        }
        await sleep(POLL_MS);
      }
      const res = await api.stream(
        `${podPath}/log`,
        { container: "probe" },
        AbortSignal.timeout(30_000),
      );
      const out = (await res.text()).trim();
      const code = found.status?.containerStatuses?.[0]?.state?.terminated?.exitCode;
      let reached;
      try {
        reached = JSON.parse(out.split("\n").at(-1));
      } catch {}
      if (
        found.status.phase !== "Succeeded" ||
        !Array.isArray(reached) ||
        reached.length !== list.length
      ) {
        throw new Error(
          `its probe pod ended ${found.status.phase}${code === undefined ? "" : ` (exit ${code})`}, saying ${JSON.stringify(out.slice(-300))}`,
        );
      }
      const problem = probeProblem(list, reached);
      const missed = probeMissed(list, reached);
      // No network at all, or a proxy not ready: nothing proven either way, unless a leak.
      if (!problem && missed.length) {
        throw new Error(
          `its probe pod couldn't reach ${says(missed)}, which sandboxes go out through: is it ready?`,
        );
      }
      return problem;
    } finally {
      await api
        .remove(podPath, { gracePeriodSeconds: 0 })
        .catch((error) => log(`Network probe: removing its pod: ${error.message}`));
    }
  }

  // What the probe's verdict is kept for: the NetworkPolicies of both namespaces, as they are.
  async function policiesKey(policies) {
    const mine =
      policies ?? (await api.get(`${NETWORKING}/${api.namespace}/networkpolicies`)).items;
    const theirs = apart
      ? (await services.get(`${NETWORKING}/${services.namespace}/networkpolicies`)).items
      : [];
    const key = (p) => [
      p.metadata?.namespace,
      p.metadata?.name,
      p.metadata?.resourceVersion,
      p.spec,
    ];
    return JSON.stringify([(mine ?? []).map(key), (theirs ?? []).map(key)]);
  }

  // The probe's problem, or null, for the policies as they are (`policies`: the sandboxes'
  // namespace's, when the caller has them): kept, or probed now, one probe at a time. Throws
  // when the probe couldn't tell, and the next call probes again.
  async function check(policies = null) {
    const key = await policiesKey(policies);
    if (kept?.key === key) return kept.verdict;
    const entry = { key };
    entry.verdict = queue.then(async () => {
      const started = now();
      try {
        const problem = await probe();
        log(
          problem
            ? `Network probe: runs refused, ${problem}`
            : `Network probe: a sandbox reaches the egress proxy alone (${Math.round((now() - started) / 1000)} s)`,
        );
        return problem;
      } catch (error) {
        if (kept === entry) kept = null;
        log(`Network probe: couldn't tell, ${error.message}`);
        throw error;
      }
    });
    queue = entry.verdict.catch(() => {});
    kept = entry;
    return entry.verdict;
  }

  return {
    check,
    // The runner took its lease: the verdict is made again, now rather than at the next run.
    reset() {
      kept = null;
      check().catch(() => {});
    },
  };
}
