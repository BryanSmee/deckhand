import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ConfigError, loadConfig } from "../listener/config.mjs";
import {
  grantFor,
  hardeningArgs,
  loadGrants,
  mountArgs,
  parseGrants,
  resolveMounts,
} from "../listener/grants.mjs";

const config = loadConfig({ ALLOWED_USERS: "a", SANDBOX_MEMORY: "2g" });

test("the operator's grants, per repo", () => {
  const grants = parseGrants(
    `Org/Repo:
  hosts: ["*.example.com", pypi.org]
  limits: { cpus: 4, pids: 4096 }
  mounts:
    - root: /nfs/work/
      read_only: false
    - /srv/data
`,
    config,
  );
  assert.deepEqual(grantFor(grants, config, "org/repo"), {
    hosts: ["*.example.com", "pypi.org"],
    allowRepoHosts: false,
    limits: { cpus: "4", memory: "2g", pids: 4096 },
    mounts: [
      { root: "/nfs/work", readOnly: false },
      { root: "/srv/data", readOnly: true },
    ],
  });
  // Any other repo: nothing extra, the operator's limits.
  assert.deepEqual(grantFor(grants, config, "org/other"), {
    hosts: [],
    allowRepoHosts: false,
    mounts: [],
    limits: config.limits,
  });
});

test('allow_repo_hosts: per repo, for every repo with "*", a repo\'s own entry first', () => {
  const allows = (text, repo) => grantFor(parseGrants(text, config), config, repo).allowRepoHosts;
  assert.equal(allows("org/repo:\n  allow_repo_hosts: true\n", "Org/Repo"), true);
  assert.equal(allows("org/repo:\n  allow_repo_hosts: true\n", "org/other"), false);
  const every = '"*":\n  allow_repo_hosts: true\norg/closed:\n  allow_repo_hosts: false\n';
  assert.equal(allows(every, "org/any"), true);
  assert.equal(allows(every, "org/closed"), false);
  // An entry that doesn't say keeps what "*" says.
  assert.equal(allows(`${every}org/mounts:\n  hosts: [pypi.org]\n`, "org/mounts"), true);
});

test("a broken grants file grants nothing and says what is wrong", () => {
  const bad = (text, pattern) => assert.throws(() => parseGrants(text, config), pattern);
  bad("org/repo:\n  hosts: [bad host]\n", /org\/repo: hosts: "bad host"/);
  bad("org/repo:\n  mounts: [/nfs/../etc]\n", /plain absolute root/);
  bad("org/repo:\n  mounts: [relative]\n", /plain absolute root/);
  bad("org/repo:\n  limits: { memory: lots }\n", /org\/repo: limits\.memory: expected an amount/);
  bad("org/repo:\n  limits: { disk: 1 }\n", /limits\.disk: unknown/);
  bad("org/repo:\n  network: host\n", /network: unknown/);
  bad("just-a-name:\n  hosts: []\n", /expected an owner\/repo key/);
  bad("org/repo:\n  allow_repo_hosts: yes\n", /allow_repo_hosts: expected true or false/);
  // "*" only says whether repos may add hosts: nothing else is granted to every repo at once.
  bad('"*":\n  hosts: [pypi.org]\n', /\*: hosts: only allow_repo_hosts applies to every repo/);
  bad('"*":\n  mounts: [/srv]\n', /\*: mounts: only allow_repo_hosts/);
  assert.throws(() => parseGrants("[a]", config), ConfigError);
});

test("no grants file: no grants; an unreadable one is an error", () => {
  const missing = () => {
    throw Object.assign(new Error("nope"), { code: "ENOENT" });
  };
  assert.equal(loadGrants(config, missing).size, 0);
  const denied = () => {
    throw Object.assign(new Error("permission denied"), { code: "EACCES" });
  };
  assert.throws(() => loadGrants(config, denied), /permission denied/);
});

// A root with a subfolder, a symlink inside it and one pointing out. The root is read-only
// for everyone (the tests may run as uid 1000, the sandbox's user), so its subfolders can be
// mounted read-write.
function tree() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "deckhand-grants-")));
  mkdirSync(join(dir, "work", "api"), { recursive: true });
  mkdirSync(join(dir, "secret"));
  symlinkSync(join(dir, "work", "api"), join(dir, "work", "inside"));
  symlinkSync(join(dir, "secret"), join(dir, "work", "escape"));
  chmodSync(join(dir, "work"), 0o555);
  return dir;
}

test("mounts: subpaths of a granted root pass, after resolving .. and symlinks", () => {
  const dir = tree();
  const grant = { mounts: [{ root: join(dir, "work"), readOnly: false }] };
  const { mounts, refused } = resolveMounts(
    [
      { path: join(dir, "work", "api"), readOnly: false },
      { path: join(dir, "work"), readOnly: true },
      { path: join(dir, "work", "inside"), readOnly: true },
      { path: `${dir}/work/api/../api`, readOnly: true },
    ],
    grant,
  );
  assert.deepEqual(refused, []);
  assert.deepEqual(mounts, [
    { source: join(dir, "work", "api"), target: join(dir, "work", "api"), readOnly: false },
    { source: join(dir, "work"), target: join(dir, "work"), readOnly: true },
    // Mounted from where the link points, at the path asked for.
    { source: join(dir, "work", "api"), target: join(dir, "work", "inside"), readOnly: true },
    { source: join(dir, "work", "api"), target: join(dir, "work", "api"), readOnly: true },
  ]);
});

test("mounts: .., symlinks out, other paths and no grant are refused", () => {
  const dir = tree();
  const grant = { mounts: [{ root: join(dir, "work"), readOnly: true }] };
  const refusedFor = (path, g = grant) =>
    resolveMounts([{ path, readOnly: true }], g).refused.join("");
  assert.match(refusedFor(`${dir}/work/../secret`), /resolves to \S+\/secret, outside the roots/);
  assert.match(refusedFor(`${dir}/work/escape`), /resolves to \S+\/secret, outside the roots/);
  assert.match(refusedFor(`${dir}/work/../nothing`), /resolves to \S+\/nothing, outside/);
  assert.match(refusedFor(`${dir}/work/missing`), /doesn't exist, or the listener can't see it/);
  assert.match(refusedFor(`${dir}/work-other`), /outside the roots/);
  assert.match(refusedFor("/etc", { mounts: [] }), /grants this repository no host paths/);
  assert.match(refusedFor("/workspace/x"), /the sandbox uses \/workspace itself/);
  assert.match(refusedFor("/home/node"), /the sandbox uses \/home\/node\/\.claude itself/);
  assert.match(refusedFor(`${dir}/work/a,b`), /only letters, digits/);
  // A root the listener can't see grants nothing.
  const unseen = { mounts: [{ root: "/nfs/nowhere", readOnly: false }] };
  assert.match(refusedFor("/nfs/nowhere/api", unseen), /doesn't exist, or the listener can't/);
  // Caches the repo mounts are taken too.
  const clash = resolveMounts([{ path: "/home/node/.npm", readOnly: true }], grant, {
    caches: ["/home/node/.npm"],
  });
  assert.match(clash.refused[0], /uses \/home\/node\/\.npm itself/);
});

test("mounts: read-only unless the operator grants read-write; a repo can only narrow", () => {
  const dir = tree();
  const path = join(dir, "work", "api");
  const ro = resolveMounts([{ path, readOnly: false }], {
    mounts: [{ root: join(dir, "work"), readOnly: true }],
  });
  assert.equal(ro.mounts[0].readOnly, true);
  assert.match(ro.notes[0], /mounted read-only: the operator grants \S+ read-only/);
  const rw = { mounts: [{ root: join(dir, "work"), readOnly: false }] };
  assert.equal(resolveMounts([{ path, readOnly: true }], rw).mounts[0].readOnly, true);
  assert.equal(resolveMounts([{ path, readOnly: false }], rw).mounts[0].readOnly, false);
});

test("mounts: read-write refused when the sandbox's user can rewrite a directory on the way", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "deckhand-grants-")));
  const root = join(dir, "work");
  mkdirSync(join(root, "team", "api", "src"), { recursive: true });
  chmodSync(root, 0o555);
  chmodSync(join(root, "team"), 0o777); // anyone, so uid 1000 too
  chmodSync(join(root, "team", "api"), 0o777); // the mount itself may be writable
  const grant = { mounts: [{ root, readOnly: false }] };
  const resolve = (path, readOnly = false) => resolveMounts([{ path, readOnly }], grant);
  // /work/team can be written: a sandbox could swap /work/team/api for a symlink to /.
  assert.match(
    resolve(join(root, "team", "api")).refused[0],
    /read-write, but the sandbox's user \(uid 1000\) can write `\S+\/work\/team` on its way/,
  );
  assert.match(resolve(join(root, "team", "api", "src")).refused[0], /\/work\/team` on its way/);
  // Its own entry is in /work, which it can't write; read-only requests aren't checked.
  assert.deepEqual(resolve(join(root, "team")).refused, []);
  assert.deepEqual(resolve(root).refused, []);
  assert.deepEqual(resolve(join(root, "team", "api"), true).refused, []);
  // A narrower root inside a wider one: checked from the wider one.
  chmodSync(join(root, "team"), 0o555);
  chmodSync(root, 0o777);
  const nested = {
    mounts: [
      { root: join(root, "team"), readOnly: false },
      { root, readOnly: true },
    ],
  };
  assert.match(
    resolveMounts([{ path: join(root, "team", "api"), readOnly: false }], nested).refused[0],
    /can write `\S+\/work` on its way/,
  );
});

test("mounts: writable by uid 1000 as owner, group 1000 or anyone", () => {
  const modes = new Map();
  const stat = (path) => modes.get(path) ?? { mode: 0o755, uid: 0, gid: 0 };
  const grant = { mounts: [{ root: "/nfs", readOnly: false }] };
  const refusedWith = (parent) => {
    modes.clear();
    modes.set("/nfs/team", parent);
    return resolveMounts([{ path: "/nfs/team/api", readOnly: false }], grant, {
      realpath: (p) => p,
      stat,
    }).refused.length;
  };
  assert.equal(refusedWith({ mode: 0o755, uid: 1000, gid: 0 }), 1);
  assert.equal(refusedWith({ mode: 0o555, uid: 1000, gid: 0 }), 0);
  assert.equal(refusedWith({ mode: 0o775, uid: 0, gid: 1000 }), 1);
  assert.equal(refusedWith({ mode: 0o755, uid: 0, gid: 1000 }), 0);
  assert.equal(refusedWith({ mode: 0o1777, uid: 0, gid: 0 }), 1);
  assert.equal(refusedWith({ mode: 0o775, uid: 1001, gid: 1001 }), 0);
});

test("docker arguments: bind mounts, no capabilities, limits", () => {
  assert.deepEqual(
    mountArgs([
      { source: "/nfs/a", target: "/nfs/a", readOnly: true },
      { source: "/nfs/b", target: "/data/b", readOnly: false },
    ]),
    [
      "--mount",
      "type=bind,src=/nfs/a,dst=/nfs/a,readonly",
      "--mount",
      "type=bind,src=/nfs/b,dst=/data/b",
    ],
  );
  assert.deepEqual(hardeningArgs({ cpus: "1.5", memory: "2g", pids: 512 }), [
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--cpus",
    "1.5",
    "--memory",
    "2g",
    "--memory-swap",
    "2g",
    "--pids-limit",
    "512",
  ]);
});
