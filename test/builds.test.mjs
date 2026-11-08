// What the runner decides itself of builds (runner/builds.mjs): from its own grants and the
// repository's default branch, whatever the orchestrator asked.
import assert from "node:assert/strict";
import { test } from "node:test";
import { grantsFrom } from "../listener/grants.mjs";
import { blobOf, buildPlan, buildProblem } from "../runner/builds.mjs";
import { grantedOf } from "./helpers.mjs";

const config = { prefix: "dh", limits: {}, grantsDir: "/nowhere" };
const SHA = "0123456789abcdef0123456789abcdef01234567";
// A fork's pull request's head, which GitHub serves through the repository too.
const FORK = "f".repeat(40);
const grantsOf = (text) => () => grantsFrom({ "org/repo.yaml": text }, config);

test("a build: with the `dockerfile` grant, a plain path, a branch only with its own grant", async () => {
  const grants = grantsOf("hosts: [pypi.org]\n");
  const granted = grantedOf(["dockerfile"]);
  const problem = (asked, given = granted) => buildProblem(config, asked, grants, given);
  const asked = { repo: "org/repo", ref: "main", dockerfile: "docker/Dockerfile" };
  assert.equal(await problem(asked), null);
  assert.equal(await problem({ repo: "org/repo" }), null);
  assert.match(await problem({ ...asked, dockerfile: "../x" }), /not a plain path/);
  assert.match(
    await problem({ ...asked, branch: true }),
    /don't grant `branch_docker_images` to this repository/,
  );
  // Granted, at a commit's full id only: never a branch's name, a pull request's ref (a fork's,
  // maybe), an abbreviation or a path.
  const branches = grantedOf(["dockerfile", "branch_docker_images"]);
  assert.equal(await problem({ ...asked, ref: SHA, branch: true }, branches), null);
  for (const ref of [
    "main",
    "refs/pull/7/head",
    "pull/7/head",
    SHA.slice(0, 12),
    SHA.toUpperCase(),
    `${SHA}/x`,
    "../x",
    null,
    7,
  ]) {
    assert.match(
      await problem({ ...asked, ref, branch: true }, branches),
      /a branch's image is built at a commit's full id/,
      String(ref),
    );
  }
  // Without the operator's policies granting it (or without policies): refused.
  assert.match(await problem(asked, grantedOf([])), /don't grant `dockerfile`/);
  assert.match(await problem(asked, null), /don't grant `dockerfile`/);
  await assert.rejects(problem({ ...asked, repo: "org/../x" }), /repo\?/);
  // The policies can't decide: no build.
  await assert.rejects(
    problem(asked, async () => ({ error: "policy error: x" })),
    (error) => error.status === 403 && /can't decide org\/repo's/.test(error.message),
  );
});

test("a build's plan: the default branch unless a branch is asked (and granted), GitHub's blob, granted hosts only", async () => {
  const grants = grantsOf("hosts: [pypi.org]\n");
  const cfg = { ...config, githubUrl: "https://github.com", githubApi: "https://api.github.com" };
  const asked = [];
  const blobOf = async (repo, path, ref) => (asked.push([repo, path, ref]), "sha-1");
  const plan = await buildPlan(
    cfg,
    {
      repo: "org/repo",
      ref: "0123456789abcdef0123456789abcdef01234567",
      branch: false,
      dockerfile: "Dockerfile",
      blob: "made up",
      access: { hosts: ["pypi.org", "evil.example"], trusted: ["evil.example", "pypi.org"] },
    },
    { grants, blobOf },
  );
  assert.deepEqual(plan, {
    repo: "org/repo",
    ref: null,
    branch: false,
    dockerfile: "Dockerfile",
    blob: "sha-1",
    access: { hosts: ["pypi.org"], trusted: ["pypi.org"] },
  });
  assert.deepEqual(asked, [["org/repo", "Dockerfile", null]]);
  // A branch's, as asked once granted (buildProblem() checks the grant first), at a commit the
  // github service says is the repository's own.
  const owned = [];
  const ownCommit = async (repo, sha) => (owned.push([repo, sha]), sha === SHA);
  const branch = await buildPlan(
    cfg,
    { repo: "org/repo", ref: SHA, branch: true, dockerfile: "Dockerfile" },
    { grants, blobOf, ownCommit },
  );
  assert.deepEqual([branch.ref, branch.branch, asked.at(-1)[2]], [SHA, true, SHA]);
  assert.deepEqual(owned, [["org/repo", SHA]]);
  // A fork's commit: refused, its blob never looked up; without the github service's word, none.
  const before = asked.length;
  for (const lookups of [
    { grants, blobOf, ownCommit },
    { grants, blobOf },
  ]) {
    await assert.rejects(
      buildPlan(
        cfg,
        { repo: "org/repo", ref: FORK, branch: true, dockerfile: "Dockerfile" },
        lookups,
      ),
      (error) =>
        error.status === 403 && /isn't a commit of org\/repo's own branches/.test(error.message),
    );
  }
  assert.equal(asked.length, before);
});

test("a fork's pull request's head is never built as a branch's image, by its ref or its commit", async () => {
  // GitHub serves both through the base repository (its tarball, its contents): the orchestrator
  // naming either gets nothing built, whatever the grants.
  const grants = grantsOf("hosts: []\n");
  const cfg = { ...config, githubUrl: "https://github.com", githubApi: "https://api.github.com" };
  const granted = grantedOf(["dockerfile", "branch_docker_images"]);
  const built = [];
  const lookups = {
    grants,
    blobOf: async (repo, path, ref) => (built.push(ref), "sha-1"),
    // The github service: the fork's commit isn't on the repository's branches.
    ownCommit: async (repo, sha) => sha !== FORK,
  };
  const build = async (ref) => {
    const asked = { repo: "org/repo", ref, branch: true, dockerfile: "Dockerfile" };
    const problem = await buildProblem(config, asked, grants, granted);
    if (problem) return problem;
    try {
      return await buildPlan(cfg, asked, lookups);
    } catch (error) {
      return error.message;
    }
  };
  assert.match(await build("refs/pull/7/head"), /built at a commit's full id/);
  assert.match(await build(FORK), /isn't a commit of org\/repo's own branches/);
  assert.deepEqual(built, []);
  assert.equal((await build(SHA)).ref, SHA);
});

test("a file's blob, as GitHub names it", () => {
  assert.equal(blobOf(Buffer.from("")), "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
});
