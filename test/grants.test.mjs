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
  ANY_REPO,
  autoMergeFiles,
  autoMergeProblems,
  grantCheck,
  GRANTS,
  GrantsError,
  grantErrors,
  grantFields,
  grantFor,
  grantOf as grantWithPolicies,
  grantsFrom,
  loadGrants,
  NO_GRANTS,
  previewProblem,
  REPO_ONLY,
  resolveMounts,
  ungranted,
  withGrants,
} from "../listener/grants.mjs";
import { defaultPolicies, grantedOf, hasOpa, tempDir, testConfig } from "./helpers.mjs";
import { operatorPolicies, rulesOf } from "../lib/policy-files.mjs";
import { builtInPolicies } from "../policy-service/engine.mjs";

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
  acknowledgeAutoMergePreview: false,
  grantFiles: [],
  mounts: [],
  allowProjects: [],
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
    acknowledgeAutoMergePreview: false,
    grantFiles: [],
    allowProjects: [],
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

test("allow_projects: a repo's own file lists <organization>/<number>, never default.yaml", () => {
  const files = { "org/repo.yaml": "allow_projects: [Acme/3, acme/3, acme/12]\n" };
  assert.deepEqual(grantOf(files, "org/repo").allowProjects, ["acme/3", "acme/12"]);
  assert.deepEqual(grantOf(files, "org/other").allowProjects, []);
  for (const bad of ["acme", "acme/0", "acme/x", "-acme/3", "a/b/3", 3]) {
    const text = `allow_projects: [${JSON.stringify(bad)}]\n`;
    assert.throws(
      () => grantOf({ "org/repo.yaml": text }, "org/repo"),
      /allow_projects: .*expected <organization>\/<number>/,
      String(bad),
    );
  }
  assert.throws(
    () => grantOf({ "org/repo.yaml": "allow_projects: acme/3\n" }, "org/repo"),
    /allow_projects: expected a list/,
  );
  assert.throws(
    () => grantOf({ "default.yaml": "allow_projects: [acme/3]\n" }, "org/repo"),
    /allow_projects: only a repository's own file grants projects/,
  );
});

test("default.yaml: hosts added, limits as the base", () => {
  const files = {
    "default.yaml": `hosts: [pypi.org]
limits: { memory: 8g, cpus: 3 }
`,
    "org/closed.yaml": "cached_hosts: [pypi.org]\n",
    "org/api.yaml": "hosts: [files.example.com, pypi.org]\nlimits: { cpus: 4 }\n",
  };
  const api = grantOf(files, "Org/API");
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
  assert.deepEqual(closed.cachedHosts, ["pypi.org"]);
  assert.deepEqual(closed.hosts, ["pypi.org"]);
  assert.deepEqual(closed.limits, { cpus: "3", memory: "8g", pids: 2048 });

  // A repo without a file of its own: default.yaml alone.
  const other = grantOf(files, "elsewhere/any");
  assert.deepEqual(other.hosts, ["pypi.org"]);
  assert.deepEqual(other.mounts, []);
  assert.equal(other.limitsFile, "default.yaml");
  assert.deepEqual(other.files, ["default.yaml"]);
});

test("a folder of several owners and repos, matched case-insensitively", (t) => {
  const { config: c } = folder(t, {
    "default.yaml": "hosts: [pypi.org]\n",
    "acme/api.yaml": "hosts: [api.example.com]\n",
    "acme/Web.yaml": "hosts: [web.example.com]\n",
    "Globex/tools.yaml": "cached_hosts: [pypi.org]\n",
    "README.md": "# Who owns what",
    CODEOWNERS: "acme/ @acme/platform\n",
    ".git/config": "[core]\n",
    ".github/notes.yaml": "not: a grant\n",
    "acme/notes.txt": "skipped",
  });
  const grants = loadGrants(c);
  assert.deepEqual(grantFor(grants, c, "ACME/api").hosts, ["pypi.org", "api.example.com"]);
  assert.deepEqual(grantFor(grants, c, "acme/web").hosts, ["pypi.org", "web.example.com"]);
  assert.deepEqual(grantFor(grants, c, "globex/Tools").cachedHosts, ["pypi.org"]);
  assert.deepEqual(grantFor(grants, c, "globex/tools").files, [
    "default.yaml",
    "Globex/tools.yaml",
  ]);
  assert.deepEqual(grantFor(grants, c, "acme/other").files, ["default.yaml"]);
  assert.deepEqual(grantErrors(grants), []);
});

test("a broken repo file stops that repo only, naming the file", (t) => {
  const { config: c } = folder(t, {
    "default.yaml": "hosts: [pypi.org]\n",
    "acme/api.yaml": "hosts: [bad host]\nlimits: { memory: lots }\n",
    "acme/web.yaml": "cached_hosts: [pypi.org]\n",
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
  assert.deepEqual(grantFor(grants, c, "acme/web").cachedHosts, ["pypi.org"]);
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
  // Moved to the operator's policies (#498): what to write instead, with the repo's name.
  bad(
    "allow_preview: true\n",
    /allow_preview: moved to the operator's policies \(#498\): `allow_grant if \{ input\.repo\.name == "org\/repo"; input\.grant == "preview" \}` in policy\/ of the grants folder/,
  );
  bad(
    "allow_auto_merge: public\n",
    /`allow_grant if \{ input\.repo\.name == "org\/repo"; input\.grant == "auto_merge_public" \}`/,
  );
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
  writeFileSync(join(outside, "api.yaml"), "hosts: [pypi.org]\n");
  mkdirSync(join(outside, "globex"));
  writeFileSync(join(outside, "globex", "tools.yaml"), "hosts: [pypi.org]\n");
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
  const texts = { "acme/api.yaml": "hosts: [a.example.com]\n" };
  const read = [];
  const reader = (path) => {
    const file = path.slice(dir.length + 1);
    read.push(file);
    return texts[file] ?? readFileSync(path, "utf8");
  };
  assert.deepEqual(grantFor(loadGrants(c, reader), c, "acme/api").hosts, ["a.example.com"]);
  assert.deepEqual(read, ["default.yaml", "acme/api.yaml"]);
  texts["acme/api.yaml"] = "hosts: [b.example.com]\n";
  assert.deepEqual(grantFor(loadGrants(c, reader), c, "acme/api").hosts, ["b.example.com"]);
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
    "preview: the operator's policies don't grant `preview` to this repository (`allow_grant`)",
    "dockerfile: the operator's policies don't grant `dockerfile` to this repository (`allow_grant`)",
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
  assert.match(refusedFor("/tmp/deckhand/x"), /the sandbox uses \/tmp\/deckhand itself/);
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

test("the yes-or-no grants: the operator's policies', each a field of the grant (#498)", () => {
  // Every grant sets a field nothing else does but auto-merge's two.
  assert.deepEqual(Object.keys(GRANTS).sort(), [
    "acknowledge_automerge_and_preview_is_highly_dangerous",
    "auto_merge",
    "auto_merge_public",
    "branch_docker_images",
    "docker",
    "dockerfile",
    "preview",
    "research",
    "workflows",
  ]);
  assert.deepEqual(grantFields(new Set()), NO_GRANTS);
  assert.deepEqual(grantFields(new Set(["docker", "preview"])), {
    ...NO_GRANTS,
    allowDocker: true,
    allowPreview: true,
  });
  // `auto_merge_public`: a public repository too, whether `auto_merge` is given or not.
  assert.equal(grantFields(new Set(["auto_merge"])).allowAutoMerge, true);
  assert.equal(grantFields(new Set(["auto_merge_public"])).allowAutoMerge, "public");
  assert.equal(grantFields(new Set(["auto_merge", "auto_merge_public"])).allowAutoMerge, "public");
  // A name nobody knows grants nothing.
  assert.deepEqual(grantFields(new Set(["everything"])), NO_GRANTS);
  // Those given one repository at a time: an engine, workflows, auto-merge.
  assert.deepEqual([...REPO_ONLY].sort(), [
    "acknowledge_automerge_and_preview_is_highly_dangerous",
    "auto_merge",
    "auto_merge_public",
    "docker",
    "workflows",
  ]);
  assert.match(ANY_REPO, /^[^\w]+\/[^\w]+$/);
  const grant = grantOf({ "org/repo.yaml": "hosts: [pypi.org]\n" }, "org/repo");
  const said = { granted: new Set(["workflows"]), files: ["grants.rego"], denied: [] };
  assert.deepEqual(withGrants(grant, said), {
    ...grant,
    allowWorkflows: true,
    grantFiles: ["grants.rego"],
  });
  assert.equal(withGrants(grant, null), grant);
});

test("grantOf: the folder's grant with what the policies grant; their failure a GrantsError", async () => {
  const load = () => grantsFrom({ "org/repo.yaml": "hosts: [pypi.org]\n" }, config);
  const granted = grantedOf(["docker", "auto_merge"], "org/repo");
  const repo = await grantWithPolicies(config, "Org/Repo", { load, granted });
  assert.deepEqual([repo.hosts, repo.allowDocker, repo.allowAutoMerge], [["pypi.org"], true, true]);
  const other = await grantWithPolicies(config, "org/other", { load, granted });
  assert.equal(other.allowDocker, false);
  // No policies: nothing granted (fail closed).
  assert.equal((await grantWithPolicies(config, "org/repo", { load })).allowDocker, false);
  await assert.rejects(
    grantWithPolicies(config, "org/repo", {
      load,
      granted: async () => ({ error: "policy error: opa didn't answer" }),
    }),
    (error) =>
      error instanceof GrantsError &&
      error.file === null &&
      /the operator's policies can't decide org\/repo's: policy error: opa didn't answer/.test(
        error.message,
      ),
  );
  // A grants file with errors: no grant, whatever the policies say (the git gateway's
  // `workflows` included, server.mjs: it takes the throw for no).
  await assert.rejects(
    grantWithPolicies(config, "org/repo", {
      load: () => grantsFrom({ "org/repo.yaml": "hosts: [bad host]\n" }, config),
      granted: grantedOf(["workflows"]),
    }),
    (error) => error instanceof GrantsError && error.file === "org/repo.yaml",
  );
  // grantCheck() says it as a broken grants file: no run starts.
  const check = await grantCheck(
    config,
    "org/repo",
    { mounts: [], docker: { cache: false } },
    { load, granted: async () => ({ error: "x" }) },
  );
  assert.ok(check.error instanceof GrantsError);
  const ok = await grantCheck(
    config,
    "org/repo",
    { mounts: [], docker: { cache: false } },
    { load, granted },
  );
  assert.deepEqual(ok.missing, []);
});

test("each grant's former key is an error saying what to write, in default.yaml too", () => {
  const keys = {
    allow_preview: "preview",
    allow_dockerfile: "dockerfile",
    allow_branch_docker_images: "branch_docker_images",
    allow_docker: "docker",
    allow_research: "research",
    allow_workflows: "workflows",
    allow_auto_merge: "auto_merge",
    acknowledge_automerge_and_preview_is_highly_dangerous:
      "acknowledge_automerge_and_preview_is_highly_dangerous",
  };
  for (const [key, name] of Object.entries(keys)) {
    assert.throws(
      () => grantOf({ "org/repo.yaml": `${key}: true\n` }, "org/repo"),
      (error) =>
        error instanceof GrantsError &&
        error.file === "org/repo.yaml" &&
        error.message.includes(
          `${key}: moved to the operator's policies (#498): \`allow_grant if { input.repo.name == "org/repo"; input.grant == "${name}" }\``,
        ),
      key,
    );
    // `false` granted nothing: the key goes, never a rule that would grant it. A repository's own
    // file is told how to keep out a grant its policies give every repository.
    for (const file of ["default.yaml", "org/repo.yaml"]) {
      const said = (() => {
        try {
          grantFor(grantsFrom({ [file]: `${key}: false\n` }, config), config, "org/repo");
        } catch (error) {
          return error.message;
        }
        return "";
      })();
      assert.match(said, new RegExp(`${key}: gone \\(#498\\), remove it: nothing is granted`), key);
      assert.doesNotMatch(said, /allow_grant/, `${key} in ${file}`);
      assert.equal(said.includes("deny_grant"), file !== "default.yaml", `${key} in ${file}`);
    }
    // `true` in default.yaml: a rule for every repository, but for what was only ever a
    // repository's own to grant, which never was valid there.
    const wide = (() => {
      try {
        grantsFrom({ "default.yaml": `${key}: true\n` }, config);
      } catch (error) {
        return error.message;
      }
      return "";
    })();
    if (REPO_ONLY.has(name)) {
      assert.match(
        wide,
        /never valid in default\.yaml: grant `[\w]+` one repository at a time/,
        key,
      );
      assert.ok(
        wide.includes(`input.repo.name == "<owner>/<repo>"; input.grant == "${name}"`),
        key,
      );
    } else {
      assert.ok(wide.includes(`\`allow_grant if { input.grant == "${name}" }\``), key);
    }
  }
});

test("autoMergeFiles: the operator's policy files that name an auto-merge grant", () => {
  const files = new Map([
    ["grants.rego", 'package deckhand\n\nallow_grant if {\n  input.grant in {"auto_merge"}\n}\n'],
    ["public.rego", 'package deckhand\n\nallow_grant if input.grant == "auto_merge_public"\n'],
    ["docker.rego", 'package deckhand\n\nallow_grant if input.grant == "docker"\n'],
    ["note.rego", '# "auto_merge" is off here\npackage deckhand\n'],
  ]);
  assert.deepEqual(autoMergeFiles(files), ["grants.rego", "public.rego"]);
});

test("acknowledge_automerge_and_preview_is_highly_dangerous: what it lets through", () => {
  const key = "acknowledge_automerge_and_preview_is_highly_dangerous";
  const settings = {
    review: { on: "ready", merge: true },
    preview: { command: "./x.sh" },
  };
  const grant = { allowAutoMerge: true, allowPreview: true };
  assert.equal(previewProblem(grant, settings).includes(key), true);
  assert.match(
    autoMergeProblems(grant, settings, true)[0],
    new RegExp(`don't grant \`${key}\` to this repository \\(\`allow_grant\`\\), nothing`),
  );
  // The merge's gates say it themselves.
  assert.deepEqual(autoMergeProblems(grant, settings, true, { preview: false }), []);
  assert.equal(previewProblem({ ...grant, acknowledgeAutoMergePreview: true }, settings), null);
  // A hook that isn't granted never runs: nothing to acknowledge.
  assert.equal(previewProblem({ allowAutoMerge: true }, settings), null);
  assert.equal(previewProblem(grant, { review: settings.review }), null);
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
    /don't grant `auto_merge`/,
  );
  assert.match(autoMergeProblems(null, settings)[0], /don't grant `auto_merge`/);
  assert.match(
    autoMergeProblems({ allowAutoMerge: true }, settings, false)[0],
    /public and the operator's policies grant it `auto_merge`, not `auto_merge_public`/,
  );
  // Unknown visibility: the merge checks it.
  assert.deepEqual(autoMergeProblems({ allowAutoMerge: true }, settings, null), []);
  assert.match(
    autoMergeProblems({ allowAutoMerge: true }, { review: { ...review, on: "manual" } })[0],
    /review\.on: ready/,
  );
});

test("`docker` without its grant is refused", () => {
  const none = grantOf({}, "org/repo");
  const settings = { preview: null, dockerfile: null, docker: { cache: false } };
  assert.deepEqual(ungranted(none, settings), [
    "docker: the operator's policies don't grant `docker` to this repository (`allow_grant`)",
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
  // Its policy/grants.rego: comments and the package, no rule.
  const policies = operatorPolicies(dir);
  assert.deepEqual([...policies.keys()], ["grants.rego"]);
  assert.deepEqual(rulesOf(policies.get("grants.rego")), []);
});

test(
  "the real opa: server.example's grants.rego, uncommented, grants its repository what it says",
  { skip: !hasOpa() && "no opa on the PATH" },
  async (t) => {
    const text = readFileSync(
      new URL("../server.example/grants/policy/grants.rego", import.meta.url),
      "utf8",
    );
    const uncommented = text.replace(/^# (allow_grant|  |\})/gm, "$1");
    assert.deepEqual(rulesOf(uncommented), ["allow_grant"]);
    const policies = defaultPolicies(t, {
      builtIn: new Map([...builtInPolicies(), ["grants.rego", uncommented]]),
    });
    const said = await policies.grants("Your-Org/Your-Repo");
    assert.deepEqual([...said.granted].sort(), [
      "branch_docker_images",
      "docker",
      "dockerfile",
      "preview",
      "research",
      "workflows",
    ]);
    assert.deepEqual(said.denied, []);
    assert.deepEqual([...(await policies.grants("your-org/other")).granted], []);
  },
);
