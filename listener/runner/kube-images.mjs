// What ../images.mjs asks of the backend, on Kubernetes (the Docker runner's: images.mjs here).
// A cluster's nodes pull from a registry only, so:
//
//   - A repo's image is built by a BuildKit daemon in the namespace (KUBERNETES_BUILDKIT),
//     driven with buildctl (buildkit.mjs), and pushed to the operator's registry
//     (KUBERNETES_REGISTRY), whose API (registry.mjs) says whether a tag is there, lists the
//     tags to prune and deletes them. Its credentials, and the nodes' pull Secret, are one
//     kubernetes.io/dockerconfigjson Secret (KUBERNETES_REGISTRY_SECRET). The daemon goes out
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
import { checked } from "../docker.mjs";
import { egressPolicy, proxyEnv } from "../egress.mjs";
import { buildArgs, buildctl as buildctlCli, withDockerConfig } from "./buildkit.mjs";
import { INSTALL_USER, kubeName, labelValue, quantity } from "./kubernetes.mjs";
import { aliasOf } from "./networks.mjs";
import { authsOf, createRegistry, parseRef } from "./registry.mjs";

const DISCOVERY = "/apis/discovery.k8s.io/v1/namespaces";
const POLL_MS = 2000;
// An install pod that hasn't ended by then (stuck Pending, npm hanging) fails, and goes.
const INSTALL_MS = 15 * 60_000;
// The pull Secret and the BuildKit pods' addresses, read again after this long.
const SECRET_TTL_MS = 60_000;
const BUILDER_TTL_MS = 10_000;

export function createKubernetesImages({
  config,
  api, // kube-api.mjs
  fetch = globalThis.fetch, // the registry's
  buildctl = buildctlCli,
  log = () => {},
  now = Date.now,
  sleep = delay,
}) {
  const k = config.kubernetes;
  const owner = { "deckhand.owner": labelValue(config.prefix) };
  const claimPath = (name) => `persistentvolumeclaims/${kubeName(name)}`;
  let secret = { at: -Infinity, text: null };
  let builder = { at: -Infinity, addresses: [] };
  const registry = createRegistry({
    fetch,
    auths: async () => authsOf(JSON.parse(await pullConfig())),
  });

  // The pull Secret's docker config, as text ("{}" without one).
  async function pullConfig() {
    if (!k.registrySecret) return "{}";
    if (now() - secret.at < SECRET_TTL_MS) return secret.text;
    const found = await api.find(`secrets/${kubeName(k.registrySecret)}`);
    const data = found?.data?.[".dockerconfigjson"];
    if (!data) {
      throw new Error(
        `KUBERNETES_REGISTRY_SECRET: no kubernetes.io/dockerconfigjson Secret ${k.registrySecret} in the namespace ${api.namespace}`,
      );
    }
    secret = { at: now(), text: Buffer.from(data, "base64").toString() };
    return secret.text;
  }

  // The image's digest in its registry, or null when it isn't there. The base image's too:
  // a new one pushed under the same tag gives repo images a new tag (images.mjs imageTag()).
  async function id(ref) {
    return registry.digest(ref);
  }

  // Builds in progress: the hosts each may reach, by what they are (gate()).
  const running = { key: null, count: 0, hosts: [], trusted: [], waiting: [] };

  // Builds of one set of hosts run together; another set waits until they are done: the
  // daemon's address is the same for all of them, and one repo's Dockerfile mustn't reach
  // what another's grant allows.
  async function gate(hosts, trusted) {
    const key = JSON.stringify([[...hosts].sort(), [...trusted].sort()]);
    while (running.count && running.key !== key) {
      await new Promise((resolve) => running.waiting.push(resolve));
    }
    Object.assign(running, { key, hosts, trusted, count: running.count + 1 });
    return () => {
      running.count--;
      if (running.count) return;
      running.key = null;
      for (const wake of running.waiting.splice(0)) wake();
    };
  }

  // `hosts` and `trusted`: what the run may reach (access.mjs). Its RUN steps go through the
  // egress proxy; the daemon's own pulls and pushes do as its Deployment's environment says
  // (docs/setup.md, Kubernetes runner).
  async function build({ dir, dockerfile, tag, labels = {}, output, hosts = [], trusted = [] }) {
    const registryHosts = [parseRef(tag).host, parseRef(config.image).host];
    const done = await gate([...hosts, ...registryHosts], [...trusted, ...registryHosts]);
    try {
      const args = buildArgs({
        addr: k.buildkit,
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
      return await withDockerConfig(await pullConfig(), (env) =>
        buildctl(args, { env, onData: output }),
      );
    } finally {
      done();
    }
  }

  // The egress proxy, for the build's RUN steps: Docker's predefined proxy build args.
  function proxyArgs() {
    const { HTTP_PROXY, HTTPS_PROXY, http_proxy, https_proxy } = proxyEnv(config);
    return { HTTP_PROXY, HTTPS_PROXY, http_proxy, https_proxy };
  }

  // Newest first, by when each was built, as `docker image ls` gives them.
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
      const at = await registry.created(`${name}:${tag}`).catch(() => 0);
      dated.push({ tag, at });
    }
    return dated.sort((a, b) => b.at - a.at).map((d) => d.tag);
  }

  // A tag a pod runs stays, as Docker keeps an image a container uses. Deleting a manifest
  // deletes every tag that points at it: when one that stays (`kept`, images.mjs prune()'s, or
  // a pod's) shares it (an identical build, which BuildKit's cache makes often), only the tag
  // goes, where the registry can delete a tag alone (OCI distribution 1.1), else it stays.
  async function remove(ref, kept = []) {
    const { items = [] } = await api.get("pods", {
      labelSelector: `deckhand.owner=${owner["deckhand.owner"]}`,
    });
    const used = items.flatMap((p) => (p.spec?.containers ?? []).map((c) => c.image));
    if (used.includes(ref)) return;
    const name = ref.slice(0, ref.lastIndexOf(":"));
    try {
      const digest = await registry.digest(ref);
      if (!digest) return;
      for (const other of new Set([...kept, ...used.filter((i) => i.startsWith(`${name}:`))])) {
        if (other === ref || (await registry.digest(other)) !== digest) continue;
        await registry.remove(name, ref.slice(name.length + 1)).catch(() => {});
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

  // A cache's claim. No chown: the sandbox pod's fsGroup makes it the sandbox user's.
  async function createVolume(name, labels = {}) {
    if (!k.cacheStorageClass) {
      return { code: 1, out: "", err: "no KUBERNETES_CACHE_STORAGE_CLASS" };
    }
    try {
      await api.create(
        "persistentvolumeclaims",
        claim(name, labels, k.cacheStorageClass, k.cacheSize, "cache"),
      );
      return { code: 0, out: "", err: "" };
    } catch (error) {
      if (error.status === 409) return { code: 0, out: "", err: "" };
      return { code: 1, out: "", err: error.message };
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

  // Installs pods by IP while they run, for egressFor().
  const installs = new Map(); // pod name → hosts

  // `spec`: agents' install() and the agent's name. The installer is idempotent (one folder
  // per version, nothing done when it is there): it runs at the first run of each version
  // after the listener starts, and goes at once when the version is in the claim.
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
    if (!(await agentClaim(volume))) return;
    const pod = kubeName(`${config.prefix}-install-${name}-${version}`);
    await api.remove(`pods/${pod}`, { gracePeriodSeconds: 0 }).catch(() => {});
    await waitGone(pod);
    const limits = { cpu: String(config.limits.cpus), memory: quantity(config.limits.memory) };
    await api.create("pods", {
      apiVersion: "v1",
      kind: "Pod",
      metadata: { name: pod, labels: { ...owner, "deckhand.role": "install" } },
      spec: {
        restartPolicy: "Never",
        automountServiceAccountToken: false,
        enableServiceLinks: false,
        ...pullSecrets(),
        securityContext: {
          runAsNonRoot: true,
          runAsUser: INSTALL_USER.uid,
          runAsGroup: INSTALL_USER.gid,
          // The claim becomes the installer's group's to write.
          fsGroup: INSTALL_USER.gid,
          fsGroupChangePolicy: "OnRootMismatch",
          seccompProfile: { type: "RuntimeDefault" },
        },
        containers: [
          {
            name: "install",
            image: config.image,
            command: [command],
            env: Object.entries({ [versionVar]: version, ...env, ...proxyEnv(config) }).map(
              ([key, value]) => ({ name: key, value: String(value) }),
            ),
            resources: { limits, requests: limits },
            securityContext: {
              allowPrivilegeEscalation: false,
              capabilities: { drop: ["ALL"] },
              runAsNonRoot: true,
              seccompProfile: { type: "RuntimeDefault" },
            },
            volumeMounts: [{ name: "agent", mountPath: mount }],
          },
        ],
        volumes: [{ name: "agent", persistentVolumeClaim: { claimName: kubeName(volume) } }],
      },
    });
    installs.set(pod, hosts);
    try {
      const ended = await ending(pod);
      await readLog(pod, output);
      const code = ended?.status?.containerStatuses?.[0]?.state?.terminated?.exitCode;
      if (ended?.status?.phase !== "Succeeded") {
        const why = ended
          ? `exit ${code ?? ended.status?.phase}`
          : `no end in ${INSTALL_MS / 60000} min`;
        throw new Error(`installing ${displayName} ${version} failed: ${why}`);
      }
    } finally {
      installs.delete(pod);
      await api
        .remove(`pods/${pod}`, { gracePeriodSeconds: 0 })
        .catch((e) => log(`Removing ${pod}: ${e.message}`));
    }
  }

  function pullSecrets() {
    return k.registrySecret ? { imagePullSecrets: [{ name: kubeName(k.registrySecret) }] } : {};
  }

  // The pod once it has ended, or null when it doesn't within INSTALL_MS.
  async function ending(pod) {
    const since = now();
    while (now() - since < INSTALL_MS) {
      const found = await api.find(`pods/${pod}`);
      if (!found) throw new Error(`the install pod ${pod} is gone`);
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

  // The BuildKit daemon's pod IPs: the endpoints of KUBERNETES_BUILDKIT's Service.
  async function builderAddresses() {
    if (now() - builder.at < BUILDER_TTL_MS) return builder.addresses;
    let addresses = [];
    try {
      const service = aliasOf(k.buildkit);
      const { items = [] } = await api.get(`${DISCOVERY}/${api.namespace}/endpointslices`, {
        labelSelector: `kubernetes.io/service-name=${service}`,
      });
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

  // The egress proxy's answer for a caller that isn't a sandbox (broker-http.mjs), or null:
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
    // fsGroup hands a new claim to the sandbox's user: no chown job.
    ownsVolumes: true,
    installAgent,
    egressFor,
  };
}
