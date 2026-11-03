// The git gateway's copies of the repos granted `workflows` (git-gateway.mjs): a bare
// mirror per repo under the listener's data, so a push's workflow files can be read before
// GitHub gets them. A push is a thin pack: its deltas may point at objects GitHub already
// has, so it is indexed against the mirror, fetched just before (`index-pack --fix-thin`).
// It goes into a quarantine of its own, as receive-pack does: a refused push leaves nothing
// in the mirror.
import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { inspectWorkflow } from "./workflow-check.mjs";

// GitHub refuses pushes over 2 GiB: a bigger one isn't kept on disk to find out.
export const MAX_PUSH = 2 * 1024 ** 3;
// A workflow file bigger than this isn't read: refused.
export const MAX_WORKFLOW = 512 * 1024;
const GIT_MS = 5 * 60_000;
// A mirror's first fetch clones the whole repository: a big one takes longer.
const CLONE_MS = 60 * 60_000;
// Git's only setting from the listener's environment, which holds the operator's credentials.
const { PATH } = process.env;

// The files GitHub would read as workflows, and anything under .github/workflows/ that isn't a
// plain file (a symlink, a submodule): what the checks look at.
const PLAIN = /^100[0-7]{3}$/;
const checked = (entry) => /\.ya?ml$/i.test(entry.path) || !PLAIN.test(entry.mode);

// Removes what `dir` holds that is older than `ms`. Never fails: a sweep is only tidying.
async function sweep(dir, ms) {
  try {
    for (const name of await readdir(dir)) {
      const path = join(dir, name);
      if (Date.now() - (await stat(path)).mtimeMs > ms) {
        await rm(path, { recursive: true, force: true });
      }
    }
  } catch {
    // No such dir yet, or one going: nothing to tidy.
  }
}

export function createMirrors({
  root, // where the mirrors are kept
  // Where pushes are saved while they are checked: not the data volume, whose state a run
  // filling it would break.
  spoolRoot = join(tmpdir(), "deckhand-pushes"),
  githubUrl = "https://github.com",
  maxPush = MAX_PUSH,
  timeoutMs = GIT_MS,
  cloneMs = CLONE_MS,
  // (op, result) → nothing: each fetch from GitHub, `clone` (the first) or `mirror_update`, `ok`
  // or `failed` (the github service's metrics).
  onFetch = () => {},
}) {
  // What a listener that stopped mid-check left: older than any check lasts.
  const swept = sweep(spoolRoot, cloneMs + 2 * timeoutMs);

  // Per repo: one check at a time, so a fetch never runs under another push's reads.
  const queues = new Map();

  function locked(repo, fn) {
    const run = (queues.get(repo) ?? Promise.resolve()).then(fn);
    const tail = run.catch(() => {});
    queues.set(repo, tail);
    tail.then(() => queues.get(repo) === tail && queues.delete(repo));
    return run;
  }

  // Runs git; resolves with its stdout, rejects with its stderr. Nothing from the system's or
  // the user's config, never a prompt.
  function git(args, { env = {}, input, codes = [0], timeout = timeoutMs } = {}) {
    return new Promise((resolve, reject) => {
      const child = spawn("git", args, {
        env: {
          PATH,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_TERMINAL_PROMPT: "0",
          ...env,
        },
        stdio: [input ? "pipe" : "ignore", "pipe", "pipe"],
        timeout,
      });
      const out = [];
      const err = [];
      child.stdout.on("data", (c) => out.push(c));
      child.stderr.on("data", (c) => err.push(c));
      child.on("error", reject);
      child.on("close", (code, signal) => {
        if (codes.includes(code)) return resolve(Object.assign(Buffer.concat(out), { code }));
        const why = signal
          ? `stopped after ${Math.round(timeout / 60_000)} min (${signal})`
          : Buffer.concat(err).toString().trim().split("\n").pop() || code;
        reject(new Error(`git ${args[0] === "-C" ? args[2] : args[0]}: ${why}`));
      });
      if (input) pipeline(input, child.stdin).catch(() => {});
    });
  }

  // The push's whole body, on disk: { dir, file }. The caller removes `dir`.
  async function spool(body) {
    await swept;
    await mkdir(spoolRoot, { recursive: true });
    const dir = await mkdtemp(join(spoolRoot, "push-"));
    const file = join(dir, "push");
    let size = 0;
    try {
      await pipeline(
        body,
        async function* (chunks) {
          for await (const chunk of chunks) {
            size += chunk.length;
            if (size > maxPush) throw new Error("push too large");
            yield chunk;
          }
        },
        createWriteStream(file),
      );
    } catch (error) {
      await rm(dir, { recursive: true, force: true });
      throw error;
    }
    return { dir, file };
  }

  // A tree's entries: { mode, type, oid, name }.
  async function lsTree(rev, env, recursive = false) {
    const out = await git(["ls-tree", "-z", ...(recursive ? ["-r"] : []), rev], { env });
    return out
      .toString("utf8")
      .split("\0")
      .filter(Boolean)
      .map((line) => {
        const [meta, name] = [
          line.slice(0, line.indexOf("\t")),
          line.slice(line.indexOf("\t") + 1),
        ];
        const [mode, type, oid] = meta.split(" ");
        return { mode, type, oid, name };
      });
  }

  // What's under .github/workflows/ at `rev`, keyed by path: { mode, oid }. Read a level at a
  // time, not the whole tree. Without case, as a check should never miss one GitHub reads. A
  // `.github` or `workflows` that isn't a folder (a symlink, a submodule) is listed itself: it
  // is refused as a file that can't be read, rather than leave the folder unchecked.
  async function workflowFiles(rev, env) {
    const files = new Map();
    const unread = (path, entry) => files.set(path, { mode: entry.mode, oid: entry.oid });
    for (const github of await lsTree(rev, env)) {
      if (github.name.toLowerCase() !== ".github") continue;
      if (github.type !== "tree") {
        unread(github.name, github);
        continue;
      }
      for (const dir of await lsTree(github.oid, env)) {
        if (dir.name.toLowerCase() !== "workflows") continue;
        if (dir.type !== "tree") {
          unread(`${github.name}/${dir.name}`, dir);
          continue;
        }
        for (const file of await lsTree(dir.oid, env, true)) {
          const path = `${github.name}/${dir.name}/${file.name}`;
          files.set(path, { mode: file.mode, oid: file.oid });
        }
      }
    }
    return files;
  }

  // The workflow files each pushed branch changes, that fail workflow-check.mjs's rules: [{ ref,
  // path, problems }], `path` saying where. Changed means different from `base`'s, the default
  // branch's, at the branch's tip, or from a base's in the branch's merge with it: GitHub runs
  // a pull request's workflows from that merge, which can hold what neither side checked alone
  // (a step the branch edits, in a job the base has since given a secret). The merges are with
  // `base` and an update's `bases` (its pull requests'). The reusable workflows a checked one
  // calls are checked too, changed or not. Deleted files aren't. `updates`: { ref, new, bases }
  // of the push (`new` a commit or a ref of the mirror), `file` the push from `start` (null: no
  // pack), `dir` where the push's objects go. `token` reads the repo. `secrets`: the repo is
  // granted `workflow_secrets` (inspectWorkflow()'s `secretsOn`, `base`). Throws when the
  // mirror can't be fetched or the pack read.
  async function check({
    repo,
    token,
    base,
    updates,
    file = null,
    start = null,
    dir,
    secrets = false,
  }) {
    const mirror = join(root, `${repo}.git`);
    return locked(repo, async () => {
      await fetch(repo, mirror, token);
      const objects = join(dir, "objects");
      await mkdir(join(objects, "pack"), { recursive: true });
      const env = {
        GIT_DIR: mirror,
        GIT_OBJECT_DIRECTORY: objects,
        GIT_ALTERNATE_OBJECT_DIRECTORIES: join(mirror, "objects"),
      };
      if (start !== null) {
        await git(["index-pack", "--stdin", "--fix-thin"], {
          env,
          input: createReadStream(file, { start }),
        });
      }
      // Per branch: its workflow files, or null when it isn't on GitHub.
      const branches = new Map();
      const filesOf = async (branch) => {
        if (!branches.has(branch)) {
          const known = await git(["rev-parse", "--verify", "-q", `refs/heads/${branch}`], { env })
            .then(() => true)
            .catch(() => false);
          branches.set(branch, known ? await workflowFiles(`refs/heads/${branch}`, env) : null);
        }
        return branches.get(branch);
      };
      const inspected = new Map(); // blob → { problems, calls }
      const inspect = async (entry) => {
        if (!inspected.has(entry.oid)) {
          const text = await read(entry, env);
          inspected.set(
            entry.oid,
            text === null
              ? {
                  problems: [`not a plain UTF-8 file of at most ${MAX_WORKFLOW / 1024} KiB`],
                  calls: [],
                }
              : inspectWorkflow(text, { secretsOn: secrets ? base : null }),
          );
        }
        return inspected.get(entry.oid);
      };
      // The problems of `tree`'s files that differ from `before`'s, and of the workflows they
      // call, changed or not: { path, oid, problems }, `where` added to their paths. Each file
      // is followed even when the tip has it too: in a merge, the branch's caller can meet the
      // base's newer callee.
      const examine = async (tree, before, where) => {
        const files = await workflowFiles(tree, env);
        const same = (a, b) => a && a.oid === b.oid && a.mode === b.mode;
        const queue = [...files]
          .filter(([path, entry]) => !same(before.get(path), entry))
          .filter(([path, entry]) => checked({ path, mode: entry.mode }))
          .map(([path, entry]) => ({ path, entry, label: path }));
        const seen = new Set(queue.map((f) => f.path.toLowerCase()));
        const found = [];
        while (queue.length) {
          const { path, entry, label } = queue.shift();
          const { problems, calls } = await inspect(entry);
          if (problems.length) found.push({ path: `${label}${where}`, oid: entry.oid, problems });
          for (const call of calls) {
            // Without case, like the folder: never miss the file GitHub would call.
            const callees = [...files].filter(([p]) => p.toLowerCase() === call.toLowerCase());
            if (!callees.length) {
              found.push({
                path: `${label}${where}`,
                oid: null,
                problems: [`calls ${call}, which isn't there`],
              });
            }
            for (const [p, e] of callees) {
              if (seen.has(p.toLowerCase())) continue;
              seen.add(p.toLowerCase());
              queue.push({ path: p, entry: e, label: `${p} (called by ${path})` });
            }
          }
        }
        return found;
      };
      const found = [];
      for (const { ref, new: tip, bases = [], ifExists = false } of updates) {
        if (/^0+$/.test(tip)) continue;
        if (ifExists && !(await filesOf(ref.slice("refs/heads/".length)))) continue;
        const defaults = (await filesOf(base)) ?? new Map();
        // A file refused at the tip is said once, not again for each merge it is in.
        const said = new Set();
        const report = (f) => {
          if (f.oid && said.has(f.oid)) return;
          if (f.oid) said.add(f.oid);
          found.push({ ref, path: f.path, problems: f.problems });
        };
        for (const f of await examine(tip, defaults, "")) report(f);
        for (const into of new Set([base, ...bases])) {
          const before = await filesOf(into);
          if (!before) continue;
          const merge = await mergeTree(`refs/heads/${into}`, tip, env);
          const where = ` (merged with ${into})`;
          for (const path of merge.conflicts) {
            found.push({
              ref,
              path: `${path}${where}`,
              problems: [`conflicts with ${into}: rebase the branch on it`],
            });
          }
          if (merge.conflicts.length) continue;
          for (const f of await examine(merge.tree, before, where)) report(f);
        }
      }
      return found;
    });
  }

  // The mirror brought up to date with GitHub. Its first fetch, a whole clone, gets longer.
  async function fetch(repo, mirror, token) {
    await mkdir(mirror, { recursive: true });
    await git(["init", "-q", "--bare", mirror]);
    const empty = !(await git(["-C", mirror, "for-each-ref", "--count=1"])).length;
    const auth = Buffer.from(`x-access-token:${token}`).toString("base64");
    // The token in the environment, never in a command line or the mirror's config.
    const op = empty ? "clone" : "mirror_update";
    await git(
      [
        "-C",
        mirror,
        "fetch",
        "-q",
        "--prune",
        "--no-tags",
        "--no-write-fetch-head",
        `${githubUrl}/${repo}.git`,
        "+refs/heads/*:refs/heads/*",
        "+refs/tags/*:refs/tags/*",
      ],
      {
        env: {
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "http.extraHeader",
          GIT_CONFIG_VALUE_0: `Authorization: Basic ${auth}`,
        },
        timeout: empty ? cloneMs : timeoutMs,
      },
    ).then(
      () => onFetch(op, "ok"),
      (error) => {
        onFetch(op, "failed");
        throw error;
      },
    );
  }

  // The refs of a push whose new tips reach an object it doesn't carry and the repository doesn't
  // have: [{ ref, missing }], `missing` the first such object. The repository's own is what the
  // mirror's branches and tags reach (never refs/pull/*); GitHub keeps a fork network's objects
  // together, so a push needn't carry a fork's commit, tree or blob to point a branch at it, nor
  // a thin pack's delta base. It is git's own connectivity check, against the repository's
  // objects rather than its network's (github-forks.mjs: a work run that isn't a fork's). The
  // pack (`file` from `start`, null: none) goes into a quarantine of its own in `dir`. Throws
  // when the mirror can't be fetched or the pack read.
  async function connect({ repo, token, updates, file = null, start = null, dir }) {
    const mirror = join(root, `${repo}.git`);
    return locked(repo, async () => {
      await fetch(repo, mirror, token);
      const objects = join(dir, "connect", "objects");
      await mkdir(join(objects, "pack"), { recursive: true });
      const env = {
        GIT_DIR: mirror,
        GIT_OBJECT_DIRECTORY: objects,
        GIT_ALTERNATE_OBJECT_DIRECTORIES: join(mirror, "objects"),
      };
      if (start !== null) {
        await git(["index-pack", "--stdin", "--fix-thin"], {
          env,
          input: createReadStream(file, { start }),
        });
      }
      const unconnected = [];
      for (const { ref, new: tip } of updates) {
        if (/^0+$/.test(tip)) continue;
        let out;
        try {
          out = await git(["rev-list", "--objects", "--missing=print", tip, "--not", "--all"], {
            env,
          });
        } catch {
          // Its tip itself is neither in the push nor the repository's.
          unconnected.push({ ref, missing: tip });
          continue;
        }
        const missing = String(out)
          .split("\n")
          .find((line) => line.startsWith("?"));
        if (missing) unconnected.push({ ref, missing: missing.slice(1) });
      }
      return unconnected;
    });
  }

  // check() for a branch already on GitHub (`branch`), merged with `into`: before a pull
  // request is opened into it or marked ready, which run its workflows from a new merge.
  async function checkBranch({ repo, token, base, branch, into, secrets = false }) {
    await swept;
    await mkdir(spoolRoot, { recursive: true });
    const dir = await mkdtemp(join(spoolRoot, "branch-"));
    try {
      const ref = `refs/heads/${branch}`;
      // Fetched first, then read only if GitHub has it: a branch it doesn't have runs nothing,
      // and GitHub refuses its pull request.
      const updates = [{ ref, new: ref, bases: [into], ifExists: true }];
      return await check({ repo, token, base, updates, dir, secrets });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  // The merge GitHub would make of `tip` into `base`: { tree, conflicts }, `conflicts` the
  // workflow paths that don't merge.
  async function mergeTree(base, tip, env) {
    const out = await git(
      [
        "merge-tree",
        "--write-tree",
        "-z",
        "--no-messages",
        "--allow-unrelated-histories",
        base,
        tip,
      ],
      { env, codes: [0, 1] },
    );
    const [tree, ...entries] = out.toString("utf8").split("\0");
    const conflicts = new Set();
    for (const entry of entries) {
      const path = entry.slice(entry.indexOf("\t") + 1);
      if (entry && /^\.github\/workflows(\/|$)/i.test(path)) conflicts.add(path);
    }
    return { tree, conflicts: [...conflicts] };
  }

  // A plain file's text, or null: not one, too big, or not UTF-8 text (YAML can be UTF-16).
  // The characters YAML reads differently are workflow-check.mjs's to refuse, with their line.
  async function read(entry, env) {
    if (!PLAIN.test(entry.mode)) return null;
    const size = Number(await git(["cat-file", "-s", entry.oid], { env }));
    if (size > MAX_WORKFLOW) return null;
    const blob = await git(["cat-file", "blob", entry.oid], { env });
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(blob);
    } catch {
      return null;
    }
  }

  return {
    spool,
    check,
    connect,
    checkBranch,
    remove: (dir) => rm(dir, { recursive: true, force: true }),
  };
}
