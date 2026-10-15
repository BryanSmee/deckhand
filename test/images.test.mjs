import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../listener/config.mjs";
import { KEEP_TAGS, createImages, imageRef, imageTag } from "../listener/images.mjs";

const config = loadConfig({ ALLOWED_USERS: "a", CLAUDE_CODE_VERSION: "9.9.9" });

// Plays Docker: `images` are the tags that exist, `volumes` the volumes; every call is kept.
function fakeDocker({
  base = "sha256:base",
  images = new Set(),
  volumes = new Set(),
  fail = {},
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
          .map((i) => i.split(":")[1])
          .join("\n"),
        err: "",
      };
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

function setup(options, blob = "blob1") {
  const fake = fakeDocker(options);
  const checkouts = [];
  const images = createImages({
    config,
    docker: fake.docker,
    readFile: async (repo, path, ref) =>
      path === "missing" ? null : { sha: `${blob}@${ref}`, text: "" },
    checkout: async (repo, ref) => {
      checkouts.push(ref);
      return mkdtempSync(join(tmpdir(), "deckhand-ctx-"));
    },
  });
  return { ...fake, images, checkouts };
}

test("a repo without a Dockerfile runs on the base image", async () => {
  const { images, calls } = setup();
  assert.equal(
    await images.imageFor({ repo: "org/a", ref: "main", dockerfile: null }),
    "deckhand-sandbox",
  );
  assert.ok(!calls.some((c) => c.startsWith("build")));
});

test("a missing base image is a clear error", async () => {
  const { images } = setup({ base: null });
  await assert.rejects(images.imageFor({ repo: "org/a", ref: "main" }), /docker compose build/);
});

test("a repo's Dockerfile is built once from its ref, then reused", async () => {
  const { images, calls, checkouts } = setup();
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
  assert.match(first, /^deckhand-repo-org-a:[0-9a-f]{16}$/);
  assert.equal(calls.filter((c) => c.startsWith("build")).length, 1);
  assert.deepEqual(checkouts, ["main"]);
  assert.equal(builds, 2);
  const build = calls.find((c) => c.startsWith("build"));
  assert.match(build, /--build-arg DECKHAND_BASE=deckhand-sandbox/);
  assert.match(build, /--label deckhand\.repo=org\/a/);
  assert.equal(await ask(), first);
  assert.equal(calls.filter((c) => c.startsWith("build")).length, 1);
});

test("a new base image or a changed Dockerfile means a new tag", () => {
  const tag = imageTag(config, "org/a", "sha256:1", "Dockerfile", "blob1");
  assert.notEqual(tag, imageTag(config, "org/a", "sha256:2", "Dockerfile", "blob1"));
  assert.notEqual(tag, imageTag(config, "org/a", "sha256:1", "Dockerfile", "blob2"));
  assert.notEqual(tag, imageTag(config, "org/b", "sha256:1", "Dockerfile", "blob1"));
});

test("old tags are pruned, the most recent kept", async () => {
  const old = Array.from({ length: 5 }, (_, k) => `deckhand-repo-org-a:old${k}`);
  const { images, tags: existing } = setup({ images: new Set(old) });
  const tag = await images.imageFor({ repo: "org/a", ref: "main", dockerfile: "Dockerfile" });
  assert.ok(existing.has(tag));
  assert.equal(existing.size, KEEP_TAGS);
  assert.ok(existing.has("deckhand-repo-org-a:old4"));
  assert.ok(!existing.has("deckhand-repo-org-a:old0"));
});

test("a failed build fails the run and is tried again next time", async () => {
  const { images, calls } = setup({ fail: { build: "no such file" } });
  const ask = () => images.imageFor({ repo: "org/a", ref: "main", dockerfile: "Dockerfile" });
  await assert.rejects(ask(), /building Dockerfile of org\/a failed.*no such file/);
  await assert.rejects(ask());
  assert.equal(calls.filter((c) => c.startsWith("build")).length, 2);
  await assert.rejects(
    images.imageFor({ repo: "org/a", ref: "main", dockerfile: "missing" }),
    /missing .* is not in org\/a at main/,
  );
});

test("branch images: a pull request's own branch, never a fork's", () => {
  const allowed = { allowBranchDockerImages: true, dockerfile: "Dockerfile" };
  const pr = (fullName) => ({
    head: { sha: "abc", repo: fullName ? { full_name: fullName } : null },
  });
  assert.deepEqual(imageRef(allowed, "org/a", "main", pr("Org/A")), { ref: "abc", branch: true });
  assert.deepEqual(imageRef(allowed, "org/a", "main", pr("mallory/a")), {
    ref: "main",
    branch: false,
  });
  // The fork was deleted: GitHub gives no head repo.
  assert.deepEqual(imageRef(allowed, "org/a", "main", pr(null)), { ref: "main", branch: false });
  const off = { ...allowed, allowBranchDockerImages: false };
  assert.deepEqual(imageRef(off, "org/a", "main", pr("org/a")), { ref: "main", branch: false });
  assert.deepEqual(imageRef(allowed, "org/a", "main", null), { ref: "main", branch: false });
});

test("Claude Code installs once per version, in a container of its own", async () => {
  const { images, calls } = setup();
  await Promise.all([images.installClaudeCode(), images.installClaudeCode()]);
  await images.installClaudeCode();
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
});

test("cache volumes: created once per repo and path, owned by the sandbox's user", async () => {
  const { images, calls } = setup();
  const args = await images.caches("org/a", ["/home/node/.npm"], "img:1");
  assert.equal(args[0], "-v");
  assert.match(args[1], /^deckhand-cache-org-a-home-node-npm-\w+:\/home\/node\/\.npm$/);
  await images.caches("org/a", ["/home/node/.npm"], "img:1");
  assert.equal(calls.filter((c) => c.startsWith("volume create")).length, 1);
  assert.match(
    calls.find((c) => c.includes("chown")),
    /--user 0 --cap-drop ALL --cap-add CHOWN --security-opt no-new-privileges --entrypoint chown -v \S+:\/home\/node\/\.npm img:1 1000:1000/,
  );
  // Another repo, same path: its own volume.
  const other = await images.caches("org/b", ["/home/node/.npm"], "img:1");
  assert.notEqual(other[1], args[1]);
});
