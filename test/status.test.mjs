import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createStatus, serverInfo, serverSetup } from "../listener/status.mjs";
import { tempDir, testConfig } from "./helpers.mjs";

// A grants folder on disk, { "path/in/it": text }, and settings reading it.
function setupWith(t, files, settings = {}) {
  const dir = tempDir(t, "deckhand-setup-");
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return { dir, setup: serverSetup(testConfig({ GRANTS_DIR: dir, ...settings })) };
}

test("serverInfo: the image's version and repository, Node's version, and when it started", () => {
  const now = () => 1791990000000;
  assert.deepEqual(
    serverInfo(
      { DECKHAND_VERSION: "edge-1713fa6", DECKHAND_SOURCE: "https://github.com/acme/deckhand/" },
      now,
    ),
    {
      version: "edge-1713fa6",
      startedAt: 1791990000000,
      node: process.version,
      // Without its trailing slash: the dashboard adds /commit/<sha>.
      source: "https://github.com/acme/deckhand",
    },
  );
  // Built from source: "dev", nothing to link to.
  const dev = serverInfo({ DECKHAND_VERSION: "", DECKHAND_SOURCE: "" }, now);
  assert.deepEqual([dev.version, dev.source], ["dev", ""]);
});

test("/status says since when the listener runs, next to its version", () => {
  const ctx = {
    server: serverInfo({ DECKHAND_VERSION: "1.2.3" }, () => 1000),
    tasks: new Map(),
    runs: [],
    previews: { status: () => [] },
    running: 0,
    app: null,
  };
  const status = createStatus(ctx).status();
  assert.deepEqual([status.version, status.startedAt, status.idle], ["1.2.3", 1000, true]);
});

test("serverSetup: the engine, the hosts granted in all, who may sign in on which repos", (t) => {
  const { setup } = setupWith(
    t,
    {
      "default.yaml": "hosts: [pypi.org, registry.npmjs.org]\ncached_hosts: [deb.debian.org]\n",
      "acme/api.yaml": 'hosts: ["*.example.com", pypi.org]\nallow_docker: true\n',
      "acme/site.yaml": "hosts: [cdn.example.org]\n",
    },
    {
      ALLOWED_USERS: "alice, Bob",
      ALLOWED_REPOS: "acme/*, BryanSmee/deckhand",
      SANDBOX_ENGINE: "sysbox",
    },
  );
  assert.deepEqual(setup, {
    engine: "sysbox",
    // pypi.org once; cached hosts are among those granted, not more.
    proxy: { on: true, hosts: 4 },
    grants: { ok: true, file: null, message: null },
    allowedUsers: ["alice", "bob"],
    allowedRepos: ["acme/*", "bryansmee/deckhand"],
  });
});

test("serverSetup: nothing but what the Server page shows, whatever the settings hold", (t) => {
  const { setup } = setupWith(t, {}, { ANTHROPIC_API_KEY: "sk-secret", GITHUB_CLIENT_SECRET: "s" });
  assert.deepEqual(Object.keys(setup), [
    "engine",
    "proxy",
    "grants",
    "allowedUsers",
    "allowedRepos",
  ]);
  assert.deepEqual(Object.keys(setup.proxy), ["on", "hosts"]);
  assert.deepEqual(Object.keys(setup.grants), ["ok", "file", "message"]);
  // No engine, no grants folder, no repo allowlist: none, nothing granted, every repo.
  assert.deepEqual([setup.engine, setup.proxy.hosts, setup.allowedRepos], [null, 0, []]);
  assert.ok(!JSON.stringify(setup).includes("secret"));
});

test("serverSetup: a repo's file with errors is named, and grants no host", (t) => {
  const { setup } = setupWith(t, {
    "default.yaml": "hosts: [pypi.org]\n",
    "acme/api.yaml": "hosts: [cdn.example.org]\nallow_everything: true\n",
  });
  assert.equal(setup.proxy.hosts, 1);
  assert.equal(setup.grants.ok, false);
  assert.equal(setup.grants.file, "acme/api.yaml");
  assert.match(setup.grants.message, /^grants: acme\/api\.yaml: allow_everything: unknown/);
});

test("serverSetup: a broken default.yaml stops every run: no host count, its file named", (t) => {
  const { setup } = setupWith(t, {
    "default.yaml": "allow_docker: true\n",
    "acme/api.yaml": "hosts: [cdn.example.org]\n",
  });
  assert.deepEqual(setup.proxy, { on: true, hosts: null });
  assert.deepEqual([setup.grants.ok, setup.grants.file], [false, "default.yaml"]);
  assert.match(setup.grants.message, /allow_docker: only a repository's own file grants it/);
});

test("serverSetup: errors in several files name none, and never the folder's own path", (t) => {
  const { dir, setup } = setupWith(t, {
    "acme/api.yaml": "hosts: 3\n",
    "acme/site.yaml": "limits: 4\n",
  });
  assert.deepEqual([setup.grants.ok, setup.grants.file], [false, null]);
  assert.match(setup.grants.message, /acme\/api\.yaml: .*; grants: acme\/site\.yaml: /);
  // The grants folder is a file: its path stays out.
  const file = join(dir, "default.yaml");
  writeFileSync(file, "");
  const broken = serverSetup(testConfig({ GRANTS_DIR: file }));
  assert.equal(broken.grants.ok, false);
  assert.ok(!broken.grants.message.includes(dir), broken.grants.message);
  assert.match(broken.grants.message, /GRANTS_DIR: expected a folder/);
});
