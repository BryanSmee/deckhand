// deploy/kubernetes-e2e's overlay rendered (#676), so a change to the base that breaks it shows
// here rather than in the next run of run.sh: what it installs stays within what run.sh's guard
// checks and deletes, and its patches still land (a patch whose target matches nothing is
// skipped by kustomize without a word). Needs kustomize on the PATH, which CI's kubernetes job
// installs and where a skip fails the job; elsewhere these tests skip.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parseYaml } from "../lib/yaml.mjs";

const repo = join(import.meta.dirname, "..");
const overlay = join(repo, "deploy", "kubernetes-e2e");
const skip =
  spawnSync("kustomize", ["version"], { stdio: "ignore" }).error && "no kustomize on the PATH";

function render() {
  const out = execFileSync("kustomize", ["build", overlay]).toString();
  return out
    .split(/^---$/m)
    .map((part) => parseYaml(part))
    .filter(Boolean);
}

// run.sh's guard: the namespaces and the one cluster-scoped binding it checks before it touches
// them, and deletes at the end.
function guard() {
  const script = readFileSync(join(overlay, "run.sh"), "utf8");
  const namespaces = script
    .match(/^NAMESPACES=\(([^)]*)\)$/m)?.[1]
    .split(/\s+/)
    .filter(Boolean);
  const binding = script.match(/^BINDING=(\S+)$/m)?.[1];
  assert.ok(namespaces?.length && binding, "run.sh's NAMESPACES and BINDING");
  return { namespaces, binding };
}

const id = (o) =>
  `${o.kind}/${o.metadata.namespace ? `${o.metadata.namespace}/` : ""}${o.metadata.name}`;
const deployment = (objects, name) =>
  objects.find(
    (o) =>
      o.kind === "Deployment" && o.metadata.namespace === "deckhand" && o.metadata.name === name,
  );
const configMap = (objects, prefix) =>
  objects.find(
    (o) =>
      o.kind === "ConfigMap" &&
      o.metadata.namespace === "deckhand" &&
      new RegExp(`^${prefix}-[0-9a-z]{10}$`).test(o.metadata.name),
  );

test("the overlay installs only what run.sh's guard checks, all labelled", { skip }, () => {
  const { namespaces, binding } = guard();
  for (const o of render()) {
    const { name, namespace, labels } = o.metadata;
    if (namespace) {
      assert.ok(namespaces.includes(namespace), `${id(o)}: a namespace run.sh doesn't check`);
      continue;
    }
    // Cluster-scoped: run.sh refuses a cluster that has one without the label, and deletes them.
    if (o.kind === "Namespace") {
      assert.ok(namespaces.includes(name), `${id(o)}: not in run.sh's NAMESPACES`);
    } else {
      assert.equal(
        o.kind,
        "ClusterRoleBinding",
        `${id(o)}: a cluster-scoped object run.sh doesn't check`,
      );
      assert.equal(name, binding, `${id(o)}: not run.sh's BINDING`);
    }
    assert.equal(labels?.["deckhand.e2e"], "true", `${id(o)}: no label deckhand.e2e=true`);
  }
});

test("the overlay's patches land", { skip }, () => {
  const objects = render();
  for (const name of ["edge", "github", "models"]) {
    const spec = deployment(objects, name)?.spec.template.spec;
    assert.ok(spec, `the base's Deployment ${name}`);
    const env = Object.fromEntries(spec.containers[0].env.map((e) => [e.name, e.value]));
    assert.equal(env.NODE_EXTRA_CA_CERTS, "/etc/e2e-ca/ca.crt", name);
    assert.equal(env.GIT_SSL_CAINFO, "/etc/e2e-ca/ca.crt", name);
    assert.ok(
      spec.containers[0].volumeMounts.some((m) => m.name === "e2e-ca"),
      name,
    );
    assert.ok(
      spec.volumes.some((v) => v.name === "e2e-ca" && v.configMap?.name === "e2e-ca"),
      name,
    );
    if (name !== "models") {
      assert.equal(env.GITHUB_URL, "https://github.deckhand-e2e.svc.cluster.local", name);
      assert.equal(env.GITHUB_API, "https://github.deckhand-e2e.svc.cluster.local/api/v3", name);
    }
  }

  const env = configMap(objects, "deckhand-env");
  assert.ok(env, "the base's ConfigMap deckhand-env, merged");
  assert.equal(env.data.SANDBOX_IMAGE, "ghcr.io/bryansmee/deckhand-sandbox:e2e");
  assert.equal(env.data.ANTHROPIC_BASE_URL, "https://anthropic.deckhand-e2e.svc.cluster.local");
  const server = configMap(objects, "deckhand-server");
  assert.ok(server, "the base's ConfigMap deckhand-server, replaced");
  assert.deepEqual(Object.keys(server.data).toSorted(), ["config.yaml", "default.yaml"]);
  assert.equal(
    server.data["config.yaml"],
    readFileSync(join(overlay, "server", "e2e.yaml"), "utf8"),
  );

  // Every image this checkout's (tag e2e), never one pulled from the registry.
  for (const o of objects) {
    for (const c of o.spec?.template?.spec.containers ?? []) {
      assert.match(c.image, /:e2e$/, `${id(o)}: ${c.image}`);
    }
  }
});
