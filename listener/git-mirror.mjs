// The git gateway's copies of the repos granted `allow_workflows` (git-gateway.mjs): a bare
// mirror per repo under the listener's data, so a push's workflow files can be read before
// GitHub gets them. A push is a thin pack: its deltas may point at objects GitHub already
// has, so it is indexed against the mirror, fetched just before (`index-pack --fix-thin`).
// It goes into a quarantine of its own, as receive-pack does: a refused push leaves nothing
// in the mirror.
import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";

// GitHub refuses pushes over 2 GiB: a bigger one isn't kept on disk to find out.
export const MAX_PUSH = 2 * 1024 ** 3;
// A workflow file bigger than this isn't read: refused.
export const MAX_WORKFLOW = 512 * 1024;
const GIT_MS = 5 * 60_000;
// Git's only setting from the listener's environment, which holds the operator's credentials.
const { PATH } = process.env;

// The files GitHub would read as workflows, and anything under .github/workflows/ that isn't a
// plain file (a symlink, a submodule): what the checks look at.
const PLAIN = /^100[0-7]{3}$/;
const checked = (entry) => /\.ya?ml$/i.test(entry.path) || !PLAIN.test(entry.mode);

export function createMirrors({
  root, // where the mirrors are kept
  // Where pushes are saved while they are checked: not the data volume, whose state a run
  // filling it would break.
  spoolRoot = join(tmpdir(), "deckhand-pushes"),
  githubUrl = "https://github.com",
  maxPush = MAX_PUSH,
  timeoutMs = GIT_MS,
}) {
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
  function git(args, { env = {}, input, codes = [0] } = {}) {
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
        timeout: timeoutMs,
      });
      const out = [];
      const err = [];
      child.stdout.on("data", (c) => out.push(c));
      child.stderr.on("data", (c) => err.push(c));
      child.on("error", reject);
      child.on("close", (code, signal) => {
        if (codes.includes(code)) return resolve(Object.assign(Buffer.concat(out), { code }));
        const why = Buffer.concat(err).toString().trim().split("\n").pop() || signal || code;
        reject(new Error(`git ${args[0] === "-C" ? args[2] : args[0]}: ${why}`));
      });
      if (input) pipeline(input, child.stdin).catch(() => {});
    });
  }

  // The push's whole body, on disk: { dir, file }. The caller removes `dir`.
  async function spool(body) {
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

  // The workflow files each pushed branch changes from `base`, the default branch: [{ ref,
  // path, mode, text, problem }], `text` null for what isn't a plain UTF-8 file of at most
  // MAX_WORKFLOW bytes, `problem` set for a file that can't be merged. Deleted files aren't.
  // Those of the branch's merge with `base` too: GitHub runs a pull request's workflows from
  // that merge, which can hold what neither side checked alone (a step the branch edits, in a
  // job the default branch has since given a secret). `updates`: { ref, new } of the push,
  // `file` the push from `start` (null: no pack). `token` reads the repo. Throws when the
  // mirror can't be fetched or the pack read.
  async function changedWorkflows({ repo, token, base, updates, file, start, dir }) {
    const mirror = join(root, `${repo}.git`);
    const auth = Buffer.from(`x-access-token:${token}`).toString("base64");
    return locked(repo, async () => {
      await mkdir(mirror, { recursive: true });
      await git(["init", "-q", "--bare", mirror]);
      // The token in the environment, never in a command line or the mirror's config.
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
        },
      );
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
      const known = await git(["rev-parse", "--verify", "-q", `refs/heads/${base}`], { env })
        .then(() => true)
        .catch(() => false);
      const before = known ? await workflowFiles(`refs/heads/${base}`, env) : new Map();
      const changed = [];
      const texts = new Map();
      // The files of `tree` that differ from the default branch's and aren't in `skip`.
      const differing = async (tree, skip = new Map()) => {
        const out = [];
        for (const [path, entry] of await workflowFiles(tree, env)) {
          const was = before.get(path);
          if (was && was.oid === entry.oid && was.mode === entry.mode) continue;
          if (skip.get(path)?.oid === entry.oid) continue;
          if (!checked({ path, mode: entry.mode })) continue;
          if (!texts.has(entry.oid)) texts.set(entry.oid, await read(entry, env));
          out.push({ path, mode: entry.mode, text: texts.get(entry.oid) });
        }
        return out;
      };
      for (const { ref, new: oid } of updates) {
        if (/^0+$/.test(oid)) continue;
        for (const file of await differing(oid)) changed.push({ ref, ...file });
        if (!known) continue;
        const merge = await mergeTree(`refs/heads/${base}`, oid, env);
        for (const path of merge.conflicts) {
          const problem = `conflicts with ${base}: rebase the branch on it`;
          changed.push({ ref, path, mode: null, text: null, problem });
        }
        const conflicted = new Set(merge.conflicts);
        for (const file of await differing(merge.tree, await workflowFiles(oid, env))) {
          if (conflicted.has(file.path)) continue;
          changed.push({ ref, ...file, path: `${file.path} (merged with ${base})` });
        }
      }
      return changed;
    });
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

  return { spool, changedWorkflows, remove: (dir) => rm(dir, { recursive: true, force: true }) };
}
