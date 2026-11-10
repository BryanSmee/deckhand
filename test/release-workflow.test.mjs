// The release workflow's chart job installs helm as checks.yml's kubernetes job does (#989).
// Renovate bumps both HELM_VERSION lines in one pull request, but each sum by hand
// (`needs-sha`): one left behind fails only at the next release tag, so it fails here first.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const workflows = join(import.meta.dirname, "..", ".github", "workflows");

// HELM_VERSION and HELM_SHA256 as a workflow's env sets them, and how many times each.
const helm = (file) => {
  const text = readFileSync(join(workflows, file), "utf8");
  const values = (name) =>
    [...text.matchAll(new RegExp(`^\\s+${name}: (\\S+)$`, "gm"))].map((m) => m[1]);
  return { version: values("HELM_VERSION"), sha256: values("HELM_SHA256") };
};

test("the release's chart job pins the helm that checks.yml does, with its sum", () => {
  const checks = helm("checks.yml");
  const release = helm("release-workflow.yml");
  assert.equal(checks.version.length, 1, "checks.yml: one HELM_VERSION");
  assert.equal(checks.sha256.length, 1, "checks.yml: one HELM_SHA256");
  assert.deepEqual(release, checks);
});
