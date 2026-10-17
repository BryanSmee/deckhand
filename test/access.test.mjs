// The replies that stop a run before its sandbox starts: grants, mounts, `/agent` and models.
import assert from "node:assert/strict";
import { mkdirSync, realpathSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  engineFor,
  grantedAccess,
  recheckMounts,
  researchAccess,
  researchRefusal,
  RunError,
  validateRun,
} from "../listener/access.mjs";
import { agentFor } from "../listener/agents/index.mjs";
import { egressPolicy } from "../listener/egress.mjs";
import { parseRepoConfig } from "../listener/repo-config.mjs";
import { tempDir, testConfig } from "./helpers.mjs";

const claude = agentFor("claude");
const codex = agentFor("codex");

const task = (live = {}) => ({
  repo: "org/repo",
  base: "trunk",
  live: { light: false, mode: "work", record: { model: "best" }, ...live },
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
function refusal(t, text, yaml, agent = claude) {
  const { config } = granted(t, text);
  const { settings } = parseRepoConfig(yaml, config);
  const logged = [];
  const io = { agent, note: () => {}, log: (m) => logged.push(m) };
  try {
    grantedAccess(config, task(), settings, io);
  } catch (error) {
    assert.ok(error instanceof RunError, error.stack);
    return { error: error.message, logged };
  }
  assert.fail("the run went on");
}

test("a broken grant file stops the repo's runs, naming the file; the details stay in the logs", (t) => {
  const { error, logged } = refusal(t, "hosts: [bad host]\n", "");
  assert.equal(
    error,
    "Claude can't run here: `org/repo.yaml` in the operator's grants folder has errors (see the listener's logs).",
  );
  assert.match(logged.join("\n"), /org\/repo\.yaml: hosts: .*bad host/);
  // One still saying allow_repo_hosts, gone since #151: the same.
  const old = refusal(t, "allow_repo_hosts: true\n", "hosts: [pypi.org]\n");
  assert.match(old.error, /`org\/repo\.yaml` in the operator's grants folder has errors/);
  assert.match(old.logged.join("\n"), /allow_repo_hosts: gone/);
});

test("a preview hook, Dockerfile or engine without its grant: one reply listing them", (t) => {
  const yaml = "preview: ./preview.sh\ndockerfile: docker/Dockerfile\ndocker: true\n";
  const { error, logged } = refusal(t, "hosts: [pypi.org]\n", yaml);
  assert.match(error, /^Claude can't run here: `\.deckhand\.yaml` on `trunk` has errors\./);
  assert.match(error, /- preview: .* don't set `allow_preview: true` for this repository/);
  assert.match(error, /- dockerfile: .* don't set `allow_dockerfile: true` for this repository/);
  assert.match(error, /- docker: .* don't set `allow_docker: true` for this repository/);
  assert.match(error, /The operator can add these to the repository's file in the grants folder/);
  assert.match(logged.join("\n"), /asks for what its grant doesn't allow/);
});

test("mounts outside the granted root, through a symlink or .., are refused, each named", (t) => {
  const dir = realpathSync(tempDir(t));
  mkdirSync(join(dir, "nfs"));
  symlinkSync("/etc", join(dir, "nfs", "escape"));
  const yaml = `mounts:\n  - ${dir}/nfs/escape\n  - ${dir}/nfs/../etc\n`;
  const { error } = refusal(t, `mounts: [${join(dir, "nfs")}]\n`, yaml, codex);
  assert.match(
    error,
    /^Codex can't run here: host mounts requested by `\.deckhand\.yaml` are refused/,
  );
  assert.match(error, /escape`: resolves to \/etc, outside the roots/);
  assert.match(error, /\.\.\/etc`: (resolves to \S+, outside|doesn't exist)/);
  assert.match(error, /Only paths under a root the operator grants this repository can be mounted/);
});

test("a mount that resolves elsewhere once the run is prepared stops it", (t) => {
  const dir = realpathSync(tempDir(t));
  mkdirSync(join(dir, "nfs", "a"), { recursive: true });
  mkdirSync(join(dir, "nfs", "b"));
  symlinkSync("a", join(dir, "nfs", "api"));
  const config = testConfig({ GRANTS_DIR: granted(t, `mounts: [${join(dir, "nfs")}]\n`).dir });
  const { settings } = parseRepoConfig(`mounts:\n  - ${dir}/nfs/api\n`, config);
  const noted = [];
  const io = { agent: claude, note: (m) => noted.push(m), log: () => {} };
  const checked = grantedAccess(config, task(), settings, io);
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
  // None without the repo's `docker`, its grant, or for a light run.
  assert.equal(engine(config, {}, { docker: null }, access), null);
  assert.equal(engine(config, {}, docker, { ...access, grant: { allowDocker: false } }), null);
  assert.equal(engine(config, { light: true }, docker, access), null);
  assert.deepEqual(notes, []);
  // Without SANDBOX_ENGINE, or for a fork's pull request: none, and the log says why.
  assert.equal(engine(testConfig(), {}, docker, access), null);
  assert.equal(engine(config, {}, docker, access, true), null);
  assert.deepEqual(notes, [
    "No container engine: the operator hasn't set SANDBOX_ENGINE",
    "No container engine: a pull request from a fork",
  ]);
});

test("research: refused without allow_research, naming the grant; a broken grant file too", (t) => {
  const io = { agent: claude, log: () => {} };
  const research = task({ light: true, mode: "research" });
  const without = granted(t, "hosts: [nas.lan.example]\n").config;
  assert.match(researchRefusal(without, "org/repo"), /`allow_research: true`/);
  assert.throws(
    () => researchAccess(without, research, io),
    (e) =>
      e instanceof RunError &&
      /^Claude can't run here: research runs need the operator's `allow_research: true` grant/.test(
        e.message,
      ),
  );
  const broken = granted(t, "allow_research: yes\n").config;
  assert.match(researchRefusal(broken, "org/repo"), /`org\/repo\.yaml` in the operator's grants/);
  // default.yaml grants it to every repo.
  const dir = realpathSync(tempDir(t));
  writeFileSync(join(dir, "default.yaml"), "allow_research: true\n");
  assert.equal(researchRefusal(testConfig({ GRANTS_DIR: dir }), "org/repo"), null);
});

test("research: any public host, private addresses for the mandatory hosts only, nothing else", (t) => {
  const { config } = granted(
    t,
    "allow_research: true\nhosts: [nas.lan.example]\ncached_hosts: [deb.debian.org]\nmounts: [/srv]\nlimits: { cpus: 3 }\n",
  );
  const research = task({ light: true, mode: "research" });
  const access = researchAccess(config, research, { agent: claude, log: () => {} });
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
  const work = grantedAccess(config, task(), settings, {
    agent: claude,
    note: () => {},
    log: () => {},
  });
  assert.ok(!work.hosts.includes("*"));
  assert.ok(work.hosts.includes("nas.lan.example"));
  assert.equal(egressPolicy("example.org", work.hosts, work.trusted).allowed, false);
});
