// The replies that stop a run before its sandbox starts: grants, mounts, `/agent` and models.
import assert from "node:assert/strict";
import { mkdirSync, realpathSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  bareAccess,
  egressCache,
  engineFor,
  grantedAccess,
  recheckMounts,
  researchRefusal,
  RunError,
  validateRun,
} from "../listener/access.mjs";
import { agentFor } from "../listener/agents/index.mjs";
import { egressPolicy } from "../listener/egress.mjs";
import { parseRepoConfig } from "../listener/repo-config.mjs";
import { grantedOf, tempDir, testConfig } from "./helpers.mjs";

const claude = agentFor("claude");
const codex = agentFor("codex");

const task = (live = {}) => ({
  repo: "org/repo",
  base: "trunk",
  live: {
    light: false,
    mode: "work",
    capabilities: ["pull", "push"],
    record: { model: "best" },
    ...live,
  },
});

// A grants folder holding org/repo.yaml, and the config reading it.
function granted(t, text) {
  const dir = realpathSync(tempDir(t));
  mkdirSync(join(dir, "org"));
  writeFileSync(join(dir, "org", "repo.yaml"), text);
  return { dir, config: testConfig({ GRANTS_DIR: dir }) };
}

// grantedAccess() for the repo's .deckhand.yaml `yaml` and the grant `text`: the error
// stopping the run, and what it logged.
async function refusal(t, text, yaml, agent = claude) {
  const { config } = granted(t, text);
  const { settings } = parseRepoConfig(yaml, config);
  const logged = [];
  const io = { agent, note: () => {}, log: (m) => logged.push(m) };
  try {
    await grantedAccess(config, task(), settings, io);
  } catch (error) {
    assert.ok(error instanceof RunError, error.stack);
    return { error: error.message, logged };
  }
  assert.fail("the run went on");
}

test("a broken grant file stops the repo's runs, naming the file; the details stay in the logs", async (t) => {
  const { error, logged } = await refusal(t, "hosts: [bad host]\n", "");
  assert.equal(
    error,
    "Claude can't run here: `org/repo.yaml` in the operator's grants folder has errors (see the orchestrator's logs).",
  );
  assert.match(logged.join("\n"), /org\/repo\.yaml: hosts: .*bad host/);
  // One still saying allow_repo_hosts, gone since #151: the same.
  const old = await refusal(t, "allow_repo_hosts: true\n", "hosts: [pypi.org]\n");
  assert.match(old.error, /`org\/repo\.yaml` in the operator's grants folder has errors/);
  assert.match(old.logged.join("\n"), /allow_repo_hosts: gone/);
  // One still granting what the policies grant since #498: the same, saying what to write.
  const moved = await refusal(t, "allow_docker: true\n", "");
  assert.match(moved.error, /`org\/repo\.yaml` in the operator's grants folder has errors/);
  assert.match(
    moved.logged.join("\n"),
    /allow_docker: moved to the operator's policies \(#498\): `allow_grant if \{ input\.repo\.name == "org\/repo"; input\.grant == "docker" \}`/,
  );
});

test("a broken policy stops the repo's runs as a broken grant file does", async (t) => {
  const { config } = granted(t, "hosts: [pypi.org]\n");
  const logged = [];
  const io = {
    agent: claude,
    note: () => {},
    log: (m) => logged.push(m),
    granted: async () => ({ error: "policy error: grants.rego:3: rego_parse_error" }),
  };
  await assert.rejects(
    grantedAccess(config, task(), parseRepoConfig("", config).settings, io),
    (e) =>
      e instanceof RunError &&
      e.message ===
        "Claude can't run here: the operator's grants folder has errors (see the orchestrator's logs).",
  );
  assert.match(logged.join("\n"), /the operator's policies can't decide org\/repo's: policy error/);
});

test("a Dockerfile or engine without its grant: one reply listing them", async (t) => {
  const yaml = "dockerfile: docker/Dockerfile\ndocker: true\n";
  const { error, logged } = await refusal(t, "hosts: [pypi.org]\n", yaml);
  assert.match(error, /^Claude can't run here: `\.deckhand\.yaml` on `trunk` has errors\./);
  for (const name of ["dockerfile", "docker"]) {
    assert.match(
      error,
      new RegExp(
        `- ${name}: the operator's policies don't grant \`${name}\` to this repository \\(\`allow_grant\`\\)`,
      ),
    );
  }
  assert.match(error, /with `allow_grant` rules in the grants folder's policies/);
  assert.match(logged.join("\n"), /asks for what its grant doesn't allow/);
  // Granted by the operator's policies: the run goes on.
  const { config } = granted(t, "hosts: [pypi.org]\n");
  const access = await grantedAccess(config, task(), parseRepoConfig(yaml, config).settings, {
    agent: claude,
    note: () => {},
    log: () => {},
    granted: grantedOf(["dockerfile", "docker"]),
  });
  assert.equal(access.grant.allowDocker, true);
  assert.deepEqual(access.grant.grantFiles, ["grants.rego"]);
});

test("mounts outside the granted root, through a symlink or .., are refused, each named", async (t) => {
  const dir = realpathSync(tempDir(t));
  mkdirSync(join(dir, "nfs"));
  symlinkSync("/etc", join(dir, "nfs", "escape"));
  const yaml = `mounts:\n  - ${dir}/nfs/escape\n  - ${dir}/nfs/../etc\n`;
  const { error } = await refusal(t, `mounts: [${join(dir, "nfs")}]\n`, yaml, codex);
  assert.match(
    error,
    /^Codex can't run here: host mounts requested by `\.deckhand\.yaml` are refused/,
  );
  assert.match(error, /escape`: resolves to \/etc, outside the roots/);
  assert.match(error, /\.\.\/etc`: (resolves to \S+, outside|doesn't exist)/);
  assert.match(error, /Only paths under a root the operator grants this repository can be mounted/);
});

test("a mount that resolves elsewhere once the run is prepared stops it", async (t) => {
  const dir = realpathSync(tempDir(t));
  mkdirSync(join(dir, "nfs", "a"), { recursive: true });
  mkdirSync(join(dir, "nfs", "b"));
  symlinkSync("a", join(dir, "nfs", "api"));
  const config = testConfig({ GRANTS_DIR: granted(t, `mounts: [${join(dir, "nfs")}]\n`).dir });
  const { settings } = parseRepoConfig(`mounts:\n  - ${dir}/nfs/api\n`, config);
  const noted = [];
  const io = { agent: claude, note: (m) => noted.push(m), log: () => {} };
  const checked = await grantedAccess(config, task(), settings, io);
  assert.deepEqual(noted, [`Host mount ${dir}/nfs/api (read-only)`]);
  // Unchanged: it goes on.
  recheckMounts(claude, settings, checked);
  // The link now points elsewhere.
  symlinkSync("b", join(dir, "nfs", "api-b"));
  renameSync(join(dir, "nfs", "api-b"), join(dir, "nfs", "api"));
  assert.throws(
    () => recheckMounts(claude, settings, checked),
    (e) =>
      e instanceof RunError &&
      /^Claude can't run here: host mounts changed while the run was being prepared\./.test(
        e.message,
      ) &&
      e.message.includes(`\`${dir}/nfs/api\` no longer resolves to \`${dir}/nfs/a\``),
  );
});

// A fork's code would leave something there for the repo's later runs (sandbox-spec.mjs).
test("a run with a comment from a fork's pull request notes its read-write mounts read-only", async (t) => {
  const dir = realpathSync(tempDir(t));
  mkdirSync(join(dir, "nfs", "api"), { recursive: true });
  const grant = `mounts:\n  - root: ${join(dir, "nfs")}\n    read_only: false\n`;
  const config = testConfig({ GRANTS_DIR: granted(t, grant).dir });
  const { settings } = parseRepoConfig(
    `mounts:\n  - path: ${dir}/nfs/api\n    read_only: false\n`,
    config,
  );
  // Owned by root, as a granted root should be: these temp dirs are uid 1000's, the sandbox's.
  const fs = { stat: () => ({ mode: 0o40755, uid: 0, gid: 0 }) };
  const notes = async (live) => {
    const noted = [];
    await grantedAccess(config, task(live), settings, {
      agent: claude,
      note: (m) => noted.push(m),
      log: () => {},
      fs,
    });
    return noted;
  };
  assert.deepEqual(await notes({}), [`Host mount ${dir}/nfs/api`]);
  assert.deepEqual(await notes({ fork: true }), [
    `Host mount ${dir}/nfs/api (read-only: a pull request from a fork)`,
  ]);
  assert.deepEqual(await notes({ capabilities: ["pull"], fork: true }), [
    `Host mount ${dir}/nfs/api (read-only)`,
  ]);
});

test("validateRun: an /agent the operator doesn't have, config errors, a mode gone, another agent's model", () => {
  const ok = { badPick: null, errors: [], warnings: [], own: null };
  const noted = [];
  const note = (m) => noted.push(m);
  validateRun(claude, task(), { ...ok, warnings: ["triggers: renamed trigger"] }, note);
  assert.deepEqual(noted, [".deckhand.yaml: triggers: renamed trigger"]);
  const refused = (agent, live, run) => {
    try {
      validateRun(agent, task(live), { ...ok, ...run }, note);
    } catch (error) {
      assert.ok(error instanceof RunError);
      return error.message;
    }
    assert.fail("the run went on");
  };
  const badPick =
    "`/agent codex` isn't one the operator configured (`claude@anthropic`, or `default`)";
  assert.equal(refused(claude, {}, { badPick }), `Claude can't run here: ${badPick}.`);
  assert.match(
    refused(claude, {}, { errors: ["agent: the operator hasn't configured codex"] }),
    /^Claude can't run here: `\.deckhand\.yaml` on `trunk` has errors\.\n\n- agent: the operator hasn't configured codex$/,
  );
  assert.equal(
    refused(claude, { mode: "audit" }, {}),
    "Claude can't run here: the `audit` mode is no longer in `.deckhand.yaml` on `trunk`.",
  );
  assert.match(
    refused(codex, { record: { model: "opus" } }, {}),
    /^Codex can't run here: `opus` is a Claude model, not one of Codex's\. Use a tier/,
  );
});

test("engineFor: the repo's `docker` with its grant and the operator's SANDBOX_ENGINE, for work", () => {
  const config = testConfig({ SANDBOX_ENGINE: "podman" });
  const docker = { docker: { cache: true } };
  const access = { grant: { allowDocker: true }, limits: { cpus: 3 } };
  const notes = [];
  const engine = (cfg, live, settings, granted, fork = false) =>
    engineFor(cfg, task(live), settings, granted, fork, (m) => notes.push(m));
  const cached = engine(config, {}, docker, access);
  assert.deepEqual(cached.limits, { cpus: 3 });
  assert.match(cached.cache, /^deckhand-engine-cache-org-repo-[0-9a-f]+$/);
  assert.equal(engine(config, {}, { docker: {} }, access).cache, null);
  // None without the repo's `docker` or its grant (a run without the `docker` capability doesn't
  // ask: preparation.mjs).
  assert.equal(engine(config, {}, { docker: null }, access), null);
  assert.equal(engine(config, {}, docker, { ...access, grant: { allowDocker: false } }), null);
  assert.deepEqual(notes, []);
  // Without SANDBOX_ENGINE, or for a fork's pull request: none, and the log says why.
  assert.equal(engine(testConfig(), {}, docker, access), null);
  assert.equal(engine(config, {}, docker, access, true), null);
  assert.deepEqual(notes, [
    "No container engine: the operator hasn't set SANDBOX_ENGINE",
    "No container engine: a pull request from a fork",
  ]);
  // A run that reaches the open internet: an engine, without the cache later runs' engines trust.
  notes.length = 0;
  const open = engineFor(config, task({}), docker, access, false, (m) => notes.push(m), true);
  assert.deepEqual(open, { limits: { cpus: 3 }, cache: null });
  assert.deepEqual(notes, ["No engine cache: this run reaches the open internet"]);
});

test("research: refused without the `research` grant, naming it; a broken grant file too", async (t) => {
  const io = { agent: claude, log: () => {}, internet: true };
  const research = task({ light: true, mode: "research", capabilities: ["internet"] });
  const without = granted(t, "hosts: [nas.lan.example]\n").config;
  assert.match(await researchRefusal(without, "org/repo"), /don't grant `research`/);
  await assert.rejects(
    bareAccess(without, research, io),
    (e) =>
      e instanceof RunError &&
      /^Claude can't run here: research runs need the `research` grant: the operator's policies don't grant `research`/.test(
        e.message,
      ),
  );
  const broken = granted(t, "hosts: [bad host]\n").config;
  assert.match(
    await researchRefusal(broken, "org/repo"),
    /`org\/repo\.yaml` in the operator's grants/,
  );
  // The operator's policies grant it.
  const granting = { granted: grantedOf(["research"]) };
  assert.equal(await researchRefusal(without, "org/repo", granting), null);
  assert.ok(await bareAccess(without, research, { ...io, ...granting }));
  // Without `internet`, no grant is needed, but grants that can't be read still refuse.
  assert.ok(await bareAccess(without, research, { ...io, internet: false }));
  await assert.rejects(
    bareAccess(broken, research, { ...io, internet: false }),
    /^Error: Claude can't run here: `org\/repo\.yaml` in the operator's grants folder has errors/,
  );
});

test("research: any public host, private addresses for the mandatory hosts only, nothing else", async (t) => {
  const { config } = granted(
    t,
    "hosts: [nas.lan.example]\ncached_hosts: [deb.debian.org]\nmounts: [/srv]\nlimits: { cpus: 3 }\n",
  );
  const research = task({ light: true, mode: "research", capabilities: ["internet"] });
  const granting = grantedOf(["research"]);
  const access = await bareAccess(config, research, {
    agent: claude,
    log: () => {},
    internet: true,
    granted: granting,
  });
  assert.deepEqual(access.hosts, ["*"]);
  assert.deepEqual(access.mounts, []);
  assert.deepEqual(access.grant.cachedHosts, []);
  assert.equal(access.limits.cpus, "3");
  const answer = (host) => egressPolicy(host, access.hosts, access.trusted, [], []);
  assert.deepEqual(answer("example.org"), {
    allowed: true,
    private: false,
    cache: false,
    decrypt: false,
    relay: false,
  });
  // The repo's granted internal host is public only here: next to the open internet, it
  // would be a way out for what it serves.
  assert.equal(answer("nas.lan.example").private, false);
  assert.equal(answer("github.com").private, true);
  // Its work runs still get the operator's hosts only.
  const { settings } = parseRepoConfig("", config);
  const work = await grantedAccess(config, task(), settings, {
    agent: claude,
    note: () => {},
    log: () => {},
  });
  assert.ok(!work.hosts.includes("*"));
  assert.ok(work.hosts.includes("nas.lan.example"));
  assert.equal(egressPolicy("example.org", work.hosts, work.trusted).allowed, false);
  // A run with neither `pull` nor `internet`: the mandatory hosts alone.
  const bare = await bareAccess(config, research, {
    agent: claude,
    log: () => {},
    internet: false,
    granted: granting,
  });
  assert.deepEqual(bare.hosts, bare.trusted);
  assert.ok(!bare.hosts.includes("nas.lan.example"));
  assert.ok(bare.hosts.includes("github.com"));
});

test("egressCache: an agent whose calls the proxy relays gets the CA, a research run's too; none on an API key", async () => {
  const agy = agentFor("antigravity");
  const notes = [];
  const note = (line) => notes.push(line);
  const grant = { cachedHosts: [] };
  // A research run (no GitHub) on a Google AI plan's login: its agent's calls are decrypted.
  const plan = { agyCredential: "AGY_AUTH_FILE" };
  assert.deepEqual(await egressCache(grant, async () => "PEM", note, agy, plan, false), {
    ca: "PEM",
    cached: [],
  });
  // Without the CA it can't run: said, rather than every call failing on TLS.
  await assert.rejects(
    egressCache(grant, async () => null, note, agy, plan, false),
    /the egress proxy has no CA, and its calls to its provider go through it/,
  );
  // On a Gemini API key its calls go to the listener directly: nothing to trust.
  const key = { agyCredential: "GEMINI_API_KEY" };
  assert.deepEqual(await egressCache(grant, async () => "PEM", note, agy, key, false), {
    ca: null,
    cached: [],
  });
  // Claude Code relays nothing.
  assert.deepEqual(
    await egressCache(grant, async () => "PEM", note, agentFor("claude"), {}, false),
    {
      ca: null,
      cached: [],
    },
  );
});
