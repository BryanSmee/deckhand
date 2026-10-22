// The dashboard's checks on a repo (repo-check.mjs): here, the name its actions take.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRepoCheck } from "../listener/repo-check.mjs";
import { testConfig } from "./helpers.mjs";

function checks(answer) {
  const calls = [];
  const github = async (repo, method, path) => {
    calls.push(path);
    const full = answer(repo);
    return full === null
      ? new Response("{}", { status: 404 })
      : Response.json({ full_name: full, default_branch: "main" });
  };
  const repoSettings = async () => ({ settings: { users: ["alice"] }, errors: [] });
  const config = testConfig({ ALLOWED_USERS: "alice" });
  return { calls, ...createRepoCheck({ config, github, repoSettings }) };
}

test("nameOf: GitHub's spelling, read once; the name asked for when GitHub renames or can't read it", async () => {
  const spelled = checks(() => "Org/App");
  assert.equal(await spelled.nameOf("org/app"), "Org/App");
  assert.equal(await spelled.nameOf("ORG/APP"), "Org/App");
  assert.deepEqual(spelled.calls, ["/repos/org/app"]);
  // Renamed or transferred: another repo than the one ALLOWED_REPOS was checked for.
  assert.equal(await checks(() => "Elsewhere/app").nameOf("org/app"), "org/app");
  assert.equal(await checks(() => null).nameOf("org/app"), "org/app");
});
