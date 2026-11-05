// deploy/kubernetes/check-isolation.sh against a fake kubectl (fixtures/fake-kubectl.sh says how
// it plays a cluster), #728: what it concludes from each answer, and that every target is still
// reported when a kubectl forwards its stdin (a `docker exec -i` wrapper, as
// deploy/kubernetes-e2e's), which a call without </dev/null let eat the loop's targets.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { needsBash, scriptEnv, tempDir } from "./helpers.mjs";

const script = join(import.meta.dirname, "..", "deploy", "kubernetes", "check-isolation.sh");

// Runs the script against a cluster made of `files` (fake-kubectl.sh's) → { code, out, err, calls,
// dir }.
function check(t, files) {
  const dir = tempDir(t);
  symlinkSync(join(import.meta.dirname, "fixtures", "fake-kubectl.sh"), join(dir, "kubectl"));
  for (const [name, lines] of Object.entries(files)) writeFileSync(join(dir, name), lines);
  const result = spawnSync("sh", [script], {
    env: scriptEnv(t, { PATH: `${dir}${delimiter}${process.env.PATH}` }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    code: result.status,
    out: result.stdout.toString(),
    err: result.stderr.toString(),
    calls: readFileSync(join(dir, "kubectl-calls"), "utf8"),
    dir,
  };
}

// Deckhand's pods, each with a port or two, as `get pods` lists them.
const TARGETS =
  "edge-1@10.42.0.1:8080 edge-1@10.42.0.1:9464 orchestrator-1@10.42.0.2:8080 " +
  "github-1@10.42.0.3:8080 runner-1@10.42.0.4:8080 egress-1@10.42.0.5:3128 " +
  "broker-1@10.42.0.6:8080 models-1@10.42.0.7:8080\n";
// An isolated cluster: the proxy reached, the rest out of reach, refused where a plugin rejects
// the connection (some do), or where nothing listens.
const ISOLATED = {
  targets: TARGETS,
  reach: [
    "10.43.0.10:3128 reached",
    "10.42.0.5:3128 reached",
    "1.1.1.1:443 refused",
    "10.42.0.99:8080 refused",
    "10.42.0.1:8080 refused",
    "10.42.0.1:9464 refused",
    "10.42.0.2:8080 refused",
    "10.42.0.3:8080 refused",
    "",
  ].join("\n"),
  // edge-1 listens on both its ports, orchestrator-1 on none; github-1 has only nc.
  listens: [
    "edge-1 8080 node yes",
    "edge-1 9464 node yes",
    "orchestrator-1 8080 node no",
    "github-1 8080 nc yes",
    "",
  ].join("\n"),
};

test(
  "an isolated cluster passes, every target reported, each pod asked with its stdin closed",
  { skip: needsBash },
  (t) => {
    const result = check(t, ISOLATED);
    assert.equal(result.code, 0, result.out + result.err);
    const lines = result.out.trim().split("\n");
    assert.deepEqual(lines, [
      "ok    10.43.0.10:3128 reached",
      "ok    1.1.1.1:443 out-of-reach",
      "ok    10.42.0.99:8080 (another sandbox) out-of-reach",
      // Refused, and the pod says it listens: a policy refused it.
      "ok    10.42.0.1:8080 out-of-reach",
      "ok    10.42.0.1:9464 out-of-reach",
      "ok    10.42.0.2:8080 not listening (orchestrator-1): not checked",
      "ok    10.42.0.3:8080 out-of-reach",
      "ok    10.42.0.4:8080 out-of-reach",
      "ok    10.42.0.5:3128 reached",
      "ok    10.42.0.6:8080 out-of-reach",
      "ok    10.42.0.7:8080 out-of-reach",
      "Isolated: a sandbox reaches the egress proxy alone, and no other sandbox.",
    ]);
    // Each refused port asked of its own pod, github-1's with nc once node failed.
    assert.match(result.calls, /exec edge-1 -- node -e .* 127\.0\.0\.1:9464/s);
    assert.match(result.calls, /exec github-1 -- nc -z -w 3 127\.0\.0\.1 8080/);
    // The sandbox and its peer, created with a sandbox's labels, then deleted.
    const applied = readFileSync(join(result.dir, "applied"), "utf8");
    assert.equal(applied.match(/^ {4}deckhand\.role: sandbox$/gm)?.length, 2);
    assert.match(result.calls, /delete pod deckhand-isolation-check deckhand-isolation-peer/);
  },
);

test("a service's port a sandbox reaches fails the check", { skip: needsBash }, (t) => {
  const result = check(t, { ...ISOLATED, reach: ISOLATED.reach + "10.42.0.6:8080 reached\n" });
  assert.equal(result.code, 1);
  assert.match(result.out, /^FAIL  10\.42\.0\.6:8080 reached \(expected: out-of-reach\)$/m);
  // The rest still checked.
  assert.match(result.out, /^ok    10\.42\.0\.7:8080 out-of-reach$/m);
  assert.match(result.err, /NOT isolated/);
});

test("another sandbox reached, or the internet, fails the check", { skip: needsBash }, (t) => {
  const reach = "10.43.0.10:3128 reached\n10.42.0.99:8080 reached\n1.1.1.1:443 reached\n";
  const result = check(t, { targets: TARGETS, reach });
  assert.equal(result.code, 1);
  assert.match(result.out, /^FAIL  10\.42\.0\.99:8080 \(another sandbox\) reached/m);
  assert.match(result.out, /^FAIL  1\.1\.1\.1:443 reached/m);
});

test("the egress proxy out of reach fails the check", { skip: needsBash }, (t) => {
  const result = check(t, { targets: TARGETS });
  assert.equal(result.code, 1);
  assert.match(result.out, /^FAIL  10\.43\.0\.10:3128 out-of-reach \(expected: reached\)$/m);
});

test(
  "a refused port whose pod can't say whether it listens fails closed",
  { skip: needsBash },
  (t) => {
    const result = check(t, {
      ...ISOLATED,
      reach: ISOLATED.reach + "10.42.0.7:8080 refused\n",
      listens: ISOLATED.listens + "models-1 8080 none yes\n",
    });
    assert.equal(result.code, 1);
    assert.match(
      result.out,
      /^FAIL  10\.42\.0\.7:8080 refused, and models-1 has neither node nor nc/m,
    );
  },
);

test(
  "the engines' port: the proxy's reached when published, another pod's still out of reach",
  { skip: needsBash },
  (t) => {
    const result = check(t, {
      ...ISOLATED,
      engines: "",
      targets: TARGETS.trim() + " egress-1@10.42.0.5:3129 runner-1@10.42.0.4:3129\n",
      reach: ISOLATED.reach + "10.43.0.10:3129 reached\n10.42.0.5:3129 reached\n",
    });
    assert.equal(result.code, 0, result.out + result.err);
    assert.match(result.out, /^ok    10\.43\.0\.10:3129 reached$/m);
    assert.match(result.out, /^ok    10\.42\.0\.5:3129 reached$/m);
    assert.match(result.out, /^ok    10\.42\.0\.4:3129 out-of-reach$/m);

    // Not published: the proxy's pod reaching 3129 is a hole.
    const unpublished = check(t, {
      ...ISOLATED,
      targets: TARGETS.trim() + " egress-1@10.42.0.5:3129\n",
      reach: ISOLATED.reach + "10.42.0.5:3129 reached\n",
    });
    assert.equal(unpublished.code, 1);
    assert.match(unpublished.out, /^FAIL  10\.42\.0\.5:3129 reached \(expected: out-of-reach\)$/m);
    assert.doesNotMatch(unpublished.calls, /exec deckhand-isolation-check .*10\.43\.0\.10:3129/s);
  },
);

test("no running pod with a port: Deckhand isn't deployed", { skip: needsBash }, (t) => {
  const result = check(t, {});
  assert.equal(result.code, 1);
  assert.match(result.err, /No running pod with a port in deckhand/);
  assert.doesNotMatch(result.calls, /apply/);
});
