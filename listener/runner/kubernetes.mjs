// The Kubernetes runner: the runner interface of docker.mjs (its header lists the methods),
// with each sandbox a bare Pod in the sandboxes' namespace (KUBERNETES_NAMESPACE), through the
// API (kube-api.mjs). The services, the egress proxy and BuildKit are in the services'
// namespace (KUBERNETES_SERVICES_NAMESPACE), by default the same one; apart, the sandboxes'
// can enforce Pod Security `restricted`, which rootless BuildKit can't meet, and the runner's
// Role there covers none of the services' Secrets. The orchestrator stays the only writer of
// the runs' state; the sandboxes are what spread over the cluster's nodes.
//
//   - A run's environment goes into a Secret of its own (envFrom), never inline in the Pod,
//     deleted with the run. The run's files (inbox, CA, digest) come from the broker service
//     through the egress proxy, as under Docker: no volume is shared with the runner.
//   - The Pod meets Pod Security `restricted` (podSpec()), gets no ServiceAccount token and no
//     DNS server (a lookup fails at once, as on Docker's internal network): `egress` (the host
//     of EGRESS_PROXY) is the services' namespace's Service of that name, through hostAliases
//     (proxyService()). The services' names it calls (lib/services.mjs SANDBOX_URLS) are the
//     proxy's to read.
//   - No network per run: the sandboxes' namespace's NetworkPolicies isolate every sandbox, and
//     start() refuses to run without them (isolationProblem()), nor on a cluster that doesn't
//     enforce them, as a probe pod labelled as a sandbox finds (kube-probe.mjs). The egress
//     proxy knows a sandbox by its pod IP (locate()).
//   - Each session volume is a PersistentVolumeClaim, kept between the issue's runs.
//   - A Pod Pending longer than KUBERNETES_PENDING_MINUTES (no room, an image it can't pull)
//     fails its run, saying why (follow()), and a leftover one is removed rather than waited
//     for (wait()).
//
//   - A repo's image, the agent's install and the caches are kube-images.mjs's: the agent is a
//     claim mounted read-only, or, when there is none, installed by an init container into an
//     emptyDir (podSpec()); caches are claims too, when the operator sets their class.
//
//   - A run granted a container engine (engine.mjs) gets Sysbox's dockerd as a sidecar in its
//     pod, under the operator's RuntimeClass (KUBERNETES_ENGINE_RUNTIME_CLASS) and the pod's
//     own user namespace, its storage an emptyDir (podSpec()). It shares the sandbox's address,
//     so it reaches the egress proxy on the engines' port (lib/services.mjs ENGINE_PROXY_PORT),
//     which tells the proxy its connections apart.
//
// Not here yet, refused before a run starts (access.mjs runnerRefusal()): host mounts. An
// engine without that RuntimeClass, or Podman's, is refused there too.
import { setTimeout as delay } from "node:timers/promises";
import { RunError } from "../access.mjs";
import { agentFor } from "../agents/index.mjs";
import { proxyEnv } from "../egress.mjs";
import { createInbox } from "./inbox.mjs";
import { kubeName, labelValue, restrictedContainer } from "./kube-names.mjs";
import { createNetworkProbe, PROBE } from "./kube-probe.mjs";
import { createPullSecret } from "./kube-pull.mjs";
import { splitLines } from "./lines.mjs";
import { aliasOf } from "./networks.mjs";
import {
  ENGINE_HOST,
  engineEnv,
  engineProxy,
  KUBE_ENGINE_STORAGE,
  kubernetesEngine,
} from "./engine.mjs";
import { ENGINE_PROXY_PORT } from "../../lib/services.mjs";

// How long a cancelled run's sandbox has between SIGTERM and SIGKILL, as under Docker.
const KILL_GRACE_S = 10;

// How often a Pending pod, or one that wait() waits for, is looked at again.
const POLL_MS = 2000;

// How long state(), wait() and follow() keep asking an API that errs (a control plane being
// upgraded, a 429, a network blip) before they give up: a run at work outlives a blip.
const API_RETRY_MS = 60_000;
const API_BACKOFF_MS = [1000, 2000, 5000, 10_000];

// A pod its node lost (NotReady, unreachable) is never confirmed gone: past its deletion's
// deadline by STUCK_MS, or in phase Unknown for UNKNOWN_MS, it is force-deleted and counts as
// gone, so its run ends rather than holding its slot forever.
const STUCK_MS = 2 * 60_000;
const UNKNOWN_MS = 5 * 60_000;

// The proxy's addresses, as networks.mjs caches them.
const PROXY_TTL_MS = 10000;
const PROXY_RETRY_MS = 2000;

// The sandbox's container, in its Pod and in its log's URL.
const CONTAINER = "sandbox";

// Who installs an agent on Kubernetes (kube-images.mjs, and the init container of podSpec()):
// neither root, which Pod Security `restricted` refuses, nor the sandbox's user, who mustn't
// own what the next sandbox runs.
export const INSTALL_USER = { uid: 1001, gid: 1001 };

// The annotation of a pod whose init container installs its agent (installing()), and that
// container's name.
const AGENT_INIT = "deckhand.agent-init";
export const INIT_CONTAINER = "agent-install";

// The engine's sidecar (podSpec()), and its storage's volume.
const ENGINE_CONTAINER = "engine";
const ENGINE_VOLUME = "engine";

// What pendingReason() says while the init container installs the agent.
export const INSTALLING = "its init container is installing the agent";

// What sets a sandbox's pod and its Secret apart from the rest of the namespace.
const ROLE = "deckhand.role";
const SANDBOX = "sandbox";
const ENV = "sandbox-env";

const NETWORKING = "/apis/networking.k8s.io/v1/namespaces";
const DISCOVERY = "/apis/discovery.k8s.io/v1/namespaces";

// Where they are now (kube-names.mjs), for the modules and tests that import them from here.
export { kubeName, labelValue };

// Docker's amounts ("4g", "512m", grants.mjs) → Kubernetes' quantities ("4Gi", "512Mi").
export function quantity(memory) {
  const m = /^(\d+)([kmg]?)$/.exec(String(memory).toLowerCase());
  if (!m) throw new Error(`a memory limit of ${memory}: expected an amount (512m, 4g)`);
  return m[1] + { "": "", k: "Ki", m: "Mi", g: "Gi" }[m[2]];
}

// Whether a label selector (matchLabels, matchExpressions) picks a pod with `labels`. An
// empty one picks every pod.
export function selects(selector = {}, labels = {}) {
  const has = (k) => Object.hasOwn(labels, k);
  for (const [k, v] of Object.entries(selector.matchLabels ?? {})) {
    if (labels[k] !== v) return false;
  }
  for (const { key, operator, values = [] } of selector.matchExpressions ?? []) {
    const ok = {
      In: has(key) && values.includes(labels[key]),
      NotIn: !has(key) || !values.includes(labels[key]),
      Exists: has(key),
      DoesNotExist: !has(key),
    }[operator];
    if (!ok) return false;
  }
  return true;
}

// Whether a peer's selector can never pick a sandbox pod, any run's or deployment's, not just
// this one (`labels`, whose keys are the only ones sandbox pods carry): it asks for a label
// they never have, or for a deckhand.role other than theirs.
export function excludesSandboxes(selector = {}, labels) {
  const ours = (key) => Object.hasOwn(labels, key);
  for (const [key, value] of Object.entries(selector.matchLabels ?? {})) {
    if (!ours(key) || (key === ROLE && value !== SANDBOX)) return true;
  }
  for (const { key, operator, values = [] } of selector.matchExpressions ?? []) {
    if (!ours(key) && ["In", "Exists"].includes(operator)) return true;
    if (key !== ROLE) continue;
    if (operator === "In" && !values.includes(SANDBOX)) return true;
    if (operator === "NotIn" && values.includes(SANDBOX)) return true;
    if (operator === "DoesNotExist") return true;
  }
  return false;
}

// The label every namespace carries, its name (Kubernetes sets it): what a namespaceSelector
// names one namespace by.
const NAMESPACE_NAME = "kubernetes.io/metadata.name";

// Whether a selector asks for `key` to be `value`, and so picks nothing else on that key: in
// its matchLabels, or as an `In` of that value alone.
const pins = (selector, key, value) =>
  selector?.matchLabels?.[key] === value ||
  (selector?.matchExpressions ?? []).some(
    (e) => e.key === key && e.operator === "In" && e.values?.length === 1 && e.values[0] === value,
  );

// Why a peer of a sandbox's egress rule could be more than the egress proxy's pods in the
// services' namespace, or null: its namespaceSelector names that namespace (NAMESPACE_NAME),
// and its podSelector asks for every label of the proxy Service's selector, so it picks no pod
// the Service doesn't. Anything wider is refused, whatever else it asks for.
function proxyPeerProblem(peer, proxy) {
  if (peer.ipBlock || !pins(peer.namespaceSelector, NAMESPACE_NAME, proxy.namespace)) {
    return `beyond the namespace ${proxy.namespace} (a namespaceSelector on ${NAMESPACE_NAME}: ${proxy.namespace} and a podSelector, nothing else)`;
  }
  const wanted = Object.entries(proxy.selector ?? {});
  if (!wanted.length || !wanted.every(([k, v]) => pins(peer.podSelector, k, v))) {
    return `pods of the namespace ${proxy.namespace} other than the egress proxy's (a podSelector with its Service's selector${wanted.length ? `, ${wanted.map(([k, v]) => `${k}: ${v}`).join(", ")}` : ", which has none"})`;
  }
  return null;
}

// Why the sandboxes' namespace's NetworkPolicies (`policies`) don't isolate a sandbox pod with
// `labels`, or null when they do: one of them picks it for both Ingress and Egress, and none
// of those that pick it lets anything in, nor lets it out to anything but the egress proxy.
// Policies add up, so a single wider one is enough to refuse: fail closed.
// In one namespace with the services (no `proxy`), a peer is a podSelector of that namespace
// that never picks a sandbox; with the services apart (`proxy`: { namespace, selector }, the
// services' namespace and the proxy Service's selector), the proxy's pods there alone
// (proxyPeerProblem()), none of the sandboxes' own namespace.
// Each rule to them names its ports, among `ports` (the proxy's): a sandbox that could reach
// another port of a pod there (the orchestrator's services port) would get what only the
// runner may.
export function isolationProblem(policies, labels, { ports = [3128], proxy = null } = {}) {
  const picking = policies.filter((p) => selects(p.spec?.podSelector, labels));
  const types = (p) => p.spec.policyTypes ?? (p.spec.egress ? ["Ingress", "Egress"] : ["Ingress"]);
  if (!picking.some((p) => types(p).includes("Ingress") && types(p).includes("Egress"))) {
    return "no NetworkPolicy picks the sandbox pods for both Ingress and Egress";
  }
  for (const p of picking) {
    const name = `the NetworkPolicy ${p.metadata?.name}`;
    if (p.spec.ingress?.length) return `${name} lets traffic in to sandbox pods`;
    for (const rule of p.spec.egress ?? []) {
      if (!rule.to?.length) return `${name} lets sandbox pods reach anything`;
      for (const peer of rule.to) {
        if (proxy) {
          const problem = proxyPeerProblem(peer, proxy);
          if (problem) return `${name} lets sandbox pods reach ${problem}`;
          continue;
        }
        if (peer.ipBlock || peer.namespaceSelector || !peer.podSelector) {
          return `${name} lets sandbox pods reach beyond the namespace's pods`;
        }
        if (!excludesSandboxes(peer.podSelector, labels)) {
          return `${name} lets sandbox pods reach each other`;
        }
      }
      // A port entry without a number (a protocol alone) is every port of that protocol.
      const wide = !rule.ports?.length
        ? { port: undefined }
        : rule.ports.find(
            (p) => typeof p.port !== "number" || p.endPort !== undefined || !ports.includes(p.port),
          );
      if (wide) {
        const what = wide.port === undefined ? "every port" : `port ${wide.port}`;
        const whose = proxy ? "the egress proxy's pods" : "the namespace's pods";
        return `${name} lets sandbox pods reach ${what} of ${whose} (only ${ports.join(" and ")})`;
      }
    }
  }
  return null;
}

// The egress proxy's Service, in the services' namespace (`services`, kube-api.mjs): the
// cluster IP sandboxes and install pods reach it at by its name (hostAliases: they have no DNS,
// or none that knows it), its selector, the proxy's pods (isolationProblem()), and its ports
// (an engine needs the engines'). Null when EGRESS_PROXY is an address.
export async function proxyService(services, config) {
  const host = aliasOf(config.egressProxy);
  if (!host) return null;
  const service = await services.find(`services/${host}`);
  const ip = service?.spec?.clusterIP;
  if (!ip || ip === "None") {
    throw new Error(
      `no Service ${host} with a cluster IP in the namespace ${services.namespace}: sandboxes reach ${config.egressProxy} through it`,
    );
  }
  const ports = (service.spec.ports ?? []).map((p) => p.port);
  return { ip, hostnames: [host], selector: service.spec.selector ?? {}, ports };
}

// proxyService()'s answer as a pod's hostAliases.
export const aliasesOf = (proxy) => (proxy ? [{ ip: proxy.ip, hostnames: proxy.hostnames }] : []);

// Pod Security `restricted`, the pod's side (the container's: kube-names.mjs
// restrictedContainer()), for the sandboxes and kube-images.mjs's installs, checks and jobs, so
// that none drifts from the others: as `user`, whose group its claims (and emptyDirs) become, where
// their storage applies it. Only when the claim's root isn't the group's already: by default the
// kubelet walks the whole volume at every mount, while the pod is Pending
// (KUBERNETES_PENDING_MINUTES).
export function restrictedPod(user) {
  return {
    runAsNonRoot: true,
    runAsUser: user.uid,
    runAsGroup: user.gid ?? user.uid,
    fsGroup: user.gid ?? user.uid,
    fsGroupChangePolicy: "OnRootMismatch",
    seccompProfile: { type: "RuntimeDefault" },
  };
}

// The init container that installs an agent (its install spec's `command` and `env`) into
// `volumeMounts` (an emptyDir the pod's main container then mounts read-only), as INSTALL_USER:
// a sandbox's (podSpec()) and a job's whose agent has no claim (kube-images.mjs runJob()).
export function agentInitContainer({ image, command, env, resources, volumeMounts }) {
  return {
    name: INIT_CONTAINER,
    image,
    command: [command],
    env: envList(env),
    resources: { limits: resources, requests: resources },
    securityContext: {
      ...restrictedContainer(),
      runAsUser: INSTALL_USER.uid,
      runAsGroup: INSTALL_USER.gid,
    },
    volumeMounts,
  };
}

// A sandbox spec (sandbox-spec.mjs) as a Pod, Pod Security `restricted` throughout: its user,
// no privilege gain, no capability, the runtime's seccomp profile. `secret`: the Secret its
// environment comes from; `env`: values that aren't secrets (where the run's files are);
// `aliases`: hostAliases; `claims`: volume name → its claim's; `pullSecret`: the registry's
// (KUBERNETES_REGISTRY_SECRET); `agentInit`: { volume, image, command, env } when the agent
// has no claim: an emptyDir, which an init container fills as INSTALL_USER before the
// sandbox mounts it read-only. `engine`: { image, runtimeClass, env, size } for a run granted
// a container engine (engine.mjs): its sidecar, below.
export function podSpec(
  { name, image, user, limits, caps = [], volumes = [] },
  {
    pod,
    labels,
    annotations,
    secret,
    env = {},
    aliases = [],
    claims = {},
    pullSecret = null,
    agentInit = null,
    engine = null,
  },
) {
  if (!user) throw new Error("the sandbox spec has no user");
  if (!limits) throw new Error("the sandbox spec has no limits");
  if (caps.length) throw new Error(`the kubernetes runner adds no capabilities (${caps})`);
  const resources = { cpu: String(limits.cpus), memory: quantity(limits.memory) };
  const claimed = [...new Set(volumes.map((v) => v.name))];
  const init = agentInit && claimed.includes(agentInit.volume) ? agentInit : null;
  const mountOf = (v) => ({
    name: `v${claimed.indexOf(v.name)}`,
    mountPath: v.path,
    ...(v.readOnly ? { readOnly: true } : {}),
    ...(v.subpath ? { subPath: v.subpath } : {}),
  });
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: { name: pod, labels, annotations: { "deckhand.name": name, ...annotations } },
    spec: {
      // Its run ends with it: no restart, as with `docker run` and no --restart.
      restartPolicy: "Never",
      // It never calls the API.
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      // Under Docker, `--init` reaps orphaned processes; here the pod's pause process does. Not
      // in an engine's pod, as Sysbox advises: the sandbox's entrypoint reaps them there
      // (SANDBOX_REAP), and the engine's image has its own init.
      shareProcessNamespace: !engine,
      terminationGracePeriodSeconds: KILL_GRACE_S,
      hostAliases: aliases,
      ...(pullSecret ? { imagePullSecrets: [{ name: pullSecret }] } : {}),
      // No cluster DNS: its only names are hostAliases'. A resolver that answers nothing fails
      // a lookup at once, where the cluster's, blocked by the NetworkPolicy, would time out on
      // every search domain.
      dnsPolicy: "None",
      dnsConfig: { nameservers: ["127.0.0.1"] },
      // Its claims are the sandbox user's to write.
      securityContext: restrictedPod(user),
      // The engine's: every container of the pod under Sysbox's runtime, in a user namespace
      // of the pod's own, root there an unprivileged user on the node.
      ...(engine ? { runtimeClassName: engine.runtimeClass, hostUsers: false } : {}),
      ...(init || engine
        ? {
            initContainers: [
              ...(init
                ? [
                    agentInitContainer({
                      image: init.image,
                      command: init.command,
                      env: init.env,
                      resources,
                      volumeMounts: volumes
                        .filter((v) => v.name === init.volume)
                        .map((v) => ({ ...mountOf(v), readOnly: false })),
                    }),
                  ]
                : []),
              ...(engine ? [engineContainer(engine, resources)] : []),
            ],
          }
        : {}),
      containers: [
        {
          name: CONTAINER,
          image,
          // No imagePullPolicy: Kubernetes' default pulls a :latest or untagged image again
          // at every start, so nodes don't keep an old base image (and its entrypoint) after
          // an update, and keeps a pinned tag or digest.
          envFrom: [{ secretRef: { name: secret } }],
          env: envList(env),
          // As much as it may use is held for it: a node without the room leaves it Pending
          // rather than starving it later.
          resources: { limits: resources, requests: resources },
          securityContext: restrictedContainer(),
          volumeMounts: volumes.map(mountOf),
        },
      ],
      volumes: [
        ...claimed.map((volume, i) =>
          volume === init?.volume
            ? { name: `v${i}`, emptyDir: {} }
            : {
                name: `v${i}`,
                persistentVolumeClaim: {
                  claimName: claims[volume] ?? kubeName(volume),
                  // Read-only for each of its mounts: the claim too, then.
                  ...(volumes.filter((v) => v.name === volume).every((v) => v.readOnly)
                    ? { readOnly: true }
                    : {}),
                },
              },
        ),
        // Gone with the pod; past its size, the kubelet evicts the pod.
        ...(engine ? [{ name: ENGINE_VOLUME, emptyDir: { sizeLimit: engine.size } }] : []),
      ],
    },
  };
}

const envList = (env) => Object.entries(env).map(([k, v]) => ({ name: k, value: String(v) }));

// The engine's sidecar: an init container that keeps running (`restartPolicy: Always`), so
// it is up before the sandbox starts and stopped once the sandbox exits, the pod's phase the
// sandbox's alone. Root, which dockerd needs, only inside the pod's user namespace
// (`hostUsers: false`): Pod Security `restricted` allows that from Kubernetes 1.35, and the rest
// of restrictedContainer() holds. Sysbox gives root its capabilities and the syscalls it needs in that
// namespace alone, whatever the spec drops. As much as the sandbox may use, as on Docker.
function engineContainer({ image, env }, resources) {
  return {
    name: ENGINE_CONTAINER,
    image,
    restartPolicy: "Always",
    // Its API on the pod's loopback alone, where the sandbox reaches it (`engine` is 127.0.0.1
    // there): a NetworkPolicy always lets the pod's own node in, its hostNetwork pods too. With
    // `dockerd` first, the image's entrypoint adds no host of its own (0.0.0.0:2375).
    args: ["dockerd", "--host=unix:///var/run/docker.sock", "--host=tcp://127.0.0.1:2375"],
    env: envList(env),
    resources: { limits: resources, requests: resources },
    securityContext: {
      ...restrictedContainer(),
      runAsNonRoot: false,
      runAsUser: 0,
      runAsGroup: 0,
    },
    volumeMounts: [{ name: ENGINE_VOLUME, mountPath: KUBE_ENGINE_STORAGE }],
  };
}

// Why a pod is still Pending, as its status says it: its container waiting (an image it can't
// pull), or not scheduled (no node with the room). Null when it says nothing more than
// ContainerCreating: its events tell then (Multi-Attach of a claim another node holds, a
// volume that won't mount), or nothing does.
export function pendingReason(pod) {
  const waiting = (statuses = []) => {
    for (const s of statuses) {
      const w = s.state?.waiting;
      // Neither says more than "not yet": PodInitializing is the sandbox's while the init
      // container runs.
      if (w?.reason && !["ContainerCreating", "PodInitializing"].includes(w.reason)) {
        return w.message ? `${w.reason}: ${w.message}` : w.reason;
      }
    }
    return null;
  };
  const init = pod.status?.initContainerStatuses ?? [];
  const said =
    waiting(init) ??
    (init.some((s) => s.name === INIT_CONTAINER && s.state?.running) ? INSTALLING : null) ??
    waiting(pod.status?.containerStatuses);
  if (said) return said;
  const unscheduled = (pod.status?.conditions ?? []).find(
    (c) => c.type === "PodScheduled" && c.status === "False",
  );
  if (unscheduled) return unscheduled.message || unscheduled.reason || "not scheduled";
  return null;
}

// The init container's exit code when it failed (the agent's install), else null.
export function failedInit(pod) {
  const code = (pod.status?.initContainerStatuses ?? []).find((s) => s.name === INIT_CONTAINER)
    ?.state?.terminated?.exitCode;
  return code === undefined || code === 0 ? null : code;
}

// The newest Warning event's "reason: message" among `events` (the pod's), or null.
export function latestWarning(events) {
  const when = (e) =>
    Date.parse(e.lastTimestamp ?? e.eventTime ?? e.metadata?.creationTimestamp ?? "") || 0;
  const last = events.filter((e) => e.type === "Warning").sort((a, b) => when(b) - when(a))[0];
  return last ? `${last.reason}: ${last.message}` : null;
}

const UNSAID = "Kubernetes gave no reason: its volumes may not have mounted";

// A pod's log has stdout and stderr in one stream, and the runtime splits a long line into
// parts the other stream's lines can land between. So the sandbox, when SANDBOX_TAG_STDERR
// asks it to, writes both to stdout through one writer, whole lines only, each stderr line
// (the setup's, the entrypoint's) starting with this (../../sandbox/deckhand-tagged): they
// stay apart from the agent's output, as under Docker. A setup line that looks like JSON is
// still the setup's.
export const STDERR_TAG = "\x1e";

// How often follow() looks at the pod while its log streams: a connection the API server
// dropped without a word would otherwise never end.
const WATCH_MS = 30_000;

export function createKubernetesRunner({
  config,
  api, // kube-api.mjs, in the sandboxes' namespace
  services = api, // the same, in the services' (the same object when they are one)
  pullSecret = createPullSecret({ config, api, services }), // kube-pull.mjs
  inboxDir, // the runs folder, in the runner's own volume
  log = () => {},
  now = Date.now,
  sleep = delay,
  mirror = null, // the broker service's copy of the runs' inboxes and files (inbox.mjs)
  watchMs = WATCH_MS,
  // kube-probe.mjs's, made below unless the tests bring theirs; `probeOptions`: more of its
  // options (the tests' env, DNS lookup, resolv.conf and sleep).
  probe = null,
  probeOptions = {},
}) {
  const { pendingMs, storageClass, sessionSize, cacheStorageClass } = config.kubernetes;
  const apart = services.namespace !== api.namespace;
  const inbox = createInbox({ inboxDir, mirror });
  // Runs whose Secret exists before their pod does: relink() leaves them alone.
  const starting = new Set();
  let proxy = { at: -Infinity, addresses: [] };

  const owner = { "deckhand.owner": labelValue(config.prefix) };
  const selector = (role) =>
    Object.entries({ ...owner, [ROLE]: role })
      .map(([k, v]) => `${k}=${v}`)
      .join(",");
  const podPath = (name) => `pods/${kubeName(name)}`;
  // Not a sandbox, though labelled as one: the network probe's pod.
  const probing = (pod) => Boolean(pod.metadata?.annotations?.[PROBE]);
  const secretName = (run) => kubeName(`${run}-env`);
  const claimPath = (volume) => `persistentvolumeclaims/${kubeName(volume)}`;

  // `spec`: sandboxSpec()'s. → { engine: { backend, cached } } when it has one, else
  // { engine: null }.
  async function start(spec) {
    const { run, name, labels = {}, env: values = {}, tokens, engine, ca, digest } = spec;
    const { volumes = [] } = spec;
    if (engine && !kubernetesEngine(config)) {
      throw new Error(
        "the kubernetes runner runs a container engine only with Sysbox's RuntimeClass (KUBERNETES_ENGINE_RUNTIME_CLASS, SANDBOX_ENGINE sysbox or auto)",
      );
    }
    for (const v of volumes) {
      // A cache's claim is images.mjs caches()'s, made only with a class to make it of.
      if (v.kind === "mount" || (v.kind === "cache" && !cacheStorageClass)) {
        throw new Error(
          `the kubernetes runner mounts no ${v.kind === "mount" ? "host path" : "cache"} (${v.path})`,
        );
      }
    }
    await inbox.write(run, ca, digest);
    const podLabels = { ...owner, "deckhand.run": labelValue(run), [ROLE]: SANDBOX };
    const made = []; // what start() created, removed again if it fails
    starting.add(run);
    try {
      const { items: policies = [] } = await api.get(
        `${NETWORKING}/${api.namespace}/networkpolicies`,
      );
      const proxySvc = await proxyService(services, config);
      checkIsolation(policies, podLabels, proxySvc);
      // Its engine goes out on the proxy's engines' port, through the Service's cluster IP.
      if (engine && proxySvc && !proxySvc.ports.includes(ENGINE_PROXY_PORT)) {
        throw new Error(
          `the Service ${proxySvc.hostnames[0]} in the namespace ${services.namespace} has no port ${ENGINE_PROXY_PORT}, the egress proxy's engines' port, through which a container engine goes out (see docs/kubernetes.md, Container engine on Kubernetes)`,
        );
      }
      await checkEnforced(policies);
      const pullName = await pullSecret.forPods();
      for (const v of volumes.filter((v) => v.kind === "session")) {
        if (await ensureClaim(v.name)) made.push(claimPath(v.name));
      }
      const agentInit = await agentInstall(volumes.find((v) => v.kind === "agent"));
      const sidecar = engine ? engineSpec() : null;
      const secret = secretName(run);
      // The pod first: the run's tokens are bound to its UID (../sandbox-spec.mjs tokenEnv()).
      // Its container waits for the Secret it reads (CreateContainerConfigError, which the
      // kubelet retries), made right after.
      const pod = await api.create(
        "pods",
        podSpec(spec, {
          pod: kubeName(name),
          labels: podLabels,
          annotations: {
            ...labels,
            "deckhand.run": run,
            ...(agentInit ? { [AGENT_INIT]: agentInit.volume } : {}),
          },
          secret,
          // Not secrets: where the run's files and its engine are.
          env: {
            ...inbox.env(ca, digest),
            SANDBOX_TAG_STDERR: "1",
            // Its pod shares no process namespace: the entrypoint stays PID 1, reaping.
            ...(sidecar ? { SANDBOX_REAP: "1" } : {}),
            ...(sidecar ? sidecar.sandboxEnv : {}),
          },
          // Its engine at `engine`, as on Docker: in the pod, its published ports too.
          aliases: [
            ...aliasesOf(proxySvc),
            ...(sidecar ? [{ ip: "127.0.0.1", hostnames: [ENGINE_HOST] }] : []),
          ],
          pullSecret: pullName,
          agentInit,
          engine: sidecar,
        }),
      );
      made.push(podPath(name));
      // Its address, once it has one, may have been asked about meanwhile: nobody's then.
      forgetUids();
      const bound = tokens ? await tokens(pod?.metadata?.uid) : {};
      // Unset values stay unset in the sandbox, as under Docker.
      const env = Object.fromEntries(
        Object.entries({ ...bound, ...values })
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => [k, String(v)]),
      );
      await api.create("secrets", {
        apiVersion: "v1",
        kind: "Secret",
        metadata: {
          name: secret,
          labels: { ...owner, "deckhand.run": labelValue(run), [ROLE]: ENV },
          annotations: { "deckhand.run": run },
        },
        type: "Opaque",
        stringData: env,
      });
      made.push(`secrets/${secret}`);
    } catch (error) {
      for (const path of made.reverse()) {
        await api.remove(path).catch((e) => log(`Removing ${path}: ${e.message}`));
      }
      throw error;
    } finally {
      starting.delete(run);
    }
    return { engine: engine ? { backend: "sysbox", cached: false } : null };
  }

  // The engine's sidecar (podSpec()), and what the sandbox gets to use it: the engine's address,
  // and the proxy's engines' port for the containers it builds and runs (their connections
  // are the engine's, ../../sandbox/entrypoint.sh), which the engine itself goes out through.
  function engineSpec() {
    const proxy = engineProxy(config.egressProxy);
    const { engineRuntimeClass: runtimeClass, engineSize: size } = config.kubernetes;
    return {
      image: config.engineImage,
      runtimeClass,
      size,
      env: { EGRESS_PROXY: proxy },
      sandboxEnv: { ...engineEnv("sysbox"), DECKHAND_ENGINE_PROXY: proxy },
    };
  }

  // The init container that installs the agent when it has no claim (kube-images.mjs
  // installAgent() made none: no KUBERNETES_AGENT_STORAGE_CLASS), else null. From the base
  // image, which has the installers whatever a repo's image did with them, through the egress
  // proxy, which lets it reach its install's hosts only while the pod is Pending
  // (installing()).
  async function agentInstall(agent) {
    if (!agent?.install || (await api.find(claimPath(agent.name)))) return null;
    return {
      volume: agent.name,
      image: config.image,
      command: agent.install.command,
      env: { ...agent.install.env, ...proxyEnv(config) },
    };
  }

  // The ports sandboxes reach the proxy on: none other (isolationProblem()). The engines' too
  // when runs may have one: their pod's policy lets it through.
  const sandboxPorts = () => [
    Number(new URL(config.egressProxy).port || 3128),
    ...(kubernetesEngine(config) ? [ENGINE_PROXY_PORT] : []),
  ];

  // Fail closed: without the sandboxes' namespace's NetworkPolicies (`policies`), a sandbox
  // would reach anything. `proxySvc`: proxyService()'s, whose pods alone they may reach in the
  // services' namespace, when it is another one.
  function checkIsolation(policies, labels, proxySvc) {
    if (apart && !proxySvc) {
      throw new Error(
        `EGRESS_PROXY (${config.egressProxy}) is an address: with sandboxes apart from the services (KUBERNETES_SERVICES_NAMESPACE), it names the egress proxy's Service, whose pods alone they may reach`,
      );
    }
    const problem = isolationProblem(policies, labels, {
      ports: sandboxPorts(),
      proxy: apart ? { namespace: services.namespace, selector: proxySvc.selector } : null,
    });
    if (problem) {
      throw new Error(
        `the namespace ${api.namespace} doesn't isolate its sandboxes: ${problem}. Deckhand's NetworkPolicy lets them reach the egress proxy only (see docs/kubernetes.md)`,
      );
    }
  }

  // Fail closed too when the cluster doesn't apply the policies isolationProblem() read: the
  // probe's verdict (kube-probe.mjs), kept until they change or the lease is taken again.
  probe ??= createNetworkProbe({
    config,
    api,
    services,
    pullSecret,
    // Its ports sandboxes may use: EGRESS_PROXY's, and the engines' when the Service has it.
    proxy: async () => {
      const svc = await proxyService(services, config);
      const [main, ...more] = sandboxPorts();
      return {
        ip: svc?.ip ?? new URL(config.egressProxy).hostname,
        ports: [main, ...more.filter((port) => svc?.ports.includes(port))],
      };
    },
    labels: { ...owner, "deckhand.run": "network-probe", [ROLE]: SANDBOX },
    log,
    now,
    sleep,
    ...probeOptions,
  });
  async function checkEnforced(policies) {
    let problem;
    try {
      problem = await probe.check(policies);
    } catch (error) {
      throw new Error(
        `the runner couldn't check that the cluster enforces the sandboxes' NetworkPolicies: ${error.message} (see docs/kubernetes.md)`,
      );
    }
    if (problem) {
      throw new Error(
        `the cluster doesn't enforce the sandboxes' NetworkPolicies: ${problem}. The runner probes again when they change, or when it restarts (see docs/kubernetes.md)`,
      );
    }
  }

  // The session volume's claim, made when missing. → true when it was made now.
  async function ensureClaim(volume) {
    if (await api.find(claimPath(volume))) return false;
    await api.create("persistentvolumeclaims", {
      apiVersion: "v1",
      kind: "PersistentVolumeClaim",
      metadata: {
        name: kubeName(volume),
        labels: { ...owner, [ROLE]: "session" },
        annotations: { "deckhand.volume": volume },
      },
      spec: {
        accessModes: ["ReadWriteOnce"],
        resources: { requests: { storage: sessionSize } },
        ...(storageClass ? { storageClassName: storageClass } : {}),
      },
    });
    return true;
  }

  async function pods() {
    const { items = [] } = await api.get("pods", { labelSelector: selector(SANDBOX) });
    return items.filter((pod) => !probing(pod));
  }

  // Throws when the API can't tell, rather than "none".
  async function list() {
    return (await pods()).map((pod) => ({
      name: pod.metadata.annotations?.["deckhand.name"] ?? pod.metadata.name,
      run: pod.metadata.annotations?.["deckhand.run"] ?? null,
      running: running(pod),
    }));
  }

  // Pending counts: it exists, and its run goes on once it starts (follow()).
  const running = (pod) => !["Succeeded", "Failed"].includes(pod.status?.phase);

  async function state(name) {
    const pod = await look(name);
    return pod ? (running(pod) ? "running" : "exited") : null;
  }

  // The sandbox container's exit code once it ended, or null (running, gone): the runner's run
  // events.
  async function exitCode(name) {
    const pod = await look(name);
    const code = (pod?.status?.containerStatuses ?? []).find((s) => s.name === CONTAINER)?.state
      ?.terminated?.exitCode;
    return Number.isInteger(code) ? code : null;
  }

  // The pod, or null when there is none. An error of the API's (not a 404) is asked again,
  // backing off, and thrown only past API_RETRY_MS. A pod its node lost (lost()) is
  // force-deleted, and null.
  async function look(name) {
    const since = now();
    for (let tries = 0; ; tries++) {
      let pod;
      try {
        pod = await api.find(podPath(name));
      } catch (error) {
        if (now() - since >= API_RETRY_MS) throw error;
        const pause = API_BACKOFF_MS[Math.min(tries, API_BACKOFF_MS.length - 1)];
        log(`${name}: ${error.message} (asked again in ${pause / 1000} s)`);
        await sleep(pause);
        continue;
      }
      if (!pod || !lost(pod)) return pod;
      log(
        `${name}: its node lost it (${pod.status?.phase}, deleted ${pod.metadata.deletionTimestamp ?? "not yet"}): force-deleting it`,
      );
      await api
        .remove(podPath(name), { gracePeriodSeconds: 0 })
        .catch((error) => log(`Removing ${name}: ${error.message}`));
      return null;
    }
  }

  // Never to be confirmed gone: deleted, and still there well past its deadline (Kubernetes
  // sets deletionTimestamp to when the grace ends), or Unknown (its node stopped reporting)
  // since long enough, by its conditions' latest change.
  function lost(pod) {
    const deadline = Date.parse(pod.metadata?.deletionTimestamp ?? "");
    if (deadline && now() - deadline >= STUCK_MS) return true;
    if (pod.status?.phase !== "Unknown") return false;
    const changes = (pod.status.conditions ?? [])
      .map((c) => Date.parse(c.lastTransitionTime ?? ""))
      .filter(Boolean);
    const since = changes.length
      ? Math.max(...changes)
      : Date.parse(pod.metadata?.creationTimestamp ?? "") || now();
    return now() - since >= UNKNOWN_MS;
  }

  // Resolves once the pod's log ends (it exited, or the API closed the stream: state() tells).
  // `skip`: { out, err } lines already read by a previous follower (the runner's copy before). The log has the agent's
  // output and the rest in one stream, told apart by STDERR_TAG. A pod that stays Pending past
  // KUBERNETES_PENDING_MINUTES is removed, and its run fails with the reason.
  //
  // A stream the API server dropped without closing it (an instance replaced during an
  // upgrade) would never end: while it lasts, the pod is looked at every watchMs, and once it
  // has been seen exited twice in a row, the stream is let go and its log read once more,
  // whole, for the lines it hadn't delivered.
  // `onCaughtUp()`: once, when both streams are past the lines skipped (docker.mjs follow()).
  // `signal`: the caller is gone (the runner service's), the stream ends.
  async function follow(
    name,
    { skip = { out: 0, err: 0 }, onOut, onErr, onCaughtUp = () => {}, signal },
  ) {
    if (!(await started(name, onErr))) return;
    let seen = { out: 0, err: 0 };
    let past = skip;
    let caught = false;
    const catchUp = () => {
      if (caught || seen.out < skip.out || seen.err < skip.err) return;
      caught = true;
      try {
        onCaughtUp();
      } catch (error) {
        log(`The log of ${name}: ${error.stack ?? error}`);
      }
    };
    catchUp();
    const each = (raw, at) => {
      const kind = raw.startsWith(STDERR_TAG) ? "err" : "out";
      const line = kind === "err" ? raw.slice(STDERR_TAG.length) : raw;
      if (seen[kind]++ < past[kind]) return catchUp();
      catchUp();
      try {
        (kind === "out" ? onOut : onErr)(line, at);
      } catch (error) {
        log(`The log of ${name}: ${error.stack ?? error}`);
      }
    };
    const stop = new AbortController();
    const watch = watchdog(name, stop);
    // The caller gone (the runner service's): the stream ends, nothing more is read.
    const gone = () => stop.abort();
    signal?.addEventListener("abort", gone, { once: true });
    try {
      await readLog(name, { follow: "true" }, stop.signal, each);
    } catch (error) {
      if (signal?.aborted) return;
      if (!stop.signal.aborted) {
        // The caller follows again while the pod runs (runs.mjs follow()).
        log(`The log of ${name}: ${error.message}`);
        return;
      }
      log(`The log of ${name}: its stream outlived the pod, reading the rest`);
      past = { out: Math.max(skip.out, seen.out), err: Math.max(skip.err, seen.err) };
      seen = { out: 0, err: 0 };
      try {
        await readLog(name, {}, AbortSignal.timeout(WATCH_MS), each);
      } catch (error) {
        log(`The log of ${name}: ${error.message}`);
      }
      return;
    } finally {
      clearInterval(watch);
      signal?.removeEventListener("abort", gone);
    }
    // The kubelet rotates a container's log (containerLogMaxSize): what was rotated away is
    // gone, and lines were read twice or will be skipped.
    if (seen.out + seen.err < skip.out + skip.err) {
      log(
        `The log of ${name} has ${seen.out + seen.err} lines, fewer than the ${skip.out + skip.err} already read: the kubelet rotated it. Set its containerLogMaxSize above RUN_LOG_MAX_MB (docs/kubernetes.md, Requirements)`,
      );
    }
  }

  // The pod's log, line by line to `each`, until it ends or `signal` aborts.
  async function readLog(name, query, signal, each) {
    const res = await api.stream(
      `${podPath(name)}/log`,
      { container: CONTAINER, ...query, timestamps: "true" },
      signal,
    );
    const split = splitLines(each);
    for await (const chunk of res.body ?? []) split(Buffer.from(chunk));
  }

  // Aborts `stop` once the pod has been seen exited (or gone) on two looks in a row: the
  // first may come while the stream still delivers its last lines.
  function watchdog(name, stop) {
    let looking = false;
    let exited = 0;
    const timer = setInterval(async () => {
      if (looking) return;
      looking = true;
      try {
        exited = (await state(name)) === "running" ? 0 : exited + 1;
        if (exited >= 2) stop.abort();
      } catch (error) {
        log(`The log of ${name}: ${error.message}`);
      } finally {
        looking = false;
      }
    }, watchMs);
    timer.unref?.();
    return timer;
  }

  // Until the pod leaves Pending: true once its container ran, false when it is gone.
  // A failed install in its init container (the agent without a claim) fails the run, with
  // the installer's output in the run's log (`onErr`), as a failed install does on Docker.
  async function started(name, onErr = () => {}) {
    for (;;) {
      const pod = await look(name);
      if (!pod) return false;
      const code = failedInit(pod);
      if (code !== null) {
        const agent = pod.metadata?.annotations?.[AGENT_INIT] ?? "its agent";
        await readLog(
          name,
          { container: INIT_CONTAINER },
          AbortSignal.timeout(WATCH_MS),
          (line, at) => onErr(line, at),
        ).catch((error) => log(`The install log of ${name}: ${error.message}`));
        log(`${name}: installing ${agent} failed (exit ${code})`);
        throw new RunError(
          `The sandbox couldn't start on the Kubernetes runner: installing its agent (${agent}) in its init container failed (exit ${code}); the installer's output is in the run's log. The operator can check that the install reaches its hosts through the egress proxy, or set KUBERNETES_AGENT_STORAGE_CLASS to install it once per version. Comment again to retry.`,
        );
      }
      if (pod.status?.phase !== "Pending") return true;
      if (overdue(pod)) {
        const why = await whyPending(name, pod);
        log(`${name}: Pending for ${minutes(pendingMs)} min (${why}): removing it`);
        await kill(name).catch((error) => log(`Removing ${name}: ${error.message}`));
        const fix =
          why === INSTALLING
            ? "The operator can check that the agent's install reaches its hosts through the egress proxy, or set KUBERNETES_AGENT_STORAGE_CLASS to install it once per version"
            : "The operator can make room in the cluster, or check the image";
        throw new RunError(
          `The sandbox couldn't start on the Kubernetes runner: its pod stayed Pending for ${minutes(pendingMs)} min (${why}). ${fix} (KUBERNETES_PENDING_MINUTES sets the wait). Comment again to retry.`,
        );
      }
      await sleep(POLL_MS);
    }
  }

  // pendingReason(), else the pod's latest Warning event, else that Kubernetes didn't say.
  async function whyPending(name, pod) {
    const said = pendingReason(pod);
    if (said) return said;
    try {
      const { items = [] } = await api.get("events", {
        // By its uid too: the pod's name is the task's, the same for every run of the issue,
        // and a previous pod's events outlive it (about an hour).
        fieldSelector: `involvedObject.kind=Pod,involvedObject.name=${kubeName(name)},involvedObject.uid=${pod.metadata?.uid ?? ""}`,
      });
      return latestWarning(items) ?? UNSAID;
    } catch (error) {
      log(`The events of ${name}: ${error.message}`);
      return UNSAID;
    }
  }

  // Whether a pod is still Pending past KUBERNETES_PENDING_MINUTES.
  function overdue(pod) {
    if (pod.status?.phase !== "Pending") return false;
    const since = Date.parse(pod.metadata?.creationTimestamp ?? "") || now();
    return now() - since >= pendingMs;
  }

  // Until it exits. A leftover stuck Pending (an image it can't pull; one a restarted
  // orchestrator found without saved state, which nothing follows) would never exit: past the limit, it is
  // removed instead, its requests given back to the cluster.
  async function wait(name) {
    for (;;) {
      const pod = await look(name);
      if (!pod || !running(pod)) return;
      if (overdue(pod) && !pod.metadata.deletionTimestamp) {
        log(
          `${name}: Pending for ${minutes(pendingMs)} min (${await whyPending(name, pod)}): removing it`,
        );
        await kill(name);
      }
      await sleep(POLL_MS);
    }
  }

  // Deleting it is the only way to stop a pod: SIGTERM, then SIGKILL after the grace.
  async function kill(name) {
    await api.remove(podPath(name), { gracePeriodSeconds: KILL_GRACE_S });
  }

  // Without `run` (a leftover sandbox), its Secret is the one its annotation names. A pod
  // still running (its run ended on an error) gets its grace, as with kill().
  // Only a sandbox pod of this deployment's (its labels) and that run's, and only its run's
  // Secret: never another pod or Secret of the namespace that has the name.
  const ownedBy = (object) =>
    object?.metadata?.labels?.["deckhand.owner"] === owner["deckhand.owner"];
  async function remove(name, run) {
    const found = await api.find(podPath(name));
    const runOfPod = found?.metadata?.annotations?.["deckhand.run"];
    const pod = ownedBy(found) && (!run || runOfPod === run) ? found : null;
    if (found && !pod) log(`Not removing the pod ${name}: not a sandbox of this deployment's`);
    const which = run ?? pod?.metadata?.annotations?.["deckhand.run"];
    if (pod) {
      const grace = running(pod) ? KILL_GRACE_S : 0;
      await api.remove(podPath(name), { gracePeriodSeconds: grace });
      // Its address no longer names it; the others' answers are kept as they were.
      forgetUids({ removed: pod.metadata?.uid ?? true });
    }
    if (which) {
      const secret = await api.find(`secrets/${secretName(which)}`);
      if (ownedBy(secret) && secret.metadata?.annotations?.["deckhand.run"] === which) {
        await api.remove(`secrets/${secretName(which)}`);
      }
    }
    if (run) inbox.remove(run);
  }

  // The agent's session claim (its `session`), kept by the issue's runs.
  async function hasSession(name, agent = agentFor()) {
    return Boolean(await api.find(claimPath(`${name}-${agent.session.volume}`)));
  }

  // Whether the sandbox's init container is installing its agent: its pod has one, and it
  // hasn't ended yet. Asked of the init container's own status, not the pod's phase, which
  // the kubelet reports Running only at its next sync, after the sandbox has started; and
  // never kept, for the same reason. A no is final for the run, which the caller remembers
  // (egress-http.mjs): an init container that ended never runs again. Null when the API
  // can't tell.
  async function installing(name) {
    let pod;
    try {
      pod = await api.find(podPath(name));
    } catch (error) {
      log(`${name}: whether it installs its agent: ${error.message}`);
      return null;
    }
    if (!pod?.metadata?.annotations?.[AGENT_INIT] || pod.status?.phase !== "Pending") return false;
    const init = (pod.status?.initContainerStatuses ?? []).find((s) => s.name === INIT_CONTAINER);
    return !init?.state?.terminated;
  }

  // The UID of the sandbox's pod that has an IP, or null: what the run's tokens are bound to
  // (../broker.mjs check()). A UID, not the pod's name (each of the issue's runs has the same)
  // nor its IP (reused). Cached for PROXY_TTL_MS, as each call to the broker asks, an address
  // with no sandbox for PROXY_RETRY_MS (a token replayed from elsewhere asks the API that often
  // at most), and looked up again as a sandbox starts (what was known kept, should that lookup
  // fail) or forgotten as one is removed. One lookup per address at a time: the connections that
  // ask meanwhile share it. An API error answers what was known, and is asked again after
  // PROXY_RETRY_MS: a blip mustn't refuse every sandbox, nor cost an API call per connection.
  // Known means answered by the API within PROXY_TTL_MS (`goodAt`), never carried forward by
  // failures: past that, an outage fails closed (nobody's), as a pod gone without remove()
  // (evicted, its node lost) may have left its address to another run's.
  let uids = new Map(); // ip → { uid, at, goodAt, failed }
  const fresh = (k) => !!k?.uid && now() - (k.goodAt ?? -Infinity) < PROXY_TTL_MS;
  const looking = new Map(); // ip → Promise<uid>
  let uidsGen = 0; // counts forgetUids()
  // `removed`: the UID of the pod removed (true: unknown, all of them go).
  function forgetUids({ removed = null } = {}) {
    uidsGen++;
    looking.clear();
    if (removed === true) return void (uids = new Map());
    // Every answer looked up again; the sandboxes known (fresh()) kept for a failed lookup, not
    // the addresses that had none (the new pod may have one of them now) nor the removed pod's.
    uids = new Map(
      [...uids]
        .filter(([, k]) => fresh(k) && k.uid !== removed)
        .map(([ip, k]) => [ip, { ...k, at: -Infinity }]),
    );
  }
  async function sandboxOf(ip) {
    const known = uids.get(ip);
    const age = known ? now() - known.at : Infinity;
    const ttl = known?.uid && !known.failed ? PROXY_TTL_MS : PROXY_RETRY_MS;
    if (known && age < ttl) return known.uid;
    if (!looking.has(ip)) {
      looking.set(
        ip,
        podUid(ip).finally(() => looking.delete(ip)),
      );
    }
    return looking.get(ip);
  }

  // The API's answer for sandboxOf(), cached.
  async function podUid(ip) {
    const seen = uidsGen;
    let uid = null;
    try {
      const { items = [] } = await api.get("pods", {
        labelSelector: selector(SANDBOX),
        fieldSelector: `status.podIP=${ip}`,
      });
      // Checked here too: the API's answer for that address, and no other.
      const at = (p) => p.status?.podIP === ip || (p.status?.podIPs ?? []).some((a) => a.ip === ip);
      const live = items.filter(
        (p) => at(p) && !p.metadata?.deletionTimestamp && running(p) && !probing(p),
      );
      uid = live.length === 1 ? (live[0].metadata?.uid ?? null) : null;
    } catch (error) {
      // What was known, if the API said so within PROXY_TTL_MS, until PROXY_RETRY_MS on.
      log(`Looking up the sandbox at ${ip}: ${error.message}`);
      const known = uids.get(ip);
      const kept = fresh(known) ? known.uid : null;
      if (seen === uidsGen) {
        uids.set(ip, { uid: kept, at: now(), goodAt: known?.goodAt, failed: true });
      }
      return kept;
    }
    if (uids.size > 1000) uids = new Map();
    // Unless a sandbox started or went meanwhile: its answer would be older than that.
    if (seen === uidsGen) uids.set(ip, { uid, at: now(), goodAt: now() });
    return uid;
  }

  // The IPs of the pods behind the egress Service, in the services' namespace, ready or not
  // (one starting still relays).
  async function proxyAddresses({ fresh = false } = {}) {
    const age = now() - proxy.at;
    if (age < PROXY_TTL_MS && !(fresh && age >= PROXY_RETRY_MS)) return proxy.addresses;
    const at = now();
    let addresses = [];
    try {
      const service = aliasOf(config.egressProxy);
      const { items = [] } = await services.get(
        `${DISCOVERY}/${services.namespace}/endpointslices`,
        { labelSelector: `kubernetes.io/service-name=${service}` },
      );
      addresses = [
        ...new Set(items.flatMap((s) => (s.endpoints ?? []).flatMap((e) => e.addresses ?? []))),
      ];
    } catch (error) {
      log(`Looking up the egress proxy: ${error.message}`);
    }
    proxy = { at, addresses };
    return addresses;
  }

  // No networks to join again: the Secrets of runs whose pod is gone are removed. Secrets
  // first, then pods, with the runs starting in between: one listed here either has its pod
  // listed below or belongs to a run still starting.
  async function relink() {
    const { items = [] } = await api.get("secrets", { labelSelector: selector(ENV) });
    const pending = new Set(starting);
    const runs = new Set((await list()).map((s) => s.run));
    for (const secret of items) {
      const run = secret.metadata.annotations?.["deckhand.run"];
      if (!run || runs.has(run) || pending.has(run)) continue;
      log(`Removing the Secret ${secret.metadata.name}: its run is gone`);
      await api.remove(`secrets/${secret.metadata.name}`);
    }
  }

  return {
    start,
    list,
    state,
    exitCode,
    follow,
    send: inbox.send,
    close: inbox.close,
    closed: inbox.closed,
    resync: inbox.resync,
    wait,
    kill,
    remove,
    hasSession,
    installing,
    relink,
    proxyAddresses,
    // The runner service took its lease: the network probe runs again (kube-probe.mjs).
    leased: () => probe.reset(),
    // The pod at that address is the sandbox: no other container of a run has one of its own.
    locate: async (ip) => {
      const sandbox = await sandboxOf(ip);
      return sandbox ? { sandbox, name: null } : null;
    },
  };
}

const minutes = (ms) => Math.round(ms / 60000);
