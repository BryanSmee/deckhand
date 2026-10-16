import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../listener/config.mjs";
import { createRepoSettings } from "../listener/repo-settings.mjs";

const config = loadConfig({ ALLOWED_USERS: "alice,bob" });

// A repo whose config file is `text` (none: 404), and the repository list's reads.
function setup(files, listed = new Map()) {
  const github = async (repo, method, path) => {
    const text = files[repo];
    if (text === undefined || !path.includes("/contents/"))
      return new Response("{}", { status: 404 });
    return Response.json({ type: "file", content: Buffer.from(text).toString("base64"), sha: "s" });
  };
  const repoList = {
    usersOf: (repo) => listed.get(repo.toLowerCase()) ?? null,
    known: () => [...listed.values()].map((r) => r.repo),
  };
  return createRepoSettings({ github, config, repoList });
}

test("repo settings: the latest read wins, here or the repository list's; unknown is null", async () => {
  const listed = new Map([
    [
      "org/app",
      { repo: "org/app", users: ["alice"], waitForAnswers: false, at: Date.now() - 1000 },
    ],
  ]);
  const reads = setup({ "org/app": "users: [bob]\n" }, listed);
  assert.deepEqual(reads.usersOf("Org/App"), ["alice"]);
  assert.equal(reads.waitsForAnswers("org/app"), false);
  assert.equal(reads.usersOf("org/other"), null);
  assert.equal(reads.waitsForAnswers("org/other"), true);
  const { errors } = await reads.repoSettings("org/app", "");
  assert.deepEqual(errors, []);
  assert.deepEqual(reads.usersOf("org/app"), ["bob"]);
  assert.equal(reads.waitsForAnswers("org/app"), true);
});

test("repo settings: a config with errors isn't kept; inboxes list every repo read once", async () => {
  const reads = setup({
    "org/app": "inbox:\n  ideas: 3\n",
    "org/bad": "users: 12\n",
  });
  await reads.repoSettings("org/app", "main");
  const bad = await reads.repoSettings("org/bad", "main");
  assert.ok(bad.errors.length);
  assert.equal(reads.usersOf("org/bad"), null);
  assert.deepEqual(reads.inboxes(), [["org/app", { ideas: 3, bugs: null, discussions: null }]]);
});
