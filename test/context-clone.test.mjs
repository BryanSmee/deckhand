// The sandbox's context repos (#930, ../sandbox/entrypoint.sh clone_context()): each line of
// SANDBOX_CONTEXT cloned shallow at its ref (a commit's id fetched alone), made read-only, before
// the setup; one that fails stops the run with git's message.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { needsBash, needsModes, scriptEnv, tempDir } from "./helpers.mjs";

const entrypoint = readFileSync(
  join(import.meta.dirname, "..", "sandbox", "entrypoint.sh"),
  "utf8",
);
const cloneContext = entrypoint.match(/^clone_context\(\) \{\n[^]*?^\}$/m)?.[0];

const gitEnv = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

// acme/app on a fake GitHub (bare repositories under `root`): main with two commits, `v1` a tag
// on the first, `release/2.0` a branch on it too. → the first commit's id and main's.
function github(t) {
  // The clones are read-only: writable again before the temp dir goes (its hook comes after).
  let made = null;
  t.after(() => made && spawnSync("chmod", ["-R", "u+w", made]));
  const dir = tempDir(t, "context-");
  made = dir;
  const root = join(dir, "github");
  const work = join(dir, "work");
  const env = { ...process.env, HOME: dir, ...gitEnv };
  const git = (...args) => execFileSync("git", args, { cwd: work, env }).toString().trim();
  execFileSync("git", ["init", "-q", "-b", "main", work], { env });
  writeFileSync(join(work, "README.md"), "one\n");
  git("add", "-A");
  git("commit", "-q", "-m", "one");
  const first = git("rev-parse", "HEAD");
  git("tag", "v1");
  git("branch", "release/2.0");
  writeFileSync(join(work, "README.md"), "two\n");
  git("commit", "-q", "-am", "two");
  const bare = join(root, "acme", "app.git");
  execFileSync("git", ["clone", "-q", "--bare", work, bare], { env });
  // GitHub fetches any commit by its id.
  execFileSync("git", ["-C", bare, "config", "uploadpack.allowAnySHA1InWant", "true"], { env });
  return { dir, root, first, main: git("rev-parse", "HEAD"), env };
}

// clone_context() run alone, as the entrypoint runs it.
function clone(t, { dir, root }, lines) {
  return spawnSync("bash", ["-euo", "pipefail", "-c", `${cloneContext}\nclone_context`], {
    env: scriptEnv(t, {
      ...gitEnv,
      HOME: dir,
      // The run's own repository, beside acme/app: the context repos' URLs are made from it.
      REPO_URL: `file://${root}/org/repo.git`,
      SANDBOX_CONTEXT: lines.join("\n"),
    }),
    cwd: dir,
    encoding: "utf8",
  });
}

const head = (folder) =>
  execFileSync("git", ["-C", folder, "rev-parse", "HEAD"], { env: { ...process.env, ...gitEnv } })
    .toString()
    .trim();

test("the entrypoint clones the context repos after the main clone, before the branch and the setup", () => {
  assert.ok(cloneContext, "no clone_context() in entrypoint.sh");
  const call = entrypoint.indexOf("|| clone_context\n");
  assert.ok(call > entrypoint.indexOf("|| reset_clone\n"));
  assert.ok(call < entrypoint.indexOf("sandbox-draft-pr start"));
  assert.ok(call < entrypoint.indexOf('bash -c "$SANDBOX_SETUP"'));
  // Each prompt is told where they are (prompts.mjs contextNote()), once: TASK_PROMPT has it.
  assert.ok(entrypoint.includes('[[ $prompt != *"$SANDBOX_CONTEXT_NOTE"* ]]'));
});

test(
  "two refs of one repository, its default branch and a commit: each in its folder, read-only",
  { skip: needsBash },
  (t) => {
    const remote = github(t);
    const at = (name) => join(remote.dir, "context", "acme", name);
    const result = clone(t, remote, [
      `acme/app v1 ${at("app@v1")}`,
      `acme/app release/2.0 ${at("app@release-2.0")}`,
      `acme/app - ${at("app")}`,
      `acme/app ${remote.first} ${at(`app@${remote.first.slice(0, 7)}`)}`,
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(head(at("app@v1")), remote.first);
    assert.equal(head(at("app@release-2.0")), remote.first);
    assert.equal(head(at("app")), remote.main);
    assert.equal(head(at(`app@${remote.first.slice(0, 7)}`)), remote.first);
    assert.equal(readFileSync(join(at("app@v1"), "README.md"), "utf8"), "one\n");
    assert.equal(readFileSync(join(at("app"), "README.md"), "utf8"), "two\n");
    // Shallow: one commit each.
    const count = execFileSync("git", ["-C", at("app"), "rev-list", "--count", "HEAD"], {
      env: { ...process.env, ...gitEnv },
    });
    assert.equal(count.toString().trim(), "1");
    if (!needsModes) {
      for (const path of [at("app"), join(at("app"), "README.md")]) {
        assert.equal(statSync(path).mode & 0o222, 0, path);
      }
    }
    assert.match(result.stderr, /Context repo acme\/app: .*app@v1, read-only/);
    // Fresh at the next start: the read-only folder replaced.
    const again = clone(t, remote, [`acme/app - ${at("app")}`]);
    assert.equal(again.status, 0, again.stderr);
    assert.equal(head(at("app")), remote.main);
  },
);

test(
  "a ref that isn't there, or a repository: the run stops with git's message",
  { skip: needsBash },
  (t) => {
    const remote = github(t);
    const folder = join(remote.dir, "context", "acme", "app@v9");
    const missing = clone(t, remote, [`acme/app v9 ${folder}`]);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /Context repo acme\/app \(v9\): its clone into .* failed/);
    assert.match(missing.stderr, /v9/);
    const gone = clone(t, remote, [`acme/gone - ${join(remote.dir, "context", "acme", "gone")}`]);
    assert.equal(gone.status, 1);
    assert.match(gone.stderr, /Context repo acme\/gone \(its default branch\): its clone/);
    // Nothing to clone: nothing done.
    const none = clone(t, remote, []);
    assert.equal(none.status, 0, none.stderr);
    assert.ok(!existsSync(join(remote.dir, "context", "acme", "app")));
  },
);
