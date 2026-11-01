import assert from "node:assert/strict";
import { mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { grantFor, grantsFrom, withGrants } from "../listener/grants.mjs";
import { KEYS, parseRepoConfig } from "../listener/repo-config.mjs";
import { effectiveView } from "../listener/repo-view.mjs";
import { tempDir, testConfig } from "./helpers.mjs";

const config = testConfig({
  ALLOWED_USERS: "alice,bob",
  MAX_PARALLEL: "3",
});

// `grants`: the grants folder's files, { "owner/repo.yaml": text }; `granted`: the grants the
// operator's policies give the repo (grants.mjs GRANTS).
function view(yaml, grants = {}, repo = "org/app", granted = []) {
  const { settings } = parseRepoConfig(yaml, config);
  const grant = grantOf(grants, repo, granted);
  return effectiveView(config, repo, settings, grant);
}

// What grants.mjs grantOf() gives `repo`, its policies granting `names`.
const grantOf = (grants, repo, names, cfg = config) =>
  withGrants(grantFor(grantsFrom(grants, cfg), cfg, repo), {
    granted: new Set(names),
    files: names.length ? ["grants.rego"] : [],
  });

const byKey = (rows, key) => rows.find((r) => r.key === key);

test("settings: the repo's values tagged as such, the operator's otherwise", () => {
  const { settings } = view(
    [
      "users: [alice]",
      "model: sonnet",
      "max_parallel: 1",
      "dockerfile: docker/Dockerfile",
      "modes:",
      "  audit:",
      "    instructions: .github/audit.md",
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
  assert.match(byKey(settings, "dockerfile").note, /don't grant dockerfile/);
  // A mode takes work's model and effort by default (customMode()).
  assert.equal(byKey(settings, "modes.audit").value, ".github/audit.md · sonnet/medium");
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

test("mounts: as a run resolves them, refused ones with their reason", (t) => {
  const dir = realpathSync(tempDir(t, "deckhand-view-"));
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
    "mounts:",
    "  - path: /srv/data",
  ].join("\n");
  const { settings, errors } = parseRepoConfig(yaml, config);
  assert.deepEqual(errors, []);
  const v = effectiveView(config, "org/app", settings, null);
  assert.ok(![...v.settings, ...v.mounts].some((r) => r.source === "refused"));
  for (const key of ["dockerfile", "allow_branch_docker_images", "docker"]) {
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

test("dockerfile: from the repo once granted", () => {
  const yaml = "dockerfile: Dockerfile\n";
  const { settings, grant } = view(yaml, {}, "org/app", ["dockerfile", "branch_docker_images"]);
  assert.equal(byKey(settings, "dockerfile").source, "repo");
  assert.equal(byKey(settings, "allow_branch_docker_images").value, "true");
  assert.equal(grant.allowDockerfile, true);
  assert.deepEqual(grant.grantFiles, ["grants.rego"]);
  assert.equal(byKey(view(yaml).settings, "dockerfile").source, "refused");
  // `preview`, removed (#574): no row of its own, refused or not.
  assert.equal(byKey(view("preview: ./preview.sh\n").settings, "preview"), undefined);
});

test("docker: refused without its grant; granted, its engine noted when there is none", () => {
  const refused = byKey(view("docker: true\n").settings, "docker");
  assert.equal(refused.source, "refused");
  assert.match(refused.note, /don't grant docker/);
  const granted = view("docker: { cache: true }\n", {}, "org/app", ["docker"]);
  assert.deepEqual(byKey(granted.settings, "docker"), {
    key: "docker",
    value: "a container engine, its cache kept",
    source: "repo",
    note: "the operator hasn't set SANDBOX_ENGINE",
  });
  assert.equal(granted.grant.allowDocker, true);
  assert.equal(granted.grant.allowWorkflows, false);
  const workflows = view("", {}, "org/app", ["workflows"]);
  assert.equal(workflows.grant.allowWorkflows, true);
  const withEngine = { ...config, engine: "sysbox" };
  const { settings } = parseRepoConfig("docker: true\n", withEngine);
  const grant = grantOf({}, "org/app", ["docker"], withEngine);
  const row = byKey(effectiveView(withEngine, "org/app", settings, grant).settings, "docker");
  assert.equal(row.note, null);
  assert.equal(byKey(view("").settings, "docker").value, "none");
});

test("settings: projects, and those the grant doesn't list said as not moved", () => {
  const yaml =
    "projects:\n  - project: acme/3\n    start: Doing\n  - project: acme/4\n    merged: Done\n";
  const ungranted = byKey(view(yaml).settings, "projects");
  assert.deepEqual(ungranted, {
    key: "projects",
    value: "acme/3 (Status: start: Doing); acme/4 (Status: merged: Done)",
    source: "repo",
    note: "not moved: the operator's grants don't list acme/3, acme/4 in allow_projects",
  });
  const some = view(yaml, { "org/app.yaml": "allow_projects: [acme/3]\n" });
  assert.match(byKey(some.settings, "projects").note, /don't list acme\/4 in/);
  assert.deepEqual(some.grant.allowProjects, ["acme/3"]);
  const all = view(yaml, { "org/app.yaml": "allow_projects: [acme/3, acme/4]\n" });
  assert.equal(byKey(all.settings, "projects").note, null);
  assert.deepEqual(byKey(view("").settings, "projects"), {
    key: "projects",
    value: "none",
    source: "operator",
    note: null,
  });
});

test("settings: agent, brainstorm_agent and wait_for_answers have their rows", () => {
  const withCodex = testConfig({ OPENAI_API_KEY: "sk-test" });
  const yaml = "brainstorm_agent: codex\nwait_for_answers: false\n";
  const { settings: parsed, errors } = parseRepoConfig(yaml, withCodex);
  assert.deepEqual(errors, []);
  const grant = grantFor(grantsFrom({}, withCodex), withCodex, "org/app");
  const { settings } = effectiveView(withCodex, "org/app", parsed, grant);
  assert.deepEqual(byKey(settings, "agent"), {
    key: "agent",
    value: "claude",
    source: "operator",
    note: null,
  });
  assert.deepEqual(
    [byKey(settings, "brainstorm_agent").value, byKey(settings, "brainstorm_agent").source],
    ["codex", "repo"],
  );
  assert.deepEqual(
    [byKey(settings, "wait_for_answers").value, byKey(settings, "wait_for_answers").source],
    ["false", "repo"],
  );
  assert.equal(byKey(view("").settings, "wait_for_answers").value, "true");
});

test("settings: every key the file takes has its row, or a table of its own", () => {
  const elsewhere = Object.keys(KEYS).filter((key) => !KEYS[key].display);
  // hosts, cached_hosts and preview (#574) only get a warning: the file no longer sets them.
  assert.deepEqual(elsewhere, ["hosts", "cached_hosts", "mounts", "preview"]);
  const { settings } = view("modes:\n  audit:\n    instructions: audit.md\n");
  for (const key of Object.keys(KEYS).filter((k) => KEYS[k].display)) {
    assert.ok(
      settings.some((r) => r.key === key || r.key.startsWith(`${key}.`)),
      `${key} has no row`,
    );
  }
});
