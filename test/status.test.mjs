import assert from "node:assert/strict";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
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
      "acme/api.yaml": 'hosts: ["*.example.com", pypi.org]\n',
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
    // No Claude credential set.
    claude: { set: [], default: null, fallbacks: [] },
    allowedUsers: ["alice", "bob"],
    allowedRepos: ["acme/*", "bryansmee/deckhand"],
  });
});

test("serverSetup: nothing but what the Server page shows, whatever the settings hold", (t) => {
  const secrets = {
    ANTHROPIC_API_KEY: "sk-ant-3f9e1c",
    CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-5d2a",
    GITHUB_CLIENT_SECRET: "gh-cs-77ab42",
  };
  const { setup } = setupWith(t, {}, secrets);
  assert.deepEqual(Object.keys(setup), [
    "engine",
    "proxy",
    "grants",
    "claude",
    "allowedUsers",
    "allowedRepos",
  ]);
  assert.deepEqual(Object.keys(setup.proxy), ["on", "hosts"]);
  assert.deepEqual(Object.keys(setup.grants), ["ok", "file", "message"]);
  // The Claude credentials by name: the plan first, the key set too, no fallback to it.
  assert.deepEqual(setup.claude, { set: ["plan", "key"], default: "plan", fallbacks: [] });
  // No engine, no grants folder, no repo allowlist: none, nothing granted, every repo.
  assert.deepEqual([setup.engine, setup.proxy.hosts, setup.allowedRepos], [null, 0, []]);
  for (const value of Object.values(secrets)) assert.ok(!JSON.stringify(setup).includes(value));
});

test("serverSetup: which Claude credential runs use first", (t) => {
  const claude = (env) => setupWith(t, {}, env).setup.claude;
  assert.deepEqual(claude({ ANTHROPIC_API_KEY: "k" }), {
    set: ["key"],
    default: "key",
    fallbacks: [],
  });
  // A gateway's token comes first; it isn't one an entry can name, but FALLBACKS can still
  // name the key. Other agents' and providers' entries aren't Claude's credentials.
  const env = {
    ANTHROPIC_AUTH_TOKEN: "t",
    ANTHROPIC_API_KEY: "k",
    OPENAI_API_KEY: "o",
    FALLBACKS: "codex@openai, claude@anthropic:key",
  };
  assert.deepEqual(claude(env), { set: ["key"], default: "gateway", fallbacks: ["key"] });
});

test("serverSetup: a repo's file with errors is named, not quoted, and grants no host", (t) => {
  const { setup } = setupWith(t, {
    "default.yaml": "hosts: [pypi.org]\n",
    // Its error quotes the root: a path on the host, for this repo's eyes only.
    "acme/api.yaml":
      "hosts: [cdn.example.org]\nmounts: [{ root: /srv/private-client/data, read_only: maybe }]\n",
  });
  assert.deepEqual(setup.proxy, { on: true, hosts: 1 });
  assert.deepEqual(setup.grants, {
    ok: false,
    file: "acme/api.yaml",
    message: "acme/api.yaml has errors (a repository's config panel says what)",
  });
  assert.ok(!JSON.stringify(setup).includes("private-client"));
});

test("serverSetup: a broken default.yaml stops every run: no host count, its file named", (t) => {
  const { setup } = setupWith(t, {
    "default.yaml": "mounts: [/srv]\n",
    "acme/api.yaml": "hosts: [cdn.example.org]\n",
  });
  assert.deepEqual(setup.proxy, { on: true, hosts: null });
  assert.deepEqual([setup.grants.ok, setup.grants.file], [false, "default.yaml"]);
  assert.match(setup.grants.message, /^default\.yaml has errors/);
});

test("serverSetup: errors in several files name each, and never a path", (t) => {
  const { dir, setup } = setupWith(t, {
    "acme/api.yaml": "hosts: 3\n",
    "acme/site.yaml": "limits: 4\n",
  });
  assert.deepEqual([setup.grants.ok, setup.grants.file], [false, null]);
  assert.match(setup.grants.message, /^acme\/api\.yaml, acme\/site\.yaml have errors/);
  // The grants folder is a file: not a file in it to name, nor its path.
  const file = join(dir, "default.yaml");
  writeFileSync(file, "");
  const broken = serverSetup(testConfig({ GRANTS_DIR: file }));
  assert.deepEqual([broken.grants.ok, broken.grants.file], [false, null]);
  assert.ok(!broken.grants.message.includes(dir), broken.grants.message);
  assert.match(broken.grants.message, /^the grants folder has errors/);
});

test("serverSetup: a grants folder that can't be listed names no file", (t) => {
  const { dir } = setupWith(t, { "acme/api.yaml": "hosts: [cdn.example.org]\n" });
  // Its error's file is "" (grants.mjs walkGrants()): the folder itself.
  chmodSync(dir, 0);
  let setup;
  try {
    setup = serverSetup(testConfig({ GRANTS_DIR: dir }));
  } finally {
    chmodSync(dir, 0o755);
  }
  assert.deepEqual([setup.grants.ok, setup.grants.file], [false, null]);
  assert.match(setup.grants.message, /^the grants folder has errors/);
});
