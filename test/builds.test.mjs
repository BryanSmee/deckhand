// What the runner decides itself of builds (runner/builds.mjs): from its own grants and the
// repository's default branch, whatever the orchestrator asked.
import assert from "node:assert/strict";
import { test } from "node:test";
import { grantsFrom } from "../listener/grants.mjs";
import { blobOf, buildPlan, buildProblem } from "../runner/builds.mjs";
import { grantedOf } from "./helpers.mjs";

const config = { prefix: "dh", limits: {}, grantsDir: "/nowhere" };
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
  assert.equal(
    await problem({ ...asked, branch: true }, grantedOf(["dockerfile", "branch_docker_images"])),
    null,
  );
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
  // A branch's, as asked once granted (buildProblem() checks the grant first).
  const branch = await buildPlan(
    cfg,
    { repo: "org/repo", ref: "abc", branch: true, dockerfile: "Dockerfile" },
    { grants, blobOf },
  );
  assert.deepEqual([branch.ref, asked.at(-1)[2]], ["abc", "abc"]);
});

test("a file's blob, as GitHub names it", () => {
  assert.equal(blobOf(Buffer.from("")), "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
});
