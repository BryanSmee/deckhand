// The Kubernetes runner, against a fake of the API that keeps what it is sent: the Pod, Secret
// and claims a run gets (and loses when its start fails), the NetworkPolicy check, the
// Pending timeout, its log followed with `skip`, and what the listener asks of it otherwise.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { RunError, runnerRefusal } from "../listener/access.mjs";
import { claude } from "../listener/agents/claude.mjs";
import { apiBase, createKubeApi, KubeError } from "../listener/runner/kube-api.mjs";
import {
  createKubernetesRunner,
  INSTALL_USER,
  INSTALLING,
  isolationProblem,
  kubeName,
  labelValue,
  latestWarning,
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
  brokerUrl: "http://listener:8081",
  egressProxy: "http://egress:3128",
  kubernetes: { pendingMs: 600000, storageClass: "fast", sessionSize: "10Gi" },
};

// Deckhand's policy, as docs/setup.md shows it.
const POLICY = {
  metadata: { name: "deckhand-sandboxes" },
  spec: {
    podSelector: { matchLabels: { "deckhand.role": "sandbox" } },
    policyTypes: ["Ingress", "Egress"],
    egress: [
      { to: [{ podSelector: { matchLabels: { app: "egress" } } }], ports: [{ port: 3128 }] },
      { to: [{ podSelector: { matchLabels: { app: "listener" } } }], ports: [{ port: 8081 }] },
    ],
  },
};

const SERVICES = {
  listener: { metadata: { name: "listener" }, spec: { clusterIP: "10.96.0.10" } },
  egress: { metadata: { name: "egress" }, spec: { clusterIP: "10.96.0.11" } },
};

// A namespace's API: `objects` by resource then name; `logs` a pod's log, chunks of text;
// `fail(call)` answers a call instead (a Response), when it does. Every call is in `calls`
// as "METHOD path?query", the bodies sent in `bodies`.
// `fail` gets the request's `signal`, and may answer a promise that only it ends (an API that
// never answers); a pod's log may be a function of { follow, signal } giving a Response.
// `timeoutMs`: createKubeApi()'s.
function fakeApi({
  policies = [POLICY],
  logs = {},
  slices = [],
  fail = () => null,
  timeoutMs,
} = {}) {
  const objects = {
    pods: new Map(),
    secrets: new Map(),
    persistentvolumeclaims: new Map(),
    services: new Map(Object.entries(SERVICES)),
    events: new Map(),
  };
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
    if (pathname === `/apis/discovery.k8s.io/v1/namespaces/${NS}/endpointslices`) {
      return Response.json({ items: slices });
    }
    const [, kind, name, sub] =
      pathname.match(new RegExp(`^/api/v1/namespaces/${NS}/(\\w+)(?:/([^/]+))?(?:/(\\w+))?$`)) ??
      [];
    const store = objects[kind];
    if (!store) return new Response("no such route", { status: 404 });
    const missing = () =>
      Response.json({ message: `${kind} "${name}" not found` }, { status: 404 });
    if (sub === "log") {
      if (!store.has(name)) return missing();
      if (typeof logs[name] === "function") {
        return logs[name]({ follow: searchParams.get("follow") === "true", signal: init.signal });
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
          ...body.metadata,
        },
        status: kind === "pods" ? { phase: "Running", podIPs: [{ ip: "10.244.1.7" }] } : {},
      };
      store.set(body.metadata.name, made);
      return Response.json(made, { status: 201 });
    }
    if (method === "DELETE") {
      if (!store.delete(name)) return missing();
      return Response.json({ kind: "Status" });
    }
    if (name) return store.has(name) ? Response.json(store.get(name)) : missing();
    const selector = searchParams.get("labelSelector");
    return Response.json({ items: [...store.values()].filter((o) => matches(o, selector)) });
  };
  const api = createKubeApi({
    fetch,
    base: "https://kube",
    token: () => "token-1",
    namespace: NS,
    timeoutMs,
  });
  return { api, calls, bodies, objects };
}

// `now`: a clock of the test's own, else one that the runner's sleep() moves forward (its
// retries and polls take time); `sleep(ms)` is called too.
// `kubernetes`: more of config.kubernetes.
function setup(t, options = {}, { now, sleep = async () => {}, kubernetes = {} } = {}) {
  const fake = fakeApi(options);
  const logged = [];
  const inboxDir = tempDir(t);
  const clock = { at: Date.parse("2026-10-30T10:00:00Z") };
  const runner = createKubernetesRunner({
    config: { ...config, kubernetes: { ...config.kubernetes, ...kubernetes } },
    api: fake.api,
    inboxDir,
    log: (line) => logged.push(line),
    now: now ?? (() => clock.at),
    sleep: async (ms) => {
      clock.at += ms;
      await sleep(ms);
    },
  });
  return { ...fake, runner, logged, inboxDir, clock };
}

// What sandboxSpec() gives a work run (sandbox-spec.mjs).
const spec = (over = {}) => ({
  run: "dh-org-repo-12-abc-1730000000",
  name: "dh-org-repo-12-abc",
  image: "dh-sandbox",
  labels: { "deckhand.task": "org/repo#12" },
  env: { DECKHAND_RUN_SECRET: "s3cret", TASK_PROMPT: "do it", SANDBOX_MODEL: undefined },
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
    DECKHAND_RUN_SECRET: "s3cret",
    TASK_PROMPT: "do it",
  });
  assert.equal(secret.metadata.annotations["deckhand.run"], "dh-org-repo-12-abc-1730000000");
  const pod = objects.pods.get("dh-org-repo-12-abc");
  assert.ok(!JSON.stringify(pod).includes("s3cret"));
  const [c] = pod.spec.containers;
  assert.deepEqual(c.envFrom, [{ secretRef: { name: "dh-org-repo-12-abc-1730000000-env" } }]);
  // Where the run's files are: values, from the broker.
  assert.deepEqual(c.env, [
    { name: "TASK_INBOX", value: "http://listener:8081/run/inbox" },
    { name: "DECKHAND_CA", value: "http://listener:8081/run/ca" },
    // Its stderr lines tagged: the pod log has both streams in one.
    { name: "SANDBOX_TAG_STDERR", value: "1" },
  ]);
  assert.deepEqual(pod.spec.hostAliases, [
    { ip: "10.96.0.10", hostnames: ["listener"] },
    { ip: "10.96.0.11", hostnames: ["egress"] },
  ]);
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
    { name: "v1", mountPath: "/workspace" },
    { name: "v2", mountPath: "/home/node/.claude" },
  ]);
  // The session claims, of the operator's class and size; the agent's is not the runner's.
  const claim = objects.persistentvolumeclaims.get("dh-org-repo-12-abc-workspace");
  assert.deepEqual(claim.spec, {
    accessModes: ["ReadWriteOnce"],
    resources: { requests: { storage: "10Gi" } },
    storageClassName: "fast",
  });
  assert.ok(!objects.persistentvolumeclaims.has("dh-claude-code"));
  // The policy checked first, the Pod, then its Secret, last.
  assert.match(calls[0], /networkpolicies$/);
  assert.match(calls.at(-2), /^POST \/api\/v1\/namespaces\/runs\/pods$/);
  assert.match(calls.at(-1), /^POST \/api\/v1\/namespaces\/runs\/secrets$/);
  // The inbox is the listener's: the next run's claims are already there.
  runner.send("dh-org-repo-12-abc-1730000000", "more", claude);
  assert.equal(runner.closed("dh-org-repo-12-abc-1730000000"), false);
  assert.equal((await runner.file("dh-org-repo-12-abc-1730000000", "ca")).toString(), "PEM");
  objects.pods.clear();
  calls.length = 0;
  await runner.start(spec({ run: "dh-org-repo-12-abc-1730000999" }));
  assert.equal(calls.filter((c) => c.startsWith("POST")).length, 2); // Pod, Secret
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
  // An API error keeps what was known: one failed call refuses no sandbox.
  time += 60_000;
  failing = true;
  assert.deepEqual(await runner.locate("10.244.1.7"), { sandbox: uid, name: null });
  assert.equal(failed, 1);
  failing = false;
  // Gone with its pod: an address never names a pod that was removed.
  await runner.remove("dh-org-repo-12-abc", "dh-org-repo-12-abc-1730000000");
  assert.equal(await runner.locate("10.244.1.7"), null);
});

test("start: without the namespace's NetworkPolicy, no run, and the reply says why", async (t) => {
  const { runner, objects } = setup(t, { policies: [] });
  await assert.rejects(
    runner.start(spec()),
    /the namespace runs doesn't isolate its sandboxes: no NetworkPolicy picks the sandbox pods for both Ingress and Egress.*docs\/setup\.md/,
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
    const spec = { ...all, policyTypes: ["Egress"], egress: [{ to: [{ podSelector }] }] };
    assert.equal(isolationProblem(add(spec), labels), null, JSON.stringify(podSelector));
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

test("start: an engine, a host mount or a cache is refused", async (t) => {
  const { runner, objects } = setup(t);
  await assert.rejects(runner.start(spec({ engine: { limits: {} } })), /no container engine/);
  const mount = { kind: "mount", name: "/srv", path: "/srv" };
  await assert.rejects(runner.start(spec({ volumes: [mount] })), /no host path/);
  // A cache only with a class to make its claims of (KUBERNETES_CACHE_STORAGE_CLASS).
  const cache = { kind: "cache", name: "c", path: "/c" };
  await assert.rejects(runner.start(spec({ volumes: [cache] })), /no cache/);
  assert.equal(objects.pods.size + objects.secrets.size, 0);
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
  const [init] = pod.spec.initContainers;
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

test("start: an agent whose claim is there mounts it, no init container", async (t) => {
  const { runner, objects } = setup(t);
  objects.persistentvolumeclaims.set("dh-claude-code", { metadata: { name: "dh-claude-code" } });
  await runner.start(spec({ volumes: [agentVolume, ...spec().volumes.slice(1)] }));
  const pod = objects.pods.get("dh-org-repo-12-abc");
  assert.equal(pod.spec.initContainers, undefined);
  assert.equal(pod.spec.imagePullSecrets, undefined);
  assert.equal(pod.metadata.annotations["deckhand.agent-init"], undefined);
  assert.deepEqual(pod.spec.volumes[0].persistentVolumeClaim, {
    claimName: "dh-claude-code",
    readOnly: true,
  });
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
  await runner.follow("dh-org-repo-12-abc", {
    skip: { out: 1, err: 1 },
    onOut: (line, at) => out.push([line, at]),
    onErr: (line) => err.push(line),
  });
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
  await runner.follow("dh-org-repo-12-abc", {
    skip: { out: 40, err: 2 },
    onOut: () => {},
    onErr: () => {},
  });
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
    pendingReason({ status: { initContainerStatuses: [{ state: { running: {} } }] } }),
    INSTALLING,
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
  assert.equal(await runner.sandboxIdOf("dh-org-repo-12-abc"), uid);
  assert.equal(await runner.sandboxIdOf("dh-gone"), null);
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
  const grant = { allowDocker: true, allowDockerfile: true, allowPreview: true };
  const settings = { docker: {}, dockerfile: "Dockerfile", preview: { command: "x" } };
  const mounts = [{ source: "/srv", target: "/srv" }];
  const engine = { limits: {}, cache: null };
  assert.equal(runnerRefusal({ runner: "docker" }, settings, { grant, mounts }, engine), null);
  assert.equal(
    runnerRefusal(config, settings, { grant, mounts }, engine),
    "the operator runs sandboxes on the kubernetes runner, which doesn't support a container engine (`docker`), its own image (`dockerfile`) without a registry (`KUBERNETES_REGISTRY`), a preview hook (`preview`), host mounts (`mounts`) yet. The repository can remove them from `.deckhand.yaml`, or the operator can run its sandboxes on Docker (`RUNNER=docker`).",
  );
  // No engine for this run (a light run, a fork's, no SANDBOX_ENGINE): it goes without one,
  // as under Docker.
  assert.match(
    runnerRefusal(config, { docker: {}, dockerfile: "D" }, { grant, mounts: [] }, null),
    /support its own image \(`dockerfile`\) without a registry \(`KUBERNETES_REGISTRY`\) yet\. The repository can remove it from/,
  );
  // With a registry, its image is built (kube-images.mjs).
  const registry = { ...config, kubernetes: { ...config.kubernetes, registry: "r.example.com" } };
  assert.equal(
    runnerRefusal(registry, { docker: {}, dockerfile: "D" }, { grant, mounts: [] }, null),
    null,
  );
  assert.equal(runnerRefusal(config, { docker: {} }, { grant, mounts: [] }, null), null);
  assert.equal(runnerRefusal(config, {}, { grant, mounts: [] }, null), null);
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
  });
  await runner.start(spec());
  fake.pod = fakes.objects.pods.get("dh-org-repo-12-abc");
  const err = [];
  await runner.follow("dh-org-repo-12-abc", { onOut: () => {}, onErr: (l) => err.push(l) });
  assert.deepEqual(err, ["one", "two"]);
  assert.ok(logged.some((l) => /its stream outlived the pod, reading the rest/.test(l)));
});
