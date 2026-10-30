// Images on the Kubernetes runner (runner/kube-images.mjs, through ../listener/images.mjs):
// repo images built by buildctl and pushed to a registry, found again by a manifest HEAD and
// pruned through its API; agents installed by a pod of their own into a claim, or left to
// the sandboxes' init containers; caches as claims; and what the egress proxy lets the
// builder and the installs reach. Against recorded fakes of the API, the registry and
// buildctl.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { antigravity } from "../listener/agents/antigravity.mjs";
import { claude } from "../listener/agents/claude.mjs";
import { createImages, imageRef, KEEP_TAGS } from "../listener/images.mjs";
import { buildArgs } from "../listener/runner/buildkit.mjs";
import { createKubernetesImages } from "../listener/runner/kube-images.mjs";
import { INSTALL_USER } from "../listener/runner/kubernetes.mjs";
import { authsOf, challenge, createRegistry, parseRef } from "../listener/runner/registry.mjs";
import { SANDBOX_USER } from "../listener/sandbox-spec.mjs";
import { tempDir } from "./helpers.mjs";

const REGISTRY = "registry.example.com";
const BASE = "ghcr.io/acme/deckhand-sandbox:1.2";

const config = {
  prefix: "dh",
  image: BASE,
  runner: "kubernetes",
  brokerUrl: "http://listener:8081",
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
  return { fetch, images, calls };
}

// A namespace's API, as kube-api.mjs answers it: objects by resource then name. Pods the
// install creates end as `install` says ("Succeeded", "Failed"), their log `installLog`;
// with `hold`, they run until finish() is called.
function fakeApi({
  install = "Succeeded",
  installLog = "Claude Code 9.9.9 installed\n",
  hold = false,
} = {}) {
  let finished = !hold;
  const objects = {
    pods: new Map(),
    secrets: new Map([
      [
        "pull",
        { data: { ".dockerconfigjson": Buffer.from(JSON.stringify(PULL)).toString("base64") } },
      ],
    ]),
    persistentvolumeclaims: new Map(),
    endpointslices: new Map(),
  };
  const created = [];
  const removed = [];
  const split = (path) => {
    const [kind, name] = path.split("/");
    return { store: objects[kind], name };
  };
  const api = {
    namespace: "runs",
    async find(path) {
      const { store, name } = split(path);
      const found = store.get(name) ?? null;
      if (found?.kind === "Pod" && !finished)
        return { ...found, status: { ...found.status, phase: "Running" } };
      return found;
    },
    async get(path, query = {}) {
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
          ? {
              phase: install,
              podIP: "10.244.2.9",
              containerStatuses: [
                { state: { terminated: { exitCode: install === "Succeeded" ? 0 : 1 } } },
              ],
            }
          : {};
      store.set(body.metadata.name, { ...body, status });
      return body;
    },
    async remove(path) {
      removed.push(path);
      const { store, name } = split(path);
      return store.delete(name);
    },
    async stream() {
      return new Response(installLog);
    },
  };
  return { api, objects, created, removed, finish: () => (finished = true) };
}

// buildctl, recorded: each call's arguments and the docker config it was handed; a build
// "pushes" its image to `registry`. `fail`: exit 1 instead. `hold`: a promise each build
// waits for first.
function fakeBuildctl(registry, clock, { fail = false, hold } = {}) {
  const calls = [];
  const buildctl = async (args, { env, onData }) => {
    const call = {
      args,
      dockerConfig: JSON.parse(readFileSync(join(env.DOCKER_CONFIG, "config.json"), "utf8")),
    };
    calls.push(call);
    if (hold) await hold();
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

function setup(
  t,
  { kubernetes = {}, api: apiOptions, build: buildOptions, registry: regOptions } = {},
) {
  const clock = { at: Date.parse("2026-10-30T10:00:00Z") };
  const registry = fakeRegistry(regOptions);
  const fake = fakeApi(apiOptions);
  const build = fakeBuildctl(registry, clock, buildOptions);
  const logged = [];
  const cfg = { ...config, kubernetes: { ...config.kubernetes, ...kubernetes } };
  const backend = createKubernetesImages({
    config: cfg,
    api: fake.api,
    fetch: registry.fetch,
    buildctl: build.buildctl,
    log: (line) => logged.push(line),
    now: () => clock.at,
    // Time passes, and other tasks get their turn.
    sleep: async (ms) => {
      clock.at += ms;
      await new Promise((resolve) => setImmediate(resolve));
    },
  });
  const checkouts = [];
  const images = createImages({
    config: cfg,
    backend,
    jobs: {},
    readFile: async (repo, path, ref) =>
      path === "missing" ? null : { sha: `blob@${ref}`, text: "" },
    checkout: async (repo, ref) => {
      checkouts.push(ref);
      return tempDir(t, "deckhand-ctx-");
    },
  });
  return { ...fake, registry, build, backend, images, checkouts, clock, logged };
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
  assert.ok(args.includes(`dockerfile=${dir}/docker`));
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
  const { images, build, registry } = setup(t);
  const ask = () =>
    images.imageFor({ repo: "org/a", ref: "main", dockerfile: "Dockerfile", access });
  const first = await ask();
  // The same tag of the base pushed again: a new digest, a new image.
  registry.images.set(BASE, { digest: "sha256:base2", created: 2 });
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
  const { images, objects } = setup(t, { build: { hold: () => held } });
  objects.endpointslices.set("buildkitd", [{ endpoints: [{ addresses: ["10.244.3.3"] }] }]);
  const ip = "10.244.3.3";
  assert.deepEqual(await images.egressFor(ip, "pypi.org"), {
    allowed: false,
    private: false,
    cache: false,
    decrypt: false,
    relay: false,
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
  });
  assert.equal((await images.egressFor(ip, "evil.example")).allowed, false);
  // The registries it pulls from and pushes to.
  assert.equal((await images.egressFor(ip, REGISTRY)).allowed, true);
  assert.equal((await images.egressFor(ip, "ghcr.io")).allowed, true);
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
  const [c] = spec.containers;
  assert.equal(c.image, BASE);
  assert.deepEqual(c.command, ["deckhand-install-claude-code"]);
  assert.deepEqual(c.securityContext, {
    allowPrivilegeEscalation: false,
    capabilities: { drop: ["ALL"] },
    runAsNonRoot: true,
    seccompProfile: { type: "RuntimeDefault" },
  });
  const env = Object.fromEntries(c.env.map((e) => [e.name, e.value]));
  assert.equal(env.CLAUDE_CODE_VERSION, "9.9.9");
  assert.equal(env.HTTPS_PROXY, "http://egress:3128");
  assert.deepEqual(c.volumeMounts, [{ name: "agent", mountPath: "/opt/claude-code" }]);
  assert.deepEqual(spec.volumes, [
    { name: "agent", persistentVolumeClaim: { claimName: "dh-claude-code" } },
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
  const { images, created } = setup(t, { kubernetes: { cacheStorageClass: "nfs" } });
  assert.equal(images.keepsCaches, true);
  assert.equal(images.noCaches, null);
  const found = await images.caches("org/a", ["/home/node/.npm"], BASE);
  assert.equal(found.length, 1);
  assert.equal(found[0].path, "/home/node/.npm");
  const [claim] = created;
  assert.equal(claim.metadata.name, found[0].name);
  assert.equal(claim.metadata.labels["deckhand.role"], "cache");
  assert.equal(claim.metadata.annotations["deckhand.cache"], "/home/node/.npm");
  assert.deepEqual(claim.spec, {
    accessModes: ["ReadWriteMany"],
    resources: { requests: { storage: "10Gi" } },
    storageClassName: "nfs",
  });
  // Made once, then found.
  await images.caches("org/a", ["/home/node/.npm"], BASE);
  assert.equal(created.length, 1);
});

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
