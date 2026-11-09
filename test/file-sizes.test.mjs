// The size ratchet (#1065): a code file over 800 lines (1,500 for a test) can't grow. Agents add
// to the file they are already in and nothing else pushes back, so test/file-sizes.json holds
// each such file to its number of lines, a number that only goes down: the file that shrank
// lowers it in the same pull request, the one that fell under the threshold leaves the JSON.
// Raising one to make room is caught against the default branch's copy, unless its entry says
// why ({ "lines": 900, "why": "#1234" }).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { posix, tempDir } from "./helpers.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const JSON_PATH = "test/file-sizes.json";
const BASE = "origin/main";
export const LIMITS = { code: 800, tests: 1500 };

// The code files: not graphql-js's bundle, nor what isn't code (lockfiles, the GraphQL schema,
// the Grafana JSON, YAML).
const CODE = /\.(mjs|js|ts|tsx|rego|sh|css)$/;
const covered = (path) => CODE.test(path) && !path.startsWith("listener/vendor/");
const isTest = (path) => path.startsWith("test/") || /\.spec\.tsx?$/.test(path);
const limitOf = (path, limits) => (isTest(path) ? limits.tests : limits.code);

// Lines as `wc -l` counts them, plus a last one without its newline.
export function countLines(buffer) {
  let n = 0;
  for (const byte of buffer) if (byte === 0x0a) n++;
  return buffer.length && buffer.at(-1) !== 0x0a ? n + 1 : n;
}

// git in `cwd`, without the GIT_* variables a hook running the suite would pass on: GIT_DIR
// would point every call at that repository.
function git(cwd, ...args) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")),
  );
  return spawnSync("git", args, { cwd, env, encoding: "utf8" });
}

// The repository's tracked files, POSIX paths. Without git (the tests also run from a tarball,
// AGENTS.md), its tree, less what isn't the repository's own: packages, builds, Claude Code's
// worktrees, the docs site's cache.
const SKIP = new Set(["node_modules", ".git", "dist", "coverage", ".claude"]);
const SKIP_PATHS = new Set(["docs/.vitepress/cache"]);
function files(dir) {
  const listed = git(dir, "ls-files", "-z");
  if (listed.status === 0 && !listed.error) return listed.stdout.split("\0").filter(Boolean);
  const walk = (at) =>
    readdirSync(at, { withFileTypes: true }).flatMap((entry) => {
      const path = posix(relative(dir, join(at, entry.name)));
      if (SKIP.has(entry.name) || SKIP_PATHS.has(path)) return [];
      return entry.isDirectory() ? walk(join(at, entry.name)) : [path];
    });
  return walk(dir);
}

// A JSON's entries as { lines, why }, and what is wrong with them.
function entries(numbers, problems) {
  const out = new Map();
  for (const [path, value] of Object.entries(numbers)) {
    const entry = typeof value === "number" ? { lines: value } : value;
    if (
      !Number.isInteger(entry?.lines) ||
      entry.lines < 1 ||
      (typeof value === "object" && (typeof entry.why !== "string" || !entry.why.trim()))
    ) {
      problems.push(
        `${JSON_PATH}: "${path}" must be a number of lines, or { "lines": <n>, "why": "#<issue>" }`,
      );
      continue;
    }
    out.set(path, entry);
  }
  return out;
}

// What breaks the ratchet in `dir`, against its JSON: → one message per problem, [] when none.
export function check(dir, { limits = LIMITS, numbers } = {}) {
  numbers ??= JSON.parse(readFileSync(join(dir, JSON_PATH), "utf8"));
  const problems = [];
  const keys = Object.keys(numbers);
  const sorted = keys.toSorted();
  if (keys.some((key, i) => key !== sorted[i])) problems.push(`${JSON_PATH}: sort it by path`);
  const listed = entries(numbers, problems);
  const sizes = new Map(
    files(dir)
      .filter(covered)
      .filter((path) => existsSync(join(dir, path)))
      .map((path) => [path, countLines(readFileSync(join(dir, path)))]),
  );
  for (const [path, lines] of sizes) {
    const limit = limitOf(path, limits);
    if (lines > limit && !listed.has(path))
      problems.push(
        `${path}: ${lines} lines, over the ${limit} a ${isTest(path) ? "test" : "code file"} may have. ` +
          `Split it. An entry in ${JSON_PATH} to make room is refused against ${BASE}'s unless it says ` +
          `why: { "lines": ${lines}, "why": "#<issue>" }`,
      );
  }
  for (const [path, { lines: number }] of listed) {
    const lines = sizes.get(path);
    const limit = limitOf(path, limits);
    if (lines === undefined)
      problems.push(`${path}: gone, or not a code file: remove its entry from ${JSON_PATH}`);
    else if (lines > number)
      problems.push(
        `${path}: ${lines} lines, over its number in ${JSON_PATH}, ${number}. ` +
          `Split it (move a part to a module of its own) rather than raise the number`,
      );
    else if (lines <= limit)
      problems.push(
        `${path}: ${lines} lines, under the ${limit} a ${isTest(path) ? "test" : "code file"} may have: ` +
          `remove its entry from ${JSON_PATH}`,
      );
    else if (lines < number)
      problems.push(
        `${path}: ${lines} lines, under its number in ${JSON_PATH}, ${number}: ` +
          `write "${path}": ${lines}, so its limit tightens`,
      );
  }
  return problems;
}

// The default branch's JSON: undefined without that branch (no git, or not fetched), null when
// it has no JSON yet.
export function baseNumbers(dir) {
  if (git(dir, "rev-parse", "--verify", "--quiet", `${BASE}^{commit}`).status !== 0)
    return undefined;
  const shown = git(dir, "show", `${BASE}:${JSON_PATH}`);
  return shown.status === 0 ? JSON.parse(shown.stdout) : null;
}

// The numbers raised against the default branch's: a file's number above its number there, or
// above its threshold when it had none, without a why.
export function raised(numbers, base, { limits = LIMITS } = {}) {
  const ignored = [];
  const before = entries(base, ignored);
  const problems = [];
  for (const [path, entry] of entries(numbers, ignored)) {
    const was = before.get(path)?.lines ?? limitOf(path, limits);
    if (entry.lines > was && !entry.why)
      problems.push(
        `${path}: its number in ${JSON_PATH} went up, from ${was} on ${BASE} to ${entry.lines}. ` +
          `Split the file instead; if it really can't be, say why: { "lines": ${entry.lines}, "why": "#<issue>" }. ` +
          `(Behind ${BASE}, where the number went down? Rebase first.)`,
      );
  }
  return problems;
}

const report = (problems) =>
  `${problems.length} file size problem(s) (#1065, AGENTS.md Conventions):\n- ${problems.join("\n- ")}`;

test("no code file over its threshold grows, and every number in test/file-sizes.json is its file's", () => {
  const problems = check(root);
  assert.deepEqual(problems, [], report(problems));
});

test("no number in test/file-sizes.json is raised against the default branch's", (t) => {
  const base = baseNumbers(root);
  if (base === undefined) return t.skip(`no ${BASE} to compare with (git fetch origin main)`);
  if (base === null) return t.diagnostic(`${BASE} has no ${JSON_PATH} yet`);
  const problems = raised(JSON.parse(readFileSync(join(root, JSON_PATH), "utf8")), base);
  assert.deepEqual(problems, [], report(problems));
});

// A temp repository with these files (path → lines) and this JSON, all of them added to git.
const LIMITS_SMALL = { code: 5, tests: 10 };
function repo(t, sizes, numbers = {}) {
  const dir = tempDir(t);
  const write = (path, text) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  for (const [path, lines] of Object.entries(sizes)) write(path, "x\n".repeat(lines));
  write(JSON_PATH, JSON.stringify(numbers, null, 2) + "\n");
  git(dir, "init", "--quiet");
  git(dir, "add", ".");
  return { dir, write };
}
const at = (dir, numbers) => check(dir, { limits: LIMITS_SMALL, numbers });

test("countLines counts a last line without its newline", () => {
  assert.equal(countLines(Buffer.from("")), 0);
  assert.equal(countLines(Buffer.from("a\nb\n")), 2);
  assert.equal(countLines(Buffer.from("a\nb")), 2);
});

test("a file at or under its threshold needs no entry; tests have their own", (t) => {
  const { dir } = repo(t, {
    "a.mjs": 5,
    "test/a.test.mjs": 10,
    "web/a.spec.tsx": 10,
    "a.json": 99,
  });
  assert.deepEqual(at(dir, {}), []);
});

test("a file over its threshold that isn't in the JSON fails, telling to split it", (t) => {
  const { dir } = repo(t, { "lib/new.mjs": 6, "test/big.test.mjs": 11, "web/x.spec.ts": 11 });
  const problems = at(dir, {});
  assert.equal(problems.length, 3);
  assert.match(problems[0], /^lib\/new\.mjs: 6 lines, over the 5 a code file may have\. Split it/);
  assert.match(problems[1], /^test\/big\.test\.mjs: 11 lines, over the 10 a test may have/);
  assert.match(problems[2], /^web\/x\.spec\.ts: 11 lines/);
});

test("graphql-js's bundle and what isn't code are left out", (t) => {
  const { dir } = repo(t, {
    "listener/vendor/graphql.mjs": 99,
    "package-lock.json": 99,
    "a.yaml": 99,
  });
  assert.deepEqual(at(dir, {}), []);
});

test("a file in the JSON that grew past its number fails, naming its lines and number", (t) => {
  const { dir } = repo(t, { "big.mjs": 9 });
  const [problem, ...rest] = at(dir, { "big.mjs": 8 });
  assert.deepEqual(rest, []);
  assert.match(
    problem,
    /^big\.mjs: 9 lines, over its number in test\/file-sizes\.json, 8\. Split it/,
  );
  assert.deepEqual(at(dir, { "big.mjs": 9 }), []);
});

test("a number left higher than its file fails, with the line to write", (t) => {
  const { dir } = repo(t, { "big.mjs": 7 });
  assert.deepEqual(at(dir, { "big.mjs": 9 }), [
    'big.mjs: 7 lines, under its number in test/file-sizes.json, 9: write "big.mjs": 7, so its limit tightens',
  ]);
});

test("an entry whose file fell under its threshold, or is gone, must leave the JSON", (t) => {
  const { dir } = repo(t, { "small.mjs": 5 });
  const problems = at(dir, { "gone.mjs": 9, "small.mjs": 9 });
  assert.match(problems[0], /^gone\.mjs: gone, or not a code file: remove its entry/);
  assert.match(
    problems[1],
    /^small\.mjs: 5 lines, under the 5 a code file may have: remove its entry/,
  );
});

test("an unsorted JSON, or an entry that isn't a number of lines, fails", (t) => {
  const { dir } = repo(t, { "a.mjs": 9, "b.mjs": 9 });
  assert.deepEqual(at(dir, { "b.mjs": 9, "a.mjs": 9 }), ["test/file-sizes.json: sort it by path"]);
  const problems = at(dir, { "a.mjs": "9", "b.mjs": { lines: 9 } });
  assert.equal(problems.filter((p) => p.includes("must be a number of lines")).length, 2);
});

test("without git, the tree is read instead", (t) => {
  const dir = tempDir(t);
  mkdirSync(join(dir, "lib"));
  mkdirSync(join(dir, "node_modules"));
  writeFileSync(join(dir, "lib", "big.mjs"), "x\n".repeat(6));
  writeFileSync(join(dir, "node_modules", "dep.mjs"), "x\n".repeat(99));
  assert.match(at(dir, {})[0], /^lib\/big\.mjs: 6 lines/);
});

test("a number raised against the default branch's fails, unless its entry says why", (t) => {
  const { dir, write } = repo(
    t,
    { "big.mjs": 8, "other.mjs": 7 },
    { "big.mjs": 8, "other.mjs": 7 },
  );
  assert.equal(baseNumbers(dir), undefined, "no origin/main yet");
  const commit = [
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@example.com",
    "-c",
    "commit.gpgsign=false",
  ];
  assert.equal(git(dir, ...commit, "commit", "--quiet", "--no-verify", "-m", "base").status, 0);
  assert.equal(git(dir, "update-ref", "refs/remotes/origin/main", "HEAD").status, 0);
  const base = baseNumbers(dir);
  assert.deepEqual(base, { "big.mjs": 8, "other.mjs": 7 });

  write("big.mjs", "x\n".repeat(9));
  const numbers = { "big.mjs": 9, "new.mjs": 6, "other.mjs": 6 };
  const problems = raised(numbers, base, { limits: LIMITS_SMALL });
  assert.equal(problems.length, 2);
  assert.match(
    problems[0],
    /^big\.mjs: its number in test\/file-sizes\.json went up, from 8 on origin\/main to 9/,
  );
  assert.match(problems[1], /^new\.mjs: .* from 5 on origin\/main to 6/);
  const why = { "big.mjs": { lines: 9, why: "#1234" }, "new.mjs": { lines: 6, why: "#1234" } };
  assert.deepEqual(raised(why, base, { limits: LIMITS_SMALL }), []);

  assert.equal(git(dir, "rm", "--quiet", "--cached", JSON_PATH).status, 0);
  assert.equal(git(dir, ...commit, "commit", "--quiet", "--no-verify", "-m", "no JSON").status, 0);
  assert.equal(git(dir, "update-ref", "refs/remotes/origin/main", "HEAD").status, 0);
  assert.equal(baseNumbers(dir), null, "origin/main without the JSON");
});
