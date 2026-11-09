// The size ratchet (#1065): a code file over 800 lines (1,500 for a test) can't grow. Agents add
// to the file they are already in and nothing else pushes back, so each file over its threshold
// is held to its size on the base branch: no committed numbers, which every parallel pull request
// touching a big file would rewrite, and conflict on. A file that really can't be split gets an
// entry in test/file-sizes.json, its ceiling, which says why ({ "lines": 900, "why": "#1234" }).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { posix, tempDir } from "./helpers.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const EXCEPTIONS = "test/file-sizes.json";
export const LIMITS = { code: 800, tests: 1500 };

// The code files: not graphql-js's bundle, nor what isn't code (lockfiles, the GraphQL schema,
// the Grafana JSON, YAML).
const CODE = /\.(mjs|js|ts|tsx|rego|sh|css)$/;
const covered = (path) => CODE.test(path) && !path.startsWith("listener/vendor/");
const isTest = (path) => path.startsWith("test/") || /\.spec\.tsx?$/.test(path);
const limitOf = (path, limits) => (isTest(path) ? limits.tests : limits.code);
const kindOf = (path) => (isTest(path) ? "test" : "code file");

// Lines as `wc -l` counts them, plus a last one without its newline.
export function countLines(buffer) {
  let n = 0;
  for (const byte of buffer) if (byte === 0x0a) n++;
  return buffer.length && buffer.at(-1) !== 0x0a ? n + 1 : n;
}

// git in `cwd`, without the GIT_* variables a hook running the suite would pass on: GIT_DIR
// would point every call at that repository.
function git(cwd, args, input) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")),
  );
  return spawnSync("git", args, { cwd, env, input, maxBuffer: 1 << 30 });
}
const ok = (result) => result.status === 0 && !result.error;

// The repository's tracked files, POSIX paths. Without git (the tests also run from a tarball,
// AGENTS.md), its tree, less what isn't the repository's own: packages, builds, Claude Code's
// worktrees, the docs site's cache.
const SKIP = new Set(["node_modules", ".git", "dist", "coverage", ".claude"]);
const SKIP_PATHS = new Set(["docs/.vitepress/cache"]);
function files(dir) {
  const listed = git(dir, ["ls-files", "-z"]);
  if (ok(listed)) return listed.stdout.toString().split("\0").filter(Boolean);
  const walk = (at) =>
    readdirSync(at, { withFileTypes: true }).flatMap((entry) => {
      const path = posix(relative(dir, join(at, entry.name)));
      if (SKIP.has(entry.name) || SKIP_PATHS.has(path)) return [];
      return entry.isDirectory() ? walk(join(at, entry.name)) : [path];
    });
  return walk(dir);
}

// The commit the files are compared with: FILE_SIZES_BASE (CI: the merge commit's first parent,
// main as the pull request merges into it), else where the branch left origin/main, else
// origin/main itself (a shallow clone has no merge base). → { commit, name }, or undefined.
export function baseOf(dir, env = process.env) {
  const commit = (rev) => {
    const parsed = git(dir, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`]);
    return ok(parsed) ? parsed.stdout.toString().trim() : undefined;
  };
  if (env.FILE_SIZES_BASE) {
    const at = commit(env.FILE_SIZES_BASE);
    return at && { commit: at, name: env.FILE_SIZES_BASE };
  }
  if (!commit("origin/main")) return undefined;
  const merged = git(dir, ["merge-base", "HEAD", "origin/main"]);
  if (ok(merged)) return { commit: merged.stdout.toString().trim(), name: "origin/main" };
  return { commit: commit("origin/main"), name: "origin/main" };
}

// `paths`' lines at `commit`, renames followed (a file moved while its size held isn't new): →
// Map path → lines, without the paths that didn't exist there.
function linesAt(dir, commit, paths) {
  const was = new Map();
  const renames = git(dir, ["diff", "-z", "--name-status", "-M", commit]);
  if (ok(renames)) {
    const fields = renames.stdout.toString().split("\0");
    for (let i = 0; i < fields.length - 1;) {
      const status = fields[i];
      if (status.startsWith("R") || status.startsWith("C")) {
        was.set(fields[i + 2], fields[i + 1]);
        i += 3;
      } else i += 2;
    }
  }
  const asked = paths.map((path) => was.get(path) ?? path);
  const shown = git(dir, ["cat-file", "--batch"], asked.map((p) => `${commit}:${p}\n`).join(""));
  assert.ok(ok(shown), `git cat-file: ${shown.stderr}`);
  const out = new Map();
  let at = 0;
  for (const path of paths) {
    const end = shown.stdout.indexOf(0x0a, at);
    const header = shown.stdout.subarray(at, end).toString();
    at = end + 1;
    const [, type, size] = header.split(" ");
    if (type === undefined || header.endsWith(" missing")) continue;
    if (type === "blob") out.set(path, countLines(shown.stdout.subarray(at, at + Number(size))));
    at += Number(size) + 1;
  }
  return out;
}

// The exceptions: each a file's ceiling and why, and what is wrong with them.
function exceptionsOf(numbers, problems) {
  const out = new Map();
  for (const [path, entry] of Object.entries(numbers)) {
    if (!Number.isInteger(entry?.lines) || typeof entry.why !== "string" || !entry.why.trim())
      problems.push(`${EXCEPTIONS}: "${path}" must be { "lines": <n>, "why": "#<issue>" }`);
    else out.set(path, entry);
  }
  return out;
}

// What breaks the ratchet in `dir`'s working tree against `base` (baseOf()): → one message per
// problem, [] when none. Without a base, only the exceptions are checked.
export function check(dir, { base, limits = LIMITS, exceptions } = {}) {
  const path = join(dir, EXCEPTIONS);
  exceptions ??= existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  const problems = [];
  const allowed = exceptionsOf(exceptions, problems);
  const sizes = new Map(
    files(dir)
      .filter(covered)
      .filter((file) => existsSync(join(dir, file)))
      .map((file) => [file, countLines(readFileSync(join(dir, file)))]),
  );
  const over = [...sizes].filter(([file, lines]) => lines > limitOf(file, limits));
  const before = base
    ? linesAt(
        dir,
        base.commit,
        over.map(([file]) => file),
      )
    : new Map();
  for (const [file, lines] of base ? over : []) {
    const limit = limitOf(file, limits);
    const was = before.get(file);
    const ceiling = allowed.get(file)?.lines;
    if (lines <= Math.max(was ?? limit, ceiling ?? 0)) continue;
    const then =
      was === undefined || was <= limit
        ? `over the ${limit} a ${kindOf(file)} may have`
        : `${was} on ${base.name}, over the ${limit} a ${kindOf(file)} may have: it can't grow`;
    problems.push(
      `${file}: ${lines} lines, ${then}. Split it (a module of its own for the part you touch). ` +
        `If it really can't be, give it a ceiling in ${EXCEPTIONS} that says why: ` +
        `"${file}": { "lines": ${lines}, "why": "#<issue>" }`,
    );
  }
  for (const [file, { lines: ceiling }] of allowed) {
    const lines = sizes.get(file);
    if (lines === undefined || lines <= limitOf(file, limits))
      problems.push(`${file}: gone, or under its threshold: remove its entry from ${EXCEPTIONS}`);
    else if (lines < ceiling)
      problems.push(
        `${file}: ${lines} lines, under its ceiling in ${EXCEPTIONS}, ${ceiling}: remove its entry ` +
          `(main holds the file to its size), or lower it to ${lines}`,
      );
  }
  return problems;
}

const report = (problems) =>
  `${problems.length} file size problem(s) (#1065, AGENTS.md Conventions):\n- ${problems.join("\n- ")}`;

test("no code file over its threshold grows against the base branch", (t) => {
  const base = baseOf(root);
  const problems = check(root, { base });
  assert.deepEqual(problems, [], report(problems));
  if (!base) t.skip("no base to compare with: git fetch origin main, or FILE_SIZES_BASE");
});

// A temp repository with these files (path → lines), committed as origin/main, then changed by
// `write` in its working tree.
const SMALL = { code: 5, tests: 10 };
function repo(t, sizes) {
  const dir = tempDir(t);
  const write = (path, lines) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), typeof lines === "string" ? lines : "x\n".repeat(lines));
  };
  for (const [path, lines] of Object.entries(sizes)) write(path, lines);
  const run = (...args) => assert.ok(ok(git(dir, args)), `git ${args.join(" ")}`);
  const commit = [
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@example.com",
    "-c",
    "commit.gpgsign=false",
  ];
  run("init", "--quiet");
  run("add", ".");
  run(...commit, "commit", "--quiet", "--no-verify", "--allow-empty", "-m", "base");
  run("update-ref", "refs/remotes/origin/main", "HEAD");
  // A file the branch adds, tracked as `git add` would.
  const add = (path, lines) => (write(path, lines), run("add", path));
  const at = (exceptions = {}) => check(dir, { base: baseOf(dir, {}), limits: SMALL, exceptions });
  return { dir, write, add, run, commit, at };
}

test("countLines counts a last line without its newline", () => {
  assert.equal(countLines(Buffer.from("")), 0);
  assert.equal(countLines(Buffer.from("a\nb\n")), 2);
  assert.equal(countLines(Buffer.from("a\nb")), 2);
});

test("a file over its threshold that grew fails, naming its lines and main's, and saying to split it", (t) => {
  const { write, at } = repo(t, { "big.mjs": 8, "test/big.test.mjs": 12 });
  assert.deepEqual(at(), [], "as on main");
  write("big.mjs", 9);
  write("test/big.test.mjs", 11);
  const [problem, ...rest] = at();
  assert.deepEqual(rest, [], "a file that shrank needs nothing");
  assert.match(
    problem,
    /^big\.mjs: 9 lines, 8 on origin\/main, over the 5 a code file may have: it can't grow\. Split it/,
  );
});

test("a new file over its threshold fails, and one that crossed it; tests have their own", (t) => {
  const { write, add, at } = repo(t, { "lib/old.mjs": 5, "test/a.test.mjs": 10 });
  add("lib/new.mjs", 6);
  add("web/x.spec.tsx", 10);
  write("lib/old.mjs", 6);
  write("test/a.test.mjs", 11);
  const problems = at();
  assert.equal(problems.length, 3);
  assert.match(problems[0], /^lib\/new\.mjs: 6 lines, over the 5 a code file may have\. Split it/);
  assert.match(problems[1], /^lib\/old\.mjs: 6 lines, over the 5/);
  assert.match(problems[2], /^test\/a\.test\.mjs: 11 lines, over the 10 a test may have/);
});

test("graphql-js's bundle and what isn't code are left out", (t) => {
  const { add, at } = repo(t, {});
  add("listener/vendor/graphql.mjs", 99);
  add("package-lock.json", 99);
  add("a.yaml", 99);
  assert.deepEqual(at(), []);
});

test("a file moved without growing isn't new", (t) => {
  const { dir, run, at } = repo(t, { "lib/big.mjs": "a\nb\nc\nd\ne\nf\ng\n" });
  mkdirSync(join(dir, "lib", "big"));
  run("mv", "lib/big.mjs", "lib/big/index.mjs");
  assert.deepEqual(at(), []);
});

test("is held to where the branch left main, not to main since", (t) => {
  const { write, run, commit, at } = repo(t, { "big.mjs": 8 });
  run("checkout", "--quiet", "-b", "work");
  write("big.mjs", 8);
  // main went on: big.mjs split down to 6 lines there.
  run("checkout", "--quiet", "origin/main");
  write("big.mjs", 6);
  run(...commit, "commit", "--quiet", "--no-verify", "-am", "split");
  run("update-ref", "refs/remotes/origin/main", "HEAD");
  run("checkout", "--quiet", "work");
  assert.deepEqual(at(), []);
});

test("a ceiling in the JSON, with why, lets a file grow to it, and must stay its file's", (t) => {
  const { write, at } = repo(t, { "big.mjs": 8, "small.mjs": 9 });
  write("big.mjs", 10);
  write("small.mjs", 5);
  assert.deepEqual(at({ "big.mjs": { lines: 10, why: "#1234" } }), []);
  assert.match(at({ "big.mjs": { lines: 9, why: "#1234" } })[0], /^big\.mjs: 10 lines/);
  const problems = at({
    "big.mjs": { lines: 11, why: "#1234" },
    "gone.mjs": { lines: 9, why: "#1" },
    "small.mjs": { lines: 9, why: "#1" },
    "x.mjs": { lines: 9 },
  });
  assert.equal(problems.length, 4);
  assert.match(problems[0], /^test\/file-sizes\.json: "x\.mjs" must be/);
  assert.match(problems[1], /^big\.mjs: 10 lines, under its ceiling .* 11: remove its entry/);
  assert.match(problems[2], /^gone\.mjs: gone, or under its threshold: remove its entry/);
  assert.match(problems[3], /^small\.mjs: gone, or under its threshold/);
});

test("without a base, only the exceptions are checked; without git, the tree is read", (t) => {
  const dir = tempDir(t);
  mkdirSync(join(dir, "node_modules"));
  writeFileSync(join(dir, "big.mjs"), "x\n".repeat(9));
  writeFileSync(join(dir, "node_modules", "dep.mjs"), "x\n".repeat(99));
  assert.equal(baseOf(dir, {}), undefined);
  assert.deepEqual(check(dir, { limits: SMALL, exceptions: {} }), []);
  const problems = check(dir, {
    limits: SMALL,
    exceptions: { "big.mjs": { lines: 10, why: "#1" } },
  });
  assert.deepEqual(problems, [
    "big.mjs: 9 lines, under its ceiling in test/file-sizes.json, 10: remove its entry (main holds the file to its size), or lower it to 9",
  ]);
});

test("FILE_SIZES_BASE names the base, as CI does", (t) => {
  const { dir, write, run, commit } = repo(t, { "big.mjs": 8 });
  write("big.mjs", 9);
  run(...commit, "commit", "--quiet", "--no-verify", "-am", "grow");
  assert.deepEqual(baseOf(dir, { FILE_SIZES_BASE: "HEAD^1" }).name, "HEAD^1");
  const base = baseOf(dir, { FILE_SIZES_BASE: "HEAD^1" });
  assert.match(
    check(dir, { base, limits: SMALL, exceptions: {} })[0],
    /^big\.mjs: 9 lines, 8 on HEAD\^1/,
  );
  assert.equal(baseOf(dir, { FILE_SIZES_BASE: "nope" }), undefined);
});
