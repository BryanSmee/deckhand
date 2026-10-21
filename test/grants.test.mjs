import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { loadConfig, parseConfigFile } from "../listener/config.mjs";
import {
  autoMergeGrants,
  autoMergeProblems,
  GrantsError,
  grantErrors,
  grantFor,
  grantsFrom,
  hardeningArgs,
  loadGrants,
  mountArgs,
  resolveMounts,
  ungranted,
} from "../listener/grants.mjs";
import { tempDir, testConfig } from "./helpers.mjs";

const config = testConfig({ ALLOWED_USERS: "a" });

// What one repo gets from a grants folder given as { "path/in/it.yaml": text }.
const grantOf = (files, repo) => grantFor(grantsFrom(files, config), config, repo);

// A grants folder on disk: { "path/in/it": text }, and the config reading it.
function folder(t, files) {
  const dir = realpathSync(tempDir(t, "deckhand-grants-dir-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return { dir, config: { ...config, grantsDir: dir } };
}

const NOTHING = {
  hosts: [],
  cachedHosts: [],
  allowPreview: false,
  allowDockerfile: false,
  allowBranchDockerImages: false,
  allowDocker: false,
  allowResearch: false,
  allowWorkflows: false,
  allowAutoMerge: false,
  mounts: [],
  limits: config.limits,
  files: [],
  hostFiles: {},
  limitsFile: null,
};

test("the operator's grants, one file per repo", () => {
  const files = {
    "Org/Repo.yaml": `hosts: ["*.example.com", pypi.org]
limits: { cpus: 4, pids: 4096 }
mounts:
  - root: /nfs/work/
    read_only: false
  - /srv/data
`,
  };
  assert.deepEqual(grantOf(files, "org/repo"), {
    hosts: ["*.example.com", "pypi.org"],
    cachedHosts: [],
    allowPreview: false,
    allowDockerfile: false,
    allowBranchDockerImages: false,
    allowDocker: false,
    allowResearch: false,
    allowWorkflows: false,
    allowAutoMerge: false,
    limits: { cpus: "4", memory: "4g", pids: 4096 },
    mounts: [
      { root: "/nfs/work", readOnly: false },
      { root: "/srv/data", readOnly: true },
    ],
    files: ["Org/Repo.yaml"],
    hostFiles: { "*.example.com": "Org/Repo.yaml", "pypi.org": "Org/Repo.yaml" },
    limitsFile: "Org/Repo.yaml",
  });
  // Any other repo: nothing extra, the operator's limits.
  assert.deepEqual(grantOf(files, "org/other"), NOTHING);
  assert.deepEqual(grantOf({}, "org/repo"), NOTHING);
});

test("default.yaml: flags unless a repo's own file says, hosts added, limits as the base", () => {
  const files = {
    "default.yaml": `allow_dockerfile: true
hosts: [pypi.org]
limits: { memory: 8g, cpus: 3 }
`,
    "org/closed.yaml": "allow_dockerfile: false\n",
    "org/api.yaml":
      "hosts: [files.example.com, pypi.org]\nlimits: { cpus: 4 }\nallow_preview: true\n",
  };
  const api = grantOf(files, "Org/API");
  assert.deepEqual(
    [api.allowDockerfile, api.allowPreview, api.allowBranchDockerImages],
    [true, true, false],
  );
  assert.deepEqual(api.hosts, ["pypi.org", "files.example.com"]);
  assert.deepEqual(api.hostFiles, {
    "pypi.org": "default.yaml",
    "files.example.com": "org/api.yaml",
  });
  // Its own cpus over default.yaml's memory, over the built-in pids.
  assert.deepEqual(api.limits, { cpus: "4", memory: "8g", pids: 2048 });
  assert.equal(api.limitsFile, "org/api.yaml");
  assert.deepEqual(api.files, ["default.yaml", "org/api.yaml"]);

  const closed = grantOf(files, "org/closed");
  assert.equal(closed.allowDockerfile, false);
  assert.deepEqual(closed.hosts, ["pypi.org"]);
  assert.deepEqual(closed.limits, { cpus: "3", memory: "8g", pids: 2048 });

  // A repo without a file of its own: default.yaml alone.
  const other = grantOf(files, "elsewhere/any");
  assert.deepEqual([other.allowDockerfile, other.allowPreview], [true, false]);
  assert.deepEqual(other.mounts, []);
  assert.equal(other.limitsFile, "default.yaml");
  assert.deepEqual(other.files, ["default.yaml"]);
});

test("a folder of several owners and repos, matched case-insensitively", (t) => {
  const { config: c } = folder(t, {
    "default.yaml": "allow_dockerfile: true\n",
    "acme/api.yaml": "hosts: [api.example.com]\n",
    "acme/Web.yaml": "hosts: [web.example.com]\n",
    "Globex/tools.yaml": "allow_preview: true\n",
    "README.md": "# Who owns what",
    CODEOWNERS: "acme/ @acme/platform\n",
    ".git/config": "[core]\n",
    ".github/notes.yaml": "not: a grant\n",
    "acme/notes.txt": "skipped",
  });
  const grants = loadGrants(c);
  assert.deepEqual(grantFor(grants, c, "ACME/api").hosts, ["api.example.com"]);
  assert.deepEqual(grantFor(grants, c, "acme/web").hosts, ["web.example.com"]);
  assert.equal(grantFor(grants, c, "globex/Tools").allowPreview, true);
  assert.equal(grantFor(grants, c, "globex/tools").allowDockerfile, true);
  assert.deepEqual(grantFor(grants, c, "acme/other").files, ["default.yaml"]);
  assert.deepEqual(grantErrors(grants), []);
});

test("a broken repo file stops that repo only, naming the file", (t) => {
  const { config: c } = folder(t, {
    "default.yaml": "hosts: [pypi.org]\n",
    "acme/api.yaml": "hosts: [bad host]\nlimits: { memory: lots }\n",
    "acme/web.yaml": "allow_preview: true\n",
  });
  const grants = loadGrants(c);
  assert.throws(
    () => grantFor(grants, c, "acme/api"),
    (error) =>
      error instanceof GrantsError &&
      error.file === "acme/api.yaml" &&
      /^grants: acme\/api\.yaml: hosts: "bad host": .*; limits\.memory: expected an amount/.test(
        error.message,
      ),
  );
  assert.equal(grantFor(grants, c, "acme/web").allowPreview, true);
  assert.deepEqual(grantFor(grants, c, "globex/any").hosts, ["pypi.org"]);
  // What the listener says at start, without refusing to.
  assert.deepEqual(
    grantErrors(grants).map((e) => e.file),
    ["acme/api.yaml"],
  );
});

test("each repo file's errors, one list per file", () => {
  const bad = (text, pattern) =>
    assert.throws(() => grantOf({ "org/repo.yaml": text }, "org/repo"), pattern);
  bad("hosts: [bad host]\n", /org\/repo\.yaml: hosts: "bad host"/);
  bad("cached_hosts: [bad host]\n", /org\/repo\.yaml: cached_hosts: "bad host": expected a host/);
  bad("cached_hosts: deb.debian.org\n", /cached_hosts: expected a list of host names/);
  bad("mounts: [/nfs/../etc]\n", /plain absolute root/);
  bad("mounts: [relative]\n", /plain absolute root/);
  bad("limits: { memory: lots }\n", /org\/repo\.yaml: limits\.memory: expected an amount/);
  bad("limits: { disk: 1 }\n", /limits\.disk: unknown/);
  bad("network: host\n", /network: unknown \(hosts, cached_hosts, limits, mounts/);
  // Gone with a repo's own hosts: ignoring it would quietly take them away.
  bad("allow_repo_hosts: true\n", /allow_repo_hosts: gone, list the hosts .* under hosts here/);
  bad("allow_preview: 1\n", /allow_preview: expected true or false/);
  bad("- a\n", /org\/repo\.yaml: expected a mapping/);
  // The old single file's layout, copied as is.
  bad("org/repo:\n  hosts: [pypi.org]\n", /org\/repo: unknown/);
});

test("a broken default.yaml or a misplaced file stops every run", (t) => {
  const broken = (files, pattern, file = null) =>
    assert.throws(
      () => grantsFrom(files, config),
      (error) => error instanceof GrantsError && error.file === file && pattern.test(error.message),
    );
  broken(
    { "default.yaml": "allow_repo_hosts: false\n" },
    /default\.yaml: allow_repo_hosts: gone/,
    "default.yaml",
  );
  // mounts for every repo would be too broad to grant by accident.
  broken(
    { "default.yaml": "mounts: [/srv]\n" },
    /default\.yaml: mounts: only a repository's own/,
    "default.yaml",
  );
  broken(
    { "default.yaml": "hosts: [bad host]\n" },
    /default\.yaml: hosts: "bad host"/,
    "default.yaml",
  );
  broken(
    { "grants.yaml": "org/repo: {}\n" },
    /grants\.yaml: not a grant: expected default\.yaml or <owner>\/<repo>\.yaml/,
    "grants.yaml",
  );
  broken({ "acme/api/x.yaml": "" }, /acme\/api\/x\.yaml: not a grant/, "acme/api/x.yaml");
  broken({ "acme/api.yml": "" }, /name it \.yaml/, "acme/api.yml");
  broken({ "Default.yaml": "" }, /Default\.yaml: not a grant/, "Default.yaml");
  broken({ "ac me/api.yaml": "" }, /not a grant/, "ac me/api.yaml");
  broken(
    { "acme/api.yaml": "", "acme/API.yaml": "" },
    /acme\/API\.yaml: the same repository as acme\/api\.yaml/,
    "acme/API.yaml",
  );
  broken({ "Acme/api.yaml": "", "acme/api.yaml": "" }, /the same repository/, "acme/api.yaml");
  // Several files: no single one to name.
  broken({ "a.yaml": "", "default.yaml": "mounts: [/srv]\n" }, /a\.yaml: .*; default\.yaml: /);

  // The listener refuses to start: loadGrants() throws.
  const { config: c } = folder(t, {
    "default.yaml": "limits: { cpus: none }\n",
    "acme/api.yaml": "",
  });
  assert.throws(() => loadGrants(c), /default\.yaml: limits\.cpus/);
});

test("symlinks: followed inside the folder, an error leading outside it", (t) => {
  const outside = realpathSync(tempDir(t, "deckhand-outside-"));
  writeFileSync(join(outside, "api.yaml"), "allow_preview: true\n");
  mkdirSync(join(outside, "globex"));
  writeFileSync(join(outside, "globex", "tools.yaml"), "allow_preview: true\n");
  const { dir, config: c } = folder(t, { "acme/api.yaml": "hosts: [pypi.org]\n" });
  symlinkSync(join(dir, "acme", "api.yaml"), join(dir, "acme", "web.yaml"));
  symlinkSync(join(outside, "api.yaml"), join(dir, "acme", "leak.yaml"));
  symlinkSync(join(dir, "nowhere.yaml"), join(dir, "acme", "dangling.yaml"));
  symlinkSync(join(outside, "README.md"), join(dir, "README.md")); // not a grant: skipped
  const grants = loadGrants(c);
  assert.deepEqual(grantFor(grants, c, "acme/web").hosts, ["pypi.org"]);
  assert.throws(
    () => grantFor(grants, c, "acme/leak"),
    (e) =>
      e.file === "acme/leak.yaml" && /a symlink leading outside the grants folder/.test(e.message),
  );
  assert.throws(
    () => grantFor(grants, c, "acme/dangling"),
    /acme\/dangling\.yaml: a broken symlink/,
  );
  // An owner's folder leading outside: every run stops.
  symlinkSync(join(outside, "globex"), join(dir, "globex"));
  assert.throws(() => loadGrants(c), /globex: a symlink leading outside the grants folder/);
});

test("an edit applies to the next load, without a restart; a repo's file is read when asked for", (t) => {
  const { dir, config: c } = folder(t, {
    "default.yaml": "",
    "acme/api.yaml": "",
    "acme/web.yaml": "",
  });
  const texts = { "acme/api.yaml": "allow_preview: false\n" };
  const read = [];
  const reader = (path) => {
    const file = path.slice(dir.length + 1);
    read.push(file);
    return texts[file] ?? readFileSync(path, "utf8");
  };
  assert.equal(grantFor(loadGrants(c, reader), c, "acme/api").allowPreview, false);
  assert.deepEqual(read, ["default.yaml", "acme/api.yaml"]);
  texts["acme/api.yaml"] = "allow_preview: true\n";
  assert.equal(grantFor(loadGrants(c, reader), c, "acme/api").allowPreview, true);
  // An unreadable file stops its repo only.
  const denied = (path) => {
    if (path.endsWith("api.yaml")) throw Object.assign(new Error("denied"), { code: "EACCES" });
    return readFileSync(path, "utf8");
  };
  const grants = loadGrants(c, denied);
  assert.throws(() => grantFor(grants, c, "acme/api"), /acme\/api\.yaml: can't be read \(EACCES\)/);
  assert.deepEqual(grantFor(grants, c, "acme/web").files, ["default.yaml", "acme/web.yaml"]);
});

test("no grants folder: no grants; a file in its place is an error", (t) => {
  const none = { ...config, grantsDir: join(tmpdir(), "deckhand-no-such-folder") };
  assert.deepEqual(grantFor(loadGrants(none), none, "org/repo"), NOTHING);
  const { dir } = folder(t, { "grants.yaml": "" });
  const file = { ...config, grantsDir: join(dir, "grants.yaml") };
  assert.throws(() => loadGrants(file), /expected a folder/);
});

test("GRANTS_FILE is gone: the listener says so rather than drop its grants", () => {
  assert.throws(
    () => loadConfig({ ALLOWED_USERS: "a", GRANTS_FILE: "/etc/deckhand/grants.yaml" }),
    /GRANTS_FILE is gone: .* GRANTS_DIR/,
  );
  assert.throws(
    () => parseConfigFile("grants_file: /x.yaml\n", "config.yaml"),
    /grants_file: gone/,
  );
  assert.equal(config.grantsDir, "/etc/deckhand/grants");
  assert.equal(
    loadConfig({ ALLOWED_USERS: "a", GRANTS_DIR: "/srv/grants" }).grantsDir,
    "/srv/grants",
  );
});

test("a preview hook or a Dockerfile without its grant: one line each, naming the grant", () => {
  const settings = { preview: { command: "./preview.sh" }, dockerfile: "Dockerfile" };
  const none = grantOf({}, "org/repo");
  assert.deepEqual(ungranted(none, settings), [
    "preview: the operator's grants don't set `allow_preview: true` for this repository",
    "dockerfile: the operator's grants don't set `allow_dockerfile: true` for this repository",
  ]);
  const both = { ...none, allowPreview: true, allowDockerfile: true };
  assert.deepEqual(ungranted(both, settings), []);
  // Nothing asked, nothing missing.
  assert.deepEqual(ungranted(none, { preview: null, dockerfile: null }), []);
});

// Read-write mounts are checked from /, and the temp dir's own parents (/tmp, sticky) may
// let the tests' user rename it: they may run as uid 1000, the sandbox's user. So `stat`
// reads `dir` and what it holds, and shows what is above it as root's, not writable.
const ROOT_DIR = { mode: 0o40755, uid: 0, gid: 0 };
// Real modes under `dir`, owned by root: the tests may run as uid 1000, the sandbox's user,
// which would own (so could chmod) every directory they create.
const statUnder = (dir) => (path) =>
  path === dir || path.startsWith(`${dir}/`)
    ? { ...ROOT_DIR, mode: statSync(path).mode }
    : ROOT_DIR;

// A temp dir the test makes read-only in places: writable again before tempDir removes it (a
// test's after hooks run in the order they were added).
function lockedDir(t) {
  let dir;
  const writable = (path) => {
    chmodSync(path, 0o755);
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (entry.isDirectory()) writable(join(path, entry.name));
    }
  };
  t.after(() => writable(dir));
  dir = realpathSync(tempDir(t, "deckhand-grants-"));
  return dir;
}

// A root with a subfolder, a symlink inside it and one pointing out. The root and the temp
// dir are read-only for everyone (the tests may run as uid 1000, the sandbox's user), so its
// subfolders can be mounted read-write.
function tree(t) {
  const dir = lockedDir(t);
  mkdirSync(join(dir, "work", "api"), { recursive: true });
  mkdirSync(join(dir, "secret"));
  symlinkSync(join(dir, "work", "api"), join(dir, "work", "inside"));
  symlinkSync(join(dir, "secret"), join(dir, "work", "escape"));
  chmodSync(join(dir, "work"), 0o555);
  chmodSync(dir, 0o555);
  return dir;
}

test("mounts: subpaths of a granted root pass, after resolving .. and symlinks", (t) => {
  const dir = tree(t);
  const grant = { mounts: [{ root: join(dir, "work"), readOnly: false }] };
  const { mounts, refused } = resolveMounts(
    [
      { path: join(dir, "work", "api"), readOnly: false },
      { path: join(dir, "work"), readOnly: true },
      { path: join(dir, "work", "inside"), readOnly: true },
      { path: `${dir}/work/api/../api`, readOnly: true },
    ],
    grant,
    { stat: statUnder(dir) },
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

test("mounts: .., symlinks out, other paths and no grant are refused", (t) => {
  const dir = tree(t);
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
  assert.match(refusedFor("/deckhand/x"), /the sandbox uses \/deckhand itself/);
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

test("mounts: read-only unless the operator grants read-write; a repo can only narrow", (t) => {
  const dir = tree(t);
  const path = join(dir, "work", "api");
  const ro = resolveMounts([{ path, readOnly: false }], {
    mounts: [{ root: join(dir, "work"), readOnly: true }],
  });
  assert.equal(ro.mounts[0].readOnly, true);
  assert.match(ro.notes[0], /mounted read-only: the operator grants \S+ read-only/);
  const rw = { mounts: [{ root: join(dir, "work"), readOnly: false }] };
  const fs = { stat: statUnder(dir) };
  assert.equal(resolveMounts([{ path, readOnly: true }], rw, fs).mounts[0].readOnly, true);
  assert.equal(resolveMounts([{ path, readOnly: false }], rw, fs).mounts[0].readOnly, false);
});

test("mounts: read-write refused when the sandbox's user can rewrite a directory on the way", (t) => {
  const dir = lockedDir(t);
  const root = join(dir, "work");
  mkdirSync(join(root, "team", "api", "src"), { recursive: true });
  chmodSync(dir, 0o555);
  chmodSync(root, 0o555);
  chmodSync(join(root, "team"), 0o777); // anyone, so uid 1000 too
  chmodSync(join(root, "team", "api"), 0o777); // the mount itself may be writable
  const stat = statUnder(dir);
  const grant = { mounts: [{ root, readOnly: false }] };
  const resolve = (path, readOnly = false) => resolveMounts([{ path, readOnly }], grant, { stat });
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
  // A narrower root inside a wider one: checked above the narrower one too.
  chmodSync(join(root, "team"), 0o555);
  chmodSync(root, 0o777);
  const nested = {
    mounts: [
      { root: join(root, "team"), readOnly: false },
      { root, readOnly: true },
    ],
  };
  const refusedFor = (g, path) => resolveMounts([{ path, readOnly: false }], g, { stat }).refused;
  assert.match(
    refusedFor(nested, join(root, "team", "api"))[0],
    /can write `\S+\/work` on its way/,
  );
  // Above every root this repo has: another repo's root, or none at all, may hold it.
  const own = { mounts: [{ root: join(root, "team"), readOnly: false }] };
  assert.match(refusedFor(own, join(root, "team", "api"))[0], /can write `\S+\/work` on its way/);
  assert.match(refusedFor(own, join(root, "team"))[0], /can write `\S+\/work` on its way/);
  chmodSync(root, 0o555);
  assert.deepEqual(refusedFor(own, join(root, "team", "api")), []);
  // The temp dir's own parents count too, read for real: /tmp is sticky, so only an entry
  // the sandbox's user owns (the tests' own, when they run as uid 1000) can be swapped.
  const real = resolveMounts([{ path: join(root, "team"), readOnly: false }], own).refused;
  assert.equal(real.length, statSync(dir).uid === 1000 ? 1 : 0);
});

// The issue's layout, with an injected stat: repo A is granted /nfs/work/api read-write, repo
// B /nfs/work, which uid 1000 can write. B's sandbox could rename /nfs/work/api and put a
// symlink to / in its place, so A's read-write mounts are refused.
test("mounts: a directory another repo's root lets a sandbox write is refused on the way", () => {
  const modes = new Map([["/nfs/work", { mode: 0o40755, uid: 1000, gid: 1000 }]]);
  const fs = { realpath: (p) => p, stat: (p) => modes.get(p) ?? ROOT_DIR };
  const a = { mounts: [{ root: "/nfs/work/api", readOnly: false }] };
  const refusedFor = (path) => resolveMounts([{ path, readOnly: false }], a, fs).refused;
  assert.match(refusedFor("/nfs/work/api")[0], /can write `\/nfs\/work` on its way/);
  assert.match(refusedFor("/nfs/work/api/src")[0], /can write `\/nfs\/work` on its way/);
  // Read-only: not checked this way. Owned by uid 1000 but read-only: it can chmod it back.
  assert.deepEqual(resolveMounts([{ path: "/nfs/work/api", readOnly: true }], a, fs).refused, []);
  modes.set("/nfs/work", { mode: 0o40555, uid: 1000, gid: 1000 });
  assert.match(refusedFor("/nfs/work/api/src")[0], /can write `\/nfs\/work` on its way/);
  // Owned by another user and read-only for uid 1000: accepted.
  modes.set("/nfs/work", { mode: 0o40555, uid: 0, gid: 1000 });
  assert.deepEqual(refusedFor("/nfs/work/api/src"), []);
  // Higher up too: anything from / on the way.
  modes.set("/nfs", { mode: 0o40777, uid: 0, gid: 0 });
  assert.match(refusedFor("/nfs/work/api")[0], /can write `\/nfs` on its way/);
});

test("mounts: writable by uid 1000 as owner (write bit or not), group 1000 or anyone", () => {
  const modes = new Map();
  const stat = (path) => modes.get(path) ?? ROOT_DIR;
  const grant = { mounts: [{ root: "/nfs", readOnly: false }] };
  const refusedWith = (parent, child = ROOT_DIR) => {
    modes.clear();
    modes.set("/nfs/team", parent);
    modes.set("/nfs/team/api", child);
    return resolveMounts([{ path: "/nfs/team/api", readOnly: false }], grant, {
      realpath: (p) => p,
      stat,
    }).refused.length;
  };
  assert.equal(refusedWith({ mode: 0o755, uid: 1000, gid: 0 }), 1);
  assert.equal(refusedWith({ mode: 0o555, uid: 1000, gid: 0 }), 1); // its owner can chmod it
  assert.equal(refusedWith({ mode: 0o775, uid: 0, gid: 1000 }), 1);
  assert.equal(refusedWith({ mode: 0o755, uid: 0, gid: 1000 }), 0);
  assert.equal(refusedWith({ mode: 0o777, uid: 0, gid: 0 }), 1);
  assert.equal(refusedWith({ mode: 0o775, uid: 1001, gid: 1001 }), 0);
  // Sticky (/tmp): only the directory's owner or the entry's can rename the entry.
  assert.equal(refusedWith({ mode: 0o1777, uid: 0, gid: 0 }), 0);
  assert.equal(refusedWith({ mode: 0o1777, uid: 0, gid: 0 }, { ...ROOT_DIR, uid: 1000 }), 1);
  assert.equal(refusedWith({ mode: 0o1777, uid: 1000, gid: 0 }), 1);
  assert.equal(refusedWith({ mode: 0o1555, uid: 1000, gid: 0 }), 1);
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

test("allow_workflows: a repository's own file only", () => {
  const own = { "org/repo.yaml": "allow_workflows: true\n" };
  assert.equal(grantOf(own, "org/repo").allowWorkflows, true);
  assert.equal(grantOf(own, "org/other").allowWorkflows, false);
  // Workflow files run with the repo's Actions secrets: never every repo at once.
  assert.throws(
    () => grantsFrom({ "default.yaml": "allow_workflows: true\n" }, config),
    (error) =>
      error instanceof GrantsError &&
      error.file === "default.yaml" &&
      /default\.yaml: allow_workflows: only a repository's own file grants it/.test(error.message),
  );
  assert.throws(
    () => grantOf({ "org/repo.yaml": "allow_workflows: 1\n" }, "org/repo"),
    /allow_workflows: expected true or false/,
  );
});

test("allow_auto_merge: a repository's own file only, true or public", () => {
  const own = {
    "org/repo.yaml": "allow_auto_merge: true\n",
    "org/pub.yaml": "allow_auto_merge: public\n",
  };
  assert.equal(grantOf(own, "org/repo").allowAutoMerge, true);
  assert.equal(grantOf(own, "org/pub").allowAutoMerge, "public");
  assert.equal(grantOf(own, "org/other").allowAutoMerge, false);
  assert.deepEqual(autoMergeGrants(grantsFrom(own, config)), [
    { repo: "org/repo", value: true },
    { repo: "org/pub", value: "public" },
  ]);
  // Model output on the default branch with no human reading it: never every repo at once.
  assert.throws(
    () => grantsFrom({ "default.yaml": "allow_auto_merge: true\n" }, config),
    (error) =>
      error instanceof GrantsError &&
      error.file === "default.yaml" &&
      /default\.yaml: allow_auto_merge: only a repository's own file grants it/.test(error.message),
  );
  assert.throws(
    () => grantOf({ "org/repo.yaml": "allow_auto_merge: yes-please\n" }, "org/repo"),
    /allow_auto_merge: expected true, false or public/,
  );
});

test("autoMergeProblems: the grant, the repository's visibility and `review.on: ready`", () => {
  const review = { on: "ready", fix: true, merge: true, mergeMethod: "squash" };
  const settings = { review };
  assert.deepEqual(autoMergeProblems({ allowAutoMerge: true }, settings, true), []);
  assert.deepEqual(autoMergeProblems({ allowAutoMerge: "public" }, settings, false), []);
  // Off: nothing to say.
  assert.deepEqual(autoMergeProblems({}, { review: { ...review, merge: false } }), []);
  assert.match(
    autoMergeProblems({ allowAutoMerge: false }, settings, true)[0],
    /allow_auto_merge: true/,
  );
  assert.match(autoMergeProblems(null, settings)[0], /allow_auto_merge: true/);
  assert.match(autoMergeProblems({ allowAutoMerge: true }, settings, false)[0], /public/);
  // Unknown visibility: the merge checks it.
  assert.deepEqual(autoMergeProblems({ allowAutoMerge: true }, settings, null), []);
  assert.match(
    autoMergeProblems({ allowAutoMerge: true }, { review: { ...review, on: "manual" } })[0],
    /review\.on: ready/,
  );
});

test("allow_docker: a repository's own file only, and `docker` without it is refused", () => {
  assert.equal(grantOf({ "org/repo.yaml": "allow_docker: true\n" }, "org/repo").allowDocker, true);
  assert.equal(
    grantOf({ "org/other.yaml": "allow_docker: true\n" }, "org/repo").allowDocker,
    false,
  );
  // An engine for every repository would be too broad to grant by accident.
  assert.throws(
    () => grantsFrom({ "default.yaml": "allow_docker: true\n" }, config),
    (error) =>
      error instanceof GrantsError &&
      /default\.yaml: allow_docker: only a repository's own file grants it/.test(error.message),
  );
  assert.throws(
    () => grantOf({ "org/repo.yaml": "allow_docker: yes please\n" }, "org/repo"),
    /allow_docker: expected true or false/,
  );
  const none = grantOf({}, "org/repo");
  const settings = { preview: null, dockerfile: null, docker: { cache: false } };
  assert.deepEqual(ungranted(none, settings), [
    "docker: the operator's grants don't set `allow_docker: true` for this repository",
  ]);
  assert.deepEqual(ungranted({ ...none, allowDocker: true }, settings), []);
});

test("server.example/grants is a valid grants folder that grants nothing", () => {
  const dir = new URL("../server.example/grants", import.meta.url).pathname;
  const config = testConfig({ ALLOWED_USERS: "a", GRANTS_DIR: dir });
  const grants = loadGrants(config);
  assert.deepEqual(grantErrors(grants), []);
  const grant = grantFor(grants, config, "your-org/your-repo");
  assert.deepEqual(grant.hosts, []);
  assert.equal(grant.allowPreview, false);
});
