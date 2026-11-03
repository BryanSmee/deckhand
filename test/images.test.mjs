import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { antigravity } from "../listener/agents/antigravity.mjs";
import { claude } from "../listener/agents/claude.mjs";
import {
  KEEP_TAGS,
  archivedBlobs,
  createImages,
  gitBlob,
  imageRef,
  imageTag,
} from "../listener/images.mjs";
import { legacyRepoImage, repoImage } from "../listener/repo-config.mjs";
import { createDockerImages } from "../listener/runner/images.mjs";
import { createDockerJobs } from "../listener/runner/jobs.mjs";
import { createRegistry } from "../lib/metrics.mjs";
import { runnerMetrics } from "../runner/metrics.mjs";
import { buildContext, contextBlob, tempDir, testConfig, withBlobs } from "./helpers.mjs";

const config = testConfig({ ALLOWED_USERS: "a", CLAUDE_CODE_VERSION: "9.9.9" });
const A = repoImage(config, "org/a");

// Plays Docker: `images` are the tags that exist, `volumes` the volumes; every call is kept.
function fakeDocker({
  base = "sha256:base",
  images = new Set(),
  volumes = new Set(),
  fail = {},
  inUse = new Set(), // tags a container runs: `docker image rm` refuses them
  unremovable = new Set(), // tags `docker image rm` fails on otherwise
} = {}) {
  const calls = [];
  const docker = async (args) => {
    calls.push(args.join(" "));
    const [command, sub] = args;
    if (fail[command]) return { code: 1, out: "", err: fail[command] };
    if (command === "image" && sub === "inspect") {
      const name = args.at(-1);
      if (name === config.image) return { code: base ? 0 : 1, out: base ?? "", err: "" };
      return { code: images.has(name) ? 0 : 1, out: "", err: "" };
    }
    if (command === "image" && sub === "ls") {
      return {
        code: 0,
        out: [...images]
          .reverse()
          .filter((i) => i.split(":")[0] === args.at(-1))
          .map((i) => i.split(":")[1])
          .join("\n"),
        err: "",
      };
    }
    if (command === "image" && sub === "rm" && inUse.has(args[2])) {
      return {
        code: 1,
        out: "",
        err: `Error response from daemon: conflict: unable to remove repository reference "${args[2]}" (must force) - container 0123 is using its referenced image`,
      };
    }
    if (command === "image" && sub === "rm" && unremovable.has(args[2])) {
      return { code: 1, out: "", err: "Error response from daemon: layer store busy" };
    }
    if (command === "image" && sub === "rm") images.delete(args[2]);
    if (command === "build") images.add(args[args.indexOf("-t") + 1]);
    if (command === "volume" && sub === "inspect")
      return { code: volumes.has(args[2]) ? 0 : 1, out: "", err: "" };
    if (command === "volume" && sub === "create") volumes.add(args.at(-1));
    return { code: 0, out: "", err: "" };
  };
  return { docker, calls, tags: images, volumes };
}

// The Docker runner's backends, on the fake: what images.mjs asks them is what Docker gets.
const onDocker = (docker) => ({
  backend: createDockerImages({ config, docker }),
  jobs: createDockerJobs({ config, docker }),
});

function setup(t, options, blob = "blob1", metrics = null) {
  const fake = fakeDocker(options);
  const checkouts = [];
  const images = withBlobs(
    createImages({
      config,
      ...onDocker(fake.docker),
      metrics,
      checkout: async (repo, ref) => {
        checkouts.push(ref);
        return buildContext(t, `${blob}@${ref}`);
      },
    }),
    async (repo, path, ref) => (path === "missing" ? null : { sha: contextBlob(`${blob}@${ref}`) }),
  );
  return { ...fake, images, checkouts };
}

test("a repo without a Dockerfile runs on the base image", async (t) => {
  const { images, calls } = setup(t);
  assert.equal(
    await images.imageFor({ repo: "org/a", ref: "main", dockerfile: null }),
    "deckhand-sandbox",
  );
  assert.ok(!calls.some((c) => c.startsWith("build")));
});

test("a missing base image is a clear error", async (t) => {
  const { images } = setup(t, { base: null });
  await assert.rejects(images.imageFor({ repo: "org/a", ref: "main" }), /docker compose build/);
});

test("a repo's Dockerfile is built once from its ref, then reused", async (t) => {
  const { images, calls, checkouts } = setup(t);
  let builds = 0;
  const ask = () =>
    images.imageFor({
      repo: "Org/A",
      ref: "main",
      dockerfile: "Dockerfile",
      onBuild: () => builds++,
    });
  // Two runs at once share one build.
  const [first, second] = await Promise.all([ask(), ask()]);
  assert.equal(first, second);
  assert.match(first, /^deckhand-repo-org-a-[0-9a-f]{10}:[0-9a-f]{16}$/);
  assert.equal(first.split(":")[0], A);
  assert.equal(calls.filter((c) => c.startsWith("build")).length, 1);
  assert.deepEqual(checkouts, ["main"]);
  assert.equal(builds, 2);
  const build = calls.find((c) => c.startsWith("build"));
  assert.match(build, /--build-arg DECKHAND_BASE=deckhand-sandbox/);
  assert.match(build, /--label deckhand\.repo=org\/a/);
  assert.equal(await ask(), first);
  assert.equal(calls.filter((c) => c.startsWith("build")).length, 1);
});

// The tag names the Dockerfile's blob as the github service said it; the files built come in a
// tarball of their own (#503): built only when their Dockerfile is that blob, never stored under
// a tag that names another Dockerfile.
test("a build whose files hold another Dockerfile than its tag names is refused, nothing tagged", async (t) => {
  const fake = fakeDocker();
  const images = withBlobs(
    createImages({
      config,
      ...onDocker(fake.docker),
      checkout: async () => buildContext(t, "something else"),
    }),
    async () => ({ sha: contextBlob("the default branch's") }),
  );
  const ask = () => images.imageFor({ repo: "org/a", ref: "main", dockerfile: "Dockerfile" });
  await assert.rejects(ask(), /not the Dockerfile its tag names/);
  assert.ok(!fake.calls.some((c) => c.startsWith("build")));
  assert.equal(fake.tags.size, 0);
  // No Dockerfile in its files at all: the same.
  const none = withBlobs(
    createImages({
      config,
      ...onDocker(fake.docker),
      checkout: async () => tempDir(t, "deckhand-ctx-"),
    }),
    async () => ({ sha: contextBlob("x") }),
  );
  await assert.rejects(
    none.imageFor({ repo: "org/a", ref: "main", dockerfile: "Dockerfile" }),
    (error) => /\(none in its files/.test(error.message) && error.code === "DOCKERFILE_MOVED",
  );
});

// GitHub's tarballs come from `git archive`, which applies .gitattributes: `eol=crlf` and `ident`
// change the Dockerfile written, not the blob GitHub names. The same Dockerfile still builds.
test("a Dockerfile git archive wrote with CRLF line ends or an expanded $Id$ still builds", async (t) => {
  const stored = "FROM deckhand-sandbox\n# $Id$\nRUN true\n";
  const archived = [
    stored.replace(/\n/g, "\r\n"),
    stored.replace("$Id$", `$Id: ${"a".repeat(40)} $`),
    stored.replace("$Id$", `$Id: ${"b".repeat(40)} $`).replace(/\n/g, "\r\n"),
  ];
  for (const text of archived) {
    assert.ok(archivedBlobs(Buffer.from(text)).has(gitBlob(Buffer.from(stored))), text);
    const fake = fakeDocker();
    const images = withBlobs(
      createImages({
        config,
        ...onDocker(fake.docker),
        checkout: async () => {
          const dir = tempDir(t, "deckhand-ctx-");
          writeFileSync(join(dir, "Dockerfile"), text);
          return dir;
        },
      }),
      async () => ({ sha: gitBlob(Buffer.from(stored)) }),
    );
    await images.imageFor({ repo: "org/a", ref: "main", dockerfile: "Dockerfile" });
    assert.equal(fake.calls.filter((c) => c.startsWith("build")).length, 1);
  }
  // Another Dockerfile, CRLF or not, still doesn't.
  const other = Buffer.from("FROM deckhand-sandbox\r\nRUN false\r\n");
  assert.ok(!archivedBlobs(other).has(gitBlob(Buffer.from(stored))));
});

test("a new base image or a changed Dockerfile means a new tag", () => {
  const tag = imageTag(config, "org/a", "sha256:1", "Dockerfile", "blob1");
  assert.notEqual(tag, imageTag(config, "org/a", "sha256:2", "Dockerfile", "blob1"));
  assert.notEqual(tag, imageTag(config, "org/a", "sha256:1", "Dockerfile", "blob2"));
  assert.notEqual(tag, imageTag(config, "org/b", "sha256:1", "Dockerfile", "blob1"));
  // Repos whose names slug alike: neither name nor tag is shared.
  const [x, y] = ["acme/x.y", "acme/x-y"].map((r) =>
    imageTag(config, r, "sha256:1", "Dockerfile", "blob1"),
  );
  assert.notEqual(x.split(":")[0], y.split(":")[0]);
  assert.notEqual(x.split(":")[1], y.split(":")[1]);
  const branch = imageTag(config, "org/a", "sha256:1", "Dockerfile", "blob1", "abc");
  assert.notEqual(branch, tag);
  assert.notEqual(branch, imageTag(config, "org/a", "sha256:1", "Dockerfile", "blob1", "def"));
});

test("a branch build never takes the default branch's tag", async (t) => {
  const fake = fakeDocker();
  const checkouts = [];
  const images = withBlobs(
    createImages({
      config,
      ...onDocker(fake.docker),
      checkout: async (repo, ref) => {
        checkouts.push(ref);
        return buildContext(t, "same");
      },
    }),
    // The same Dockerfile blob at both refs: only the build context may differ.
    async () => ({ sha: contextBlob("same") }),
  );
  const ask = (ref, branch) =>
    images.imageFor({ repo: "org/a", ref, branch, dockerfile: "Dockerfile" });
  const branch = await ask("abc", true);
  assert.match(branch, /^deckhand-repo-org-a-[0-9a-f]{10}:branch-[0-9a-f]{16}$/);
  // Built from the branch first, the default branch still builds its own.
  const main = await ask("main", false);
  assert.notEqual(main, branch);
  assert.doesNotMatch(main, /:branch-/);
  assert.deepEqual(checkouts, ["abc", "main"]);
  // Each reused for its own ref; another commit of the branch builds again.
  assert.equal(await ask("main", false), main);
  assert.equal(await ask("abc", true), branch);
  assert.notEqual(await ask("def", true), branch);
  assert.equal(fake.calls.filter((c) => c.startsWith("build")).length, 3);
});

test("pruning keeps the default branch's tag through branch builds", async (t) => {
  const branches = Array.from({ length: 4 }, (_, k) => `${A}:branch-old${k}`);
  const { images, tags: existing } = setup(t, {
    images: new Set([`${A}:main1`, ...branches]),
  });
  const tag = await images.imageFor({
    repo: "org/a",
    ref: "abc",
    branch: true,
    dockerfile: "Dockerfile",
  });
  assert.equal(existing.size, KEEP_TAGS);
  assert.ok(existing.has(tag));
  assert.ok(existing.has(`${A}:main1`));
  assert.ok(existing.has(`${A}:branch-old3`));
});

test("old tags are pruned, the most recent kept", async (t) => {
  const old = Array.from({ length: 5 }, (_, k) => `${A}:old${k}`);
  const { images, tags: existing } = setup(t, { images: new Set(old) });
  const tag = await images.imageFor({ repo: "org/a", ref: "main", dockerfile: "Dockerfile" });
  assert.ok(existing.has(tag));
  assert.equal(existing.size, KEEP_TAGS);
  assert.ok(existing.has(`${A}:old4`));
  assert.ok(!existing.has(`${A}:old0`));
});

test("pruning one repo's tags never removes another's, the unhashed names go", async (t) => {
  const other = Array.from({ length: 5 }, (_, k) => `${repoImage(config, "org-a")}:old${k}`);
  const legacy = [`${legacyRepoImage(config, "org/a")}:old`];
  const old = Array.from({ length: 5 }, (_, k) => `${A}:old${k}`);
  const { images, tags: existing } = setup(t, { images: new Set([...other, ...legacy, ...old]) });
  await images.imageFor({ repo: "org/a", ref: "main", dockerfile: "Dockerfile" });
  for (const tag of other) assert.ok(existing.has(tag), tag);
  assert.ok(!existing.has(legacy[0]));
  assert.equal([...existing].filter((i) => i.startsWith(`${A}:`)).length, KEEP_TAGS);
});

test("a failed build fails the run and is tried again next time", async (t) => {
  const { images, calls } = setup(t, { fail: { build: "no such file" } });
  const ask = () => images.imageFor({ repo: "org/a", ref: "main", dockerfile: "Dockerfile" });
  await assert.rejects(ask(), /building Dockerfile of org\/a failed.*no such file/);
  await assert.rejects(ask());
  assert.equal(calls.filter((c) => c.startsWith("build")).length, 2);
  await assert.rejects(
    images.imageFor({ repo: "org/a", ref: "main", dockerfile: "missing" }),
    /missing .* is not in org\/a at main/,
  );
});

test("branch images: with the operator's grant, a pull request's own branch, never a fork's", () => {
  const grant = { allowBranchDockerImages: true };
  const settings = { dockerfile: "Dockerfile" };
  const pr = (fullName) => ({
    head: { sha: "abc", repo: fullName ? { full_name: fullName } : null },
  });
  assert.deepEqual(imageRef(grant, settings, "org/a", "main", pr("Org/A")), {
    ref: "abc",
    branch: true,
  });
  assert.deepEqual(imageRef(grant, settings, "org/a", "main", pr("mallory/a")), {
    ref: "main",
    branch: false,
  });
  // The fork was deleted: GitHub gives no head repo.
  assert.deepEqual(imageRef(grant, settings, "org/a", "main", pr(null)), {
    ref: "main",
    branch: false,
  });
  const off = { allowBranchDockerImages: false };
  assert.deepEqual(imageRef(off, settings, "org/a", "main", pr("org/a")), {
    ref: "main",
    branch: false,
  });
  assert.deepEqual(imageRef(grant, { dockerfile: null }, "org/a", "main", pr("org/a")), {
    ref: "main",
    branch: false,
  });
  assert.deepEqual(imageRef(grant, settings, "org/a", "main", null), {
    ref: "main",
    branch: false,
  });
});

test("an agent installs once per version, in a container of its own", async (t) => {
  const { images, calls } = setup(t);
  await Promise.all([images.installAgent(claude), images.installAgent(claude)]);
  await images.installAgent(claude);
  const installs = calls.filter((c) => c.includes("deckhand-install-claude-code"));
  assert.equal(installs.length, 1);
  assert.match(
    installs[0],
    /-e CLAUDE_CODE_VERSION=9\.9\.9 -v deckhand-claude-code:\/opt\/claude-code/,
  );
  // npm's registry is outside the sandboxes' internal network.
  assert.match(installs[0], /^run --rm --network bridge /);
  // As root, so uid 1000 (the sandbox's user) can't change the files; CHOWN only, to take
  // over a volume an older install left to uid 1000.
  assert.match(
    installs[0],
    / --user 0 --cap-drop ALL --cap-add CHOWN --security-opt no-new-privileges /,
  );
  // The Antigravity CLI's: with the sha256 its tarball must have.
  await images.installAgent(antigravity);
  const agy = calls.find((c) => c.includes("deckhand-install-antigravity"));
  assert.match(agy, /-e AGY_VERSION=1\.4\.0 -e AGY_SHA256=x64:[0-9a-f]{64},arm64:[0-9a-f]{64} -v /);
});

test("cache volumes: created once per repo and path, owned by the sandbox's user", async (t) => {
  const { images, calls } = setup(t);
  const [cache] = await images.caches("org/a", ["/home/node/.npm"], "img:1");
  assert.equal(cache.path, "/home/node/.npm");
  assert.match(cache.name, /^deckhand-cache-org-a-home-node-npm-\w+$/);
  await images.caches("org/a", ["/home/node/.npm"], "img:1");
  assert.equal(calls.filter((c) => c.startsWith("volume create")).length, 1);
  assert.match(
    calls.find((c) => c.includes("chown")),
    /--user 0 --cap-drop ALL --cap-add CHOWN --security-opt no-new-privileges -v \S+:\/home\/node\/\.npm --entrypoint chown img:1 1000:1000/,
  );
  // Another repo, same path: its own volume.
  const [other] = await images.caches("org/b", ["/home/node/.npm"], "img:1");
  assert.notEqual(other.name, cache.name);
});

// The runner's metrics (../runner/metrics.mjs), counted where images.mjs builds, prunes and
// installs.
test("builds, prunes and installs are counted in the runner's metrics", async (t) => {
  const registry = createRegistry();
  const metrics = runnerMetrics(registry, { runner: "docker", active: () => true });
  const old = Array.from({ length: 5 }, (_, k) => `${A}:old${k}`);
  const { images } = setup(
    t,
    { images: new Set(old), inUse: new Set([old[0]]), unremovable: new Set([old[1]]) },
    "b",
    metrics,
  );
  await images.imageFor({ repo: "org/a", ref: "main", dockerfile: "Dockerfile" });
  await images.installAgent(claude);
  const text = await registry.render();
  const has = (line) => assert.ok(text.includes(`${line}\n`), line);
  has('deckhand_image_builds_total{runner="docker",result="ok"} 1');
  has("deckhand_image_build_seconds_count 1");
  // Five old tags and the new one: three kept by the prune, one in use, one Docker failed on,
  // one deleted.
  has('deckhand_image_prunes_total{result="deleted"} 1');
  has('deckhand_image_prunes_total{result="kept"} 1');
  has('deckhand_image_prunes_total{result="failed"} 1');
  has('deckhand_agent_installs_total{agent="claude",result="ok"} 1');

  const failing = setup(t, { fail: { build: "no such file", run: "npm: 403" } }, "b", metrics);
  await assert.rejects(
    failing.images.imageFor({ repo: "org/a", ref: "main", dockerfile: "Dockerfile" }),
  );
  await assert.rejects(failing.images.installAgent(claude));
  const after = await registry.render();
  assert.ok(after.includes('deckhand_image_builds_total{runner="docker",result="error"} 1\n'));
  assert.ok(after.includes("deckhand_image_build_seconds_count 2\n"));
  assert.ok(after.includes('deckhand_agent_installs_total{agent="claude",result="error"} 1\n'));
});
