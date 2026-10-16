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
  assert.equal(byKey(settings, "modes.review").value, ".github/review.md · best/medium · light");
  assert.deepEqual(byKey(settings, "limits"), {
    key: "limits",
    value: "2 CPUs, 4g memory, 2048 processes",
    source: "operator",
    note: "built in",
  });
});

test("settings: no file, the operator's defaults; limits from the repo's grant", () => {
  const { settings, grant } = view("", { "org/app.yaml": "limits: { cpus: 4 }\n" });
  assert.ok(settings.every((r) => r.source === "operator"));
  assert.equal(byKey(settings, "dockerfile").value, "none: the base image deckhand-sandbox");
  assert.equal(byKey(settings, "limits").value, "4 CPUs, 4g memory, 2048 processes");
  assert.equal(byKey(settings, "limits").note, "grants/org/app.yaml");
  assert.deepEqual(grant.files, ["org/app.yaml"]);
});

test("hosts: the operator's only, each naming the grants file it comes from", () => {
  // A repo's own hosts are ignored (a warning), never shown as reachable.
  const yaml = "hosts: [evil.net]\n";
  const grants = {
    "default.yaml": "hosts: [registry.npmjs.org, pypi.org]\n",
    "org/app.yaml": "hosts: ['*.example.com', pypi.org]\n",
  };
  const { hosts, grant } = view(yaml, grants);
  assert.deepEqual(hosts, [
    { host: "api.anthropic.com", source: "operator", note: "always" },
    { host: "github.com", source: "operator", note: "always" },
    { host: "api.github.com", source: "operator", note: "always" },
    { host: "*.githubusercontent.com", source: "operator", note: "always" },
    { host: "registry.npmjs.org", source: "operator", note: "grants/default.yaml" },
    { host: "pypi.org", source: "operator", note: "grants/default.yaml" },
    { host: "*.example.com", source: "operator", note: "grants/org/app.yaml" },
  ]);
  assert.deepEqual(grant.files, ["default.yaml", "org/app.yaml"]);
  assert.equal("allowRepoHosts" in grant, false);
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
  const { settings } = parseRepoConfig("", config);
  const v = effectiveView(config, "org/app", settings, null);
  assert.equal(v.grant, null);
  assert.ok(v.hosts.every((h) => h.note === "always"));
});

test("broken grants: what needs a grant is unknown, not refused", () => {
  const yaml = [
    "dockerfile: Dockerfile",
    "docker: true",
    "preview: ./preview.sh",
    "mounts:",
    "  - path: /srv/data",
  ].join("\n");
  const { settings, errors } = parseRepoConfig(yaml, config);
  assert.deepEqual(errors, []);
  const v = effectiveView(config, "org/app", settings, null);
  assert.ok(![...v.settings, ...v.mounts].some((r) => r.source === "refused"));
  for (const key of ["dockerfile", "allow_branch_docker_images", "docker", "preview"]) {
    assert.equal(byKey(v.settings, key).source, "unknown", key);
    assert.match(byKey(v.settings, key).note, /grants, which have errors/);
  }
  assert.equal(byKey(v.settings, "dockerfile").value, "Dockerfile");
  assert.deepEqual(v.mounts, [
    {
      path: "/srv/data",
      source: "unknown",
      readOnly: true,
      note: "depends on the operator's grants, which have errors",
    },
  ]);
  // What doesn't need a grant is shown as usual.
  assert.equal(byKey(v.settings, "effort").source, "operator");
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

test("docker: refused without allow_docker; granted, its engine noted when there is none", () => {
  const refused = byKey(view("docker: true\n").settings, "docker");
  assert.equal(refused.source, "refused");
  assert.match(refused.note, /allow_docker: true/);
  const grants = { "org/app.yaml": "allow_docker: true\n" };
  const granted = view("docker: { cache: true }\n", grants);
  assert.deepEqual(byKey(granted.settings, "docker"), {
    key: "docker",
    value: "a container engine, its cache kept",
    source: "repo",
    note: "the operator hasn't set SANDBOX_ENGINE",
  });
  assert.equal(granted.grant.allowDocker, true);
  const withEngine = { ...config, engine: "sysbox" };
  const { settings } = parseRepoConfig("docker: true\n", withEngine);
  const grant = grantFor(grantsFrom(grants, withEngine), withEngine, "org/app");
  const row = byKey(effectiveView(withEngine, "org/app", settings, grant).settings, "docker");
  assert.equal(row.note, null);
  assert.equal(byKey(view("").settings, "docker").value, "none");
});
