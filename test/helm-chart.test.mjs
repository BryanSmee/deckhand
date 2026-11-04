// deploy/helm/deckhand held to deploy/kubernetes (#570): with its default values the chart
// renders the objects `kustomize build` does, alone and with each component, so the base's
// rules (test/kubernetes-manifests.test.mjs) hold for it too; its values then change what they
// say and nothing else. Needs helm and kustomize on the PATH, which CI's kubernetes job installs
// (pinned) and where a skip fails the job; elsewhere these tests skip.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { parseYaml } from "../lib/yaml.mjs";
import { isolationProblem } from "../listener/runner/kubernetes.mjs";
import { posix, tempDir } from "./helpers.mjs";

const repo = join(import.meta.dirname, "..");
const base = join(repo, "deploy", "kubernetes");
const chart = join(repo, "deploy", "helm", "deckhand");

const runs = (tool) => !spawnSync(tool, ["version"], { stdio: "ignore" }).error;
const skip = (!runs("helm") || !runs("kustomize")) && "no helm or kustomize on the PATH";

const documents = (text) =>
  text
    .split(/^---$/m)
    .map((part) => parseYaml(part))
    .filter(Boolean);

// The base with these components, through an overlay of its own, as an operator's would be:
// relative paths, as kustomize refuses absolute ones.
function kustomize(t, components) {
  const overlay = tempDir(t);
  const path = (dir) => posix(relative(overlay, dir));
  let text = `resources: [${path(base)}]\n`;
  if (components.length) {
    text += `components: [${components.map((c) => path(join(base, "components", c))).join(", ")}]\n`;
  }
  writeFileSync(join(overlay, "kustomization.yaml"), text);
  const out = execFileSync("kustomize", [
    "build",
    "--load-restrictor",
    "LoadRestrictionsNone",
    overlay,
  ]);
  return documents(out.toString());
}

// The chart with these values (a file: JSON is YAML).
function helm(t, values = {}) {
  const file = join(tempDir(t), "values.yaml");
  writeFileSync(file, JSON.stringify(values));
  const out = execFileSync("helm", ["template", "deckhand", chart, "-f", file]);
  return documents(out.toString());
}

function helmFails(t, values) {
  const file = join(tempDir(t), "values.yaml");
  writeFileSync(file, JSON.stringify(values));
  const result = spawnSync("helm", ["template", "deckhand", chart, "-f", file]);
  assert.notEqual(result.status, 0, "helm template should refuse these values");
  return result.stderr.toString();
}

// What may differ without changing what Kubernetes does: the generated ConfigMaps' hashes
// (kustomize's and the chart's, each of its own making), the order of the lists kustomize's
// strategic merge patches reorder, which Kubernetes merges by name, and the annotation only Helm
// reads, which keeps the namespaces and claims through `helm uninstall`.
const BY_NAME = new Set(["env", "volumes", "volumeMounts"]);
const KEEP = "helm.sh/resource-policy";
function normalized(object) {
  const text = JSON.stringify(object).replace(
    /"(deckhand-(?:server|env|blobs))-[0-9a-z]{10}"/g,
    '"$1"',
  );
  const copy = JSON.parse(text, (key, value) =>
    BY_NAME.has(key) && Array.isArray(value)
      ? value.toSorted((a, b) => a.name.localeCompare(b.name))
      : value,
  );
  const { annotations } = copy.metadata;
  if (annotations?.[KEEP] === "keep") {
    delete annotations[KEEP];
    if (!Object.keys(annotations).length) delete copy.metadata.annotations;
  }
  return copy;
}
const keyOf = (o) => `${o.kind} ${o.metadata.namespace ?? ""}/${o.metadata.name}`;
const byKey = (list) => new Map(list.map(normalized).map((o) => [keyOf(o), o]));

const named = (list, kind, name) => list.find((o) => o.kind === kind && o.metadata.name === name);
const deployments = (list) => list.filter((o) => o.kind === "Deployment");
const envOf = (list) =>
  list.find((o) => o.kind === "ConfigMap" && o.metadata.name.startsWith("deckhand-env-")).data;

// Each component's values, and the combinations rendered: each alone, and all of them.
const COMPONENTS = {
  redis: { store: "redis" },
  buildkit: { buildkit: { enabled: true } },
  engine: { engine: { enabled: true } },
  blobs: { blobs: { enabled: true } },
};
const COMBINATIONS = [
  [],
  ["redis"],
  ["buildkit"],
  ["engine"],
  ["blobs"],
  ["redis", "buildkit", "engine", "blobs"],
];

test("helm: every component of the base has its values in the chart", () => {
  const dirs = readdirSync(join(base, "components"), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  assert.deepEqual(dirs.sort(), Object.keys(COMPONENTS).sort());
});

for (const components of COMBINATIONS) {
  const values = Object.assign({}, ...components.map((c) => COMPONENTS[c]));
  const what = components.length ? `with ${components.join(" and ")}` : "alone";
  test(`helm: the chart renders what kustomize does, the base ${what}`, { skip }, (t) => {
    const expected = byKey(kustomize(t, components));
    const actual = byKey(helm(t, values));
    assert.deepEqual([...actual.keys()].sort(), [...expected.keys()].sort());
    for (const [key, object] of expected) assert.deepEqual(actual.get(key), object, key);
  });
}

test(
  "helm: `helm uninstall` keeps the namespaces, the claims and the sandboxes' isolation; an upgrade keeps the old ConfigMaps",
  { skip },
  (t) => {
    const kept = helm(t, { store: "redis" })
      .filter((o) => o.metadata.annotations?.[KEEP] === "keep")
      .map((o) => keyOf(o).replace(/-[0-9a-f]{10}$/, ""))
      .sort();
    assert.deepEqual(kept, [
      "ConfigMap deckhand/deckhand-env",
      "ConfigMap deckhand/deckhand-server",
      "Namespace /deckhand",
      "Namespace /deckhand-sandboxes",
      "NetworkPolicy deckhand-sandboxes/deckhand-default-deny",
      "NetworkPolicy deckhand-sandboxes/deckhand-installs",
      "NetworkPolicy deckhand-sandboxes/deckhand-sandboxes",
      "PersistentVolumeClaim deckhand/egress-cache",
      "PersistentVolumeClaim deckhand/orchestrator-data",
      "PersistentVolumeClaim deckhand/orchestrator-screenshots",
      "PersistentVolumeClaim deckhand/runner-data",
    ]);
  },
);

test("helm: image.tag is every service's tag and the sandboxes'", { skip }, (t) => {
  const objects = helm(t, {
    image: { tag: "v1.2.3" },
    store: "redis",
    buildkit: { enabled: true },
  });
  const images = deployments(objects).flatMap((d) => d.spec.template.spec.containers);
  for (const { image } of images.filter((c) => c.image.startsWith("ghcr.io/bryansmee/"))) {
    assert.match(image, /^ghcr\.io\/bryansmee\/deckhand-[a-z]+:v1\.2\.3$/);
  }
  assert.equal(images.filter((c) => c.image.endsWith(":v1.2.3")).length, 8);
  assert.equal(envOf(objects).SANDBOX_IMAGE, "ghcr.io/bryansmee/deckhand-sandbox:v1.2.3");
  // The engine's image too, at the same release.
  const engine = helm(t, { image: { tag: "v1.2.3" }, engine: { enabled: true } });
  assert.equal(envOf(engine).ENGINE_IMAGE, "ghcr.io/bryansmee/deckhand-engine:v1.2.3");
  // One of its own, from a mirror.
  const mirrored = helm(t, { image: { sandbox: "registry.example.com/sandbox@sha256:abc" } });
  assert.equal(envOf(mirrored).SANDBOX_IMAGE, "registry.example.com/sandbox@sha256:abc");
});

test(
  "helm: config.yaml and the grants reach the services that read them, and a change restarts them",
  { skip },
  (t) => {
    const server = {
      config: "allowed_users: [someone]\n",
      grants: {
        "default.yaml": "hosts: []\n",
        "a/b-c.yaml": "hosts: [a.example]\n",
        "a-b/c.yaml": "hosts: [b.example]\n",
      },
    };
    const objects = helm(t, { server });
    const map = objects.find(
      (o) => o.kind === "ConfigMap" && o.metadata.name.startsWith("deckhand-server-"),
    );
    // Each grant mounted at its path, from a key of its own: a/b-c.yaml and a-b/c.yaml, which
    // a slash turned into a dash would give one key, keep their own files.
    const grantsOf = (items) =>
      Object.fromEntries(items.map(({ key, path }) => [path, map.data[key]]));
    assert.equal(map.data["config.yaml"], server.config);
    assert.equal(map.data["default.yaml"], server.grants["default.yaml"]);
    assert.equal(Object.keys(map.data).length, 4);
    for (const key of Object.keys(map.data).filter((k) => k.includes("-"))) {
      assert.match(key, /^[0-9a-f]{8}\.[a-z-]+\.yaml$/);
    }
    for (const d of deployments(objects)) {
      const volume = d.spec.template.spec.volumes.find((v) => v.name === "server");
      if (!volume) continue;
      const { name, items } = volume.projected.sources[0].configMap;
      assert.equal(name, map.metadata.name, d.metadata.name);
      const grants = ["orchestrator", "runner", "github", "policy"].includes(d.metadata.name);
      assert.deepEqual(
        grantsOf(items),
        {
          "config.yaml": server.config,
          ...(grants
            ? Object.fromEntries(
                Object.entries(server.grants).map(([path, text]) => [`grants/${path}`, text]),
              )
            : {}),
        },
        d.metadata.name,
      );
    }
    // A grant whose key another file already has is refused, never mounted in its place.
    assert.match(
      helmFails(t, { server: { grants: { "config.yaml": "hosts: []\n" } } }),
      /already taken/,
    );
    // Another config.yaml, another name: the pods that mount it roll.
    const changed = helm(t, { server: { ...server, config: "allowed_users: [other]\n" } });
    const renamed = changed.find(
      (o) => o.kind === "ConfigMap" && o.metadata.name.startsWith("deckhand-server-"),
    );
    assert.notEqual(renamed.metadata.name, map.metadata.name);
  },
);

test(
  "helm: env, the sandboxes' storage classes and the registry go to deckhand-env",
  { skip },
  (t) => {
    const objects = helm(t, {
      env: { MAX_PARALLEL: 4, KUBERNETES_SESSION_SIZE: "20Gi" },
      sandboxes: { storageClass: "fast", cacheStorageClass: "nfs", agentStorageClass: "nfs" },
      buildkit: { enabled: true, noProxy: "registry.deckhand.svc" },
      registry: { url: "registry.example.com/deckhand", secretName: "pull" },
    });
    const env = envOf(objects);
    assert.equal(env.MAX_PARALLEL, "4");
    assert.equal(env.KUBERNETES_SESSION_SIZE, "20Gi");
    assert.equal(env.KUBERNETES_STORAGE_CLASS, "fast");
    assert.equal(env.KUBERNETES_CACHE_STORAGE_CLASS, "nfs");
    assert.equal(env.KUBERNETES_AGENT_STORAGE_CLASS, "nfs");
    assert.equal(env.KUBERNETES_REGISTRY, "registry.example.com/deckhand");
    assert.equal(env.KUBERNETES_REGISTRY_SECRET, "pull");
    // The Roles name that Secret alone.
    const roles = objects.filter((o) => o.kind === "Role");
    assert.equal(roles.length, 2);
    for (const role of roles) {
      assert.deepEqual(role.rules.at(-1).resourceNames, ["pull"], role.metadata.namespace);
    }
    const buildkit = named(objects, "Deployment", "buildkitd").spec.template.spec.containers[0];
    assert.equal(buildkit.env.find((e) => e.name === "NO_PROXY").value, "registry.deckhand.svc");
    // Unset, none of them is.
    const defaults = envOf(helm(t));
    for (const key of ["KUBERNETES_STORAGE_CLASS", "KUBERNETES_REGISTRY", "KUBERNETES_BUILDKIT"]) {
      assert.equal(defaults[key], undefined, key);
    }
  },
);

test("helm: the services' claims take the storage class and sizes given", { skip }, (t) => {
  const claims = (values) =>
    Object.fromEntries(
      helm(t, values)
        .filter((o) => o.kind === "PersistentVolumeClaim")
        .map((c) => [c.metadata.name, c.spec]),
    );
  const file = claims({ persistence: { storageClass: "ssd", sizes: { "github-data": "50Gi" } } });
  assert.equal(Object.keys(file).length, 8);
  for (const [name, spec] of Object.entries(file)) {
    assert.equal(spec.storageClassName, "ssd", name);
    assert.deepEqual(spec.accessModes, ["ReadWriteOnce"], name);
  }
  assert.equal(file["github-data"].resources.requests.storage, "50Gi");
  assert.equal(file["edge-data"].resources.requests.storage, "1Gi");
  // With Redis: the shared ones ReadWriteMany, on their class; the stores' claims gone.
  const values = {
    store: "redis",
    persistence: { storageClass: "ssd", sharedStorageClass: "nfs" },
    redis: { storageClass: "fast", size: "8Gi" },
  };
  const redis = claims(values);
  assert.deepEqual(Object.keys(redis).sort(), [
    "egress-cache",
    "orchestrator-data",
    "orchestrator-screenshots",
    "runner-data",
  ]);
  assert.equal(redis["egress-cache"].storageClassName, "ssd");
  for (const name of ["orchestrator-data", "orchestrator-screenshots", "runner-data"]) {
    assert.deepEqual(redis[name].accessModes, ["ReadWriteMany"], name);
    assert.equal(redis[name].storageClassName, "nfs", name);
  }
  const [template] = named(helm(t, values), "StatefulSet", "redis").spec.volumeClaimTemplates;
  assert.equal(template.spec.storageClassName, "fast");
  assert.equal(template.spec.resources.requests.storage, "8Gi");
});

test("helm: the ingress sends the host to edge's public port alone", { skip }, (t) => {
  assert.equal(named(helm(t), "Ingress", "edge"), undefined);
  const ingress = named(
    helm(t, {
      ingress: {
        enabled: true,
        className: "nginx",
        host: "deckhand.example.com",
        annotations: { "cert-manager.io/cluster-issuer": "letsencrypt" },
        tlsSecretName: "deckhand-tls",
      },
    }),
    "Ingress",
    "edge",
  );
  assert.equal(ingress.metadata.namespace, "deckhand");
  assert.equal(ingress.metadata.annotations["cert-manager.io/cluster-issuer"], "letsencrypt");
  assert.equal(ingress.spec.ingressClassName, "nginx");
  assert.deepEqual(ingress.spec.tls, [
    { hosts: ["deckhand.example.com"], secretName: "deckhand-tls" },
  ]);
  const [rule] = ingress.spec.rules;
  assert.equal(rule.host, "deckhand.example.com");
  assert.deepEqual(rule.http.paths, [
    {
      path: "/",
      pathType: "Prefix",
      backend: { service: { name: "edge", port: { name: "http" } } },
    },
  ]);
  assert.match(helmFails(t, { ingress: { enabled: true } }), /ingress\.host/);
});

test(
  "helm: other namespaces leave none of the defaults' behind, and the sandboxes still pass the runner's check",
  { skip },
  (t) => {
    const objects = helm(t, {
      namespaces: { services: "dh", sandboxes: "dh-runs" },
      metrics: { namespace: "dh-monitoring" },
      store: "redis",
      buildkit: { enabled: true },
    });
    // Every namespace named, wherever: the objects', the peers', the subjects'.
    const text = JSON.stringify(objects);
    const mentioned = [
      ...text.matchAll(/"(?:namespace|kubernetes\.io\/metadata\.name)":"([^"]+)"/g),
    ];
    assert.deepEqual([...new Set(mentioned.map((m) => m[1]))].sort(), [
      "dh",
      "dh-monitoring",
      "dh-runs",
      "kube-system",
    ]);
    const namespaces = objects.filter((o) => o.kind === "Namespace").map((o) => o.metadata.name);
    assert.deepEqual(namespaces.sort(), ["dh", "dh-runs"]);
    for (const o of objects.filter((o) => o.metadata.namespace)) {
      assert.ok(["dh", "dh-runs"].includes(o.metadata.namespace), keyOf(o));
    }
    const policies = objects.filter(
      (o) => o.kind === "NetworkPolicy" && o.metadata.namespace === "dh-runs",
    );
    const proxy = { namespace: "dh", selector: named(objects, "Service", "egress").spec.selector };
    assert.equal(isolationProblem(policies, { "deckhand.role": "sandbox" }, { proxy }), null);
    assert.equal(isolationProblem(policies, { "deckhand.role": "install" }, { proxy }), null);
    const broker = named(objects, "Deployment", "broker").spec.template.spec.containers[0];
    assert.match(
      broker.env.find((e) => e.name === "SERVICE_ACCOUNTS").value,
      /^edge=dh:deckhand-edge,/,
    );
    assert.equal(envOf(objects).KUBERNETES_NAMESPACE, "dh-runs");
    assert.equal(envOf(objects).KUBERNETES_SERVICES_NAMESPACE, "dh");
    // Made elsewhere: none of the chart's.
    const without = helm(t, { namespaces: { create: false } });
    assert.equal(without.filter((o) => o.kind === "Namespace").length, 0);
  },
);

test(
  "helm: the API server's addresses are the runner's and the broker's way out",
  { skip },
  (t) => {
    const objects = helm(t, { apiServer: { cidrs: ["172.18.0.2/32", "172.18.0.3/32"] } });
    const policy = named(objects, "NetworkPolicy", "deckhand-api-server");
    assert.deepEqual(policy.spec.egress[0].to, [
      { ipBlock: { cidr: "172.18.0.2/32" } },
      { ipBlock: { cidr: "172.18.0.3/32" } },
    ]);
    assert.match(helmFails(t, { apiServer: { cidrs: [] } }), /apiServer\.cidrs/);
  },
);

test(
  "helm: blob storage's URL, Secret and address reach the runner and the broker alone",
  { skip },
  (t) => {
    const blobs = {
      enabled: true,
      url: "s3://deckhand?endpoint=http://garage.blobs:3900&region=garage",
      secretName: "garage-key",
      to: [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "blobs" } } }],
      ports: [3900],
    };
    const objects = helm(t, { blobs });
    const map = objects.find(
      (o) => o.kind === "ConfigMap" && o.metadata.name.startsWith("deckhand-blobs-"),
    );
    assert.deepEqual(map.data, { BLOB_URL: blobs.url });
    for (const d of deployments(objects)) {
      const spec = d.spec.template.spec;
      const text = JSON.stringify(spec);
      if (!["runner", "broker"].includes(d.metadata.name)) {
        assert.ok(!/BLOB_|garage-key|deckhand-blobs/.test(text), d.metadata.name);
        continue;
      }
      const env = spec.containers[0].env;
      assert.equal(
        env.find((e) => e.name === "BLOB_URL").valueFrom.configMapKeyRef.name,
        map.metadata.name,
      );
      assert.equal(spec.volumes.find((v) => v.name === "blobs").secret.secretName, "garage-key");
    }
    assert.ok(!("BLOB_URL" in envOf(objects)));
    const policy = named(objects, "NetworkPolicy", "deckhand-blobs");
    assert.deepEqual(policy.spec.egress, [
      { to: blobs.to, ports: [{ port: 3900, protocol: "TCP" }] },
    ]);
    // Off: none of it.
    const off = helm(t);
    assert.equal(named(off, "NetworkPolicy", "deckhand-blobs"), undefined);
    assert.ok(!JSON.stringify(off).includes("BLOB_"));
  },
);

test(
  "helm: metrics.port everywhere the base says 9464, metrics.namespace the port's only peer, and a ServiceMonitor or VMServiceScrape",
  { skip },
  (t) => {
    const objects = helm(t, { metrics: { port: 9500, namespace: "observability" } });
    const services = deployments(objects).filter((d) => d.metadata.name !== "buildkitd");
    assert.equal(services.length, 8);
    for (const d of services) {
      const { metadata, spec } = d.spec.template;
      assert.equal(metadata.annotations["prometheus.io/port"], "9500", d.metadata.name);
      const [main] = spec.containers;
      assert.equal(main.env.find((e) => e.name === "METRICS_PORT").value, "9500");
      assert.equal(main.ports.find((p) => p.name === "metrics").containerPort, 9500);
      const service = named(objects, "Service", d.metadata.name);
      assert.equal(service.spec.ports.find((p) => p.name === "metrics").port, 9500);
    }
    const policy = named(objects, "NetworkPolicy", "deckhand-metrics");
    assert.deepEqual(policy.spec.ingress, [
      {
        from: [
          {
            namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "observability" } },
          },
        ],
        ports: [{ port: 9500, protocol: "TCP" }],
      },
    ]);
    assert.ok(!JSON.stringify(objects).includes("9464"));
    // deckhand-env can't set it apart from the rest.
    assert.match(
      helmFails(t, { env: { METRICS_PORT: "1" } }),
      /env\.METRICS_PORT: .*metrics\.port/,
    );
    // Off by default: no CRD needed.
    assert.ok(!helm(t).some((o) => /Monitor|Scrape/.test(o.kind)));
    for (const [kind, apiVersion] of [
      ["ServiceMonitor", "monitoring.coreos.com/v1"],
      ["VMServiceScrape", "operator.victoriametrics.com/v1beta1"],
    ]) {
      const serviceMonitor = { enabled: true, kind, labels: { release: "kps" }, interval: "30s" };
      const monitor = named(helm(t, { metrics: { serviceMonitor } }), kind, "deckhand");
      assert.equal(monitor.apiVersion, apiVersion);
      assert.equal(monitor.metadata.namespace, "deckhand");
      assert.equal(monitor.metadata.labels.release, "kps");
      assert.deepEqual(monitor.spec, {
        jobLabel: "app.kubernetes.io/part-of",
        selector: { matchLabels: { "app.kubernetes.io/part-of": "deckhand" } },
        namespaceSelector: { matchNames: ["deckhand"] },
        endpoints: [{ port: "metrics", path: "/metrics", honorLabels: true, interval: "30s" }],
      });
    }
    // Never a service's own port, which deckhand-metrics would open to the monitoring namespace.
    for (const port of [3128, 3129, 8080, 8081, 8082, 8083, 8181]) {
      assert.match(
        helmFails(t, { metrics: { port } }),
        /metrics\.port: \d+ is a service's own port/,
      );
    }
    // Never the sandboxes' namespace, nor the services' (every pod of it, BuildKit's too).
    for (const namespace of ["deckhand-sandboxes", "deckhand", ""]) {
      assert.match(helmFails(t, { metrics: { namespace } }), /metrics\.namespace/);
    }
    assert.match(
      helmFails(t, { metrics: { serviceMonitor: { enabled: true, kind: "PodMonitor" } } }),
      /metrics\.serviceMonitor\.kind/,
    );
  },
);

test(
  "helm: the Grafana dashboard and the alert rules, deploy/'s files, off by default",
  { skip },
  (t) => {
    const dashboard = readFileSync(join(repo, "deploy", "grafana", "deckhand.json"), "utf8");
    const rules = parseYaml(readFileSync(join(repo, "deploy", "alerts", "deckhand.yaml"), "utf8"));
    // Off by default: no CRD needed, no ConfigMap for a Grafana that isn't there.
    const none = helm(t);
    assert.ok(!named(none, "ConfigMap", "deckhand-grafana-dashboard"));
    assert.ok(!none.some((o) => /Rule$/.test(o.kind)));

    const labels = { grafana_dashboard: "1" };
    const shipped = helm(t, { metrics: { dashboard: { enabled: true } } });
    const map = named(shipped, "ConfigMap", "deckhand-grafana-dashboard");
    assert.equal(map.metadata.namespace, "deckhand");
    assert.deepEqual(map.metadata.labels, { "app.kubernetes.io/part-of": "deckhand", ...labels });
    assert.deepEqual(JSON.parse(map.data["deckhand.json"]), JSON.parse(dashboard));
    // The sidecar's namespace, label and folder, as given.
    const elsewhere = named(
      helm(t, {
        metrics: {
          dashboard: {
            enabled: true,
            namespace: "monitoring",
            labels: { grafana_dashboard: "deckhand" },
            annotations: { grafana_folder: "Deckhand" },
          },
        },
      }),
      "ConfigMap",
      "deckhand-grafana-dashboard",
    );
    assert.equal(elsewhere.metadata.namespace, "monitoring");
    assert.equal(elsewhere.metadata.labels.grafana_dashboard, "deckhand");
    assert.deepEqual(elsewhere.metadata.annotations, { grafana_folder: "Deckhand" });

    for (const [kind, apiVersion] of [
      ["PrometheusRule", "monitoring.coreos.com/v1"],
      ["VMRule", "operator.victoriametrics.com/v1beta1"],
    ]) {
      const ruleValues = { enabled: true, kind, labels: { release: "kps" } };
      const values = { metrics: { rules: ruleValues, serviceMonitor: { enabled: true } } };
      const rule = named(helm(t, values), kind, "deckhand");
      assert.equal(rule.apiVersion, apiVersion);
      assert.equal(rule.metadata.namespace, "deckhand");
      assert.equal(rule.metadata.labels.release, "kps");
      assert.deepEqual(rule.spec, rules);
    }
    assert.match(
      helmFails(t, { metrics: { rules: { enabled: true, kind: "AlertingRule", job: "x" } } }),
      /metrics\.rules\.kind/,
    );
    // DeckhandServiceDown's job: the ServiceMonitor's, or the scrape job's given, never none
    // (a critical alert matching nothing) nor another than the ServiceMonitor's.
    const serviceDown = (objects) =>
      named(objects, "PrometheusRule", "deckhand")
        .spec.groups.flatMap((g) => g.rules)
        .find((r) => r.alert === "DeckhandServiceDown").expr;
    const job = "kubernetes-pods";
    assert.equal(
      serviceDown(helm(t, { metrics: { rules: { enabled: true, job } } })),
      'up{job="kubernetes-pods"} == 0',
    );
    assert.match(helmFails(t, { metrics: { rules: { enabled: true } } }), /metrics\.rules\.job/);
    assert.match(
      helmFails(t, {
        metrics: { rules: { enabled: true, job }, serviceMonitor: { enabled: true } },
      }),
      /metrics\.rules\.job: "kubernetes-pods"/,
    );
  },
);

test("helm: values that can't work are refused", { skip }, (t) => {
  assert.match(helmFails(t, { store: "postgres" }), /store/);
  assert.match(
    helmFails(t, { namespaces: { services: "deckhand", sandboxes: "deckhand" } }),
    /namespace each/,
  );
  // The registry without BuildKit, which alone reads it; an engine without its RuntimeClass.
  assert.match(helmFails(t, { registry: { url: "registry.example.com" } }), /buildkit\.enabled/);
  assert.match(
    helmFails(t, { engine: { enabled: true, runtimeClass: "" } }),
    /engine\.runtimeClass/,
  );
  assert.match(helmFails(t, { blobs: { enabled: true, url: "" } }), /blobs\.url/);
  assert.match(helmFails(t, { blobs: { enabled: true, to: [] } }), /blobs\.to/);
  // What the chart sets in deckhand-env itself, which its Roles and policies agree with.
  for (const [name, value] of [
    ["KUBERNETES_NAMESPACE", "namespaces.sandboxes"],
    ["KUBERNETES_REGISTRY_SECRET", "registry.secretName"],
    ["SANDBOX_IMAGE", "image.sandbox"],
    ["RUNNER", "the chart itself"],
    ["SANDBOX_ENGINE", "engine.enabled"],
    ["ENGINE_IMAGE", "engine.image"],
    // Blob storage's, which deckhand-env would give the orchestrator and the models service.
    ["BLOB_URL", "blobs.url"],
    ["BLOB_SECRET_ACCESS_KEY", "blobs.secretName"],
  ]) {
    assert.match(helmFails(t, { env: { [name]: "x" } }), new RegExp(`env\\.${name}: .*${value}`));
  }
});
