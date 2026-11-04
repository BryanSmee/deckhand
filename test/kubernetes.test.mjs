// The Kubernetes runner, against a fake of the API that keeps what it is sent: the Pod, Secret
// and claims a run gets (and loses when its start fails), the NetworkPolicy check, the
// Pending timeout, its log followed with `skip`, and what the listener asks of it otherwise.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { RunError, runnerRefusal } from "../listener/access.mjs";
import { claude } from "../listener/agents/claude.mjs";
import { parseRepoConfig } from "../listener/repo-config.mjs";
import { apiBase, createKubeApi, KubeError } from "../listener/runner/kube-api.mjs";
import { createPullSecret } from "../listener/runner/kube-pull.mjs";
import {
  createKubernetesRunner,
  INSTALL_USER,
  INSTALLING,
  isolationProblem,
  kubeName,
  labelValue,
  latestWarning,
  pendingFailure,
  pendingReason,
  podSpec,
  quantity,
  selects,
} from "../listener/runner/kubernetes.mjs";
import { LINE_CUT, MAX_LINE } from "../listener/runner/lines.mjs";
import { SANDBOX_USER } from "../listener/sandbox-spec.mjs";
import { tempDir } from "./helpers.mjs";

const NS = "runs";
const config = {
  prefix: "dh",
  image: "dh-sandbox",
  runner: "kubernetes",
  egressProxy: "http://egress:3128",
  kubernetes: { pendingMs: 600000, storageClass: "fast", sessionSize: "10Gi" },
  // An engine only with KUBERNETES_ENGINE_RUNTIME_CLASS too (ENGINE below).
  engine: "sysbox",
  engineImage: "dh-engine",
};

// The settings that give runs a container engine (#573).
const ENGINE = { engineRuntimeClass: "sysbox-runc", engineSize: "20Gi" };

// Pod Security `restricted` as Kubernetes 1.35 checks it (its pod-security-admission's policy/
// checks, enforce-version latest), for the fields Deckhand's pods set: why `pod` fails it, or
// [] when it passes. A pod in its own user namespace (hostUsers: false) may run as root.
function restrictedProblems(pod) {
  const s = pod.spec;
  const problems = [];
  if (s.hostNetwork || s.hostPID || s.hostIPC) problems.push("host namespaces");
  const userns = s.hostUsers === false;
  const allowedVolumes = [
    "configMap",
    "csi",
    "downwardAPI",
    "emptyDir",
    "ephemeral",
    "persistentVolumeClaim",
    "projected",
    "secret",
  ];
  for (const v of s.volumes ?? []) {
    const kind = Object.keys(v).find((k) => k !== "name");
    if (!allowedVolumes.includes(kind)) problems.push(`volume ${v.name}: ${kind}`);
  }
  const containers = [...(s.initContainers ?? []), ...s.containers];
  const podSc = s.securityContext ?? {};
  for (const c of containers) {
    const sc = c.securityContext ?? {};
    if (sc.privileged) problems.push(`${c.name}: privileged`);
    if (sc.allowPrivilegeEscalation !== false) problems.push(`${c.name}: privilege escalation`);
    if (!sc.capabilities?.drop?.includes("ALL")) problems.push(`${c.name}: capabilities kept`);
    if ((sc.capabilities?.add ?? []).some((cap) => cap !== "NET_BIND_SERVICE")) {
      problems.push(`${c.name}: capabilities added`);
    }
    const seccomp = sc.seccompProfile?.type ?? podSc.seccompProfile?.type;
    if (!["RuntimeDefault", "Localhost"].includes(seccomp)) problems.push(`${c.name}: seccomp`);
    if (sc.procMount && sc.procMount !== "Default") problems.push(`${c.name}: procMount`);
    if ((c.ports ?? []).some((p) => p.hostPort)) problems.push(`${c.name}: hostPort`);
    if (userns) continue;
    if ((sc.runAsNonRoot ?? podSc.runAsNonRoot) !== true) problems.push(`${c.name}: may be root`);
    if ((sc.runAsUser ?? podSc.runAsUser) === 0) problems.push(`${c.name}: runs as root`);
  }
  if (!userns && podSc.runAsUser === 0) problems.push("the pod runs as root");
  return problems;
}

// Deckhand's policy, as docs/kubernetes.md shows it.
const POLICY = {
  metadata: { name: "deckhand-sandboxes" },
  spec: {
    podSelector: { matchLabels: { "deckhand.role": "sandbox" } },
    policyTypes: ["Ingress", "Egress"],
    egress: [
      { to: [{ podSelector: { matchLabels: { app: "egress" } } }], ports: [{ port: 3128 }] },
    ],
  },
};

const SERVICES = {
  egress: {
    metadata: { name: "egress" },
    spec: {
      clusterIP: "10.96.0.11",
      selector: { app: "deckhand-egress" },
      ports: [{ port: 3128 }, { port: 3129 }],
    },
  },
};

// The services' namespace, when the sandboxes have one of their own.
const SVC = "deckhand";

// Deckhand's policy with the sandboxes apart, as docs/kubernetes.md shows it: the proxy's pods in
// the services' namespace alone.
const APART_POLICY = {
  metadata: { name: "deckhand-sandboxes" },
  spec: {
    podSelector: { matchLabels: { "deckhand.role": "sandbox" } },
    policyTypes: ["Ingress", "Egress"],
    egress: [
      {
        to: [
          {
            namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": SVC } },
            podSelector: { matchLabels: { app: "deckhand-egress" } },
          },
        ],
        ports: [{ port: 3128 }],
      },
    ],
  },
};

// A namespace's API: `objects` by resource then name; `logs` a pod's log, chunks of text;
// `fail(call)` answers a call instead (a Response), when it does. Every call is in `calls`
// as "METHOD path?query", the bodies sent in `bodies`.
// `fail` gets the request's `signal`, and may answer a promise that only it ends (an API that
// never answers); a pod's log may be a function of { follow, signal, container } giving a
// Response.
// `timeoutMs`: createKubeApi()'s.
// `apart`: the services in a namespace of their own (SVC), with the proxy's Service, its
// EndpointSlices (`slices`) and `servicePolicies`; `servicesApi` and `servicesObjects` are
// theirs.
function fakeApi({
  policies = [POLICY],
  logs = {},
  slices = [],
  fail = () => null,
  timeoutMs,
  apart = false,
  servicePolicies = [],
} = {}) {
  const store = (services = {}) => ({
    pods: new Map(),
    secrets: new Map(),
    persistentvolumeclaims: new Map(),
    services: new Map(Object.entries(services)),
    events: new Map(),
  });
  const objects = store(apart ? {} : SERVICES);
  const servicesObjects = apart ? store(SERVICES) : objects;
  const namespaces = { [NS]: objects, ...(apart ? { [SVC]: servicesObjects } : {}) };
  const servicesNs = apart ? SVC : NS;
  const calls = [];
  const bodies = [];
  let uids = 0;
  const matches = (obj, selector) =>
    !selector ||
    selector.split(",").every((term) => {
      const [k, v] = term.split("=");
      return obj.metadata.labels?.[k] === v;
    });
  const fetch = async (url, init = {}) => {
    const { pathname, search, searchParams } = new URL(url);
    const method = init.method ?? "GET";
    calls.push(`${method} ${pathname}${search}`);
    assert.equal(init.headers.authorization, "Bearer token-1");
    const body = init.body && JSON.parse(init.body);
    if (body) bodies.push(body);
    const failed = await fail({ method, path: pathname, body, signal: init.signal });
    if (failed) return failed;
    if (pathname === `/apis/networking.k8s.io/v1/namespaces/${NS}/networkpolicies`) {
      return Response.json({ items: policies });
    }
    if (apart && pathname === `/apis/networking.k8s.io/v1/namespaces/${SVC}/networkpolicies`) {
      return Response.json({ items: servicePolicies });
    }
    if (pathname === `/apis/discovery.k8s.io/v1/namespaces/${servicesNs}/endpointslices`) {
      return Response.json({ items: slices });
    }
    const [, ns, kind, name, sub] =
      pathname.match(/^\/api\/v1\/namespaces\/([^/]+)\/(\w+)(?:\/([^/]+))?(?:\/(\w+))?$/) ?? [];
    const store = namespaces[ns]?.[kind];
    if (!store) return new Response("no such route", { status: 404 });
    const missing = () =>
      Response.json({ message: `${kind} "${name}" not found` }, { status: 404 });
    if (sub === "log") {
      if (!store.has(name)) return missing();
      if (typeof logs[name] === "function") {
        return logs[name]({
          follow: searchParams.get("follow") === "true",
          signal: init.signal,
          container: searchParams.get("container"),
        });
      }
      const chunks = logs[name] ?? [];
      return new Response(
        new ReadableStream({
          start(c) {
            for (const chunk of chunks) c.enqueue(new TextEncoder().encode(chunk));
            c.close();
          },
        }),
      );
    }
    if (method === "POST") {
      if (store.has(body.metadata.name)) {
        return Response.json({ message: "already exists" }, { status: 409 });
      }
      const made = {
        ...body,
        metadata: {
          creationTimestamp: new Date(0).toISOString(),
          uid: `uid-${++uids}`,
          resourceVersion: "1",
          ...body.metadata,
        },
        status: kind === "pods" ? { phase: "Running", podIPs: [{ ip: "10.244.1.7" }] } : {},
      };
      store.set(body.metadata.name, made);
      return Response.json(made, { status: 201 });
    }
    if (method === "PUT") {
      if (!store.has(name)) return missing();
      const version = store.get(name).metadata.resourceVersion;
      if (body.metadata.resourceVersion !== version) {
        return Response.json({ message: "conflict" }, { status: 409 });
      }
      // Each change a new version, as the API gives it.
      const changed = {
        ...body,
        metadata: { ...body.metadata, resourceVersion: String(Number(version ?? 0) + 1) },
      };
      store.set(name, changed);
      return Response.json(changed);
    }
    if (method === "DELETE") {
      if (!store.delete(name)) return missing();
      return Response.json({ kind: "Status" });
    }
    if (name) return store.has(name) ? Response.json(store.get(name)) : missing();
    const selector = searchParams.get("labelSelector");
    return Response.json({ items: [...store.values()].filter((o) => matches(o, selector)) });
  };
  const kubeApi = (namespace) =>
    createKubeApi({ fetch, base: "https://kube", token: () => "token-1", namespace, timeoutMs });
  const api = kubeApi(NS);
  const servicesApi = apart ? kubeApi(SVC) : api;
  return { api, servicesApi, calls, bodies, objects, servicesObjects };
}

// A network probe that finds the cluster enforces the policies (kube-probe.mjs).
const ENFORCED = { check: async () => null, reset() {} };

// The addresses every pod's network gate waits on (kube-gate.mjs), as a runner in the cluster
// has them: the API server's Service and the cluster's DNS.
const GATE_OPTIONS = {
  env: { KUBERNETES_SERVICE_HOST: "10.96.0.1", KUBERNETES_SERVICE_PORT: "443" },
  resolvConf: () => "search svc.cluster.local\nnameserver 10.96.0.10\n",
};

// `now`: a clock of the test's own, else one that the runner's sleep() moves forward (its
// retries and polls take time); `sleep(ms)` is called too.
// `kubernetes`: more of config.kubernetes. `probeOptions`: the network probe's (kube-probe.mjs),
// which runs only when given: the cluster enforces the policies otherwise.
function setup(
  t,
  options = {},
  {
    now,
    sleep = async () => {},
    kubernetes = {},
    engine,
    probeOptions = null,
    metrics = null,
  } = {},
) {
  const fake = fakeApi(options);
  const logged = [];
  const inboxDir = tempDir(t);
  const clock = { at: Date.parse("2026-10-30T10:00:00Z") };
  const cfg = {
    ...config,
    ...(engine ? { engine } : {}),
    kubernetes: { ...config.kubernetes, ...kubernetes },
  };
  const clockNow = now ?? (() => clock.at);
  const runner = createKubernetesRunner({
    config: cfg,
    api: fake.api,
    services: fake.servicesApi,
    pullSecret: createPullSecret({
      config: cfg,
      api: fake.api,
      services: fake.servicesApi,
      now: clockNow,
    }),
    inboxDir,
    log: (line) => logged.push(line),
    now: clockNow,
    sleep: async (ms) => {
      clock.at += ms;
      await sleep(ms);
    },
    probe: probeOptions ? null : ENFORCED,
    // The gate's addresses too.
    probeOptions: probeOptions ?? GATE_OPTIONS,
    metrics,
  });
  return { ...fake, runner, logged, inboxDir, clock };
}

// What sandboxSpec() gives a work run (sandbox-spec.mjs).
const spec = (over = {}) => ({
  run: "dh-org-repo-12-abc-1730000000",
  name: "dh-org-repo-12-abc",
  image: "dh-sandbox",
  labels: { "deckhand.task": "org/repo#12" },
  env: { DECKHAND_RUN_TOKEN: "s3cret", TASK_PROMPT: "do it", SANDBOX_MODEL: undefined },
  user: SANDBOX_USER,
  limits: { cpus: "2", memory: "4g", pids: 2048 },
  caps: [],
  volumes: [
    { kind: "agent", name: "dh-claude-code", path: "/opt/claude-code", readOnly: true },
    { kind: "session", name: "dh-org-repo-12-abc-workspace", path: "/workspace" },
    { kind: "session", name: "dh-org-repo-12-abc-claude", path: "/home/node/.claude" },
  ],
  ca: "PEM",
  ...over,
});

test("start: a claim per session volume, the Pod, then a Secret with the run's env and tokens", async (t) => {
  const { runner, calls, objects } = setup(t);
  const bound = [];
  const tokens = (uid) => (bound.push(uid), { DECKHAND_RUN_TOKEN: `token-for-${uid}` });
  assert.deepEqual(await runner.start(spec({ tokens })), { engine: null });
  const secret = objects.secrets.get("dh-org-repo-12-abc-1730000000-env");
  // Unset values stay unset; the secrets are in the Secret, never in the Pod. The run's tokens
  // are bound to the pod's UID, known once it is made.
  const uid = objects.pods.get("dh-org-repo-12-abc").metadata.uid;
  assert.deepEqual(bound, [uid]);
  assert.deepEqual(secret.stringData, {
    DECKHAND_RUN_TOKEN: `token-for-${uid}`,
    DECKHAND_RUN_TOKEN: "s3cret",
    TASK_PROMPT: "do it",
  });
  assert.equal(secret.metadata.annotations["deckhand.run"], "dh-org-repo-12-abc-1730000000");
  const pod = objects.pods.get("dh-org-repo-12-abc");
  assert.ok(!JSON.stringify(pod).includes("s3cret"));
  const [c] = pod.spec.containers;
  assert.deepEqual(c.envFrom, [{ secretRef: { name: "dh-org-repo-12-abc-1730000000-env" } }]);
  // Where the run's files are: values, from the broker.
  assert.deepEqual(c.env, [
    { name: "TASK_INBOX", value: "http://broker:8081/run/inbox" },
    { name: "DECKHAND_CA", value: "http://broker:8081/run/ca" },
    // Its stderr lines tagged: the pod log has both streams in one.
    { name: "SANDBOX_TAG_STDERR", value: "1" },
  ]);
  // The proxy's name alone: the services' names sandboxes call are the proxy's to read.
  assert.deepEqual(pod.spec.hostAliases, [{ ip: "10.96.0.11", hostnames: ["egress"] }]);
  assert.deepEqual(pod.metadata.labels, {
    "deckhand.owner": "dh",
    "deckhand.run": "dh-org-repo-12-abc-1730000000",
    "deckhand.role": "sandbox",
  });
  assert.equal(pod.metadata.annotations["deckhand.task"], "org/repo#12");
  assert.equal(pod.metadata.annotations["deckhand.name"], "dh-org-repo-12-abc");
  assert.deepEqual(
    pod.spec.volumes.map((v) => v.persistentVolumeClaim),
    [
      { claimName: "dh-claude-code", readOnly: true },
      { claimName: "dh-org-repo-12-abc-workspace" },
      { claimName: "dh-org-repo-12-abc-claude" },
    ],
  );
  assert.deepEqual(c.volumeMounts, [
    { name: "v0", mountPath: "/opt/claude-code", readOnly: true },
    // A folder of each session claim, not its root, which may hold lost+found (#643).
    { name: "v1", mountPath: "/workspace", subPath: ".deckhand-session" },
    { name: "v2", mountPath: "/home/node/.claude", subPath: ".deckhand-session" },
  ]);
  // The session claims, of the operator's class and size; the agent's is not the runner's.
  const claim = objects.persistentvolumeclaims.get("dh-org-repo-12-abc-workspace");
  assert.deepEqual(claim.spec, {
    accessModes: ["ReadWriteOnce"],
    resources: { requests: { storage: "10Gi" } },
    storageClassName: "fast",
  });
  // Their session in their folder (SESSION_FOLDER), from the start.
  assert.equal(claim.metadata.annotations["deckhand.layout"], "folder");
  assert.ok(!objects.persistentvolumeclaims.has("dh-claude-code"));
  // The policy checked first, the Pod, then its Secret, last.
  assert.match(calls[0], /networkpolicies$/);
  assert.match(calls.at(-2), /^POST \/api\/v1\/namespaces\/runs\/pods$/);
  assert.match(calls.at(-1), /^POST \/api\/v1\/namespaces\/runs\/secrets$/);
  // The inbox is the runner's: the next run's claims are already there.
  runner.send("dh-org-repo-12-abc-1730000000", "more", claude);
  assert.equal(runner.closed("dh-org-repo-12-abc-1730000000"), false);
  objects.pods.clear();
  calls.length = 0;
  await runner.start(spec({ run: "dh-org-repo-12-abc-1730000999" }));
  assert.equal(calls.filter((c) => c.startsWith("POST")).length, 2); // Pod, Secret
  // Claims of the folder's layout: their folder again, where the last run left its session.
  const next = objects.pods.get("dh-org-repo-12-abc").spec.containers[0].volumeMounts;
  assert.deepEqual(
    next.map((m) => m.subPath),
    [undefined, ".deckhand-session", ".deckhand-session"],
  );
});

// A session claim's folder, not its root (#643), unless it is from before (`rooted`); what
// isn't a session (the agent, a cache) keeps its root, or the subpath its spec names.
test("podSpec: session volumes mount their folder, rooted ones and the others their root", () => {
  const cache = { kind: "cache", name: "dh-cache-org-repo-npm", path: "/home/node/.npm" };
  const named = { kind: "cache", name: "dh-cache-org-repo-x", path: "/x", subpath: "x" };
  const volumes = [...spec().volumes, cache, named];
  const options = { pod: "p", labels: {}, annotations: {}, secret: "s" };
  const mounts = (pod) =>
    pod.spec.containers[0].volumeMounts.map((m) => `${m.mountPath}:${m.subPath ?? ""}`);
  assert.deepEqual(mounts(podSpec(spec({ volumes }), options)), [
    "/opt/claude-code:",
    "/workspace:.deckhand-session",
    "/home/node/.claude:.deckhand-session",
    "/home/node/.npm:",
    "/x:x",
  ]);
  const rooted = podSpec(spec({ volumes }), {
    ...options,
    // Only a session volume's name counts: the agent's has no folder to leave.
    rooted: ["dh-org-repo-12-abc-workspace", "dh-claude-code"],
  });
  assert.deepEqual(mounts(rooted), [
    "/opt/claude-code:",
    "/workspace:",
    "/home/node/.claude:.deckhand-session",
    "/home/node/.npm:",
    "/x:x",
  ]);
});

test("podSpec: Pod Security restricted, no token, no restart, the grant's limits", () => {
  const pod = podSpec(spec(), {
    pod: "p",
    labels: {},
    annotations: {},
    secret: "s",
  });
  const { spec: s } = pod;
  assert.equal(s.restartPolicy, "Never");
  assert.equal(s.automountServiceAccountToken, false);
  assert.equal(s.enableServiceLinks, false);
  // No cluster DNS: a lookup fails at once rather than timing out behind the NetworkPolicy.
  assert.equal(s.dnsPolicy, "None");
  assert.deepEqual(s.dnsConfig, { nameservers: ["127.0.0.1"] });
  assert.equal(s.terminationGracePeriodSeconds, 10);
  assert.equal(s.hostNetwork ?? false, false);
  assert.equal(s.hostPID ?? false, false);
  assert.equal(s.hostIPC ?? false, false);
  assert.deepEqual(s.securityContext, {
    runAsNonRoot: true,
    runAsUser: 1000,
    runAsGroup: 1000,
    fsGroup: 1000,
    // Not a walk through the whole workspace at every mount, while the pod is Pending.
    fsGroupChangePolicy: "OnRootMismatch",
    seccompProfile: { type: "RuntimeDefault" },
  });
  // restricted: no hostPath (volumes are claims only), every container hardened.
  assert.ok(s.volumes.every((v) => Object.keys(v).sort().join() === "name,persistentVolumeClaim"));
  for (const c of [...s.containers, ...(s.initContainers ?? [])]) {
    assert.deepEqual(c.securityContext, {
      allowPrivilegeEscalation: false,
      capabilities: { drop: ["ALL"] },
      runAsNonRoot: true,
      seccompProfile: { type: "RuntimeDefault" },
    });
    assert.equal(c.ports, undefined);
    // Kubernetes' default: a :latest image is pulled again, a pinned one kept.
    assert.equal(c.imagePullPolicy, undefined);
    assert.deepEqual(c.resources, {
      limits: { cpu: "2", memory: "4Gi" },
      requests: { cpu: "2", memory: "4Gi" },
    });
  }
  assert.deepEqual(restrictedProblems(pod), []);
  // Fail closed, as sandboxArgs(): no user or limits, no sandbox; nor capabilities.
  assert.throws(() => podSpec(spec({ user: undefined }), {}), /no user/);
  assert.throws(() => podSpec(spec({ limits: undefined }), {}), /no limits/);
  assert.throws(() => podSpec(spec({ caps: ["CHOWN"] }), {}), /no capabilities/);
});

test("start: a failure removes the Pod, Secret and claims it made, keeps the older ones", async (t) => {
  const { runner, objects } = setup(t, {
    fail: ({ method, path }) =>
      method === "POST" && path.endsWith("/pods")
        ? Response.json({ message: "pods is forbidden" }, { status: 403 })
        : null,
  });
  objects.persistentvolumeclaims.set("dh-org-repo-12-abc-claude", {
    metadata: { name: "dh-org-repo-12-abc-claude" },
  });
  await assert.rejects(runner.start(spec()), /POST pods: pods is forbidden/);
  assert.equal(objects.secrets.size, 0);
  assert.deepEqual([...objects.persistentvolumeclaims.keys()], ["dh-org-repo-12-abc-claude"]);
});

// A claim from before #643 (no `deckhand.layout`) has its clone and session at its root: still
// mounted there, untouched, so that its issue goes on where it was (a session to continue,
// task-modes.mjs's replies without a trigger line), beside a claim of the new layout.
test("start: a claim from before its folder is mounted at its root, its session kept", async (t) => {
  const { runner, objects, calls } = setup(t);
  objects.persistentvolumeclaims.set("dh-org-repo-12-abc-workspace", {
    metadata: { name: "dh-org-repo-12-abc-workspace" },
  });
  assert.equal(await runner.hasSession("dh-org-repo-12-abc", claude), false);
  await runner.start(spec());
  const [, workspace, home] =
    objects.pods.get("dh-org-repo-12-abc").spec.containers[0].volumeMounts;
  assert.deepEqual(workspace, { name: "v1", mountPath: "/workspace" });
  assert.deepEqual(home, {
    name: "v2",
    mountPath: "/home/node/.claude",
    subPath: ".deckhand-session",
  });
  assert.deepEqual(objects.persistentvolumeclaims.get("dh-org-repo-12-abc-workspace"), {
    metadata: { name: "dh-org-repo-12-abc-workspace" },
  });
  assert.ok(!calls.some((c) => /^(PUT|PATCH|DELETE) .*persistentvolumeclaims/.test(c)));
  assert.equal(await runner.hasSession("dh-org-repo-12-abc", claude), true);
});

// An issue at work before the update: both its claims from before, its session there already
// (runs.mjs continues it, task-modes.mjs takes its replies), both at their root, none made.
test("start: an issue whose claims are both from before goes on at their root", async (t) => {
  const { runner, objects, calls } = setup(t);
  for (const name of ["dh-org-repo-12-abc-workspace", "dh-org-repo-12-abc-claude"]) {
    objects.persistentvolumeclaims.set(name, {
      metadata: { name, annotations: { "deckhand.volume": name } },
    });
  }
  assert.equal(await runner.hasSession("dh-org-repo-12-abc", claude), true);
  await runner.start(spec());
  const mounts = objects.pods.get("dh-org-repo-12-abc").spec.containers[0].volumeMounts;
  assert.deepEqual(mounts.slice(1), [
    { name: "v1", mountPath: "/workspace" },
    { name: "v2", mountPath: "/home/node/.claude" },
  ]);
  assert.ok(!calls.some((c) => /persistentvolumeclaims$/.test(c) && c.startsWith("POST")));
  for (const claim of objects.persistentvolumeclaims.values()) {
    assert.equal(claim.metadata.annotations["deckhand.layout"], undefined);
  }
});

test("start: a Secret refused removes the Pod made before it", async (t) => {
  const { runner, objects } = setup(t, {
    fail: ({ method, path }) =>
      method === "POST" && path.endsWith("/secrets")
        ? Response.json({ message: "secrets is forbidden" }, { status: 403 })
        : null,
  });
  await assert.rejects(runner.start(spec()), /POST secrets: secrets is forbidden/);
  assert.equal(objects.pods.size, 0);
});

test("locate: the UID of the running sandbox pod at an address, else null", async (t) => {
  let time = 0;
  let failing = false;
  let failed = 0;
  const { runner, objects, calls } = setup(
    t,
    {
      fail: ({ method, path }) =>
        failing && method === "GET" && path.endsWith("/pods")
          ? (failed++, Response.json({ message: "etcd leader changed" }, { status: 500 }))
          : null,
    },
    { now: () => time },
  );
  await runner.start(spec());
  const uid = objects.pods.get("dh-org-repo-12-abc").metadata.uid;
  assert.deepEqual(await runner.locate("10.244.1.7"), { sandbox: uid, name: null });
  assert.equal(await runner.locate("10.244.9.9"), null);
  // The connections that ask at once about an address share one lookup.
  const lists = () => calls.filter((c) => c.startsWith("GET") && c.includes("podIP")).length;
  time += 60_000;
  const before = lists();
  const found = await Promise.all([1, 2, 3].map(() => runner.locate("10.244.8.8")));
  assert.deepEqual(found, [null, null, null]);
  assert.equal(lists(), before + 1);
  // An API error keeps what was known, even right after another sandbox started: one failed
  // call refuses no sandbox. Nor is it asked again for every connection meanwhile.
  time += 60_000;
  assert.deepEqual(await runner.locate("10.244.1.7"), { sandbox: uid, name: null });
  time += 2_000;
  failing = true;
  await runner.start(spec({ name: "dh-org-repo-13-abc", run: "dh-org-repo-13-abc-1730000000" }));
  assert.deepEqual(await runner.locate("10.244.1.7"), { sandbox: uid, name: null });
  assert.equal(failed, 1);
  for (let i = 0; i < 5; i++) {
    time += 10;
    assert.deepEqual(await runner.locate("10.244.1.7"), { sandbox: uid, name: null });
    assert.equal(await runner.locate("10.244.5.5"), null);
  }
  assert.equal(failed, 2);
  // Known means answered within 10 s: past that, an outage fails closed (the pod may be gone
  // without remove(), its address another's).
  time += 10_000;
  assert.equal(await runner.locate("10.244.1.7"), null);
  failing = false;
  objects.pods.delete("dh-org-repo-13-abc");
  // Gone with its pod: an address never names a pod that was removed.
  await runner.remove("dh-org-repo-12-abc", "dh-org-repo-12-abc-1730000000");
  assert.equal(await runner.locate("10.244.1.7"), null);
});

test("start: without the namespace's NetworkPolicy, no run, and the reply says why", async (t) => {
  const { runner, objects } = setup(t, { policies: [] });
  await assert.rejects(
    runner.start(spec()),
    /the namespace runs doesn't isolate its sandboxes: no NetworkPolicy picks the sandbox pods for both Ingress and Egress.*docs\/kubernetes\.md/,
  );
  assert.equal(objects.pods.size + objects.secrets.size + objects.persistentvolumeclaims.size, 0);
  // Its Services missing: no way to the broker or the proxy.
  const other = setup(t);
  other.objects.services.delete("egress");
  await assert.rejects(other.runner.start(spec()), /no Service egress with a cluster IP/);
});

test("isolationProblem: any policy that widens what a sandbox may reach or what reaches it", () => {
  const labels = { "deckhand.owner": "dh", "deckhand.role": "sandbox", "deckhand.run": "r" };
  assert.equal(isolationProblem([POLICY], labels), null);
  const add = (spec) => [POLICY, { metadata: { name: "extra" }, spec }];
  const all = { podSelector: {} };
  assert.match(isolationProblem(add({ ...all, ingress: [{}] }), labels), /extra lets traffic in/);
  assert.match(
    isolationProblem(add({ ...all, policyTypes: ["Egress"], egress: [{}] }), labels),
    /extra lets sandbox pods reach anything/,
  );
  for (const peer of [
    { ipBlock: { cidr: "0.0.0.0/0" } },
    { namespaceSelector: {} },
    { namespaceSelector: {}, podSelector: { matchLabels: { app: "egress" } } },
  ]) {
    assert.match(
      isolationProblem(add({ ...all, policyTypes: ["Egress"], egress: [{ to: [peer] }] }), labels),
      /beyond the namespace's pods/,
    );
  }
  assert.match(
    isolationProblem(
      add({ ...all, policyTypes: ["Egress"], egress: [{ to: [{ podSelector: {} }] }] }),
      labels,
    ),
    /reach each other/,
  );
  // No sandbox at all, not just this one: another deployment's, another run's.
  for (const matchLabels of [
    { "deckhand.role": "sandbox", "deckhand.owner": "other" },
    { "deckhand.run": "another-run" },
  ]) {
    assert.match(
      isolationProblem(
        add({
          ...all,
          policyTypes: ["Egress"],
          egress: [{ to: [{ podSelector: { matchLabels } }] }],
        }),
        labels,
      ),
      /reach each other/,
    );
  }
  // A label sandbox pods never carry, or another role: never a sandbox.
  for (const podSelector of [
    { matchLabels: { "deckhand.role": "egress" } },
    { matchLabels: { "deckhand.owner": "dh", app: "listener" } },
    { matchExpressions: [{ key: "deckhand.role", operator: "NotIn", values: ["sandbox"] }] },
    { matchExpressions: [{ key: "deckhand.role", operator: "In", values: ["egress"] }] },
    { matchExpressions: [{ key: "app", operator: "Exists" }] },
  ]) {
    const spec = {
      ...all,
      policyTypes: ["Egress"],
      egress: [{ to: [{ podSelector }], ports: [{ port: 3128 }] }],
    };
    assert.equal(isolationProblem(add(spec), labels), null, JSON.stringify(podSelector));
  }
  // Their other ports (the orchestrator's services port gives the runner's tokens; the broker's
  // port, which sandboxes once reached directly, #567): each rule names its ports, the proxy's
  // only.
  const orchestrator = { podSelector: { matchLabels: { app: "orchestrator" } } };
  for (const [ports, open] of [
    [undefined, "every port"],
    [[{ port: 8083 }], "port 8083"],
    [[{ port: 8081 }], "port 8081"],
    [[{ port: 3128, endPort: 3140 }], "port 3128"],
    [[{ port: "http" }], "port http"],
    [[{ protocol: "TCP" }], "every port"],
    [[{ port: 3128 }, { protocol: "TCP" }], "every port"],
  ]) {
    const spec = { ...all, policyTypes: ["Egress"], egress: [{ to: [orchestrator], ports }] };
    assert.match(
      isolationProblem(add(spec), labels),
      new RegExp(`extra lets sandbox pods reach ${open} `),
    );
  }
  const notApp = { matchExpressions: [{ key: "app", operator: "DoesNotExist" }] };
  assert.match(
    isolationProblem(
      add({ ...all, policyTypes: ["Egress"], egress: [{ to: [{ podSelector: notApp }] }] }),
      labels,
    ),
    /reach each other/,
  );
  // A policy for other pods doesn't count, either way.
  const others = { podSelector: { matchLabels: { app: "egress" } }, egress: [{}] };
  assert.equal(isolationProblem(add(others), labels), null);
  assert.match(isolationProblem([{ metadata: {}, spec: others }], labels), /no NetworkPolicy/);
  // Egress only: what comes in isn't denied.
  const egressOnly = { ...POLICY.spec, policyTypes: ["Egress"] };
  assert.match(isolationProblem([{ metadata: {}, spec: egressOnly }], labels), /no NetworkPolicy/);
});

test("isolationProblem, apart: the egress proxy's pods in the services' namespace, nothing else", () => {
  const labels = { "deckhand.owner": "dh", "deckhand.role": "sandbox", "deckhand.run": "r" };
  const proxy = { namespace: SVC, selector: { app: "deckhand-egress" } };
  assert.equal(isolationProblem([APART_POLICY], labels, { proxy }), null);
  const withPeer = (peer, ports = [{ port: 3128 }]) => [
    {
      metadata: { name: "deckhand-sandboxes" },
      spec: { ...APART_POLICY.spec, egress: [{ to: [peer], ports }] },
    },
  ];
  const svc = { matchLabels: { "kubernetes.io/metadata.name": SVC } };
  const egress = { matchLabels: { app: "deckhand-egress" } };
  // Narrower still, or the same written as expressions: allowed.
  for (const peer of [
    { namespaceSelector: svc, podSelector: { matchLabels: { app: "deckhand-egress", v: "2" } } },
    {
      namespaceSelector: {
        matchExpressions: [{ key: "kubernetes.io/metadata.name", operator: "In", values: [SVC] }],
      },
      podSelector: {
        matchExpressions: [{ key: "app", operator: "In", values: ["deckhand-egress"] }],
      },
    },
  ]) {
    assert.equal(isolationProblem(withPeer(peer), labels, { proxy }), null, JSON.stringify(peer));
  }
  // Another pod of the services' namespace, or all of them.
  for (const podSelector of [
    { matchLabels: { app: "orchestrator" } },
    {},
    undefined,
    { matchExpressions: [{ key: "app", operator: "In", values: ["deckhand-egress", "broker"] }] },
    { matchExpressions: [{ key: "app", operator: "NotIn", values: ["broker"] }] },
  ]) {
    assert.match(
      isolationProblem(withPeer({ namespaceSelector: svc, podSelector }), labels, { proxy }),
      /lets sandbox pods reach pods of the namespace deckhand other than the egress proxy's/,
      JSON.stringify(podSelector),
    );
  }
  // A third namespace, every namespace, the sandboxes' own pods, an address.
  for (const peer of [
    {
      namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "other" } },
      podSelector: egress,
    },
    { namespaceSelector: {}, podSelector: egress },
    {
      namespaceSelector: {
        matchExpressions: [
          { key: "kubernetes.io/metadata.name", operator: "In", values: [SVC, "other"] },
        ],
      },
      podSelector: egress,
    },
    { namespaceSelector: { matchLabels: { team: "deckhand" } }, podSelector: egress },
    { podSelector: egress },
    { podSelector: { matchLabels: { "deckhand.role": "install" } } },
    { ipBlock: { cidr: "10.244.0.0/16" } },
  ]) {
    assert.match(
      isolationProblem(withPeer(peer), labels, { proxy }),
      /lets sandbox pods reach beyond the namespace deckhand/,
      JSON.stringify(peer),
    );
  }
  // A proxy Service without a selector: nothing tells its pods.
  assert.match(
    isolationProblem([APART_POLICY], labels, { proxy: { namespace: SVC, selector: {} } }),
    /other than the egress proxy's .*which has none/,
  );
  // Its other ports, as in one namespace.
  assert.match(
    isolationProblem(
      withPeer({ namespaceSelector: svc, podSelector: egress }, [{ port: 8083 }]),
      labels,
      {
        proxy,
      },
    ),
    /reach port 8083 of the egress proxy's pods \(only 3128\)/,
  );
  // The single-namespace policy no longer does: its peer is the sandboxes' own namespace.
  assert.match(isolationProblem([POLICY], labels, { proxy }), /beyond the namespace deckhand/);
  // Ingress refused as in one namespace.
  const ingress = { ...APART_POLICY, spec: { ...APART_POLICY.spec, ingress: [{}] } };
  assert.match(isolationProblem([ingress], labels, { proxy }), /lets traffic in/);
});

test("start, apart: the pod, its Secret and claims in the sandboxes' namespace, the proxy read in the services'", async (t) => {
  const kubernetes = { registrySecret: "pull" };
  const pull = (auth) => ({
    metadata: { name: "pull", resourceVersion: "1" },
    type: "kubernetes.io/dockerconfigjson",
    data: { ".dockerconfigjson": Buffer.from(JSON.stringify({ auths: auth })).toString("base64") },
  });
  let time = 0;
  const { runner, objects, servicesObjects, calls } = setup(
    t,
    { apart: true, policies: [APART_POLICY] },
    { kubernetes, now: () => time },
  );
  servicesObjects.secrets.set("pull", pull({ "registry.example.com": { auth: "a" } }));
  await runner.start(spec());
  assert.deepEqual([...objects.pods.keys()], ["dh-org-repo-12-abc"]);
  assert.deepEqual([...objects.persistentvolumeclaims.keys()].sort(), [
    "dh-org-repo-12-abc-claude",
    "dh-org-repo-12-abc-workspace",
  ]);
  // Nothing made in the services' namespace; only its Service, its Secret read.
  for (const kind of ["pods", "persistentvolumeclaims", "events"]) {
    assert.equal(servicesObjects[kind].size, 0, kind);
  }
  assert.deepEqual([...servicesObjects.secrets.keys()], ["pull"]);
  const writes = calls.filter((c) => !c.startsWith("GET"));
  assert.ok(
    writes.every((c) => c.includes(`/namespaces/${NS}/`)),
    writes.join("\n"),
  );
  assert.ok(calls.includes(`GET /api/v1/namespaces/${SVC}/services/egress`));
  assert.ok(calls.includes(`GET /apis/networking.k8s.io/v1/namespaces/${NS}/networkpolicies`));
  const pod = objects.pods.get("dh-org-repo-12-abc");
  assert.deepEqual(pod.spec.hostAliases, [{ ip: "10.96.0.11", hostnames: ["egress"] }]);
  // Its pull Secret: a copy of the services' one in its own namespace, as pods pull with.
  assert.deepEqual(pod.spec.imagePullSecrets, [{ name: "pull" }]);
  const copy = objects.secrets.get("pull");
  assert.equal(copy.type, "kubernetes.io/dockerconfigjson");
  assert.deepEqual(copy.data, servicesObjects.secrets.get("pull").data);
  assert.equal(copy.metadata.labels["deckhand.owner"], "dh");
  assert.ok(objects.secrets.has("dh-org-repo-12-abc-1730000000-env"));
  // Rotated in the services' namespace: the copy follows, once the source is read again.
  servicesObjects.secrets.set("pull", pull({ "registry.example.com": { auth: "b" } }));
  time += 61_000;
  await runner.start(spec({ name: "dh-org-repo-13-abc", run: "dh-org-repo-13-abc-1" }));
  assert.deepEqual(objects.secrets.get("pull").data, servicesObjects.secrets.get("pull").data);
  // One of that name that isn't the runner's copy is never overwritten: the run is refused.
  objects.secrets.set("pull", { metadata: { name: "pull", labels: {} }, data: {} });
  time += 61_000;
  await assert.rejects(
    runner.start(spec({ name: "dh-org-repo-14-abc", run: "dh-org-repo-14-abc-1" })),
    /the Secret pull in the namespace runs isn't the runner's copy of KUBERNETES_REGISTRY_SECRET/,
  );
  assert.deepEqual(objects.secrets.get("pull").data, {});
  assert.equal(objects.pods.has("dh-org-repo-14-abc"), false);
});

test("start, apart: a pull Secret there that isn't the runner's copy is refused, even holding the same data", async (t) => {
  const kubernetes = { registrySecret: "pull" };
  const data = { ".dockerconfigjson": Buffer.from("{}").toString("base64") };
  const source = { metadata: { name: "pull" }, data };
  // The same data, labelled the runner's owner but not its copy's role; then one made between
  // the runner's look and its create (a 409), by someone else.
  const foreign = { metadata: { name: "pull", labels: { "deckhand.owner": "dh" } }, data };
  {
    const { runner, objects, servicesObjects } = setup(
      t,
      { apart: true, policies: [APART_POLICY] },
      { kubernetes },
    );
    servicesObjects.secrets.set("pull", source);
    objects.secrets.set("pull", foreign);
    await assert.rejects(
      runner.start(spec()),
      /the Secret pull in the namespace runs isn't the runner's copy of KUBERNETES_REGISTRY_SECRET \(labelled deckhand.owner: dh and deckhand.role: registry\)/,
    );
    assert.equal(objects.pods.size, 0);
  }
  let raced = false;
  const fake = setup(
    t,
    {
      apart: true,
      policies: [APART_POLICY],
      fail: ({ method, path, body }) => {
        if (
          method !== "POST" ||
          !path.endsWith(`/namespaces/${NS}/secrets`) ||
          body.metadata.name !== "pull"
        ) {
          return null;
        }
        raced = true;
        fake.objects.secrets.set("pull", foreign);
        return Response.json({ message: "already exists" }, { status: 409 });
      },
    },
    { kubernetes },
  );
  fake.servicesObjects.secrets.set("pull", source);
  await assert.rejects(fake.runner.start(spec()), /isn't the runner's copy/);
  assert.ok(raced);
  assert.equal(fake.objects.pods.size, 0);
  // Its own copy, made by the other runner meanwhile: used.
  fake.objects.secrets.set("pull", {
    metadata: { name: "pull", labels: { "deckhand.owner": "dh", "deckhand.role": "registry" } },
    data,
  });
  await fake.runner.start(spec());
  assert.equal(fake.objects.pods.size, 1);
});

test("start, apart: the pull Secret's copy changed or gone under it (another start's) is looked at again", async (t) => {
  const kubernetes = { registrySecret: "pull" };
  const config = (auth) => ({
    ".dockerconfigjson": Buffer.from(JSON.stringify({ auths: { r: { auth } } })).toString("base64"),
  });
  const labels = { "deckhand.owner": "dh", "deckhand.role": "registry" };
  let time = 0;
  let race = null; // what another start does just before this one's write lands
  const fake = setup(
    t,
    {
      apart: true,
      policies: [APART_POLICY],
      fail: ({ method, path }) => {
        if (
          !race ||
          !path.endsWith(`/namespaces/${NS}/secrets${method === "PUT" ? "/pull" : ""}`)
        ) {
          return null;
        }
        if (!["PUT", "POST"].includes(method)) return null;
        const then = race;
        race = null;
        return then(method);
      },
    },
    { kubernetes, now: () => time },
  );
  const { runner, objects, servicesObjects } = fake;
  servicesObjects.secrets.set("pull", { metadata: { name: "pull" }, data: config("a") });
  await runner.start(spec());
  assert.deepEqual(objects.secrets.get("pull").data, config("a"));
  // Rotated; another start brings the copy up to date between this one's look and its PUT,
  // whose version is then stale: a 409, looked at again, and found up to date.
  servicesObjects.secrets.set("pull", { metadata: { name: "pull" }, data: config("b") });
  time += 61_000;
  let puts = 0;
  race = () => {
    puts++;
    const copy = objects.secrets.get("pull");
    objects.secrets.set("pull", {
      ...copy,
      metadata: { ...copy.metadata, resourceVersion: "9" },
      data: config("b"),
    });
    return null; // this PUT goes on, its resourceVersion now stale
  };
  await runner.start(spec({ name: "dh-org-repo-13-abc", run: "dh-org-repo-13-abc-1" }));
  assert.equal(puts, 1);
  assert.deepEqual(objects.secrets.get("pull").data, config("b"));
  assert.ok(objects.pods.has("dh-org-repo-13-abc"));
  // Two starts at once across a rotation: both run, the copy up to date.
  servicesObjects.secrets.set("pull", { metadata: { name: "pull" }, data: config("c") });
  time += 61_000;
  await Promise.all([
    runner.start(spec({ name: "dh-org-repo-14-abc", run: "dh-org-repo-14-abc-1" })),
    runner.start(spec({ name: "dh-org-repo-15-abc", run: "dh-org-repo-15-abc-1" })),
  ]);
  assert.ok(objects.pods.has("dh-org-repo-14-abc") && objects.pods.has("dh-org-repo-15-abc"));
  assert.deepEqual(objects.secrets.get("pull").data, config("c"));
  // Made by someone meanwhile (a 409), then gone again: made anew, not "remove it".
  objects.secrets.delete("pull");
  time += 61_000;
  race = () => Response.json({ message: "already exists" }, { status: 409 });
  await runner.start(spec({ name: "dh-org-repo-16-abc", run: "dh-org-repo-16-abc-1" }));
  assert.deepEqual(objects.secrets.get("pull").metadata.labels, labels);
  assert.ok(objects.pods.has("dh-org-repo-16-abc"));
});

test("start, apart: the single-namespace policy, or a proxy at an address, starts nothing", async (t) => {
  const { runner, objects } = setup(t, { apart: true });
  await assert.rejects(
    runner.start(spec()),
    /the namespace runs doesn't isolate its sandboxes: the NetworkPolicy deckhand-sandboxes lets sandbox pods reach beyond the namespace deckhand/,
  );
  const byAddress = setup(t, { apart: true, policies: [APART_POLICY] });
  const runner2 = createKubernetesRunner({
    config: { ...config, egressProxy: "http://10.96.0.11:3128" },
    api: byAddress.api,
    services: byAddress.servicesApi,
    inboxDir: tempDir(t),
  });
  await assert.rejects(
    runner2.start(spec()),
    /EGRESS_PROXY \(http:\/\/10\.96\.0\.11:3128\) is an address/,
  );
  assert.equal(objects.pods.size + byAddress.objects.pods.size, 0);
  assert.equal(objects.secrets.size + byAddress.objects.secrets.size, 0);
});

test("proxyAddresses and locate, apart: the proxy's endpoints in the services' namespace, sandboxes in theirs", async (t) => {
  const slices = [{ endpoints: [{ addresses: ["10.244.2.3"] }] }];
  const { runner, objects, calls } = setup(t, { apart: true, policies: [APART_POLICY], slices });
  assert.deepEqual(await runner.proxyAddresses(), ["10.244.2.3"]);
  assert.match(
    calls.at(-1),
    new RegExp(`^GET /apis/discovery.k8s.io/v1/namespaces/${SVC}/endpointslices`),
  );
  await runner.start(spec());
  const { uid } = objects.pods.get("dh-org-repo-12-abc").metadata;
  assert.deepEqual(await runner.locate("10.244.1.7"), { sandbox: uid, name: null });
  assert.match(calls.at(-1), new RegExp(`^GET /api/v1/namespaces/${NS}/pods\\?`));
});

test("selects: matchLabels and matchExpressions", () => {
  const labels = { a: "1", b: "2" };
  assert.ok(selects({}, labels));
  assert.ok(selects({ matchLabels: { a: "1" } }, labels));
  assert.ok(!selects({ matchLabels: { a: "2" } }, labels));
  const expr = (operator, values) => ({ matchExpressions: [{ key: "a", operator, values }] });
  assert.ok(selects(expr("In", ["1", "3"]), labels));
  assert.ok(!selects(expr("NotIn", ["1"]), labels));
  assert.ok(selects(expr("Exists"), labels));
  assert.ok(!selects(expr("DoesNotExist"), labels));
});

test("start: an engine without Sysbox's RuntimeClass, a host mount or a cache is refused", async (t) => {
  const { runner, objects } = setup(t);
  await assert.rejects(
    runner.start(spec({ engine: { limits: {} } })),
    /only with Sysbox's RuntimeClass/,
  );
  // Podman's engine never: its seccomp is unconfined.
  const podman = setup(t, {}, { kubernetes: ENGINE, engine: "podman" });
  await assert.rejects(
    podman.runner.start(spec({ engine: { limits: {} } })),
    /only with Sysbox's RuntimeClass/,
  );
  assert.equal(podman.objects.pods.size, 0);
  const mount = { kind: "mount", name: "/srv", path: "/srv" };
  await assert.rejects(runner.start(spec({ volumes: [mount] })), /no host path/);
  // A cache only with a class to make its claims of (KUBERNETES_CACHE_STORAGE_CLASS).
  const cache = { kind: "cache", name: "c", path: "/c" };
  await assert.rejects(runner.start(spec({ volumes: [cache] })), /no cache/);
  assert.equal(objects.pods.size + objects.secrets.size, 0);
});

test("start: an engine with Sysbox's RuntimeClass is a sidecar in the pod, root in its user namespace alone", async (t) => {
  const { runner, objects } = setup(t, {}, { kubernetes: ENGINE });
  const engine = { limits: { cpus: "2", memory: "4g", pids: 2048 }, cache: null };
  // An agent without a claim: its install's init container too.
  const volumes = [agentVolume, ...spec().volumes.slice(1)];
  assert.deepEqual(await runner.start(spec({ engine, volumes })), {
    engine: { backend: "sysbox", cached: false },
  });
  const pod = objects.pods.get("dh-org-repo-12-abc");
  const s = pod.spec;
  // Every container under Sysbox, in the pod's own user namespace.
  assert.equal(s.runtimeClassName, "sysbox-runc");
  assert.equal(s.hostUsers, false);
  // The network gate, the agent's install, then the engine: a sidecar (restartPolicy Always),
  // up before the sandbox starts and stopped once it exits.
  assert.deepEqual(
    s.initContainers.map((c) => c.name),
    ["network-gate", "agent-install", "engine"],
  );
  const sidecar = s.initContainers[2];
  assert.equal(sidecar.restartPolicy, "Always");
  assert.equal(sidecar.image, "dh-engine");
  // Its API on the pod's loopback only: the node reaches the pod's address whatever the policy.
  assert.deepEqual(sidecar.args, [
    "dockerd",
    "--host=unix:///var/run/docker.sock",
    "--host=tcp://127.0.0.1:2375",
  ]);
  // Its way out, the proxy's engines' port: what the engine pulls isn't decrypted.
  assert.deepEqual(sidecar.env, [{ name: "EGRESS_PROXY", value: "http://egress:3129" }]);
  // Root for dockerd, which Sysbox maps to an unprivileged user; nothing else relaxed.
  assert.deepEqual(sidecar.securityContext, {
    allowPrivilegeEscalation: false,
    capabilities: { drop: ["ALL"] },
    runAsNonRoot: false,
    seccompProfile: { type: "RuntimeDefault" },
    runAsUser: 0,
    runAsGroup: 0,
  });
  assert.deepEqual(sidecar.resources, {
    limits: { cpu: "2", memory: "4Gi" },
    requests: { cpu: "2", memory: "4Gi" },
  });
  assert.deepEqual(sidecar.volumeMounts, [{ name: "engine", mountPath: "/var/lib/docker" }]);
  assert.deepEqual(s.volumes.at(-1), { name: "engine", emptyDir: { sizeLimit: "20Gi" } });
  // No process namespace shared, as Sysbox advises: the sandbox's entrypoint reaps instead.
  assert.equal(s.shareProcessNamespace, false);
  // The sandbox itself as without an engine: its user, nothing relaxed.
  const [c] = s.containers;
  assert.equal(c.securityContext.runAsNonRoot, true);
  assert.equal(s.securityContext.runAsUser, 1000);
  // It reaches the engine at `engine`, in the pod, and its containers the proxy's engines' port.
  const env = Object.fromEntries(c.env.map((e) => [e.name, e.value]));
  assert.equal(env.DOCKER_HOST, "tcp://engine:2375");
  assert.equal(env.DECKHAND_ENGINE_PROXY, "http://egress:3129");
  assert.equal(env.SANDBOX_REAP, "1");
  assert.deepEqual(s.hostAliases, [
    { ip: "10.96.0.11", hostnames: ["egress"] },
    { ip: "127.0.0.1", hostnames: ["engine"] },
  ]);
  // Still Pod Security `restricted`, as Kubernetes 1.35 checks it.
  assert.deepEqual(restrictedProblems(pod), []);
  // Without its user namespace, that root would fail it.
  assert.deepEqual(restrictedProblems({ ...pod, spec: { ...s, hostUsers: undefined } }), [
    "engine: may be root",
    "engine: runs as root",
  ]);
  // A run without an engine gets none of it, the RuntimeClass set or not.
  objects.pods.clear();
  await runner.start(spec({ run: "dh-org-repo-12-abc-1730000999", volumes }));
  const plain = objects.pods.get("dh-org-repo-12-abc").spec;
  assert.equal(plain.runtimeClassName, undefined);
  assert.equal(plain.shareProcessNamespace, true);
  assert.ok(!plain.containers[0].env.some((e) => e.name === "SANDBOX_REAP"));
  assert.equal(plain.hostUsers, undefined);
  assert.deepEqual(
    plain.initContainers.map((c) => c.name),
    ["network-gate", "agent-install"],
  );
});

test("start: an engine whose proxy Service has no engines' port starts nothing, saying so", async (t) => {
  const { runner, objects } = setup(t, {}, { kubernetes: ENGINE });
  const egress = structuredClone(objects.services.get("egress"));
  egress.spec.ports = [{ port: 3128 }];
  objects.services.set("egress", egress);
  const engine = { limits: { cpus: "2", memory: "4g" }, cache: null };
  await assert.rejects(
    runner.start(spec({ engine })),
    /the Service egress in the namespace runs has no port 3129, the egress proxy's engines' port/,
  );
  assert.equal(objects.pods.size + objects.secrets.size, 0);
  // A run without an engine doesn't need it.
  await runner.start(spec());
  assert.equal(objects.pods.size, 1);
});

test("start: with an engine, the proxy's engines' port may be in the sandboxes' policy, no other", async (t) => {
  const both = structuredClone(POLICY);
  both.spec.egress[0].ports = [{ port: 3128 }, { port: 3129 }];
  // Without the RuntimeClass, a policy that lets them reach 3129 is too wide.
  const off = setup(t, { policies: [both] });
  await assert.rejects(off.runner.start(spec()), /lets sandbox pods reach port 3129/);
  const on = setup(t, { policies: [both] }, { kubernetes: ENGINE });
  await on.runner.start(spec());
  assert.equal(on.objects.pods.size, 1);
  const wider = structuredClone(both);
  wider.spec.egress[0].ports.push({ port: 8082 });
  const other = setup(t, { policies: [wider] }, { kubernetes: ENGINE });
  await assert.rejects(other.runner.start(spec()), /lets sandbox pods reach port 8082/);
});

test("start: with a cache class, a cache is its claim, mounted read-write", async (t) => {
  const { runner, objects } = setup(t, {}, { kubernetes: { cacheStorageClass: "nfs" } });
  const cache = { kind: "cache", name: "dh-cache-org-repo-npm", path: "/home/node/.npm" };
  await runner.start(spec({ volumes: [...spec().volumes, cache] }));
  const pod = objects.pods.get("dh-org-repo-12-abc");
  assert.deepEqual(pod.spec.volumes.at(-1).persistentVolumeClaim, {
    claimName: "dh-cache-org-repo-npm",
  });
  assert.deepEqual(pod.spec.containers[0].volumeMounts.at(-1), {
    name: "v3",
    mountPath: "/home/node/.npm",
  });
  // The cache's claim is the images' to make (kube-images.mjs), not the runner's.
  assert.ok(!objects.persistentvolumeclaims.has("dh-cache-org-repo-npm"));
});

// The agent's volume as sandboxSpec() gives it, with how to fill it.
const agentVolume = {
  kind: "agent",
  name: "dh-claude-code",
  path: "/opt/claude-code",
  readOnly: true,
  install: { command: "deckhand-install-claude-code", env: { CLAUDE_CODE_VERSION: "9.9.9" } },
};

test("start: an agent without a claim is installed by an init container, mounted read-only", async (t) => {
  const { runner, objects } = setup(t, {}, { kubernetes: { registrySecret: "pull" } });
  const volumes = [agentVolume, ...spec().volumes.slice(1)];
  await runner.start(spec({ volumes }));
  const pod = objects.pods.get("dh-org-repo-12-abc");
  assert.equal(pod.metadata.annotations["deckhand.agent-init"], "dh-claude-code");
  // The nodes pull through the registry's Secret.
  assert.deepEqual(pod.spec.imagePullSecrets, [{ name: "pull" }]);
  assert.deepEqual(pod.spec.volumes[0], { name: "v0", emptyDir: {} });
  // After the network gate: nothing reaches the proxy before the pod's policies apply.
  const [gate, init] = pod.spec.initContainers;
  assert.equal(gate.name, "network-gate");
  // From the base image, as neither root nor the sandbox's user, hardened as the sandbox is.
  assert.equal(init.image, "dh-sandbox");
  assert.deepEqual(init.command, ["deckhand-install-claude-code"]);
  assert.deepEqual(init.securityContext, {
    allowPrivilegeEscalation: false,
    capabilities: { drop: ["ALL"] },
    runAsNonRoot: true,
    seccompProfile: { type: "RuntimeDefault" },
    runAsUser: INSTALL_USER.uid,
    runAsGroup: INSTALL_USER.gid,
  });
  assert.notEqual(INSTALL_USER.uid, SANDBOX_USER.uid);
  assert.notEqual(INSTALL_USER.uid, 0);
  assert.deepEqual(init.volumeMounts, [
    { name: "v0", mountPath: "/opt/claude-code", readOnly: false },
  ]);
  const env = Object.fromEntries(init.env.map((e) => [e.name, e.value]));
  assert.equal(env.CLAUDE_CODE_VERSION, "9.9.9");
  // Out through the egress proxy, the only way out of a sandbox's pod.
  assert.equal(env.HTTPS_PROXY, "http://egress:3128");
  // Never the run's secrets: those are the sandbox's, in its Secret.
  assert.ok(!JSON.stringify(init).includes("s3cret"));
  // The sandbox only reads it.
  assert.deepEqual(pod.spec.containers[0].volumeMounts[0], {
    name: "v0",
    mountPath: "/opt/claude-code",
    readOnly: true,
  });
});

test("start: an agent whose claim is there mounts it, no install's init container", async (t) => {
  const { runner, objects } = setup(t);
  objects.persistentvolumeclaims.set("dh-claude-code", { metadata: { name: "dh-claude-code" } });
  await runner.start(spec({ volumes: [agentVolume, ...spec().volumes.slice(1)] }));
  const pod = objects.pods.get("dh-org-repo-12-abc");
  assert.deepEqual(
    pod.spec.initContainers.map((c) => c.name),
    ["network-gate"],
  );
  assert.equal(pod.spec.imagePullSecrets, undefined);
  assert.equal(pod.metadata.annotations["deckhand.agent-init"], undefined);
  assert.deepEqual(pod.spec.volumes[0].persistentVolumeClaim, {
    claimName: "dh-claude-code",
    readOnly: true,
  });
});

test("start: the network gate first, from the base image: the API server and the DNS out of reach, the proxy reached", async (t) => {
  const { runner, objects } = setup(t);
  // A repo's image: the gate is the base image's all the same, which has node.
  await runner.start(spec({ image: "registry.example.com/dh/org-repo:abc" }));
  const pod = objects.pods.get("dh-org-repo-12-abc");
  const [gate] = pod.spec.initContainers;
  assert.equal(gate.name, "network-gate");
  assert.equal(gate.image, "dh-sandbox");
  assert.equal(pod.spec.containers[0].image, "registry.example.com/dh/org-repo:abc");
  assert.deepEqual(JSON.parse(gate.command[3]), [
    { what: "the Kubernetes API server", host: "10.96.0.1", port: 443, reach: false },
    { what: "the cluster's DNS", host: "10.96.0.10", port: 53, reach: false },
    { what: "the egress proxy", host: "10.96.0.11", port: 3128, reach: true },
  ]);
  // Its deadline before the pod's Pending one (KUBERNETES_PENDING_MINUTES from its creation),
  // so that its own failure, saying what it still reached, is what the run is told.
  const created = Date.parse("2026-10-30T10:00:00Z");
  assert.equal(gate.command[4], String(created + 600_000 - 30_000));
  // No secret of the run's, and Pod Security `restricted` still.
  assert.equal(gate.envFrom, undefined);
  assert.ok(!JSON.stringify(gate).includes("s3cret"));
  assert.deepEqual(restrictedProblems(pod), []);
});

test("start: a runner that knows no address to gate on starts nothing", async (t) => {
  const { runner, objects } = setup(t, {}, { probeOptions: { env: {}, resolvConf: () => "" } });
  await assert.rejects(runner.start(spec()), /knows no address the sandboxes mustn't reach/);
  assert.equal(objects.pods.size + objects.secrets.size, 0);
});

test("follow: a network gate that never saw its NetworkPolicies apply fails the run, nothing of it run", async (t) => {
  const { runner, objects, calls, logged } = setup(t, {
    logs: {
      "dh-org-repo-12-abc": [
        "still reached the Kubernetes API server (10.96.0.1:443) after 600 s\n",
      ],
    },
  });
  await runner.start(spec());
  const pod = objects.pods.get("dh-org-repo-12-abc");
  pod.status = {
    phase: "Failed",
    initContainerStatuses: [{ name: "network-gate", state: { terminated: { exitCode: 3 } } }],
  };
  await assert.rejects(
    runner.follow("dh-org-repo-12-abc", { onOut: () => {}, onErr: () => {} }),
    (error) =>
      error instanceof RunError &&
      /its NetworkPolicies didn't apply: still reached the Kubernetes API server \(10\.96\.0\.1:443\) after 600 s\. Nothing of the run's ran/.test(
        error.message,
      ),
  );
  assert.ok(calls.some((c) => c.includes("/log?container=network-gate")));
  assert.ok(logged.some((line) => /its NetworkPolicies didn't apply/.test(line)));
});

test("follow: a gate still waiting past KUBERNETES_PENDING_MINUTES points to the NetworkPolicies, not 'make room'", async (t) => {
  // Its own deadline came first unless the node's clock is far off the runner's: said all the same.
  const { runner, objects } = setup(t);
  await runner.start(spec());
  const pod = objects.pods.get("dh-org-repo-12-abc");
  pod.metadata.creationTimestamp = "2026-10-30T09:00:00Z";
  pod.status = {
    phase: "Pending",
    initContainerStatuses: [{ name: "network-gate", state: { running: {} } }],
    containerStatuses: [{ state: { waiting: { reason: "PodInitializing" } } }],
  };
  await assert.rejects(
    runner.follow("dh-org-repo-12-abc", { onOut: () => {}, onErr: () => {} }),
    (error) =>
      /stayed Pending for 10 min \(its init container waits for its NetworkPolicies to apply\)\. The operator can check that the cluster's network plugin enforces NetworkPolicies/.test(
        error.message,
      ),
  );
});

test("installing: while its init container hasn't ended, whatever the pod's phase says yet", async (t) => {
  const { runner, objects } = setup(t);
  await runner.start(spec({ volumes: [agentVolume, ...spec().volumes.slice(1)] }));
  const pod = objects.pods.get("dh-org-repo-12-abc");
  pod.status.phase = "Pending";
  assert.equal(await runner.installing("dh-org-repo-12-abc"), true);
  // Its init container ended: the sandbox starts, before the kubelet reports Running.
  pod.status.initContainerStatuses = [
    { name: "agent-install", state: { terminated: { exitCode: 0 } } },
  ];
  assert.equal(await runner.installing("dh-org-repo-12-abc"), false);
  pod.status.initContainerStatuses = [{ name: "agent-install", state: { running: {} } }];
  assert.equal(await runner.installing("dh-org-repo-12-abc"), true);
  pod.status.phase = "Running";
  assert.equal(await runner.installing("dh-org-repo-12-abc"), false);
  // A pod without an init container never installs.
  objects.pods.clear();
  await runner.start(spec({ run: "dh-org-repo-12-abc-1730000999" }));
  objects.pods.get("dh-org-repo-12-abc").status.phase = "Pending";
  assert.equal(await runner.installing("dh-org-repo-12-abc"), false);
});

test("installing: an API that can't tell is no answer, not a refused connection", async (t) => {
  let failing = false;
  const { runner } = setup(t, {
    fail: ({ method, path }) =>
      failing && method === "GET" && path.endsWith("/pods/dh-org-repo-12-abc")
        ? Response.json({ message: "etcd timeout" }, { status: 500 })
        : null,
  });
  await runner.start(spec({ volumes: [agentVolume, ...spec().volumes.slice(1)] }));
  failing = true;
  assert.equal(await runner.installing("dh-org-repo-12-abc"), null);
});

test("follow: a failed install in the init container fails the run, its output in the log", async (t) => {
  const { runner, objects, calls, logged } = setup(t, {
    logs: { "dh-org-repo-12-abc": ["npm error 403 registry.npmjs.org\n"] },
  });
  await runner.start(spec({ volumes: [agentVolume, ...spec().volumes.slice(1)] }));
  const pod = objects.pods.get("dh-org-repo-12-abc");
  pod.status = {
    phase: "Failed",
    initContainerStatuses: [{ name: "agent-install", state: { terminated: { exitCode: 1 } } }],
  };
  const err = [];
  await assert.rejects(
    runner.follow("dh-org-repo-12-abc", { onOut: () => {}, onErr: (line) => err.push(line) }),
    (error) =>
      error instanceof RunError &&
      /installing its agent \(dh-claude-code\) in its init container failed \(exit 1\); the installer's output is in the run's log/.test(
        error.message,
      ),
  );
  assert.deepEqual(err, ["npm error 403 registry.npmjs.org"]);
  assert.ok(calls.some((c) => c.includes("/log?container=agent-install")));
  assert.ok(logged.some((line) => /installing dh-claude-code failed \(exit 1\)/.test(line)));
});

test("follow: an install still running past KUBERNETES_PENDING_MINUTES says so, not 'make room'", async (t) => {
  const { runner, objects } = setup(t);
  await runner.start(spec({ volumes: [agentVolume, ...spec().volumes.slice(1)] }));
  const pod = objects.pods.get("dh-org-repo-12-abc");
  pod.metadata.creationTimestamp = "2026-10-30T09:00:00Z";
  pod.status = {
    phase: "Pending",
    initContainerStatuses: [{ name: "agent-install", state: { running: {} } }],
    containerStatuses: [{ state: { waiting: { reason: "PodInitializing" } } }],
  };
  await assert.rejects(
    runner.follow("dh-org-repo-12-abc", { onOut: () => {}, onErr: () => {} }),
    (error) =>
      /stayed Pending for 10 min \(its init container is installing the agent\)\. The operator can check that the agent's install reaches its hosts/.test(
        error.message,
      ),
  );
});

test("list and state: this deployment's sandbox pods, Pending and Running as running", async (t) => {
  const { runner, objects } = setup(t);
  await runner.start(spec());
  await runner.start(spec({ run: "r2", name: "dh-other" }));
  objects.pods.get("dh-other").status.phase = "Failed";
  objects.pods.set("someone-else", {
    metadata: {
      name: "someone-else",
      labels: { "deckhand.owner": "xx", "deckhand.role": "sandbox" },
    },
    status: { phase: "Running" },
  });
  assert.deepEqual(await runner.list(), [
    { name: "dh-org-repo-12-abc", run: "dh-org-repo-12-abc-1730000000", running: true },
    { name: "dh-other", run: "r2", running: false },
  ]);
  objects.pods.get("dh-org-repo-12-abc").status.phase = "Pending";
  assert.equal(await runner.state("dh-org-repo-12-abc"), "running");
  assert.equal(await runner.state("dh-other"), "exited");
  assert.equal(await runner.state("dh-gone"), null);
  // Its sandbox container's exit code, once it ended (the run events'): none while it runs.
  assert.equal(await runner.exitCode("dh-other"), null);
  objects.pods.get("dh-other").status.containerStatuses = [
    { name: "sandbox", state: { terminated: { exitCode: 137 } } },
  ];
  assert.equal(await runner.exitCode("dh-other"), 137);
  assert.equal(await runner.exitCode("dh-gone"), null);
  // The API failing isn't "none".
  const broken = setup(t, {
    fail: () => Response.json({ message: "etcd down" }, { status: 500 }),
  });
  await assert.rejects(broken.runner.list(), /etcd down/);
  await assert.rejects(broken.runner.state("x"), /etcd down/);
});

test("follow: the agent's lines and the rest apart, from one log, past what was read", async (t) => {
  const stamp = (s) => `2026-10-30T10:00:0${s}.123456789Z `;
  // Stderr's lines start with STDERR_TAG, a setup's JSON too: it's never the agent's.
  const log = [
    `${stamp(1)}\x1eCloning…\n`,
    `${stamp(2)}{"type":"system"}\n${stamp(3)}\x1e{"type":"result","result":"from setup"}\n`,
    `${stamp(4)}{"type":"assi`,
    `stant"}\n${stamp(5)}{"type":"result"}\n${stamp(6)}\x1ehalf a line`,
  ];
  const { runner } = setup(t, { logs: { "dh-org-repo-12-abc": log } });
  await runner.start(spec());
  const out = [];
  const err = [];
  let caught = null;
  await runner.follow("dh-org-repo-12-abc", {
    skip: { out: 1, err: 1 },
    onOut: (line, at) => out.push([line, at]),
    onErr: (line) => err.push(line),
    // Past the skipped lines of both, before the next.
    onCaughtUp: () => (caught = [out.length, err.length]),
  });
  assert.deepEqual(caught, [0, 0]);
  assert.deepEqual(out, [
    ['{"type":"assistant"}', Date.parse("2026-10-30T10:00:04.123Z")],
    ['{"type":"result"}', Date.parse("2026-10-30T10:00:05.123Z")],
  ]);
  // The half line is read again, whole, by the next follow().
  assert.deepEqual(err, ['{"type":"result","result":"from setup"}']);
});

test("follow: a line over MAX_LINE is cut; a handler that throws loses its line only", async (t) => {
  const long = "x".repeat(MAX_LINE + 10);
  const { runner, logged } = setup(t, {
    logs: { "dh-org-repo-12-abc": [`\x1e${long}\n`, "\x1eboom\n", "\x1eafter\n"] },
  });
  await runner.start(spec());
  const err = [];
  await runner.follow("dh-org-repo-12-abc", {
    onOut: () => {},
    onErr: (line) => {
      if (line === "boom") throw new Error("disk full");
      err.push(line);
    },
  });
  // The tag counts toward MAX_LINE.
  assert.deepEqual(err, ["x".repeat(MAX_LINE - 1) + LINE_CUT, "after"]);
  assert.ok(logged.some((l) => l.includes("disk full")));
});

test("follow: a log shorter than what was read (rotated by the kubelet) is logged", async (t) => {
  const { runner, logged } = setup(t, { logs: { "dh-org-repo-12-abc": ["\x1eone\n"] } });
  await runner.start(spec());
  let caught = false;
  await runner.follow("dh-org-repo-12-abc", {
    skip: { out: 40, err: 2 },
    onOut: () => {},
    onErr: () => {},
    // Never past them: the run keeps its whole grace (runs.mjs follow()).
    onCaughtUp: () => (caught = true),
  });
  assert.equal(caught, false);
  assert.ok(
    logged.some((l) => /has 1 lines, fewer than the 42 already read.*containerLogMaxSize/.test(l)),
  );
});

test("follow: a Pending pod is waited for, then followed", async (t) => {
  let looks = 0;
  const fake = {};
  const { runner, objects, calls } = setup(
    t,
    { logs: { "dh-org-repo-12-abc": ["\x1estarted\n"] } },
    {
      sleep: async () => {
        if (++looks === 3) fake.pod.status.phase = "Running";
      },
    },
  );
  await runner.start(spec());
  fake.pod = objects.pods.get("dh-org-repo-12-abc");
  fake.pod.metadata.creationTimestamp = "2026-10-30T09:59:00Z";
  fake.pod.status.phase = "Pending";
  const err = [];
  await runner.follow("dh-org-repo-12-abc", { onOut: () => {}, onErr: (l) => err.push(l) });
  assert.equal(looks, 3);
  assert.deepEqual(err, ["started"]);
  assert.ok(calls.at(-1).includes("/log?container=sandbox&follow=true&timestamps=true"));
});

test("follow: a pod Pending past KUBERNETES_PENDING_MINUTES fails its run, saying why", async (t) => {
  const { runner, objects, calls } = setup(t);
  await runner.start(spec());
  const pod = objects.pods.get("dh-org-repo-12-abc");
  pod.metadata.creationTimestamp = "2026-10-30T09:50:00Z"; // 10 min before now()
  pod.status = {
    phase: "Pending",
    conditions: [
      {
        type: "PodScheduled",
        status: "False",
        reason: "Unschedulable",
        message: "0/3 nodes are available: 3 Insufficient memory.",
      },
    ],
  };
  await assert.rejects(
    runner.follow("dh-org-repo-12-abc", { onOut: () => {}, onErr: () => {} }),
    (error) =>
      error instanceof RunError &&
      /stayed Pending for 10 min \(0\/3 nodes are available: 3 Insufficient memory\.\)/.test(
        error.message,
      ),
  );
  assert.ok(
    calls.includes("DELETE /api/v1/namespaces/runs/pods/dh-org-repo-12-abc?gracePeriodSeconds=10"),
  );
  assert.equal(objects.pods.size, 0);
});

test("follow: a pod stuck mounting its volumes fails with its latest Warning event", async (t) => {
  const { runner, objects, calls } = setup(t);
  await runner.start(spec());
  const pod = objects.pods.get("dh-org-repo-12-abc");
  pod.metadata.creationTimestamp = "2026-10-30T09:50:00Z";
  pod.status = {
    phase: "Pending",
    containerStatuses: [{ state: { waiting: { reason: "ContainerCreating" } } }],
  };
  objects.events.set("e1", {
    metadata: { name: "e1" },
    type: "Warning",
    reason: "FailedAttachVolume",
    message: 'Multi-Attach error for volume "pvc-1": Volume is already used by pod(s) other',
    lastTimestamp: "2026-10-30T09:55:00Z",
  });
  const follow = () => runner.follow("dh-org-repo-12-abc", { onOut: () => {}, onErr: () => {} });
  await assert.rejects(
    follow(),
    /stayed Pending for 10 min \(FailedAttachVolume: Multi-Attach error for volume "pvc-1"/,
  );
  assert.ok(
    calls.some((c) =>
      c.endsWith(
        `/events?fieldSelector=involvedObject.kind%3DPod%2CinvolvedObject.name%3Ddh-org-repo-12-abc%2CinvolvedObject.uid%3D${pod.metadata.uid}`,
      ),
    ),
  );
  // No event either: it says what it can.
  await runner.remove("dh-org-repo-12-abc", "dh-org-repo-12-abc-1730000000");
  objects.events.clear();
  await runner.start(spec());
  Object.assign(objects.pods.get("dh-org-repo-12-abc"), {
    status: pod.status,
    metadata: {
      ...objects.pods.get("dh-org-repo-12-abc").metadata,
      creationTimestamp: "2026-10-30T09:50:00Z",
    },
  });
  await assert.rejects(follow(), /\(Kubernetes gave no reason: its volumes may not have mounted\)/);
});

test("pendingReason: an init container's image it can't pull, or its install running", () => {
  assert.equal(
    pendingReason({
      status: {
        initContainerStatuses: [
          { state: { waiting: { reason: "ErrImagePull", message: "denied" } } },
        ],
      },
    }),
    "ErrImagePull: denied",
  );
  assert.equal(
    pendingReason({
      status: { initContainerStatuses: [{ name: "agent-install", state: { running: {} } }] },
    }),
    INSTALLING,
  );
  // Its network gate waiting for its NetworkPolicies, before the install.
  assert.equal(
    pendingReason({
      status: {
        initContainerStatuses: [
          { name: "network-gate", state: { running: {} } },
          { name: "agent-install", state: { waiting: { reason: "PodInitializing" } } },
        ],
      },
    }),
    "its init container waits for its NetworkPolicies to apply",
  );
  // The engine's sidecar running says nothing about the agent's install.
  assert.equal(
    pendingReason({
      status: {
        initContainerStatuses: [
          { name: "agent-install", state: { terminated: { exitCode: 0 } } },
          { name: "engine", state: { running: {} } },
        ],
      },
    }),
    null,
  );
});

test("pendingReason: an image it can't pull before scheduling, else Kubernetes' silence", () => {
  const waiting = (reason, message) => ({
    status: { containerStatuses: [{ state: { waiting: { reason, message } } }] },
  });
  assert.equal(
    pendingReason(waiting("ImagePullBackOff", 'Back-off pulling image "x"')),
    'ImagePullBackOff: Back-off pulling image "x"',
  );
  // Nothing more than ContainerCreating: the events tell.
  assert.equal(pendingReason(waiting("ContainerCreating")), null);
  assert.equal(pendingReason({}), null);
  const event = (type, reason, at) => ({ type, reason, message: `${reason}!`, lastTimestamp: at });
  assert.equal(
    latestWarning([
      event("Warning", "FailedMount", "2026-10-30T09:55:00Z"),
      event("Warning", "FailedAttachVolume", "2026-10-30T09:58:00Z"),
      event("Normal", "Scheduled", "2026-10-30T09:59:00Z"),
    ]),
    "FailedAttachVolume: FailedAttachVolume!",
  );
  assert.equal(latestWarning([event("Normal", "Pulling", "2026-10-30T09:59:00Z")]), null);
});

test("wait: a leftover stuck Pending past the limit is removed, not waited on forever", async (t) => {
  let onSleep = () => {};
  const { runner, objects, calls, logged } = setup(t, {}, { sleep: async () => onSleep() });
  const deletes = () => calls.filter((c) => c.startsWith("DELETE")).length;
  await runner.start(spec());
  const pod = objects.pods.get("dh-org-repo-12-abc");
  pod.metadata.creationTimestamp = "2026-10-30T09:50:00Z"; // 10 min before now()
  pod.status = {
    phase: "Pending",
    containerStatuses: [{ state: { waiting: { reason: "ImagePullBackOff" } } }],
  };
  await runner.wait("dh-org-repo-12-abc");
  assert.equal(
    calls.filter((c) => c.startsWith("DELETE")).at(-1),
    "DELETE /api/v1/namespaces/runs/pods/dh-org-repo-12-abc?gracePeriodSeconds=10",
  );
  assert.ok(logged.some((l) => /Pending for 10 min \(ImagePullBackOff\): removing it/.test(l)));
  // Pending within the limit: waited for until it exits, never removed.
  await runner.remove("dh-org-repo-12-abc", "dh-org-repo-12-abc-1730000000");
  await runner.start(spec());
  const young = objects.pods.get("dh-org-repo-12-abc");
  young.metadata.creationTimestamp = "2026-10-30T09:59:00Z";
  young.status = { phase: "Pending" };
  const before = deletes();
  let looks = 0;
  onSleep = () => {
    if (++looks === 3) young.status.phase = "Succeeded";
  };
  await runner.wait("dh-org-repo-12-abc");
  assert.equal(looks, 3);
  assert.equal(deletes(), before);
});

test("apiBase: the API server's URL, an IPv6 host in brackets", () => {
  const env = (host) => ({ KUBERNETES_SERVICE_HOST: host, KUBERNETES_SERVICE_PORT: "443" });
  assert.equal(apiBase(env("10.96.0.1")), "https://10.96.0.1:443");
  assert.equal(apiBase(env("fd00:10:96::1")), "https://[fd00:10:96::1]:443");
  assert.equal(new URL(`${apiBase(env("fd00:10:96::1"))}/api`).hostname, "[fd00:10:96::1]");
});

test("wait, kill and remove: the pod deleted with its grace, then with its Secret", async (t) => {
  let looks = 0;
  const { runner, objects, calls, inboxDir } = setup(
    t,
    {},
    {
      sleep: async () => {
        if (++looks === 2) objects.pods.get("dh-org-repo-12-abc").status.phase = "Succeeded";
      },
    },
  );
  await runner.start(spec());
  await runner.wait("dh-org-repo-12-abc");
  assert.equal(looks, 2);
  await runner.kill("dh-org-repo-12-abc");
  assert.equal(
    calls.at(-1),
    "DELETE /api/v1/namespaces/runs/pods/dh-org-repo-12-abc?gracePeriodSeconds=10",
  );
  // Gone already: nothing to stop.
  await runner.kill("dh-org-repo-12-abc");
  await runner.remove("dh-org-repo-12-abc", "dh-org-repo-12-abc-1730000000");
  assert.equal(objects.pods.size + objects.secrets.size, 0);
  assert.ok(!existsSync(join(inboxDir, "dh-org-repo-12-abc-1730000000")));
  // The claims stay: the issue's next run goes on from them.
  assert.equal(objects.persistentvolumeclaims.size, 2);
  // A leftover: its Secret is the one its annotation names.
  await runner.start(spec({ run: "r9" }));
  await runner.remove("dh-org-repo-12-abc");
  assert.equal(objects.pods.size + objects.secrets.size, 0);
});

test("hasSession, address and proxyAddresses", async (t) => {
  const slices = [
    {
      endpoints: [
        { addresses: ["10.244.2.3"] },
        { addresses: ["10.244.3.4"], conditions: { ready: false } },
      ],
    },
  ];
  let time = 0;
  const { runner, objects, calls } = setup(t, { slices }, { now: () => time });
  assert.equal(await runner.hasSession("dh-org-repo-12-abc", claude), false);
  await runner.start(spec());
  assert.equal(await runner.hasSession("dh-org-repo-12-abc", claude), true);
  const { uid } = objects.pods.get("dh-org-repo-12-abc").metadata;
  assert.deepEqual(await runner.locate("10.244.1.7"), { sandbox: uid, name: null });
  assert.deepEqual(await runner.proxyAddresses(), ["10.244.2.3", "10.244.3.4"]);
  assert.ok(
    calls.at(-1).endsWith("endpointslices?labelSelector=kubernetes.io%2Fservice-name%3Degress"),
  );
  // Cached, as under Docker; looked up again when asked fresh, a little later.
  const asked = calls.length;
  await runner.proxyAddresses();
  await runner.proxyAddresses({ fresh: true });
  assert.equal(calls.length, asked);
  time = 3000;
  await runner.proxyAddresses({ fresh: true });
  assert.equal(calls.length, asked + 1);
});

test("relink: the Secrets of runs whose pod is gone are removed, the others kept", async (t) => {
  const { runner, objects, logged } = setup(t);
  await runner.start(spec());
  await runner.start(spec({ run: "r2", name: "dh-other" }));
  objects.pods.delete("dh-other");
  objects.secrets.set("unowned", { metadata: { name: "unowned", labels: {} } });
  await runner.relink();
  assert.deepEqual([...objects.secrets.keys()], ["dh-org-repo-12-abc-1730000000-env", "unowned"]);
  assert.ok(logged.some((l) => l.includes("Removing the Secret r2-env")));
});

test("kubeName, labelValue, quantity: Deckhand's names and amounts as Kubernetes takes them", () => {
  assert.equal(kubeName("dh-org-repo-12-abc"), "dh-org-repo-12-abc");
  assert.equal(kubeName("dh.org.repo-12"), "dh.org.repo-12");
  // A dot beside a dash, or two in a row, isn't a subdomain: a repo named .github.
  const subdomain = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;
  for (const name of ["deckhand-acme-.github-12-ab12cd", "a..b", "a.-b", ".git_hooks", "x."]) {
    const made = kubeName(name);
    assert.match(made, subdomain, name);
    assert.match(made, /-[0-9a-f]{10}$/, name);
  }
  assert.match(kubeName("deckhand-acme-.github-12-ab12cd"), /^deckhand-acme-github-12-ab12cd-/);
  const odd = kubeName("dh-my_org-repo-12");
  assert.match(odd, /^dh-my-org-repo-12-[0-9a-f]{10}$/);
  assert.notEqual(odd, kubeName("dh-my-org-repo-12"));
  assert.ok(kubeName("x".repeat(300)).length <= 253);
  assert.equal(labelValue("dh"), "dh");
  assert.match(labelValue("org/repo#12"), /^[0-9a-f]{40}$/);
  assert.match(labelValue("a".repeat(64)), /^[0-9a-f]{40}$/);
  assert.equal(quantity("4g"), "4Gi");
  assert.equal(quantity("512m"), "512Mi");
  assert.equal(quantity("1024k"), "1024Ki");
  assert.equal(quantity("1000"), "1000");
});

test("createKubeApi: the token at each call, the API's message in its errors", async () => {
  let n = 0;
  const seen = [];
  const api = createKubeApi({
    base: "https://kube",
    namespace: NS,
    token: () => `t${++n}`,
    fetch: async (url, init) => {
      seen.push([url, init.headers.authorization]);
      return Response.json({ message: 'pods "x" is forbidden' }, { status: 403 });
    },
  });
  const error = await api.get("pods/x").catch((e) => e);
  assert.ok(error instanceof KubeError);
  assert.equal(error.status, 403);
  assert.equal(error.message, 'GET pods/x: pods "x" is forbidden');
  await api.find("/apis/x", { a: "1", b: undefined }).catch(() => {});
  assert.deepEqual(seen, [
    [`https://kube/api/v1/namespaces/${NS}/pods/x`, "Bearer t1"],
    ["https://kube/apis/x?a=1", "Bearer t2"],
  ]);
});

test("runnerRefusal: what Kubernetes can't run yet, granted, gets a reply naming the runner", () => {
  const grant = { allowDocker: true, allowDockerfile: true };
  const settings = { docker: {}, dockerfile: "Dockerfile" };
  const mounts = [{ source: "/srv", target: "/srv" }];
  const engine = { limits: {}, cache: null };
  // Its capabilities (capabilities.mjs): the repo's image is built with `image:repo`.
  const caps = new Set(["pull", "image:repo"]);
  assert.equal(
    runnerRefusal({ runner: "docker" }, settings, { grant, mounts }, engine, caps),
    null,
  );
  assert.equal(
    runnerRefusal(config, settings, { grant, mounts }, engine, caps),
    "the operator runs sandboxes on the kubernetes runner, which doesn't support a container engine (`docker`), its own image (`dockerfile`) without a registry (`KUBERNETES_REGISTRY`), host mounts (`mounts`) yet. The repository can remove them from `.deckhand.yaml`, or the operator can run its sandboxes on Docker (`RUNNER=docker`).",
  );
  // No engine for this run (a light run, a fork's, no SANDBOX_ENGINE): it goes without one,
  // as under Docker.
  assert.match(
    runnerRefusal(config, { docker: {}, dockerfile: "D" }, { grant, mounts: [] }, null, caps),
    /support its own image \(`dockerfile`\) without a registry \(`KUBERNETES_REGISTRY`\) yet\. The repository can remove it from/,
  );
  // With a registry, its image is built (kube-images.mjs).
  const registry = { ...config, kubernetes: { ...config.kubernetes, registry: "r.example.com" } };
  assert.equal(
    runnerRefusal(registry, { docker: {}, dockerfile: "D" }, { grant, mounts: [] }, null, caps),
    null,
  );
  // Nor without `image:repo`: the run builds none.
  assert.equal(
    runnerRefusal(config, { dockerfile: "D" }, { grant, mounts: [] }, null, new Set(["pull"])),
    null,
  );
  assert.equal(runnerRefusal(config, { docker: {} }, { grant, mounts: [] }, null), null);
  // With Sysbox's RuntimeClass, the engine runs (#573); Podman's still doesn't.
  const sysbox = { ...config, kubernetes: { ...config.kubernetes, ...ENGINE } };
  assert.equal(runnerRefusal(sysbox, { docker: {} }, { grant, mounts: [] }, engine), null);
  assert.equal(
    runnerRefusal({ ...sysbox, engine: "auto" }, { docker: {} }, { grant, mounts: [] }, engine),
    null,
  );
  assert.match(
    runnerRefusal({ ...sysbox, engine: "podman" }, { docker: {} }, { grant, mounts: [] }, engine),
    /doesn't support a container engine \(`docker`\) yet/,
  );
  assert.equal(runnerRefusal(config, {}, { grant, mounts: [] }, null), null);
  // A `preview` left in the config, from before #574: ignored, so not refused for it.
  const { settings: left } = parseRepoConfig("preview: ./preview.sh\n", config);
  assert.equal(runnerRefusal(config, left, { grant, mounts: [] }, null), null);
});

test("state and follow: an API that errs for a while is asked again, a run at work goes on", async (t) => {
  let failures = 0;
  const { runner, logged, clock } = setup(t, {
    logs: { "dh-org-repo-12-abc": ["\x1estill here\n"] },
    fail: ({ method, path }) =>
      method === "GET" && path.endsWith("/pods/dh-org-repo-12-abc") && failures-- > 0
        ? Response.json({ message: "etcdserver: leader changed" }, { status: 500 })
        : null,
  });
  await runner.start(spec());
  failures = 3;
  assert.equal(await runner.state("dh-org-repo-12-abc"), "running");
  assert.equal(logged.filter((l) => /leader changed \(asked again in/.test(l)).length, 3);
  failures = 2;
  const err = [];
  await runner.follow("dh-org-repo-12-abc", { onOut: () => {}, onErr: (l) => err.push(l) });
  assert.deepEqual(err, ["still here"]);
  // Past API_RETRY_MS, it says so.
  failures = Infinity;
  const before = clock.at;
  await assert.rejects(runner.state("dh-org-repo-12-abc"), /leader changed/);
  assert.ok(clock.at - before >= 60_000);
});

test("state and wait: a pod its node lost is force-deleted and counts as gone", async (t) => {
  const { runner, objects, calls, clock } = setup(t);
  const force = "DELETE /api/v1/namespaces/runs/pods/dh-org-repo-12-abc?gracePeriodSeconds=0";
  await runner.start(spec());
  const pod = objects.pods.get("dh-org-repo-12-abc");
  // Deleted, its grace not long past: still running, as it may still be stopping.
  pod.metadata.deletionTimestamp = new Date(clock.at - 60_000).toISOString();
  assert.equal(await runner.state("dh-org-repo-12-abc"), "running");
  pod.metadata.deletionTimestamp = new Date(clock.at - 2 * 60_000).toISOString();
  assert.equal(await runner.state("dh-org-repo-12-abc"), null);
  assert.equal(calls.at(-1), force);
  assert.equal(objects.pods.size, 0);
  // Unknown: lost once its node said nothing for 5 min; wait() returns then.
  await runner.remove("dh-org-repo-12-abc", "dh-org-repo-12-abc-1730000000");
  await runner.start(spec());
  const unknown = objects.pods.get("dh-org-repo-12-abc");
  const since = new Date(clock.at).toISOString();
  unknown.status = { phase: "Unknown", conditions: [{ type: "Ready", lastTransitionTime: since }] };
  assert.equal(await runner.state("dh-org-repo-12-abc"), "running");
  await runner.wait("dh-org-repo-12-abc");
  assert.ok(clock.at - Date.parse(since) >= 5 * 60_000);
  assert.equal(calls.at(-1), force);
});

test("remove: a pod still running gets its grace, an exited one goes at once", async (t) => {
  const { runner, objects, calls } = setup(t);
  await runner.start(spec());
  await runner.remove("dh-org-repo-12-abc", "dh-org-repo-12-abc-1730000000");
  assert.ok(
    calls.includes("DELETE /api/v1/namespaces/runs/pods/dh-org-repo-12-abc?gracePeriodSeconds=10"),
  );
  await runner.start(spec());
  objects.pods.get("dh-org-repo-12-abc").status.phase = "Succeeded";
  await runner.remove("dh-org-repo-12-abc", "dh-org-repo-12-abc-1730000000");
  assert.ok(
    calls.includes("DELETE /api/v1/namespaces/runs/pods/dh-org-repo-12-abc?gracePeriodSeconds=0"),
  );
});

// What an API that never answers does: nothing, until the request's signal aborts.
const never = (signal) =>
  new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason)));

test("state: a call the API never answers times out, and is asked again", async (t) => {
  let hangs = 0;
  const { runner, logged } = setup(t, {
    timeoutMs: 20,
    fail: ({ method, path, signal }) =>
      method === "GET" && path.endsWith("/pods/dh-org-repo-12-abc") && hangs-- > 0
        ? never(signal)
        : null,
  });
  await runner.start(spec());
  hangs = 2;
  assert.equal(await runner.state("dh-org-repo-12-abc"), "running");
  assert.equal(
    logged.filter((l) => l.includes("GET pods/dh-org-repo-12-abc: no answer in 0.02 s")).length,
    2,
  );
});

test("follow: a log stream that outlives its pod is let go, the rest of the log read", async (t) => {
  const encode = (text) => new TextEncoder().encode(text);
  const fake = {};
  const logs = {
    "dh-org-repo-12-abc": ({ follow, signal }) => {
      if (!follow) return new Response("\x1eone\n\x1etwo\n");
      // The first line, then nothing, the connection never closed: the pod exits meanwhile.
      return new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(encode("\x1eone\n"));
            fake.pod.status.phase = "Succeeded";
            signal.addEventListener("abort", () => c.error(signal.reason));
          },
        }),
      );
    },
  };
  const fakes = fakeApi({ logs });
  const logged = [];
  const runner = createKubernetesRunner({
    config,
    api: fakes.api,
    inboxDir: tempDir(t),
    log: (line) => logged.push(line),
    sleep: async () => {},
    watchMs: 5,
    probe: ENFORCED,
  });
  await runner.start(spec());
  fake.pod = fakes.objects.pods.get("dh-org-repo-12-abc");
  const err = [];
  await runner.follow("dh-org-repo-12-abc", { onOut: () => {}, onErr: (l) => err.push(l) });
  assert.deepEqual(err, ["one", "two"]);
  assert.ok(logged.some((l) => /its stream outlived the pod, reading the rest/.test(l)));
});

test("remove: never a pod or a Secret of the namespace that isn't this deployment's run's", async (t) => {
  const { runner, objects } = setup(t);
  // The namespace's own: a pod named like a sandbox, a Secret named like a run's.
  objects.pods.set("myapp", { metadata: { name: "myapp", labels: { app: "myapp" } }, status: {} });
  objects.secrets.set("myapp-1-env", { metadata: { name: "myapp-1-env", labels: {} } });
  await runner.remove("myapp", "myapp-1");
  assert.ok(objects.pods.has("myapp"));
  assert.ok(objects.secrets.has("myapp-1-env"));
  // Its own, as before.
  await runner.start(spec());
  await runner.remove("dh-org-repo-12-abc", "dh-org-repo-12-abc-1730000000");
  assert.equal(objects.pods.has("dh-org-repo-12-abc"), false);
  assert.equal(objects.secrets.has("dh-org-repo-12-abc-1730000000-env"), false);
});

// The network probe (kube-probe.mjs): its pods (one name each), and what the cluster around it
// has.
const isProbe = (pod) => Boolean(pod?.metadata?.annotations?.["deckhand.probe"]);
const probeIn = (objects) => [...objects.pods.values()].find(isProbe);
const CLUSTER_SERVICES = {
  broker: {
    metadata: { name: "broker" },
    spec: { clusterIP: "10.96.0.20", ports: [{ port: 8081, protocol: "TCP" }] },
  },
  egress: {
    metadata: { name: "egress" },
    spec: {
      clusterIP: "10.96.0.11",
      selector: { app: "deckhand-egress" },
      ports: [{ port: 3128 }],
    },
  },
};
const CLUSTER_SLICES = [
  {
    metadata: { labels: { "kubernetes.io/service-name": "broker" } },
    endpoints: [{ addresses: [] }, { addresses: ["10.244.2.5"] }],
    ports: [{ port: 8081, protocol: "TCP" }],
  },
  {
    metadata: { labels: { "kubernetes.io/service-name": "egress" } },
    endpoints: [{ addresses: ["10.244.3.9"] }],
    ports: [{ port: 3128, protocol: "TCP" }],
  },
];
const PROXY = "10.96.0.11:3128";

// A runner whose network probe answers `reach(target)` for each of its targets ("host:port",
// "/udp" after a UDP one), its pod ending `phase` (null: never). `targets()`: what the last
// probe pod was asked to try; `probes()`: how many were made; `answers.reach` may change.
// `gate`: { exitCode, said } when its network gate (kube-gate.mjs) ended so, past its deadline.
// `services`, `slices`: the services' namespace's, by default CLUSTER_SERVICES' and CLUSTER_SLICES.
function probed(
  t,
  {
    reach = (target) => target === PROXY,
    phase = "Succeeded",
    kubernetes,
    services = CLUSTER_SERVICES,
    slices = CLUSTER_SLICES,
    gate = null,
    metrics = null,
  } = {},
) {
  const answers = { reach };
  // Whatever the probe pod's name, its log is what it would print.
  const logs = new Proxy(
    {},
    {
      get: (_, name) =>
        String(name).startsWith("dh-network-probe-")
          ? ({ container }) =>
              new Response(
                container === "network-gate"
                  ? `${gate.said}\n`
                  : `${JSON.stringify(asked(s.objects.pods.get(name)).map((t) => answers.reach(t)))}\n`,
              )
          : undefined,
    },
  );
  const policies = [structuredClone(POLICY)];
  const env = {
    KUBERNETES_SERVICE_HOST: "10.96.0.1",
    KUBERNETES_SERVICE_PORT: "443",
    STORE_URL: "redis://redis.data:6379",
  };
  const looked = [];
  const lookup = async (host) => (looked.push(host), [{ address: `10.0.9.${looked.length}` }]);
  const asked = (pod) =>
    JSON.parse(pod.spec.containers[0].command[3]).map(
      ({ host, port, proto }) => `${host}:${port}${proto === "udp" ? "/udp" : ""}`,
    );
  const s = setup(
    t,
    { policies, slices, logs },
    {
      kubernetes,
      metrics,
      probeOptions: {
        env,
        lookup,
        resolvConf: () => "search svc.cluster.local\nnameserver 10.96.0.10\n",
        sleep: async (ms) => {
          s.clock.at += ms;
          for (const pod of s.objects.pods.values()) {
            if (!isProbe(pod)) continue;
            if (gate) {
              pod.status = {
                phase: "Failed",
                initContainerStatuses: [
                  { name: "network-gate", state: { terminated: { exitCode: gate.exitCode } } },
                ],
              };
            } else if (phase) pod.status = { phase };
          }
        },
      },
    },
  );
  for (const [name, svc] of Object.entries(services)) s.objects.services.set(name, svc);
  const made = () => s.bodies.filter(isProbe);
  return {
    ...s,
    answers,
    policies,
    looked,
    probes: () => made().length,
    targets: () => asked(made().at(-1)),
    probePod: () => made().at(-1),
  };
}

test("network probe: reaching the egress proxy alone, runs start; the verdict kept until the policies change or the lease", async (t) => {
  const p = probed(t, {
    kubernetes: {
      registry: "registry.example.com:5000/deckhand",
      buildkit: "tcp://buildkitd:1234",
    },
  });
  await p.runner.start(spec());
  assert.ok(p.objects.pods.has("dh-org-repo-12-abc"));
  assert.ok(!probeIn(p.objects), "the probe pod is removed");
  assert.match(p.probePod().metadata.name, /^dh-network-probe-[0-9a-f]{8}$/);
  assert.deepEqual(p.targets(), [
    PROXY,
    "10.96.0.20:8081",
    "10.244.2.5:8081",
    "10.0.9.1:5000",
    "10.0.9.2:1234",
    "10.0.9.3:6379",
    "10.96.0.10:53",
    "10.96.0.10:53/udp",
    "10.96.0.1:443",
    "1.1.1.1:443",
  ]);
  // The registry's host, BuildKit's (with a registry) and Redis's, as the runner resolves them.
  assert.deepEqual(p.looked, ["registry.example.com", "buildkitd", "redis.data"]);
  assert.match(p.logged.join("\n"), /Network probe: a sandbox reaches the egress proxy alone/);
  await p.runner.start(spec({ run: "dh-org-repo-12-abc-2", name: "dh-org-repo-13-abc" }));
  assert.equal(p.probes(), 1);
  p.policies[0].metadata.resourceVersion = "2";
  await p.runner.start(spec({ run: "dh-org-repo-12-abc-3", name: "dh-org-repo-14-abc" }));
  assert.equal(p.probes(), 2);
  // A new lease probes at once, before any run.
  p.runner.leased();
  await p.runner.start(spec({ run: "dh-org-repo-12-abc-4", name: "dh-org-repo-15-abc" }));
  assert.equal(p.probes(), 3);
  // Labelled as a sandbox, it is none: never listed nor located.
  const { name } = p.probePod().metadata;
  p.objects.pods.set(name, { ...p.probePod(), status: { phase: "Running", podIP: "10.244.1.99" } });
  assert.ok(!(await p.runner.list()).some((s) => s.name === name));
  assert.equal(await p.runner.locate("10.244.1.99"), null);
});

test("network probe: a service, Redis, the registry, the cluster's DNS, the API server or the internet reached refuses runs, saying which", async (t) => {
  const cases = {
    "10.96.0.20:8081": /reached the Service broker \(10\.96\.0\.20:8081\)/,
    "10.244.2.5:8081": /reached a pod of the Service broker \(10\.244\.2\.5:8081\)/,
    "10.0.9.1:5000": /reached the registry \(registry\.example\.com\) \(10\.0\.9\.1:5000\)/,
    "10.0.9.3:6379": /reached Redis \(redis\.data\) \(10\.0\.9\.3:6379\)/,
    "10.96.0.10:53/udp": /reached the cluster's DNS \(10\.96\.0\.10:53\/udp\)/,
    "10.96.0.1:443": /reached the Kubernetes API server \(10\.96\.0\.1:443\)/,
    "1.1.1.1:443": /reached a public address \(1\.1\.1\.1:443\)/,
  };
  for (const [leak, said] of Object.entries(cases)) {
    const p = probed(t, {
      reach: (target) => target === PROXY || target === leak,
      kubernetes: {
        registry: "registry.example.com:5000/deckhand",
        buildkit: "tcp://buildkitd:1234",
      },
    });
    await assert.rejects(p.runner.start(spec()), (error) => {
      assert.match(error.message, /the cluster doesn't enforce the sandboxes' NetworkPolicies/);
      assert.match(error.message, said);
      assert.match(error.message, /Calico and Cilium do/);
      return true;
    });
    assert.equal(p.objects.pods.size + p.objects.secrets.size, 0, leak);
    // Kept: the next run is refused without another probe.
    await assert.rejects(p.runner.start(spec()), said);
    assert.equal(p.probes(), 1);
    assert.match(p.logged.join("\n"), /Network probe: runs refused/);
  }
});

// The metrics port (9464) the manifests give every Service, the egress proxy's too
// (deploy/kubernetes, #653): the monitoring namespace's alone, so a sandbox reaching it is a leak.
test("network probe: every Service's metrics port, the egress proxy's too, is tried, and reaching it refuses runs", async (t) => {
  const metrics = { name: "metrics", port: 9464, protocol: "TCP" };
  const services = structuredClone(CLUSTER_SERVICES);
  const slices = structuredClone(CLUSTER_SLICES);
  for (const { spec } of Object.values(services)) spec.ports.push(metrics);
  for (const slice of slices) slice.ports.push(metrics);
  const p = probed(t, { services, slices });
  await p.runner.start(spec());
  const tried = p.targets();
  for (const target of [
    "10.96.0.20:9464",
    "10.244.2.5:9464",
    "10.96.0.11:9464",
    "10.244.3.9:9464",
  ]) {
    assert.ok(tried.includes(target), target);
  }
  // The proxy's own port alone may be reached: its pod's 3128 isn't a target, its 9464 is.
  assert.ok(!tried.includes("10.244.3.9:3128"));
  const leaky = probed(t, {
    services,
    slices,
    reach: (target) => target === PROXY || target === "10.244.3.9:9464",
  });
  await assert.rejects(
    leaky.runner.start(spec()),
    /reached a pod of the Service egress \(10\.244\.3\.9:9464\)/,
  );
});

test("network probe: a pod that can't reach the egress proxy proves nothing: that run is refused, the next probes again", async (t) => {
  // No network at all, or a proxy not ready yet (a fresh install, an evicted pod).
  const p = probed(t, { reach: () => false });
  await assert.rejects(
    p.runner.start(spec()),
    /couldn't check that the cluster enforces the sandboxes' NetworkPolicies: its probe pod couldn't reach the egress proxy \(10\.96\.0\.11:3128\), which sandboxes go out through/,
  );
  assert.equal(p.objects.pods.size, 0);
  // The proxy back: the next run probes again, and starts.
  p.answers.reach = (target) => target === PROXY;
  await p.runner.start(spec());
  assert.equal(p.probes(), 2);
  assert.ok(p.objects.pods.has("dh-org-repo-12-abc"));
  // A leak with the proxy missed is a leak all the same: kept.
  const leaky = probed(t, { reach: (target) => target === "1.1.1.1:443" });
  await assert.rejects(leaky.runner.start(spec()), /reached a public address/);
  await assert.rejects(leaky.runner.start(spec()), /reached a public address/);
  assert.equal(leaky.probes(), 1);
});

test("network probe: its pod's network gate first, the probe's targets tried once its policies apply", async (t) => {
  const p = probed(t);
  await p.runner.start(spec());
  const [gate] = p.probePod().spec.initContainers;
  assert.equal(gate.name, "network-gate");
  assert.deepEqual(JSON.parse(gate.command[3]), [
    { what: "the Kubernetes API server", host: "10.96.0.1", port: 443, reach: false },
    { what: "the cluster's DNS", host: "10.96.0.10", port: 53, reach: false },
    { what: "the egress proxy", host: "10.96.0.11", port: 3128, reach: true },
  ]);
});

test("network probe: a gate that still reached the API server or the DNS past its deadline is a verdict: runs refused", async (t) => {
  const p = probed(t, {
    gate: { exitCode: 3, said: "still reached the cluster's DNS (10.96.0.10:53) after 600 s" },
  });
  const said =
    /the cluster doesn't enforce the sandboxes' NetworkPolicies: a pod labelled as a sandbox still reached the cluster's DNS \(10\.96\.0\.10:53\) after 600 s: does the network plugin enforce NetworkPolicies\?/;
  await assert.rejects(p.runner.start(spec()), said);
  assert.ok(!probeIn(p.objects), "the probe pod is removed");
  // Kept, as any verdict.
  await assert.rejects(p.runner.start(spec()), said);
  assert.equal(p.probes(), 1);
});

test("network probe: a gate that never reached the egress proxy proves nothing: that run is refused, the next probes again", async (t) => {
  const p = probed(t, {
    gate: { exitCode: 4, said: "never reached the egress proxy (10.96.0.11:3128) in 600 s" },
  });
  await assert.rejects(
    p.runner.start(spec()),
    /couldn't check that the cluster enforces the sandboxes' NetworkPolicies: its probe pod never reached the egress proxy \(10\.96\.0\.11:3128\) in 600 s, which sandboxes go out through/,
  );
  await assert.rejects(p.runner.start(spec()), /its probe pod never reached the egress proxy/);
  assert.equal(p.probes(), 2, "not kept: probed again");
});

test("network probe: a leftover older than any probe is removed, a younger one (the other copy's, mid-handover) left alone", async (t) => {
  const p = probed(t);
  const left = (name, at) =>
    p.objects.pods.set(name, {
      metadata: {
        name,
        creationTimestamp: new Date(at).toISOString(),
        labels: {
          "deckhand.owner": "dh",
          "deckhand.run": "network-probe",
          "deckhand.role": "sandbox",
        },
        annotations: { "deckhand.probe": "network" },
      },
      status: { phase: "Running" },
    });
  left("dh-network-probe-old", p.clock.at - 60 * 60_000);
  left("dh-network-probe-other", p.clock.at - 1000);
  await p.runner.start(spec());
  assert.ok(!p.objects.pods.has("dh-network-probe-old"));
  assert.ok(p.objects.pods.has("dh-network-probe-other"));
});

test("network probe: a probe pod that fails or never ends refuses the run, is removed, and is tried again", async (t) => {
  const failed = probed(t, { phase: "Failed" });
  await assert.rejects(
    failed.runner.start(spec()),
    /couldn't check that the cluster enforces the sandboxes' NetworkPolicies: its probe pod ended Failed/,
  );
  assert.ok(!probeIn(failed.objects));
  await assert.rejects(failed.runner.start(spec()), /its probe pod ended Failed/);
  assert.equal(failed.probes(), 2, "not kept: probed again");

  const stuck = probed(t, { phase: null, kubernetes: { pendingMs: 60_000 } });
  await assert.rejects(
    stuck.runner.start(spec()),
    /its probe pod didn't end within 2 min \(Running\)/,
  );
  assert.equal(stuck.objects.pods.size, 0);
  await assert.rejects(stuck.runner.start(spec()), /its probe pod didn't end/);
  assert.equal(stuck.probes(), 2, "not kept: probed again");
});

test("network probe: its pod is labelled as a sandbox, meets Pod Security restricted, and holds nothing", async (t) => {
  const p = probed(t);
  await p.runner.start(spec());
  const pod = p.probePod();
  assert.deepEqual(pod.metadata.labels, {
    "deckhand.owner": "dh",
    "deckhand.run": "network-probe",
    "deckhand.role": "sandbox",
  });
  assert.equal(isolationProblem([POLICY], pod.metadata.labels), null);
  assert.deepEqual(restrictedProblems(pod), []);
  const { spec: podSpec_ } = pod;
  assert.equal(podSpec_.automountServiceAccountToken, false);
  assert.equal(podSpec_.enableServiceLinks, false);
  assert.equal(podSpec_.restartPolicy, "Never");
  assert.equal(podSpec_.dnsPolicy, "None");
  assert.equal(podSpec_.volumes, undefined);
  assert.deepEqual(podSpec_.securityContext, {
    runAsNonRoot: true,
    runAsUser: SANDBOX_USER.uid,
    runAsGroup: SANDBOX_USER.gid,
    seccompProfile: { type: "RuntimeDefault" },
  });
  const [container] = podSpec_.containers;
  assert.equal(container.image, "dh-sandbox");
  assert.equal(container.envFrom, undefined);
  assert.equal(container.env, undefined);
  assert.deepEqual(container.securityContext, {
    allowPrivilegeEscalation: false,
    capabilities: { drop: ["ALL"] },
    runAsNonRoot: true,
    seccompProfile: { type: "RuntimeDefault" },
  });
  assert.deepEqual(container.command.slice(0, 2), ["node", "-e"]);
});

test("network probe, with an engine: the proxy's engines' port is the proxy's, to be reached when its Service publishes it", async (t) => {
  const egress = structuredClone(CLUSTER_SERVICES.egress);
  egress.spec.ports = [{ port: 3128 }, { port: 3129 }];
  const slices = structuredClone(CLUSTER_SLICES);
  slices[1].ports = [{ port: 3128 }, { port: 3129 }];
  const both = (target) => ["10.96.0.11:3128", "10.96.0.11:3129"].includes(target);
  const p = probed(t, {
    reach: both,
    kubernetes: ENGINE,
    services: { ...CLUSTER_SERVICES, egress },
    slices,
  });
  await p.runner.start(spec());
  const tried = p.targets();
  assert.deepEqual(tried.slice(0, 2), ["10.96.0.11:3128", "10.96.0.11:3129"]);
  // Neither port of the proxy's pods is a leak; the broker's still are.
  assert.ok(!tried.some((target) => target.startsWith("10.244.3.9:")));
  assert.ok(tried.includes("10.244.2.5:8081"));
  // Its Service without 3129: the port isn't tried (engine runs are refused before, saying so).
  const without = probed(t, { kubernetes: ENGINE });
  await without.runner.start(spec());
  assert.ok(!without.targets().some((target) => target.endsWith(":3129")));
  // Without the engine's settings, 3129 on the proxy's Service must be out of reach.
  const off = probed(t, { reach: both, services: { ...CLUSTER_SERVICES, egress }, slices });
  await assert.rejects(
    off.runner.start(spec()),
    /reached the Service egress \(10\.96\.0\.11:3129\)/,
  );
});

// The runner's metrics' hooks (../runner/metrics.mjs), recorded.
function recordedMetrics() {
  const seen = { started: [], failed: [], probed: [] };
  return {
    seen,
    started: (seconds) => seen.started.push(seconds),
    failedToStart: (reason) => seen.failed.push(reason),
    probed: (result, seconds) => seen.probed.push([result, seconds]),
  };
}

test("metrics: a start timed until its pod leaves Pending, once; another copy's pod isn't timed", async (t) => {
  const metrics = recordedMetrics();
  const fake = {};
  const { runner, objects } = setup(
    t,
    { logs: { "dh-org-repo-12-abc": ["\x1estarted\n"] } },
    {
      metrics,
      sleep: async () => {
        fake.pod.status.phase = "Running";
      },
    },
  );
  await runner.start(spec());
  fake.pod = objects.pods.get("dh-org-repo-12-abc");
  fake.pod.status.phase = "Pending";
  const follow = () => runner.follow("dh-org-repo-12-abc", { onOut: () => {}, onErr: () => {} });
  await follow();
  // One poll of the pod (2 s on the test's clock), asked to running.
  assert.deepEqual(metrics.seen.started, [2]);
  await follow();
  assert.deepEqual(metrics.seen.started, [2]);
  const other = setup(t, { logs: { "dh-org-repo-12-abc": [] } }, { metrics });
  other.objects.pods.set("dh-org-repo-12-abc", { ...fake.pod, status: { phase: "Running" } });
  await other.runner.follow("dh-org-repo-12-abc", { onOut: () => {}, onErr: () => {} });
  assert.deepEqual(metrics.seen.started, [2]);
  assert.deepEqual(metrics.seen.failed, []);
});

test("metrics: a pod Pending past the wait counts as failed to start, by why", async (t) => {
  const metrics = recordedMetrics();
  const cases = {
    unschedulable: {
      phase: "Pending",
      conditions: [{ type: "PodScheduled", status: "False", reason: "Unschedulable" }],
    },
    image_pull: {
      phase: "Pending",
      containerStatuses: [{ state: { waiting: { reason: "ImagePullBackOff" } } }],
    },
    pending: { phase: "Pending" },
  };
  for (const status of Object.values(cases)) {
    const { runner, objects } = setup(t, {}, { metrics });
    await runner.start(spec());
    const pod = objects.pods.get("dh-org-repo-12-abc");
    pod.metadata.creationTimestamp = "2026-10-30T09:50:00Z"; // 10 min before now()
    pod.status = status;
    await assert.rejects(
      runner.follow("dh-org-repo-12-abc", { onOut: () => {}, onErr: () => {} }),
      RunError,
    );
  }
  assert.deepEqual(metrics.seen.failed, Object.keys(cases));
  assert.deepEqual(metrics.seen.started, []);
});

test("pendingFailure: an agent's install, the gate, an image, no node, else pending", () => {
  const pod = (status) => ({ status });
  assert.equal(pendingFailure(pod({}), INSTALLING), "agent_install");
  const pull = { initContainerStatuses: [{ state: { waiting: { reason: "ErrImagePull" } } }] };
  assert.equal(pendingFailure(pod(pull), "ErrImagePull: denied"), "image_pull");
  const invalid = { containerStatuses: [{ state: { waiting: { reason: "InvalidImageName" } } }] };
  assert.equal(pendingFailure(pod(invalid), "x"), "image_pull");
  const unscheduled = { conditions: [{ type: "PodScheduled", status: "False" }] };
  assert.equal(pendingFailure(pod(unscheduled), "0/3 nodes"), "unschedulable");
  assert.equal(pendingFailure(pod({}), "FailedMount: …"), "pending");
});

test("metrics: the network probe's verdicts, and a start it refuses says not_isolated", async (t) => {
  const metrics = recordedMetrics();
  const p = probed(t, { metrics });
  await p.runner.start(spec());
  assert.deepEqual(
    metrics.seen.probed.map(([result]) => result),
    ["isolated"],
  );
  assert.ok(metrics.seen.probed[0][1] >= 0);
  const leaky = probed(t, { reach: () => true, metrics });
  await assert.rejects(leaky.runner.start(spec()), (error) => error.reason === "not_isolated");
  const blind = probed(t, { reach: () => false, metrics });
  await assert.rejects(blind.runner.start(spec()), (error) => error.reason === "isolation_unknown");
  assert.deepEqual(
    metrics.seen.probed.map(([result]) => result),
    ["isolated", "reached", "unknown"],
  );
});

test("metrics: a namespace without the sandboxes' NetworkPolicy refuses a start as not_isolated", async (t) => {
  const { runner } = setup(t, { policies: [] });
  await assert.rejects(runner.start(spec()), (error) => error.reason === "not_isolated");
});

test("metrics: a failed gate or install counts once, however often its pod is followed", async (t) => {
  const cases = { network_gate: "network-gate", agent_install: "agent-install" };
  for (const [reason, container] of Object.entries(cases)) {
    const metrics = recordedMetrics();
    const { runner, objects } = setup(
      t,
      { logs: { "dh-org-repo-12-abc": ["said\n"] } },
      { metrics },
    );
    await runner.start(spec({ volumes: [agentVolume, ...spec().volumes.slice(1)] }));
    objects.pods.get("dh-org-repo-12-abc").status = {
      phase: "Failed",
      initContainerStatuses: [{ name: container, state: { terminated: { exitCode: 3 } } }],
    };
    const follow = () => runner.follow("dh-org-repo-12-abc", { onOut: () => {}, onErr: () => {} });
    await assert.rejects(follow(), RunError);
    await assert.rejects(follow(), RunError);
    assert.deepEqual(metrics.seen.failed, [reason]);
    assert.deepEqual(metrics.seen.started, []);
  }
});

test("metrics: the same name's next pod isn't timed from this copy's older start, nor after a lease taken again", async (t) => {
  const metrics = recordedMetrics();
  const { runner, objects } = setup(t, { logs: { "dh-org-repo-12-abc": [] } }, { metrics });
  const follow = () => runner.follow("dh-org-repo-12-abc", { onOut: () => {}, onErr: () => {} });
  await runner.start(spec());
  // Another copy removed it and started the issue's next run under the same name.
  const pod = objects.pods.get("dh-org-repo-12-abc");
  objects.pods.set("dh-org-repo-12-abc", {
    ...pod,
    metadata: { ...pod.metadata, uid: "another-copy's" },
    status: { phase: "Running" },
  });
  await follow();
  assert.deepEqual(metrics.seen.started, []);
  // Taking the lease again forgets what it timed.
  objects.pods.clear();
  await runner.start(spec({ run: "dh-org-repo-12-abc-2" }));
  runner.leased();
  objects.pods.get("dh-org-repo-12-abc").status = { phase: "Running" };
  await follow();
  assert.deepEqual(metrics.seen.started, []);
});
