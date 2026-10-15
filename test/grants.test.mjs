import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { loadConfig, parseConfigFile } from "../listener/config.mjs";
import {
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

const config = loadConfig({ ALLOWED_USERS: "a", SANDBOX_MEMORY: "2g" });

// What one repo gets from a grants folder given as { "path/in/it.yaml": text }.
const grantOf = (files, repo) => grantFor(grantsFrom(files, config), config, repo);

// A grants folder on disk: { "path/in/it": text }, and the config reading it.
function folder(files) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "deckhand-grants-dir-")));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return { dir, config: { ...config, grantsDir: dir } };
}

const NOTHING = {
  hosts: [],
  allowRepoHosts: false,
  allowPreview: false,
  allowDockerfile: false,
  allowBranchDockerImages: false,
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
    allowRepoHosts: false,
    allowPreview: false,
    allowDockerfile: false,
    allowBranchDockerImages: false,
    limits: { cpus: "4", memory: "2g", pids: 4096 },
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
    "default.yaml": `allow_repo_hosts: true
allow_dockerfile: true
hosts: [pypi.org]
limits: { memory: 8g, cpus: 3 }
`,
    "org/closed.yaml": "allow_repo_hosts: false\nallow_dockerfile: false\n",
    "org/api.yaml":
      "hosts: [files.example.com, pypi.org]\nlimits: { cpus: 4 }\nallow_preview: true\n",
  };
  const api = grantOf(files, "Org/API");
  assert.deepEqual(
    [api.allowRepoHosts, api.allowDockerfile, api.allowPreview, api.allowBranchDockerImages],
    [true, true, true, false],
  );
  assert.deepEqual(api.hosts, ["pypi.org", "files.example.com"]);
  assert.deepEqual(api.hostFiles, {
    "pypi.org": "default.yaml",
    "files.example.com": "org/api.yaml",
  });
  // Its own cpus over default.yaml's memory, over SANDBOX_*.
  assert.deepEqual(api.limits, { cpus: "4", memory: "8g", pids: 2048 });
  assert.equal(api.limitsFile, "org/api.yaml");
  assert.deepEqual(api.files, ["default.yaml", "org/api.yaml"]);

  const closed = grantOf(files, "org/closed");
  assert.deepEqual([closed.allowRepoHosts, closed.allowDockerfile], [false, false]);
  assert.deepEqual(closed.hosts, ["pypi.org"]);
  assert.deepEqual(closed.limits, { cpus: "3", memory: "8g", pids: 2048 });

  // A repo without a file of its own: default.yaml alone.
  const other = grantOf(files, "elsewhere/any");
  assert.deepEqual([other.allowRepoHosts, other.allowPreview], [true, false]);
  assert.deepEqual(other.mounts, []);
  assert.equal(other.limitsFile, "default.yaml");
  assert.deepEqual(other.files, ["default.yaml"]);
});

test("a folder of several owners and repos, matched case-insensitively", () => {
  const { config: c } = folder({
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

test("a broken repo file stops that repo only, naming the file", () => {
  const { config: c } = folder({
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
  bad("mounts: [/nfs/../etc]\n", /plain absolute root/);
  bad("mounts: [relative]\n", /plain absolute root/);
  bad("limits: { memory: lots }\n", /org\/repo\.yaml: limits\.memory: expected an amount/);
  bad("limits: { disk: 1 }\n", /limits\.disk: unknown/);
  bad("network: host\n", /network: unknown/);
  bad("allow_repo_hosts: yes\n", /allow_repo_hosts: expected true or false/);
  bad("allow_preview: 1\n", /allow_preview: expected true or false/);
  bad("- a\n", /org\/repo\.yaml: expected a mapping/);
  // The old single file's layout, copied as is.
  bad("org/repo:\n  hosts: [pypi.org]\n", /org\/repo: unknown/);
});

test("a broken default.yaml or a misplaced file stops every run", () => {
  const broken = (files, pattern, file = null) =>
    assert.throws(
      () => grantsFrom(files, config),
      (error) => error instanceof GrantsError && error.file === file && pattern.test(error.message),
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
  const { config: c } = folder({ "default.yaml": "limits: { cpus: none }\n", "acme/api.yaml": "" });
  assert.throws(() => loadGrants(c), /default\.yaml: limits\.cpus/);
});

test("symlinks: followed inside the folder, an error leading outside it", () => {
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "deckhand-outside-")));
  writeFileSync(join(outside, "api.yaml"), "allow_preview: true\n");
  mkdirSync(join(outside, "globex"));
  writeFileSync(join(outside, "globex", "tools.yaml"), "allow_preview: true\n");
  const { dir, config: c } = folder({ "acme/api.yaml": "hosts: [pypi.org]\n" });
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

test("an edit applies to the next load, without a restart; a repo's file is read when asked for", () => {
  const { dir, config: c } = folder({
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

test("no grants folder: no grants; a file in its place is an error", () => {
  const none = { ...config, grantsDir: join(tmpdir(), "deckhand-no-such-folder") };
  assert.deepEqual(grantFor(loadGrants(none), none, "org/repo"), NOTHING);
  const { dir } = folder({ "grants.yaml": "" });
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
