import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { checkout } from "../listener/checkout.mjs";
import { tempDir } from "./helpers.mjs";

test("a checkout is GitHub's tarball without its top folder", async (t) => {
  const src = tempDir(t, "deckhand-src-");
  mkdirSync(join(src, "org-repo-abc1234", "docker"), { recursive: true });
  writeFileSync(join(src, "org-repo-abc1234", "docker", "Dockerfile"), "FROM x\n");
  const tarball = execFileSync("tar", ["-czf", "-", "-C", src, "org-repo-abc1234"]);
  const asked = [];
  const download = async (repo, ref) => {
    asked.push(`${repo} ${ref}`);
    return new Response(tarball);
  };
  const tmp = tempDir(t, "deckhand-tmp-");
  const dir = await checkout(download, "org/repo", "feature/x", { tmp });
  assert.deepEqual(asked, ["org/repo feature/x"]);
  assert.equal(readFileSync(join(dir, "docker", "Dockerfile"), "utf8"), "FROM x\n");

  // A refused download or a broken archive leaves nothing behind.
  await assert.rejects(
    checkout(async () => new Response("", { status: 404 }), "org/repo", "x", { tmp }),
    /404/,
  );
  await assert.rejects(
    checkout(async () => new Response("not a tarball"), "org/repo", "x", { tmp }),
    /tar/,
  );
  assert.equal(readdirSync(tmp).length, 1);
});
