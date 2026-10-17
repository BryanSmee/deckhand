import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { resolveAsset } from "../listener/static.mjs";
import { tempDir } from "./helpers.mjs";

test("dashboard files: only those inside the build folder", (t) => {
  const dir = tempDir(t);
  const root = join(dir, "dist");
  mkdirSync(join(root, "assets"), { recursive: true });
  writeFileSync(join(root, "index.html"), "<!doctype html>");
  writeFileSync(join(root, "assets", "app-1a2b.js"), "");
  writeFileSync(join(dir, "secret.js"), "");
  writeFileSync(join(root, "notes.txt"), "");
  symlinkSync(join(dir, "secret.js"), join(root, "assets", "link.js"));

  assert.equal(resolveAsset(root, "/"), join(root, "index.html"));
  assert.equal(resolveAsset(root, "/assets/app-1a2b.js"), join(root, "assets", "app-1a2b.js"));
  for (const path of [
    "/../secret.js",
    "/assets/%2e%2e/%2e%2e/secret.js",
    "/assets/link.js", // a symlink out of the folder
    "/assets", // a folder
    "/notes.txt", // not a type the dashboard serves
    "/assets/missing.js",
    "/%E0%A4%A.js", // not a valid escape
  ]) {
    assert.equal(resolveAsset(root, path), null, path);
  }
  // No build at all.
  assert.equal(resolveAsset(join(dir, "none"), "/"), null);
});
