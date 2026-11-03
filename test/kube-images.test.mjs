// Images on the Kubernetes runner (runner/kube-images.mjs, through ../listener/images.mjs):
// repo images built by buildctl and pushed to a registry, found again by a manifest HEAD and
// pruned through its API; agents installed by a pod of their own into a claim, or left to
// the sandboxes' init containers; caches as claims; and what the egress proxy lets the
// builder and the installs reach. Against recorded fakes of the API, the registry and
// buildctl.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { chmodSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { antigravity } from "../listener/agents/antigravity.mjs";
import { claude } from "../listener/agents/claude.mjs";
import { createImages, imageRef, KEEP_TAGS } from "../listener/images.mjs";
import { buildArgs } from "../listener/runner/buildkit.mjs";
import {
  BUILD_MS,
  builderIsolationProblem,
  createKubernetesImages,
  writable,
} from "../listener/runner/kube-images.mjs";
import { createNetworkGate } from "../listener/runner/kube-gate.mjs";
import { INSTALL_USER } from "../listener/runner/kubernetes.mjs";
import { WRAPPER } from "../listener/runner/kube-seal.mjs";
import { authsOf, challenge, createRegistry, parseRef } from "../listener/runner/registry.mjs";
import { SANDBOX_USER } from "../listener/sandbox-spec.mjs";
import { LOGIN_REFRESH_MS } from "../lib/services.mjs";
import { loginRefresh } from "../runner/service.mjs";
import { buildContext, contextBlob, isRoot, needsBash, tempDir, withBlobs } from "./helpers.mjs";

const REGISTRY = "registry.example.com";
const BASE = "ghcr.io/acme/deckhand-sandbox:1.2";

const config = {
  prefix: "dh",
  image: BASE,
  runner: "kubernetes",
  egressProxy: "http://egress:3128",
  limits: { cpus: "2", memory: "4g", pids: 2048 },
  claudeCodeVolume: "dh-claude-code",
  claudeCodeVersion: "9.9.9",
  agyVolume: "dh-antigravity",
  agyVersion: "1.4.0",
  agySha256: "x64:ab",
  kubernetes: {
    registry: `${REGISTRY}/dh`,
    registrySecret: "pull",
    buildkit: "tcp://buildkitd:1234",
    cacheStorageClass: null,
    cacheSize: "10Gi",
    agentStorageClass: null,
    agentSize: "5Gi",
    pendingMs: 600_000,
  },
};

const PULL = { auths: { [REGISTRY]: { username: "bot", password: "pw" } } };

// An OCI registry over fetch, with token auth: `images` "host/name:tag" → { digest, created },
// the base image there from the start. Every request is in `calls` ("METHOD url"). `deletes`:
// false answers 405, as a registry without deletes does; `tagDeletes`: false refuses to delete a
// tag alone, as registries before OCI distribution 1.1 do.
function fakeRegistry({ deletes = true, tagDeletes = true } = {}) {
  const images = new Map([[BASE, { digest: "sha256:base1", created: 1 }]]);
  const calls = [];
  const tokens = new Set();
  const undated = new Set(); // digests whose config can't be read
  const fetch = async (input, init = {}) => {
    const url = new URL(input);
    const method = init.method ?? "GET";
    calls.push(`${method} ${url.href}`);
    const headers = init.headers ?? {};
    if (url.pathname === "/token") {
      // Credentials for the operator's registry; anonymous elsewhere (a public base image).
      const host = url.searchParams.get("service");
      if (host === REGISTRY && headers.authorization !== `Basic ${btoa("bot:pw")}`) {
        return new Response(null, { status: 401 });
      }
      const token = `t-${tokens.size}`;
      tokens.add(token);
      return Response.json({ token });
    }
    if (!tokens.has(headers.authorization?.replace(/^Bearer /, ""))) {
      return new Response(null, {
        status: 401,
        headers: {
          "www-authenticate": `Bearer realm="https://${url.host}/token",service="${url.host}"`,
        },
      });
    }
    const m = /^\/v2\/(.+)\/(manifests|tags|blobs)\/(.+)$/.exec(url.pathname);
    const [, name, kind, rest] = m;
    const repo = `${url.host}/${name}`;
    if (kind === "tags") {
      const tags = [...images.keys()]
        .filter((ref) => ref.startsWith(`${repo}:`))
        .map((ref) => ref.slice(repo.length + 1))
        .sort();
      if (!tags.length)
        return Response.json({ errors: [{ code: "NAME_UNKNOWN" }] }, { status: 404 });
      return Response.json({ name, tags });
    }
    if (kind === "blobs") {
      const found = [...images.values()].find((i) => `sha256:config-${i.digest}` === rest);
      if (undated.has(found.digest)) return new Response("storage down", { status: 500 });
      return Response.json({ created: new Date(found.created).toISOString() });
    }
    const found = rest.startsWith("sha256:")
      ? [...images.values()].find((i) => i.digest === rest)
      : images.get(`${repo}:${rest}`);
    if (method === "DELETE") {
      if (!deletes) {
        return Response.json(
          { errors: [{ message: "The operation is unsupported." }] },
          { status: 405 },
        );
      }
      // A tag alone, where the registry can (OCI distribution 1.1), or a whole manifest.
      if (!rest.startsWith("sha256:")) {
        if (!tagDeletes)
          return Response.json({ errors: [{ code: "UNSUPPORTED" }] }, { status: 400 });
        images.delete(`${repo}:${rest}`);
        return new Response(null, { status: 202 });
      }
      for (const [ref, image] of images) if (image.digest === rest) images.delete(ref);
      return new Response(null, { status: 202 });
    }
    if (!found) return Response.json({ errors: [{ code: "MANIFEST_UNKNOWN" }] }, { status: 404 });
    const type = "application/vnd.oci.image.manifest.v1+json";
    if (method === "HEAD") {
      return new Response(null, {
        headers: { "docker-content-digest": found.digest, "content-type": type },
      });
    }
    return Response.json(
      { config: { digest: `sha256:config-${found.digest}` } },
      { headers: { "content-type": type } },
    );
  };
  return { fetch, images, calls, undated };
}

// Deckhand's policies for the BuildKit daemon, as docs/kubernetes.md describes them: out to the
// egress proxy and DNS, in from the listener.
const BUILDER_POLICY = {
  metadata: { name: "deckhand-buildkit" },
  spec: {
    podSelector: { matchLabels: { app: "buildkitd" } },
    policyTypes: ["Ingress", "Egress"],
    egress: [
      { to: [{ podSelector: { matchLabels: { app: "egress" } } }], ports: [{ port: 3128 }] },
      {
        to: [{ namespaceSelector: {}, podSelector: { matchLabels: { "k8s-app": "kube-dns" } } }],
        ports: [
          { port: 53, protocol: "UDP" },
          { port: 53, protocol: "TCP" },
        ],
      },
    ],
    ingress: [{ from: [{ podSelector: { matchLabels: { app: "listener" } } }] }],
  },
};

// A namespace's API, as kube-api.mjs answers it: objects by resource then name. The pods the
// images create (installs, checks) end as `install` says ("Succeeded", "Failed", with
// `exitCode`), their log `installLog`; with `hold`, they run until finish() is called; with
// `gateExit`, their network gate ended so, saying `gateLog`. The BuildKit daemon is a pod
// behind its Service, under `policies`. `namespace`: the API's;
// `pull`: whether the registry's Secret is there.
function fakeApi({
  namespace = "runs",
  pull = true,
  install = "Succeeded",
  exitCode = install === "Succeeded" ? 0 : 1,
  installLog = "Claude Code 9.9.9 installed\n",
  hold = false,
  gateExit = 0,
  gateLog = "",
  podsFail = false,
  policies = [BUILDER_POLICY],
  builder = true,
} = {}) {
  let finished = !hold;
  const builders = new Map([["buildkitd-0", { metadata: { labels: { app: "buildkitd" } } }]]);
  const objects = {
    pods: new Map(),
    secrets: new Map(
      pull
        ? [
            [
              "pull",
              {
                data: { ".dockerconfigjson": Buffer.from(JSON.stringify(PULL)).toString("base64") },
              },
            ],
          ]
        : [],
    ),
    services: new Map([
      ["egress", { spec: { clusterIP: "10.96.0.11", selector: { app: "deckhand-egress" } } }],
    ]),
    persistentvolumeclaims: new Map(),
    endpointslices: new Map(
      builder
        ? [
            [
              "buildkitd",
              [
                {
                  endpoints: [
                    {
                      addresses: ["10.244.3.3"],
                      targetRef: { kind: "Pod", name: "buildkitd-0" },
                    },
                  ],
                },
              ],
            ],
          ]
        : [],
    ),
  };
  const created = [];
  const removed = [];
  const split = (path) => {
    const [kind, name] = path.split("/");
    return { store: objects[kind], name };
  };
  const api = {
    namespace,
    async find(path) {
      const { store, name } = split(path);
      const found =
        store.get(name) ?? (path.startsWith("pods/") ? builders.get(name) : null) ?? null;
      if (found?.kind === "Pod" && !finished)
        return { ...found, status: { ...found.status, phase: "Running" } };
      return found;
    },
    async get(path, query = {}) {
      if (path === "pods" && podsFail) throw new Error("GET pods: HTTP 503");
      if (path.endsWith("/networkpolicies")) return { items: policies };
      if (path.endsWith("/endpointslices")) {
        const service = query.labelSelector.split("=")[1];
        return { items: objects.endpointslices.get(service) ?? [] };
      }
      return { items: [...split(path).store.values()] };
    },
    async create(kind, body) {
      const store = objects[kind];
      if (store.has(body.metadata.name)) {
        throw Object.assign(new Error("already exists"), { status: 409 });
      }
      created.push(body);
      const status =
        kind === "pods"
          ? gateExit
            ? {
                phase: "Failed",
                podIP: "10.244.2.9",
                initContainerStatuses: [
                  { name: "network-gate", state: { terminated: { exitCode: gateExit } } },
                ],
                containerStatuses: [{ state: { waiting: { reason: "PodInitializing" } } }],
              }
            : {
                phase: install,
                podIP: "10.244.2.9",
                containerStatuses: [{ state: { terminated: { exitCode } } }],
              }
          : {};
      store.set(body.metadata.name, { ...body, status });
      return body;
    },
    async replace(path, body) {
      const { store, name } = split(path);
      store.set(name, body);
      return body;
    },
    async remove(path) {
      removed.push(path);
      const { store, name } = split(path);
      return store.delete(name);
    },
    async stream(path, query = {}) {
      return new Response(query.container === "network-gate" ? gateLog : installLog);
    },
  };
  return { api, objects, created, removed, finish: () => (finished = true) };
}

// buildctl, recorded: each call's arguments and the docker config it was handed; a build
// "pushes" its image to `registry`. `fail`: exit 1 instead. `hold`: a promise each build
// waits for first.
function fakeBuildctl(registry, clock, { fail = false, hold } = {}) {
  const calls = [];
  const buildctl = async (args, { env, onData, signal }) => {
    const call = {
      args,
      env,
      dockerConfig: JSON.parse(readFileSync(join(env.DOCKER_CONFIG, "config.json"), "utf8")),
    };
    calls.push(call);
    if (hold) await hold(signal);
    onData?.(Buffer.from("#1 [internal] load build definition from Dockerfile\n"));
    if (fail) return { code: 1, out: "", err: "" };
    const output = args[args.indexOf("--output") + 1];
    const ref = /name=([^,]+)/.exec(output)[1];
    clock.at += 1000;
    registry.images.set(ref, {
      digest: `sha256:${createHash("sha256").update(ref).digest("hex")}`,
      created: clock.at,
    });
    return { code: 0, out: "", err: "" };
  };
  return { buildctl, calls };
}

// The addresses every pod's network gate waits on (kube-gate.mjs), as a runner in the cluster
// has them: the API server's Service and the cluster's DNS.
// What a network gate's container (`gate`) tries.
const gateTargets = (gate) => JSON.parse(gate.command[3]);

const GATE_OPTIONS = {
  env: { KUBERNETES_SERVICE_HOST: "10.96.0.1", KUBERNETES_SERVICE_PORT: "443" },
  resolvConf: () => "nameserver 10.96.0.10\n",
};

function setup(
  t,
  {
    kubernetes = {},
    api: apiOptions,
    build: buildOptions,
    registry: regOptions,
    image = BASE,
    buildMs,
    apart = false,
  } = {},
) {
  const clock = { at: Date.parse("2026-10-30T10:00:00Z") };
  const registry = fakeRegistry(regOptions);
  // Apart: the builder, its policies and the registry's Secret in the services' namespace,
  // nothing of theirs in the sandboxes'.
  const services = apart ? fakeApi({ ...apiOptions, namespace: "deckhand" }) : null;
  const fake = apart
    ? fakeApi({ ...apiOptions, pull: false, builder: false, policies: [] })
    : fakeApi(apiOptions);
  const build = fakeBuildctl(registry, clock, buildOptions);
  const logged = [];
  const cfg = { ...config, image, kubernetes: { ...config.kubernetes, ...kubernetes } };
  const backend = createKubernetesImages({
    config: cfg,
    api: fake.api,
    services: services?.api,
    fetch: registry.fetch,
    buildctl: build.buildctl,
    buildMs,
    log: (line) => logged.push(line),
    networkGate: createNetworkGate({ config: cfg, ...GATE_OPTIONS, now: () => clock.at }),
    now: () => clock.at,
    // Time passes, and other tasks get their turn.
    sleep: async (ms) => {
      clock.at += ms;
      await new Promise((resolve) => setImmediate(resolve));
    },
  });
  const checkouts = [];
  const images = withBlobs(
    createImages({
      config: cfg,
      backend,
      jobs: {},
      checkout: async (repo, ref) => {
        checkouts.push(ref);
        return buildContext(t, `blob@${ref}`);
      },
    }),
    async (repo, path, ref) => (path === "missing" ? null : { sha: contextBlob(`blob@${ref}`) }),
  );
  return { ...fake, services, registry, build, backend, images, checkouts, clock, logged };
}

const access = { hosts: ["pypi.org", "*.debian.org"], trusted: ["pypi.org"] };

test("a repo's Dockerfile is built by buildctl, pushed to the registry, then reused", async (t) => {
  const { images, build, registry, checkouts } = setup(t);
  const ask = () =>
    images.imageFor({ repo: "Org/A", ref: "main", dockerfile: "docker/Dockerfile", access });
  // Two runs at once share one build.
  const [first, second] = await Promise.all([ask(), ask()]);
  assert.equal(first, second);
  assert.match(first, /^registry\.example\.com\/dh\/dh-repo-org-a-[0-9a-f]{10}:[0-9a-f]{16}$/);
  assert.equal(build.calls.length, 1);
  assert.deepEqual(checkouts, ["main"]);
  const [{ args, dockerConfig }] = build.calls;
  const dir = args[args.indexOf("--local") + 1].slice("context=".length);
  assert.deepEqual(
    args,
    buildArgs({
      addr: "tcp://buildkitd:1234",
      dir,
      dockerfile: "docker/Dockerfile",
      ref: first,
      buildArgs: {
        DECKHAND_BASE: BASE,
        HTTP_PROXY: "http://egress:3128",
        HTTPS_PROXY: "http://egress:3128",
        http_proxy: "http://egress:3128",
        https_proxy: "http://egress:3128",
      },
      labels: { "deckhand.repo": "org/a" },
    }),
  );
  assert.ok(args.includes(`dockerfile=${join(dir, "docker")}`));
  assert.ok(args.includes("filename=Dockerfile"));
  assert.ok(args.includes(`type=image,name=${first},push=true`));
  // Its credentials: the pull Secret's, handed over in a file of its own.
  assert.deepEqual(dockerConfig, PULL);
  // Found again by a manifest HEAD: no second build.
  assert.ok(registry.images.has(first));
  assert.equal(await ask(), first);
  assert.equal(build.calls.length, 1);
});

test("the tag follows the base image's digest and the Dockerfile", async (t) => {
  const { images, build, registry, clock } = setup(t);
  const ask = () =>
    images.imageFor({ repo: "org/a", ref: "main", dockerfile: "Dockerfile", access });
  const first = await ask();
  // The same tag of the base pushed again: a new digest, a new image, once the base's digest
  // is looked up again (it is kept a minute).
  registry.images.set(BASE, { digest: "sha256:base2", created: 2 });
  assert.equal(await ask(), first);
  clock.at += 60_000;
  const second = await ask();
  assert.notEqual(second, first);
  assert.equal(build.calls.length, 2);
});

test("a base image the registry doesn't have is a clear error", async (t) => {
  const { images, registry } = setup(t);
  registry.images.delete(BASE);
  await assert.rejects(
    images.imageFor({ repo: "org/a", ref: "main", dockerfile: "Dockerfile" }),
    /the base image ghcr\.io\/acme\/deckhand-sandbox:1\.2 is not in its registry: SANDBOX_IMAGE/,
  );
});

test("a failed build is said, and the next run builds again", async (t) => {
  const { images } = setup(t, { build: { fail: true } });
  await assert.rejects(
    images.imageFor({ repo: "org/a", ref: "main", dockerfile: "Dockerfile" }),
    /building Dockerfile of org\/a failed: exit 1/,
  );
  assert.deepEqual(images.building(), []);
});

test("old tags are pruned through the registry, the default branch's newest kept", async (t) => {
  const { images, registry, objects, logged } = setup(t);
  const ask = (ref, branch) =>
    images.imageFor({ repo: "org/a", ref, branch, dockerfile: "Dockerfile", access });
  const main = await ask("main", false);
  const name = main.split(":")[0];
  const tagsOf = () => [...registry.images.keys()].filter((r) => r.startsWith(`${name}:`)).sort();
  const branches = [];
  for (const sha of ["b1", "b2", "b3"]) branches.push(await ask(sha, true));
  // The newest few, and the default branch's however many branch builds came after it.
  assert.deepEqual(tagsOf(), [main, branches[1], branches[2]].sort());
  assert.equal(tagsOf().length, KEEP_TAGS);
  // A tag a pod runs stays, as Docker keeps an image a container uses.
  objects.pods.set("sandbox", { spec: { containers: [{ image: branches[1] }] } });
  await ask("b4", true);
  assert.ok(registry.images.has(branches[1]));
  assert.deepEqual(logged, []);
});

test("a manifest a kept tag shares isn't deleted with the tag pruned: the tag alone goes", async (t) => {
  for (const tagDeletes of [true, false]) {
    const { images, registry } = setup(t, { registry: { tagDeletes } });
    const ask = (ref, branch) =>
      images.imageFor({ repo: "org/a", ref, branch, dockerfile: "Dockerfile", access });
    const main = await ask("main", false);
    const name = main.slice(0, main.lastIndexOf(":"));
    // An old tag with the same manifest as the default branch's (an identical build).
    registry.images.set(`${name}:branch-old`, { ...registry.images.get(main), created: 0 });
    for (const sha of ["b1", "b2"]) await ask(sha, true);
    assert.ok(registry.images.has(main));
    // Where the registry can't delete a tag alone, it stays rather than take the kept one.
    assert.equal(registry.images.has(`${name}:branch-old`), !tagDeletes);
  }
});

test("a registry that refuses deletes keeps its tags, and the run goes on", async (t) => {
  const { images, logged } = setup(t, { registry: { deletes: false } });
  for (const sha of ["b1", "b2", "b3", "b4"]) {
    await images.imageFor({ repo: "org/a", ref: sha, branch: true, dockerfile: "Dockerfile" });
  }
  assert.match(logged[0], /^Pruning .*: deleting .*: HTTP 405 \(The operation is unsupported\.\)$/);
});

test("a branch image only under the grant, never a fork's: imageRef()'s cases on Kubernetes", async (t) => {
  const settings = { dockerfile: "Dockerfile" };
  const own = { head: { sha: "abc", repo: { full_name: "Org/A" } } };
  const fork = { head: { sha: "evil", repo: { full_name: "someone/a" } } };
  const granted = { allowBranchDockerImages: true };
  const cases = [
    [granted, own, { ref: "abc", branch: true }],
    [granted, fork, { ref: "main", branch: false }],
    [{ allowBranchDockerImages: false }, own, { ref: "main", branch: false }],
    [granted, { head: { repo: { full_name: "org/a" } } }, { ref: "main", branch: false }],
  ];
  const { images, checkouts } = setup(t);
  for (const [grant, pr, expected] of cases) {
    const source = imageRef(grant, settings, "org/a", "main", pr);
    assert.deepEqual(source, expected);
    const image = await images.imageFor({ repo: "org/a", ...source, dockerfile: "Dockerfile" });
    assert.equal(/:branch-/.test(image), expected.branch);
  }
  // Built from the branch once, from the default branch once: never from the fork.
  assert.deepEqual(checkouts, ["abc", "main"]);
});

test("the builder reaches the building repo's hosts only, tunnelled, and nothing between builds", async (t) => {
  let release;
  const held = new Promise((resolve) => (release = resolve));
  const { images } = setup(t, { build: { hold: () => held } });
  const ip = "10.244.3.3";
  assert.deepEqual(await images.egressFor(ip, "pypi.org"), {
    allowed: false,
    private: false,
    cache: false,
    decrypt: false,
    relay: false,
    reason: "no_build",
    source: "build",
  });
  const built = images.imageFor({ repo: "org/a", ref: "main", dockerfile: "Dockerfile", access });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  const pypi = await images.egressFor(ip, "pypi.org");
  assert.deepEqual(pypi, {
    allowed: true,
    private: true,
    cache: false,
    decrypt: false,
    relay: false,
    source: "build",
  });
  assert.equal((await images.egressFor(ip, "evil.example")).reason, "not_granted");
  // The registries it pulls from and pushes to.
  assert.equal((await images.egressFor(ip, REGISTRY)).allowed, true);
  assert.equal((await images.egressFor(ip, "ghcr.io")).allowed, true);
  // Where ghcr.io sends a puller for the base image's layers, and the token service the
  // listener saw each registry name; not Docker Hub's, which no image here comes from.
  assert.equal((await images.egressFor(ip, "pkg-containers.githubusercontent.com")).allowed, true);
  assert.equal((await images.egressFor(ip, "auth.docker.io")).allowed, false);
  // Another caller isn't the builder's to answer for.
  assert.equal(await images.egressFor("10.244.9.9", "pypi.org"), null);
  release();
  await built;
});

test("builds of repos granted other hosts wait for each other", async (t) => {
  const order = [];
  let releaseFirst;
  const first = new Promise((resolve) => (releaseFirst = resolve));
  let holds = 0;
  const { images } = setup(t, {
    build: { hold: () => (holds++ === 0 ? first : Promise.resolve()) },
  });
  const a = images
    .imageFor({ repo: "org/a", ref: "main", dockerfile: "Dockerfile", access })
    .then(() => order.push("a"));
  await new Promise((resolve) => setImmediate(resolve));
  const b = images
    .imageFor({
      repo: "org/b",
      ref: "main",
      dockerfile: "Dockerfile",
      access: { hosts: ["npmjs.org"], trusted: [] },
    })
    .then(() => order.push("b"));
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, []);
  releaseFirst();
  await Promise.all([a, b]);
  assert.deepEqual(order, ["a", "b"]);
});

test("an agent with a class: its claim made, filled by an install pod as neither root nor the sandbox", async (t) => {
  const { images, objects, created, removed } = setup(t, {
    kubernetes: { agentStorageClass: "nfs" },
  });
  const output = [];
  await images.installAgent(claude, (chunk) => output.push(chunk.toString()));
  const claim = created.find((o) => o.kind === "PersistentVolumeClaim");
  assert.equal(claim.metadata.name, "dh-claude-code");
  assert.deepEqual(claim.spec, {
    accessModes: ["ReadWriteMany"],
    resources: { requests: { storage: "5Gi" } },
    storageClassName: "nfs",
  });
  const pod = created.find((o) => o.kind === "Pod");
  assert.equal(pod.metadata.labels["deckhand.role"], "install");
  const { spec } = pod;
  assert.equal(spec.restartPolicy, "Never");
  assert.equal(spec.automountServiceAccountToken, false);
  assert.deepEqual(spec.imagePullSecrets, [{ name: "pull" }]);
  // Pod Security restricted: no root, no capability, no privilege gain.
  assert.deepEqual(spec.securityContext, {
    runAsNonRoot: true,
    runAsUser: INSTALL_USER.uid,
    runAsGroup: INSTALL_USER.gid,
    fsGroup: INSTALL_USER.gid,
    fsGroupChangePolicy: "OnRootMismatch",
    seccompProfile: { type: "RuntimeDefault" },
  });
  assert.notEqual(INSTALL_USER.uid, SANDBOX_USER.uid);
  // Its network gate first (kube-gate.mjs): the API server and the DNS out of reach, the proxy
  // reached, before the installer runs.
  const [gate] = spec.initContainers;
  assert.equal(gate.name, "network-gate");
  assert.equal(gate.image, BASE);
  assert.deepEqual(gateTargets(gate), [
    { what: "the Kubernetes API server", host: "10.96.0.1", port: 443, reach: false },
    { what: "the cluster's DNS", host: "10.96.0.10", port: 53, reach: false },
    { what: "the egress proxy", host: "10.96.0.11", port: 3128, reach: true },
  ]);
  const [c] = spec.containers;
  assert.equal(c.image, BASE);
  // The installer, once the claim proved writable (writable()).
  assert.deepEqual(c.command, writable("/opt/claude-code", "deckhand-install-claude-code"));
  assert.deepEqual(c.securityContext, {
    allowPrivilegeEscalation: false,
    capabilities: { drop: ["ALL"] },
    runAsNonRoot: true,
    seccompProfile: { type: "RuntimeDefault" },
  });
  const env = Object.fromEntries(c.env.map((e) => [e.name, e.value]));
  assert.equal(env.CLAUDE_CODE_VERSION, "9.9.9");
  assert.equal(env.HTTPS_PROXY, "http://egress:3128");
  assert.deepEqual(c.volumeMounts, [{ name: "claim", mountPath: "/opt/claude-code" }]);
  assert.deepEqual(spec.volumes, [
    { name: "claim", persistentVolumeClaim: { claimName: "dh-claude-code" } },
  ]);
  // Its log in the run's, and the pod gone once it ended.
  assert.deepEqual(output, ["Claude Code 9.9.9 installed\n"]);
  assert.equal(objects.pods.size, 0);
  assert.ok(removed.includes(`pods/${pod.metadata.name}`));
  // Once per version.
  await images.installAgent(claude, () => {});
  assert.equal(created.filter((o) => o.kind === "Pod").length, 1);
});

test("an install pod reaches its agent's install hosts only, through the proxy", async (t) => {
  const { images, finish } = setup(t, {
    kubernetes: { agentStorageClass: "nfs" },
    api: { hold: true },
  });
  const done = images.installAgent(antigravity, () => {});
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
  // GitHub's releases, tunnelled: the pod trusts no CA of Deckhand's and gets no token.
  assert.deepEqual(await images.egressFor("10.244.2.9", "github.com"), {
    allowed: true,
    private: false,
    cache: false,
    decrypt: false,
    relay: false,
    source: "install",
  });
  assert.equal((await images.egressFor("10.244.2.9", "registry.npmjs.org")).allowed, false);
  finish();
  await done;
  // Gone with its pod.
  assert.equal(await images.egressFor("10.244.2.9", "github.com"), null);
});

test("a failed install says so, removes its pod, and the next run tries again", async (t) => {
  const { images, objects, created } = setup(t, {
    kubernetes: { agentStorageClass: "nfs" },
    api: { install: "Failed", installLog: "npm ERR! 404\n" },
  });
  const output = [];
  await assert.rejects(
    images.installAgent(claude, (chunk) => output.push(chunk.toString())),
    /installing Claude 9\.9\.9 failed: exit 1/,
  );
  assert.deepEqual(output, ["npm ERR! 404\n"]);
  assert.equal(objects.pods.size, 0);
  await assert.rejects(images.installAgent(claude, () => {}));
  assert.equal(created.filter((o) => o.kind === "Pod").length, 2);
});

test("a pod whose NetworkPolicies don't apply: its network gate fails it before anything of it runs, said", async (t) => {
  const { images, objects } = setup(t, {
    kubernetes: { agentStorageClass: "nfs" },
    api: {
      gateExit: 3,
      gateLog: "still reached the Kubernetes API server (10.96.0.1:443) after 600 s\n",
    },
  });
  const output = [];
  await assert.rejects(
    images.installAgent(claude, (chunk) => output.push(chunk.toString())),
    /installing Claude 9\.9\.9 failed: its NetworkPolicies didn't apply: still reached the Kubernetes API server \(10\.96\.0\.1:443\) after 600 s/,
  );
  // The installer never ran: no log of its.
  assert.deepEqual(output, []);
  assert.equal(objects.pods.size, 0);
  // A cache's check likewise.
  const checks = setup(t, {
    kubernetes: { cacheStorageClass: "nfs" },
    api: { gateExit: 3, gateLog: "still reached the cluster's DNS (10.96.0.10:53) after 600 s\n" },
  });
  await assert.rejects(
    checks.images.caches("org/a", ["/home/node/.npm"], BASE),
    /its NetworkPolicies didn't apply: still reached the cluster's DNS/,
  );
});

test("an agent's claim made beforehand is installed into without a class", async (t) => {
  const { images, objects, created } = setup(t);
  objects.persistentvolumeclaims.set("dh-claude-code", { metadata: {} });
  await images.installAgent(claude, () => {});
  assert.equal(created.filter((o) => o.kind === "Pod").length, 1);
  assert.equal(created.filter((o) => o.kind === "PersistentVolumeClaim").length, 0);
});

test("no class and no claim: nothing installed here, the sandbox's init container does", async (t) => {
  const { images, created } = setup(t);
  await images.installAgent(claude, () => {});
  assert.deepEqual(created, []);
});

test("caches: claims of the cache class, the sandbox's by its fsGroup, no chown job", async (t) => {
  const { images, created, api, clock } = setup(t, { kubernetes: { cacheStorageClass: "nfs" } });
  let madeAt;
  const create = api.create;
  api.create = async (kind, body) => {
    if (kind === "pods") madeAt ??= clock.at;
    return create(kind, body);
  };
  assert.equal(images.keepsCaches, true);
  assert.equal(images.noCaches, null);
  const found = await images.caches("org/a", ["/home/node/.npm"], BASE);
  assert.equal(found.length, 1);
  assert.equal(found[0].path, "/home/node/.npm");
  const [claim, check] = created;
  assert.equal(claim.metadata.name, found[0].name);
  // A short pod as the sandbox's user checks it may write there, then goes.
  assert.equal(check.kind, "Pod");
  assert.equal(check.spec.securityContext.runAsUser, SANDBOX_USER.uid);
  assert.equal(check.spec.securityContext.fsGroup, SANDBOX_USER.gid);
  assert.deepEqual(check.spec.containers[0].command, writable("/cache"));
  assert.equal(check.spec.volumes[0].persistentVolumeClaim.claimName, claim.metadata.name);
  assert.equal(check.spec.containers[0].env.length, 0);
  // Its network gate waits for no proxy: it may reach nothing at all.
  assert.ok(gateTargets(check.spec.initContainers[0]).every((target) => !target.reach));
  // It gives up before the check's own limit (5 min from the pod's creation): its failure is
  // what the run is told.
  assert.equal(Number(check.spec.initContainers[0].command[4]), madeAt + 5 * 60_000 - 30_000);
  assert.equal(claim.metadata.labels["deckhand.role"], "cache");
  assert.equal(claim.metadata.annotations["deckhand.cache"], "/home/node/.npm");
  assert.deepEqual(claim.spec, {
    accessModes: ["ReadWriteMany"],
    resources: { requests: { storage: "10Gi" } },
    storageClassName: "nfs",
  });
  // Made once, then found.
  await images.caches("org/a", ["/home/node/.npm"], BASE);
  assert.equal(created.length, 2);
});

test("caches: a claim its storage doesn't hand to the sandbox's user fails the run, and goes", async (t) => {
  const { images, objects } = setup(t, {
    kubernetes: { cacheStorageClass: "nfs" },
    api: { install: "Failed", exitCode: 97, installLog: "" },
  });
  await assert.rejects(
    images.caches("org/a", ["/home/node/.npm"], BASE),
    /creating the cache volume .*: the claim .* isn't writable by uid 1000: its storage class \(nfs\) has to apply the pod's fsGroup \(for a CSI driver, fsGroupPolicy: File\)/,
  );
  // The next run makes it again.
  assert.equal(objects.persistentvolumeclaims.size, 0);
  assert.equal(objects.pods.size, 0);
});

test("an agent's claim its storage doesn't hand to the install's user: said, not an EACCES", async (t) => {
  const { images } = setup(t, {
    kubernetes: { agentStorageClass: "efs" },
    api: { install: "Failed", exitCode: 97, installLog: "" },
  });
  await assert.rejects(
    images.installAgent(claude, () => {}),
    /installing Claude 9\.9\.9 failed: the claim dh-claude-code isn't writable by uid 1001: its storage class \(efs\)/,
  );
});

test("writable(): a check of the mount point, then the command", { skip: needsBash }, (t) => {
  const dir = tempDir(t);
  const run = (...command) => {
    const [shell, ...args] = writable(dir, ...command);
    return spawnSync(shell, args).status;
  };
  assert.equal(run(), 0);
  assert.equal(run("sh", "-c", "exit 4"), 4);
  // Nothing left behind by the check.
  assert.deepEqual(readdirSync(dir), []);
});

test(
  "writable(): a mount point it can't write; a claim filled beforehand needs no write",
  { skip: needsBash || (isRoot && "root writes anywhere") },
  (t) => {
    const dir = tempDir(t);
    const run = (...command) => {
      const [shell, ...args] = writable(dir, ...command);
      return spawnSync(shell, args).status;
    };
    chmodSync(dir, 0o555);
    try {
      // A claim it can't write: NOT_WRITABLE unless the command manages without (a claim
      // filled beforehand, which the installer leaves as it is).
      assert.equal(run(), 97);
      assert.equal(run("sh", "-c", "exit 4"), 97);
      assert.equal(run("true"), 0);
    } finally {
      chmodSync(dir, 0o755);
    }
  },
);

test("caches: none without a class, and the reason for the run's log", async (t) => {
  const { images, created } = setup(t);
  assert.equal(images.keepsCaches, false);
  assert.equal(images.noCaches, "no KUBERNETES_CACHE_STORAGE_CLASS is set");
  assert.deepEqual(await images.caches("org/a", ["/c"], BASE), []);
  assert.deepEqual(created, []);
});

test("parseRef: a registry host by its dot, port or localhost, else Docker Hub's", () => {
  assert.deepEqual(parseRef("registry.example.com/dh/x:abc"), {
    host: "registry.example.com",
    name: "dh/x",
    reference: "abc",
  });
  assert.deepEqual(parseRef("localhost:5000/x"), {
    host: "localhost:5000",
    name: "x",
    reference: "latest",
  });
  assert.deepEqual(parseRef("node:26"), {
    host: "docker.io",
    name: "library/node",
    reference: "26",
  });
  assert.deepEqual(parseRef("acme/tool"), {
    host: "docker.io",
    name: "acme/tool",
    reference: "latest",
  });
  assert.deepEqual(parseRef("r.example.com:443/a/b:1@sha256:ff"), {
    host: "r.example.com:443",
    name: "a/b",
    reference: "sha256:ff",
  });
});

test("authsOf and challenge: a docker config's credentials, a registry's challenge", () => {
  assert.deepEqual(
    authsOf({
      auths: {
        "https://index.docker.io/v1/": { auth: Buffer.from("me:p:w").toString("base64") },
        "r.example.com": { username: "u", password: "p" },
        "empty.example.com": {},
      },
    }),
    {
      "docker.io": { username: "me", password: "p:w" },
      "r.example.com": { username: "u", password: "p" },
    },
  );
  assert.deepEqual(challenge('Bearer realm="https://a/token",service="a",scope="x"'), {
    scheme: "bearer",
    params: { realm: "https://a/token", service: "a", scope: "x" },
  });
  assert.equal(challenge(null), null);
});

test("registry: Basic auth, a digest hashed when HEAD doesn't say, tags by pages", async () => {
  const manifest = JSON.stringify({ config: { digest: "sha256:c" } });
  const seen = [];
  const fetch = async (input, init = {}) => {
    const url = new URL(input);
    seen.push(
      `${init.method ?? "GET"} ${url.pathname}${url.search} ${init.headers?.authorization ?? "-"}`,
    );
    if (!init.headers?.authorization) {
      return new Response(null, {
        status: 401,
        headers: { "www-authenticate": 'Basic realm="r"' },
      });
    }
    if (url.pathname.endsWith("/manifests/1")) {
      return init.method === "HEAD" ? new Response(null) : new Response(manifest);
    }
    if (url.searchParams.get("last") === "b") return Response.json({ tags: ["c"] });
    return Response.json(
      { tags: ["a", "b"] },
      { headers: { link: '</v2/x/tags/list?n=2&last=b>; rel="next"' } },
    );
  };
  const registry = createRegistry({
    fetch,
    auths: async () => ({ "r.example.com": { username: "u", password: "p" } }),
  });
  assert.equal(
    await registry.digest("r.example.com/x:1"),
    `sha256:${createHash("sha256").update(manifest).digest("hex")}`,
  );
  assert.deepEqual(await registry.tags("r.example.com/x"), ["a", "b", "c"]);
  assert.ok(seen.every((s) => s.endsWith("-") || s.endsWith(`Basic ${btoa("u:p")}`)));
  // Without credentials, a Basic challenge is a 401: nothing to answer it with.
  const anonymous = createRegistry({ fetch });
  await assert.rejects(
    anonymous.digest("r.example.com/x:1"),
    /looking up r\.example\.com\/x:1: HTTP 401/,
  );
});

test("buildctl gets its docker config and PATH, nothing else of the listener's environment", async (t) => {
  const { images, build } = setup(t);
  await images.imageFor({ repo: "org/a", ref: "main", dockerfile: "Dockerfile", access });
  const [{ env }] = build.calls;
  assert.deepEqual(Object.keys(env).sort(), ["DOCKER_CONFIG", "HOME", "PATH"]);
});

test("a base image from Docker Hub: the builder may reach its API, token service and layers", async (t) => {
  let release;
  const held = new Promise((resolve) => (release = resolve));
  const { images, registry } = setup(t, {
    image: "acme/deckhand-sandbox:1.2",
    build: { hold: () => held },
    kubernetes: { registryHosts: ["s3.example.com"] },
  });
  // Docker Hub answers at registry-1.docker.io.
  registry.images.set("registry-1.docker.io/acme/deckhand-sandbox:1.2", {
    digest: "sha256:hub",
    created: 1,
  });
  const built = images.imageFor({ repo: "org/a", ref: "main", dockerfile: "Dockerfile", access });
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
  const ip = "10.244.3.3";
  for (const host of [
    "registry-1.docker.io",
    "auth.docker.io",
    "production.cloudflare.docker.com",
    // The operator's (KUBERNETES_REGISTRY_HOSTS).
    "s3.example.com",
    // The token service the operator's registry named to the listener.
    REGISTRY,
  ]) {
    assert.equal((await images.egressFor(ip, host)).allowed, true, host);
  }
  // ghcr.io's storage: no image here comes from there.
  assert.equal((await images.egressFor(ip, "pkg-containers.githubusercontent.com")).allowed, false);
  release();
  await built;
});

test("no build without the NetworkPolicies that isolate the builder, or without a builder", async (t) => {
  for (const [api, said] of [
    [{ policies: [] }, /no NetworkPolicy picks the BuildKit daemon's pods for Egress/],
    [{ builder: false }, /no BuildKit daemon behind the Service buildkitd in the namespace runs/],
  ]) {
    const { images, build } = setup(t, { api });
    await assert.rejects(
      images.imageFor({ repo: "org/a", ref: "main", dockerfile: "Dockerfile", access }),
      (error) =>
        /building Dockerfile of org\/a failed: the BuildKit daemon isn't isolated: /.test(
          error.message,
        ) && said.test(error.message),
    );
    assert.equal(build.calls.length, 0);
  }
});

test("builderIsolationProblem: any policy that lets the builder out but to the proxy and DNS, or in from beyond", () => {
  const labels = { app: "buildkitd" };
  assert.equal(builderIsolationProblem([BUILDER_POLICY], labels), null);
  // Another daemon's labels: no policy picks it.
  assert.match(builderIsolationProblem([BUILDER_POLICY], { app: "x" }), /for Egress/);
  const egressOnly = {
    ...BUILDER_POLICY,
    spec: { ...BUILDER_POLICY.spec, policyTypes: ["Egress"], ingress: undefined },
  };
  assert.match(builderIsolationProblem([egressOnly], labels), /for Ingress/);
  const widen = (spec) => ({ metadata: { name: "wide" }, spec: { podSelector: {}, ...spec } });
  assert.match(
    builderIsolationProblem(
      [BUILDER_POLICY, widen({ policyTypes: ["Egress"], egress: [{}] })],
      labels,
    ),
    /the NetworkPolicy wide lets the BuildKit daemon reach anything/,
  );
  const out = widen({
    policyTypes: ["Egress"],
    egress: [{ to: [{ ipBlock: { cidr: "0.0.0.0/0" } }], ports: [{ port: 443 }] }],
  });
  assert.match(
    builderIsolationProblem([BUILDER_POLICY, out], labels),
    /beyond the namespace's pods/,
  );
  const anyIn = widen({ policyTypes: ["Ingress"], ingress: [{}] });
  assert.match(builderIsolationProblem([BUILDER_POLICY, anyIn], labels), /lets traffic in/);
  const otherNamespace = widen({
    policyTypes: ["Ingress"],
    ingress: [{ from: [{ namespaceSelector: {} }] }],
  });
  assert.match(
    builderIsolationProblem([BUILDER_POLICY, otherNamespace], labels),
    /lets traffic in/,
  );
});

test("the build gate: first come, first served, a waiting set isn't starved by its elders", async (t) => {
  const order = [];
  const holds = [];
  const { images } = setup(t, {
    build: { hold: () => new Promise((resolve) => holds.push(resolve)) },
  });
  const tick = async () => {
    for (let i = 0; i < 8; i++) await new Promise((resolve) => setImmediate(resolve));
  };
  const ask = (repo, hosts) =>
    images
      .imageFor({ repo, ref: "main", dockerfile: "Dockerfile", access: { hosts, trusted: [] } })
      .then(() => order.push(repo));
  const a1 = ask("org/a1", ["a.example"]);
  await tick();
  const b = ask("org/b", ["b.example"]);
  await tick();
  // The same hosts as the build running, but after one of other hosts: it waits its turn.
  const a2 = ask("org/a2", ["a.example"]);
  await tick();
  assert.equal(holds.length, 1);
  holds[0]();
  await tick();
  assert.equal(holds.length, 2); // b's
  holds[1]();
  await tick();
  holds[2]();
  await Promise.all([a1, b, a2]);
  assert.deepEqual(order, ["org/a1", "org/b", "org/a2"]);
});

test("a build that outlasts its time is stopped, saying so", async (t) => {
  const { images } = setup(t, {
    buildMs: 20,
    build: {
      hold: (signal) =>
        new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true })),
    },
  });
  await assert.rejects(
    images.imageFor({ repo: "org/a", ref: "main", dockerfile: "Dockerfile", access }),
    /building Dockerfile of org\/a failed: stopped after/,
  );
  assert.equal(BUILD_MS, 60 * 60_000);
});

test("a tag the registry won't delete alone is logged, and kept", async (t) => {
  const { images, registry, logged } = setup(t, { registry: { tagDeletes: false } });
  const ask = (ref, branch) =>
    images.imageFor({ repo: "org/a", ref, branch, dockerfile: "Dockerfile", access });
  const main = await ask("main", false);
  const name = main.slice(0, main.lastIndexOf(":"));
  registry.images.set(`${name}:branch-old`, { ...registry.images.get(main), created: 0 });
  for (const sha of ["b1", "b2"]) await ask(sha, true);
  assert.ok(registry.images.has(`${name}:branch-old`));
  assert.match(logged.join("\n"), /Pruning .*:branch-old \(its tag only\): deleting .*: HTTP 400/);
});

test("a run without a Dockerfile doesn't look its base image up: the nodes pull it", async (t) => {
  const { images, registry } = setup(t);
  registry.images.delete(BASE);
  const before = registry.calls.length;
  assert.equal(await images.imageFor({ repo: "org/a", ref: "main", dockerfile: null }), BASE);
  assert.equal(registry.calls.length, before);
});

test("registry: a tag list's next page as an absolute URL of the same registry, not another's", async () => {
  const seen = [];
  const fetch = async (input) => {
    const url = new URL(input);
    seen.push(url.href);
    if (url.searchParams.get("last") === "b") {
      return Response.json(
        { tags: ["c"] },
        { headers: { link: '<https://evil.example/v2/x/tags/list?last=c>; rel="next"' } },
      );
    }
    return Response.json(
      { tags: ["a", "b"] },
      { headers: { link: '<https://r.example.com/v2/x/tags/list?n=2&last=b>; rel="next"' } },
    );
  };
  const registry = createRegistry({ fetch });
  assert.deepEqual(await registry.tags("r.example.com/x"), ["a", "b", "c"]);
  assert.ok(seen.every((url) => url.startsWith("https://r.example.com/v2/x/tags/list")));
});

test("a prune whose pods the API can't list is logged, and the run has its image", async (t) => {
  const { images, registry, logged } = setup(t, { api: { podsFail: true } });
  const ask = (ref, branch) =>
    images.imageFor({ repo: "org/a", ref, branch, dockerfile: "Dockerfile", access });
  const tags = [];
  for (const [ref, branch] of [
    ["main", false],
    ["b1", true],
    ["b2", true],
    ["b3", true],
  ]) {
    tags.push(await ask(ref, branch));
  }
  assert.ok(tags.every((tag) => registry.images.has(tag)));
  assert.match(logged.join("\n"), /^Pruning .*: GET pods: HTTP 503$/m);
});

test("a tag whose date can't be read is kept and logged, never taken for the newest", async (t) => {
  const { images, registry, logged } = setup(t);
  const ask = (ref, branch) =>
    images.imageFor({ repo: "org/a", ref, branch, dockerfile: "Dockerfile", access });
  const main = await ask("main", false);
  const name = main.slice(0, main.lastIndexOf(":"));
  // An old default-branch tag, its config unreadable.
  registry.images.set(`${name}:0000000000000000`, { digest: "sha256:old", created: 0 });
  registry.undated.add("sha256:old");
  for (const sha of ["b1", "b2", "b3"]) await ask(sha, true);
  assert.ok(registry.images.has(`${name}:0000000000000000`));
  // The default branch's real newest stays too.
  assert.ok(registry.images.has(main));
  assert.match(logged.join("\n"), /Dating .*:0000000000000000 \(kept\): .*HTTP 500/);
});

test("an agent left to the init container is asked again: a claim made later is filled", async (t) => {
  const { images, objects, created } = setup(t);
  await images.installAgent(claude, () => {});
  assert.equal(created.filter((o) => o.kind === "Pod").length, 0);
  // The operator makes the claim while the listener runs: the next run fills it.
  objects.persistentvolumeclaims.set("dh-claude-code", { metadata: {} });
  await images.installAgent(claude, () => {});
  assert.equal(created.filter((o) => o.kind === "Pod").length, 1);
  // Installed: once per version from then on.
  await images.installAgent(claude, () => {});
  assert.equal(created.filter((o) => o.kind === "Pod").length, 1);
});

test("apart: the builder and the registry's Secret in the services' namespace, installs in the sandboxes'", async (t) => {
  const { images, build, created, services } = setup(t, {
    apart: true,
    kubernetes: { agentStorageClass: "nfs" },
  });
  await images.imageFor({ repo: "org/a", ref: "main", dockerfile: "Dockerfile", access });
  // Pushed with the services' namespace's Secret, to the daemon checked there: by its name in
  // that namespace, as the short one resolves in the runner's own.
  assert.deepEqual(build.calls[0].dockerConfig, PULL);
  const args = build.calls[0].args;
  assert.equal(args[args.indexOf("--addr") + 1], "tcp://buildkitd.deckhand.svc:1234");
  assert.equal(services.created.length, 0);
  // The install pod, in the sandboxes' namespace: the Secret copied there, the proxy by its
  // Service's IP, as the cluster's DNS doesn't know its short name there.
  await images.installAgent(claude, () => {});
  const copy = created.find((o) => o.kind === "Secret");
  assert.equal(copy.metadata.name, "pull");
  assert.deepEqual(copy.data, services.objects.secrets.get("pull").data);
  const pod = created.find((o) => o.kind === "Pod");
  assert.deepEqual(pod.spec.imagePullSecrets, [{ name: "pull" }]);
  assert.deepEqual(pod.spec.hostAliases, [{ ip: "10.96.0.11", hostnames: ["egress"] }]);
  assert.equal(services.created.length, 0);
  // In one namespace, as before: no copy, no hostAliases.
  const one = setup(t, { kubernetes: { agentStorageClass: "nfs" } });
  await one.images.installAgent(claude, () => {});
  assert.equal(one.created.filter((o) => o.kind === "Secret").length, 0);
  assert.equal(one.created.find((o) => o.kind === "Pod").spec.hostAliases, undefined);
});

test("apart: a cache's check reaches nothing, so needs no proxy Service, nor gets its hostAliases", async (t) => {
  const { backend, created, services } = setup(t, {
    apart: true,
    kubernetes: { cacheStorageClass: "nfs" },
  });
  services.objects.services.delete("egress");
  assert.deepEqual(await backend.createVolume("dh-cache-org-a-npm"), { code: 0, out: "", err: "" });
  const pod = created.find((o) => o.kind === "Pod");
  assert.equal(pod.metadata.labels["deckhand.role"], "check");
  assert.equal(pod.spec.hostAliases, undefined);
});

test("apart: the builder's ingress may let in the services' namespace's pods, never another namespace", async (t) => {
  const anyPod = {
    ...BUILDER_POLICY,
    spec: { ...BUILDER_POLICY.spec, ingress: [{ from: [{ podSelector: {} }] }] },
  };
  const labels = { app: "buildkitd" };
  // With the sandboxes there too, `podSelector: {}` picks them: refused.
  assert.match(builderIsolationProblem([anyPod], labels), /lets sandbox pods reach/);
  assert.equal(builderIsolationProblem([anyPod], labels, { sandboxesApart: true }), null);
  const sandboxes = {
    ...BUILDER_POLICY,
    spec: {
      ...BUILDER_POLICY.spec,
      ingress: [
        {
          from: [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "runs" } } }],
        },
      ],
    },
  };
  assert.match(
    builderIsolationProblem([sandboxes], labels, { sandboxesApart: true }),
    /lets traffic in to the BuildKit daemon from beyond the namespace's pods/,
  );
  // And the runner asks the services' namespace's policies.
  const { images, build } = setup(t, { apart: true, api: { policies: [anyPod] } });
  await images.imageFor({ repo: "org/a", ref: "main", dockerfile: "Dockerfile", access });
  assert.equal(build.calls.length, 1);
  const refused = setup(t, { apart: true, api: { policies: [] } });
  await assert.rejects(
    refused.images.imageFor({ repo: "org/a", ref: "main", dockerfile: "Dockerfile", access }),
    /no NetworkPolicy picks the BuildKit daemon's pods for Egress/,
  );
});

test("builderIsolationProblem: a DNS rule without `to` is DNS, nothing more", () => {
  const labels = { app: "buildkitd" };
  const policy = (egress) => ({
    ...BUILDER_POLICY,
    spec: { ...BUILDER_POLICY.spec, egress: [...BUILDER_POLICY.spec.egress, egress] },
  });
  assert.equal(
    builderIsolationProblem([policy({ ports: [{ port: 53, protocol: "UDP" }] })], labels),
    null,
  );
  assert.match(
    builderIsolationProblem([policy({ ports: [{ port: 443 }] })], labels),
    /lets the BuildKit daemon reach anything/,
  );
  assert.match(
    builderIsolationProblem([policy({ ports: [{ port: 53, endPort: 65535 }] })], labels),
    /lets the BuildKit daemon reach anything/,
  );
});

// The Antigravity login's refresh on Kubernetes (runner/service.mjs loginRefresh(), with
// runJob() as its jobs): the job's pod goes through `starting` (statuses, one per look at it,
// each seen by `looked(status)`), then runs until it is attached to, then ends with
// `exitCode`; `attach(input)` answers what the container printed, which the fake seals with
// the key the input starts with, as kube-seal.mjs's WRAPPER does. `attached`: the inputs
// sent; `logs`: the log reads' queries.
function refreshOn(t, { exitCode = 0, attach, starting = [], looked = () => {}, ...options } = {}) {
  const s = setup(t, options);
  const find = s.api.find;
  const ended = new Set();
  const looks = new Map(); // pod → how many times it was looked at
  // A pod made again under the same name starts afresh.
  const create = s.api.create;
  s.api.create = async (kind, body) => {
    ended.delete(`pods/${body.metadata.name}`);
    looks.delete(`pods/${body.metadata.name}`);
    return create(kind, body);
  };
  s.api.find = async (path) => {
    const found = await find(path);
    if (!found || !path.startsWith("pods/dh-job-")) return found;
    const look = looks.get(path) ?? 0;
    looks.set(path, look + 1);
    if (look < starting.length) {
      const status = { podIP: "10.244.2.9", ...starting[look] };
      await looked(status);
      return { ...found, status };
    }
    const done = ended.has(path);
    return {
      ...found,
      status: {
        phase: done ? (exitCode ? "Failed" : "Succeeded") : "Running",
        podIP: "10.244.2.9",
        containerStatuses: [{ state: done ? { terminated: { exitCode } } : { running: {} } }],
      },
    };
  };
  const attached = [];
  s.api.attach = async (path, query, { input: sent }) => {
    const nl = sent.indexOf("\n");
    const key = Buffer.from(sent.slice(0, nl), "hex");
    const input = sent.slice(nl + 1);
    attached.push({ path, query, input, key });
    try {
      const { out, err } = await attach(input);
      return { out: sealWith(key, out), err };
    } finally {
      ended.add(path.replace(/\/attach$/, ""));
    }
  };
  const logs = [];
  const stream = s.api.stream;
  s.api.stream = async (path, query) => {
    logs.push({ path, query });
    return stream(path, query);
  };
  const refresh = loginRefresh({
    config: { ...config, agyLoginVolume: "dh-antigravity-login" },
    images: s.images,
    jobs: { run: s.backend.runJob },
  });
  return { ...s, refresh, attached, logs };
}

// What kube-seal.mjs's WRAPPER prints of `text`, with `key`.
function sealWith(key, text) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const sealed = Buffer.concat([cipher.update(text), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), sealed]).toString("base64");
}

// A pod Pending while its init container installs the agent.
const INSTALLING = {
  phase: "Pending",
  initContainerStatuses: [{ name: "agent-install", state: { running: {} } }],
  containerStatuses: [{ state: { waiting: { reason: "PodInitializing" } } }],
};

test("Kubernetes: the login's refresh is a pod of its own, its input on stdin, no Secret, no token, removed", async (t) => {
  const reached = {};
  const { refresh, attached, created, objects, removed, images } = refreshOn(t, {
    kubernetes: { agentStorageClass: "nfs" },
    attach: async (input) => {
      // While it runs: Google's OAuth and agy's own hosts, tunnelled; nothing else.
      for (const host of [
        "oauth2.googleapis.com",
        "daily-cloudcode-pa.googleapis.com",
        "github.com",
        "play.googleapis.com",
        "example.com",
      ]) {
        reached[host] = await images.egressFor("10.244.2.9", host);
      }
      return { out: `${input} refreshed`, err: "" };
    },
  });
  assert.deepEqual(await refresh('{"token":"old"}'), {
    code: 0,
    out: '{"token":"old"} refreshed',
    err: "",
  });
  assert.deepEqual(
    attached.map(({ key, ...rest }) => rest),
    [
      {
        path: "pods/dh-job-antigravity-refresh/attach",
        query: { container: "job", stdin: "true", stdout: "true", stderr: "true" },
        input: '{"token":"old"}',
      },
    ],
  );
  // A key of its own for each job, first on its stdin.
  assert.equal(attached[0].key.length, 32);
  assert.deepEqual(reached["oauth2.googleapis.com"], {
    allowed: true,
    private: false,
    cache: false,
    decrypt: false,
    relay: false,
    source: "install",
  });
  assert.equal(reached["daily-cloudcode-pa.googleapis.com"].allowed, true);
  assert.equal(reached["daily-cloudcode-pa.googleapis.com"].relay, false);
  // The agent is in its claim already: no install host.
  for (const host of ["github.com", "play.googleapis.com", "example.com"]) {
    assert.equal(reached[host].allowed, false, host);
  }
  // Gone with its pod.
  assert.equal(await images.egressFor("10.244.2.9", "oauth2.googleapis.com"), null);

  const pod = created.find((o) => o.metadata.name === "dh-job-antigravity-refresh");
  assert.equal(pod.metadata.labels["deckhand.role"], "install");
  const { spec } = pod;
  assert.equal(spec.restartPolicy, "Never");
  assert.equal(spec.automountServiceAccountToken, false);
  assert.equal(spec.enableServiceLinks, false);
  // Its network gate alone (kube-gate.mjs), waiting for the proxy too: it goes out through it.
  assert.deepEqual(
    spec.initContainers.map((c) => c.name),
    ["network-gate"],
  );
  assert.deepEqual(gateTargets(spec.initContainers[0]).at(-1), {
    what: "the egress proxy",
    host: "10.96.0.11",
    port: 3128,
    reach: true,
  });
  assert.deepEqual(spec.securityContext, {
    runAsNonRoot: true,
    runAsUser: SANDBOX_USER.uid,
    runAsGroup: SANDBOX_USER.gid,
    fsGroup: SANDBOX_USER.gid,
    fsGroupChangePolicy: "OnRootMismatch",
    seccompProfile: { type: "RuntimeDefault" },
  });
  const [c] = spec.containers;
  // Its stdout sealed with a one-time key (kube-seal.mjs): the node's log of it, shipped or not,
  // holds no token.
  assert.deepEqual(c.command, ["node", "-e", WRAPPER, "deckhand-antigravity-refresh"]);
  assert.equal(c.stdin, true);
  assert.equal(c.stdinOnce, true);
  assert.deepEqual(c.securityContext, {
    allowPrivilegeEscalation: false,
    capabilities: { drop: ["ALL"] },
    runAsNonRoot: true,
    seccompProfile: { type: "RuntimeDefault" },
  });
  // No Secret anywhere: neither envFrom nor a value from one, nor a volume of one; the login
  // isn't in its spec.
  assert.equal(c.envFrom, undefined);
  assert.ok(c.env.every((e) => e.value !== undefined && !e.valueFrom));
  assert.ok(!JSON.stringify(pod).includes("old"));
  const env = Object.fromEntries(c.env.map((e) => [e.name, e.value]));
  assert.equal(env.AGY_VERSION, "1.4.0");
  assert.equal(env.HTTPS_PROXY, "http://egress:3128");
  // The agent's claim read-only; the login's home an emptyDir, no claim of its own.
  assert.deepEqual(c.volumeMounts, [
    { name: "v0", mountPath: "/opt/antigravity", readOnly: true },
    { name: "v1", mountPath: "/home/node/.gemini" },
  ]);
  assert.deepEqual(spec.volumes, [
    { name: "v0", persistentVolumeClaim: { claimName: "dh-antigravity", readOnly: true } },
    { name: "v1", emptyDir: {} },
  ]);
  assert.ok(!created.some((o) => o.kind === "Secret"));
  assert.ok(!created.some((o) => o.metadata.name === "dh-antigravity-login"));
  assert.ok(removed.includes("pods/dh-job-antigravity-refresh"));
  assert.equal(objects.pods.size, 0);
});

test("Kubernetes: without an agent claim, the refresh pod installs the CLI in an init container", async (t) => {
  const reached = {};
  const { refresh, created, images } = refreshOn(t, {
    starting: [INSTALLING],
    looked: async () => {
      reached.installing = await images.egressFor("10.244.2.9", "github.com");
    },
    attach: async () => {
      reached.running = await images.egressFor("10.244.2.9", "github.com");
      reached.oauth = await images.egressFor("10.244.2.9", "oauth2.googleapis.com");
      return { out: "{}", err: "" };
    },
  });
  await refresh("{}");
  const { spec } = created.find((o) => o.metadata.name === "dh-job-antigravity-refresh");
  // After its network gate.
  const [gate, init] = spec.initContainers;
  assert.equal(gate.name, "network-gate");
  assert.deepEqual(init.command, ["deckhand-install-antigravity"]);
  assert.equal(init.securityContext.runAsUser, INSTALL_USER.uid);
  assert.deepEqual(init.volumeMounts, [{ name: "v0", mountPath: "/opt/antigravity" }]);
  const env = Object.fromEntries(init.env.map((e) => [e.name, e.value]));
  assert.equal(env.AGY_VERSION, "1.4.0");
  assert.equal(env.AGY_SHA256, "x64:ab");
  assert.deepEqual(spec.volumes[0], { name: "v0", emptyDir: {} });
  // Its install's hosts while its init container runs, never once `agy` does with the login.
  assert.equal(reached.installing.allowed, true);
  assert.equal(reached.running.allowed, false);
  assert.equal(reached.oauth.allowed, true);
});

test("Kubernetes: a refresh whose agent's install fails says why, with the installer's output, and its pod goes", async (t) => {
  const { refresh, attached, logs, removed, objects } = refreshOn(t, {
    api: { installLog: "release-install: sha256 mismatch\n" },
    starting: [
      INSTALLING,
      {
        phase: "Failed",
        initContainerStatuses: [{ name: "agent-install", state: { terminated: { exitCode: 1 } } }],
        containerStatuses: [{ state: { waiting: { reason: "PodInitializing" } } }],
      },
    ],
    attach: async () => assert.fail("never attached"),
  });
  const result = await refresh("{}");
  assert.equal(result.code, -1);
  assert.equal(result.out, "");
  assert.match(
    result.err,
    /^release-install: sha256 mismatch\ninstalling the agent in its init container failed \(exit 1\): release-install: sha256 mismatch$/,
  );
  assert.deepEqual(attached, []);
  assert.deepEqual(logs, [
    { path: "pods/dh-job-antigravity-refresh/log", query: { container: "agent-install" } },
  ]);
  assert.ok(removed.includes("pods/dh-job-antigravity-refresh"));
  assert.equal(objects.pods.size, 0);
});

test("Kubernetes: a refresh pod whose NetworkPolicies don't apply fails before anything of it runs, and goes", async (t) => {
  const { refresh, attached, logs, removed, objects } = refreshOn(t, {
    api: { gateLog: "still reached the cluster's DNS (10.96.0.10:53) after 600 s\n" },
    starting: [
      {
        phase: "Failed",
        initContainerStatuses: [{ name: "network-gate", state: { terminated: { exitCode: 3 } } }],
        containerStatuses: [{ state: { waiting: { reason: "PodInitializing" } } }],
      },
    ],
    attach: async () => assert.fail("never attached"),
  });
  const result = await refresh("{}");
  assert.equal(result.code, -1);
  assert.match(
    result.err,
    /^the pod dh-job-antigravity-refresh: its NetworkPolicies didn't apply: still reached the cluster's DNS \(10\.96\.0\.10:53\) after 600 s$/,
  );
  assert.deepEqual(attached, []);
  assert.deepEqual(logs, [
    { path: "pods/dh-job-antigravity-refresh/log", query: { container: "network-gate" } },
  ]);
  assert.ok(removed.includes("pods/dh-job-antigravity-refresh"));
  assert.equal(objects.pods.size, 0);
});

test("Kubernetes: a refresh pod that never starts fails within the models service's lease, and goes", async (t) => {
  const pending = {
    phase: "Pending",
    containerStatuses: [
      { state: { waiting: { reason: "ImagePullBackOff", message: "no such tag" } } },
    ],
  };
  const { refresh, removed, objects, clock } = refreshOn(t, {
    kubernetes: { agentStorageClass: "nfs" },
    starting: Array(1000).fill(pending),
    attach: async () => assert.fail("never attached"),
  });
  const since = clock.at;
  const result = await refresh("{}");
  assert.equal(result.code, -1);
  assert.match(result.err, /didn't start in time \(ImagePullBackOff: no such tag\)/);
  // Before another copy of the models service may take the login over.
  assert.ok(clock.at - since < LOGIN_REFRESH_MS, `${clock.at - since} ms`);
  assert.ok(removed.includes("pods/dh-job-antigravity-refresh"));
  assert.equal(objects.pods.size, 0);
});

test("Kubernetes: refreshes at once take turns on their one pod, each answered", async (t) => {
  let release;
  const held = new Promise((resolve) => (release = resolve));
  const live = [];
  const { refresh, attached, objects, created } = refreshOn(t, {
    kubernetes: { agentStorageClass: "nfs" },
    attach: async (input) => {
      live.push(objects.pods.size);
      if (input === "first") await held;
      return { out: `${input} refreshed`, err: "" };
    },
  });
  const first = refresh("first");
  const second = refresh("second");
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
  // The second waits for the first's pod to go.
  assert.deepEqual(
    attached.map((a) => a.input),
    ["first"],
  );
  release();
  assert.deepEqual(await first, { code: 0, out: "first refreshed", err: "" });
  assert.deepEqual(await second, { code: 0, out: "second refreshed", err: "" });
  assert.deepEqual(
    attached.map((a) => a.input),
    ["first", "second"],
  );
  // One pod at a time, each made after the last went.
  assert.deepEqual(live, [1, 1]);
  assert.equal(created.filter((o) => o.metadata.name === "dh-job-antigravity-refresh").length, 2);
  assert.equal(objects.pods.size, 0);
});

test("Kubernetes: a refresh that fails or can't be attached to says so, and its pod goes all the same", async (t) => {
  const failed = refreshOn(t, {
    kubernetes: { agentStorageClass: "nfs" },
    exitCode: 1,
    attach: async () => ({ out: "", err: "token refresh failed: invalid_grant" }),
  });
  assert.deepEqual(await failed.refresh("{}"), {
    code: 1,
    out: "",
    err: "token refresh failed: invalid_grant",
  });
  assert.ok(failed.removed.includes("pods/dh-job-antigravity-refresh"));

  const cut = refreshOn(t, {
    kubernetes: { agentStorageClass: "nfs" },
    attach: async () => {
      throw new Error("GET pods/dh-job-antigravity-refresh/attach: forbidden");
    },
  });
  const result = await cut.refresh("{}");
  assert.equal(result.code, -1);
  assert.match(result.err, /attaching to the pod dh-job-antigravity-refresh: .*forbidden/);
  assert.ok(cut.removed.includes("pods/dh-job-antigravity-refresh"));
  assert.equal(cut.objects.pods.size, 0);
});

test("Kubernetes: a refresh whose output isn't sealed with its key is not read", async (t) => {
  const { backend, api, removed } = refreshOn(t, {
    kubernetes: { agentStorageClass: "nfs" },
    attach: async () => ({ out: "", err: "" }),
  });
  // A container that printed the file itself, as it is, rather than through the wrapper.
  api.attach = async () => ({ out: '{"token":{"refresh_token":"1//x"}}', err: "" });
  await backend.installAgent({ ...antigravity.install(config), name: "antigravity" });
  const result = await backend.runJob({
    name: "antigravity-refresh",
    image: BASE,
    network: "install",
    user: SANDBOX_USER,
    entrypoint: "deckhand-antigravity-refresh",
    volumes: [{ name: "dh-antigravity", path: "/opt/antigravity", readOnly: true }],
    input: "{}",
  });
  assert.equal(result.code, -1);
  assert.equal(result.out, "");
  assert.match(result.err, /isn't sealed with its key: not read/);
  assert.ok(!result.err.includes("1//x"));
  assert.ok(removed.includes("pods/dh-job-antigravity-refresh"));
});

test("Kubernetes: a job that asks for root or a capability is refused, no pod made", async (t) => {
  const { backend, created } = setup(t);
  const job = { name: "x", image: BASE, network: "install", entrypoint: "true" };
  await assert.rejects(backend.runJob({ ...job, user: { uid: 0 } }), /never root/);
  await assert.rejects(
    backend.runJob({ ...job, user: SANDBOX_USER, caps: ["CHOWN"] }),
    /adds no capabilities/,
  );
  await assert.rejects(
    backend.runJob({ ...job, user: SANDBOX_USER, network: "none" }),
    /install network, not none/,
  );
  assert.ok(!created.some((o) => o.kind === "Pod"));
});

// What the runner's metrics count a prune as (../runner/metrics.mjs).
test("remove: a tag deleted, kept while a pod runs it, failed when the registry refuses", async (t) => {
  const { images, backend, objects } = setup(t);
  const main = await images.imageFor({ repo: "org/a", ref: "main", dockerfile: "Dockerfile" });
  objects.pods.set("sandbox", { spec: { containers: [{ image: main }] } });
  assert.equal(await backend.remove(main), "kept");
  objects.pods.delete("sandbox");
  assert.equal(await backend.remove(main), "deleted");
  assert.equal(await backend.remove(main), null);
  const refusing = setup(t, { registry: { deletes: false } });
  const tag = await refusing.images.imageFor({
    repo: "org/a",
    ref: "main",
    dockerfile: "Dockerfile",
  });
  assert.equal(await refusing.backend.remove(tag), "failed");
});
