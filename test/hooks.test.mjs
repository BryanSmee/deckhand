// What the runner decides itself of builds and preview hooks (runner/hooks.mjs): from its own
// grants and the repository's default branch, whatever the orchestrator asked.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { grantsFrom } from "../listener/grants.mjs";
import { blobOf, buildPlan, buildProblem, previewJob } from "../runner/hooks.mjs";
import { grantedOf, tempDir } from "./helpers.mjs";

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

test("a preview hook: its command and image from the default branch's config, its Dockerfile's image built", async (t) => {
  const dir = tempDir(t);
  const files = (config) => {
    writeFileSync(join(dir, ".deckhand.yaml"), config);
    writeFileSync(join(dir, "Dockerfile"), "FROM x\n");
  };
  const checkouts = [];
  const checkout = async (repo, ref) => {
    checkouts.push(ref);
    const copy = tempDir(t);
    for (const name of [".deckhand.yaml", "Dockerfile"]) {
      writeFileSync(join(copy, name), readFileSync(join(dir, name)));
    }
    return copy;
  };
  const built = [];
  const imageFor = async (asked) => (built.push(asked), "dh-repo-org-repo:abc");
  const payload = {
    action: "opened",
    repository: { full_name: "Org/Repo" },
    pull_request: { number: 5 },
  };
  const job = { repo: "org/repo", event: "pull_request", payload };
  const grants = grantsOf("hosts: [pypi.org]\n");
  const both = { grants, granted: grantedOf(["preview", "dockerfile"]) };
  files("preview:\n  command: ./up.sh\ndockerfile: Dockerfile\n");
  const found = await previewJob(config, job, { checkout, imageFor, ...both });
  assert.equal(found.hook.command, "./up.sh");
  assert.equal(found.image, "dh-repo-org-repo:abc");
  assert.deepEqual(checkouts, [null]);
  // Its tag from the Dockerfile's blob, as GitHub names it.
  assert.equal(built[0].blob, blobOf(Buffer.from("FROM x\n")));
  assert.equal(blobOf(Buffer.from("")), "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
  // Each refusal says why: no grant, a Dockerfile it may not build, no hook, another event.
  const refused = (names, why) =>
    assert.rejects(
      previewJob(config, job, { checkout, imageFor, grants, granted: grantedOf(names) }),
      why,
    );
  await refused([], /don't grant `preview`/);
  await refused(["preview"], /don't grant `dockerfile`/);
  files("max_parallel: 2\n");
  await refused(["preview", "dockerfile"], /has no preview hook/);
  await assert.rejects(
    previewJob(config, { ...job, event: "push" }, { checkout, imageFor, ...both }),
    /event\?/,
  );
  // An event the runner can't tie to the repository asked: another's, or without its subject.
  const event = (asked) =>
    assert.rejects(previewJob(config, asked, { checkout, imageFor, ...both }), (error) => {
      assert.equal(error.status, 400);
      return true;
    });
  await event({ ...job, payload: { ...payload, repository: { full_name: "org/other" } } });
  await event({ ...job, payload: { ...payload, repository: undefined } });
  await event({ ...job, event: "workflow_run" });
  await event({ ...job, payload: null });
  await event({ ...job, payload: [] });
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
