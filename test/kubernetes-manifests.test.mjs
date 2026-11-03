// deploy/kubernetes/ held to the rules test/networks.test.mjs holds compose.yaml to: each
// service's NetworkPolicies let in its callers alone and let it out to its callees alone
// (lib/services.mjs CALLS), the secrets are each their own service's, nothing but the broker's
// TokenReviews is cluster-wide, and no two services share a writable volume. The sandboxes'
// and BuildKit's policies pass the runner's own checks, which it makes before every run and
// build. kubeconform checks the schemas (CI's kubernetes job): kustomize isn't needed here, as
// the files are read as written, with the components' patches.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { DRAIN_MS as BROKER_DRAIN_MS } from "../broker/server.mjs";
import { appSecrets, keys } from "../deploy/kubernetes/secrets.mjs";
import { convertManifest, KEPT } from "../github/app.mjs";
import { DRAIN_MS as GITHUB_DRAIN_MS } from "../lib/drain.mjs";
import { CALLS, SERVICES } from "../lib/services.mjs";
import { keyId } from "../lib/tokens.mjs";
import { parseYaml } from "../lib/yaml.mjs";
import { builderIsolationProblem } from "../listener/runner/kube-images.mjs";
import { isolationProblem, selects } from "../listener/runner/kubernetes.mjs";
import { DRAIN_MS as MODELS_DRAIN_MS } from "../models/server.mjs";
import { DRAIN_MS as POLICY_DRAIN_MS } from "../policy-service/service.mjs";

const root = join(import.meta.dirname, "..", "deploy", "kubernetes");
const SERVICES_NS = "deckhand";
const SANDBOXES_NS = "deckhand-sandboxes";

// Each file's documents, as lib/yaml.mjs reads them.
const docs = (file) =>
  readFileSync(join(root, file), "utf8")
    .split(/^---$/m)
    .map((text) => parseYaml(text))
    .filter(Boolean);
const kustomization = (dir = "") => docs(join(dir, "kustomization.yaml"))[0];
const resources = (dir = "") => kustomization(dir).resources.flatMap((f) => docs(join(dir, f)));

const base = resources();
const buildkit = resources("components/buildkit");
const redis = resources("components/redis");
const blobs = resources("components/blobs");
const all = [...base, ...buildkit, ...redis, ...blobs];
const of = (kind, list = all) => list.filter((r) => r.kind === kind);
const named = (kind, name, list = all) => of(kind, list).find((r) => r.metadata.name === name);

// lib/services.mjs's services → the app label of their pods (and their Deployment's name).
const APP = Object.fromEntries(SERVICES.map((s) => [s, s === "proxy" ? "egress" : s]));
const SERVICE_OF = Object.fromEntries(SERVICES.map((s) => [`deckhand-${APP[s]}`, s]));
const deployment = (service) => named("Deployment", APP[service], base);
const pod = (service) => deployment(service).spec.template.spec;
const container = (service) => pod(service).containers[0];
const env = (service) =>
  Object.fromEntries((container(service).env ?? []).map((e) => [e.name, e.value ?? e.valueFrom]));

// Calls without a service token, as in test/networks.test.mjs: the proxy asks the orchestrator's
// egress policy about each connection; the orchestrator reads the proxy's CA from it.
const UNTOKENED = { proxy: ["orchestrator"], orchestrator: ["proxy"] };
const callees = (service) => [...CALLS[service], ...(UNTOKENED[service] ?? [])].sort();
const callers = (service) => SERVICES.filter((caller) => callees(caller).includes(service)).sort();
// Who else may reach a service: the internet edge's public port, the sandboxes' namespace and
// BuildKit the proxy.
const OUTSIDE_CALLERS = { edge: ["internet"], proxy: ["sandboxes", "buildkitd"] };
// Ways out beyond the cluster's pods, as INTERNET in test/networks.test.mjs; the runner's and
// the broker's include the API server's port.
const WAYS_OUT = {
  edge: [443],
  github: [443],
  models: [443],
  proxy: "any",
};
// The runner and the broker reach the API server's addresses alone (deckhand-api-server): a
// placeholder the operator replaces, which reaches nothing until then.
const API = ["runner", "broker"];
const API_PLACEHOLDER = "192.0.2.1/32";

// A policy peer → who it is: a service, "sandboxes", "buildkitd", "dns", "internet".
function peer(p) {
  if (p.ipBlock) return p.ipBlock.cidr === API_PLACEHOLDER ? "api" : "internet";
  const ns = p.namespaceSelector?.matchLabels?.["kubernetes.io/metadata.name"];
  if (ns === "kube-system") return "dns";
  if (ns === SANDBOXES_NS) return "sandboxes";
  const app = p.podSelector?.matchLabels?.app;
  if (app === "buildkitd") return "buildkitd";
  return SERVICE_OF[app] ?? `unknown ${JSON.stringify(p)}`;
}

// The policies of the services' namespace picking a service's pods: who they let in, who out.
function reach(service, policies = of("NetworkPolicy", base)) {
  const labels = deployment(service).spec.template.metadata.labels;
  const picking = policies.filter(
    (p) => p.metadata.namespace === SERVICES_NS && selects(p.spec.podSelector, labels),
  );
  const ins = new Set();
  const outs = new Set();
  const out = [];
  for (const p of picking) {
    for (const rule of p.spec.ingress ?? []) {
      for (const from of rule.from ?? [{ ipBlock: {} }]) ins.add(peer(from));
    }
    for (const rule of p.spec.egress ?? []) {
      for (const to of rule.to ?? []) {
        outs.add(peer(to));
        if (peer(to) === "internet") out.push(...(rule.ports?.map((x) => x.port) ?? ["any"]));
      }
    }
  }
  return { ins, outs, out, picking };
}

test("kustomization.yaml: every manifest of the folder is a resource of the base or a component's", () => {
  const listed = new Set([
    ...kustomization().resources,
    ...kustomization("components/redis").resources.map((f) => `components/redis/${f}`),
    ...kustomization("components/redis").patches.flatMap((p) =>
      p.path ? [`components/redis/${p.path}`] : [],
    ),
    ...kustomization("components/buildkit").resources.map((f) => `components/buildkit/${f}`),
    ...kustomization("components/blobs").resources.map((f) => `components/blobs/${f}`),
  ]);
  const files = readdirSync(root, { recursive: true })
    .map((f) => f.replaceAll("\\", "/"))
    .filter((f) => f.endsWith(".yaml") && !f.endsWith("kustomization.yaml"))
    .filter((f) => !f.startsWith("server/"));
  assert.deepEqual(files.filter((f) => !listed.has(f)).sort(), []);
});

// A generator's file missing (or git-ignored, as config.yaml is) fails every build of the base,
// remote ones included.
test("kustomization.yaml: every file a generator reads is in the folder", () => {
  for (const dir of ["", "components/redis", "components/buildkit", "components/blobs"]) {
    for (const generator of kustomization(dir).configMapGenerator ?? []) {
      for (const entry of generator.files ?? []) {
        const file = join(root, dir, entry.split("=").at(-1));
        assert.ok(existsSync(file), `${generator.name}: ${file}`);
      }
    }
  }
});

// The commands the store sends (lib/store-redis.mjs, its scripts' included: Redis checks those
// too, and lib/resp.mjs): each user's ACL has to allow them all, or a call fails with NOPERM.
function storeCommands() {
  const lib = join(import.meta.dirname, "..", "lib");
  const text = ["store-redis.mjs", "resp.mjs"]
    .map((f) => readFileSync(join(lib, f), "utf8"))
    .join("\n");
  const found = new Set();
  // In the scripts: redis.call('XINFO', 'GROUPS', …), redis.pcall(…), pcall(redis.call, …).
  for (const [, command, sub] of text.matchAll(
    /(?:redis\.p?call\(|pcall\(redis\.call, )'([A-Z]+)'(?:, '([A-Z]+)')?/g,
  )) {
    found.add(["XGROUP", "XINFO"].includes(command) ? `${command}|${sub}` : command);
  }
  // From Node: call("EVALSHA", …), ["SELECT", …].
  for (const [, command] of text.matchAll(/(?:call\(|\[)"([A-Z]+)"/g)) found.add(command);
  found.delete("AUTH"); // always allowed
  return [...found].map((c) => c.toLowerCase());
}
const allows = (acl, command) =>
  acl.includes(` +${command} `) || acl.includes(` +${command.split("|")[0]} `);

test("components/redis and setup.md: each user's ACL allows every command the store sends", () => {
  const commands = storeCommands();
  assert.ok(commands.includes("xdel") && commands.includes("xinfo|groups"), commands.join(" "));
  const lines = [
    /echo "(user \$service on .*)" >>/.exec(
      readFileSync(join(root, "components/redis/redis.yaml"), "utf8"),
    )[1],
    /^(user deckhand on .*)$/m.exec(
      readFileSync(join(import.meta.dirname, "..", "docs", "setup.md"), "utf8"),
    )[1],
  ];
  for (const line of lines) {
    const acl = `${line} `;
    assert.deepEqual(
      commands.filter((c) => !allows(acl, c)),
      [],
      line.slice(0, 40),
    );
  }
});

test("deploy/kubernetes: a Deployment, a Service and a ServiceAccount per service, its API token on the runner and the broker alone", () => {
  for (const service of SERVICES) {
    const d = deployment(service);
    assert.ok(d, `${service}: no Deployment ${APP[service]}`);
    assert.equal(d.metadata.namespace, SERVICES_NS);
    assert.ok(named("Service", APP[service], base), `${service}: no Service`);
    const account = pod(service).serviceAccountName;
    assert.equal(account, `deckhand-${APP[service]}`, `${service}'s ServiceAccount`);
    assert.ok(named("ServiceAccount", account, base), `${service}: no ServiceAccount ${account}`);
    const api = ["runner", "broker"].includes(service);
    assert.equal(pod(service).automountServiceAccountToken, api, `${service}'s API token`);
    // No <SERVICE>_PORT variables: the policy Service's would read as POLICY_PORT.
    assert.equal(pod(service).enableServiceLinks, false, `${service}: enableServiceLinks`);
  }
  // Every Service's selector is its Deployment's pods'.
  for (const service of of("Service", base)) {
    const d = named("Deployment", service.metadata.name, base);
    assert.deepEqual(service.spec.selector, d.spec.selector.matchLabels, service.metadata.name);
  }
});

test("deploy/kubernetes: a token projected for the broker wherever CALLS says the service calls it, and SERVICE_ACCOUNTS to match", () => {
  const accounts = Object.fromEntries(
    env("broker")
      .SERVICE_ACCOUNTS.split(",")
      .map((part) => part.split("=")),
  );
  for (const service of SERVICES) {
    const projected = (pod(service).volumes ?? []).find((v) =>
      v.projected?.sources?.some((s) => s.serviceAccountToken),
    );
    const calls = CALLS[service].includes("broker");
    assert.equal(Boolean(projected), calls, `${service}'s token for the broker`);
    if (!calls) {
      assert.ok(!(service in accounts), `${service} in SERVICE_ACCOUNTS`);
      continue;
    }
    const source = projected.projected.sources[0].serviceAccountToken;
    assert.equal(source.audience, "deckhand-broker");
    const mount = container(service).volumeMounts.find((m) => m.name === projected.name);
    assert.equal(env(service).SERVICE_ACCOUNT_TOKEN_FILE, `${mount.mountPath}/${source.path}`);
    assert.equal(accounts[service], `${SERVICES_NS}:${pod(service).serviceAccountName}`, service);
  }
});

test("deploy/kubernetes: SERVICE_NETWORKS=none wherever it is read; the broker tells its callers by their accounts", () => {
  for (const service of ["edge", "orchestrator", "runner", "github", "models"]) {
    assert.equal(env(service).SERVICE_NETWORKS, "none", service);
  }
  // The broker takes the network's word over the accounts' when both are set; the policy
  // service checks no network unset.
  for (const service of ["broker", "policy", "proxy"]) {
    assert.ok(!("SERVICE_NETWORKS" in env(service)), service);
  }
});

test("deploy/kubernetes: each service's NetworkPolicies let in its callers alone, and out to its callees alone (CALLS)", () => {
  // Default deny in both namespaces: what isn't let through below isn't.
  for (const ns of [SERVICES_NS, SANDBOXES_NS]) {
    const deny = of("NetworkPolicy", base).find(
      (p) => p.metadata.namespace === ns && Object.keys(p.spec.podSelector).length === 0,
    );
    assert.deepEqual(deny?.spec.policyTypes, ["Ingress", "Egress"], `${ns}: default deny`);
    assert.ok(!deny.spec.ingress && !deny.spec.egress, `${ns}: default deny lets nothing`);
  }
  for (const service of SERVICES) {
    const { ins, outs, out } = reach(service);
    const expectedIns = [...callers(service), ...(OUTSIDE_CALLERS[service] ?? [])].sort();
    assert.deepEqual([...ins].sort(), expectedIns, `who reaches ${service}`);
    const ways = WAYS_OUT[service];
    const expectedOuts = [
      ...callees(service),
      ...(service === "policy" ? [] : ["dns"]),
      ...(ways ? ["internet"] : []),
      ...(API.includes(service) ? ["api"] : []),
    ].sort();
    assert.deepEqual([...outs].sort(), expectedOuts, `what ${service} reaches`);
    if (ways === "any") assert.deepEqual(out, ["any", "any"], service);
    else assert.deepEqual([...new Set(out)].sort(), ways ?? [], `${service}'s ways out`);
  }
  // The proxy's way out leaves out the private ranges: no granted host is a pod or a node.
  const { picking } = reach("proxy");
  const blocks = picking.flatMap((p) =>
    (p.spec.egress ?? []).flatMap((r) => (r.to ?? []).filter((t) => t.ipBlock)),
  );
  for (const range of ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"]) {
    assert.ok(blocks[0].ipBlock.except.includes(range), range);
  }
});

test("deploy/kubernetes: the sandboxes' and install pods' NetworkPolicies pass the runner's check, with the services apart", () => {
  const policies = of("NetworkPolicy", base).filter((p) => p.metadata.namespace === SANDBOXES_NS);
  const proxy = {
    namespace: SERVICES_NS,
    selector: named("Service", "egress", base).spec.selector,
  };
  const sandbox = { "deckhand.owner": "deckhand", "deckhand.run": "x", "deckhand.role": "sandbox" };
  assert.equal(isolationProblem(policies, sandbox, { proxy }), null);
  const install = { "deckhand.owner": "deckhand", "deckhand.role": "install" };
  assert.equal(isolationProblem(policies, install, { proxy }), null);
  // A check pod: picked by the default deny alone, nothing in or out.
  const check = { "deckhand.owner": "deckhand", "deckhand.role": "check" };
  const picking = policies.filter((p) => selects(p.spec.podSelector, check));
  assert.deepEqual(
    picking.map((p) => p.metadata.name),
    ["deckhand-default-deny"],
  );
  // And the check fails closed on what would let them out: one wide rule is enough.
  const wide = structuredClone(policies);
  wide[1].spec.egress.push({ to: [{ ipBlock: { cidr: "0.0.0.0/0" } }] });
  assert.match(isolationProblem(wide, sandbox, { proxy }), /reach/);
});

test("components/buildkit: BuildKit's NetworkPolicies pass the runner's check", () => {
  const policies = of("NetworkPolicy", [...base, ...buildkit]).filter(
    (p) => p.metadata.namespace === SERVICES_NS,
  );
  const labels = named("Deployment", "buildkitd", buildkit).spec.template.metadata.labels;
  assert.equal(builderIsolationProblem(policies, labels, { sandboxesApart: true }), null);
  // Its Roles' additions: the registry's pull Secret by name, in both namespaces.
  const added = kustomization("components/buildkit")
    .patches.filter((p) => p.target?.kind === "Role")
    .flatMap((p) => parseYaml(p.patch))
    .map((op) => op.value);
  assert.equal(added.length, 2);
  for (const rule of added) {
    assert.deepEqual(rule.resources, ["secrets"]);
    assert.deepEqual(rule.resourceNames, ["deckhand-registry"], rule.verbs.join(","));
  }
  // And the registries, on 443, with it alone.
  const withBuildkit = reach("runner", policies);
  assert.ok(withBuildkit.outs.has("internet"));
  assert.deepEqual([...new Set(withBuildkit.out)], [443]);
  // The runner reaches it: its Service's port, from the runner's pods.
  const runner = reach("runner", policies);
  assert.ok(runner.outs.has("buildkitd"));
});

test("deploy/kubernetes: nothing cluster-wide but the broker's TokenReviews; the runner's Roles name what it calls", () => {
  const wide = all.filter((r) => /^Cluster/.test(r.kind));
  assert.deepEqual(
    wide.map((r) => `${r.kind} ${r.roleRef?.name} → ${r.subjects?.map((s) => s.name)}`),
    ["ClusterRoleBinding system:auth-delegator → deckhand-broker"],
  );
  // Every Role: namespaced, no wildcard, bound to the runner alone.
  for (const role of of("Role")) {
    for (const rule of role.rules) {
      for (const field of ["apiGroups", "resources", "verbs"]) {
        assert.ok(!rule[field].includes("*"), `${role.metadata.namespace}: ${field} *`);
      }
    }
  }
  for (const binding of of("RoleBinding")) {
    assert.deepEqual(
      binding.subjects.map((s) => `${s.namespace}:${s.name}`),
      [`${SERVICES_NS}:deckhand-runner`],
    );
  }
  const rules = (ns, list = base) =>
    of("Role", list)
      .filter((r) => r.metadata.namespace === ns)
      .flatMap((r) => r.rules)
      .map((r) => `${r.resources.join(",")}: ${r.verbs.join(",")}`);
  // listener/runner/kubernetes.mjs, kube-images.mjs, kube-pull.mjs, kube-probe.mjs.
  assert.deepEqual(rules(SANDBOXES_NS), [
    "pods: create,get,list,delete",
    "pods/log: get",
    // The Antigravity login refresh's stdin and stdout (kube-attach.mjs).
    "pods/attach: create,get",
    "secrets: create,get,list,delete",
    "persistentvolumeclaims: create,get,delete",
    "events: list",
    "networkpolicies: list",
  ]);
  assert.deepEqual(rules(SERVICES_NS), [
    "services: get,list",
    "pods: get",
    "endpointslices: list",
    "networkpolicies: list",
  ]);
});

test("deploy/kubernetes: each secret is its own service's, the orchestrator holds none, the broker's public key reaches its readers read only", () => {
  const SECRETS = {
    "deckhand-edge": "edge",
    "deckhand-github": "github",
    "deckhand-broker-key": "broker",
    "deckhand-models": "models",
    "deckhand-models-key": "models",
    "deckhand-credentials": "models",
  };
  const secretsOf = (service) => [
    ...(pod(service).volumes ?? []).filter((v) => v.secret).map((v) => v.secret.secretName),
    ...(container(service).envFrom ?? []).filter((e) => e.secretRef).map((e) => e.secretRef.name),
    ...(container(service).env ?? []).flatMap((e) =>
      e.valueFrom?.secretKeyRef ? [e.valueFrom.secretKeyRef.name] : [],
    ),
  ];
  for (const service of SERVICES) {
    const held = secretsOf(service).sort();
    const own = Object.entries(SECRETS)
      .filter(([, holder]) => holder === service)
      .map(([name]) => name)
      .sort();
    assert.deepEqual(held, own, `${service}'s Secrets`);
  }
  // Nothing secret in the orchestrator's settings either.
  const secretLike = (name) =>
    /TOKEN|KEY|SECRET|AUTH_FILE|PASSWORD|PEM/.test(name) &&
    !["SERVICE_ACCOUNT_TOKEN_FILE"].includes(name);
  assert.deepEqual(Object.keys(env("orchestrator")).filter(secretLike), []);
  // Read only wherever mounted.
  for (const service of SERVICES) {
    const secretVolumes = (pod(service).volumes ?? []).filter((v) => v.secret).map((v) => v.name);
    for (const mount of container(service).volumeMounts ?? []) {
      if (secretVolumes.includes(mount.name)) assert.equal(mount.readOnly, true, mount.name);
    }
  }
  // The broker publishes none: its readers mount the ConfigMap, read only, at SERVICE_KEYS_DIR
  // (the policy service's default, /keys).
  assert.ok(!("SERVICE_KEYS_DIR" in env("broker")));
  for (const service of SERVICES) {
    const volume = (pod(service).volumes ?? []).find(
      (v) => v.configMap?.name === "deckhand-service-keys",
    );
    const reads = ["runner", "models", "policy"].includes(service);
    assert.equal(Boolean(volume), reads, `${service}: the broker's public key`);
    if (!reads) continue;
    const mount = container(service).volumeMounts.find((m) => m.name === volume.name);
    assert.equal(mount.readOnly, true);
    assert.equal(mount.mountPath, env(service).SERVICE_KEYS_DIR ?? "/keys", service);
  }
});

// A disk emptyDir over its sizeLimit evicts the pod, cutting every call it serves; a tmpfs refuses
// the one write that would go over it.
// Gi, Mi → bytes.
const bytes = (q) => Number(/^(\d+)/.exec(q)[1]) * { Gi: 2 ** 30, Mi: 2 ** 20 }[q.slice(-2)];

test("deploy/kubernetes: the github service's and the runner's /tmp are tmpfs of a fixed size, within their memory", () => {
  for (const service of ["github", "runner"]) {
    const tmp = pod(service).volumes.find((v) => v.name === "tmp");
    assert.equal(tmp.emptyDir.medium, "Memory", service);
    // A tmpfs is charged to its pod: the request keeps the room on the node, the limit bounds
    // it by the pod's cgroup, both above it with room for the process.
    const { requests, limits } = container(service).resources;
    assert.equal(requests.memory, limits.memory, service);
    assert.ok(bytes(requests.memory) >= bytes(tmp.emptyDir.sizeLimit) + 2 ** 29, service);
  }
});

// What the manifests set, the services read: SERVICE_NETWORKS=none where the manifests give it
// (a bound of null, the callers' tokens alone), and REDIS_PASSWORD with every store (redis's
// STORE_URL names its user, not its password).
test("the services' entry points: SERVICE_NETWORKS=none, and REDIS_PASSWORD for the store", () => {
  const server = (dir) => readFileSync(join(import.meta.dirname, "..", dir, "server.mjs"), "utf8");
  for (const dir of ["edge", "orchestrator", "runner", "github", "models"]) {
    assert.match(server(dir), /SERVICE_NETWORKS === "none"|serviceNetworks === "none"/, dir);
  }
  for (const dir of ["edge", "orchestrator", "runner", "github", "models", "broker"]) {
    // Each call's URL and the options' first lines.
    const text = server(dir);
    const calls = [...text.matchAll(/openStore\(/g)].map((m) => text.slice(m.index, m.index + 200));
    assert.ok(calls.length, `${dir}: no store`);
    for (const call of calls) assert.match(call, /password: env\.REDIS_PASSWORD/, dir);
  }
});

test("deploy/kubernetes: no two services share a writable volume", () => {
  const users = new Map(); // claim → services
  for (const service of SERVICES) {
    for (const v of pod(service).volumes ?? []) {
      if (!v.persistentVolumeClaim) continue;
      const claim = v.persistentVolumeClaim.claimName;
      users.set(claim, [...(users.get(claim) ?? []), service]);
      assert.ok(named("PersistentVolumeClaim", claim, base), `${claim}: no claim`);
    }
  }
  for (const [claim, services] of users) assert.equal(services.length, 1, `${claim}: ${services}`);
  // Every claim of the base is a service's.
  for (const claim of of("PersistentVolumeClaim", base)) {
    assert.ok(users.has(claim.metadata.name), `${claim.metadata.name}: no service mounts it`);
  }
});

// What a copy's update takes (docs/services.md, Upgrades without downtime): its next copy is
// ready before the old one stops, which drains within its grace period.
const GRACE = {
  edge: 40,
  orchestrator: 300,
  runner: 300,
  broker: 45,
  github: 300,
  models: 630,
  policy: 40,
  proxy: 630,
};
// The defaults of the services whose drain the manifests leave to the code (ms); edge and the
// proxy set DRAIN_SECONDS (edge's server starts as it is imported).
const DRAIN_DEFAULTS = {
  github: GITHUB_DRAIN_MS,
  broker: BROKER_DRAIN_MS,
  models: MODELS_DRAIN_MS,
  policy: POLICY_DRAIN_MS,
};
// Each service that pauses before its SIGTERM → its drain (s): its DRAIN_SECONDS, or its default.
const drain = (service) => Number(env(service).DRAIN_SECONDS ?? DRAIN_DEFAULTS[service] / 1000);
const PAUSED = ["edge", "github", "broker", "models", "policy", "proxy"];
// Readiness on /ready, but: edge has none (it stops taking connections as it drains); the
// orchestrator's and the runner's answer on the acting copy alone, and the next copy only acts
// once the old one has stopped, so a rolling update waiting for it would never end.
const READINESS = { edge: "/health", orchestrator: "/health", runner: "/health" };

test("deploy/kubernetes: two copies of each service, one of the proxy, each update starting the next copy first", () => {
  for (const service of SERVICES) {
    const d = deployment(service);
    assert.equal(d.spec.replicas, service === "proxy" ? 1 : 2, `${service}'s copies`);
    assert.deepEqual(
      d.spec.strategy,
      { type: "RollingUpdate", rollingUpdate: { maxUnavailable: 0, maxSurge: 1 } },
      service,
    );
    assert.equal(
      container(service).readinessProbe?.httpGet?.path,
      READINESS[service] ?? "/ready",
      `${service}'s readiness`,
    );
    // Liveness on /health, which answers as long as the process does: /ready waits for the
    // broker too (#391).
    assert.equal(
      container(service).livenessProbe?.httpGet?.path,
      "/health",
      `${service}'s liveness`,
    );
    assert.equal(pod(service).terminationGracePeriodSeconds, GRACE[service], service);
  }
  // The services both copies answer for pause before their SIGTERM, until the Service no longer
  // sends them connections (a pod leaves its endpoints as it starts terminating, kube-proxy and
  // the ingress learn it a few seconds later), then drain within their grace period: a refused
  // connection meanwhile fails the internet's callers and the dashboard's health probe (#560),
  // which don't try it again. The proxy drains as long as an agent's call lasts.
  // The pause is docs/services.md's 10 s.
  for (const service of PAUSED) {
    const pause = Number(container(service).lifecycle?.preStop?.exec?.command?.[1]);
    assert.equal(pause, 10, `${service} pauses 10 s before its drain`);
    assert.ok(drain(service) > 0, `${service}'s drain`);
    assert.ok(
      pause + drain(service) < GRACE[service],
      `${service}: its pause and drain within its grace`,
    );
  }
});

test("deploy/kubernetes: every service as compose runs it: not root, no capability, a read-only root", () => {
  for (const service of SERVICES) {
    const security = pod(service).securityContext;
    assert.equal(security.runAsNonRoot, true, service);
    assert.equal(security.runAsUser, 1000, service);
    assert.equal(security.seccompProfile.type, "RuntimeDefault", service);
    const own = container(service).securityContext;
    assert.deepEqual(own.capabilities, { drop: ["ALL"] }, service);
    assert.equal(own.allowPrivilegeEscalation, false, service);
    assert.equal(own.readOnlyRootFilesystem, true, service);
  }
  // The sandboxes' namespace enforces Pod Security `restricted`.
  const sandboxes = named("Namespace", SANDBOXES_NS, base);
  assert.equal(sandboxes.metadata.labels["pod-security.kubernetes.io/enforce"], "restricted");
});

test("components/redis: each service's store under its own user and keys, its password one key of deckhand-redis", () => {
  const patches = kustomization("components/redis").patches.filter((p) => p.path);
  const stored = patches.map((p) => docs(join("components/redis", p.path))[0]);
  const acl = readFileSync(join(root, "components/redis/redis.yaml"), "utf8");
  const users = /for service in ([\w ]+); do/.exec(acl)[1].split(" ");
  for (const patch of stored) {
    const service = patch.metadata.name;
    const vars = Object.fromEntries(
      patch.spec.template.spec.containers[0].env.map((e) => [e.name, e.value ?? e.valueFrom]),
    );
    assert.equal(vars.STORE_URL, `redis://${service}@redis:6379?prefix=deckhand:${service}:`);
    assert.deepEqual(vars.REDIS_PASSWORD, {
      secretKeyRef: { name: "deckhand-redis", key: service },
    });
    assert.ok(users.includes(service), `${service}: no Redis user`);
    // Each user's keys are its own prefix's.
    assert.match(acl, /~deckhand:\$service:\*/);
  }
  // Every service with a store, and nothing else.
  assert.deepEqual(stored.map((p) => p.metadata.name).sort(), [
    "broker",
    "edge",
    "github",
    "models",
    "orchestrator",
    "runner",
  ]);
  assert.deepEqual([...users].sort(), [
    "broker",
    "edge",
    "github",
    "models",
    "orchestrator",
    "runner",
  ]);
  // Redis reaches nothing: no policy picking its pods lets them out, DNS included.
  const policies = of("NetworkPolicy", [...base, ...redis]);
  const labels = named("StatefulSet", "redis", redis).spec.template.metadata.labels;
  const picking = policies.filter((p) => selects(p.spec.podSelector, labels));
  assert.ok(picking.some((p) => p.spec.policyTypes.includes("Egress")));
  assert.deepEqual(
    picking.flatMap((p) => p.spec.egress ?? []),
    [],
  );
  // Redis lets in those alone.
  const policy = named("NetworkPolicy", "deckhand-redis", redis);
  const from = policy.spec.ingress[0].from[0].podSelector.matchExpressions[0].values;
  assert.deepEqual(from.map((app) => SERVICE_OF[app]).sort(), [
    "broker",
    "edge",
    "github",
    "models",
    "orchestrator",
    "runner",
  ]);
});

test("secrets.mjs: the keys and the App's credentials, each in its own service's Secret", async () => {
  const made = keys("deckhand")
    .split(/^---$/m)
    .map((text) => parseYaml(text))
    .filter(Boolean);
  assert.deepEqual(
    made.map((r) => `${r.kind} ${r.metadata.name}`),
    ["Secret deckhand-broker-key", "ConfigMap deckhand-service-keys", "Secret deckhand-models-key"],
  );
  // The public key named by its kid, as the broker would publish it.
  const [file, pem] = Object.entries(made[1].data)[0];
  assert.equal(file, `${keyId(pem)}.pem`);
  const models = Buffer.from(
    Buffer.from(made[2].data["models.key"], "base64").toString(),
    "base64",
  );
  assert.equal(models.length, 32);

  // GitHub's answer to the manifest's code, as the github service converts it (/setup).
  const github = {
    "/app-manifests/c0de/conversions": {
      id: 1,
      slug: "deckhand-x",
      client_id: "Iv1.x",
      client_secret: "client-secret",
      webhook_secret: "webhook-secret",
      pem: "-----BEGIN RSA PRIVATE KEY-----",
      owner: { login: "acme" },
      html_url: "https://github.com/apps/deckhand-x",
    },
    "/users/deckhand-x%5Bbot%5D": { id: 2 },
  };
  const fetch = async (url) => Response.json(github[new URL(url).pathname]);
  const credentials = await convertManifest({ code: "c0de", api: "https://api.test", fetch });
  const app = appSecrets(credentials, {
    publicUrl: "https://deckhand.example.com",
    namespace: "deckhand",
  })
    .split(/^---$/m)
    .map((text) => parseYaml(text))
    .filter(Boolean);
  const file64 = (secret, key) =>
    Buffer.from(app.find((r) => r.metadata.name === secret).data[key], "base64");
  const edge = JSON.parse(file64("deckhand-edge", "app.json"));
  const held = JSON.parse(file64("deckhand-github", "app.json"));
  // What the github service keeps, as /setup would have written it; edge's, with the bot.
  assert.deepEqual(Object.keys(held).sort(), [...KEPT].sort());
  assert.equal(edge.bot_id, 2);
  // The key is the github service's alone; the webhook secret and the OAuth client's, edge's.
  assert.equal(edge.pem, undefined);
  assert.equal(edge.webhook_secret, "webhook-secret");
  assert.equal(edge.public_url, "https://deckhand.example.com");
  assert.equal(held.pem, "-----BEGIN RSA PRIVATE KEY-----");
  assert.equal(held.webhook_secret, undefined);
  assert.equal(held.client_secret, undefined);
  assert.equal(file64("deckhand-edge", "session.key").length, 32);
});

// A component's patches (JSON Patch `add` alone, as they are written) applied to copies of
// `list`'s documents they target (a target's name is a regular expression, as kustomize's).
function patched(dir, list) {
  const out = structuredClone(list);
  for (const { target, patch } of kustomization(dir).patches ?? []) {
    const docs = out.filter(
      (r) =>
        r.kind === target.kind &&
        new RegExp(`^(?:${target.name})$`).test(r.metadata.name) &&
        (!target.namespace || r.metadata.namespace === target.namespace),
    );
    assert.ok(docs.length, `${dir}: no ${target.kind} ${target.name}`);
    for (const doc of docs) {
      for (const op of parseYaml(patch)) {
        assert.equal(op.op, "add");
        const keys = op.path.split("/").slice(1);
        const last = keys.pop();
        const at = keys.reduce((node, k) => node[k], doc);
        if (last === "-") at.push(structuredClone(op.value));
        else at[last] = structuredClone(op.value);
      }
    }
  }
  return out;
}

test("components/engine: the engines' port published, and the sandboxes' policy with it passes the runner's check with an engine set", () => {
  const withEngine = patched("components/engine", base);
  const service = named("Service", "egress", withEngine);
  assert.deepEqual(
    service.spec.ports.map((p) => p.port),
    [3128, 3129],
  );
  const ports = named("Deployment", "egress", withEngine).spec.template.spec.containers[0].ports;
  assert.deepEqual(
    ports.map((p) => p.containerPort),
    [3128, 3129],
  );
  const policies = of("NetworkPolicy", withEngine).filter(
    (p) => p.metadata.namespace === SANDBOXES_NS,
  );
  const proxy = { namespace: SERVICES_NS, selector: service.spec.selector };
  const sandbox = { "deckhand.owner": "deckhand", "deckhand.run": "x", "deckhand.role": "sandbox" };
  // The runner's ports with an engine (kubernetes.mjs sandboxPorts()), and without one: 3129
  // is then too wide.
  assert.equal(isolationProblem(policies, sandbox, { proxy, ports: [3128, 3129] }), null);
  assert.match(isolationProblem(policies, sandbox, { proxy }), /port 3129/);
  // Install pods still reach 3128 alone.
  const install = { "deckhand.owner": "deckhand", "deckhand.role": "install" };
  assert.equal(isolationProblem(policies, install, { proxy }), null);
  // The proxy lets the sandboxes in on 3129, and nobody else.
  const engines = named("NetworkPolicy", "deckhand-egress", withEngine).spec.ingress.filter((r) =>
    r.ports.some((p) => p.port === 3129),
  );
  assert.deepEqual(
    engines.flatMap((r) => r.from.map(peer)),
    ["sandboxes"],
  );
  // The settings that turn it on, beside the base's.
  const literals = kustomization("components/engine").configMapGenerator[0].literals;
  assert.deepEqual(literals.map((l) => l.split("=")[0]).sort(), [
    "ENGINE_IMAGE",
    "KUBERNETES_ENGINE_RUNTIME_CLASS",
    "SANDBOX_ENGINE",
  ]);
});

// Blob storage's settings and key pair (#606, #610) are the runner's and the broker's alone, as in
// compose.yaml (test/networks.test.mjs): the Secret mounted read only where BLOB_*_FILE says, the
// URL from a ConfigMap no other service reads, and their way out to its address alone, a
// placeholder that reaches nothing until the overlay sets it.
test("components/blobs: the runner and the broker alone get BLOB_URL and the deckhand-blobs Secret, and reach its address alone", () => {
  const withBlobs = [...patched("components/blobs", base), ...blobs];
  const spec = (service) => named("Deployment", APP[service], withBlobs).spec.template.spec;
  const BLOB_SETTINGS = ["BLOB_URL", "BLOB_ACCESS_KEY_ID_FILE", "BLOB_SECRET_ACCESS_KEY_FILE"];
  for (const service of SERVICES) {
    const { containers, volumes = [] } = spec(service);
    const [main] = containers;
    const settings = (main.env ?? []).filter((e) => e.name.startsWith("BLOB_"));
    const secret = volumes.find((v) => v.secret?.secretName === "deckhand-blobs");
    const config = JSON.stringify(spec(service)).includes('"deckhand-blobs"');
    if (!API.includes(service)) {
      assert.deepEqual(settings, [], `${service}: blob storage's settings`);
      assert.ok(!config && !secret, `${service}: blob storage's ConfigMap or Secret`);
      continue;
    }
    assert.deepEqual(
      settings.map((e) => e.name),
      BLOB_SETTINGS,
      service,
    );
    assert.deepEqual(settings[0].valueFrom.configMapKeyRef, {
      name: "deckhand-blobs",
      key: "BLOB_URL",
    });
    assert.equal(secret.secret.defaultMode, 0o440, service);
    const mount = main.volumeMounts.find((m) => m.name === secret.name);
    assert.equal(mount.readOnly, true, service);
    const files = Object.fromEntries(settings.slice(1).map((e) => [e.name, e.value]));
    assert.deepEqual(files, {
      BLOB_ACCESS_KEY_ID_FILE: `${mount.mountPath}/access-key-id`,
      BLOB_SECRET_ACCESS_KEY_FILE: `${mount.mountPath}/secret-access-key`,
    });
  }
  // Not deckhand-env, which the orchestrator and the models service read too.
  const env = kustomization("components/blobs").configMapGenerator;
  assert.deepEqual(
    env.map((g) => g.name),
    ["deckhand-blobs"],
  );
  assert.deepEqual(env[0].literals, ["BLOB_URL=s3://deckhand?endpoint=https://blobs.invalid"]);
  // Its policy: the runner and the broker, out to the placeholder alone.
  const policies = of("NetworkPolicy", blobs);
  assert.deepEqual(
    policies.map((p) => p.metadata.name),
    ["deckhand-blobs"],
  );
  const [policy] = policies;
  assert.deepEqual(policy.spec.policyTypes, ["Egress"]);
  for (const service of SERVICES) {
    const labels = deployment(service).spec.template.metadata.labels;
    assert.equal(selects(policy.spec.podSelector, labels), API.includes(service), service);
  }
  assert.deepEqual(policy.spec.egress, [
    { to: [{ ipBlock: { cidr: "192.0.2.2/32" } }], ports: [{ port: 443, protocol: "TCP" }] },
  ]);
});
