import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../listener/config.mjs";
import { grantFor, grantsFrom } from "../listener/grants.mjs";
import { parseRepoConfig } from "../listener/repo-config.mjs";
import { effectiveView } from "../listener/repo-view.mjs";

const config = loadConfig({
  ALLOWED_USERS: "alice,bob",
  ALLOWED_HOSTS: "registry.npmjs.org",
  MAX_PARALLEL: "3",
});

// `grants`: the grants folder's files, { "owner/repo.yaml": text }.
function view(yaml, grants = {}, repo = "org/app") {
  const { settings } = parseRepoConfig(yaml, config);
  const grant = grantFor(grantsFrom(grants, config), config, repo);
  return effectiveView(config, repo, settings, grant);
}

const byKey = (rows, key) => rows.find((r) => r.key === key);

test("settings: the repo's values tagged as such, the operator's otherwise", () => {
  const { settings } = view(
    [
      "users: [alice]",
      "model: sonnet",
      "max_parallel: 1",
      "dockerfile: docker/Dockerfile",
      "modes:",
      "  review:",
      "    instructions: .github/review.md",
      "    light: true",
    ].join("\n"),
  );
  assert.deepEqual(byKey(settings, "users"), {
    key: "users",
    value: "alice",
    source: "repo",
    note: "narrowed from ALLOWED_USERS (alice, bob)",
  });
  assert.deepEqual(
    [byKey(settings, "model").value, byKey(settings, "model").source],
    ["sonnet", "repo"],
  );
  assert.equal(byKey(settings, "effort").source, "operator");
  assert.equal(byKey(settings, "max_parallel").note, "MAX_PARALLEL is 3");
  // Not granted: it stops runs, and says which grant is missing.
  assert.equal(byKey(settings, "dockerfile").value, "docker/Dockerfile");
  assert.equal(byKey(settings, "dockerfile").source, "refused");
  assert.match(byKey(settings, "dockerfile").note, /allow_dockerfile: true/);
  // A light mode takes the brainstorms' model and effort by default (customMode()).
  assert.equal(byKey(settings, "modes.review").value, ".github/review.md · opus/medium · light");
  assert.deepEqual(byKey(settings, "limits"), {
    key: "limits",
    value: "2 CPUs, 4g memory, 2048 processes",
    source: "operator",
    note: "SANDBOX_*",
  });
});

test("settings: no file, the operator's defaults; limits from the repo's grant", () => {
  const { settings, grant } = view("", { "org/app.yaml": "limits: { cpus: 4 }\n" });
  assert.ok(settings.every((r) => r.source === "operator"));
  assert.equal(byKey(settings, "dockerfile").value, "none: the base image deckhand-sandbox");
  assert.equal(byKey(settings, "limits").value, "4 CPUs, 4g memory, 2048 processes");
  assert.equal(byKey(settings, "limits").note, "grants: org/app.yaml");
  assert.deepEqual(grant.files, ["org/app.yaml"]);
});

test("hosts: refused without allow_repo_hosts, unless the operator allows them already", () => {
  const yaml = "hosts: [pypi.org, registry.npmjs.org, files.example.com]\n";
  const refused = view(yaml, { "org/app.yaml": "hosts: ['*.example.com']\n" }).hosts;
  const of = (rows, host) => rows.find((h) => h.host === host);
  assert.equal(of(refused, "api.anthropic.com").note, "always");
  assert.equal(of(refused, "pypi.org").source, "refused");
  assert.match(of(refused, "pypi.org").note, /allow_repo_hosts/);
  assert.equal(of(refused, "*.example.com").note, "grants: org/app.yaml");
  assert.equal(of(refused, "files.example.com").note, "already allowed by the operator");
  assert.equal(of(refused, "registry.npmjs.org").note, "ALLOWED_HOSTS");

  // Granted to every repo by default.yaml, with a host of its own.
  const granted = view(yaml, { "default.yaml": "allow_repo_hosts: true\nhosts: [pypi.org]\n" });
  assert.deepEqual(of(granted.hosts, "pypi.org"), {
    host: "pypi.org",
    source: "operator",
    note: "grants: default.yaml",
  });
  assert.deepEqual(of(granted.hosts, "files.example.com"), {
    host: "files.example.com",
    source: "repo",
    note: null,
  });
  assert.deepEqual(granted.grant.files, ["default.yaml"]);
  assert.equal(granted.grant.allowRepoHosts, true);
});

test("mounts: as a run resolves them, refused ones with their reason", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "deckhand-view-")));
  mkdirSync(join(dir, "work", "api"), { recursive: true });
  mkdirSync(join(dir, "secret"));
  symlinkSync(join(dir, "secret"), join(dir, "work", "escape"));
  const yaml = [
    "mounts:",
    `  - path: ${dir}/work/api`,
    `  - path: ${dir}/work/escape`,
    `  - path: ${dir}/secret`,
  ].join("\n");
  const { mounts, grant } = view(yaml, { "org/app.yaml": `mounts:\n  - root: ${dir}/work\n` });
  assert.deepEqual(mounts[0], {
    path: `${dir}/work/api`,
    source: "repo",
    readOnly: true,
    note: null,
  });
  assert.equal(mounts[1].source, "refused");
  assert.match(mounts[1].note, /^resolves to \S+\/secret, outside the roots/);
  assert.equal(mounts[2].source, "refused");
  assert.deepEqual(grant.mounts, [{ root: `${dir}/work`, readOnly: true }]);

  // No grant at all.
  const none = view(yaml).mounts;
  assert.ok(none.every((m) => m.source === "refused"));
  assert.equal(none[0].note, "the operator grants this repository no host paths");
});

test("broken grants: the defaults, and no grant shown", () => {
  const { settings } = parseRepoConfig("hosts: [pypi.org]\n", config);
  const v = effectiveView(config, "org/app", settings, null);
  assert.equal(v.grant, null);
  assert.equal(v.hosts.find((h) => h.host === "pypi.org").source, "refused");
});

test("dockerfile and preview: from the repo once granted", () => {
  const yaml = "dockerfile: Dockerfile\npreview: ./preview.sh\n";
  const { settings, grant } = view(yaml, {
    "org/app.yaml":
      "allow_dockerfile: true\nallow_preview: true\nallow_branch_docker_images: true\n",
  });
  assert.equal(byKey(settings, "dockerfile").source, "repo");
  assert.deepEqual(
    [byKey(settings, "preview").value, byKey(settings, "preview").source],
    ["./preview.sh (30 min)", "repo"],
  );
  assert.equal(byKey(settings, "allow_branch_docker_images").value, "true");
  assert.equal(grant.allowPreview, true);
  assert.equal(byKey(view("preview: ./preview.sh\n").settings, "preview").source, "refused");
});
