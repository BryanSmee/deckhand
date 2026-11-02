// The container engine sidecar's options (runner/engine.mjs): what each backend relaxes, and
// that none is ever privileged or gets the host's Docker.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  engineArgs,
  engineBackend,
  engineEnv,
  engineName,
  engineProxy,
  engineVolume,
  kubernetesEngine,
} from "../listener/runner/engine.mjs";

const limits = { cpus: "1.5", memory: "2g", pids: 512 };

test("engineArgs: Sysbox's runtime, nothing relaxed; Podman's relaxations; both limited", () => {
  const sysbox = engineArgs("sysbox", { volume: "v", limits }).join(" ");
  const podman = engineArgs("podman", { volume: "v", limits }).join(" ");
  assert.match(sysbox, /^--runtime sysbox-runc /);
  assert.doesNotMatch(sysbox, /unconfined|--device/);
  assert.match(podman, /seccomp=unconfined.*apparmor=unconfined.*--device \/dev\/fuse/);
  for (const args of [sysbox, podman]) {
    assert.doesNotMatch(args, /--privileged|docker\.sock|--network host|--pid |--cap-add/);
    assert.match(args, /--cpus 1\.5 --memory 2g --memory-swap 2g --pids-limit 512/);
  }
  assert.match(sysbox, /type=volume,src=v,dst=\/var\/lib\/docker$/);
  assert.match(podman, /type=volume,src=v,dst=\/home\/podman\/\.local\/share\/containers$/);
});

test("engineBackend: auto prefers Sysbox; sysbox without its runtime is an error", () => {
  assert.equal(engineBackend("auto", ["runc", "sysbox-runc"]), "sysbox");
  assert.equal(engineBackend("auto", ["runc"]), "podman");
  assert.equal(engineBackend("sysbox", ["sysbox-runc"]), "sysbox");
  assert.equal(engineBackend("podman", ["sysbox-runc"]), "podman");
  assert.throws(() => engineBackend("sysbox", ["runc"]), /no sysbox-runc runtime/);
});

test("engineEnv, names", () => {
  assert.deepEqual(engineEnv("sysbox"), { DOCKER_HOST: "tcp://engine:2375" });
  assert.deepEqual(engineEnv("podman"), { DOCKER_HOST: "tcp://engine:2375", DOCKER_BUILDKIT: "0" });
  assert.equal(engineName("dh-org-repo-1-abc"), "dh-org-repo-1-abc-engine");
  assert.equal(engineVolume("dh-org-repo-1-abc-123"), "dh-org-repo-1-abc-123-engine");
});

test("kubernetesEngine: Sysbox's RuntimeClass, and SANDBOX_ENGINE sysbox or auto; never Podman", () => {
  const kube = (engine, engineRuntimeClass) => ({ engine, kubernetes: { engineRuntimeClass } });
  assert.equal(kubernetesEngine(kube("sysbox", "sysbox-runc")), true);
  assert.equal(kubernetesEngine(kube("auto", "sysbox-runc")), true);
  assert.equal(kubernetesEngine(kube("podman", "sysbox-runc")), false);
  assert.equal(kubernetesEngine(kube(null, "sysbox-runc")), false);
  assert.equal(kubernetesEngine(kube("sysbox", null)), false);
  assert.equal(kubernetesEngine({ engine: "sysbox" }), false);
});

test("engineProxy: the egress proxy on its engines' port", () => {
  assert.equal(engineProxy("http://egress:3128"), "http://egress:3129");
  assert.equal(engineProxy("http://egress"), "http://egress:3129");
  assert.equal(engineProxy("http://10.96.0.11:8080/"), "http://10.96.0.11:3129");
});
