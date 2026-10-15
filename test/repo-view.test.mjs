import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../listener/config.mjs";
import { parseGrants } from "../listener/grants.mjs";
import { parseRepoConfig } from "../listener/repo-config.mjs";
import { effectiveView } from "../listener/repo-view.mjs";

const config = loadConfig({
  ALLOWED_USERS: "alice,bob",
  ALLOWED_HOSTS: "registry.npmjs.org",
  MAX_PARALLEL: "3",
});

function view(yaml, grantsYaml = "", repo = "org/app") {
  const { settings } = parseRepoConfig(yaml, config);
  return effectiveView(config, repo, settings, parseGrants(grantsYaml, config));
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
  assert.equal(byKey(settings, "dockerfile").value, "docker/Dockerfile");
  // A light mode takes the brainstorms' model and effort by default (customMode()).
  assert.equal(byKey(settings, "modes.review").value, ".github/review.md · opus/medium · light");
  assert.deepEqual(byKey(settings, "limits"), {
    key: "limits",
    value: "2 CPUs, 4g memory, 2048 processes",
    source: "operator",
    note: "SANDBOX_*",
  });
});

test("settings: no file, the operator's defaults; limits from the grants file", () => {
  const { settings, grant } = view("", "org/app:\n  limits: { cpus: 4 }\n");
  assert.ok(settings.every((r) => r.source === "operator"));
  assert.equal(byKey(settings, "dockerfile").value, "none: the base image deckhand-sandbox");
  assert.equal(byKey(settings, "limits").value, "4 CPUs, 4g memory, 2048 processes");
  assert.equal(byKey(settings, "limits").note, "the grants file");
  assert.equal(grant.entry, "org/app");
});

test("hosts: refused without allow_repo_hosts, unless the operator allows them already", () => {
  const yaml = "hosts: [pypi.org, registry.npmjs.org, files.example.com]\n";
  const refused = view(yaml, "org/app:\n  hosts: ['*.example.com']\n").hosts;
  const of = (rows, host) => rows.find((h) => h.host === host);
  assert.equal(of(refused, "api.anthropic.com").note, "always");
  assert.equal(of(refused, "pypi.org").source, "refused");
  assert.match(of(refused, "pypi.org").note, /allow_repo_hosts/);
  assert.equal(of(refused, "*.example.com").note, "the grants file");
  assert.equal(of(refused, "files.example.com").note, "already allowed by the operator");
  assert.equal(of(refused, "registry.npmjs.org").note, "ALLOWED_HOSTS");

  // Granted to every repo by "*".
  const granted = view(yaml, '"*":\n  allow_repo_hosts: true\n');
  assert.deepEqual(of(granted.hosts, "pypi.org"), { host: "pypi.org", source: "repo", note: null });
  assert.equal(granted.grant.entry, "*");
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
  const { mounts, grant } = view(yaml, `org/app:\n  mounts:\n    - root: ${dir}/work\n`);
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

test("a broken grants file: the defaults, and no grant shown", () => {
  const { settings } = parseRepoConfig("hosts: [pypi.org]\n", config);
  const v = effectiveView(config, "org/app", settings, null);
  assert.equal(v.grant, null);
  assert.equal(v.hosts.find((h) => h.host === "pypi.org").source, "refused");
});
