// The Kubernetes runner, against a fake of the API that keeps what it is sent: the Pod, Secret
// and claims a run gets (and loses when its start fails), the NetworkPolicy check, the
// Pending timeout, its log followed with `skip`, and what the listener asks of it otherwise.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { RunError, runnerRefusal } from "../listener/access.mjs";
import { claude } from "../listener/agents/claude.mjs";
import { createImages } from "../listener/images.mjs";
import { createKubeApi, KubeError } from "../listener/runner/kube-api.mjs";
import {
  createKubernetesImages,
  createKubernetesRunner,
  isolationProblem,
  kubeName,
  labelValue,
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
function fakeApi({ policies = [POLICY], logs = {}, slices = [], fail = () => null } = {}) {
  const objects = {
    pods: new Map(),
    secrets: new Map(),
    persistentvolumeclaims: new Map(),
    services: new Map(Object.entries(SERVICES)),
  };
  const calls = [];
  const bodies = [];
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
    const failed = fail({ method, path: pathname, body });
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
        metadata: { creationTimestamp: new Date(0).toISOString(), ...body.metadata },
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
  const api = createKubeApi({ fetch, base: "https://kube", token: () => "token-1", namespace: NS });
  return { api, calls, bodies, objects };
}

function setup(t, options = {}, { now = () => Date.parse("2026-10-30T10:00:00Z"), sleep } = {}) {
  const fake = fakeApi(options);
  const logged = [];
  const inboxDir = tempDir(t);
  const runner = createKubernetesRunner({
    config,
    api: fake.api,
    inboxDir,
    log: (line) => logged.push(line),
    now,
    sleep: sleep ?? (async () => {}),
  });
  return { ...fake, runner, logged, inboxDir };
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

test("start: a Secret with the run's env, a claim per session volume, then the Pod", async (t) => {
  const { runner, calls, objects } = setup(t);
  assert.deepEqual(await runner.start(spec()), { engine: null });
  const secret = objects.secrets.get("dh-org-repo-12-abc-1730000000-env");
  // Unset values stay unset; the secrets are in the Secret, never in the Pod.
  assert.deepEqual(secret.stringData, { DECKHAND_RUN_SECRET: "s3cret", TASK_PROMPT: "do it" });
  assert.equal(secret.metadata.annotations["deckhand.run"], "dh-org-repo-12-abc-1730000000");
  const pod = objects.pods.get("dh-org-repo-12-abc");
  assert.ok(!JSON.stringify(pod).includes("s3cret"));
  const [c] = pod.spec.containers;
  assert.deepEqual(c.envFrom, [{ secretRef: { name: "dh-org-repo-12-abc-1730000000-env" } }]);
  // Where the run's files are: values, from the broker.
  assert.deepEqual(c.env, [
    { name: "TASK_INBOX", value: "http://listener:8081/run/inbox" },
    { name: "DECKHAND_CA", value: "http://listener:8081/run/ca" },
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
  // The policy checked first, the Pod last.
  assert.match(calls[0], /networkpolicies$/);
  assert.match(calls.at(-1), /^POST \/api\/v1\/namespaces\/runs\/pods$/);
  // The inbox is the listener's: the next run's claims are already there.
  runner.send("dh-org-repo-12-abc-1730000000", "more", claude);
  assert.equal(runner.closed("dh-org-repo-12-abc-1730000000"), false);
  assert.equal((await runner.file("dh-org-repo-12-abc-1730000000", "ca")).toString(), "PEM");
  objects.pods.clear();
  calls.length = 0;
  await runner.start(spec({ run: "dh-org-repo-12-abc-1730000999" }));
  assert.equal(calls.filter((c) => c.startsWith("POST")).length, 2); // Secret, Pod
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
  assert.equal(s.terminationGracePeriodSeconds, 10);
  assert.equal(s.hostNetwork ?? false, false);
  assert.equal(s.hostPID ?? false, false);
  assert.equal(s.hostIPC ?? false, false);
  assert.deepEqual(s.securityContext, {
    runAsNonRoot: true,
    runAsUser: 1000,
    runAsGroup: 1000,
    fsGroup: 1000,
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

test("start: a failure removes the Secret and the claims it made, keeps the older ones", async (t) => {
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
  const cache = { kind: "cache", name: "c", path: "/c" };
  await assert.rejects(runner.start(spec({ volumes: [cache] })), /no cache/);
  assert.equal(objects.pods.size + objects.secrets.size, 0);
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
  const log = [
    `${stamp(1)}Cloning…\n`,
    `${stamp(2)}{"type":"system"}\n${stamp(3)}Setup: npm ci\n`,
    `${stamp(4)}{"type":"assi`,
    `stant"}\n${stamp(5)}{"type":"result"}\n${stamp(6)}half a line`,
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
  assert.deepEqual(err, ["Setup: npm ci"]);
});

test("follow: a line over MAX_LINE is cut; a handler that throws loses its line only", async (t) => {
  const long = "x".repeat(MAX_LINE + 10);
  const { runner, logged } = setup(t, {
    logs: { "dh-org-repo-12-abc": [`${long}\n`, "boom\n", "after\n"] },
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
  assert.deepEqual(err, ["x".repeat(MAX_LINE) + LINE_CUT, "after"]);
  assert.ok(logged.some((l) => l.includes("disk full")));
});

test("follow: a log shorter than what was read (rotated by the kubelet) is logged", async (t) => {
  const { runner, logged } = setup(t, { logs: { "dh-org-repo-12-abc": ["one\n"] } });
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
    { logs: { "dh-org-repo-12-abc": ["started\n"] } },
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

test("pendingReason: an image it can't pull before scheduling, else Kubernetes' silence", () => {
  const waiting = (reason, message) => ({
    status: { containerStatuses: [{ state: { waiting: { reason, message } } }] },
  });
  assert.equal(
    pendingReason(waiting("ImagePullBackOff", 'Back-off pulling image "x"')),
    'ImagePullBackOff: Back-off pulling image "x"',
  );
  assert.equal(pendingReason(waiting("ContainerCreating")), "Kubernetes gave no reason");
  assert.equal(pendingReason({}), "Kubernetes gave no reason");
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
  assert.deepEqual(await runner.address("dh-org-repo-12-abc"), ["10.244.1.7"]);
  objects.pods.get("dh-org-repo-12-abc").status = { phase: "Pending" };
  assert.equal(await runner.address("dh-org-repo-12-abc"), null);
  assert.equal(await runner.address("dh-gone"), null);
  assert.equal(await runner.engineAddress("dh-org-repo-12-abc"), null);
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

test("images on Kubernetes: the base image only; the agent's claim must be there", async () => {
  const claims = new Set();
  const api = { find: async (path) => (claims.has(path.split("/")[1]) ? {} : null) };
  const images = createImages({
    config: { ...config, claudeCodeVolume: "dh-claude-code", claudeCodeVersion: "9.9.9" },
    backend: createKubernetesImages({ config, api }),
    jobs: {},
    readFile: async () => null,
    checkout: async () => null,
  });
  assert.equal(await images.imageFor({ repo: "org/a", ref: "main" }), "dh-sandbox");
  await assert.rejects(
    images.installAgent(claude, () => {}),
    /Claude's volume dh-claude-code is missing: the kubernetes runner doesn't install agents, so Claude 9\.9\.9 has to be installed into it beforehand/,
  );
  claims.add("dh-claude-code");
  await images.installAgent(claude, () => {});
  assert.deepEqual(await images.caches("org/a", ["/c"], "dh-sandbox"), []);
  assert.equal(images.keepsCaches, false);
});

test("runnerRefusal: what Kubernetes can't run yet, granted, gets a reply naming the runner", () => {
  const grant = { allowDocker: true, allowDockerfile: true, allowPreview: true };
  const task = (light = false) => ({ live: { light } });
  const settings = { docker: {}, dockerfile: "Dockerfile", preview: { command: "x" } };
  const mounts = [{ source: "/srv", target: "/srv" }];
  assert.equal(runnerRefusal({ runner: "docker" }, task(), settings, { grant, mounts }), null);
  assert.equal(
    runnerRefusal(config, task(), settings, { grant, mounts }),
    "the operator runs sandboxes on the kubernetes runner, which doesn't support a container engine (`docker`), its own image (`dockerfile`), a preview hook (`preview`), host mounts (`mounts`) yet. The repository can remove them from `.deckhand.yaml`, or the operator can run its sandboxes on Docker (`RUNNER=docker`).",
  );
  // A light run gets no engine anyway; nothing asked, nothing refused.
  assert.match(
    runnerRefusal(config, task(true), { dockerfile: "D" }, { grant, mounts: [] }),
    /support its own image \(`dockerfile`\) yet\. The repository can remove it from/,
  );
  assert.equal(runnerRefusal(config, task(true), { docker: {} }, { grant, mounts: [] }), null);
  assert.equal(runnerRefusal(config, task(), {}, { grant, mounts: [] }), null);
});
