// What ../images.mjs asks of the backend, on Kubernetes (the Docker runner's: images.mjs here).
// A cluster's nodes pull from a registry only, so:
//
//   - A repo's image is built by a BuildKit daemon in the services' namespace (KUBERNETES_BUILDKIT),
//     driven with buildctl (buildkit.mjs), and pushed to the operator's registry
//     (KUBERNETES_REGISTRY), whose API (registry.mjs) says whether a tag is there, lists the
//     tags to prune and deletes them. Its credentials, and the nodes' pull Secret, are one
//     kubernetes.io/dockerconfigjson Secret (KUBERNETES_REGISTRY_SECRET, kube-pull.mjs). The daemon goes out
//     through the egress proxy: while a build runs, it may reach the hosts of the repo it
//     builds (egressFor()), and builds of repos granted other hosts wait for each other.
//   - An agent is installed once per version into a claim every sandbox mounts read-only, of
//     a ReadWriteMany class (KUBERNETES_AGENT_STORAGE_CLASS) or made beforehand, by a pod of
//     its own (installAgent()). Without either, each sandbox installs it into an emptyDir, in
//     an init container (kubernetes.mjs podSpec()).
//   - A repo's caches are claims of a ReadWriteMany class (KUBERNETES_CACHE_STORAGE_CLASS),
//     which concurrent runs mount; without one, runs go without (preparation.mjs says so).
//
// The installs run as INSTALL_USER, neither root nor the sandbox's user: Pod Security
// `restricted` allows no root, and a sandbox mustn't own what the next one runs.
import { setTimeout as delay } from "node:timers/promises";
import { egressPolicy, proxyEnv } from "../egress.mjs";
import { buildArgs, buildctl as buildctlCli, withDockerConfig } from "./buildkit.mjs";
import { createPullSecret } from "./kube-pull.mjs";
import {
  aliasesOf,
  excludesSandboxes,
  INSTALL_USER,
  kubeName,
  labelValue,
  proxyService,
  quantity,
  selects,
} from "./kubernetes.mjs";
import { aliasOf } from "./networks.mjs";
import { SANDBOX_USER } from "../sandbox-spec.mjs";
import { authsOf, createRegistry, parseRef } from "./registry.mjs";

const DISCOVERY = "/apis/discovery.k8s.io/v1/namespaces";
const NETWORKING = "/apis/networking.k8s.io/v1/namespaces";
const POLL_MS = 2000;
// A build that hasn't ended by then (a RUN step that hangs) is stopped: builds of repos
// granted other hosts wait for it (gate()).
export const BUILD_MS = 60 * 60_000;
// How long a check that a claim is writable may take, from creating its pod.
const CHECK_MS = 5 * 60_000;
// What a pod's shell exits with when its claim isn't writable (writable()).
const NOT_WRITABLE = 97;

// The hosts a registry sends a client to besides itself, known beforehand: the BuildKit daemon
// pulls through the egress proxy before the runner has seen them (registry.mjs hostsOf()
// learns the others as the runner reads the registry). Docker Hub's API, token service and
// layer storage; GitHub's registry's layer storage.
export const REGISTRY_HOSTS = {
  "docker.io": [
    "registry-1.docker.io",
    "auth.docker.io",
    "production.cloudflare.docker.com",
    "production.cloudfront.docker.com",
    "docker-images-prod.6aa30f8b08e16409b46e0173d6de2f56.r2.cloudflarestorage.com",
  ],
  "ghcr.io": ["pkg-containers.githubusercontent.com"],
};

// Why the services' namespace's NetworkPolicies (`policies`) don't isolate the BuildKit
// daemon's pods (`labels`), or null when they do: one picks them for Egress and one for
// Ingress, and none of those that pick them lets them out but to the namespace's pods (the
// egress proxy) and to DNS (UDP or TCP port 53, no range), or in but from the namespace's pods
// (the runner's), never from another namespace. Without that, a Dockerfile's RUN steps could
// skip the proxy, or anything (a sandbox among them) could drive the daemon, which asks for no
// credentials. Fail closed.
// With the sandboxes in that namespace too (`sandboxesApart` false), an ingress peer has to
// rule them out, as their own policy lets them reach any pod that isn't one; apart, none runs
// there.
export function builderIsolationProblem(policies, labels, { sandboxesApart = false } = {}) {
  const picking = policies.filter((p) => selects(p.spec?.podSelector, labels));
  const types = (p) => p.spec.policyTypes ?? (p.spec.egress ? ["Ingress", "Egress"] : ["Ingress"]);
  for (const type of ["Egress", "Ingress"]) {
    if (!picking.some((p) => types(p).includes(type))) {
      return `no NetworkPolicy picks the BuildKit daemon's pods for ${type}`;
    }
  }
  const dns = (rule) =>
    rule.ports?.length &&
    rule.ports.every(
      (port) =>
        String(port.port) === "53" &&
        port.endPort === undefined &&
        ["UDP", "TCP", undefined].includes(port.protocol),
    );
  for (const p of picking) {
    const name = `the NetworkPolicy ${p.metadata?.name}`;
    for (const rule of p.spec.egress ?? []) {
      // DNS anywhere, written without `to`, as policies often are.
      if (!rule.to?.length && dns(rule)) continue;
      if (!rule.to?.length) return `${name} lets the BuildKit daemon reach anything`;
      const wide = rule.to.some(
        (peer) => peer.ipBlock || peer.namespaceSelector || !peer.podSelector,
      );
      if (wide && !dns(rule)) {
        return `${name} lets the BuildKit daemon reach beyond the namespace's pods (DNS aside)`;
      }
    }
    for (const rule of p.spec.ingress ?? []) {
      const wide =
        !rule.from?.length ||
        rule.from.some((peer) => peer.ipBlock || peer.namespaceSelector || !peer.podSelector);
      if (wide)
        return `${name} lets traffic in to the BuildKit daemon from beyond the namespace's pods`;
      if (
        !sandboxesApart &&
        rule.from.some((peer) => !excludesSandboxes(peer.podSelector, SANDBOX_LABELS))
      ) {
        return `${name} lets sandbox pods reach the BuildKit daemon`;
      }
    }
  }
  return null;
}

// The label keys a sandbox pod carries (kubernetes.mjs start()), and its role: what a peer
// has to rule out to never pick one.
const SANDBOX_LABELS = { "deckhand.owner": "", "deckhand.run": "", "deckhand.role": "sandbox" };

// A shell command for a pod: runs the rest, if any, once its user proved it may write to "$1"
// (a claim's mount point). The kubelet applies a pod's fsGroup to a claim only where its
// storage allows (a CSI driver's fsGroupPolicy, NFS's root_squash): said plainly
// (NOT_WRITABLE), rather than an EACCES halfway through an install. A claim it can't write
// may still hold what the command would put there (a claim filled beforehand, which an
// installer leaves as it is): the command runs anyway, and only its failure is NOT_WRITABLE.
const WRITABLE = `p=$1; shift
if t=$(mktemp -p "$p" .deckhand-check-XXXXXX 2>/dev/null); then rm -f "$t"; [ $# -eq 0 ] || exec "$@"; exit 0; fi
[ $# -gt 0 ] && "$@" && exit 0
exit ${NOT_WRITABLE}`;
export const writable = (path, ...command) => ["sh", "-c", WRITABLE, "sh", path, ...command];

// What NOT_WRITABLE means, for an error: a claim the storage class doesn't hand to the pod.
const notWritable = (claim, user, storageClass) =>
  `the claim ${claim} isn't writable by uid ${user.uid}: its storage class${storageClass ? ` (${storageClass})` : ""} has to apply the pod's fsGroup (for a CSI driver, fsGroupPolicy: File) or give new volumes a root every user can write (docs/setup.md, Kubernetes runner)`;
// An install pod that hasn't ended by then (stuck Pending, npm hanging) fails, and goes.
const INSTALL_MS = 15 * 60_000;
// The BuildKit pods' addresses, read again after this long.
const BUILDER_TTL_MS = 10_000;
const BASE_TTL_MS = 60_000;

export function createKubernetesImages({
  config,
  api, // kube-api.mjs, in the sandboxes' namespace: the install pods, the claims
  services = api, // the same, in the services' (the same object when they are one): BuildKit
  pullSecret = createPullSecret({ config, api, services }), // kube-pull.mjs
  fetch = globalThis.fetch, // the registry's
  buildctl = buildctlCli,
  log = () => {},
  now = Date.now,
  sleep = delay,
  buildMs = BUILD_MS,
}) {
  const k = config.kubernetes;
  const owner = { "deckhand.owner": labelValue(config.prefix) };
  const claimPath = (name) => `persistentvolumeclaims/${kubeName(name)}`;
  const apart = services.namespace !== api.namespace;
  let builder = { at: -Infinity, addresses: [] };
  const registry = createRegistry({
    fetch,
    auths: async () => authsOf(JSON.parse(await pullSecret.text())),
  });

  // The image's digest in its registry, or null when it isn't there. The base image's too:
  // a new one pushed under the same tag gives repo images a new tag (images.mjs imageTag()).
  // The base's is kept a minute: every run with a Dockerfile asks for it.
  let base = { at: -Infinity, digest: null };
  async function id(ref) {
    if (ref !== config.image) return registry.digest(ref);
    if (base.digest && now() - base.at < BASE_TTL_MS) return base.digest;
    base = { at: now(), digest: await registry.digest(ref) };
    return base.digest;
  }

  // Builds in progress: the hosts each may reach, by what they are (gate()).
  const running = { key: null, count: 0, hosts: [], trusted: [] };
  const queue = []; // { key, hosts, trusted, admit }, first come first served

  // Builds of one set of hosts run together; another set waits until they are done: the
  // daemon's address is the same for all of them, and one repo's Dockerfile mustn't reach
  // what another's grant allows. In order of arrival: once a build of another set waits,
  // builds of the running set wait behind it, rather than keep it waiting for ever.
  async function gate(hosts, trusted) {
    const key = JSON.stringify([[...hosts].sort(), [...trusted].sort()]);
    if (!queue.length && (!running.count || running.key === key)) {
      Object.assign(running, { key, hosts, trusted, count: running.count + 1 });
    } else {
      await new Promise((admit) => queue.push({ key, hosts, trusted, admit }));
    }
    return () => {
      running.count--;
      if (running.count) return;
      running.key = null;
      // The next set: the first in line, and those of the same set right behind it.
      while (queue.length && (!running.count || queue[0].key === running.key)) {
        const next = queue.shift();
        Object.assign(running, {
          key: next.key,
          hosts: next.hosts,
          trusted: next.trusted,
          count: running.count + 1,
        });
        next.admit();
      }
    };
  }

  // `hosts` and `trusted`: what the run may reach (access.mjs). Its RUN steps go through the
  // egress proxy; the daemon's own pulls and pushes do as its Deployment's environment says
  // (docs/setup.md, Kubernetes runner), with the registries' hosts (builderHosts()). Not
  // without the NetworkPolicies that make the proxy its only way out (builderIsolation()).
  async function build({ dir, dockerfile, tag, labels = {}, output, hosts = [], trusted = [] }) {
    const problem = await builderIsolation();
    if (problem) return { code: 1, out: "", err: problem };
    const registries = builderHosts([tag, config.image]);
    const done = await gate([...hosts, ...registries], [...trusted, ...registries]);
    const signal = AbortSignal.timeout(buildMs);
    try {
      const args = buildArgs({
        addr: builderAddr(),
        dir,
        dockerfile,
        ref: tag,
        buildArgs: {
          // As under Docker: `ARG DECKHAND_BASE` / `FROM $DECKHAND_BASE`.
          DECKHAND_BASE: config.image,
          ...proxyArgs(),
        },
        labels,
      });
      const built = await withDockerConfig(await pullSecret.text(), (env) =>
        buildctl(args, { env, onData: output, signal }),
      );
      if (signal.aborted) {
        return { code: 1, out: "", err: `stopped after ${buildMs / 60_000} min` };
      }
      return built;
    } finally {
      done();
    }
  }

  // The registries of `refs` (the image built, its base), and the hosts each sends a puller
  // to: those known (REGISTRY_HOSTS), those the runner saw it send it to, and the operator's
  // (KUBERNETES_REGISTRY_HOSTS).
  function builderHosts(refs) {
    const found = [...(k.registryHosts ?? [])];
    for (const host of new Set(refs.map((ref) => parseRef(ref).host))) {
      found.push(host, ...(REGISTRY_HOSTS[host] ?? []), ...registry.hostsOf(host));
    }
    return [...new Set(found)];
  }

  // The daemon's address for buildctl. Its Service's short name resolves in the runner's own
  // namespace: apart, it is named in the services' namespace, so that the daemon built on is
  // the one builderIsolation() checked, wherever the runner runs.
  function builderAddr() {
    if (!apart) return k.buildkit;
    const url = new URL(k.buildkit);
    return `tcp://${url.hostname}.${services.namespace}.svc:${url.port}`;
  }

  // builderIsolationProblem() for the daemon's pods (the endpoints of its Service, in the
  // services' namespace), checked again after a while; also a problem: no daemon behind its
  // Service.
  let isolation = { at: -Infinity, problem: null };
  async function builderIsolation() {
    if (now() - isolation.at < BUILDER_TTL_MS) return isolation.problem;
    const service = aliasOf(k.buildkit);
    const { items: slices = [] } = await services.get(
      `${DISCOVERY}/${services.namespace}/endpointslices`,
      { labelSelector: `kubernetes.io/service-name=${service}` },
    );
    const pods = slices.flatMap((s) =>
      (s.endpoints ?? []).map((e) => e.targetRef).filter((r) => r?.kind === "Pod"),
    );
    let problem = pods.length
      ? null
      : `no BuildKit daemon behind the Service ${service} in the namespace ${services.namespace} (KUBERNETES_BUILDKIT)`;
    if (!problem) {
      const { items: policies = [] } = await services.get(
        `${NETWORKING}/${services.namespace}/networkpolicies`,
      );
      for (const ref of pods) {
        const labels = (await services.find(`pods/${ref.name}`))?.metadata?.labels ?? {};
        problem = builderIsolationProblem(policies, labels, { sandboxesApart: apart });
        if (problem) break;
      }
    }
    if (problem) {
      problem = `the BuildKit daemon isn't isolated: ${problem}. Its NetworkPolicies let it reach the egress proxy only, and only the runner reach it (see docs/setup.md, Repo images on Kubernetes)`;
    }
    isolation = { at: now(), problem };
    return problem;
  }

  // The egress proxy, for the build's RUN steps: Docker's predefined proxy build args.
  function proxyArgs() {
    const { HTTP_PROXY, HTTPS_PROXY, http_proxy, https_proxy } = proxyEnv(config);
    return { HTTP_PROXY, HTTPS_PROXY, http_proxy, https_proxy };
  }

  // Newest first, by when each was built, as `docker image ls` gives them. A tag whose date
  // can't be read is left out, logged: neither pruned as if it were the oldest nor taken for
  // the default branch's newest.
  async function tags(name) {
    let found;
    try {
      found = await registry.tags(name);
    } catch (error) {
      log(`Listing the tags of ${name}: ${error.message}`);
      return null;
    }
    if (!found) return null;
    const dated = [];
    for (const tag of found) {
      try {
        dated.push({ tag, at: await registry.created(`${name}:${tag}`) });
      } catch (error) {
        log(`Dating ${name}:${tag} (kept): ${error.message}`);
      }
    }
    return dated.sort((a, b) => b.at - a.at).map((d) => d.tag);
  }

  // A tag a pod runs stays, as Docker keeps an image a container uses. Deleting a manifest
  // deletes every tag that points at it: when one that stays (`kept`, images.mjs prune()'s, or
  // a pod's) shares it (an identical build, which BuildKit's cache makes often), only the tag
  // goes, where the registry can delete a tag alone (OCI distribution 1.1), else it stays.
  // Never throws, as Docker's doesn't: a prune that fails is logged, the run goes on.
  async function remove(ref, kept = []) {
    const name = ref.slice(0, ref.lastIndexOf(":"));
    try {
      const { items = [] } = await api.get("pods", {
        labelSelector: `deckhand.owner=${owner["deckhand.owner"]}`,
      });
      const used = items.flatMap((p) => (p.spec?.containers ?? []).map((c) => c.image));
      if (used.includes(ref)) return;
      const digest = await registry.digest(ref);
      if (!digest) return;
      for (const other of new Set([...kept, ...used.filter((i) => i.startsWith(`${name}:`))])) {
        if (other === ref || (await registry.digest(other)) !== digest) continue;
        // Logged, as a refused delete is: the tag is tried again at the next prune.
        await registry
          .remove(name, ref.slice(name.length + 1))
          .catch((error) => log(`Pruning ${ref} (its tag only): ${error.message}`));
        return;
      }
      await registry.remove(name, digest);
    } catch (error) {
      log(`Pruning ${ref}: ${error.message}`);
    }
  }

  async function volumeExists(name) {
    return Boolean(await api.find(claimPath(name)));
  }

  // A cache's claim. No chown: the sandbox pod's fsGroup makes it the sandbox user's, which a
  // short pod as that user checks first (writable()); a claim it can't write goes again.
  async function createVolume(name, labels = {}) {
    if (!k.cacheStorageClass) {
      return { code: 1, out: "", err: "no KUBERNETES_CACHE_STORAGE_CLASS" };
    }
    try {
      await api.create(
        "persistentvolumeclaims",
        claim(name, labels, k.cacheStorageClass, k.cacheSize, "cache"),
      );
    } catch (error) {
      if (error.status === 409) return { code: 0, out: "", err: "" };
      return { code: 1, out: "", err: error.message };
    }
    try {
      const ended = await runPod({
        pod: kubeName(`${config.prefix}-check-${kubeName(name)}`),
        role: "check",
        user: SANDBOX_USER,
        command: writable("/cache"),
        claim: kubeName(name),
        mount: "/cache",
        timeoutMs: CHECK_MS,
      });
      if (ended.code === 0) return { code: 0, out: "", err: "" };
      await removeVolume(name).catch(() => {});
      const err =
        ended.code === NOT_WRITABLE
          ? notWritable(kubeName(name), SANDBOX_USER, k.cacheStorageClass)
          : `checking it: ${ended.why}`;
      return { code: 1, out: "", err };
    } catch (error) {
      await removeVolume(name).catch(() => {});
      return { code: 1, out: "", err: `checking it: ${error.message}` };
    }
  }

  async function removeVolume(name) {
    await api.remove(claimPath(name));
  }

  function claim(name, labels, storageClass, size, role) {
    return {
      apiVersion: "v1",
      kind: "PersistentVolumeClaim",
      metadata: {
        name: kubeName(name),
        labels: {
          ...owner,
          "deckhand.role": role,
          ...Object.fromEntries(Object.entries(labels).map(([key, v]) => [key, labelValue(v)])),
        },
        annotations: { "deckhand.volume": name, ...labels },
      },
      spec: {
        // Every run of a repo at once, on any node; the installs write, sandboxes read.
        accessModes: ["ReadWriteMany"],
        resources: { requests: { storage: size } },
        storageClassName: storageClass,
      },
    };
  }

  // The agent's claim, made when missing and a class is set: true when there is one to
  // install into, false when sandboxes install the agent themselves (an init container).
  async function agentClaim(volume) {
    if (await volumeExists(volume)) return true;
    if (!k.agentStorageClass) return false;
    try {
      await api.create(
        "persistentvolumeclaims",
        claim(volume, {}, k.agentStorageClass, k.agentSize, "agent"),
      );
    } catch (error) {
      if (error.status !== 409) throw error;
    }
    return true;
  }

  // Install pods while they run, by name, for egressFor().
  const installs = new Map(); // pod name → hosts

  // `spec`: agents' install() and the agent's name. The installer is idempotent (one folder
  // per version, nothing done when it is there): it runs at the first run of each version
  // after the runner starts, and goes at once when the version is in the claim.
  async function installAgent({
    name,
    displayName,
    volume,
    mount,
    version,
    versionVar,
    command,
    env = {},
    hosts = [],
    output,
  }) {
    // No claim: the sandbox's init container installs it (kubernetes.mjs). Said, so that
    // images.mjs doesn't count the version as installed: a claim made later is filled then.
    if (!(await agentClaim(volume))) return { inSandbox: true };
    const ended = await runPod({
      pod: kubeName(`${config.prefix}-install-${name}-${version}`),
      role: "install",
      user: INSTALL_USER,
      command: writable(mount, command),
      env: { [versionVar]: version, ...env, ...proxyEnv(config) },
      claim: kubeName(volume),
      mount,
      hosts,
      output,
      timeoutMs: INSTALL_MS,
    });
    if (ended.code === NOT_WRITABLE) {
      throw new Error(
        `installing ${displayName} ${version} failed: ${notWritable(kubeName(volume), INSTALL_USER, k.agentStorageClass)}`,
      );
    }
    if (ended.code !== 0) {
      throw new Error(`installing ${displayName} ${version} failed: ${ended.why}`);
    }
  }

  // A short pod of the base image with `claim` at `mount`, as `user` (its group the claim's),
  // Pod Security `restricted`, removed once it ended; a leftover of the same name goes first.
  // `hosts`: what it may reach through the egress proxy (egressFor()), none without.
  // → { code, why }: its exit code (-1 when it didn't end within `timeoutMs`) and why it
  // failed. Its log goes to `output`.
  async function runPod({
    pod,
    role,
    user,
    command,
    env = {},
    claim,
    mount,
    hosts,
    output,
    timeoutMs,
  }) {
    await api.remove(`pods/${pod}`, { gracePeriodSeconds: 0 }).catch(() => {});
    await waitGone(pod);
    const limits = { cpu: String(config.limits.cpus), memory: quantity(config.limits.memory) };
    const pullName = await pullSecret.forPods();
    // Apart from the services, the cluster's DNS doesn't know the proxy's short name in the
    // sandboxes' namespace: its Service's IP, as sandboxes have it.
    const aliases = apart ? aliasesOf(await proxyService(services, config)) : [];
    await api.create("pods", {
      apiVersion: "v1",
      kind: "Pod",
      metadata: { name: pod, labels: { ...owner, "deckhand.role": role } },
      spec: {
        restartPolicy: "Never",
        automountServiceAccountToken: false,
        enableServiceLinks: false,
        ...(pullName ? { imagePullSecrets: [{ name: pullName }] } : {}),
        ...(aliases.length ? { hostAliases: aliases } : {}),
        securityContext: {
          runAsNonRoot: true,
          runAsUser: user.uid,
          runAsGroup: user.gid,
          // The claim becomes the user's group's to write, where its storage applies it.
          fsGroup: user.gid,
          fsGroupChangePolicy: "OnRootMismatch",
          seccompProfile: { type: "RuntimeDefault" },
        },
        containers: [
          {
            name: role,
            image: config.image,
            command,
            env: Object.entries(env).map(([key, value]) => ({ name: key, value: String(value) })),
            resources: { limits, requests: limits },
            securityContext: {
              allowPrivilegeEscalation: false,
              capabilities: { drop: ["ALL"] },
              runAsNonRoot: true,
              seccompProfile: { type: "RuntimeDefault" },
            },
            volumeMounts: [{ name: "claim", mountPath: mount }],
          },
        ],
        volumes: [{ name: "claim", persistentVolumeClaim: { claimName: claim } }],
      },
    });
    if (hosts) installs.set(pod, hosts);
    try {
      const ended = await ending(pod, timeoutMs);
      await readLog(pod, output);
      if (!ended) return { code: -1, why: `no end in ${timeoutMs / 60000} min` };
      const code = ended.status?.containerStatuses?.[0]?.state?.terminated?.exitCode;
      if (ended.status?.phase === "Succeeded") return { code: 0, why: null };
      return { code: code ?? -1, why: `exit ${code ?? ended.status?.phase}` };
    } finally {
      installs.delete(pod);
      await api
        .remove(`pods/${pod}`, { gracePeriodSeconds: 0 })
        .catch((e) => log(`Removing ${pod}: ${e.message}`));
    }
  }

  // The pod once it has ended, or null when it doesn't within `timeoutMs`.
  async function ending(pod, timeoutMs) {
    const since = now();
    while (now() - since < timeoutMs) {
      const found = await api.find(`pods/${pod}`);
      if (!found) throw new Error(`the pod ${pod} is gone`);
      if (["Succeeded", "Failed"].includes(found.status?.phase)) return found;
      await sleep(POLL_MS);
    }
    return null;
  }

  async function waitGone(pod) {
    const since = now();
    while ((await api.find(`pods/${pod}`)) && now() - since < 60_000) await sleep(POLL_MS);
  }

  async function readLog(pod, output = () => {}) {
    try {
      const res = await api.stream(`pods/${pod}/log`, {}, AbortSignal.timeout(30_000));
      for await (const chunk of res.body ?? []) output(Buffer.from(chunk));
    } catch (error) {
      log(`The log of ${pod}: ${error.message}`);
    }
  }

  // The BuildKit daemon's pod IPs: the endpoints of KUBERNETES_BUILDKIT's Service, in the
  // services' namespace.
  async function builderAddresses() {
    if (now() - builder.at < BUILDER_TTL_MS) return builder.addresses;
    let addresses = [];
    try {
      const service = aliasOf(k.buildkit);
      const { items = [] } = await services.get(
        `${DISCOVERY}/${services.namespace}/endpointslices`,
        { labelSelector: `kubernetes.io/service-name=${service}` },
      );
      addresses = items.flatMap((s) => (s.endpoints ?? []).flatMap((e) => e.addresses ?? []));
    } catch (error) {
      log(`Looking up the BuildKit daemon: ${error.message}`);
    }
    builder = { at: now(), addresses };
    return addresses;
  }

  async function installAddresses() {
    const found = new Map();
    for (const [pod, hosts] of installs) {
      const status = (await api.find(`pods/${pod}`).catch(() => null))?.status;
      for (const ip of [status?.podIP, ...(status?.podIPs ?? []).map((p) => p.ip)]) {
        if (ip) found.set(ip, hosts);
      }
    }
    return found;
  }

  // The egress proxy's answer for a caller that isn't a sandbox (egress-http.mjs), or null:
  // the BuildKit daemon while builds run (their hosts), an install pod (its agent's install
  // hosts). Tunnelled only, never decrypted, cached or relayed: neither trusts Deckhand's CA,
  // and neither gets a token.
  async function egressFor(ip, host) {
    const install = (await installAddresses()).get(ip);
    if (install) return egressPolicy(host, install, [], [], [], { decrypt: false });
    if (!(await builderAddresses()).includes(ip)) return null;
    if (!running.count)
      return { allowed: false, private: false, cache: false, decrypt: false, relay: false };
    return egressPolicy(host, running.hosts, running.trusted, [], [], { decrypt: false });
  }

  return {
    id,
    // Repo images' names, under the operator's registry.
    repository: (name) => `${k.registry}/${name}`,
    build,
    tags,
    remove,
    volumeExists,
    createVolume,
    removeVolume,
    keepsCaches: Boolean(k.cacheStorageClass),
    // What a missing piece costs a run, said in its log (preparation.mjs).
    noCaches: "no KUBERNETES_CACHE_STORAGE_CLASS is set",
    // fsGroup hands a new claim to the sandbox's user (createVolume() checks it): no chown job.
    ownsVolumes: true,
    installAgent,
    egressFor,
  };
}
